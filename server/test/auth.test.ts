import {
  KE2,
  OpaqueClient,
  OpaqueID,
  RegistrationResponse,
  getOpaqueConfig,
} from "@cloudflare/opaque-ts";
import { SELF } from "cloudflare:test";
import { Secret, TOTP } from "otpauth";
import { describe, expect, it } from "vitest";

import { base64ToBytes, bytesToBase64 } from "../src/crypto";
import { verifyCode } from "../src/totp";

/**
 * Pełna ścieżka uwierzytelniania, przechodzona tak jak zrobiłby to klient.
 *
 * Testy używają prawdziwego klienta OPAQUE, a nie atrapy — dzięki temu
 * sprawdzają protokół, a nie własne wyobrażenie o nim.
 */

const cfg = getOpaqueConfig(OpaqueID.OPAQUE_P256);
const SERVER_IDENTITY = "mekamb-chat";

async function post(sciezka: string, body: unknown): Promise<Response> {
  return SELF.fetch(`https://mekamb${sciezka}`, {
    method: "POST",
    headers: { "Content-Type": "application/json" },
    body: JSON.stringify(body),
  });
}

function nazwa(): string {
  return `u${crypto.randomUUID().replace(/-/g, "").slice(0, 16)}`;
}

/** Przechodzi rejestrację i zwraca aktywne konto gotowe do logowania. */
async function zarejestruj(username: string, password: string) {
  const client = new OpaqueClient(cfg);

  const request = await client.registerInit(password);
  if (request instanceof Error) throw request;

  const startRes = await post("/auth/register/start", {
    username,
    registrationRequest: bytesToBase64(Uint8Array.from(request.serialize())),
  });
  expect(startRes.status).toBe(200);
  const { registrationResponse } = await startRes.json<{ registrationResponse: string }>();

  const finished = await client.registerFinish(
    RegistrationResponse.deserialize(cfg, Array.from(base64ToBytes(registrationResponse))),
    SERVER_IDENTITY,
    username,
  );
  if (finished instanceof Error) throw finished;

  const finishRes = await post("/auth/register/finish", {
    username,
    registrationRecord: bytesToBase64(Uint8Array.from(finished.record.serialize())),
  });
  expect(finishRes.status).toBe(200);
  const { totpSecret, otpauthUri } = await finishRes.json<{
    totpSecret: string;
    otpauthUri: string;
  }>();

  return { totpSecret, otpauthUri, username, password };
}

const OKNO_MS = 30_000;

/**
 * Generuje kod TOTP dla okna przesuniętego o `przesuniecieOkien`.
 *
 * Przesunięcie jest tu konieczne, a nie wygodne. Aktywacja konta zużywa swoje
 * okno czasowe, więc logowanie tym samym kodem jest — słusznie — odrzucane
 * jako powtórzenie. RFC 6238 §5.2 wprost tego wymaga. W praktyce znaczy to,
 * że użytkownik po rejestracji czeka do następnego kodu; testy zamiast czekać
 * 30 sekund liczą kod dla kolejnego okna, mieszczącego się w tolerancji serwera.
 */
function kodDlaOkna(secret: string, przesuniecieOkien = 0): string {
  // Odtwarzamy kod tą samą biblioteką, której używa serwer — test nie
  // implementuje własnego TOTP.
  return new TOTP({
    issuer: "mekamb-chat",
    algorithm: "SHA1",
    digits: 6,
    period: 30,
    secret: Secret.fromBase32(secret),
  }).generate({ timestamp: Date.now() + przesuniecieOkien * OKNO_MS });
}

/** Kod dla bieżącego okna. */
function aktualnyKod(secret: string): string {
  return kodDlaOkna(secret, 0);
}

/** Kod dla następnego okna — używany po aktywacji, która spala okno bieżące. */
function kodPoAktywacji(secret: string): string {
  return kodDlaOkna(secret, 1);
}

/** Aktywuje konto potwierdzeniem kodu. */
async function aktywuj(username: string, totpSecret: string): Promise<void> {
  const res = await post("/auth/register/confirm", { username, code: aktualnyKod(totpSecret) });
  expect(res.status).toBe(200);
}

