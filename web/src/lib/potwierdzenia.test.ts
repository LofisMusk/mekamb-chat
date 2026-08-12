import { describe, expect, it } from "vitest";

import {
  MAX_OPOZNIENIE_MS,
  MIN_OPOZNIENIE_MS,
  Zbieracz,
  losoweOpoznienie,
  stanZPotwierdzenia,
  wyzszyStan,
} from "./potwierdzenia";

/*
 * Sedno: potwierdzenie jest zaszyfrowane, ale CHWILA jego wysłania nie jest.
 *
 * Serwer nie wie, co jest w kopercie. Wie, kiedy poszła — a potwierdzenie
 * odczytu wysłane natychmiast po przeczytaniu mówi mu „B przeczytał wiadomość
 * od A cztery sekundy temu". Opóźnienie i zbieranie w paczki są jedyną obroną,
 * jaką ma tu klient, więc mają być sprawdzone, a nie założone.
 */
describe("opóźnienie wysyłki", () => {
  it("mieści się w zadeklarowanym przedziale", () => {
    for (const los of [0, 0.25, 0.5, 0.9999]) {
      const opoznienie = losoweOpoznienie(() => los);
      expect(opoznienie).toBeGreaterThanOrEqual(MIN_OPOZNIENIE_MS);
      expect(opoznienie).toBeLessThanOrEqual(MAX_OPOZNIENIE_MS);
    }
  });

  it("nie jest stałe", () => {
    // Stałe opóźnienie przesuwa korelację, zamiast ją zrywać: obserwator
    // odejmuje pięć sekund i ma z powrotem chwilę odczytu.
    expect(losoweOpoznienie(() => 0)).not.toBe(losoweOpoznienie(() => 0.99));
  });

  it("górna granica to 30 sekund z decyzji", () => {
    expect(MAX_OPOZNIENIE_MS).toBe(30_000);
  });
});

describe("zbieracz potwierdzeń", () => {
  it("nowy jest pusty", () => {
    expect(new Zbieracz().pusty).toBe(true);
  });

  it("skleja wiadomości z jednej rozmowy w jedną paczkę", () => {
    // Liczba kopert też jest sygnałem: jedna na dziesięć odczytanych wiadomości
    // nie mówi obserwatorowi, ile ich było.
    const zbieracz = new Zbieracz();
    zbieracz.dodaj("rozmowa-a", "read", "aa");
    zbieracz.dodaj("rozmowa-a", "read", "bb");
    zbieracz.dodaj("rozmowa-a", "read", "cc");

    const paczki = zbieracz.zabierz();
    expect(paczki).toHaveLength(1);
    expect(paczki[0]?.identyfikatory).toEqual(["aa", "bb", "cc"]);
  });

  it("rozdziela paczki po rozmowie i po rodzaju", () => {
    const zbieracz = new Zbieracz();
    zbieracz.dodaj("rozmowa-a", "read", "aa");
    zbieracz.dodaj("rozmowa-a", "delivered", "bb");
    zbieracz.dodaj("rozmowa-b", "read", "cc");

    expect(zbieracz.zabierz()).toHaveLength(3);
  });

  it("nie powtarza tego samego identyfikatora", () => {
    const zbieracz = new Zbieracz();
    zbieracz.dodaj("rozmowa-a", "delivered", "aa");
    zbieracz.dodaj("rozmowa-a", "delivered", "aa");

    expect(zbieracz.zabierz()[0]?.identyfikatory).toEqual(["aa"]);
  });

  it("odczyt pochłania dostarczenie tej samej wiadomości", () => {
    // Odczyt mówi wszystko, co powiedziałoby dostarczenie. Wysłanie obu byłoby
    // drugą kopertą bez nowej treści — a każda koperta to sygnał w ruchu.
    const zbieracz = new Zbieracz();
    zbieracz.dodaj("rozmowa-a", "delivered", "aa");
    zbieracz.dodaj("rozmowa-a", "read", "aa");

    const paczki = zbieracz.zabierz();
    expect(paczki).toHaveLength(1);
    expect(paczki[0]?.rodzaj).toBe("read");
  });

  it("dostarczenie po odczycie nie wraca", () => {
    const zbieracz = new Zbieracz();
    zbieracz.dodaj("rozmowa-a", "read", "aa");
    zbieracz.dodaj("rozmowa-a", "delivered", "aa");

    const paczki = zbieracz.zabierz();
    expect(paczki).toHaveLength(1);
    expect(paczki[0]?.rodzaj).toBe("read");
  });

  it("zabranie czyści zbieracz", () => {
    // Gdyby czyszczenie było osobnym krokiem, nieudana wysyłka zostawiłaby
    // potwierdzenia wysyłane w kółko.
    const zbieracz = new Zbieracz();
    zbieracz.dodaj("rozmowa-a", "read", "aa");

    expect(zbieracz.zabierz()).toHaveLength(1);
    expect(zbieracz.zabierz()).toHaveLength(0);
    expect(zbieracz.pusty).toBe(true);
  });
});

/*
 * Sedno: potwierdzenia idą przez skrzynkę, więc mogą dotrzeć w odwrotnej
 * kolejności. Bez reguły „tylko w górę" spóźniona paczka z dostarczeniem
 * cofałaby dymek z „przeczytane" na „dostarczone" — na oczach użytkownika.
 */
describe("stan wiadomości", () => {
  it("rośnie tylko w jedną stronę", () => {
    expect(wyzszyStan("dostarczone", "przeczytane")).toBe("przeczytane");
    expect(wyzszyStan("przeczytane", "dostarczone")).toBe("przeczytane");
    expect(wyzszyStan("wyslane", "dostarczone")).toBe("dostarczone");
    expect(wyzszyStan("przeczytane", "wyslane")).toBe("przeczytane");
  });

  it("potwierdzenie odczytu znaczy przeczytane, dostarczenia — dostarczone", () => {
    expect(stanZPotwierdzenia("read")).toBe("przeczytane");
    expect(stanZPotwierdzenia("delivered")).toBe("dostarczone");
  });
});
