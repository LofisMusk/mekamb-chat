import { describe, expect, it, vi } from "vitest";

import { pilnujWysokosci } from "./okno";

/**
 * Sedno: powłoka ma wysokość WIDOKU WIZUALNEGO i nie da się jej przewinąć.
 *
 * Obie reguły dotyczą jednej usterki — tej, przez którą na iPhonie dotknięcie
 * pola pisania wyrzucało całą aplikację poza ekran. Wysokość odpowiada za to,
 * żeby pole nie schowało się pod klawiaturą; cofanie przewinięcia — za to, żeby
 * Safari nie wywiozło powłoki w górę, kiedy samo postanowi wsunąć pole nad
 * klawiaturę.
 */

/** Atrapa widoku wizualnego — tyle z `visualViewport`, ile moduł naprawdę czyta. */
function atrapaOkna(height: number, scale = 1) {
  const sluchacze = new Map<string, Set<() => void>>();

  const widok = {
    height,
    scale,
    addEventListener(nazwa: string, f: () => void) {
      const zbior = sluchacze.get(nazwa) ?? new Set();
      sluchacze.set(nazwa, zbior);
      zbior.add(f);
    },
    removeEventListener(nazwa: string, f: () => void) {
      sluchacze.get(nazwa)?.delete(f);
    },
  };

  const wlasnosci = new Map<string, string>();
  const przewijany = { scrollTop: 0 };

  const okno = {
    visualViewport: widok,
    scrollX: 0,
    scrollY: 0,
    scrollTo: vi.fn((x: number, y: number) => {
      okno.scrollX = x;
      okno.scrollY = y;
    }),
    document: {
      documentElement: {
        style: {
          setProperty: (nazwa: string, wartosc: string) => wlasnosci.set(nazwa, wartosc),
          removeProperty: (nazwa: string) => wlasnosci.delete(nazwa),
        },
      },
      scrollingElement: przewijany,
    },
  };

  const drgnij = () => {
    for (const f of sluchacze.get("scroll") ?? []) f();
    for (const f of sluchacze.get("resize") ?? []) f();
  };

  return { okno, widok, wlasnosci, przewijany, drgnij };
}

describe("pilnujWysokosci", () => {
  it("ustawia token na wysokość widoku wizualnego, nie okna", () => {
    const { okno, wlasnosci } = atrapaOkna(500);

    pilnujWysokosci(okno as unknown as Window);

    expect(wlasnosci.get("--wysokosc-okna")).toBe("500px");
  });

  it("nadąża za klawiaturą — zmiana widoku zmienia token", () => {
    const { okno, widok, wlasnosci, drgnij } = atrapaOkna(800);
    pilnujWysokosci(okno as unknown as Window);

    // Tak wygląda otwarcie klawiatury: `dvh` się nie rusza, widok wizualny tak.
    widok.height = 480;
    drgnij();

    expect(wlasnosci.get("--wysokosc-okna")).toBe("480px");
  });

  /*
   * Ta reguła jest sednem poprawki dla iPhone'a: Safari przewija widok układu
   * samo, żeby wsunąć pole nad klawiaturę, i zabiera ze sobą przypiętą powłokę.
   */
  it("cofa przewinięcie, którego dokonało Safari", () => {
    const { okno, przewijany, drgnij } = atrapaOkna(480);
    pilnujWysokosci(okno as unknown as Window);

    okno.scrollY = 220;
    przewijany.scrollTop = 220;
    drgnij();

    expect(okno.scrollY).toBe(0);
    expect(przewijany.scrollTop).toBe(0);
  });

  /*
   * Powiększenie szczypaniem to jedyny przypadek, w którym przewijanie jest
   * decyzją użytkownika — i jedyny sposób obejrzenia reszty strony. Odbieranie
   * go byłoby odbieraniem dostępności komuś, kto właśnie z niej korzysta.
   */
  it("nie rusza przewinięcia przy powiększeniu szczypaniem", () => {
    const { okno, przewijany, drgnij } = atrapaOkna(480, 2.5);
    pilnujWysokosci(okno as unknown as Window);

    okno.scrollY = 220;
    przewijany.scrollTop = 220;
    drgnij();

    expect(okno.scrollY).toBe(220);
    expect(przewijany.scrollTop).toBe(220);
  });

  it("po odpięciu nie pilnuje już niczego", () => {
    const { okno, widok, wlasnosci, drgnij } = atrapaOkna(700);
    const odepnij = pilnujWysokosci(okno as unknown as Window);

    odepnij();
    widok.height = 300;
    okno.scrollY = 90;
    drgnij();

    expect(wlasnosci.has("--wysokosc-okna")).toBe(false);
    expect(okno.scrollY).toBe(90);
  });
});
