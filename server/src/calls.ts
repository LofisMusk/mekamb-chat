import { Hono } from "hono";

import type { Env } from "./env";
import { requireAuth } from "./middleware";

/**
 * Poświadczenia STUN/TURN dla rozmów.
 *
 * # Czego serwer tu NIE robi
 *
 * Nie pośredniczy w mediach ani w sygnalizacji. Sygnalizacja idzie kanałem MLS
 * razem z wiadomościami; media idą bezpośrednio przez WebRTC. Ten endpoint
 * wydaje wyłącznie adresy serwerów pomocniczych.
 *
 * # Dlaczego poświadczenia są krótkożyjące
 *
 * TURN przekazuje ruch, więc jego użycie kosztuje transfer z naszego darmowego
 * limitu. Trwały sekret w kliencie pozwalałby dowolnej osobie zużyć go w całości.
 * Poświadczenia liczone są z sekretu serwera i wygasają po godzinie.
 */

/** Jak długo ważne są poświadczenia TURN. */
const TURN_TTL_SECONDS = 60 * 60;

const calls = new Hono<{
  Bindings: Env;
  Variables: { userId: string; deviceId: string | null };
}>();

calls.get("/ice-servers", requireAuth, async (c) => {
  const iceServers: unknown[] = [
    // STUN wystarcza do wykrycia własnego adresu publicznego i jest darmowy
    // bez ograniczeń. Większość połączeń nie potrzebuje niczego więcej.
    { urls: "stun:stun.cloudflare.com:3478" },
  ];

  const secret = c.env.TURN_SHARED_SECRET;
  const turnUrl = c.env.TURN_URL;

  if (secret && turnUrl) {
    // Schemat poświadczeń z RFC 8489: nazwa to znacznik wygaśnięcia, a hasło
    // to HMAC z niej, liczony sekretem znanym tylko serwerowi TURN i nam.
    const wygasa = Math.floor(Date.now() / 1000) + TURN_TTL_SECONDS;
    const username = `${wygasa}:${c.get("userId")}`;

    iceServers.push({
      urls: turnUrl,
      username,
      credential: await hmacBase64(secret, username),
    });
  }

  return c.json({ iceServers });
});

async function hmacBase64(secret: string, message: string): Promise<string> {
  const key = await crypto.subtle.importKey(
    "raw",
    new TextEncoder().encode(secret),
    { name: "HMAC", hash: "SHA-1" },
    false,
    ["sign"],
  );

  const signature = await crypto.subtle.sign("HMAC", key, new TextEncoder().encode(message));

  let binary = "";
  for (const byte of new Uint8Array(signature)) {
    binary += String.fromCharCode(byte);
  }
  return btoa(binary);
}

export default calls;