/** Przechodzi logowanie aż do kroku TOTP; zwraca `loginId`. */
async function zalogujDoTotp(username: string, password: string): Promise<Response> {
  const client = new OpaqueClient(cfg);
  const ke1 = await client.authInit(password);
  if (ke1 instanceof Error) throw ke1;

  const startRes = await post("/auth/login/start", {
    username,
    ke1: bytesToBase64(Uint8Array.from(ke1.serialize())),
  });
  if (startRes.status !== 200) return startRes;

  const { loginId, ke2 } = await startRes.json<{ loginId: string; ke2: string }>();

  const finishedClient = await client.authFinish(
    KE2.deserialize(cfg, Array.from(base64ToBytes(ke2))),
    SERVER_IDENTITY,
    username,
  );

  if (finishedClient instanceof Error) {
    // Złe hasło albo nieistniejące konto — klient wykrywa to sam.
    return new Response(JSON.stringify({ error: "klient odrzucił odpowiedź serwera" }), {
      status: 401,
    });
  }

  return post("/auth/login/finish", {
    loginId,
    ke3: bytesToBase64(Uint8Array.from(finishedClient.ke3.serialize())),
  });
}

describe("rejestracja", () => {
  it("zwraca sekret TOTP i URI do zeskanowania", async () => {
    const konto = await zarejestruj(nazwa(), "poprawne-konie-bateria-zszywka");

    expect(konto.totpSecret).toMatch(/^[A-Z2-7]+$/);
    expect(konto.otpauthUri).toContain("otpauth://totp/");
    expect(konto.otpauthUri).toContain("mekamb-chat");
  });

  it("zajęta nazwa jest odrzucana", async () => {
    const username = nazwa();
    await zarejestruj(username, "haslo-pierwsze");

    const client = new OpaqueClient(cfg);
    const request = await client.registerInit("haslo-drugie");
    if (request instanceof Error) throw request;

    const res = await post("/auth/register/start", {
      username,
      registrationRequest: bytesToBase64(Uint8Array.from(request.serialize())),
    });

    expect(res.status).toBe(409);
  });

  it("nieprawidłowa nazwa jest odrzucana", async () => {
    for (const zla of ["ab", "ma:dwukropek", "za-dluga".repeat(10), "spacja w srodku"]) {
      const res = await post("/auth/register/start", {
        username: zla,
        registrationRequest: "",
      });
      expect(res.status).toBe(400);
    }
  });

  it("konto bez potwierdzenia kodem nie pozwala się zalogować", async () => {
    const konto = await zarejestruj(nazwa(), "haslo-bez-aktywacji");

    // Świadomie pomijamy krok potwierdzenia.
    const res = await zalogujDoTotp(konto.username, konto.password);

    expect(res.status).toBe(401);
  });
});

