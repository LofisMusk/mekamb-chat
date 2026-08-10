import { describe, expect, it } from "vitest";

import { MINIMALNY_DYSTANS_PX, SZEROKOSC_KRAWEDZI_PX, czyGestWstecz } from "./nawigacja";

/**
 * Gest cofania.
 *
 * Sedno: ten gest dzieli ekran z przewijaniem listy i z przeciąganiem zdjęć.
 * Rozpoznany zbyt chętnie zabiera rozmowę w środku czytania — i to jest gorsze
 * niż nierozpoznanie go wcale, bo użytkownik nie prosił o żadną zmianę.
 */
describe("gest cofania", () => {
  const przyKrawedzi = { x: 4, y: 300 };

  it("przeciągnięcie od krawędzi w prawo cofa", () => {
    const koniec = { x: przyKrawedzi.x + MINIMALNY_DYSTANS_PX, y: 300 };

    expect(czyGestWstecz(przyKrawedzi, koniec)).toBe(true);
  });

  /// Bez wymogu krawędzi każde przewinięcie listy w bok cofałoby ekran.
  it("przeciągnięcie ze środka ekranu nie cofa", () => {
    const start = { x: SZEROKOSC_KRAWEDZI_PX + 1, y: 300 };

    expect(czyGestWstecz(start, { x: start.x + 200, y: 300 })).toBe(false);
  });

  it("przeciągnięcie w lewo nie cofa", () => {
    expect(czyGestWstecz(przyKrawedzi, { x: przyKrawedzi.x - 200, y: 300 })).toBe(false);
  });

  it("krótkie muśnięcie nie cofa", () => {
    const koniec = { x: przyKrawedzi.x + MINIMALNY_DYSTANS_PX - 1, y: 300 };

    expect(czyGestWstecz(przyKrawedzi, koniec)).toBe(false);
  });

  /// Przewijanie w pionie rzadko jest idealnie pionowe — bez przewagi
  /// poziomej rozmowa uciekałaby przy zwykłym czytaniu.
  it("przewinięcie w pionie z odchyleniem w bok nie cofa", () => {
    const koniec = { x: przyKrawedzi.x + 80, y: przyKrawedzi.y + 300 };

    expect(czyGestWstecz(przyKrawedzi, koniec)).toBe(false);
  });

  it("ukośne, ale głównie poziome przeciągnięcie od krawędzi cofa", () => {
    const koniec = { x: przyKrawedzi.x + 160, y: przyKrawedzi.y + 40 };

    expect(czyGestWstecz(przyKrawedzi, koniec)).toBe(true);
  });
});
