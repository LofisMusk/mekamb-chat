import { describe, expect, it } from "vitest";

import {
  PROG_DOBRANIA,
  ZAPAS_DOCELOWY,
  type Token,
  ileTokenow,
  naglowekTokenu,
  wezToken,
} from "./tokeny";

/**
 * Portfel tokenów doręczeniowych.
 *
 * Sedno: token ma dowodzić „mam prawo nadać", nie mówiąc „jestem tym kontem".
 * Wydawanie ich pojedynczo tuż przed wysyłką zniweczyłoby to, bo pobranie jest
 * żądaniem uwierzytelnionym — serwer widziałby „konto A poprosiło o token,
 * sekundę później ktoś nadał do skrzynki B". Dlatego zapas bierze się z góry
 * i wydaje pojedynczo.
 */

function magazyn(poczatek: Token[] = []) {
  const dane = new Map<string, string>([["mekamb.tokeny", JSON.stringify(poczatek)]]);

  return {
    getItem: (k: string) => dane.get(k) ?? null,
    setItem: (k: string, v: string) => void dane.set(k, v),
  };
}

const TOKEN: Token = { seed: "AAAA", unblinded: "BBBB" };

describe("zapas tokenów", () => {
  it("pusty zapas nie daje tokenu", () => {
    // Wołający ma wtedy nadać BEZ tokenu: wiadomość jest ważniejsza niż limit
    // nadużyć, dopóki serwer tokenów nie wymusza.
    expect(wezToken(magazyn())).toBeNull();
  });

  it("wydaje po jednym i zdejmuje z zapasu", () => {
    const m = magazyn([TOKEN, { seed: "CCCC", unblinded: "DDDD" }]);

    expect(wezToken(m)).toEqual(TOKEN);
    expect(ileTokenow(m)).toBe(1);
    expect(wezToken(m)).toEqual({ seed: "CCCC", unblinded: "DDDD" });
    expect(wezToken(m)).toBeNull();
  });

  it("ten sam token nie wychodzi dwa razy", () => {
    // Serwer odrzuciłby drugie użycie, ale wiadomość by wtedy nie doszła —
    // a przyczyna byłaby po naszej stronie.
    const m = magazyn([TOKEN]);

    expect(wezToken(m)).not.toBeNull();
    expect(wezToken(m)).toBeNull();
  });

  it("uszkodzony zapis znaczy pusty zapas, a nie awarie", () => {
    const dane = new Map([["mekamb.tokeny", "{to nie jest json"]]);
    const m = {
      getItem: (k: string) => dane.get(k) ?? null,
      setItem: (k: string, v: string) => void dane.set(k, v),
    };

    expect(() => wezToken(m)).not.toThrow();
    expect(wezToken(m)).toBeNull();
  });

  it("brak dostępu do magazynu nie wywraca wysyłki", () => {
    const rzucajacy = {
      getItem() {
        throw new Error("brak dostępu");
      },
      setItem() {
        throw new Error("brak dostępu");
      },
    };

    expect(wezToken(rzucajacy)).toBeNull();
  });
});

describe("nagłówek tokenu", () => {
  it("ma kształt, jakiego oczekuje serwer", () => {
    // Dwa pola rozdzielone kropką. Rozjazd tutaj znaczy odrzucone nadanie
    // z komunikatem, który niczego nie tłumaczy.
    expect(naglowekTokenu(TOKEN)).toBe("AAAA.BBBB");
    expect(naglowekTokenu(TOKEN).split(".")).toHaveLength(2);
  });
});

describe("progi zapasu", () => {
  it("dobieramy zanim zapas się skończy", () => {
    // Próg równy zeru znaczyłby dobieranie dopiero przy pustym portfelu, czyli
    // uwierzytelnione żądanie dokładnie w chwili wysyłania wiadomości.
    expect(PROG_DOBRANIA).toBeGreaterThan(0);
    expect(PROG_DOBRANIA).toBeLessThan(ZAPAS_DOCELOWY);
  });
});