describe("logowanie", () => {
  it("poprawne hasło i kod dają token dostępowy", async () => {
    const konto = await zarejestruj(nazwa(), "poprawne-haslo-uzytkownika");
    await aktywuj(konto.username, konto.totpSecret);

    const finishRes = await zalogujDoTotp(konto.username, konto.password);
    expect(finishRes.status).toBe(200);
    const { loginId, totpRequired } = await finishRes.json<{
      loginId: string;
      totpRequired: boolean;
    }>();

    // Samo hasło NIE wystarcza — serwer żąda drugiego składnika.
    expect(totpRequired).toBe(true);

    const totpRes = await post("/auth/login/totp", {
      loginId,
      code: kodPoAktywacji(konto.totpSecret),
      deviceId: "telefon",
    });

    expect(totpRes.status).toBe(200);
    const { token, expiresAt } = await totpRes.json<{ token: string; expiresAt: number }>();
    expect(token).toContain(".");
    expect(expiresAt).toBeGreaterThan(Date.now());
  });

  it("złe hasło nie przechodzi", async () => {
    const konto = await zarejestruj(nazwa(), "prawidlowe-haslo");
    await aktywuj(konto.username, konto.totpSecret);

    const res = await zalogujDoTotp(konto.username, "ZUPELNIE-INNE-haslo");

    expect(res.status).toBe(401);
  });

  /**
   * Ochrona przed enumeracją kont: logowanie nieistniejącą nazwą musi wyglądać
   * tak samo jak logowanie istniejącą ze złym hasłem.
   */
  it("nieistniejące konto nie jest odróżnialne od złego hasła", async () => {
    const konto = await zarejestruj(nazwa(), "prawidlowe-haslo");
    await aktywuj(konto.username, konto.totpSecret);

    const client = new OpaqueClient(cfg);
    const ke1 = await client.authInit("cokolwiek");
    if (ke1 instanceof Error) throw ke1;
    const ke1b64 = bytesToBase64(Uint8Array.from(ke1.serialize()));

    const nieistniejace = await post("/auth/login/start", {
      username: nazwa(),
      ke1: ke1b64,
    });
    const istniejace = await post("/auth/login/start", {
      username: konto.username,
      ke1: ke1b64,
    });

    // Ten sam status i ten sam kształt odpowiedzi.
    expect(nieistniejace.status).toBe(istniejace.status);
    expect(nieistniejace.status).toBe(200);

    const a = await nieistniejace.json<Record<string, unknown>>();
    const b = await istniejace.json<Record<string, unknown>>();
    expect(Object.keys(a).sort()).toEqual(Object.keys(b).sort());
  });

  it("hasło bez kodu TOTP nie wystarcza", async () => {
    const konto = await zarejestruj(nazwa(), "haslo-uzytkownika");
    await aktywuj(konto.username, konto.totpSecret);

    const finishRes = await zalogujDoTotp(konto.username, konto.password);
    const { loginId } = await finishRes.json<{ loginId: string }>();

    const res = await post("/auth/login/totp", { loginId, code: "000000" });

    expect(res.status).toBe(401);
  });

  it("sesja logowania jest jednorazowa", async () => {
    const konto = await zarejestruj(nazwa(), "haslo-uzytkownika");
    await aktywuj(konto.username, konto.totpSecret);

    const finishRes = await zalogujDoTotp(konto.username, konto.password);
    const { loginId } = await finishRes.json<{ loginId: string }>();
    const kod = kodPoAktywacji(konto.totpSecret);

    const pierwsze = await post("/auth/login/totp", { loginId, code: kod });
    expect(pierwsze.status).toBe(200);

    // Powtórzenie tego samego loginId musi odpaść — rekord został skonsumowany.
    const drugie = await post("/auth/login/totp", { loginId, code: kod });
    expect(drugie.status).toBe(401);
  });

  /**
   * Podsłuchany kod TOTP działa przez całe swoje okno. Po jednym użyciu
   * to okno musi zostać spalone.
   */
  it("ten sam kod TOTP nie działa drugi raz", async () => {
    const konto = await zarejestruj(nazwa(), "haslo-uzytkownika");
    await aktywuj(konto.username, konto.totpSecret);
    const kod = kodPoAktywacji(konto.totpSecret);

    const pierwszeLogowanie = await zalogujDoTotp(konto.username, konto.password);
    const { loginId: id1 } = await pierwszeLogowanie.json<{ loginId: string }>();
    expect((await post("/auth/login/totp", { loginId: id1, code: kod })).status).toBe(200);

    // Nowa sesja logowania, ale ten sam, już wykorzystany kod.
    const drugieLogowanie = await zalogujDoTotp(konto.username, konto.password);
    const { loginId: id2 } = await drugieLogowanie.json<{ loginId: string }>();
    const powtorka = await post("/auth/login/totp", { loginId: id2, code: kod });

    expect(powtorka.status).toBe(401);
    expect(await powtorka.json<{ error: string }>()).toEqual({ error: "kod został już użyty" });
  });

  it("nieznana sesja logowania jest odrzucana", async () => {
    const res = await post("/auth/login/totp", {
      loginId: crypto.randomUUID(),
      code: "123456",
    });

    expect(res.status).toBe(401);
  });

  it("po serii nieudanych prób logowanie jest blokowane", async () => {
    const username = nazwa();
    const client = new OpaqueClient(cfg);
    const ke1 = await client.authInit("cokolwiek");
    if (ke1 instanceof Error) throw ke1;
    const ke1b64 = bytesToBase64(Uint8Array.from(ke1.serialize()));

    const statusy: number[] = [];
    for (let i = 0; i < 8; i += 1) {
      const res = await post("/auth/login/start", { username, ke1: ke1b64 });
      statusy.push(res.status);
    }

    expect(statusy).toContain(429);
  });
});

describe("sekret TOTP w spoczynku", () => {
  it("nie jest przechowywany jawnie", async () => {
    const konto = await zarejestruj(nazwa(), "haslo-uzytkownika");

    // Sekret zwrócony klientowi musi być poprawny...
    expect(verifyCode(konto.totpSecret, aktualnyKod(konto.totpSecret)).valid).toBe(true);

    // ...ale w bazie leży zaszyfrowany kluczem z Workers Secrets, więc sam
    // wyciek bazy nie wystarcza do generowania kodów.
    const { env } = await import("cloudflare:test");
    const row = await env.DB.prepare("SELECT totp_secret_enc FROM users WHERE username = ?")
      .bind(konto.username)
      .first<{ totp_secret_enc: string }>();

    expect(row).not.toBeNull();
    expect(row!.totp_secret_enc).not.toBe(konto.totpSecret);
    expect(row!.totp_secret_enc).not.toContain(konto.totpSecret);
  });
});
