import {
  ExpectedAuthResult,
  KE1,
  KE3,
  OpaqueID,
  OpaqueServer,
  RegistrationRecord,
  RegistrationRequest,
  getOpaqueConfig,
} from "@cloudflare/opaque-ts";
import { Hono } from "hono";

import { base64ToBytes, bytesToBase64, decryptSecret, encryptSecret, issueToken } from "./crypto";
import type { Env } from "./env";
import { generateSecret, isReplay, provisioningUri, verifyCode } from "./totp";

/**
 * Rejestracja i logowanie.
 *
 * # Co uwierzytelnienie tu chroni
 *
 * Dostęp do **infrastruktury**: skrzynki offline, katalogu, key packages.
 * Nie odblokowuje wiadomości — ich klucze nigdy nie opuszczają urządzenia.
 * Przejęcie konta nie daje historii rozmów, bo serwer jej nie przechowuje.
 *
 * # Dlaczego OPAQUE, a nie hasło przez TLS plus hash
 *
 * Przy zwykłym hashu serwer **widzi hasło** w chwili logowania, a jego baza
 * pozwala na atak słownikowy offline. W OPAQUE hasło nie opuszcza klienta
 * w żadnej postaci, a z rekordu w bazie nie da się prowadzić takiego ataku.
 * Serwer nie ma czego wyciec, bo nigdy tego nie miał.
 *
 * # Ochrona przed enumeracją kont
 *
 * Logowanie nieistniejącą nazwą przechodzi **tę samą** ścieżkę co prawdziwe:
 * zakładamy sesję, odpowiadamy atrapą rekordu i pozwalamy dojść aż do kroku
 * TOTP. Bez tego kształt albo czas odpowiedzi zdradzałby, które konta istnieją.
 */

const cfg = getOpaqueConfig(OpaqueID.OPAQUE_P256);

/** Tożsamość serwera w protokole — wiąże sesję z konkretnym wdrożeniem. */
const SERVER_IDENTITY = "mekamb-chat";

/** Jak długo żyje sesja logowania. Ma starczyć na dwie rundy, nie na atak. */
const LOGIN_SESSION_TTL_MS = 3 * 60 * 1000;

/** Czas życia tokenu dostępowego. */
const TOKEN_TTL_MS = 24 * 60 * 60 * 1000;

/** Limit prób logowania: 5 w serii, jedna odnawiana co 30 sekund. */
const LOGIN_BUCKET = { capacity: 5, refillPerSecond: 1 / 30 };

const auth = new Hono<{ Bindings: Env }>();

/** Buduje instancję serwera OPAQUE z sekretów środowiska. */
async function opaqueServer(env: Env): Promise<OpaqueServer> {
  const oprfSeed = Array.from(base64ToBytes(env.OPAQUE_OPRF_SEED));

  // Klucz AKE wyprowadzamy deterministycznie z ziarna. Losowanie przy każdym
  // starcie Workera zmieniałoby tożsamość serwera i unieważniało rejestracje.
  const keypair = await cfg.ake.deriveAuthKeyPair(base64ToBytes(env.OPAQUE_AKE_SEED));

  return new OpaqueServer(
    cfg,
    oprfSeed,
    {
      private_key: Array.from(keypair.private_key),
      public_key: Array.from(keypair.public_key),
    },
    SERVER_IDENTITY,
  );
}

/** Sprawdza limit prób dla danego klucza. */
async function withinRateLimit(env: Env, key: string): Promise<boolean> {
  const limiter = env.RATE_LIMITER.get(env.RATE_LIMITER.idFromName(key));
  const result = await limiter.consume(key, LOGIN_BUCKET.capacity, LOGIN_BUCKET.refillPerSecond);
  return result.allowed;
}

// ---------------------------------------------------------------------------
// Rejestracja
// ---------------------------------------------------------------------------

/**
 * Krok 1: klient prosi o odpowiedź rejestracyjną.
 *
 * Ten endpoint z natury zdradza, czy nazwa jest wolna — tak działa każda
 * rejestracja i nie da się tego uniknąć bez rezygnacji z nazw użytkownika.
 * Logowanie takiego wycieku już nie ma.
 */
auth.post("/register/start", async (c) => {
  const body = await c.req.json<{ username: string; registrationRequest: string }>();

  if (!isValidUsername(body.username)) {
    return c.json({ error: "nieprawidłowa nazwa użytkownika" }, 400);
  }

  const existing = await c.env.DB.prepare("SELECT id FROM users WHERE username = ?")
    .bind(body.username)
    .first<{ id: string }>();

  if (existing !== null) {
    return c.json({ error: "nazwa jest zajęta" }, 409);
  }

  const server = await opaqueServer(c.env);
  const request = RegistrationRequest.deserialize(
    cfg,
    Array.from(base64ToBytes(body.registrationRequest)),
  );

  const response = await server.registerInit(request, body.username);
  if (response instanceof Error) {
    return c.json({ error: "nie udało się rozpocząć rejestracji" }, 400);
  }

  return c.json({
    registrationResponse: bytesToBase64(Uint8Array.from(response.serialize())),
  });
});

