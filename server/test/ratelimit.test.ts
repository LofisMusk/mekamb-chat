import { env } from "cloudflare:test";
import { describe, expect, it } from "vitest";

/** Limiter chroni hasło i kod TOTP przed zgadywaniem. */

function limiter(key: string) {
  return env.RATE_LIMITER.get(env.RATE_LIMITER.idFromName(key));
}

const POJEMNOSC = 5;
const UZUPELNIANIE = 1 / 30;

describe("RateLimiter", () => {
  it("przepuszcza serię do wyczerpania pojemności", async () => {
    const l = limiter("seria");

    for (let i = 0; i < POJEMNOSC; i += 1) {
      const wynik = await l.consume("seria", POJEMNOSC, UZUPELNIANIE);
      expect(wynik.allowed).toBe(true);
    }
  });

  it("blokuje po wyczerpaniu i podaje czas oczekiwania", async () => {
    const l = limiter("blokada");
    for (let i = 0; i < POJEMNOSC; i += 1) {
      await l.consume("blokada", POJEMNOSC, UZUPELNIANIE);
    }

    const wynik = await l.consume("blokada", POJEMNOSC, UZUPELNIANIE);

    expect(wynik.allowed).toBe(false);
    expect(wynik.retryAfterMs).toBeGreaterThan(0);
  });

  /**
   * Bez tej gwarancji limit dałoby się obejść zalewem równoległych żądań —
   * czyli dokładnie tak, jak wygląda atak na hasło.
   */
  it("równoległe próby nie przekraczają pojemności", async () => {
    const l = limiter("rownolegle");

    const wyniki = await Promise.all(
      Array.from({ length: 50 }, () => l.consume("rownolegle", POJEMNOSC, UZUPELNIANIE)),
    );

    expect(wyniki.filter((w) => w.allowed)).toHaveLength(POJEMNOSC);
  });

  it("odrzucona próba nie przedłuża blokady", async () => {
    const l = limiter("bez-kary");
    for (let i = 0; i < POJEMNOSC; i += 1) {
      await l.consume("bez-kary", POJEMNOSC, UZUPELNIANIE);
    }

    const pierwsza = await l.consume("bez-kary", POJEMNOSC, UZUPELNIANIE);
    const druga = await l.consume("bez-kary", POJEMNOSC, UZUPELNIANIE);

    // Gdyby odrzucenie aktualizowało znacznik czasu, druga próba czekałaby
    // dłużej niż pierwsza i blokada zapętlałaby się przy zalewie żądań.
    expect(druga.retryAfterMs).toBeLessThanOrEqual(pierwsza.retryAfterMs);
  });

  it("różne klucze mają rozdzielne limity", async () => {
    const l = limiter("wspolny-obiekt");
    for (let i = 0; i < POJEMNOSC; i += 1) {
      await l.consume("klucz-a", POJEMNOSC, UZUPELNIANIE);
    }

    expect((await l.consume("klucz-a", POJEMNOSC, UZUPELNIANIE)).allowed).toBe(false);
    expect((await l.consume("klucz-b", POJEMNOSC, UZUPELNIANIE)).allowed).toBe(true);
  });

  it("reset po udanym logowaniu zwalnia limit", async () => {
    const l = limiter("reset");
    for (let i = 0; i < POJEMNOSC; i += 1) {
      await l.consume("reset", POJEMNOSC, UZUPELNIANIE);
    }
    expect((await l.consume("reset", POJEMNOSC, UZUPELNIANIE)).allowed).toBe(false);

    await l.reset("reset");

    expect((await l.consume("reset", POJEMNOSC, UZUPELNIANIE)).allowed).toBe(true);
  });
});
