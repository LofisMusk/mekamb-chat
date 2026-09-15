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

/**
 * Współczynnik kontrastu WCAG 2.1 (1.4.3).
 *
 * Liczony w teście, a nie w `akcent.ts`: aplikacja nigdy nie potrzebuje tej
 * liczby w czasie działania — potrzebuje jej CI, żeby powiedzieć „nie", gdy
 * ktoś dołoży dziewiąty kolor na oko.
 */
function kontrast(a: string, b: string): number {
  const luminancja = (hex: string) => {
    const n = parseInt(hex.slice(1), 16);
    const kanal = (v: number) => {
      const c = v / 255;
      return c <= 0.04045 ? c / 12.92 : Math.pow((c + 0.055) / 1.055, 2.4);
    };
    return 0.2126 * kanal((n >> 16) & 255) + 0.7152 * kanal((n >> 8) & 255) + 0.0722 * kanal(n & 255);
  };

  const x = luminancja(a);
  const y = luminancja(b);
  return (Math.max(x, y) + 0.05) / (Math.min(x, y) + 0.05);
}

/**
 * Kontrast wypełnień.
 *
 * Sedno: `fill` istnieje wyłącznie po to, żeby biały tekst na akcencie dało się
 * przeczytać — a do tej pory nic tego nie sprawdzało. Komentarz w `akcent.ts`
 * mówił „przyciemniony dokładnie tyle, żeby wystarczyło", i to była cała
 * gwarancja. Bliźniak po stronie Androida: `KontrastAkcentuTest.kt`.
 */
describe("kontrast wypełnień pod białym tekstem", () => {
  const BIALY = "#FFFFFF";
  /** Próg WCAG AA dla zwykłego tekstu. Treść dymka i etykieta akcji to zwykły tekst. */
  const PROG = 4.5;

  it("liczy współczynnik zgodnie ze znanymi wartościami", () => {
    // Kotwica: gdyby formuła była zła, asercje niżej byłyby bezwartościowe.
    expect(kontrast("#000000", BIALY)).toBeCloseTo(21, 2);
    expect(kontrast(BIALY, BIALY)).toBeCloseTo(1, 3);
  });

  it.each(PALETA_AKCENTOW.filter((a) => a.id !== "niebieski"))(
    "$id: fill udźwiga biały tekst",
    ({ fill }) => {
      expect(kontrast(fill, BIALY)).toBeGreaterThanOrEqual(PROG);
    },
  );

  it("niebieski jest świadomym wyjątkiem, nie przeoczeniem", () => {
    // Systemowy błękit iOS: 4,02:1, czyli poniżej progu. Zostaje, bo jest
    // domyślnym akcentem obu klientów (i twardą wartością `--babel-wlasny`
    // w `styles.css`) — tym, co ludzie znają z natywnego komunikatora.
    // Przyciemnienie go jest decyzją projektową dla weba i Androida naraz.
    //
    // Asercja jest tu po to, żeby wyjątek był WIDOCZNY. Gdyby błękit kiedyś
    // przyciemniono, ten test upadnie i każe zdjąć wyjątek z filtra wyżej,
    // zamiast zostawić martwe wykluczenie.
    const niebieski = PALETA_AKCENTOW.find((a) => a.id === "niebieski");
    expect(niebieski?.fill).toBe("#007AFF");
    expect(kontrast("#007AFF", BIALY)).toBeCloseTo(4.02, 2);
    expect(kontrast("#007AFF", BIALY)).toBeLessThan(PROG);
  });

  it("żywa próbka nie nadaje się na wypełnienie — i dlatego są dwa pola", () => {
    // Gdyby ktoś „uprościł" paletę z powrotem do jednego odcienia, te cztery
    // akcenty po cichu wróciłyby pod próg. To jest ten sam zestaw, który na
    // Androidzie był wadą dostępności, dopóki telefon zalewał próbką.
    for (const id of ["zielony", "pomaranczowy", "malinowy", "turkusowy"]) {
      const akcent = PALETA_AKCENTOW.find((a) => a.id === id);
      expect(akcent).toBeDefined();
      expect(akcent!.probka).not.toBe(akcent!.fill);
      expect(kontrast(akcent!.probka, BIALY)).toBeLessThan(PROG);
    }
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
