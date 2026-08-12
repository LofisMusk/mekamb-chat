import type { PozycjaListy } from "./historia";

/**
 * Szukanie na liście rozmów.
 *
 * # Dlaczego szuka się bez ogonków i bez wielkości liter
 *
 * Bo nazwa użytkownika bywa wpisywana z klawiatury, która akurat nie ma
 * polskich znaków, a rozmowa z „Michałem" nie ma się chować przed frazą
 * „michal". Szukanie, które wymaga trafienia w znak diakrytyczny, jest
 * szukaniem, z którego ludzie rezygnują po drugiej próbie.
 *
 * # Dlaczego również po treści ostatniej wiadomości
 *
 * Bo tak się pamięta rozmowy: nie po tym, kto ją prowadził, tylko po tym,
 * co w niej padło. Głębiej nie szukamy — cała historia leży zaszyfrowana
 * w jednym rekordzie i przeszukanie jej znaczyłoby odszyfrowanie wszystkiego
 * przy każdym naciśnięciu klawisza.
 */

/** Napis sprowadzony do postaci, w której porównanie ma sens. */
export function bezOgonkow(tekst: string): string {
  return tekst
    .normalize("NFD")
    // Znaki łączone (ogonki, kreski) mają w Unicode własny zakres — po
    // rozłożeniu wystarczy je usunąć, zamiast wypisywać podmiany litera po
    // literze i zapominać o „ż".
    .replace(/[̀-ͯ]/g, "")
    // „ł" nie rozkłada się na „l" z kreską — jest osobnym znakiem i jako
    // jedyna polska litera wymaga podmiany wprost.
    .replace(/ł/g, "l")
    .replace(/Ł/g, "L")
    .toLowerCase();
}

/**
 * Filtruje listę rozmów frazą.
 *
 * `nazwa` jest podawana z zewnątrz, bo pozycja zapisana przed poprawką nazw
 * ma je puste i wywołujący odtwarza je ze składu MLS — szukanie ma działać
 * po tym, co widać na ekranie, a nie po tym, co leży na dysku.
 */
export function filtrujRozmowy(
  pozycje: readonly PozycjaListy[],
  fraza: string,
  nazwa: (pozycja: PozycjaListy) => string,
): PozycjaListy[] {
  const szukane = bezOgonkow(fraza.trim());
  if (!szukane) return [...pozycje];

  return pozycje.filter((pozycja) => {
    if (bezOgonkow(nazwa(pozycja)).includes(szukane)) return true;

    const ostatnia = pozycja.ostatnia?.tresc;
    return ostatnia ? bezOgonkow(ostatnia).includes(szukane) : false;
  });
}
