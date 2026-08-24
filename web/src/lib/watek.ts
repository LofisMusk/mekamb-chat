import type { Wiadomosc } from "./historia";

/**
 * Układ wątku: rozdzielacze czasu i sklejanie wiadomości w bloki.
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

/**
 * Ile ciszy stawia nowy rozdzielacz z godziną.
 *
 * # Dlaczego godzina wyszła z dymka
 *
 * Miała ją KAŻDA wiadomość, w stopce, przy własnej krawędzi. Przy rozmowie
 * pisanej seriami po kilka zdań dawało to kolumnę powtórzonych „21:14, 21:14,
 * 21:15" — informację, o którą nikt nie pytał, płaconą szerokością każdego
 * dymka i drugim wierszem w każdym z nich.
 *
 * Pytanie „o której to było" zadaje się raz na wątek ciszy, a nie raz na
 * zdanie. Rozdzielacz stawiamy więc tam, gdzie rozmowa się urwała: przy
 * zmianie dnia i po godzinie przerwy. Dokładny czas pojedynczej wiadomości
 * zostaje w `title` dymka — nie znika, tylko przestaje zajmować miejsce.
 */
export const PRZERWA_ROZDZIELACZA_MS = 60 * 60 * 1000;

export type PozycjaWatku =
  | { rodzaj: "rozdzielacz"; klucz: string; etykieta: string; czas: number }
  | {
      rodzaj: "wiadomosc";
      klucz: string;
      wiadomosc: Wiadomosc;
      /** Kolejna wiadomość tego samego bloku — ciaśniejszy odstęp nad nią. */
      ciag: boolean;
      /** Ostatnia wiadomość bloku — tylko ona dostaje ogon dymka. */
      ogon: boolean;
      /** Ostatnia własna wiadomość wątku — pod nią stoi stan wysyłki. */
      ostatniaWlasna: boolean;
    };

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
 * Blok zrywa: rozdzielacz, zmiana autora i przerwa dłuższa niż
 * [PRZERWA_BLOKU_MS]. Ostatni warunek jest istotny — bez niego dwie wiadomości
 * tej samej osoby wysłane rano i wieczorem sklejałyby się w jeden dymek, choć
 * dzieli je pół dnia.
 *
 * `ogon` i `ostatniaWlasna` są o tym, co stoi PO wiadomości, więc nie da się
 * ich policzyć w tej samej pętli, co resztę — wypełnia je przebieg wsteczny
 * na końcu. Robienie tego warunkiem w JSX kończyłoby się sięganiem po
 * `uklad[i + 1]` w dwóch miejscach naraz.
 */
export function ulozWatek(wiadomosci: readonly Wiadomosc[], teraz: number): PozycjaWatku[] {
  const uklad: PozycjaWatku[] = [];
  let poprzednia: Wiadomosc | undefined;

  for (const wiadomosc of wiadomosci) {
    const nowyDzien = !poprzednia || dzien(poprzednia.czas) !== dzien(wiadomosc.czas);
    const cisza =
      poprzednia !== undefined && wiadomosc.czas - poprzednia.czas >= PRZERWA_ROZDZIELACZA_MS;

    if (nowyDzien || cisza) {
      uklad.push({
        rodzaj: "rozdzielacz",
        // Godzina w kluczu, bo w jednym dniu rozdzielaczy jest teraz więcej
        // niż jeden — sama data dawałaby duplikaty kluczy Reacta.
        klucz: `rozdzielacz-${wiadomosc.czas}`,
        etykieta: etykietaDnia(wiadomosc.czas, teraz),
        czas: wiadomosc.czas,
      });
    }

    /*
     * Ślad po rozmowie A/V nie należy do żadnego bloku — z żadnej strony.
     *
     * Rysuje się na środku, jak rozdzielacz, więc sklejenie go z sąsiadem
     * zabierało ogon dymkowi stojącemu nad nim: blok kończył się wizualnie
     * na czymś, co nie jest dymkiem, i ostatnie zdanie wyglądało na urwane.
     */
    const ciag =
      !nowyDzien &&
      !cisza &&
      poprzednia !== undefined &&
      !poprzednia.rozmowa &&
      !wiadomosc.rozmowa &&
      poprzednia.wlasna === wiadomosc.wlasna &&
      poprzednia.autor === wiadomosc.autor &&
      wiadomosc.czas - poprzednia.czas < PRZERWA_BLOKU_MS;

    uklad.push({
      rodzaj: "wiadomosc",
      klucz: wiadomosc.id,
      wiadomosc,
      ciag,
      // Wypełniane niżej — tu nie wiadomo jeszcze, co stanie po tej pozycji.
      ogon: true,
      ostatniaWlasna: false,
    });
    poprzednia = wiadomosc;
  }

  /*
   * Ogon ma OSTATNI dymek bloku, nie pierwszy.
   *
   * Ogon jest w tym systemie znakiem „ktoś to powiedział" — postawiony przy
   * każdym dymku serii daje trzy ogony pod rzędem i seria przestaje czytać
   * się jak jedna wypowiedź. Blok kończy się tam, gdzie następna pozycja nie
   * jest już jego ciągiem: przy rozdzielaczu, przy zmianie strony i na końcu
   * listy.
   */
  let znalezionaWlasna = false;

  for (let i = uklad.length - 1; i >= 0; i--) {
    const pozycja = uklad[i];
    if (pozycja?.rodzaj !== "wiadomosc") continue;

    const nastepna = uklad[i + 1];
    pozycja.ogon = nastepna?.rodzaj !== "wiadomosc" || !nastepna.ciag;

    if (!znalezionaWlasna && pozycja.wiadomosc.wlasna && !pozycja.wiadomosc.rozmowa) {
      pozycja.ostatniaWlasna = true;
      znalezionaWlasna = true;
    }
  }

  return uklad;
}
