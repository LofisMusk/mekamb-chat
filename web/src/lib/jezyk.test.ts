import { describe, expect, it } from "vitest";

import { slownik, wczytajJezyk, zapiszJezyk } from "./jezyk";

function magazyn(wartosc: string | null) {
  const wpisy = new Map<string, string>();
  if (wartosc !== null) wpisy.set("mekamb.jezyk", wartosc);
  return {
    getItem: (k: string) => wpisy.get(k) ?? null,
    setItem: (k: string, v: string) => void wpisy.set(k, v),
  };
}

describe("zapamiętany wybór", () => {
  it("czyta zapisany wybór", () => {
    expect(wczytajJezyk(magazyn("en"))).toBe("en");
    expect(wczytajJezyk(magazyn("pl"))).toBe("pl");
  });

  it("cokolwiek innego znaczy polski", () => {
    expect(wczytajJezyk(magazyn(null))).toBe("pl");
    expect(wczytajJezyk(magazyn("de"))).toBe("pl");
  });

  it("brak dostępu do magazynu nie wywraca startu", () => {
    const rzucajacy = {
      getItem() {
        throw new Error("brak dostępu");
      },
      setItem() {
        throw new Error("brak dostępu");
      },
    };

    expect(wczytajJezyk(rzucajacy)).toBe("pl");
    expect(() => zapiszJezyk("en", rzucajacy)).not.toThrow();
  });
});

describe("słownik", () => {
  it("ma ten sam zestaw kluczy w obu językach", () => {
    expect(Object.keys(slownik("pl")).sort()).toEqual(Object.keys(slownik("en")).sort());
  });
});
