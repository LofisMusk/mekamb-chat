import { SELF } from "cloudflare:test";
import { Secret, TOTP } from "otpauth";
import { describe, expect, it } from "vitest";

import { base64ToBytes, bytesToBase64 } from "../src/crypto";
import * as opaque from "../src/opaque-wasm/index.js";

/**
 * Trwała sesja: token odświeżający w httpOnly cookie zamiast pełnego
 * logowania OPAQUE+TOTP przy każdym odświeżeniu strony.
 *
 * Wzorowane na `auth.test.ts`: przechodzimy prawdziwe logowanie, żeby mieć
 * ważny wiersz w `refresh_tokens`, tak jak zrobiłby to klient webowy.
 */

async function post(sciezka: string, body: unknown, headers: HeadersInit = {}): Promise<Response> {
  return SELF.fetch(`https://mekamb${sciezka}`, {
    method: "POST",
    headers: { "Content-Type": "application/json", ...headers },
    body: JSON.stringify(body),
  });
}

function nazwa(): string {
  return `u${crypto.randomUUID().replace(/-/g, "").slice(0, 16)}`;
}

const OKNO_MS = 30_000;

function kodDlaOkna(secret: string, przesuniecieOkien = 0): string {
  return new TOTP({
    issuer: "mekamb-chat",
    algorithm: "SHA1",
    digits: 6,
    period: 30,
    secret: Secret.fromBase32(secret),
  }).generate({ timestamp: Date.now() + przesuniecieOkien * OKNO_MS });
}

/**
 * Zakłada aktywne konto i loguje je do końca, zwracając cookie sesji i deviceId.
 *
 * `sesjaWTresci` odwzorowuje klienta webowego na iOS: prosi o token
 * odświeżający w treści odpowiedzi, bo cookie trzeciej strony i tak do niego
 * nie dotrze.
 */
async function zalogujSie(
  deviceId: string,
  sesjaWTresci = false,
): Promise<{ cookie: string; token: string; username: string; refreshToken?: string }> {
  const username = nazwa();
  const password = "haslo-do-testow-trwalej-sesji";

  const start = opaque.clientRegisterStart(password);
  const startRes = await post("/auth/register/start", {
    username,
    registrationRequest: bytesToBase64(start.request),
  });
  const { registrationResponse } = await startRes.json<{ registrationResponse: string }>();

  const upload = opaque.clientRegisterFinish(
    start.state,
    password,
    username,
    base64ToBytes(registrationResponse),
  );
  const finishRes = await post("/auth/register/finish", {
    username,
    registrationRecord: bytesToBase64(upload),
  });
  const { totpSecret } = await finishRes.json<{ totpSecret: string }>();

  await post("/auth/register/confirm", { username, code: kodDlaOkna(totpSecret, 0) });

  const loginStart = opaque.clientLoginStart(password);
  const loginStartRes = await post("/auth/login/start", {
    username,
    ke1: bytesToBase64(loginStart.request),
  });
  const { loginId, ke2 } = await loginStartRes.json<{ loginId: string; ke2: string }>();

  const finalization = opaque.clientLoginFinish(
    loginStart.state,
    password,
    username,
    base64ToBytes(ke2),
  );
  await post("/auth/login/finish", { loginId, username, ke3: bytesToBase64(finalization) });

  const totpRes = await post("/auth/login/totp", {
    loginId,
    code: kodDlaOkna(totpSecret, 1),
    deviceId,
    sesjaWTresci,
  });
  expect(totpRes.status).toBe(200);

  const setCookie = totpRes.headers.get("Set-Cookie");
  expect(setCookie).not.toBeNull();
  const cookie = setCookie!.split(";")[0]!;

  const { token, refreshToken } = await totpRes.json<{ token: string; refreshToken?: string }>();

  return { cookie, token, username, refreshToken };
}

