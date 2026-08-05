import type { ReceivedAttachment } from "./messenger";
import { loadHistory, saveHistory } from "./vault";

/**
 * Historia rozmowy na urządzeniu.
 *
 * # Czemu to musiało powstać
 *
 * Wiadomości żyły wyłącznie w stanie komponentu. Każde odświeżenie strony
 * kasowało całą rozmowę — a odświeżenie było jedynym sposobem na odzyskanie
 * zerwanego połączenia, więc jedno psuło drugie i rozmowa stawała się
 * niemożliwa. Naprawa połączenia ([`polaczenie.ts`]) usuwa przyczynę,
 * ale historia i tak musi przeżywać zamknięcie karty.
 *
 * # Czego to nie zmienia
 *
 * Historia zostaje **wyłącznie tutaj**, zaszyfrowana kluczem skarbca. Serwer
 * jej nie ma i nigdy nie będzie miał — utrata wszystkich urządzeń nadal
 * oznacza utratę rozmów. To założenie z pierwszego dnia, nie niedopatrzenie.
 */

/** Wiadomość w postaci pokazywanej użytkownikowi. */
export interface Wiadomosc {
  id: string;
  autor: string;
  tresc: string;
  czas: number;
  wlasna: boolean;
  zalacznik?: ReceivedAttachment;
}

/**
 * Ile wiadomości trzymamy na rozmowę.
 *
 * Zrzut skarbca idzie w całości przy przeniesieniu konta, a każdy odczyt
 * i zapis przechodzi przez szyfrowanie całości — nieograniczona historia
 * zamieniłaby to w rosnący bez końca koszt przy każdej wiadomości.
 */
const LIMIT_WIADOMOSCI = 500;

/**
 * Wersja formatu.
 *
 * 2 dołożyła nazwę rozmówcy, 3 znacznik przeczytania. Każda podnoszona po obu
 * stronach naraz: przy wersji 2 klient Androida dostał nowe pole, ale
 * ZOSTAWIŁ numer 1 — przez chwilę oba klienty deklarowały ten sam numer przy
 * niezgodnych kształtach, więc przeniesienie konta między nimi dałoby historię
 * nie do odczytania. Numer wersji ma odróżniać układy, nie datę zmiany.
 */
const WERSJA = 3;

/**
 * Zapisana rozmowa.
 *
 * Nazwa rozmówcy leży obok wiadomości, bo z samego identyfikatora grupy nie da
 * się jej odtworzyć — a lista rozmów musi wiedzieć, kogo pokazać, zanim
 * cokolwiek odszyfruje.
 */
interface ZapisanaRozmowa {
  rozmowca: string;
  wiadomosci: Wiadomosc[];
  /**
   * Czas ostatniej wiadomości, którą użytkownik widział.
   *
   * Znacznik czasu, a nie identyfikator ostatniej wiadomości: identyfikator
   * przestaje cokolwiek znaczyć, gdy ta wiadomość wypadnie poza limit historii,
   * a czas zostaje porównywalny zawsze.
   */
  przeczytaneDo?: number;
}

interface ZapisanaHistoria {
  wersja: number;
  rozmowy: Record<string, ZapisanaRozmowa>;
}

/** Rozmowa w postaci potrzebnej liście. */
export interface PozycjaListy {
  groupId: Uint8Array;
  rozmowca: string;
  ostatnia?: Wiadomosc;
  /** Ile wiadomości przyszło od ostatniego zajrzenia. Własne się nie liczą. */
  nieprzeczytane: number;
}

/** Identyfikator rozmowy jako tekst — `Uint8Array` nie nadaje się na klucz. */
export function kluczRozmowy(groupId: Uint8Array): string {
  return Array.from(groupId, (b) => b.toString(16).padStart(2, "0")).join("");
}

/**
 * `Uint8Array` przechodzi przez JSON jako obiekt `{"0":12,…}`, co po odczycie
 * daje coś, co wygląda jak tablica i nie jest nią. Klucz załącznika trafiłby
 * wtedy do deszyfrowania w postaci nie do użycia — dlatego zapisujemy je
 * jawnie jako zwykłe tablice liczb.
 */
function doZapisu(w: Wiadomosc): unknown {
  if (!w.zalacznik) return w;

  return {
    ...w,
    zalacznik: {
      ...w.zalacznik,
      key: Array.from(w.zalacznik.key),
      nonce: Array.from(w.zalacznik.nonce),
    },
  };
}

function zZapisu(surowa: unknown): Wiadomosc {
  const w = surowa as Wiadomosc & {
    zalacznik?: Omit<ReceivedAttachment, "key" | "nonce"> & { key: number[]; nonce: number[] };
  };
  if (!w.zalacznik) return w as Wiadomosc;

  return {
    ...w,
    zalacznik: {
      ...w.zalacznik,
      key: Uint8Array.from(w.zalacznik.key),
      nonce: Uint8Array.from(w.zalacznik.nonce),
    },
  };
}

