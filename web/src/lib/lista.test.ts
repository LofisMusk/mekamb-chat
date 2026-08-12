import { describe, expect, it } from "vitest";

import type { PozycjaListy } from "./historia";
import { bezOgonkow, filtrujRozmowy } from "./lista";

function pozycja(rozmowca: string, ostatnia?: string): PozycjaListy {
  return {
    groupId: new Uint8Array([rozmowca.length]),
    rozmowca,
    nieprzeczytane: 0,
    ostatnia: ostatnia
      ? { id: rozmowca, autor: rozmowca, tresc: ostatnia, czas: 0, wlasna: false }
      : undefined,
  };
}

const nazwa = (p: PozycjaListy) => p.rozmowca;

describe("sprowadzenie do postaci porównywalnej", () => {
  it("zdejmuje ogonki i wielkość liter", () => {
    expect(bezOgonkow("Michał")).toBe("michal");
    expect(bezOgonkow("ŻÓŁĆ")).toBe("zolc");
    expect(bezOgonkow("Ćma Ęśna")).toBe("cma esna");
  });

  it("literę „ł” też — a nie rozkłada się jak reszta", () => {
    // Jedyna polska litera, której NFD nie rozbija na literę i znak łączony.
    // Bez osobnej podmiany fraza „michal" nie znajdowałaby „Michał".
    expect(bezOgonkow("ł")).toBe("l");
    expect(bezOgonkow("Ł")).toBe("l");
  });
});

/*
 * Sedno: szukanie, które wymaga trafienia w ogonek, jest szukaniem, z którego
 * ludzie rezygnują po drugiej próbie — zwłaszcza na klawiaturze telefonu.
 */
describe("filtrowanie listy rozmów", () => {
  const rozmowy = [
    pozycja("Michał", "do zobaczenia jutro"),
    pozycja("Ola", "wysłałam ci zdjęcia"),
    pozycja("zespół", "spotkanie o 15"),
  ];

  it("pusta fraza zwraca całą listę", () => {
    expect(filtrujRozmowy(rozmowy, "", nazwa)).toHaveLength(3);
    expect(filtrujRozmowy(rozmowy, "   ", nazwa)).toHaveLength(3);
  });

  it("znajduje po nazwie bez ogonków", () => {
    expect(filtrujRozmowy(rozmowy, "michal", nazwa).map(nazwa)).toEqual(["Michał"]);
    expect(filtrujRozmowy(rozmowy, "ZESPOL", nazwa).map(nazwa)).toEqual(["zespół"]);
  });

  it("znajduje po treści ostatniej wiadomości", () => {
    // Rozmowy pamięta się nie po tym, kto je prowadził, tylko po tym, co padło.
    expect(filtrujRozmowy(rozmowy, "zdjęcia", nazwa).map(nazwa)).toEqual(["Ola"]);
    expect(filtrujRozmowy(rozmowy, "zdjecia", nazwa).map(nazwa)).toEqual(["Ola"]);
  });

  it("rozmowa bez wiadomości nie wywraca szukania", () => {
    expect(filtrujRozmowy([pozycja("Ala")], "cokolwiek", nazwa)).toEqual([]);
    expect(filtrujRozmowy([pozycja("Ala")], "ala", nazwa)).toHaveLength(1);
  });

  it("nazwa pochodzi z zewnątrz, nie z zapisu", () => {
    // Pozycje zapisane przed poprawką nazw mają je puste, a wywołujący
    // odtwarza je ze składu MLS. Szukanie ma działać po tym, co widać.
    const bezNazwy = pozycja("");
    expect(filtrujRozmowy([bezNazwy], "ola", () => "Ola")).toHaveLength(1);
  });
});
