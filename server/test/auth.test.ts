import { SELF } from "cloudflare:test";
import { Secret, TOTP } from "otpauth";
import { describe, expect, it } from "vitest";

import { base64ToBytes, bytesToBase64 } from "../src/crypto";
import * as opaque from "../src/opaque-wasm/index.js";
import { verifyCode } from "../src/totp";

/**
 * Pełna ścieżka uwierzytelniania, przechodzona tak jak zrobiłby to klient.
 *
 * Testy używają prawdziwego klienta OPAQUE, a nie atrapy — dzięki temu
 * sprawdzają protokół, a nie własne wyobrażenie o nim.
 */

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

/**
 * Przechodzi rejestrację prawdziwym klientem OPAQUE.
 *
 * Nie atrapą: test na atrapie sprawdzałby nasze wyobrażenie o protokole,
 * a nie sam protokół. Klient i serwer to tu ten sam kod w Rust, skompilowany
 * do WebAssembly.
 */
async function zarejestruj(username: string, password: string) {
  const start = opaque.clientRegisterStart(password);

  const startRes = await post("/auth/register/start", {
    username,
    registrationRequest: bytesToBase64(start.request),
  });
  expect(startRes.status).toBe(200);
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

/** Przechodzi logowanie aż do kroku TOTP; zwraca odpowiedź serwera. */
async function zalogujDoTotp(username: string, password: string): Promise<Response> {
  const start = opaque.clientLoginStart(password);

  const startRes = await post("/auth/login/start", {
    username,
    ke1: bytesToBase64(start.request),
  });
  if (startRes.status !== 200) return startRes;

  const { loginId, ke2 } = await startRes.json<{ loginId: string; ke2: string }>();

  let finalization: Uint8Array;
  try {
    finalization = opaque.clientLoginFinish(
      start.state,
      password,
      username,
      base64ToBytes(ke2),
    );
  } catch {
    // Złe hasło albo nieistniejące konto — klient wykrywa to sam, serwer
    // nie ma czego porównywać.
    return new Response(JSON.stringify({ error: "klient odrzucił odpowiedź serwera" }), {
      status: 401,
    });
  }

  return post("/auth/login/finish", {
    loginId,
    username,
    ke3: bytesToBase64(finalization),
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

    const start = opaque.clientRegisterStart("haslo-drugie");

    const res = await post("/auth/register/start", {
      username,
      registrationRequest: bytesToBase64(start.request),
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

    const ke1b64 = bytesToBase64(opaque.clientLoginStart("cokolwiek").request);

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
    const ke1b64 = bytesToBase64(opaque.clientLoginStart("cokolwiek").request);

    const statusy: number[] = [];
    for (let i = 0; i < 8; i += 1) {
      const res = await post("/auth/login/start", { username, ke1: ke1b64 });
      statusy.push(res.status);
    }

    expect(statusy).toContain(429);
  });
});

describe("potwierdzenie rejestracji wydaje sesję", () => {
  /**
   * Sedno: po wpisaniu kodu TOTP użytkownik jest ZALOGOWANY, nie odesłany na
   * ekran logowania. W tej chwili udowodnił oba składniki — hasło ustawił przy
   * `register/finish`, a znajomość sekretu TOTP właśnie potwierdził — więc
   * confirm zwraca dokładnie ten sam kształt co `login/totp`.
   */
  it("poprawny kod zwraca token, którym można wejść na własną skrzynkę", async () => {
    const konto = await zarejestruj(nazwa(), "haslo-po-rejestracji-od-razu");

    const res = await post("/auth/register/confirm", {
      username: konto.username,
      code: aktualnyKod(konto.totpSecret),
      deviceId: "telefon",
      sesjaWTresci: true,
    });

    expect(res.status).toBe(200);
    const dane = await res.json<{ token: string; expiresAt: number; refreshToken?: string }>();

    // Ten sam kształt co logowanie: token dostępowy, znacznik wygaśnięcia i —
    // bo poprosiliśmy `sesjaWTresci` — token odświeżający w treści.
    expect(dane.token).toContain(".");
    expect(dane.expiresAt).toBeGreaterThan(Date.now());
    expect(typeof dane.refreshToken).toBe("string");

    // Token musi od razu wpuszczać na uwierzytelniony endpoint — bez ponownego
    // logowania. Skrzynka adresowana jest NAZWĄ użytkownika, a token niesie
    // wewnętrzny UUID: serwer przelicza jedno na drugie i wpuszcza właściciela.
    const polaczenie = await SELF.fetch(`https://mekamb/inbox/${konto.username}/connect`, {
      headers: { Upgrade: "websocket", "Sec-WebSocket-Protocol": dane.token },
    });
    expect(polaczenie.status).toBe(101);
  });

  it("bez deviceId sesja wychodzi bez tokenu odświeżającego", async () => {
    const konto = await zarejestruj(nazwa(), "haslo-bez-urzadzenia");

    const res = await post("/auth/register/confirm", {
      username: konto.username,
      code: aktualnyKod(konto.totpSecret),
    });

    expect(res.status).toBe(200);
    const dane = await res.json<{ token: string; expiresAt: number; refreshToken?: string }>();
    expect(dane.token).toContain(".");
    expect(dane.refreshToken).toBeUndefined();
  });

  it("zły kod nie aktywuje konta i nie wydaje tokenu", async () => {
    const konto = await zarejestruj(nazwa(), "haslo-ze-zlym-kodem");

    const res = await post("/auth/register/confirm", {
      username: konto.username,
      code: "000000",
      deviceId: "telefon",
    });

    expect(res.status).toBe(401);
    const dane = await res.json<{ token?: string; error?: string }>();
    expect(dane.token).toBeUndefined();

    // Konto zostało `pending` — logowanie wciąż niemożliwe.
    const loginRes = await zalogujDoTotp(konto.username, konto.password);
    expect(loginRes.status).toBe(401);
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

/**
 * Zmiana authenticatora — ścieżka starym kodem.
 *
 * Passkeyowej drogi tu nie sprawdzamy: assertion wymaga prawdziwego
 * authenticatora WebAuthn, którego w workerd nie ma (tak samo pomijamy
 * logowanie passkeyem). Testujemy re-auth kodem, dwuetapowość (oczekujący →
 * potwierdzony) i to, że po zmianie działa NOWY sekret, a stary już nie.
 */
async function postAuth(sciezka: string, body: unknown, token: string): Promise<Response> {
  return SELF.fetch(`https://mekamb${sciezka}`, {
    method: "POST",
    headers: { "Content-Type": "application/json", Authorization: `Bearer ${token}` },
    body: JSON.stringify(body),
  });
}

/** Aktywuje konto i zwraca token dostępowy (confirm z deviceId wydaje sesję). */
async function aktywujZTokenem(username: string, totpSecret: string): Promise<string> {
  const res = await post("/auth/register/confirm", {
    username,
    code: aktualnyKod(totpSecret),
    deviceId: "telefon",
    sesjaWTresci: true,
  });
  expect(res.status).toBe(200);
  const { token } = await res.json<{ token: string }>();
  return token;
}

describe("zmiana authenticatora", () => {
  it("stary kod wydaje nowy sekret, a jego potwierdzenie przełącza konto", async () => {
    const konto = await zarejestruj(nazwa(), "haslo-do-zmiany-totp");
    const token = await aktywujZTokenem(konto.username, konto.totpSecret);

    // Re-auth aktualnym kodem (okno po aktywacji, żeby nie było powtórką).
    const startRes = await postAuth(
      "/auth/totp/change/start",
      { oldCode: kodPoAktywacji(konto.totpSecret) },
      token,
    );
    expect(startRes.status).toBe(200);
    const { totpSecret: nowySekret } = await startRes.json<{ totpSecret: string }>();
    expect(nowySekret).toMatch(/^[A-Z2-7]+$/);
    expect(nowySekret).not.toBe(konto.totpSecret);

    // Dopóki nie potwierdzimy, STARY sekret dalej jest aktywny (nowy tylko czeka).
    const przedRes = await postAuth(
      "/auth/totp/change/confirm",
      { code: aktualnyKod(nowySekret) },
      token,
    );
    expect(przedRes.status).toBe(200);

    // Po potwierdzeniu: NOWY sekret loguje, STARY już nie.
    const logNowy = await zalogujDoTotp(konto.username, konto.password);
    expect(logNowy.status).toBe(200);
    const { loginId } = await logNowy.json<{ loginId: string }>();
    const totpNowy = await post("/auth/login/totp", {
      loginId,
      code: kodPoAktywacji(nowySekret),
    });
    expect(totpNowy.status).toBe(200);

    const logStary = await zalogujDoTotp(konto.username, konto.password);
    expect(logStary.status).toBe(200);
    const { loginId: loginId2 } = await logStary.json<{ loginId: string }>();
    const totpStary = await post("/auth/login/totp", {
      loginId: loginId2,
      code: kodPoAktywacji(konto.totpSecret),
    });
    expect(totpStary.status).toBe(401);
  });

  it("zły stary kod nie wydaje nic i nie ma czego potwierdzać", async () => {
    const konto = await zarejestruj(nazwa(), "haslo-zly-kod");
    const token = await aktywujZTokenem(konto.username, konto.totpSecret);

    const startRes = await postAuth("/auth/totp/change/start", { oldCode: "000000" }, token);
    expect(startRes.status).toBe(401);

    // Bez udanego startu nie ma sekretu oczekującego.
    const confirmRes = await postAuth(
      "/auth/totp/change/confirm",
      { code: aktualnyKod(konto.totpSecret) },
      token,
    );
    expect(confirmRes.status).toBe(400);
  });

  it("bez tokenu dostępowego odrzuca każdy krok", async () => {
    for (const [sciezka, body] of [
      ["/auth/totp/change/options", {}],
      ["/auth/totp/change/start", { oldCode: "123456" }],
      ["/auth/totp/change/confirm", { code: "123456" }],
    ] as const) {
      const res = await post(sciezka, body);
      expect(res.status).toBe(401);
    }
  });
});
