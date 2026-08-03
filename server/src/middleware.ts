import { createMiddleware } from "hono/factory";

import { verifyToken } from "./crypto";
import type { Env } from "./env";

/**
 * Wymaga ważnego tokenu dostępowego.
 *
 * Token dowodzi, że ktoś przeszedł pełną ścieżkę: hasło (OPAQUE) **i** kod
 * z authenticatora. Nie daje dostępu do treści — tej serwer i tak nie ma.
 */
export const requireAuth = createMiddleware<{
  Bindings: Env;
  Variables: { userId: string; deviceId: string | null };
}>(async (c, next) => {
  const header = c.req.header("Authorization");
  const token = header?.startsWith("Bearer ") ? header.slice(7) : null;

  if (!token) {
    return c.json({ error: "brak tokenu dostępowego" }, 401);
  }

  const payload = await verifyToken(c.env.TOKEN_SIGNING_KEY, token);
  if (!payload) {
    // Ten sam komunikat dla podrobionego podpisu i wygasłego tokenu —
    // rozróżnienie nie pomaga użytkownikowi, a pomaga atakującemu.
    return c.json({ error: "token jest nieważny" }, 401);
  }

  c.set("userId", payload.userId);
  c.set("deviceId", payload.deviceId);
  await next();
});
