import { SELF } from "cloudflare:test";
import { cose, isoCBOR } from "@simplewebauthn/server/helpers";
import type { CBORType } from "@levischuck/tiny-cbor";
import { Secret, TOTP } from "otpauth";
import { describe, expect, it } from "vitest";

import { base64ToBytes, bytesToBase64 } from "../src/crypto";
import * as opaque from "../src/opaque-wasm/index.js";

/**
 * Logowanie passkeyem (WebAuthn).
 *
 * Prawdziwej przeglądarki i authenticatora tu nie ma, więc test SYMULUJE
 * authenticator: generuje parę kluczy ES256 i ręcznie składa `authData`/
 * `attestationObject`/podpis w formatach, jakich oczekuje prawdziwa
 * ceremonia WebAuthn. Weryfikacja po stronie serwera jest tym samym kodem
 * (`@simplewebauthn/server`), który przetworzyłby odpowiedź prawdziwej
 * przeglądarki — testujemy więc rzeczywistą weryfikację, nie jej atrapę.
 */

const ORIGIN = "https://mekamb.test"; // musi zgadzać się z ALLOWED_ORIGINS w vitest.config.ts
const RP_ID = "mekamb.test"; // musi zgadzać się z WEBAUTHN_RP_ID w vitest.config.ts

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

/** Zakłada aktywne konto, loguje je hasłem+TOTP i zwraca token dostępowy. */
async function zalogujSie(deviceId: string): Promise<{ token: string; username: string }> {
  const username = nazwa();
  const password = "haslo-do-testow-passkey-logowania";

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
  const { token } = await totpRes.json<{ token: string }>();

  return { token, username };
}

// --- Symulowany authenticator ------------------------------------------------