async function wczytajWszystko(): Promise<ZapisanaHistoria> {
  const surowe = await loadHistory();
  if (!surowe) return { wersja: WERSJA, rozmowy: {} };

  try {
    const zapis = JSON.parse(new TextDecoder().decode(surowe)) as ZapisanaHistoria;
    // Historia z innej wersji formatu jest odrzucana w całości. Próba
    // odgadnięcia starego układu dałaby rozmowy poprzestawiane w czasie —
    // gorsze niż pusty ekran, bo wygląda na prawdziwe.
    if (zapis.wersja !== WERSJA) return { wersja: WERSJA, rozmowy: {} };
    return zapis;
  } catch {
    return { wersja: WERSJA, rozmowy: {} };
  }
}

/** Wczytuje historię jednej rozmowy. */
export async function wczytajRozmowe(groupId: Uint8Array): Promise<Wiadomosc[]> {
  const zapis = await wczytajWszystko();
  const rozmowa = zapis.rozmowy[kluczRozmowy(groupId)];
  return rozmowa ? rozmowa.wiadomosci.map(zZapisu) : [];
}

/** Z kim była ta rozmowa. */
export async function rozmowcaRozmowy(groupId: Uint8Array): Promise<string | null> {
  const zapis = await wczytajWszystko();
  return zapis.rozmowy[kluczRozmowy(groupId)]?.rozmowca ?? null;
}

/**
 * Zapisuje historię jednej rozmowy, nie ruszając pozostałych.
 *
 * Odczyt przed zapisem jest konieczny: dwie rozmowy leżą w jednym rekordzie,
 * więc zapis samej bieżącej skasowałby resztę.
 */
export async function zapiszRozmowe(
  groupId: Uint8Array,
  rozmowca: string,
  wiadomosci: Wiadomosc[],
): Promise<void> {
  const zapis = await wczytajWszystko();
  const klucz = kluczRozmowy(groupId);

  // Obcinamy od początku — najstarsze idą pierwsze.
  const przyciete = wiadomosci.slice(-LIMIT_WIADOMOSCI);
  zapis.rozmowy[klucz] = {
    rozmowca,
    wiadomosci: przyciete.map(doZapisu) as Wiadomosc[],
    // Zapis nie jest przeczytaniem — znacznik zostaje taki, jaki był.
    przeczytaneDo: zapis.rozmowy[klucz]?.przeczytaneDo,
  };

  await saveHistory(new TextEncoder().encode(JSON.stringify(zapis)));
}

/**
 * Oznacza rozmowę jako przeczytaną do podanej chwili.
 *
 * Wołane, gdy rozmowa jest otwarta na ekranie — czyli wtedy, gdy użytkownik
 * naprawdę na nią patrzy, a nie gdy wiadomość tylko dotarła.
 */
export async function oznaczPrzeczytane(groupId: Uint8Array, doChwili: number): Promise<void> {
  const zapis = await wczytajWszystko();
  const rozmowa = zapis.rozmowy[kluczRozmowy(groupId)];
  if (!rozmowa || (rozmowa.przeczytaneDo ?? 0) >= doChwili) return;

  rozmowa.przeczytaneDo = doChwili;
  await saveHistory(new TextEncoder().encode(JSON.stringify(zapis)));
}

/** Ile wiadomości czeka nieprzeczytanych we wszystkich rozmowach. */
export async function ileNieprzeczytanych(): Promise<number> {
  return (await listaRozmow()).reduce((suma, p) => suma + p.nieprzeczytane, 0);
}

/**
 * Wszystkie rozmowy, od najświeższej.
 *
 * Kolejność po czasie ostatniej wiadomości, a nie po nazwie: lista ma pokazywać
 * to, do czego wraca się najczęściej.
 */
export async function listaRozmow(): Promise<PozycjaListy[]> {
  const zapis = await wczytajWszystko();

  return Object.entries(zapis.rozmowy)
    .map(([hex, rozmowa]) => {
      const doChwili = rozmowa.przeczytaneDo ?? 0;

      return {
        groupId: zHex(hex),
        rozmowca: rozmowa.rozmowca,
        ostatnia: rozmowa.wiadomosci.length
          ? zZapisu(rozmowa.wiadomosci[rozmowa.wiadomosci.length - 1])
          : undefined,
        // Własne wiadomości się nie liczą — nikt nie ma nieprzeczytanych
        // wiadomości od samego siebie.
        nieprzeczytane: rozmowa.wiadomosci.filter((w) => !w.wlasna && w.czas > doChwili).length,
      };
    })
    .sort((a, b) => (b.ostatnia?.czas ?? 0) - (a.ostatnia?.czas ?? 0));
}

function zHex(hex: string): Uint8Array {
  const bajty = new Uint8Array(hex.length / 2);
  for (let i = 0; i < bajty.length; i++) {
    bajty[i] = parseInt(hex.slice(i * 2, i * 2 + 2), 16);
  }
  return bajty;
}
