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

/** Zakłada aktywne konto i loguje je do końca, zwracając cookie sesji i deviceId. */
async function zalogujSie(deviceId: string): Promise<{ cookie: string; token: string; username: string }> {
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
  });
  expect(totpRes.status).toBe(200);

  const setCookie = totpRes.headers.get("Set-Cookie");
  expect(setCookie).not.toBeNull();
  const cookie = setCookie!.split(";")[0]!;

  const { token } = await totpRes.json<{ token: string }>();

  return { cookie, token, username };
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