/**
 * Krok 2: klient przesyła rekord rejestracyjny; zakładamy konto w stanie
 * `pending` i zwracamy sekret TOTP do zeskanowania.
 */
auth.post("/register/finish", async (c) => {
  const body = await c.req.json<{ username: string; registrationRecord: string }>();

  if (!isValidUsername(body.username)) {
    return c.json({ error: "nieprawidłowa nazwa użytkownika" }, 400);
  }

  const totpSecret = generateSecret();
  const userId = crypto.randomUUID();

  try {
    await c.env.DB.prepare(
      `INSERT INTO users (id, username, opaque_record, totp_secret_enc, created_at, status)
       VALUES (?, ?, ?, ?, ?, 'pending')`,
    )
      .bind(
        userId,
        body.username,
        body.registrationRecord,
        await encryptSecret(c.env.TOTP_ENCRYPTION_KEY, totpSecret),
        Date.now(),
      )
      .run();
  } catch {
    // Wyścig z inną rejestracją tej samej nazwy — łapie to więz UNIQUE.
    return c.json({ error: "nazwa jest zajęta" }, 409);
  }

  // Sekret wychodzi na zewnątrz dokładnie raz, tutaj. Później jest już tylko
  // zaszyfrowany w bazie i nie ma endpointu, który by go odczytał.
  return c.json({
    totpSecret,
    otpauthUri: provisioningUri(totpSecret, body.username),
  });
});

/**
 * Krok 3: potwierdzenie kodem z authenticatora aktywuje konto.
 *
 * Bez tego kroku użytkownik, który nie zeskanował QR, miałby konto, do którego
 * nigdy się nie zaloguje — a odzyskanie go wymagałoby furtki po stronie
 * serwera, której świadomie nie ma.
 *
 * # Skutek uboczny, którego nie należy „naprawiać"
 *
 * Aktywacja zapisuje zużyte okno czasowe, więc **ten sam kod nie zadziała już
 * przy logowaniu**. Użytkownik musi poczekać na następny — do 30 sekund.
 * To nie jest błąd: RFC 6238 §5.2 wprost zabrania przyjęcia drugiego kodu
 * o tej samej wartości w tym samym oknie. Interfejs powinien to wytłumaczyć
 * („poczekaj na nowy kod"), a nie obchodzić.
 */
auth.post("/register/confirm", async (c) => {
  const body = await c.req.json<{ username: string; code: string }>();

  const user = await c.env.DB.prepare(
    "SELECT id, totp_secret_enc, status FROM users WHERE username = ?",
  )
    .bind(body.username)
    .first<{ id: string; totp_secret_enc: string; status: string }>();

  if (user === null || user.status !== "pending") {
    return c.json({ error: "nie ma czego potwierdzać" }, 400);
  }

  const secret = await decryptSecret(c.env.TOTP_ENCRYPTION_KEY, user.totp_secret_enc);
  const result = verifyCode(secret, body.code);

  if (!result.valid) {
    return c.json({ error: "nieprawidłowy kod" }, 401);
  }

  await c.env.DB.prepare("UPDATE users SET status = 'active', totp_last_counter = ? WHERE id = ?")
    .bind(result.counter, user.id)
    .run();

  return c.json({ ok: true });
});

// ---------------------------------------------------------------------------
// Logowanie
// ---------------------------------------------------------------------------

/** Runda 1: wymiana OPAQUE. */
auth.post("/login/start", async (c) => {
  const body = await c.req.json<{ username: string; ke1: string }>();

  if (!(await withinRateLimit(c.env, `login:${body.username}`))) {
    return c.json({ error: "zbyt wiele prób" }, 429);
  }

  const user = await c.env.DB.prepare(
    "SELECT id, opaque_record FROM users WHERE username = ? AND status = 'active'",
  )
    .bind(body.username)
    .first<{ id: string; opaque_record: string }>();

  // Dla nieznanej nazwy używamy atrapy rekordu i idziemy dalej tą samą drogą.
  // Odpowiedź musi być nieodróżnialna od prawdziwej.
  const record =
    user === null
      ? await RegistrationRecord.createFake(cfg)
      : RegistrationRecord.deserialize(cfg, Array.from(base64ToBytes(user.opaque_record)));

  const server = await opaqueServer(c.env);
  const ke1 = KE1.deserialize(cfg, Array.from(base64ToBytes(body.ke1)));

  const started = await server.authInit(ke1, record, body.username, body.username);
  if (started instanceof Error) {
    return c.json({ error: "nie udało się rozpocząć logowania" }, 400);
  }

  const loginId = crypto.randomUUID();
  const now = Date.now();

  await c.env.DB.prepare(
    `INSERT INTO login_sessions (id, user_id, expected, stage, created_at, expires_at)
     VALUES (?, ?, ?, 'awaiting-opaque', ?, ?)`,
  )
    .bind(
      loginId,
      user?.id ?? null,
      bytesToBase64(Uint8Array.from(started.expected.serialize())),
      now,
      now + LOGIN_SESSION_TTL_MS,
    )
    .run();

  return c.json({
    loginId,
    ke2: bytesToBase64(Uint8Array.from(started.ke2.serialize())),
  });
});

