/**
 * Trwała sesja: token odświeżający w httpOnly cookie.
 *
 * Wydzielone z `auth.ts`, żeby zarówno logowanie hasłem+TOTP, jak i logowanie
 * passkeyem (`webauthn.ts`) mogły z tego korzystać bez cyklicznego importu
 * między tymi dwoma plikami.
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
 * `device_id` NIE ma więzu REFERENCES do `devices` — patrz komentarz
 * w migracji `0005_refresh_tokens.sql`: token powstaje zanim klient zdąży
 * zarejestrować urządzenie.
 */
export async function issueRefreshToken<E extends { Bindings: Env }>(
  c: Context<E>,
  userId: string,
  deviceId: string,
): Promise<void> {
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
}

/** Kasuje cookie tokenu odświeżającego (ta sama ścieżka, z którą je ustawiono). */
export function clearRefreshCookie(c: Context<{ Bindings: Env }>): void {
  deleteCookie(c, REFRESH_COOKIE_NAME, { path: REFRESH_COOKIE_PATH });
}
