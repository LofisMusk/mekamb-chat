import { kluczRozmowy } from "./historia";
import { loadNames, saveNames } from "./vault";

/**
 * Współdzielone nazwy: nazwa grupy i nick (nazwa wyświetlana) rozmówcy.
 *
 * # Dlaczego to jest WARSTWA WYŚWIETLANIA, a nie tożsamość
 *
 * Tożsamością w drzewie MLS i adresem skrzynki pozostaje `account.userId` —
 * nazwa użytkownika (`kontoZLogowania` w `vault.ts`). Nick i nazwa grupy nigdy
 * nie służą do routingu ani adresowania: koperta trafia pod nazwę użytkownika,
 * a grupa jest identyfikowana `groupId`. Ta mapa mówi wyłącznie, jak to
 * NARYSOWAĆ — surowa nazwa użytkownika zostaje pod spodem.
 *
 * # Skąd się biorą
 *
 * Z wiadomości aplikacyjnej MLS (`MetadataBody` w `proto/chat.proto`), czyli
 * tą samą drogą co każda inna wiadomość — serwer widzi wyłącznie szyfrogram
 * i nigdy nie pozna, jak ktoś nazwał grupę ani siebie. Rdzeń wysyła je przez
 * `sendMetadata`, a odbiera jako `IncomingMessage.metadata`; spina to
 * `messenger.ts`, a przechowuje ten moduł.
 *
 * # Pusty łańcuch znaczy „wyczyszczone"
 *
 * Rdzeń rozróżnia `undefined` („nie zmieniam tego pola") od `""` („czyszczę").
 * U nas czyszczenie to po prostu usunięcie wpisu — brak nicku jest
 * nieodróżnialny od nicku pustego, bo w obu przypadkach pokazujemy surową nazwę
 * użytkownika.
 */
export interface ZapisNazw {
  /** `groupId` (hex) → nazwa grupy. */
  grupy: Record<string, string>;
  /** nazwa użytkownika → nick. */
  nicki: Record<string, string>;
  /** Własny nick — pokazywany w Koncie i rozsyłany do rozmów. */
  mojNick: string;
}

/** Wersja formatu zapisu — na wypadek zmiany kształtu w przyszłości. */
const WERSJA = 1;

interface ZapisanyPlik extends ZapisNazw {
  wersja: number;
}

function pusty(): ZapisNazw {
  return { grupy: {}, nicki: {}, mojNick: "" };
}

async function wczytajSurowe(): Promise<ZapisNazw> {
  const bajty = await loadNames();
  if (!bajty) return pusty();

  try {
    const zapis = JSON.parse(new TextDecoder().decode(bajty)) as ZapisanyPlik;
    if (zapis.wersja !== WERSJA) return pusty();
    return {
      grupy: zapis.grupy ?? {},
      nicki: zapis.nicki ?? {},
      mojNick: zapis.mojNick ?? "",
    };
  } catch {
    return pusty();
  }
}

/**
 * Kolejka mutacji — jeden rekord, jeden zapis naraz.
 *
 * Cały zapis leży w JEDNYM zaszyfrowanym rekordzie, więc każda zmiana to
 * `wczytaj → zmień → zapisz`. Dwie metadane, które przyjdą tuż po sobie,
 * czytałyby ten sam stan i druga nadpisałaby pierwszą — dokładnie ten sam
 * problem, który `historia.ts` rozwiązuje własną kolejką.
 */
let kolejka: Promise<unknown> = Promise.resolve();

function zSerializacja<T>(operacja: () => Promise<T>): Promise<T> {
  const wynik = kolejka.then(operacja, operacja);
  kolejka = wynik.catch(() => {});
  return wynik;
}

async function zapisz(zapis: ZapisNazw): Promise<void> {
  const plik: ZapisanyPlik = { wersja: WERSJA, ...zapis };
  await saveNames(new TextEncoder().encode(JSON.stringify(plik)));
}

/** Wczytuje całość — do zasiania stanu interfejsu przy starcie. */
export async function wczytajNazwy(): Promise<ZapisNazw> {
  return wczytajSurowe();
}

/**
 * Ustawia albo czyści nazwę grupy. Zwraca świeży, pełny zapis.
 *
 * Pusta nazwa kasuje wpis: „bez nazwy" wraca do sklejanych nazw uczestników.
 */
export async function ustawNazweGrupy(
  groupId: Uint8Array,
  nazwa: string | undefined,
): Promise<ZapisNazw> {
  return zSerializacja(async () => {
    const zapis = await wczytajSurowe();
    const klucz = kluczRozmowy(groupId);

    if (nazwa && nazwa.trim()) {
      zapis.grupy[klucz] = nazwa.trim();
    } else {
      delete zapis.grupy[klucz];
    }

    await zapisz(zapis);
    return zapis;
  });
}

/**
 * Ustawia albo czyści nick rozmówcy. Zwraca świeży, pełny zapis.
 *
 * `username` to zawsze SUROWA nazwa użytkownika (tożsamość MLS) — nick jest
 * tylko wartością pod tym kluczem.
 */
export async function ustawNick(
  username: string,
  nick: string | undefined,
): Promise<ZapisNazw> {
  return zSerializacja(async () => {
    const zapis = await wczytajSurowe();

    if (nick && nick.trim()) {
      zapis.nicki[username] = nick.trim();
    } else {
      delete zapis.nicki[username];
    }

    await zapisz(zapis);
    return zapis;
  });
}

/** Zapisuje własny nick — pokazywany w Koncie i rozsyłany do rozmów. */
export async function ustawMojNick(nick: string): Promise<ZapisNazw> {
  return zSerializacja(async () => {
    const zapis = await wczytajSurowe();
    zapis.mojNick = nick.trim();
    await zapisz(zapis);
    return zapis;
  });
}
