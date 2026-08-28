import { beforeEach, describe, expect, it, vi } from "vitest";

import { odblokuj, wczytajBlokady, zablokuj } from "./blokady";

/** Skarbiec w pamięci — IndexedDB w testach nie ma. */
let dysk: Uint8Array | null = null;

vi.mock("./vault", () => ({
  loadBlocked: async () => dysk,
  saveBlocked: async (b: Uint8Array) => {
    dysk = b;
  },
}));

beforeEach(() => {
  dysk = null;
});

describe("blokady", () => {
  // Sedno: blokada jest po NAZWIE użytkownika (tożsamość MLS), utrwalana na
  // dysku, więc przeżywa odświeżenie karty.
  it("zapisuje i odczytuje zablokowane nazwy", async () => {
    await zablokuj("adam");
    await zablokuj("beata");
    expect([...(await wczytajBlokady())].sort()).toEqual(["adam", "beata"]);
  });

  it("odblokowanie zdejmuje wpis", async () => {
    await zablokuj("adam");
    const stan = await odblokuj("adam");
    expect(stan.has("adam")).toBe(false);
    expect((await wczytajBlokady()).has("adam")).toBe(false);
  });

  // Ponowne zablokowanie tej samej osoby to zbiór, nie lista: bez duplikatów.
  it("nie dubluje tej samej osoby", async () => {
    await zablokuj("adam");
    await zablokuj("adam");
    expect([...(await wczytajBlokady())]).toEqual(["adam"]);
  });

  // Pusty/uszkodzony zapis czytamy jako brak blokad, a nie wyjątek — inaczej
  // jeden zły bajt na dysku zabierałby całą listę rozmów.
  it("na pustym dysku zwraca pusty zbiór", async () => {
    expect((await wczytajBlokady()).size).toBe(0);
  });
});
