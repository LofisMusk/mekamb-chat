import { describe, expect, it } from "vitest";

import { PALETA_AKCENTOW, wczytajAkcent, zapiszAkcent, zastosujAkcent } from "./akcent";

function magazyn(wartosc: string | null) {
  const wpisy = new Map<string, string>();
  if (wartosc !== null) wpisy.set("mekamb.akcent", wartosc);
  return {
    getItem: (k: string) => wpisy.get(k) ?? null,
    setItem: (k: string, v: string) => void wpisy.set(k, v),
    removeItem: (k: string) => void wpisy.delete(k),
  };
}

describe("paleta", () => {
  it("ma osiem kolorów, każdy z unikalnym id", () => {
    expect(PALETA_AKCENTOW).toHaveLength(8);
    expect(new Set(PALETA_AKCENTOW.map((a) => a.id)).size).toBe(8);
  });
});

describe("zapamiętany wybór", () => {
  it("czyta zapisany wybór", () => {
    expect(wczytajAkcent(magazyn("zielony"))).toBe("zielony");
  });

  it("brak zapisu i nieznane id znaczą domyślny (null)", () => {
    expect(wczytajAkcent(magazyn(null))).toBeNull();
    expect(wczytajAkcent(magazyn("fioletowy-metaliczny"))).toBeNull();
  });

  it("zapis i usunięcie działają przez ten sam magazyn", () => {
    const m = magazyn(null);
    zapiszAkcent("turkusowy", m);
    expect(wczytajAkcent(m)).toBe("turkusowy");
    zapiszAkcent(null, m);
    expect(wczytajAkcent(m)).toBeNull();
  });
});

describe("zastosowanie akcentu", () => {
  function dokument(motyw: "jasny" | "ciemny") {
    const wlasciwosci = new Map<string, string>();
    return {
      documentElement: {
        dataset: { motyw },
        style: {
          setProperty: (k: string, v: string) => void wlasciwosci.set(k, v),
          removeProperty: (k: string) => void wlasciwosci.delete(k),
        },
      },
      wlasciwosci,
    } as unknown as Document & { wlasciwosci: Map<string, string> };
  }

  it("ustawia pięć ról dla znanego id", () => {
    const d = dokument("jasny");
    zastosujAkcent("zielony", d);
    expect(d.wlasciwosci.get("--akcent")).toBe("#19702F");
    expect(d.wlasciwosci.get("--babel-wlasny")).toBe("#19702F");
    expect(d.wlasciwosci.get("--znacznik-tlo")).toBe("#19702F");
    expect(d.wlasciwosci.get("--akcent-tlo")).toContain("#19702F");
  });

  it("usuwa właściwości dla null — arkusz wraca do niebieskiego domyślnego", () => {
    const d = dokument("jasny");
    zastosujAkcent("malinowy", d);
    zastosujAkcent(null, d);
    expect(d.wlasciwosci.size).toBe(0);
  });

  it("nieznane id traktuje jak null", () => {
    const d = dokument("jasny");
    zastosujAkcent("nieznany", d);
    expect(d.wlasciwosci.size).toBe(0);
  });
});
