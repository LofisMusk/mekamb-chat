import { Hono } from "hono";
import { getCookie } from "hono/cookie";

import * as opaque from "./opaque-wasm/index.js";

import { base64ToBytes, bytesToBase64, decryptSecret, encryptSecret, hashRefreshToken, issueToken } from "./crypto";
import type { Env } from "./env";
import { clearRefreshCookie, issueRefreshToken, REFRESH_COOKIE_NAME } from "./session";
import { generateSecret, isReplay, provisioningUri, verifyCode } from "./totp";
import webauthn from "./webauthn";

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
 * # Implementacja jest wspólna z klientami
 *
 * Cała kryptografia siedzi w `mekamb-opaque` (Rust, RFC 9807) i jest tu
 * używana przez WebAssembly. Ten sam kod działa w przeglądarce i na Androidzie.
 *
 * To nie jest wybór estetyczny. Poprzednio serwer miał implementację
 * w TypeScripcie realizującą **draft-07** protokołu, a klient natywny miałby
 * rustową realizującą **RFC 9807** — te dwie nigdy by się nie dogadały.
 * Wspólny kod usuwa całą klasę problemów ze zgodnością.
 *
 * # Ochrona przed enumeracją kont
 *
 * Logowanie nieistniejącą nazwą przechodzi **tę samą** ścieżkę co prawdziwe:
 * zakładamy sesję, odpowiadamy atrapą rekordu i pozwalamy dojść aż do kroku
 * TOTP. Bez tego kształt albo czas odpowiedzi zdradzałby, które konta istnieją.
 */

/** Jak długo żyje sesja logowania. Ma starczyć na dwie rundy, nie na atak. */
const LOGIN_SESSION_TTL_MS = 3 * 60 * 1000;

/** Czas życia tokenu dostępowego. */
const TOKEN_TTL_MS = 24 * 60 * 60 * 1000;

/** Limit prób logowania: 5 w serii, jedna odnawiana co 30 sekund. */
const LOGIN_BUCKET = { capacity: 5, refillPerSecond: 1 / 30 };

const auth = new Hono<{ Bindings: Env }>();

auth.route("/webauthn", webauthn);

/**
 * Sekret serwera OPAQUE z Workers Secrets.
 *
 * **Jego zmiana unieważnia wszystkie konta** — z niego wyprowadzany jest
 * materiał wiążący hasła użytkowników z tym wdrożeniem.
 */
function serverKey(env: Env): Uint8Array {
  return base64ToBytes(env.OPAQUE_SERVER_KEY);
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

  let response: Uint8Array;
  try {
    response = opaque.registrationStart(
      serverKey(c.env),
      body.username,
      base64ToBytes(body.registrationRequest),
    );
  } catch {
    return c.json({ error: "nie udało się rozpocząć rejestracji" }, 400);
  }

  return c.json({ registrationResponse: bytesToBase64(response) });
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

  // Rekord konta wylicza serwer z odpowiedzi klienta. Klient nie może go
  // podać wprost — inaczej podstawiłby dowolny i logowałby się bez znajomości
  // hasła.
  let record: Uint8Array;
  try {
    record = opaque.registrationFinish(base64ToBytes(body.registrationRecord));
  } catch {
    return c.json({ error: "nieprawidłowa odpowiedź rejestracyjna" }, 400);
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
        bytesToBase64(record),
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

  // Dla nieznanej nazwy przekazujemy `undefined` i idziemy dalej tą samą drogą.
  // Biblioteka produkuje wtedy odpowiedź nieodróżnialną od prawdziwej —
  // to jedyne, co powstrzymuje sprawdzanie, które konta są zajęte.
  let started: { response: Uint8Array; state: Uint8Array };
  try {
    started = opaque.loginStart(
      serverKey(c.env),
      body.username,
      user === null ? undefined : base64ToBytes(user.opaque_record),
      base64ToBytes(body.ke1),
    );
  } catch {
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
      bytesToBase64(started.state),
      now,
      now + LOGIN_SESSION_TTL_MS,
    )
    .run();

  return c.json({ loginId, ke2: bytesToBase64(started.response) });
});

