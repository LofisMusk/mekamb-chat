import {
  type AuthenticationResponseJSON,
  generateAuthenticationOptions,
  generateRegistrationOptions,
  type RegistrationResponseJSON,
  type VerifiedAuthenticationResponse,
  type VerifiedRegistrationResponse,
  verifyAuthenticationResponse,
  verifyRegistrationResponse,
} from "@simplewebauthn/server";
import { Hono } from "hono";

import { base64UrlToBytes, issueToken } from "./crypto";
import type { Env } from "./env";
import { requireAuth } from "./middleware";
import { issueRefreshToken } from "./session";

/**
 * Logowanie passkeyem — dodatkowa metoda obok OPAQUE+TOTP, nie zastępstwo.
 *
 * # Dlaczego biblioteka, a nie własny kod, skoro reszta kryptografii żyje w Rust
 *
 * `@simplewebauthn/server` nie robi tu kryptografii samodzielnie — podpisy
 * i tak są weryfikowane przez natywne Web Crypto. To, co robi, to parsowanie
 * formatów WebAuthn (CBOR, COSE, attestation object), które są specyficzne
 * dla tej ceremonii przeglądarki i serwera, a nie część współdzielonego
 * protokołu klient-klient jak OPAQUE czy MLS. Android nie bierze w tym
 * udziału (patrz CLAUDE.md, sekcja „Nie zaimplementowano" — brak passkeyi na
 * Androidzie), więc nie ma tu ryzyka rozjazdu dwóch niezależnych implementacji.
 *
 * # Klucze są discoverable (resident)
 *
 * Dzięki `residentKey: 'required'` logowanie nie wymaga wpisania nazwy
 * użytkownika — authenticator sam wskazuje, kim jest właściciel. To jest to,
 * co pozwala zastąpić pole „nazwa użytkownika + hasło" jednym kliknięciem.
 *
 * # `device_id` na credentialu jest informacyjny
 *
 * Passkey zarejestrowany w tej przeglądarce nie daje dostępu do lokalnego
 * magazynu (IndexedDB, `vault.ts`) innej przeglądarki — nawet gdy sam
 * passkey jest zsynchronizowany między urządzeniami przez menedżera haseł
 * systemu. Dlatego logowanie ZAWSZE działa na `deviceId` przysłanym przez
 * klienta (jego bieżące urządzenie), a nie na `device_id` zapisanym przy
 * rejestracji credentiala.
 */

const CHALLENGE_TTL_MS = 3 * 60 * 1000;
const TOKEN_TTL_MS = 24 * 60 * 60 * 1000;
const LOGIN_BUCKET = { capacity: 5, refillPerSecond: 1 / 30 };

const webauthn = new Hono<{
  Bindings: Env;
  Variables: { userId: string; deviceId: string | null };
}>();

async function withinRateLimit(env: Env, key: string): Promise<boolean> {
  const limiter = env.RATE_LIMITER.get(env.RATE_LIMITER.idFromName(key));
  const result = await limiter.consume(key, LOGIN_BUCKET.capacity, LOGIN_BUCKET.refillPerSecond);
  return result.allowed;
}

function allowedOrigins(env: Env): string[] {
  return (env.ALLOWED_ORIGINS ?? "")
    .split(",")
    .map((o) => o.trim())
    .filter(Boolean);
}

/** Wyciąga `challenge` z `clientDataJSON`, żeby odnaleźć pasujący wiersz w bazie. */
function decodeClientDataChallenge(clientDataJSON: string): string {
  const json = new TextDecoder().decode(base64UrlToBytes(clientDataJSON));
  const parsed = JSON.parse(json) as { challenge: string };
  if (typeof parsed.challenge !== "string") throw new Error("brak challenge");
  return parsed.challenge;
}

// ---------------------------------------------------------------------------
// Rejestracja passkeya — wymaga istniejącej sesji (użytkownik już zalogowany
// hasłem+TOTP przynajmniej raz). To dopisanie drugiej metody logowania do
// konta, nie zastępstwo pierwszego logowania.
// ---------------------------------------------------------------------------

