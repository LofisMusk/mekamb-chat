/**
 * Wybór motywu — jasny, ciemny albo za systemem.
 *
 * # Dlaczego to nie jest stan Reacta
 *
 * Motyw ustawia atrybut na `<html>`, a nie klasę na komponencie. Arkusz stylów
 * musi go widzieć wyżej niż korzeń aplikacji, bo tło strony i pasek systemowy
 * na iPhonie biorą kolor z `<body>` i z `<meta name="theme-color">` — a jedno
 * i drugie leży poza drzewem Reacta.
 *
 * # Dlaczego wybór „za systemem" nie jest zapisywany jako wynik
 *
 * Zapisujemy `auto`, a nie wyliczoną z niego wartość. Zapisanie wyniku znaczy,
 * że telefon przełączony wieczorem na ciemny zostawia aplikację jasną do końca
 * świata — bo w chwili zapisu system był jeszcze jasny. Wybór użytkownika to
 * „idź za systemem", nie „bądź jasny".
 *
 * # Dlaczego domyślnie jasny, a nie `auto`
 *
 * Bo to zwykły komunikator, nie panel sterowania — telefon (`Nocturne.kt`,
 * wariant „Mekamb Mobile") startuje jasno z tych samych powodów: to jest
 * oczekiwany domyślny wygląd większości komunikatorów, a ciemny motyw
 * dołożyliśmy dla tych, którzy go wolą, nie po to, żeby stał się domyślny na
 * połowie urządzeń. Kto chce iść za systemem, wybiera to jawnie.
 */

/** Co użytkownik wybrał. */
export type WyborMotywu = "ciemny" | "jasny" | "auto";

/** Co faktycznie widać na ekranie. */
export type Motyw = "ciemny" | "jasny";

const KLUCZ = "mekamb.motyw";

/**
 * Nazwa zdarzenia wysyłanego po każdym `zastosuj()`.
 *
 * Akcent (`lib/akcent.ts`) liczy swoje tło z tego, czy motyw jest jasny czy
 * ciemny — więc musi przeliczyć się od nowa za każdym razem, kiedy motyw się
 * zmienia, niezależnie od tego, czy zmianę wywołał klik w przełącznik, czy
 * system. Zdarzenie na dokumencie jest tu prostsze niż odwrotna zależność
 * (ten moduł nie musi nic wiedzieć o istnieniu akcentu).
 */
export const ZDARZENIE_MOTYWU = "mekamb-motyw";

/** Kolor `--tlo` obu motywów. Musi zgadzać się z `styles.css` — patrz test. */
export const TLO: Record<Motyw, string> = {
  ciemny: "#000000",
  jasny: "#ffffff",
};

function poprawny(wartosc: string | null): wartosc is WyborMotywu {
  return wartosc === "ciemny" || wartosc === "jasny" || wartosc === "auto";
}

/** Odczyt wyboru. Cokolwiek innego niż znana wartość znaczy „jasny". */
export function wczytajWybor(magazyn: Pick<Storage, "getItem"> = localStorage): WyborMotywu {
  try {
    const zapisane = magazyn.getItem(KLUCZ);
    return poprawny(zapisane) ? zapisane : "jasny";
  } catch {
    // Prywatne okno bez dostępu do magazynu. Motyw jest ustawieniem
    // kosmetycznym — brak zapisu nie może wywrócić startu aplikacji.
    return "jasny";
  }
}

export function zapiszWybor(wybor: WyborMotywu, magazyn: Pick<Storage, "setItem"> = localStorage) {
  try {
    magazyn.setItem(KLUCZ, wybor);
  } catch {
    // jw. — wybór zadziała do końca sesji i tyle.
  }
}

/**
 * Rozwinięcie wyboru w to, co widać.
 *
 * Osobna, czysta funkcja, bo to jedyne miejsce z decyzją — reszta modułu tylko
 * ją stosuje. Testy sprawdzają właśnie ją.
 */
export function rozwin(wybor: WyborMotywu, systemJasny: boolean): Motyw {
  if (wybor === "auto") return systemJasny ? "jasny" : "ciemny";
  return wybor;
}

/** Czy system prosi o jasny. Wydzielone, bo `matchMedia` nie istnieje w testach. */
export function systemJasny(): boolean {
  return typeof matchMedia === "function" && matchMedia("(prefers-color-scheme: light)").matches;
}

/**
 * Wpisuje motyw do dokumentu.
 *
 * Trzy rzeczy naraz i wszystkie trzy są konieczne:
 *
 * - `data-motyw` — po nim arkusz stylów wybiera paletę;
 * - `color-scheme` — po nim przeglądarka dobiera kolory pól, pasków przewijania
 *   i menu, których arkusz nie dotyka; bez tego w motywie jasnym zostaje ciemny
 *   pasek przewijania;
 * - `theme-color` — pasek systemowy na Androidzie i w PWA na iPhonie. Rozjazd
 *   widać jako ciemną belkę nad jasną aplikacją.
 */
export function zastosuj(motyw: Motyw, dokument: Document = document) {
  dokument.documentElement.dataset.motyw = motyw;
  dokument.documentElement.style.colorScheme = motyw === "jasny" ? "light" : "dark";

  const znacznik = dokument.querySelector('meta[name="theme-color"]');
  znacznik?.setAttribute("content", TLO[motyw]);

  dokument.dispatchEvent(new Event(ZDARZENIE_MOTYWU));
}

/**
 * Włącza motyw i nasłuchuje zmian systemu.
 *
 * Zwraca funkcję odpinającą. Nasłuch jest bezwarunkowy, a nie tylko przy
 * wyborze `auto`: przełączenie wyboru na `auto` przy już zamontowanym nasłuchu
 * ma zadziałać od razu, bez przepinania zdarzeń.
 */
export function pilnujMotywu(dajWybor: () => WyborMotywu): () => void {
  const odswiez = () => zastosuj(rozwin(dajWybor(), systemJasny()));

  odswiez();

  if (typeof matchMedia !== "function") return () => {};

  const zapytanie = matchMedia("(prefers-color-scheme: light)");
  zapytanie.addEventListener("change", odswiez);

  return () => zapytanie.removeEventListener("change", odswiez);
}
