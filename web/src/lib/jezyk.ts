import { useSyncExternalStore } from "react";

/**
 * Język interfejsu — EN domyślnie, PL jako wybór.
 *
 * # Dlaczego para napisów w miejscu użycia, a nie katalog kluczy
 *
 * Ten sam kształt co `t(pl, en)` na Androidzie (`Jezyk.kt`) i iOS
 * (`Jezyk.swift`): obie wersje stoją obok siebie w kodzie, więc nie ma
 * klucza, który by się rozjechał z treścią, i nie ma pliku tłumaczeń, o którym
 * da się zapomnieć przy dodawaniu przycisku. Przy dwóch językach katalog
 * kosztowałby więcej, niż daje.
 *
 * # Dlaczego angielski domyślnie
 *
 * Angielski jest głównym językiem projektu. Polski zostaje pełnoprawnym
 * wyborem — w ustawieniach i na ekranie powitania, bo osoba nieznająca
 * angielskiego musi do niego dotrzeć bez logowania.
 *
 * # Dlaczego zapisany jest WYBÓR
 *
 * Jak przy motywie: przechowujemy to, co ktoś wybrał, a nie wynik. Brak wpisu
 * znaczy „domyślny", więc zmiana domyślnego języka w przyszłości obejmie też
 * tych, którzy nigdy nic nie wybierali.
 */
export type Jezyk = "pl" | "en";

const KLUCZ = "mekamb.jezyk";

function wczytaj(): Jezyk {
  try {
    return localStorage.getItem(KLUCZ) === "pl" ? "pl" : "en";
  } catch {
    return "en";
  }
}

let biezacy: Jezyk = typeof localStorage === "undefined" ? "en" : wczytaj();
const sluchacze = new Set<() => void>();

function ustawAtrybut() {
  if (typeof document !== "undefined") document.documentElement.lang = biezacy;
}
ustawAtrybut();

/** Właściwa połowa pary — wg języka wybranego teraz. */
export function t(pl: string, en: string): string {
  return biezacy === "pl" ? pl : en;
}

export function jezyk(): Jezyk {
  return biezacy;
}

export function ustawJezyk(nowy: Jezyk) {
  if (nowy === biezacy) return;
  biezacy = nowy;
  try {
    localStorage.setItem(KLUCZ, nowy);
  } catch {
    // Prywatne okno bez magazynu: wybór działa do zamknięcia karty.
  }
  ustawAtrybut();
  for (const powiadom of sluchacze) powiadom();
}

/**
 * Subskrypcja języka dla korzenia drzewa.
 *
 * Wystarczy w JEDNYM miejscu (korzeń aplikacji): ponowny render korzenia
 * schodzi w dół do każdego komponentu, a `t()` czyta język przy renderze.
 */
export function useJezyk(): Jezyk {
  return useSyncExternalStore(
    (powiadom) => {
      sluchacze.add(powiadom);
      return () => sluchacze.delete(powiadom);
    },
    () => biezacy,
    () => "en",
  );
}

/** Locale do `Intl` — daty i godziny w języku interfejsu, nie przeglądarki. */
export function locale(): string {
  return biezacy === "pl" ? "pl-PL" : "en-US";
}