webauthn.post("/register/options", requireAuth, async (c) => {
  const userId = c.get("userId");

  const user = await c.env.DB.prepare("SELECT username FROM users WHERE id = ?")
    .bind(userId)
    .first<{ username: string }>();

  if (user === null) {
    return c.json({ error: "nie znaleziono konta" }, 404);
  }

  const existing = await c.env.DB.prepare("SELECT id FROM webauthn_credentials WHERE user_id = ?")
    .bind(userId)
    .all<{ id: string }>();

  const options = await generateRegistrationOptions({
    rpName: c.env.WEBAUTHN_RP_NAME,
    rpID: c.env.WEBAUTHN_RP_ID,
    userName: user.username,
    userID: new Uint8Array(new TextEncoder().encode(userId)),
    attestationType: "none",
    excludeCredentials: existing.results.map((row) => ({ id: row.id })),
    // Resident + wymagana weryfikacja użytkownika: to razem daje logowanie
    // bez wpisywania nazwy użytkownika, na sam PIN/odcisk palca/klucz.
    authenticatorSelection: { residentKey: "required", userVerification: "required" },
  });

  await c.env.DB.prepare(
    `INSERT INTO webauthn_challenges (id, user_id, challenge, typ, expires_at)
     VALUES (?, ?, ?, 'rejestracja', ?)`,
  )
    .bind(crypto.randomUUID(), userId, options.challenge, Date.now() + CHALLENGE_TTL_MS)
    .run();

  return c.json(options);
});

webauthn.post("/register/verify", requireAuth, async (c) => {
  const userId = c.get("userId");
  const deviceId = c.get("deviceId") ?? "nieznane";
  const body = await c.req.json<{ response: RegistrationResponseJSON; nazwa?: string }>();

  // Konsumujemy wyzwanie niepodzielnie, tak samo jak `login_sessions` dla
  // OPAQUE — DELETE ... RETURNING gwarantuje jednorazowość.
  const challenge = await c.env.DB.prepare(
    `DELETE FROM webauthn_challenges
      WHERE user_id = ? AND typ = 'rejestracja' AND expires_at > ?
      RETURNING challenge`,
  )
    .bind(userId, Date.now())
    .first<{ challenge: string }>();

  if (challenge === null) {
    return c.json({ error: "sesja rejestracji jest nieważna" }, 401);
  }

  let verification: VerifiedRegistrationResponse;
  try {
    verification = await verifyRegistrationResponse({
      response: body.response,
      expectedChallenge: challenge.challenge,
      expectedOrigin: allowedOrigins(c.env),
      expectedRPID: c.env.WEBAUTHN_RP_ID,
      requireUserVerification: true,
    });
  } catch {
    return c.json({ error: "weryfikacja nie powiodła się" }, 400);
  }

  if (!verification.verified) {
    return c.json({ error: "weryfikacja nie powiodła się" }, 400);
  }

  const { credential } = verification.registrationInfo;

  await c.env.DB.prepare(
    `INSERT INTO webauthn_credentials
       (id, user_id, device_id, public_key, sign_count, transports, nazwa, created_at)
     VALUES (?, ?, ?, ?, ?, ?, ?, ?)`,
  )
    .bind(
      credential.id,
      userId,
      deviceId,
      credential.publicKey,
      credential.counter,
      credential.transports ? JSON.stringify(credential.transports) : null,
      body.nazwa ?? null,
      Date.now(),
    )
    .run();

  return c.json({ ok: true });
});

// ---------------------------------------------------------------------------
// Logowanie passkeyem — bez podawania nazwy użytkownika (discoverable).
// ---------------------------------------------------------------------------

