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

/** Wersja formatu. Zmiana układu pól wymaga podniesienia. */
const WERSJA = 1;

interface ZapisanaHistoria {
  wersja: number;
  rozmowy: Record<string, Wiadomosc[]>;
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
  return rozmowa ? rozmowa.map(zZapisu) : [];
}

/**
 * Zapisuje historię jednej rozmowy, nie ruszając pozostałych.
 *
 * Odczyt przed zapisem jest konieczny: dwie rozmowy leżą w jednym rekordzie,
 * więc zapis samej bieżącej skasowałby resztę.
 */
export async function zapiszRozmowe(groupId: Uint8Array, wiadomosci: Wiadomosc[]): Promise<void> {
  const zapis = await wczytajWszystko();

  // Obcinamy od początku — najstarsze idą pierwsze.
  const przyciete = wiadomosci.slice(-LIMIT_WIADOMOSCI);
  zapis.rozmowy[kluczRozmowy(groupId)] = przyciete.map(doZapisu) as Wiadomosc[];

  await saveHistory(new TextEncoder().encode(JSON.stringify(zapis)));
}

/** Lista rozmów, o których cokolwiek wiemy. */
export async function listaRozmow(): Promise<string[]> {
  return Object.keys((await wczytajWszystko()).rozmowy);
}
