import { beforeEach, describe, expect, it, vi } from "vitest";

import {
  graniceOdciecia,
  opisZnikania,
  ustawZnikanie,
  wczytajZnikanie,
  zapomnijZnikanie,
} from "./znikanie";
import { kluczRozmowy } from "./historia";

/** Skarbiec w pamięci — IndexedDB w testach nie ma. */
let dysk: Uint8Array | null = null;

vi.mock("./vault", () => ({
  loadEphemeral: async () => dysk,
  saveEphemeral: async (b: Uint8Array) => {
    dysk = b;
  },
}));

const GRUPA = new Uint8Array([1, 2, 3]);
const KLUCZ = kluczRozmowy(GRUPA);

beforeEach(() => {
  dysk = null;
});

describe("graniceOdciecia", () => {
  // Sedno: granica to „najstarsza chwila do zachowania" = teraz − czas życia.
  // Wiadomość starsza niż granica ma przepaść.
  it("odejmuje czas życia od chwili teraz", () => {
    const teraz = 1_000_000;
    const granice = graniceOdciecia({ [KLUCZ]: 60 }, teraz);
    expect(granice[KLUCZ]).toBe(teraz - 60_000);
  });

  // Rozmowa bez znikania (czas 0 albo brak wpisu) nie ma się w ogóle pojawić —
  // inaczej przycinanie usuwałoby wszystko starsze niż „teraz", czyli wszystko.
  it("pomija rozmowy bez ustawionego znikania", () => {
    expect(graniceOdciecia({}, 1_000)).toEqual({});
    expect(graniceOdciecia({ [KLUCZ]: 0 }, 1_000)).toEqual({});
  });
});

describe("opisZnikania", () => {
  // Presety mają swoje nazwy; własne wartości opisujemy w największej równej
  // jednostce, żeby „3600 s" czytało się jako „1 godzina".
  it("nazywa presety i własne wartości po ludzku", () => {
    expect(opisZnikania(60 * 60)).toBe("1 godzina");
    expect(opisZnikania(2 * 60 * 60)).toBe("2 godz.");
    expect(opisZnikania(90 * 60)).toBe("90 min");
    expect(opisZnikania(3 * 24 * 60 * 60)).toBe("3 dni");
  });
});

describe("ustawZnikanie", () => {
  // Domyślnie wyłączone: wyłączenie kasuje wpis, a nie zapisuje zero — inaczej
  // „0 s" udawałoby ustawienie i przycinanie brałoby je za „wszystko od razu".
  it("zapisuje sekundy, a null wyłącza (usuwa wpis)", async () => {
    await ustawZnikanie(GRUPA, 300);
    expect((await wczytajZnikanie())[KLUCZ]).toBe(300);

    await ustawZnikanie(GRUPA, null);
    expect(KLUCZ in (await wczytajZnikanie())).toBe(false);
  });

  it("traktuje zero i wartości ujemne jak wyłączenie", async () => {
    await ustawZnikanie(GRUPA, 120);
    await ustawZnikanie(GRUPA, 0);
    expect(KLUCZ in (await wczytajZnikanie())).toBe(false);
  });
});

describe("zapomnijZnikanie", () => {
  it("usuwa ustawienie przy skasowaniu rozmowy", async () => {
    await ustawZnikanie(GRUPA, 300);
    await zapomnijZnikanie(GRUPA);
    expect(KLUCZ in (await wczytajZnikanie())).toBe(false);
  });
});
