import { readFileSync } from "node:fs";

import { describe, expect, it } from "vitest";

// Źródło ikon i generator są zwykłymi modułami ESM, żeby dało się je uruchomić
// samym `node`. Typy leżą obok, w plikach `.d.mts`.
import { IKONY } from "../../../design/ikony.mjs";
import { SCIEZKA_ANDROID, SCIEZKA_WEB, zrodloAndroid, zrodloWeb } from "../../../design/generuj.mjs";

import { SCIEZKI, type NazwaIkony } from "../Ikony";

const ikony = IKONY;

/*
 * Sedno: ikona ma jedną definicję, a nie jedną na platformę.
 *
 * Zestaw był wcześniej wpisany wprost w `Ikony.kt`, a web nie miał go wcale.
 * Dorysowanie drugiego zestawu ręcznie znaczyłoby, że pierwsza poprawka
 * kształtu rozjedzie platformy — i że nikt tego nie zauważy, bo różnicy dwóch
 * stopni w łuku nie widać z pamięci.
 *
 * Te testy porównują wygenerowane pliki ze źródłem. Zmiana w `Ikony.tsx` albo
 * `Ikony.kt` bez przepuszczenia jej przez `node design/generuj.mjs` wywala CI.
 */
describe("wygenerowany zestaw ikon", () => {
  it("web zgadza się ze źródłem", () => {
    expect(readFileSync(SCIEZKA_WEB, "utf8")).toBe(zrodloWeb());
  });

  it("Android zgadza się ze źródłem", () => {
    expect(readFileSync(SCIEZKA_ANDROID, "utf8")).toBe(zrodloAndroid());
  });
});

describe("źródło ikon", () => {
  it("nie ma dwóch ikon o tej samej nazwie", () => {
    // Duplikat nie jest błędem składni: w mapie wygrywa ostatnia, więc jedna
    // z dwóch ikon po cichu znika i w interfejsie pojawia się nie ta, co trzeba.
    expect(new Set(ikony.map((i) => i.nazwa)).size).toBe(ikony.length);
    expect(new Set(ikony.map((i) => i.kotlin)).size).toBe(ikony.length);
  });

  it("każda ikona mówi, co znaczy", () => {
    // Opis trafia do komentarza po obu stronach. Piktogram bez znaczenia jest
    // szumem — w komunikatorze, w którym ikona sieci mówi „rozmówca zna Twój
    // adres IP", szum jest kosztowny.
    for (const ikona of ikony) {
      expect(ikona.opis.length, ikona.nazwa).toBeGreaterThan(10);
    }
  });

  it("każda ścieżka mieści się w płótnie", () => {
    /*
     * Rysunek wychodzący poza 24×24 jest na Androidzie przycinany, a w webie
     * wystaje poza pole dotykowe. Jedno i drugie widać dopiero na urządzeniu,
     * więc sprawdzamy to tutaj — z zapasem 0,9 na połowę grubości konturu.
     */
    for (const ikona of ikony) {
      const liczby = ikona.sciezka.match(/-?\d+(\.\d+)?/g) ?? [];
      for (const liczba of liczby) {
        const wartosc = Number(liczba);
        expect(wartosc, `${ikona.nazwa}: ${liczba}`).toBeGreaterThanOrEqual(-0.1);
        expect(wartosc, `${ikona.nazwa}: ${liczba}`).toBeLessThanOrEqual(24.1);
      }
    }
  });

  it("każda ścieżka zaczyna się od przesunięcia pióra", () => {
    // Ścieżka bez `M` na początku rysuje od punktu (0,0) i wygląda jak ikona
    // z doklejoną kreską w rogu.
    for (const ikona of ikony) {
      expect(ikona.sciezka.startsWith("M"), ikona.nazwa).toBe(true);
    }
  });

  it("mapa dla weba pokrywa dokładnie źródło", () => {
    expect(Object.keys(SCIEZKI).sort()).toEqual(ikony.map((i) => i.nazwa).sort());

    for (const ikona of ikony) {
      expect(SCIEZKI[ikona.nazwa as NazwaIkony]).toBe(ikona.sciezka);
    }
  });
});
