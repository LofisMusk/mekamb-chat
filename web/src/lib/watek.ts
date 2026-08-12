import type { Wiadomosc } from "./historia";

/**
 * Układ wątku: rozdzielacze dni i sklejanie wiadomości w bloki.
 *
 * # Dlaczego to jest czystą funkcją, a nie warunkiem w JSX
 *
 * Bo obie decyzje są o SĄSIEDZTWIE — „czy poprzednia wiadomość była tego
 * samego dnia", „czy pisała ją ta sama osoba w podobnym czasie". Warunek
 * rozsypany po komponencie sięga do `wiadomosci[i - 1]` w kilku miejscach
 * i przy pierwszej zmianie sortowania zaczyna kłamać w jednym z nich.
 *
 * Tutaj przechodzi listę raz i wypisuje gotowy układ, który da się sprawdzić
 * testem bez renderowania czegokolwiek.
 */

/** Ile czasu między wiadomościami tej samej osoby zrywa blok. */
export const PRZERWA_BLOKU_MS = 5 * 60 * 1000;

export type PozycjaWatku =
  | { rodzaj: "dzien"; klucz: string; etykieta: string }
  | { rodzaj: "wiadomosc"; klucz: string; wiadomosc: Wiadomosc; ciag: boolean };

const DATA = new Intl.DateTimeFormat(undefined, { day: "numeric", month: "long" });
const DATA_Z_ROKIEM = new Intl.DateTimeFormat(undefined, {
  day: "numeric",
  month: "long",
  year: "numeric",
});

/** Dzień jako `RRRR-MM-DD` w strefie użytkownika — klucz do porównań. */
function dzien(czas: number): string {
  const d = new Date(czas);
  return `${d.getFullYear()}-${d.getMonth() + 1}-${d.getDate()}`;
}

/**
 * Etykieta rozdzielacza.
 *
 * „Dziś" i „Wczoraj" słowem, nie datą: przy rozmowie sprzed godziny data jest
 * odpowiedzią na pytanie, którego nikt nie zadał. Rok dopisujemy dopiero, gdy
 * wiadomość jest z innego roku — inaczej „14 marca 2026" przy każdej rozmowie
 * z tego tygodnia.
 */
export function etykietaDnia(czas: number, teraz: number): string {
  const dzis = dzien(teraz);
  const wczoraj = dzien(teraz - 24 * 60 * 60 * 1000);
  const kiedy = dzien(czas);

  if (kiedy === dzis) return "Dziś";
  if (kiedy === wczoraj) return "Wczoraj";

  const format = new Date(czas).getFullYear() === new Date(teraz).getFullYear() ? DATA : DATA_Z_ROKIEM;
  return format.format(new Date(czas));
}

/**
 * Układa wątek.
 *
 * Blok zrywa: zmiana dnia, zmiana autora i przerwa dłuższa niż
 * [PRZERWA_BLOKU_MS]. Ostatni warunek jest istotny — bez niego dwie wiadomości
 * tej samej osoby wysłane rano i wieczorem sklejałyby się w jeden dymek, choć
 * dzieli je pół dnia.
 */
export function ulozWatek(wiadomosci: readonly Wiadomosc[], teraz: number): PozycjaWatku[] {
  const uklad: PozycjaWatku[] = [];
  let poprzednia: Wiadomosc | undefined;

  for (const wiadomosc of wiadomosci) {
    const nowyDzien = !poprzednia || dzien(poprzednia.czas) !== dzien(wiadomosc.czas);

    if (nowyDzien) {
      uklad.push({
        rodzaj: "dzien",
        klucz: `dzien-${dzien(wiadomosc.czas)}`,
        etykieta: etykietaDnia(wiadomosc.czas, teraz),
      });
    }

    const ciag =
      !nowyDzien &&
      poprzednia !== undefined &&
      poprzednia.wlasna === wiadomosc.wlasna &&
      poprzednia.autor === wiadomosc.autor &&
      wiadomosc.czas - poprzednia.czas < PRZERWA_BLOKU_MS;

    uklad.push({ rodzaj: "wiadomosc", klucz: wiadomosc.id, wiadomosc, ciag });
    poprzednia = wiadomosc;
  }

  return uklad;
}
