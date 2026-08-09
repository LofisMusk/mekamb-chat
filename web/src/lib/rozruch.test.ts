import { describe, expect, it } from "vitest";

import { type Rozruch, ustalRozruch } from "./rozruch";
import type { Account } from "./vault";

const KONTO: Account = { userId: "ala", username: "ala", deviceId: "urzadzenie-1" };

function zrodla(nadpisania: Partial<Parameters<typeof ustalRozruch>[0]> = {}) {
  return {
    wczytajKonto: async () => KONTO,
    odswiezSesje: async () => ({ token: "token-abc" }),
    ...nadpisania,
  };
}

describe("rozruch aplikacji", () => {
  it("bez konta prowadzi do powitania", async () => {
    const start = await ustalRozruch(zrodla({ wczytajKonto: async () => null }));

    expect(start).toEqual<Rozruch>({ nazwa: "powitanie" });
  });

  it("odświeżona sesja niesie konto i token dalej", async () => {
    const start = await ustalRozruch(zrodla());

    expect(start).toEqual<Rozruch>({ nazwa: "sesja", konto: KONTO, token: "token-abc" });
  });

  /// Wygasła sesja jest normalnym stanem, nie awarią — komunikat o błędzie
  /// przy każdym dłuższym powrocie nauczyłby użytkownika go ignorować.
  it("wygasła sesja prowadzi do logowania bez komunikatu o błędzie", async () => {
    const start = await ustalRozruch(zrodla({ odswiezSesje: async () => null }));

    expect(start).toEqual<Rozruch>({ nazwa: "logowanie" });
  });

  /// Sedno: to jest ta awaria. `fetch` rzuca `TypeError` przy zerwanej sieci
  /// i przy braku nagłówków CORS, a nieobsłużony wyjątek zostawiał aplikację
  /// na ekranie „Wczytywanie…" na zawsze — bez śladu przyczyny.
  it("niedostępny serwer prowadzi do logowania z podaną przyczyną", async () => {
    const start = await ustalRozruch(
      zrodla({
        odswiezSesje: () => Promise.reject(new TypeError("Failed to fetch")),
      }),
    );

    expect(start.nazwa).toBe("logowanie");
    expect(start).toHaveProperty("blad", expect.stringContaining("Failed to fetch"));
  });

  /// Sedno: powitanie oferuje „Załóż konto", więc po nieudanym odczycie
  /// skarbca prowadziłoby do drugiego konta obok istniejącego, którego dane
  /// wciąż leżą na urządzeniu.
  it("nieczytelny skarbiec prowadzi do logowania, nie do zakładania konta", async () => {
    const start = await ustalRozruch(
      zrodla({
        wczytajKonto: () => Promise.reject(new Error("IndexedDB niedostępne")),
      }),
    );

    expect(start.nazwa).toBe("logowanie");
    expect(start).toHaveProperty("blad", expect.stringContaining("IndexedDB niedostępne"));
  });

  it("żadna awaria nie zostawia rozruchu bez ekranu", async () => {
    const awarie = [
      zrodla({ wczytajKonto: () => Promise.reject(new Error("skarbiec")) }),
      zrodla({ odswiezSesje: () => Promise.reject(new Error("sieć")) }),
      zrodla({ odswiezSesje: () => Promise.reject("nie-błąd") }),
    ];

    for (const z of awarie) {
      expect(["powitanie", "logowanie", "sesja"]).toContain((await ustalRozruch(z)).nazwa);
    }
  });
});
