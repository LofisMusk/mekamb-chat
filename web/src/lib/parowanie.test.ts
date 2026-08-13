import { describe, expect, it, vi } from "vitest";

// Moduł WASM wymaga `init()` i nie ładuje się w teście jednostkowym.
// Sprawdzamy warstwę nad nim: kod QR i kolejność wprowadzania do rozmów.
vi.mock("../wasm/mekamb_wasm", () => ({ PairingKeys: class {} }));

import type { Messenger } from "./messenger";
import { odczytajZaproszenie, wprowadzDoRozmow, zbudujZaproszenie } from "./parowanie";

const KLUCZ = Uint8Array.from({ length: 32 }, (_, i) => i * 7);

describe("kod parowania", () => {
  it("obieg tam i z powrotem odtwarza oba pola", () => {
    const odczytane = odczytajZaproszenie(zbudujZaproszenie("web-1a2b3c4d", KLUCZ));

    expect(odczytane?.deviceId).toBe("web-1a2b3c4d");
    expect(odczytane?.kluczPubliczny).toEqual(KLUCZ);
  });

  /**
   * Nazwa użytkownika w kodzie byłaby wywieszona na ekranie dla każdego, kto
   * stoi obok — a stare urządzenie zna ją i tak, bo paruje z własnym kontem.
   */
  it("nie niesie nazwy użytkownika", () => {
    expect(zbudujZaproszenie("web-1a2b3c4d", KLUCZ)).not.toMatch(/ala|user|nazwa/i);
  });

  it("kod przeniesienia konta nie jest kodem parowania", () => {
    // Dwa różne kody z tym samym schematem `mekamb://` — pomylenie ich
    // znaczyłoby skasowanie konta zamiast dodania urządzenia.
    expect(odczytajZaproszenie("mekamb://transfer?i=abc&k=def")).toBeNull();
  });

  it("obce napisy są odrzucane", () => {
    for (const smiec of ["", "https://example.com", "mekamb://parowanie", "zupełnie co innego"]) {
      expect(odczytajZaproszenie(smiec)).toBeNull();
    }
  });

  it("brakujący parametr daje null", () => {
    expect(odczytajZaproszenie("mekamb://parowanie?d=web-1")).toBeNull();
    expect(odczytajZaproszenie(`mekamb://parowanie?k=${"A".repeat(43)}`)).toBeNull();
  });

  /** Klucz złej długości to uszkodzony kod, a nie „nie ten kod". */
  it("klucz o złej długości jest odrzucany", () => {
    expect(odczytajZaproszenie("mekamb://parowanie?d=web-1&k=QUJD")).toBeNull();
  });

  it("znosi spacje wokół wklejonego kodu", () => {
    const kod = zbudujZaproszenie("web-1a2b3c4d", KLUCZ);

    expect(odczytajZaproszenie(`  ${kod}\n`)?.deviceId).toBe("web-1a2b3c4d");
  });
});

describe("wprowadzanie do rozmów", () => {
  function messengerZ(zachowanie: (groupId: Uint8Array) => void): Messenger {
    return {
      dodajWlasneUrzadzenie: async (groupId: Uint8Array) => zachowanie(groupId),
    } as unknown as Messenger;
  }

  const ROZMOWY = [new Uint8Array([1]), new Uint8Array([2]), new Uint8Array([3])];

  it("dodaje do każdej rozmowy", async () => {
    const dotkniete: number[] = [];
    const wynik = await wprowadzDoRozmow(
      messengerZ((g) => void dotkniete.push(g[0] ?? 0)),
      "web-nowe",
      ROZMOWY,
    );

    expect(dotkniete).toEqual([1, 2, 3]);
    expect(wynik).toEqual({ zrobione: 3, wszystkich: 3, pominiete: [] });
  });

  /**
   * Sedno: przerwanie zostawia konto sparowane w połowie — część rozmów
   * widoczna na nowym urządzeniu, część nie — i nic tego nie naprawia poza
   * powtórzeniem całości.
   */
  it("nieudana rozmowa nie przerywa pozostałych", async () => {
    const wynik = await wprowadzDoRozmow(
      messengerZ((g) => {
        if (g[0] === 2) throw new Error("brak key packages");
      }),
      "web-nowe",
      ROZMOWY,
    );

    expect(wynik.zrobione).toBe(2);
    expect(wynik.pominiete).toHaveLength(1);
    expect(wynik.pominiete[0]?.powod).toBe("brak key packages");
  });

  it("melduje postęp po każdej rozmowie", async () => {
    const kroki: number[] = [];
    await wprowadzDoRozmow(
      messengerZ(() => {}),
      "web-nowe",
      ROZMOWY,
      (p) => kroki.push(p.zrobione),
    );

    expect(kroki).toEqual([1, 2, 3]);
  });

  /**
   * Każda rozmowa to osobne zajęcie epoki w `GroupRelay`. Równoległe wysyłanie
   * ścigałoby się o epoki samo ze sobą i część commitów wracałaby z 409 bez
   * powodu poza naszym własnym pośpiechem.
   */
  it("idzie po kolei, nie równolegle", async () => {
    let rownoczesnie = 0;
    let najwiecej = 0;

    const messenger = {
      dodajWlasneUrzadzenie: async () => {
        rownoczesnie += 1;
        najwiecej = Math.max(najwiecej, rownoczesnie);
        await new Promise((r) => setTimeout(r, 1));
        rownoczesnie -= 1;
      },
    } as unknown as Messenger;

    await wprowadzDoRozmow(messenger, "web-nowe", ROZMOWY);

    expect(najwiecej).toBe(1);
  });

  it("brak rozmów to poprawny wynik, nie błąd", async () => {
    await expect(wprowadzDoRozmow(messengerZ(() => {}), "web-nowe", [])).resolves.toEqual({
      zrobione: 0,
      wszystkich: 0,
      pominiete: [],
    });
  });
});
