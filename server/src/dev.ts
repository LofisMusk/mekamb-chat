import { Hono } from "hono";

import { base64ToBytes, bytesToBase64, encryptSecret } from "./crypto";
import type { Env } from "./env";
import * as opaque from "./opaque-wasm/index.js";
import { generateSecret } from "./totp";

/**
 * Rozluźnienia dla środowiska testowego — WSZYSTKIE za jedną flagą.
 *
 * # Dlaczego flaga, a nie po prostu gałąź „bez zabezpieczeń"
 *
 * Gałąź z wyłączonym 2FA da się przypadkiem zmergować do produkcji, a na review
 * nic nie krzyczy — to kod, który wygląda normalnie. Flaga włączana wyłącznie
 * w środowisku `dev` wrangler (osobny Worker, osobna baza D1) jest w produkcji
 * martwa NAWET wtedy, gdy ten plik tam trafi: `TRYB_DEWELOPERSKI` nie jest
 * ustawione, więc każda z tych furtek pozostaje zamknięta. Bezpieczeństwo
 * zależy od konfiguracji wdrożenia, nie od tego, co komu wpadnie do merge'a.
 *
 * # Co to rozluźnia, a czego świadomie NIE
 *
 * Rozluźnia dostęp do **infrastruktury**: pomija 2FA, wyłącza limity prób,
 * aktywuje konta od razu i sieje konta testowe. **Nie dotyka szyfrowania
 * wiadomości** — klucze i tak nigdy nie przechodzą przez serwer (patrz
 * docs/THREAT_MODEL.md), więc tego nie da się tu osłabić nawet celowo.
 */

/** Czy działamy w trybie deweloperskim. Domyślnie NIE — produkcja go nie ustawia. */
export function trybDeweloperski(env: Env): boolean {
  return env.TRYB_DEWELOPERSKI === "true";
}

/**
 * Konta zakładane na żądanie w trybie dev.
 *
 * Hasła są jawne CELOWO: to konta wyłącznie do testów, na osobnej bazie, do
 * której nie trafiają żadne prawdziwe dane. Wszystkie mają ten sam sekret TOTP
 * nieważny — w trybie dev logowanie i tak przyjmuje dowolny kod.
 */
export const KONTA_TESTOWE: ReadonlyArray<{ username: string; haslo: string }> = [
  { username: "test1", haslo: "test1234" },
  { username: "test2", haslo: "test1234" },
];

/**
 * Zakłada jedno konto pełną rundą OPAQUE — tym samym kodem, którym robi to klient.
 *
 * Nie da się „wstawić rekordu OPAQUE ręcznie": rekord wylicza się z odpowiedzi
 * serwera na oślepiony input klienta, więc bez znajomości hasła nikt (łącznie
 * z serwerem) nie zmajstruje go w bazie. Dlatego przechodzimy całą ceremonię
 * w procesie, używając klienckich funkcji bindingu (eksportowanych do testów).
 * Efekt: konto testowe loguje się prawdziwym OPAQUE, nie obejściem.
 */
async function zalozKontoTestowe(env: Env, username: string, haslo: string): Promise<void> {
  const serverKey = base64ToBytes(env.OPAQUE_SERVER_KEY);

  const start = opaque.clientRegisterStart(haslo);
  const response = opaque.registrationStart(serverKey, username, start.request);
  const upload = opaque.clientRegisterFinish(start.state, haslo, username, response);
  const record = opaque.registrationFinish(upload);

  const totpSecret = generateSecret();

  // INSERT OR IGNORE po więzie UNIQUE(username): powtórny seed nie wywraca się
  // i nie duplikuje konta — po prostu zostawia istniejące w spokoju.
  await env.DB.prepare(
    `INSERT OR IGNORE INTO users (id, username, opaque_record, totp_secret_enc, created_at, status)
     VALUES (?, ?, ?, ?, ?, 'active')`,
  )
    .bind(
      crypto.randomUUID(),
      username,
      bytesToBase64(record),
      await encryptSecret(env.TOTP_ENCRYPTION_KEY, totpSecret),
      Date.now(),
    )
    .run();
}

/** Sieje wszystkie konta testowe. Idempotentne, więc można wołać wielokrotnie. */
export async function zasiejKontaTestowe(env: Env): Promise<string[]> {
  const zalozone: string[] = [];
  for (const konto of KONTA_TESTOWE) {
    await zalozKontoTestowe(env, konto.username, konto.haslo);
    zalozone.push(konto.username);
  }
  return zalozone;
}

const dev = new Hono<{ Bindings: Env }>();

// Każdy endpoint dev jest martwy poza trybem deweloperskim — odpowiada 404,
// jakby go w ogóle nie było. Zabezpieczenie siedzi TU, w kodzie, a nie tylko
// w tym, że produkcja przypadkiem nie mapuje tej trasy.
dev.use("*", async (c, next) => {
  if (!trybDeweloperski(c.env)) {
    return c.json({ error: "nie znaleziono" }, 404);
  }
  await next();
});

/** Zakłada konta testowe. Zwraca ich nazwy i wspólne hasło do wygody testów. */
dev.post("/seed", async (c) => {
  const konta = await zasiejKontaTestowe(c.env);
  return c.json({ konta, haslo: KONTA_TESTOWE[0]?.haslo ?? null });
});

/** Sanity-check wdrożenia: czy to naprawdę środowisko dev. */
dev.get("/status", (c) => {
  return c.json({ tryb: "deweloperski", konta: KONTA_TESTOWE.map((k) => k.username) });
});

export default dev;
