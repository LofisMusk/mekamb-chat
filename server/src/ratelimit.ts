import { DurableObject } from "cloudflare:workers";

import type { Env } from "./env";

/**
 * Limiter zapytań oparty na kubełku tokenów.
 *
 * # Dlaczego Durable Object, a nie KV
 *
 * KV jest ostatecznie spójne, więc licznik w nim trzymany daje się obejść:
 * wystarczy wysłać wiele żądań równolegle, zanim zapis się rozpropaguje.
 * Przy limitowaniu prób logowania to nie jest teoretyczny problem — to główny
 * sposób atakowania hasła i kodu TOTP.
 *
 * Durable Object obsługuje żądania po kolei, więc odczyt i zapis licznika są
 * niepodzielne z definicji.
 *
 * # Kubełek tokenów, nie okno stałe
 *
 * Okno stałe pozwala wystrzelić podwójny limit na styku dwóch okien. Kubełek
 * uzupełniany w sposób ciągły nie ma takiej krawędzi.
 */
export class RateLimiter extends DurableObject<Env> {
  constructor(ctx: DurableObjectState, env: Env) {
    super(ctx, env);

    ctx.blockConcurrencyWhile(async () => {
      this.ctx.storage.sql.exec(`
        CREATE TABLE IF NOT EXISTS bucket (
          key        TEXT PRIMARY KEY,
          tokens     REAL NOT NULL,
          updated_at INTEGER NOT NULL
        );
      `);
    });
  }

  /**
   * Pobiera jeden token.
   *
   * @param capacity  Maksymalna liczba żądań w serii.
   * @param refillPerSecond  Tempo uzupełniania.
   * @returns `allowed: false` wraz z czasem oczekiwania, gdy limit wyczerpany.
   */
  async consume(
    key: string,
    capacity: number,
    refillPerSecond: number,
  ): Promise<{ allowed: boolean; retryAfterMs: number }> {
    const now = Date.now();

    const row = this.ctx.storage.sql
      .exec<{ tokens: number; updated_at: number }>(
        "SELECT tokens, updated_at FROM bucket WHERE key = ?",
        key,
      )
      .toArray()[0];

    const previous = row ?? { tokens: capacity, updated_at: now };

    const elapsedSeconds = Math.max(0, now - previous.updated_at) / 1000;
    const tokens = Math.min(capacity, previous.tokens + elapsedSeconds * refillPerSecond);

    if (tokens < 1) {
      // Nie zapisujemy nic przy odrzuceniu: aktualizacja `updated_at`
      // przesuwałaby moment naliczania i zapętlała blokadę przy zalewie żądań.
      const retryAfterMs = Math.ceil(((1 - tokens) / refillPerSecond) * 1000);
      return { allowed: false, retryAfterMs };
    }

    this.ctx.storage.sql.exec(
      "INSERT INTO bucket (key, tokens, updated_at) VALUES (?, ?, ?) " +
        "ON CONFLICT(key) DO UPDATE SET tokens = ?, updated_at = ?",
      key,
      tokens - 1,
      now,
      tokens - 1,
      now,
    );

    return { allowed: true, retryAfterMs: 0 };
  }

  /** Kasuje limit dla klucza — po udanym logowaniu. */
  async reset(key: string): Promise<void> {
    this.ctx.storage.sql.exec("DELETE FROM bucket WHERE key = ?", key);
  }
}
