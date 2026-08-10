import { useEffect, useRef } from "react";

/**
 * Cofanie się między ekranami.
 *
 * # Dlaczego wszystko przechodzi przez historię przeglądarki
 *
 * Wyjść z ekranu można na trzy sposoby: strzałką u góry, gestem przeciągnięcia
 * i systemowym „wstecz" (przycisk na Androidzie, gest krawędziowy w Safari).
 * Trzy drogi obsłużone osobno rozjeżdżają się przy pierwszej zmianie układu
 * ekranów — a rozjazd tutaj znaczy, że przycisk systemowy wyrzuca z aplikacji
 * zamiast wrócić do listy.
 *
 * Dlatego jest jedna droga: **strzałka i gest wołają `history.back()`**, a
 * aplikacja reaguje wyłącznie na `popstate`. Cokolwiek by użytkownik nie
 * zrobił, kod wykonuje się ten sam.
 *
 * # Skąd wpis w historii
 *
 * Ekran, do którego się wchodzi, dokłada wpis przy wejściu — i **nie zdejmuje
 * go** przy zamknięciu inną drogą.
 *
 * Zdejmowanie wyglądało kusząco, bo historia nie rosłaby bez potrzeby. Ale
 * `history.back()` działa asynchronicznie, a `pushState` natychmiast: przy
 * przejściu wprost z jednej rozmowy do drugiej sprzątanie pierwszej zdążyłoby
 * zdjąć wpis **drugiej**, już po jego dołożeniu. Cofnięcie zamykałoby wtedy
 * rozmowę, którą użytkownik przed chwilą otworzył — usterka nie do odtworzenia
 * na życzenie i nie do wytłumaczenia komukolwiek.
 *
 * Ceną jest osierocony wpis, gdy ekran zamknięto z pominięciem cofania (np.
 * przeskokiem do innej gałęzi). Kosztuje jedno „wstecz", po którym nic się nie
 * dzieje. Bezczynne naciśnięcie jest mniejszą szkodą niż zamknięta rozmowa.
 */

/**
 * Gest cofania: przeciągnięcie w prawo, rozpoczęte przy lewej krawędzi.
 *
 * Krawędź jest istotna — bez niej każde przewinięcie listy w bok albo
 * przeciągnięcie zdjęcia cofałoby ekran. Wymóg przewagi poziomej odsiewa
 * przewijanie w pionie, które rzadko jest idealnie pionowe.
 */
export const SZEROKOSC_KRAWEDZI_PX = 32;
export const MINIMALNY_DYSTANS_PX = 64;

export interface Punkt {
  x: number;
  y: number;
}

export function czyGestWstecz(start: Punkt, koniec: Punkt): boolean {
  if (start.x > SZEROKOSC_KRAWEDZI_PX) return false;

  const poziomo = koniec.x - start.x;
  const pionowo = Math.abs(koniec.y - start.y);

  return poziomo >= MINIMALNY_DYSTANS_PX && poziomo > pionowo;
}

/**
 * Włącza cofanie dla otwartego ekranu.
 *
 * `klucz` rozróżnia ekrany: zmiana z jednego na drugi zdejmuje wpis
 * poprzedniego i dokłada wpis nowego, więc w historii leży dokładnie jeden
 * wpis niezależnie od tego, jak głęboko użytkownik zawędrował.
 */
export function useWstecz(aktywne: boolean, wstecz: () => void, klucz: string = ""): void {
  // Akcja przez referencję: gdyby wisiała w zależnościach efektu, każdy render
  // z nową domknięciem przepychałby wpis w historii od nowa.
  const akcja = useRef(wstecz);
  akcja.current = wstecz;

  useEffect(() => {
    if (!aktywne) return;

    history.pushState({ mekamb: klucz }, "");

    let start: Punkt | null = null;

    const naPopstate = () => akcja.current();

    const naDotykStart = (e: TouchEvent) => {
      const dotyk = e.touches[0];
      start = dotyk ? { x: dotyk.clientX, y: dotyk.clientY } : null;
    };

    const naDotykKoniec = (e: TouchEvent) => {
      const dotyk = e.changedTouches[0];
      if (start && dotyk && czyGestWstecz(start, { x: dotyk.clientX, y: dotyk.clientY })) {
        history.back();
      }
      start = null;
    };

    window.addEventListener("popstate", naPopstate);
    window.addEventListener("touchstart", naDotykStart, { passive: true });
    window.addEventListener("touchend", naDotykKoniec, { passive: true });

    return () => {
      window.removeEventListener("popstate", naPopstate);
      window.removeEventListener("touchstart", naDotykStart);
      window.removeEventListener("touchend", naDotykKoniec);
    };
  }, [aktywne, klucz]);
}
