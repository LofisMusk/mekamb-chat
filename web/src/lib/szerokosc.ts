import { useSyncExternalStore } from "react";

/**
 * Czy okno spełnia zapytanie `@media` — na żywo, nie raz przy montowaniu.
 *
 * # Kiedy tego używać, a kiedy nie
 *
 * Przełączanie listy i wątku robi arkusz stylów, nie ten hak: tam stan
 * musiałby gonić za każdym obrotem telefonu i gubiłby się po drodze. Hak jest
 * dla miejsc, w których od szerokości zależy RODZAJ komponentu — dialog na
 * środku czy arkusz od dołu, kolumna czy panel wysuwany — a tego CSS nie
 * rozstrzygnie, bo to dwa różne drzewa.
 *
 * `useSyncExternalStore`, a nie `useState` + efekt: pierwsze złożenie dostaje
 * od razu właściwą odpowiedź, bez jednego renderu w złym układzie.
 */
export function useSzerokosc(zapytanie: string): boolean {
  return useSyncExternalStore(
    (powiadom) => {
      if (typeof matchMedia !== "function") return () => {};
      const lista = matchMedia(zapytanie);
      lista.addEventListener("change", powiadom);
      return () => lista.removeEventListener("change", powiadom);
    },
    () => typeof matchMedia === "function" && matchMedia(zapytanie).matches,
    () => false,
  );
}

/** Progi układu ze specyfikacji — jedno miejsce, żeby nie rozjechały się z CSS. */
export const SZEROKI = "(min-width: 48rem)";
export const KOLUMNA_SZCZEGOLOW = "(min-width: 80rem)";