/** Runda 2: weryfikacja dowodu klienta, przejście do kroku TOTP. */
auth.post("/login/finish", async (c) => {
  const body = await c.req.json<{ loginId: string; username: string; ke3: string }>();

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

  // Nieznana nazwa użytkownika kończy się tu tak samo jak złe hasło —
  // tym samym komunikatem i tym samym kodem odpowiedzi.
  try {
    opaque.loginFinish(
      base64ToBytes(session.expected),
      body.username,
      base64ToBytes(body.ke3),
    );
  } catch {
    return c.json({ error: "nieprawidłowe dane logowania" }, 401);
  }

  if (session.user_id === null) {
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
  const body = await c.req.json<{
    loginId: string;
    code: string;
    deviceId?: string;
    sesjaWTresci?: boolean;
  }>();

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

  // Bez `deviceId` nie ma czego użyć jako klucza rotacji — trwała sesja po
  // prostu nie włącza się dla tego logowania, reszta ścieżki działa jak dziś.
  if (!body.deviceId) {
    return c.json({ token, expiresAt });
  }

  const refreshToken = await issueRefreshToken(c, session.user_id, body.deviceId);

  // Token w treści tylko na życzenie — patrz `session.ts`, dlaczego to nie
  // jest domyślne i dlaczego mimo to musi istnieć.
  return c.json(body.sesjaWTresci ? { token, expiresAt, refreshToken } : { token, expiresAt });
});

// ---------------------------------------------------------------------------
// Trwała sesja
// ---------------------------------------------------------------------------

/**
 * Wymienia token odświeżający na nowy token dostępowy.
 *
 * Klient wywołuje to przy starcie aplikacji zamiast wymuszać OPAQUE+TOTP —
 * patrz `App.tsx`, gdzie zastępuje to dotychczasowe „zawsze pokaż ekran
 * logowania po odświeżeniu strony".
 *
 * Token bierzemy z cookie, a gdy go nie ma — z treści żądania. Ta druga droga
 * istnieje dla przeglądarek blokujących cookie trzeciej strony; uzasadnienie
 * i koszt opisuje `session.ts`.
 *
 * Token jest ROTOWANY: nowy nadpisuje stary wiersz w bazie, więc powtórne
 * przedstawienie starego (np. skradzionego przed rotacją) tokenu już nie
 * znajduje dopasowania i kończy się 401 — to jedyna potrzebna ochrona przed
 * powtórzeniem, bez osobnego mechanizmu detekcji.
 */
auth.post("/refresh", async (c) => {
  const body = await c.req
    .json<{ deviceId?: string; refreshToken?: string; sesjaWTresci?: boolean }>()
    .catch(() => ({ deviceId: undefined, refreshToken: undefined, sesjaWTresci: undefined }));

  const raw = getCookie(c, REFRESH_COOKIE_NAME) ?? body.refreshToken;

  if (!raw || !body.deviceId) {
    return c.json({ error: "brak trwałej sesji" }, 401);
  }

  if (!(await withinRateLimit(c.env, `refresh:${body.deviceId}`))) {
    return c.json({ error: "zbyt wiele prób" }, 429);
  }

  const hash = await hashRefreshToken(raw);
  const row = await c.env.DB.prepare(
    `SELECT user_id FROM refresh_tokens
      WHERE device_id = ? AND token_hash = ? AND expires_at > ?`,
  )
    .bind(body.deviceId, hash, Date.now())
    .first<{ user_id: string }>();

  if (row === null) {
    clearRefreshCookie(c);
    return c.json({ error: "trwała sesja wygasła" }, 401);
  }

  const refreshToken = await issueRefreshToken(c, row.user_id, body.deviceId);

  const expiresAt = Date.now() + TOKEN_TTL_MS;
  const token = await issueToken(c.env.TOKEN_SIGNING_KEY, {
    userId: row.user_id,
    deviceId: body.deviceId,
    expiresAt,
  });

  // Rotacja jest bezwarunkowa, więc klient, który przysłał token w treści,
  // MUSI dostać nowy tą samą drogą — inaczej zostałby ze zużytym i kolejny
  // start aplikacji skończyłby się wylogowaniem.
  return c.json(
    body.sesjaWTresci || body.refreshToken ? { token, expiresAt, refreshToken } : { token, expiresAt },
  );
});

/** Kasuje trwałą sesję — wywoływane przy jawnym wylogowaniu. */
auth.post("/logout", async (c) => {
  const body = await c.req.json<{ deviceId?: string }>().catch(() => ({ deviceId: undefined }));

  if (body.deviceId) {
    await c.env.DB.prepare("DELETE FROM refresh_tokens WHERE device_id = ?")
      .bind(body.deviceId)
      .run();
  }

  clearRefreshCookie(c);
  return c.json({ ok: true });
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
