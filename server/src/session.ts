/**
 * Trwała sesja: token odświeżający w httpOnly cookie — i w treści odpowiedzi
 * dla klientów, którym cookie nie przysługuje.
 *
 * Wydzielone z `auth.ts`, żeby zarówno logowanie hasłem+TOTP, jak i logowanie
 * passkeyem (`webauthn.ts`) mogły z tego korzystać bez cyklicznego importu
 * między tymi dwoma plikami.
 *
 * # Dlaczego samo cookie nie wystarcza
 *
 * Strona stoi na `lofismusk.github.io`, a API na `…workers.dev` — z punktu
 * widzenia przeglądarki to **cookie trzeciej strony**. Safari (a na iOS każda
 * przeglądarka, bo wszystkie są WebKitem) blokuje takie cookie domyślnie, więc
 * `Set-Cookie` po prostu znika. Efekt: iPhone wylogowywał się przy każdym
 * zamknięciu aplikacji, a na desktopie ta sama ścieżka działała bez zarzutu —
 * najgorszy rodzaj usterki, bo niewidoczny dla tego, kto ją napisał.
 *
 * Dlatego klient może poprosić o token **w treści odpowiedzi** (`sesjaWTresci`)
 * i odesłać go w treści żądania. Cookie zostaje dla tych, którzy je przyjmują.
 *
 * # Co to kosztuje
 *
 * Token w treści przestaje być `httpOnly`, więc skrypt wstrzyknięty na stronę
 * może go odczytać i mieć trwały dostęp, a nie tylko bieżącą sesję. Płacimy to
 * świadomie: klient webowy trzyma w tym samym magazynie stan MLS i ziarno
 * urządzenia, więc XSS na tej stronie i tak oznacza pełną kompromitację (patrz
 * docs/THREAT_MODEL.md) — a bez tego iPhone nie ma trwałej sesji w ogóle.
 * Prosi o to wyłącznie klient, który sam o to poprosi; Android i każdy inny
 * klient z działającym cookie dostają jak dotąd samo cookie.
 */

import type { Context } from "hono";
import { deleteCookie, setCookie } from "hono/cookie";

import { bytesToBase64, hashRefreshToken } from "./crypto";
import type { Env } from "./env";

/**
 * Czas życia tokenu odświeżającego — na tyle długi, żeby użytkownik nie
 * logował się od nowa przy każdym powrocie do aplikacji, ale wciąż
 * ograniczony w czasie.
 */
export const REFRESH_TOKEN_TTL_MS = 30 * 24 * 60 * 60 * 1000;

/** Nazwa i ścieżka cookie tokenu odświeżającego. */
export const REFRESH_COOKIE_NAME = "refresh";
export const REFRESH_COOKIE_PATH = "/auth/refresh";

/**
 * Wystawia token odświeżający: zapisuje jego hash w bazie (nadpisując
 * poprzedni dla tego urządzenia — rotacja) i ustawia httpOnly cookie.
 *
 * Zwraca token w postaci jawnej, żeby wywołujący mógł go dołączyć do treści
 * odpowiedzi, gdy klient o to poprosił. Nie robi tego sam — decyzja należy do
 * trasy, która zna żądanie.
 *
 * `device_id` NIE ma więzu REFERENCES do `devices` — patrz komentarz
 * w migracji `0005_refresh_tokens.sql`: token powstaje zanim klient zdąży
 * zarejestrować urządzenie.
 */
export async function issueRefreshToken<E extends { Bindings: Env }>(
  c: Context<E>,
  userId: string,
  deviceId: string,
): Promise<string> {
  const raw = bytesToBase64(crypto.getRandomValues(new Uint8Array(32)));
  const hash = await hashRefreshToken(raw);
  const now = Date.now();

  await c.env.DB.prepare(
    `INSERT INTO refresh_tokens (id, user_id, device_id, token_hash, created_at, expires_at)
     VALUES (?, ?, ?, ?, ?, ?)
     ON CONFLICT(device_id) DO UPDATE SET
       id = excluded.id, user_id = excluded.user_id, token_hash = excluded.token_hash,
       created_at = excluded.created_at, expires_at = excluded.expires_at`,
  )
    .bind(crypto.randomUUID(), userId, deviceId, hash, now, now + REFRESH_TOKEN_TTL_MS)
    .run();

  setCookie(c, REFRESH_COOKIE_NAME, raw, {
    httpOnly: true,
    secure: true,
    sameSite: "None",
    path: REFRESH_COOKIE_PATH,
    maxAge: Math.floor(REFRESH_TOKEN_TTL_MS / 1000),
  });

  return raw;
}

/** Kasuje cookie tokenu odświeżającego (ta sama ścieżka, z którą je ustawiono). */
export function clearRefreshCookie(c: Context<{ Bindings: Env }>): void {
  deleteCookie(c, REFRESH_COOKIE_NAME, { path: REFRESH_COOKIE_PATH });
}
