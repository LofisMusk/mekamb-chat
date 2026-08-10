import { describe, expect, it } from "vitest";

import { znajdzRozmowe1na1 } from "./rozmowy";

const JA = "ala";

function rozmowa(id: number) {
  return { groupId: Uint8Array.of(id) };
}

/** Skład grup po identyfikatorze — zastępuje drzewo MLS. */
function sklad(mapa: Record<number, string[]>) {
  return (groupId: Uint8Array) => {
    const czlonkowie = mapa[groupId[0]!];
    if (!czlonkowie) throw new Error("nie ma takiej grupy w stanie MLS");
    return czlonkowie;
  };
}

describe("wybór rozmowy jeden na jeden", () => {
  /// Sedno: to jest ta usterka. Druga próba napisania do tej samej osoby
  /// zakładała drugą grupę, więc lista puchła od duplikatów, a historia
  /// rozjeżdżała się między nimi.
  it("znajduje istniejącą rozmowę z tą samą osobą", () => {
    const rozmowy = [rozmowa(1)];
    const znaleziona = znajdzRozmowe1na1(rozmowy, sklad({ 1: [JA, "bartek"] }), JA, "bartek");

    expect(znaleziona).toBe(rozmowy[0]);
  });

  it("nie podstawia rozmowy z kimś innym", () => {
    const rozmowy = [rozmowa(1)];

    expect(znajdzRozmowe1na1(rozmowy, sklad({ 1: [JA, "bartek"] }), JA, "celina")).toBeUndefined();
  });

  /// Sedno: grupa nazwana imieniem jednej osoby wciąż jest grupą. Wciągnięcie
  /// do niej rozmowy prywatnej pokazałoby ją pozostałym uczestnikom.
  it("nie traktuje grupy trzyosobowej jako rozmowy z jedną osobą", () => {
    const rozmowy = [rozmowa(1)];
    const trzyosobowa = sklad({ 1: [JA, "bartek", "celina"] });

    expect(znajdzRozmowe1na1(rozmowy, trzyosobowa, JA, "bartek")).toBeUndefined();
  });

  it("wybiera właściwą spośród wielu rozmów", () => {
    const rozmowy = [rozmowa(1), rozmowa(2), rozmowa(3)];
    const wszystkie = sklad({
      1: [JA, "bartek"],
      2: [JA, "celina", "dawid"],
      3: [JA, "celina"],
    });

    expect(znajdzRozmowe1na1(rozmowy, wszystkie, JA, "celina")).toBe(rozmowy[2]);
  });

  /// Grupa, której nie ma w stanie MLS (np. po przeniesieniu konta), nie może
  /// przerwać szukania — inaczej jedna uszkodzona pozycja blokowałaby
  /// odnalezienie każdej następnej.
  it("pomija rozmowę, której stan MLS nie zna, i szuka dalej", () => {
    const rozmowy = [rozmowa(9), rozmowa(1)];
    const znaleziona = znajdzRozmowe1na1(rozmowy, sklad({ 1: [JA, "bartek"] }), JA, "bartek");

    expect(znaleziona).toBe(rozmowy[1]);
  });

  it("nie podstawia rozmowy z samym sobą", () => {
    const rozmowy = [rozmowa(1)];

    expect(znajdzRozmowe1na1(rozmowy, sklad({ 1: [JA] }), JA, JA)).toBeUndefined();
  });

  it("brak rozmów to brak dopasowania, nie wyjątek", () => {
    expect(znajdzRozmowe1na1([], sklad({}), JA, "bartek")).toBeUndefined();
  });
});
