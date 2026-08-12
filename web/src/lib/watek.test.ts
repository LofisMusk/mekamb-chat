import { describe, expect, it } from "vitest";

import type { Wiadomosc } from "./historia";
import { PRZERWA_BLOKU_MS, etykietaDnia, ulozWatek } from "./watek";

const DZIEN = 24 * 60 * 60 * 1000;

function wiadomosc(czas: number, autor = "ola", wlasna = false): Wiadomosc {
  return { id: `${autor}-${czas}`, autor, tresc: "cześć", czas, wlasna };
}

/** Południe podanego dnia — środek doby, więc strefa czasowa nie przesuwa daty. */
function poludnie(rok: number, miesiac: number, dzien: number): number {
  return new Date(rok, miesiac - 1, dzien, 12, 0, 0).getTime();
}

describe("etykieta dnia", () => {
  const teraz = poludnie(2026, 8, 10);

  it("dzisiaj i wczoraj są słowem, nie datą", () => {
    // Data przy rozmowie sprzed godziny jest odpowiedzią na pytanie, którego
    // nikt nie zadał.
    expect(etykietaDnia(teraz - 3 * 60 * 60 * 1000, teraz)).toBe("Dziś");
    expect(etykietaDnia(teraz - DZIEN, teraz)).toBe("Wczoraj");
  });

  it("rok pojawia się dopiero przy innym roku", () => {
    // „14 marca 2026" przy każdej rozmowie z tego tygodnia to szum.
    expect(etykietaDnia(poludnie(2026, 3, 14), teraz)).not.toMatch(/2026/);
    expect(etykietaDnia(poludnie(2025, 3, 14), teraz)).toMatch(/2025/);
  });
});

describe("układ wątku", () => {
  const teraz = poludnie(2026, 8, 10);

  it("pusty wątek nie ma rozdzielaczy", () => {
    expect(ulozWatek([], teraz)).toEqual([]);
  });

  it("każdy dzień dostaje jeden rozdzielacz", () => {
    const uklad = ulozWatek(
      [
        wiadomosc(poludnie(2026, 8, 8)),
        wiadomosc(poludnie(2026, 8, 8) + 60_000),
        wiadomosc(poludnie(2026, 8, 9)),
      ],
      teraz,
    );

    expect(uklad.filter((p) => p.rodzaj === "dzien")).toHaveLength(2);
    expect(uklad[0]?.rodzaj).toBe("dzien");
  });

  it("skleja wiadomości tej samej osoby wysłane blisko siebie", () => {
    const start = poludnie(2026, 8, 10);
    const uklad = ulozWatek([wiadomosc(start), wiadomosc(start + 30_000)], teraz);
    const wiadomosci = uklad.filter((p) => p.rodzaj === "wiadomosc");

    // Pierwsza w bloku nigdy nie jest ciągiem — inaczej ścięty róg pojawia się
    // pod rozdzielaczem dnia i sugeruje, że coś jest wyżej.
    expect(wiadomosci[0]).toMatchObject({ ciag: false });
    expect(wiadomosci[1]).toMatchObject({ ciag: true });
  });

  it("przerwa dłuższa niż kilka minut zrywa blok", () => {
    // Bez tego dwie wiadomości tej samej osoby — rano i wieczorem — skleiłyby
    // się w jeden dymek, choć dzieli je pół dnia.
    const start = poludnie(2026, 8, 10);
    const uklad = ulozWatek([wiadomosc(start), wiadomosc(start + PRZERWA_BLOKU_MS + 1)], teraz);

    expect(uklad.filter((p) => p.rodzaj === "wiadomosc")[1]).toMatchObject({ ciag: false });
  });

  it("zmiana autora zrywa blok", () => {
    const start = poludnie(2026, 8, 10);
    const uklad = ulozWatek([wiadomosc(start, "ola"), wiadomosc(start + 1000, "jan")], teraz);

    expect(uklad.filter((p) => p.rodzaj === "wiadomosc")[1]).toMatchObject({ ciag: false });
  });

  it("własna po cudzej zrywa blok mimo tego samego autora", () => {
    /*
     * Sedno: strona dymka jest ważniejsza niż nazwa autora.
     *
     * Wiadomości własne zapisujemy z autorem „Ty", ale rozmowa z samym sobą
     * z drugiego urządzenia przyszłaby z naszą własną nazwą użytkownika.
     * Sklejenie dymka po lewej z dymkiem po prawej dałoby ścięty róg
     * w miejscu, w którym nic nad nim nie stoi.
     */
    const start = poludnie(2026, 8, 10);
    const uklad = ulozWatek(
      [wiadomosc(start, "ola", false), wiadomosc(start + 1000, "ola", true)],
      teraz,
    );

    expect(uklad.filter((p) => p.rodzaj === "wiadomosc")[1]).toMatchObject({ ciag: false });
  });
});