describe("trwała sesja", () => {
  it("logowanie ustawia httpOnly cookie tokenu odświeżającego", async () => {
    const { cookie } = await zalogujSie("urzadzenie-1");

    expect(cookie).toMatch(/^refresh=/);
  });

  it("cookie wymienia się na nowy token dostępowy", async () => {
    const deviceId = "urzadzenie-2";
    const { cookie } = await zalogujSie(deviceId);

    const res = await post("/auth/refresh", { deviceId }, { Cookie: cookie });

    expect(res.status).toBe(200);
    const { token, expiresAt } = await res.json<{ token: string; expiresAt: number }>();
    expect(token).toContain(".");
    expect(expiresAt).toBeGreaterThan(Date.now());
  });

  it("rotacja unieważnia poprzedni token odświeżający", async () => {
    const deviceId = "urzadzenie-3";
    const { cookie } = await zalogujSie(deviceId);

    const pierwszy = await post("/auth/refresh", { deviceId }, { Cookie: cookie });
    expect(pierwszy.status).toBe(200);

    // Ten sam, już zrotowany cookie nie pasuje do nowego wiersza w bazie.
    const drugi = await post("/auth/refresh", { deviceId }, { Cookie: cookie });
    expect(drugi.status).toBe(401);
  });

  it("brak deviceId jest odrzucany", async () => {
    const { cookie } = await zalogujSie("urzadzenie-4");

    const res = await post("/auth/refresh", {}, { Cookie: cookie });

    expect(res.status).toBe(401);
  });

  it("brak cookie jest odrzucany", async () => {
    const res = await post("/auth/refresh", { deviceId: "urzadzenie-5" });

    expect(res.status).toBe(401);
  });

  it("nieznane deviceId nie pasuje do cudzego cookie", async () => {
    const { cookie } = await zalogujSie("urzadzenie-6");

    const res = await post("/auth/refresh", { deviceId: "cudze-urzadzenie" }, { Cookie: cookie });

    expect(res.status).toBe(401);
  });

  it("wylogowanie kasuje trwałą sesję", async () => {
    const deviceId = "urzadzenie-7";
    const { cookie } = await zalogujSie(deviceId);

    const logout = await post("/auth/logout", { deviceId }, { Cookie: cookie });
    expect(logout.status).toBe(200);

    const proba = await post("/auth/refresh", { deviceId }, { Cookie: cookie });
    expect(proba.status).toBe(401);
  });

  it("logowanie bez deviceId nie ustawia cookie sesji", async () => {
    const username = nazwa();
    const password = "haslo-bez-urzadzenia";

    const start = opaque.clientRegisterStart(password);
    const startRes = await post("/auth/register/start", {
      username,
      registrationRequest: bytesToBase64(start.request),
    });
    const { registrationResponse } = await startRes.json<{ registrationResponse: string }>();
    const upload = opaque.clientRegisterFinish(
      start.state,
      password,
      username,
      base64ToBytes(registrationResponse),
    );
    const finishRes = await post("/auth/register/finish", {
      username,
      registrationRecord: bytesToBase64(upload),
    });
    const { totpSecret } = await finishRes.json<{ totpSecret: string }>();
    await post("/auth/register/confirm", { username, code: kodDlaOkna(totpSecret, 0) });

    const loginStart = opaque.clientLoginStart(password);
    const loginStartRes = await post("/auth/login/start", {
      username,
      ke1: bytesToBase64(loginStart.request),
    });
    const { loginId, ke2 } = await loginStartRes.json<{ loginId: string; ke2: string }>();
    const finalization = opaque.clientLoginFinish(
      loginStart.state,
      password,
      username,
      base64ToBytes(ke2),
    );
    await post("/auth/login/finish", { loginId, username, ke3: bytesToBase64(finalization) });

    const totpRes = await post("/auth/login/totp", { loginId, code: kodDlaOkna(totpSecret, 1) });
    expect(totpRes.status).toBe(200);
    expect(totpRes.headers.get("Set-Cookie")).toBeNull();
  });
});

/**
 * Trwała sesja tam, gdzie cookie nie dociera.
 *
 * Sedno: strona stoi na innej domenie niż API, więc dla Safari to cookie
 * trzeciej strony — blokowane domyślnie. iPhone wylogowywał się przy każdym
 * zamknięciu aplikacji, a na desktopie ta sama ścieżka działała.
 */
describe("trwała sesja bez cookie", () => {
  it("bez prośby token odświeżający NIE wychodzi w treści", async () => {
    const { refreshToken } = await zalogujSie("bez-prosby-1");

    expect(refreshToken).toBeUndefined();
  });

  it("na prośbę logowanie zwraca token odświeżający w treści", async () => {
    const { refreshToken } = await zalogujSie("w-tresci-1", true);

    expect(typeof refreshToken).toBe("string");
    expect(refreshToken!.length).toBeGreaterThan(20);
  });

  it("token z treści wymienia się na nowy token dostępowy bez cookie", async () => {
    const deviceId = "w-tresci-2";
    const { refreshToken } = await zalogujSie(deviceId, true);

    const res = await post("/auth/refresh", { deviceId, refreshToken });

    expect(res.status).toBe(200);
    const { token } = await res.json<{ token: string }>();
    expect(token).toContain(".");
  });

  /// Sedno: rotacja jest bezwarunkowa, więc klient bez cookie MUSI dostać
  /// nowy token tą samą drogą. Bez tego zostałby ze zużytym i kolejny start
  /// aplikacji skończyłby się wylogowaniem — czyli dokładnie tym, co ta
  /// ścieżka miała naprawić.
  it("odświeżenie z treści zwraca zrotowany token, a stary przestaje działać", async () => {
    const deviceId = "w-tresci-3";
    const { refreshToken } = await zalogujSie(deviceId, true);

    const pierwsze = await post("/auth/refresh", { deviceId, refreshToken });
    const { refreshToken: nowy } = await pierwsze.json<{ refreshToken?: string }>();

    expect(typeof nowy).toBe("string");
    expect(nowy).not.toBe(refreshToken);

    // Nowy działa…
    const drugie = await post("/auth/refresh", { deviceId, refreshToken: nowy });
    expect(drugie.status).toBe(200);

    // …a zużyty już nie.
    const trzecie = await post("/auth/refresh", { deviceId, refreshToken });
    expect(trzecie.status).toBe(401);
  });

  it("cudzy token z treści nie pasuje do naszego urządzenia", async () => {
    const { refreshToken } = await zalogujSie("w-tresci-4", true);
    await zalogujSie("w-tresci-5", true);

    const res = await post("/auth/refresh", { deviceId: "w-tresci-5", refreshToken });

    expect(res.status).toBe(401);
  });

  it("wylogowanie unieważnia też token trzymany przez klienta", async () => {
    const deviceId = "w-tresci-6";
    const { refreshToken } = await zalogujSie(deviceId, true);

    expect((await post("/auth/logout", { deviceId })).status).toBe(200);
    expect((await post("/auth/refresh", { deviceId, refreshToken })).status).toBe(401);
  });
});
