import { describe, expect, it } from "vitest";

import {
  DLUGOSC_ID,
  idWiadomosci,
  rozetnijIdentyfikatory,
  sklejIdentyfikatory,
} from "./messenger";

/*
 * Sedno: identyfikator wiadomości musi dać się odwrócić.
 *
 * Dopóki służył tylko za klucz Reacta, nikt nie zauważył, że bajt 0x0A zapisuje
 * się jako „a" zamiast „0a". Potwierdzenia odczytu wskazują wiadomości właśnie
 * po tym identyfikatorze — zapis nieodwracalny znaczyłby ptaszki lądujące na
 * przypadkowych dymkach albo na żadnym.
 */
describe("identyfikator wiadomości", () => {
  it("zawsze ma dwa znaki na bajt", () => {
    const bajty = new Uint8Array([0x00, 0x0a, 0x10, 0xff]);
    expect(idWiadomosci(bajty)).toBe("000a10ff");
  });

  it("robi pełne koło przez sklejenie i rozcięcie", () => {
    const a = new Uint8Array(DLUGOSC_ID).fill(0x0a);
    const b = new Uint8Array(DLUGOSC_ID).fill(0xff);
    const identyfikatory = [idWiadomosci(a), idWiadomosci(b)];

    expect(rozetnijIdentyfikatory(sklejIdentyfikatory(identyfikatory))).toEqual(identyfikatory);
  });

  it("sklejenie daje dokładnie 16 bajtów na wiadomość", () => {
    // Rdzeń odrzuca ładunek, którego długość nie jest wielokrotnością 16 —
    // lepiej, żeby to się nie zdarzyło już tutaj.
    const identyfikatory = ["0".repeat(32), "f".repeat(32), "1".repeat(32)];
    expect(sklejIdentyfikatory(identyfikatory).length).toBe(3 * DLUGOSC_ID);
  });

  it("pusta lista daje pustą tablicę", () => {
    expect(sklejIdentyfikatory([]).length).toBe(0);
    expect(rozetnijIdentyfikatory(new Uint8Array(0))).toEqual([]);
  });

  it("ogon krótszy niż identyfikator jest pomijany", () => {
    // Dane z sieci są wrogie z założenia. Rdzeń takiego ładunku nie wypuści,
    // ale ta funkcja nie ma prawa zwrócić obciętego identyfikatora, który
    // przypadkiem trafiłby w jakąś wiadomość.
    const obciete = new Uint8Array(DLUGOSC_ID + 5);
    expect(rozetnijIdentyfikatory(obciete)).toHaveLength(1);
  });
});