function base64url(bytes: Uint8Array): string {
  let binary = "";
  for (const byte of bytes) binary += String.fromCharCode(byte);
  return btoa(binary).replace(/\+/g, "-").replace(/\//g, "_").replace(/=+$/, "");
}

function concat(...parts: Uint8Array[]): Uint8Array<ArrayBuffer> {
  const total = parts.reduce((n, p) => n + p.length, 0);
  const out = new Uint8Array(total);
  let offset = 0;
  for (const part of parts) {
    out.set(part, offset);
    offset += part.length;
  }
  return out;
}

async function sha256(data: Uint8Array): Promise<Uint8Array> {
  return new Uint8Array(await crypto.subtle.digest("SHA-256", data));
}

/** DER (ASN.1) INTEGER dla nieujemnej liczby całkowitej big-endian. */
function derInteger(raw: Uint8Array): Uint8Array {
  let i = 0;
  while (i < raw.length - 1 && raw[i] === 0) i += 1;
  let bytes = raw.slice(i);
  if ((bytes[0] ?? 0) & 0x80) {
    bytes = concat(new Uint8Array([0]), bytes);
  }
  return concat(new Uint8Array([0x02, bytes.length]), bytes);
}

/**
 * WebCrypto podpisuje ECDSA w formacie IEEE P1363 (surowe r||s), a WebAuthn
 * wymaga podpisu owiniętego w ASN.1 DER — dokładnie odwrotnie niż w drugą
 * stronę robi to `unwrapEC2Signature` po stronie serwera przy weryfikacji.
 */
function derEcdsaSignature(rawSignature: Uint8Array): Uint8Array {
  const r = derInteger(rawSignature.slice(0, 32));
  const s = derInteger(rawSignature.slice(32, 64));
  const content = concat(r, s);
  return concat(new Uint8Array([0x30, content.length]), content);
}

/** Klucz publiczny ES256 w formacie COSE (dokładnie to, co zapisuje serwer). */
function coseEc2PublicKey(x: Uint8Array, y: Uint8Array): Uint8Array {
  const key: Map<string | number, CBORType> = new Map();
  key.set(cose.COSEKEYS.kty, cose.COSEKTY.EC2);
  key.set(cose.COSEKEYS.alg, cose.COSEALG.ES256);
  key.set(cose.COSEKEYS.crv, cose.COSECRV.P256);
  key.set(cose.COSEKEYS.x, x);
  key.set(cose.COSEKEYS.y, y);
  return isoCBOR.encode(key);
}

async function authenticatorData(opts: {
  rpId: string;
  signCount: number;
  attestedCredential?: { id: Uint8Array; coseKey: Uint8Array };
}): Promise<Uint8Array> {
  const rpIdHash = await sha256(new TextEncoder().encode(opts.rpId));

  // Bit 0: user present. Bit 2: user verified. Bit 6: attested credential data
  // present (tylko przy rejestracji — logowanie nie dołącza klucza ponownie).
  const flags = opts.attestedCredential ? 0b0100_0101 : 0b0000_0101;

  const signCount = new Uint8Array(4);
  new DataView(signCount.buffer).setUint32(0, opts.signCount, false);

  const parts = [rpIdHash, new Uint8Array([flags]), signCount];

  if (opts.attestedCredential) {
    const aaguid = new Uint8Array(16);
    const credIdLen = new Uint8Array(2);
    new DataView(credIdLen.buffer).setUint16(0, opts.attestedCredential.id.length, false);
    parts.push(aaguid, credIdLen, opts.attestedCredential.id, opts.attestedCredential.coseKey);
  }

  return concat(...parts);
}

async function generujAuthenticator() {
  const keyPair = (await crypto.subtle.generateKey({ name: "ECDSA", namedCurve: "P-256" }, true, [
    "sign",
    "verify",
  ])) as CryptoKeyPair;
  const rawPublicKeyBuffer = (await crypto.subtle.exportKey("raw", keyPair.publicKey)) as ArrayBuffer;
  const rawPublicKey = new Uint8Array(rawPublicKeyBuffer);
  const x = rawPublicKey.slice(1, 33);
  const y = rawPublicKey.slice(33, 65);
  const credentialId = crypto.getRandomValues(new Uint8Array(32));

  return { keyPair, x, y, credentialId };
}

/** Składa odpowiedź rejestracyjną tak, jak zrobiłaby to przeglądarka. */
async function odpowiedzRejestracji(
  authenticator: Awaited<ReturnType<typeof generujAuthenticator>>,
  challenge: string,
) {
  const clientData = JSON.stringify({
    type: "webauthn.create",
    challenge,
    origin: ORIGIN,
    crossOrigin: false,
  });
  const clientDataJSON = new TextEncoder().encode(clientData);

  const coseKey = coseEc2PublicKey(authenticator.x, authenticator.y);
  const authData = await authenticatorData({
    rpId: RP_ID,
    signCount: 0,
    attestedCredential: { id: authenticator.credentialId, coseKey },
  });

  const attestationObject = isoCBOR.encode(
    new Map<string | number, CBORType>([
      ["fmt", "none"],
      ["attStmt", new Map()],
      ["authData", authData],
    ]),
  );

  const id = base64url(authenticator.credentialId);
  return {
    id,
    rawId: id,
    type: "public-key" as const,
    clientExtensionResults: {},
    response: {
      clientDataJSON: base64url(clientDataJSON),
      attestationObject: base64url(attestationObject),
    },
  };
}

/** Składa odpowiedź logowania (assertion) tak, jak zrobiłaby to przeglądarka. */
async function odpowiedzLogowania(
  authenticator: Awaited<ReturnType<typeof generujAuthenticator>>,
  challenge: string,
  signCount: number,
) {
  const clientData = JSON.stringify({
    type: "webauthn.get",
    challenge,
    origin: ORIGIN,
    crossOrigin: false,
  });
  const clientDataJSON = new TextEncoder().encode(clientData);
  const authData = await authenticatorData({ rpId: RP_ID, signCount });
  const clientDataHash = await sha256(clientDataJSON);

  const rawSignature = new Uint8Array(
    await crypto.subtle.sign(
      { name: "ECDSA", hash: "SHA-256" },
      authenticator.keyPair.privateKey,
      concat(authData, clientDataHash),
    ),
  );

  const id = base64url(authenticator.credentialId);
  return {
    id,
    rawId: id,
    type: "public-key" as const,
    clientExtensionResults: {},
    response: {
      clientDataJSON: base64url(clientDataJSON),
      authenticatorData: base64url(authData),
      signature: base64url(derEcdsaSignature(rawSignature)),
    },
  };
}

describe("rejestracja passkeya", () => {
  it("wymaga ważnego tokenu dostępowego", async () => {
    const res = await post("/auth/webauthn/register/options", {});
    expect(res.status).toBe(401);
  });

  it("zarejestrowany passkey pozwala się zalogować", async () => {
    const { token, username } = await zalogujSie("urzadzenie-passkey-1");
    const authenticator = await generujAuthenticator();

    const optionsRes = await post(
      "/auth/webauthn/register/options",
      {},
      { Authorization: `Bearer ${token}` },
    );
    expect(optionsRes.status).toBe(200);
    const options = await optionsRes.json<{ challenge: string }>();

    const response = await odpowiedzRejestracji(authenticator, options.challenge);
    const verifyRes = await post(
      "/auth/webauthn/register/verify",
      { response },
      { Authorization: `Bearer ${token}` },
    );
    expect(verifyRes.status).toBe(200);
    expect(await verifyRes.json<{ ok: boolean }>()).toEqual({ ok: true });

    const ip = crypto.randomUUID();
    const loginOptionsRes = await post("/auth/webauthn/login/options", {}, { "CF-Connecting-IP": ip });
    expect(loginOptionsRes.status).toBe(200);
    const loginOptions = await loginOptionsRes.json<{ challenge: string }>();

    const assertion = await odpowiedzLogowania(authenticator, loginOptions.challenge, 1);
    const loginVerifyRes = await post(
      "/auth/webauthn/login/verify",
      { response: assertion, deviceId: "urzadzenie-passkey-1-nowa-przegladarka" },
      { "CF-Connecting-IP": ip },
    );

    expect(loginVerifyRes.status).toBe(200);
    const wynik = await loginVerifyRes.json<{
      token: string;
      username: string;
      userId: string;
    }>();
    expect(wynik.token).toContain(".");
    expect(wynik.username).toBe(username);
  });

  /// Sedno: logowanie passkeyem musi umieć oddać token trwałej sesji w treści
  /// tak samo jak logowanie hasłem. Inaczej użytkownik iPhone'a, który
  /// przeszedł na passkey, dalej logowałby się przy każdym uruchomieniu —
  /// czyli wybrałby wygodniejszą metodę i dostał ten sam kłopot.
  it("logowanie passkeyem oddaje token trwałej sesji w treści, gdy klient o to prosi", async () => {
    const { token } = await zalogujSie("urzadzenie-passkey-tresc");
    const authenticator = await generujAuthenticator();

    const optionsRes = await post(
      "/auth/webauthn/register/options",
      {},
      { Authorization: `Bearer ${token}` },
    );
    const options = await optionsRes.json<{ challenge: string }>();
    const response = await odpowiedzRejestracji(authenticator, options.challenge);
    await post(
      "/auth/webauthn/register/verify",
      { response },
      { Authorization: `Bearer ${token}` },
    );

    const ip = crypto.randomUUID();
    const loginOptionsRes = await post("/auth/webauthn/login/options", {}, { "CF-Connecting-IP": ip });
    const loginOptions = await loginOptionsRes.json<{ challenge: string }>();
    const assertion = await odpowiedzLogowania(authenticator, loginOptions.challenge, 1);

    const deviceId = "urzadzenie-passkey-tresc-2";
    const verifyRes = await post(
      "/auth/webauthn/login/verify",
      { response: assertion, deviceId, sesjaWTresci: true },
      { "CF-Connecting-IP": ip },
    );

    expect(verifyRes.status).toBe(200);
    const { refreshToken } = await verifyRes.json<{ refreshToken?: string }>();
    expect(typeof refreshToken).toBe("string");

    // I ten token faktycznie odnawia sesję — bez cookie.
    const odnowienie = await post("/auth/refresh", { deviceId, refreshToken });
    expect(odnowienie.status).toBe(200);
  });

  it("wyzwanie rejestracji jest jednorazowe", async () => {
    const { token } = await zalogujSie("urzadzenie-passkey-2");
    const authenticator = await generujAuthenticator();

    const optionsRes = await post(
      "/auth/webauthn/register/options",
      {},
      { Authorization: `Bearer ${token}` },
    );
    const options = await optionsRes.json<{ challenge: string }>();
    const response = await odpowiedzRejestracji(authenticator, options.challenge);

    const pierwsza = await post(
      "/auth/webauthn/register/verify",
      { response },
      { Authorization: `Bearer ${token}` },
    );
    expect(pierwsza.status).toBe(200);

    const druga = await post(
      "/auth/webauthn/register/verify",
      { response },
      { Authorization: `Bearer ${token}` },
    );
    expect(druga.status).toBe(401);
  });
});

describe("logowanie passkeyem", () => {
  it("nieznany credential jest odrzucany", async () => {
    const authenticator = await generujAuthenticator();
    const ip = crypto.randomUUID();

    const optionsRes = await post("/auth/webauthn/login/options", {}, { "CF-Connecting-IP": ip });
    const options = await optionsRes.json<{ challenge: string }>();
    const assertion = await odpowiedzLogowania(authenticator, options.challenge, 1);

    const res = await post(
      "/auth/webauthn/login/verify",
      { response: assertion, deviceId: "jakies-urzadzenie" },
      { "CF-Connecting-IP": ip },
    );

    expect(res.status).toBe(401);
  });

  it("brak deviceId jest odrzucany", async () => {
    const { token } = await zalogujSie("urzadzenie-passkey-3");
    const authenticator = await generujAuthenticator();

    const optionsRes = await post(
      "/auth/webauthn/register/options",
      {},
      { Authorization: `Bearer ${token}` },
    );
    const options = await optionsRes.json<{ challenge: string }>();
    await post(
      "/auth/webauthn/register/verify",
      { response: await odpowiedzRejestracji(authenticator, options.challenge) },
      { Authorization: `Bearer ${token}` },
    );

    const ip = crypto.randomUUID();
    const loginOptionsRes = await post("/auth/webauthn/login/options", {}, { "CF-Connecting-IP": ip });
    const loginOptions = await loginOptionsRes.json<{ challenge: string }>();
    const assertion = await odpowiedzLogowania(authenticator, loginOptions.challenge, 1);

    const res = await post(
      "/auth/webauthn/login/verify",
      { response: assertion },
      { "CF-Connecting-IP": ip },
    );
    expect(res.status).toBe(400);
  });

  it("wyzwanie logowania jest jednorazowe", async () => {
    const { token } = await zalogujSie("urzadzenie-passkey-4");
    const authenticator = await generujAuthenticator();

    const optionsRes = await post(
      "/auth/webauthn/register/options",
      {},
      { Authorization: `Bearer ${token}` },
    );
    const options = await optionsRes.json<{ challenge: string }>();
    await post(
      "/auth/webauthn/register/verify",
      { response: await odpowiedzRejestracji(authenticator, options.challenge) },
      { Authorization: `Bearer ${token}` },
    );

    const ip = crypto.randomUUID();
    const loginOptionsRes = await post("/auth/webauthn/login/options", {}, { "CF-Connecting-IP": ip });
    const loginOptions = await loginOptionsRes.json<{ challenge: string }>();
    const assertion = await odpowiedzLogowania(authenticator, loginOptions.challenge, 1);

    const pierwsze = await post(
      "/auth/webauthn/login/verify",
      { response: assertion, deviceId: "urzadzenie-powtorka" },
      { "CF-Connecting-IP": ip },
    );
    expect(pierwsze.status).toBe(200);

    const drugie = await post(
      "/auth/webauthn/login/verify",
      { response: assertion, deviceId: "urzadzenie-powtorka" },
      { "CF-Connecting-IP": ip },
    );
    expect(drugie.status).toBe(401);
  });
});
