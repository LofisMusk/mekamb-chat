/**
 * Zbieranie i opóźnianie potwierdzeń.
 *
 * # Dlaczego to nie leci od razu
 *
 * Potwierdzenie jest zaszyfrowane kanałem MLS, więc serwer nie wie, CO to jest.
 * Ale wie, KIEDY poszło — a potwierdzenie odczytu wysłane natychmiast po
 * przeczytaniu jest odczytywalne z samego ruchu: „urządzenie B nadało kopertę
 * cztery sekundy po wiadomości od A". To dokładnie ta informacja, której nie
 * chcemy oddawać, i której zaszyfrowanie treści nie ukrywa.
 *
 * Dlatego potwierdzenia są **zbierane** i wysyłane paczką po **losowym**
 * opóźnieniu. Losowym, nie stałym: stałe pięć sekund to tylko przesunięcie
 * korelacji o pięć sekund, a nie jej zerwanie.
 *
 * Ceną jest ptaszek pojawiający się z opóźnieniem. To widać i jest to
 * zamierzone — interfejs nie udaje, że wiemy więcej, niż wiemy.
 *
 * # Dlaczego paczka, a nie jedno potwierdzenie na wiadomość
 *
 * Bo liczba kopert też jest sygnałem. Jedna koperta na dziesięć odczytanych
 * wiadomości nie mówi obserwatorowi, ile ich było.
 */

import type { NazwaIkony } from "../Ikony";

export type RodzajPotwierdzenia = "delivered" | "read";

/** Stan wysyłki własnej wiadomości. Rośnie tylko w jedną stronę. */
export type StanWiadomosci = "w-locie" | "nieudana" | "wyslane" | "dostarczone" | "przeczytane";

/** Dolna i górna granica opóźnienia. Górna z decyzji: do 30 sekund. */
export const MIN_OPOZNIENIE_MS = 3_000;
export const MAX_OPOZNIENIE_MS = 30_000;

/** Paczka gotowa do wysłania: jedna rozmowa, jeden rodzaj, wiele wiadomości. */
export interface Paczka {
  kluczRozmowy: string;
  rodzaj: RodzajPotwierdzenia;
  /** Identyfikatory w postaci szesnastkowej — takiej, jakiej używa historia. */
  identyfikatory: string[];
}

/**
 * Losuje opóźnienie z przedziału.
 *
 * Wydzielone, żeby dało się je sprawdzić testem bez czekania pół minuty —
 * i żeby było jedno miejsce, w którym widać, że rozkład jest równomierny.
 */
export function losoweOpoznienie(los: () => number = Math.random): number {
  return Math.floor(MIN_OPOZNIENIE_MS + los() * (MAX_OPOZNIENIE_MS - MIN_OPOZNIENIE_MS));
}

/**
 * Zbieracz potwierdzeń.
 *
 * Czysty: nic nie wysyła i nie zna czasu. Trzyma, co się nazbierało, i oddaje
 * to na żądanie. Dzięki temu reguły — a jest ich kilka i każda ma powód —
 * dają się sprawdzić bez zegara i bez sieci.
 */
export class Zbieracz {
  private oczekujace = new Map<string, Map<RodzajPotwierdzenia, Set<string>>>();

  /**
   * Dokłada potwierdzenie.
   *
   * `przeczytane` pochłania `dostarczone` dla tej samej wiadomości: odczyt
   * mówi wszystko, co powiedziałoby dostarczenie, więc wysyłanie obu byłoby
   * drugą kopertą bez nowej treści — a każda koperta to sygnał w ruchu.
   */
  dodaj(kluczRozmowy: string, rodzaj: RodzajPotwierdzenia, identyfikator: string): void {
    const rozmowa = this.oczekujace.get(kluczRozmowy) ?? new Map();
    this.oczekujace.set(kluczRozmowy, rozmowa);

    if (rodzaj === "read") {
      rozmowa.get("delivered")?.delete(identyfikator);
    } else if (rozmowa.get("read")?.has(identyfikator)) {
      // Dostarczenie po odczycie nie wnosi nic — odczyt już to zawiera.
      return;
    }

    const zbior = rozmowa.get(rodzaj) ?? new Set<string>();
    rozmowa.set(rodzaj, zbior);
    zbior.add(identyfikator);
  }

  /** Czy jest co wysyłać. */
  get pusty(): boolean {
    for (const rozmowa of this.oczekujace.values()) {
      for (const zbior of rozmowa.values()) if (zbior.size > 0) return false;
    }
    return true;
  }

  /**
   * Zabiera wszystko, co się nazbierało, i czyści zbieracz.
   *
   * Zabranie, a nie odczyt: gdyby wywołujący miał czyścić osobno, nieudana
   * wysyłka albo wyjątek zostawiłyby potwierdzenia wysyłane w kółko.
   */
  zabierz(): Paczka[] {
    const paczki: Paczka[] = [];

    for (const [kluczRozmowy, rozmowa] of this.oczekujace) {
      for (const [rodzaj, zbior] of rozmowa) {
        if (zbior.size === 0) continue;
        paczki.push({ kluczRozmowy, rodzaj, identyfikatory: [...zbior] });
      }
    }

    this.oczekujace.clear();
    return paczki;
  }
}

/**
 * Stan wiadomości po odebraniu potwierdzenia.
 *
 * Rośnie tylko w jedną stronę. Potwierdzenia idą przez skrzynkę i mogą dotrzeć
 * w odwrotnej kolejności — bez tej reguły „przeczytane" cofałoby się do
 * „dostarczone", gdy spóźniona paczka dotarła po tej nowszej.
 */
const KOLEJNOSC: Record<StanWiadomosci, number> = {
  "w-locie": 0,
  nieudana: 0,
  wyslane: 1,
  dostarczone: 2,
  przeczytane: 3,
};

export function wyzszyStan(biezacy: StanWiadomosci, nowy: StanWiadomosci): StanWiadomosci {
  return KOLEJNOSC[nowy] > KOLEJNOSC[biezacy] ? nowy : biezacy;
}

/** Stan, jaki niesie potwierdzenie danego rodzaju. */
export function stanZPotwierdzenia(rodzaj: RodzajPotwierdzenia): StanWiadomosci {
  return rodzaj === "read" ? "przeczytane" : "dostarczone";
}

/** Ikona i opis stanu. Jedno miejsce, bo stan pojawia się w dymku i na liście. */
export function opisStanu(stan: StanWiadomosci): { ikona: NazwaIkony; etykieta: string } {
  switch (stan) {
    case "w-locie":
      return { ikona: "zegar", etykieta: "wysyłam" };
    case "nieudana":
      return { ikona: "niepowodzenie", etykieta: "nie wysłano" };
    case "wyslane":
      return { ikona: "wyslane", etykieta: "wysłano" };
    case "dostarczone":
      return { ikona: "dostarczone", etykieta: "dostarczono" };
    case "przeczytane":
      return { ikona: "dostarczone", etykieta: "przeczytano" };
  }
}