/** Runda 2: weryfikacja dowodu klienta, przejście do kroku TOTP. */
auth.post("/login/finish", async (c) => {
  const body = await c.req.json<{ loginId: string; ke3: string }>();

  // Sesję konsumujemy niepodzielnie: DELETE ... RETURNING gwarantuje, że ten
  // sam rekord nie zostanie użyty dwa razy, nawet przy równoległych żądaniach.
  const session = await c.env.DB.prepare(
    `DELETE FROM login_sessions
      WHERE id = ? AND stage = 'awaiting-opaque' AND expires_at > ?
      RETURNING user_id, expected`,
  )
    .bind(body.loginId, Date.now())
    .first<{ user_id: string | null; expected: string }>();

  if (session === null) {
    return c.json({ error: "sesja logowania jest nieważna" }, 401);
  }

  const server = await opaqueServer(c.env);
  const expected = ExpectedAuthResult.deserialize(
    cfg,
    Array.from(base64ToBytes(session.expected)),
  );
  const ke3 = KE3.deserialize(cfg, Array.from(base64ToBytes(body.ke3)));

  const finished = server.authFinish(ke3, expected);

  // Nieznana nazwa użytkownika kończy się tu tak samo jak złe hasło —
  // tym samym komunikatem i tym samym kodem odpowiedzi.
  if (finished instanceof Error || session.user_id === null) {
    return c.json({ error: "nieprawidłowe dane logowania" }, 401);
  }

  const now = Date.now();
  await c.env.DB.prepare(
    `INSERT INTO login_sessions (id, user_id, expected, stage, created_at, expires_at)
     VALUES (?, ?, '', 'awaiting-totp', ?, ?)`,
  )
    .bind(body.loginId, session.user_id, now, now + LOGIN_SESSION_TTL_MS)
    .run();

  return c.json({ totpRequired: true, loginId: body.loginId });
});

/** Runda 3: drugi składnik. Dopiero tutaj powstaje token dostępowy. */
auth.post("/login/totp", async (c) => {
  const body = await c.req.json<{ loginId: string; code: string; deviceId?: string }>();

  if (!(await withinRateLimit(c.env, `totp:${body.loginId}`))) {
    return c.json({ error: "zbyt wiele prób" }, 429);
  }

  const session = await c.env.DB.prepare(
    `DELETE FROM login_sessions
      WHERE id = ? AND stage = 'awaiting-totp' AND expires_at > ?
      RETURNING user_id`,
  )
    .bind(body.loginId, Date.now())
    .first<{ user_id: string }>();

  if (session === null) {
    return c.json({ error: "sesja logowania jest nieważna" }, 401);
  }

  const user = await c.env.DB.prepare(
    "SELECT totp_secret_enc, totp_last_counter FROM users WHERE id = ?",
  )
    .bind(session.user_id)
    .first<{ totp_secret_enc: string; totp_last_counter: number | null }>();

  if (user === null) {
    return c.json({ error: "nieprawidłowe dane logowania" }, 401);
  }

  const secret = await decryptSecret(c.env.TOTP_ENCRYPTION_KEY, user.totp_secret_enc);
  const result = verifyCode(secret, body.code);

  if (!result.valid || result.counter === null) {
    return c.json({ error: "nieprawidłowy kod" }, 401);
  }

  // Podsłuchany kod działa przez całe swoje okno. Odrzucamy okno już użyte,
  // żeby powtórzenie było bezużyteczne.
  if (isReplay(result.counter, user.totp_last_counter)) {
    return c.json({ error: "kod został już użyty" }, 401);
  }

  await c.env.DB.prepare("UPDATE users SET totp_last_counter = ? WHERE id = ?")
    .bind(result.counter, session.user_id)
    .run();

  // Udane logowanie zwalnia limit — inaczej seria pomyłek karałaby użytkownika
  // jeszcze długo po tym, jak w końcu wszedł.
  const limiter = c.env.RATE_LIMITER.get(c.env.RATE_LIMITER.idFromName(`totp:${body.loginId}`));
  await limiter.reset(`totp:${body.loginId}`);

  const expiresAt = Date.now() + TOKEN_TTL_MS;
  const token = await issueToken(c.env.TOKEN_SIGNING_KEY, {
    userId: session.user_id,
    deviceId: body.deviceId ?? null,
    expiresAt,
  });

  return c.json({ token, expiresAt });
});

/**
 * Nazwa użytkownika: 3–32 znaki, litery, cyfry, kropka, myślnik, podkreślenie.
 *
 * Dwukropek jest zakazany, bo rozdziela `user_id` i `device_id` w credentialu
 * MLS — dopuszczenie go pozwoliłoby podszyć się pod cudzą parę.
 */
export function isValidUsername(username: unknown): username is string {
  return typeof username === "string" && /^[a-z0-9._-]{3,32}$/i.test(username);
}

export default auth;