webauthn.post("/login/options", async (c) => {
  const ip = c.req.header("CF-Connecting-IP") ?? "brak-ip";
  if (!(await withinRateLimit(c.env, `webauthn-login:${ip}`))) {
    return c.json({ error: "zbyt wiele prób" }, 429);
  }

  const options = await generateAuthenticationOptions({
    rpID: c.env.WEBAUTHN_RP_ID,
    userVerification: "required",
  });

  await c.env.DB.prepare(
    `INSERT INTO webauthn_challenges (id, user_id, challenge, typ, expires_at)
     VALUES (?, NULL, ?, 'logowanie', ?)`,
  )
    .bind(crypto.randomUUID(), options.challenge, Date.now() + CHALLENGE_TTL_MS)
    .run();

  return c.json(options);
});

webauthn.post("/login/verify", async (c) => {
  const ip = c.req.header("CF-Connecting-IP") ?? "brak-ip";
  if (!(await withinRateLimit(c.env, `webauthn-login:${ip}`))) {
    return c.json({ error: "zbyt wiele prób" }, 429);
  }

  const body = await c.req.json<{ response: AuthenticationResponseJSON; deviceId?: string }>();

  if (!body.deviceId) {
    return c.json({ error: "brak deviceId" }, 400);
  }

  let challengeValue: string;
  try {
    challengeValue = decodeClientDataChallenge(body.response.response.clientDataJSON);
  } catch {
    return c.json({ error: "nieprawidłowa odpowiedź" }, 400);
  }

  const challenge = await c.env.DB.prepare(
    `DELETE FROM webauthn_challenges
      WHERE challenge = ? AND typ = 'logowanie' AND expires_at > ?
      RETURNING id`,
  )
    .bind(challengeValue, Date.now())
    .first<{ id: string }>();

  if (challenge === null) {
    return c.json({ error: "sesja logowania jest nieważna" }, 401);
  }

  const credentialRow = await c.env.DB.prepare(
    `SELECT wc.user_id AS userId, wc.public_key AS publicKey, wc.sign_count AS signCount,
            u.username AS username
       FROM webauthn_credentials wc
       JOIN users u ON u.id = wc.user_id
      WHERE wc.id = ?`,
  )
    .bind(body.response.id)
    .first<{ userId: string; publicKey: ArrayBuffer; signCount: number; username: string }>();

  if (credentialRow === null) {
    return c.json({ error: "nieznany passkey" }, 401);
  }

  let verification: VerifiedAuthenticationResponse;
  try {
    verification = await verifyAuthenticationResponse({
      response: body.response,
      expectedChallenge: challengeValue,
      expectedOrigin: allowedOrigins(c.env),
      expectedRPID: c.env.WEBAUTHN_RP_ID,
      credential: {
        id: body.response.id,
        publicKey: new Uint8Array(credentialRow.publicKey),
        counter: credentialRow.signCount,
      },
      requireUserVerification: true,
    });
  } catch {
    return c.json({ error: "weryfikacja nie powiodła się" }, 401);
  }

  if (!verification.verified) {
    return c.json({ error: "weryfikacja nie powiodła się" }, 401);
  }

  // Ochrona przed sklonowanym authenticatorem: rosnący licznik, który się
  // cofnął albo powtórzył, zdradza kopię — tu tylko go uaktualniamy, wg
  // wartości already zweryfikowanej przez bibliotekę.
  await c.env.DB.prepare("UPDATE webauthn_credentials SET sign_count = ?, last_used_at = ? WHERE id = ?")
    .bind(verification.authenticationInfo.newCounter, Date.now(), body.response.id)
    .run();

  const expiresAt = Date.now() + TOKEN_TTL_MS;
  const token = await issueToken(c.env.TOKEN_SIGNING_KEY, {
    userId: credentialRow.userId,
    deviceId: body.deviceId,
    expiresAt,
  });

  await issueRefreshToken(c, credentialRow.userId, body.deviceId);

  return c.json({
    token,
    expiresAt,
    userId: credentialRow.userId,
    username: credentialRow.username,
  });
});

export default webauthn;
