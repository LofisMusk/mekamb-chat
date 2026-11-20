import {
  type AuthenticationResponseJSON,
  generateAuthenticationOptions,
  verifyAuthenticationResponse,
} from "@simplewebauthn/server";
import { Hono } from "hono";
import { getCookie } from "hono/cookie";

import * as opaque from "./opaque-wasm/index.js";

import { base64ToBytes, bytesToBase64, decryptSecret, encryptSecret, hashRefreshToken, issueToken } from "./crypto";
import { trybDeweloperski } from "./dev";
import type { Env } from "./env";
import { requireAuth } from "./middleware";
import { clearRefreshCookie, issueRefreshToken, REFRESH_COOKIE_NAME } from "./session";
import { generateSecret, isReplay, provisioningUri, verifyCode } from "./totp";
import webauthn, { allowedOrigins, decodeClientDataChallenge } from "./webauthn";

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
  // Tryb dev: bez limitów, żeby zautomatyzowane testy nie zablokowały się same
  // serią logowań. W produkcji flaga nie jest ustawiona — limit działa normalnie.
  if (trybDeweloperski(env)) {
    return true;
  }
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

  // Tryb dev: konto od razu aktywne, żeby pominąć krok skanowania QR i kodu.
  // Produkcja zostaje przy 'pending' — aktywacja dopiero po potwierdzeniu TOTP.
  const status = trybDeweloperski(c.env) ? "active" : "pending";

  try {
    await c.env.DB.prepare(
      `INSERT INTO users (id, username, opaque_record, totp_secret_enc, created_at, status)
       VALUES (?, ?, ?, ?, ?, ?)`,
    )
      .bind(
        userId,
        body.username,
        bytesToBase64(record),
        await encryptSecret(c.env.TOTP_ENCRYPTION_KEY, totpSecret),
        Date.now(),
        status,
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
 *
 * # Dlaczego confirm od razu wydaje sesję
 *
 * Wcześniej confirm zwracał tylko `{ ok: true }`, więc po założeniu konta
 * i wpisaniu kodu użytkownik lądował na ekranie logowania — musiał przejść
 * OPAQUE + TOTP jeszcze raz, w dodatku czekając na następne okno kodu (to samo
 * spalił przed chwilą przy aktywacji). To był zbędny, wręcz mylący krok:
 * w tym momencie użytkownik **udowodnił oba składniki** — hasło ustawił
 * w `register/finish`, a znajomość sekretu TOTP właśnie potwierdził kodem.
 * Wydajemy więc pełną sesję dokładnie tak samo, jak `login/totp`: ten sam
 * token dostępowy, ten sam token odświeżający i ten sam warunek na `deviceId`
 * oraz `sesjaWTresci`. Kształt odpowiedzi jest identyczny, żeby klient miał
 * jedną ścieżkę „mam sesję" niezależnie od tego, czy wszedł przez logowanie,
 * czy przez świeżą rejestrację.
 *
 * Tożsamości to nie zaburza: token niesie `userId` (UUID z bazy) i `deviceId`,
 * a skrzynka i tak jest adresowana nazwą użytkownika — klient wyprowadza ją
 * z loginu, nie z tokenu.
 */
auth.post("/register/confirm", async (c) => {
  const body = await c.req.json<{
    username: string;
    code: string;
    deviceId?: string;
    sesjaWTresci?: boolean;
  }>();

  const user = await c.env.DB.prepare(
    "SELECT id, totp_secret_enc, status FROM users WHERE username = ?",
  )
    .bind(body.username)
    .first<{ id: string; totp_secret_enc: string; status: string }>();

  const dev = trybDeweloperski(c.env);

  // W trybie dev konto jest już aktywne po register/finish — nie ma tu stanu
  // 'pending' do potwierdzania, więc nie wymagamy go, a kodu nie sprawdzamy.
  if (user === null || (!dev && user.status !== "pending")) {
    return c.json({ error: "nie ma czego potwierdzać" }, 400);
  }

  if (!dev) {
    const secret = await decryptSecret(c.env.TOTP_ENCRYPTION_KEY, user.totp_secret_enc);
    const result = verifyCode(secret, body.code);

    if (!result.valid) {
      return c.json({ error: "nieprawidłowy kod" }, 401);
    }

    await c.env.DB.prepare("UPDATE users SET status = 'active', totp_last_counter = ? WHERE id = ?")
      .bind(result.counter, user.id)
      .run();
  }

  // Konto aktywne — użytkownik spełnił oba składniki, więc od razu dostaje
  // sesję w tym samym kształcie co `login/totp`.
  const expiresAt = Date.now() + TOKEN_TTL_MS;
  const token = await issueToken(c.env.TOKEN_SIGNING_KEY, {
    userId: user.id,
    deviceId: body.deviceId ?? null,
    expiresAt,
  });

  // Bez `deviceId` nie ma czego użyć jako klucza rotacji — trwała sesja się
  // nie włącza, tak samo jak w `login/totp`.
  if (!body.deviceId) {
    return c.json({ token, expiresAt });
  }

  const refreshToken = await issueRefreshToken(c, user.id, body.deviceId);

  // Token w treści tylko na życzenie — patrz `session.ts`.
  return c.json(body.sesjaWTresci ? { token, expiresAt, refreshToken } : { token, expiresAt });
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

  // Tryb dev: 2FA pomijane — dowolny kod przechodzi, żeby nie trzeba było mieć
  // authenticatora do testów. Ekran kodu w kliencie zostaje (żaden klient nie
  // wymaga zmian), wystarczy wpisać cokolwiek. Produkcja sprawdza kod normalnie.
  if (!trybDeweloperski(c.env)) {
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
  }

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

/**
 * Kasuje trwałą sesję — wywoływane przy jawnym wylogowaniu.
 *
 * # Dlaczego sam `deviceId` nie wystarcza
 *
 * Bo nie jest sekretem. `GET /directory/:username` wydaje identyfikatory
 * urządzeń każdemu, bez uwierzytelnienia — a ta trasa kasowała po nich wiersz
 * z `refresh_tokens` nie sprawdzając niczego więcej. Ktokolwiek mógł więc
 * wylogować dowolną osobę: przy następnym starcie aplikacji zamiast cichego
 * odświeżenia sesji dostawała pełne OPAQUE + TOTP. Android nawet **wysyłał**
 * token odświeżający, tylko serwer go nie czytał.
 *
 * Kasujemy więc dopiero po dopasowaniu `token_hash` — tak samo, jak wpuszcza
 * `/auth/refresh`. Wylogowanie jest przez to możliwe wyłącznie dla tego, kto
 * ten token ma, czyli dla właściciela sesji.
 *
 * Odpowiedź jest zawsze `ok`: wylogowanie ma kończyć się wylogowaniem także
 * wtedy, gdy sesji już nie było, a rozróżnienie mówiłoby pytającemu, które
 * pary `deviceId` + token istnieją. Ciasteczko czyścimy bezwarunkowo, bo to
 * dotyczy wyłącznie przeglądarki, która o to prosi.
 */
auth.post("/logout", async (c) => {
  const body = await c.req
    .json<{ deviceId?: string; refreshToken?: string }>()
    .catch(() => ({ deviceId: undefined, refreshToken: undefined }));

  const raw = getCookie(c, REFRESH_COOKIE_NAME) ?? body.refreshToken;

  if (body.deviceId && raw) {
    await c.env.DB.prepare("DELETE FROM refresh_tokens WHERE device_id = ? AND token_hash = ?")
      .bind(body.deviceId, await hashRefreshToken(raw))
      .run();
  }

  clearRefreshCookie(c);
  return c.json({ ok: true });
});

// ---------------------------------------------------------------------------
// Zmiana authenticatora (drugiego składnika)
//
// # Dlaczego to wymaga PONOWNEGO uwierzytelnienia
//
// Wszystkie trzy endpointy są `requireAuth` — czyli ktoś już ma ważny token,
// więc już kiedyś podał hasło i kod. Ale token żyje długo, a wymiana drugiego
// składnika to najcięższa rzecz, jaką można zrobić na koncie: kto podmieni
// authenticator, ten przejmuje logowanie na zawsze. Sama otwarta sesja to za
// mało — przejęte, odblokowane urządzenie ma otwartą sesję. Dlatego `start`
// żąda świeżego dowodu tożsamości: **passkeya albo aktualnego kodu ze starego
// authenticatora**. Jedno z dwóch, nigdy nic.
//
// # Dlaczego dwa etapy (start → confirm)
//
// Jak przy rejestracji: `start` wydaje nowy sekret jako OCZEKUJĄCY
// (`totp_secret_pending_enc`), użytkownik skanuje QR w nowej aplikacji, a
// dopiero `confirm` — pierwszym kodem z NOWEJ aplikacji — przełącza konto.
// Gdyby `start` od razu nadpisywał aktywny sekret, użytkownik, który zeskanuje
// QR z błędem albo zamknie kartę, zostałby zablokowany: stary authenticator
// już nie działa, nowego jeszcze nie potwierdził.

/** Wyzwanie webauthn żyje krótko — ma starczyć na dotknięcie klucza, nie na atak. */
const REAUTH_CHALLENGE_TTL_MS = 3 * 60 * 1000;

/**
 * Passkeyowa droga re-auth: wydaje wyzwanie assertion związane z ZALOGOWANYM
 * użytkownikiem. Typ 'reauth-totp', żeby nie dało się podstawić wyzwania
 * logowania (tamto ma `user_id NULL`).
 */
auth.post("/totp/change/options", requireAuth, async (c) => {
  const userId = c.get("userId");

  const options = await generateAuthenticationOptions({
    rpID: c.env.WEBAUTHN_RP_ID,
    userVerification: "required",
  });

  await c.env.DB.prepare(
    `INSERT INTO webauthn_challenges (id, user_id, challenge, typ, expires_at)
     VALUES (?, ?, ?, 'reauth-totp', ?)`,
  )
    .bind(crypto.randomUUID(), userId, options.challenge, Date.now() + REAUTH_CHALLENGE_TTL_MS)
    .run();

  return c.json(options);
});

/**
 * Po ponownym uwierzytelnieniu wydaje NOWY sekret jako oczekujący. Re-auth
 * przechodzi jedną z dwóch dróg — nigdy obiema, nigdy żadną.
 */
auth.post("/totp/change/start", requireAuth, async (c) => {
  const userId = c.get("userId");
  const body = await c.req.json<{ oldCode?: string; response?: AuthenticationResponseJSON }>();

  const user = await c.env.DB.prepare(
    "SELECT username, totp_secret_enc, totp_last_counter FROM users WHERE id = ? AND status = 'active'",
  )
    .bind(userId)
    .first<{ username: string; totp_secret_enc: string; totp_last_counter: number | null }>();

  if (user === null) {
    return c.json({ error: "konto nie istnieje" }, 404);
  }

  // Droga 1: aktualny kod ze starego authenticatora (z ochroną przed powtórką).
  if (body.oldCode) {
    const secret = await decryptSecret(c.env.TOTP_ENCRYPTION_KEY, user.totp_secret_enc);
    const wynik = verifyCode(secret, body.oldCode);
    if (!wynik.valid || wynik.counter === null || isReplay(wynik.counter, user.totp_last_counter)) {
      return c.json({ error: "nieprawidłowy kod" }, 401);
    }
    await c.env.DB.prepare("UPDATE users SET totp_last_counter = ? WHERE id = ?")
      .bind(wynik.counter, userId)
      .run();
  } else if (body.response) {
    // Droga 2: passkey. Wyzwanie konsumujemy niepodzielnie i TYLKO to wydane
    // temu użytkownikowi (typ 'reauth-totp', user_id = ten zalogowany).
    let challengeValue: string;
    try {
      challengeValue = decodeClientDataChallenge(body.response.response.clientDataJSON);
    } catch {
      return c.json({ error: "nieprawidłowa odpowiedź" }, 400);
    }

    const challenge = await c.env.DB.prepare(
      `DELETE FROM webauthn_challenges
        WHERE challenge = ? AND typ = 'reauth-totp' AND user_id = ? AND expires_at > ?
        RETURNING id`,
    )
      .bind(challengeValue, userId, Date.now())
      .first<{ id: string }>();

    if (challenge === null) {
      return c.json({ error: "sesja potwierdzenia jest nieważna" }, 401);
    }

    // Credential MUSI należeć do zalogowanego użytkownika — inaczej cudzy
    // passkey autoryzowałby zmianę na tym koncie.
    const credential = await c.env.DB.prepare(
      `SELECT public_key AS publicKey, sign_count AS signCount
         FROM webauthn_credentials WHERE id = ? AND user_id = ?`,
    )
      .bind(body.response.id, userId)
      .first<{ publicKey: ArrayBuffer; signCount: number }>();

    if (credential === null) {
      return c.json({ error: "nieznany passkey" }, 401);
    }

    let weryfikacja;
    try {
      weryfikacja = await verifyAuthenticationResponse({
        response: body.response,
        expectedChallenge: challengeValue,
        expectedOrigin: allowedOrigins(c.env),
        expectedRPID: c.env.WEBAUTHN_RP_ID,
        credential: {
          id: body.response.id,
          publicKey: new Uint8Array(credential.publicKey),
          counter: credential.signCount,
        },
        requireUserVerification: true,
      });
    } catch {
      return c.json({ error: "weryfikacja nie powiodła się" }, 401);
    }

    if (!weryfikacja.verified) {
      return c.json({ error: "weryfikacja nie powiodła się" }, 401);
    }

    await c.env.DB.prepare(
      "UPDATE webauthn_credentials SET sign_count = ?, last_used_at = ? WHERE id = ?",
    )
      .bind(weryfikacja.authenticationInfo.newCounter, Date.now(), body.response.id)
      .run();
  } else {
    return c.json({ error: "wymagany passkey albo aktualny kod" }, 400);
  }

  // Re-auth przeszedł — wydajemy nowy sekret jako oczekujący. Aktywnego NIE
  // ruszamy, dopóki nowy nie zostanie potwierdzony.
  const nowySekret = generateSecret();
  await c.env.DB.prepare("UPDATE users SET totp_secret_pending_enc = ? WHERE id = ?")
    .bind(await encryptSecret(c.env.TOTP_ENCRYPTION_KEY, nowySekret), userId)
    .run();

  return c.json({
    totpSecret: nowySekret,
    otpauthUri: provisioningUri(nowySekret, user.username),
  });
});

/**
 * Przełącza konto na nowy authenticator pierwszym kodem z NOWEJ aplikacji.
 * Weryfikuje przeciw sekretowi oczekującemu; dopiero to nadpisuje aktywny.
 */
auth.post("/totp/change/confirm", requireAuth, async (c) => {
  const userId = c.get("userId");
  const body = await c.req.json<{ code: string }>();

  const user = await c.env.DB.prepare(
    "SELECT totp_secret_pending_enc FROM users WHERE id = ?",
  )
    .bind(userId)
    .first<{ totp_secret_pending_enc: string | null }>();

  if (user === null || user.totp_secret_pending_enc === null) {
    return c.json({ error: "nie ma czego potwierdzać" }, 400);
  }

  const nowySekret = await decryptSecret(c.env.TOTP_ENCRYPTION_KEY, user.totp_secret_pending_enc);
  const wynik = verifyCode(nowySekret, body.code);

  if (!wynik.valid || wynik.counter === null) {
    return c.json({ error: "nieprawidłowy kod" }, 401);
  }

  // Nowy sekret staje się aktywny; licznik startuje od okna, którym go
  // potwierdzono, żeby ten sam kod nie przeszedł drugi raz przy logowaniu.
  await c.env.DB.prepare(
    "UPDATE users SET totp_secret_enc = ?, totp_secret_pending_enc = NULL, totp_last_counter = ? WHERE id = ?",
  )
    .bind(user.totp_secret_pending_enc, wynik.counter, userId)
    .run();

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
