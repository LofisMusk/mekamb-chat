/**
 * Język interfejsu — polski albo angielski, wybór trwały na tym urządzeniu.
 *
 * # Dlaczego to nie zastępuje dwujęzycznych etykiet
 *
 * Reszta aplikacji (patrz `App.tsx`) trzyma się innej, już sprawdzonej zasady:
 * nagłówki i główne akcje ekranów wejścia są dwujęzyczne NARAZ („Załóż konto ·
 * Create account"), bo to jedna decyzja, którą trzeba zrozumieć raz, zanim
 * cokolwiek się wybierze — przełącznik języka nie zdążyłby tam zadziałać.
 *
 * Ten moduł pokrywa inną część ekranu: chrom aplikacji PO zalogowaniu — gałęzie
 * nawigacji, nagłówek listy rozmów, szukanie, puste stany, treść ustawień
 * wyglądu — czyli dokładnie to miejsce w projekcie, gdzie osiadł sam
 * przełącznik. Reszta interfejsu (konto, kopia zapasowa, urządzenia) zostaje
 * po polsku, tak jak dziś — rozszerzanie pokrycia to osobna decyzja, nie efekt
 * uboczny dodania przełącznika.
 */

export type WyborJezyka = "pl" | "en";

const KLUCZ = "mekamb.jezyk";

export interface Slownik {
  rozmowy: string;
  konto: string;
  nowyCzat: string;
  szukaj: string;
  szukajEtykieta: string;
  nicNiePasuje: string;
  nicNiePasujeOpis: string;
  brakRozmow: string;
  brakRozmowOpis: string;
  wybierzRozmowe: string;
  wybierzHint: string;
  tuNicNieMa: string;
  napisz: string;
  pierwsza: string;
  wyglad: string;
  jezykEt: string;
  akcentEt: string;
  akcentOpis: string;
}

const SLOWNIK: Record<WyborJezyka, Slownik> = {
  pl: {
    rozmowy: "Rozmowy",
    konto: "Konto",
    nowyCzat: "Nowy czat",
    szukaj: "Szukaj",
    szukajEtykieta: "Szukaj rozmowy",
    nicNiePasuje: "Nic nie pasuje",
    nicNiePasujeOpis: "Szukamy po nazwie i po ostatniej wiadomości.",
    brakRozmow: "Nie masz jeszcze żadnej rozmowy",
    brakRozmowOpis: "Zacznij od „Nowy czat” — wystarczy nazwa użytkownika.",
    wybierzRozmowe: "Wybierz rozmowę",
    wybierzHint: "Albo zacznij nową — „Nowy czat” wymaga tylko nazwy użytkownika.",
    tuNicNieMa: "Tu jeszcze nic nie ma",
    napisz: "Napisz wiadomość",
    pierwsza: "Napisz pierwszy.",
    wyglad: "Wygląd",
    jezykEt: "Język interfejsu",
    akcentEt: "Kolor akcentu",
    akcentOpis: "Jedna decyzja przemalowuje akcje, dymki i znaczniki.",
  },
  en: {
    rozmowy: "Chats",
    konto: "Account",
    nowyCzat: "New chat",
    szukaj: "Search",
    szukajEtykieta: "Search chats",
    nicNiePasuje: "Nothing matches",
    nicNiePasujeOpis: "We search by name and by the last message.",
    brakRozmow: "You don't have any chats yet",
    brakRozmowOpis: "Start with “New chat” — a username is all it takes.",
    wybierzRozmowe: "Pick a chat",
    wybierzHint: "Or start a new one — “New chat” only needs a username.",
    tuNicNieMa: "Nothing here yet",
    napisz: "Write a message",
    pierwsza: "Write the first one.",
    wyglad: "Appearance",
    jezykEt: "Interface language",
    akcentEt: "Accent colour",
    akcentOpis: "One decision repaints actions, bubbles and badges.",
  },
};

function poprawny(wartosc: string | null): wartosc is WyborJezyka {
  return wartosc === "pl" || wartosc === "en";
}

/** Odczyt wyboru. Cokolwiek innego niż znana wartość znaczy „polski". */
export function wczytajJezyk(magazyn: Pick<Storage, "getItem"> = localStorage): WyborJezyka {
  try {
    const zapisany = magazyn.getItem(KLUCZ);
    return poprawny(zapisany) ? zapisany : "pl";
  } catch {
    // Prywatne okno bez dostępu do magazynu — polski i tyle.
    return "pl";
  }
}

export function zapiszJezyk(
  jezyk: WyborJezyka,
  magazyn: Pick<Storage, "setItem"> = localStorage,
): void {
  try {
    magazyn.setItem(KLUCZ, jezyk);
  } catch {
    // jw. — wybór zadziała do końca sesji i tyle.
  }
}

/** Słownik dla danego wyboru. */
export function slownik(jezyk: WyborJezyka): Slownik {
  return SLOWNIK[jezyk];
}
