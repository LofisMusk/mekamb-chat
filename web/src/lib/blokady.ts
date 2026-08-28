import { loadBlocked, saveBlocked } from "./vault";

/**
 * Zablokowani użytkownicy — zapora silniejsza niż prośba o rozmowę.
 *
 * # Czym różni się od próśb
 *
 * Prośba mówi „nie wpuszczaj tej rozmowy między prawdziwe, dopóki jej nie
 * przyjmę". Blokada mówi „nie chcę od tej osoby NICZEGO": jej wiadomości nie
 * dopisują się do żadnej rozmowy, jej zaproszenia (Welcome) nie zakładają nawet
 * prośby, a rozmowy jeden-na-jeden z nią znikają z listy. To decyzja mocniejsza
 * i osobna, więc trzymana osobno.
 *
 * # Dlaczego to jest LOKALNE i egzekwowane po odbiorze
 *
 * Serwer nie może wiedzieć, kogo blokujesz — depozyt do skrzynki nie niesie
 * tożsamości nadawcy (inwariant o tokenach doręczeniowych), więc nie da się mu
 * powiedzieć „odrzucaj od tej osoby". Blokada działa więc na TYM urządzeniu:
 * kopertę i tak odbieramy i odszyfrowujemy (żeby poznać nadawcę z credentiala
 * MLS — jedynego wiarygodnego źródła), ale nadawcę zablokowanego po prostu
 * pomijamy, zamiast pokazywać. Blokujemy po **nazwie użytkownika**, bo to ona
 * jest tożsamością MLS i adresem skrzynki — nie po nicku, który jest tylko
 * warstwą wyświetlania i który każdy może sobie zmienić.
 *
 * # Symetria
 *
 * Jednostronna, jak wszystko lokalne: przestajesz widzieć tę osobę, ale nie da
 * się jej zabronić pisania do skrzynki. Jej koperty nadal przychodzą — są tylko
 * odsiewane, zanim cokolwiek zobaczysz.
 */

/** Wersja formatu zapisu. */
const WERSJA = 1;

interface ZapisanyPlik {
  wersja: number;
  /** Nazwy użytkowników (nie nicki), które są zablokowane. */
  zablokowani: string[];
}

/** Zbiór zablokowanych nazw użytkowników. */
export type StanBlokad = Set<string>;

async function wczytajSurowe(): Promise<StanBlokad> {
  const bajty = await loadBlocked();
  if (!bajty) return new Set();

  try {
    const zapis = JSON.parse(new TextDecoder().decode(bajty)) as ZapisanyPlik;
    if (zapis.wersja !== WERSJA) return new Set();
    return new Set(zapis.zablokowani ?? []);
  } catch {
    return new Set();
  }
}

let kolejka: Promise<unknown> = Promise.resolve();

function zSerializacja<T>(operacja: () => Promise<T>): Promise<T> {
  const wynik = kolejka.then(operacja, operacja);
  kolejka = wynik.catch(() => {});
  return wynik;
}

async function zapisz(stan: StanBlokad): Promise<void> {
  const plik: ZapisanyPlik = { wersja: WERSJA, zablokowani: [...stan] };
  await saveBlocked(new TextEncoder().encode(JSON.stringify(plik)));
}

/** Wczytuje listę blokad — do zasiania interfejsu przy starcie. */
export async function wczytajBlokady(): Promise<StanBlokad> {
  return wczytajSurowe();
}

/** Blokuje użytkownika po nazwie. Zwraca świeży stan. */
export async function zablokuj(username: string): Promise<StanBlokad> {
  return zSerializacja(async () => {
    const stan = await wczytajSurowe();
    stan.add(username);
    await zapisz(stan);
    return stan;
  });
}

/** Odblokowuje użytkownika. Zwraca świeży stan. */
export async function odblokuj(username: string): Promise<StanBlokad> {
  return zSerializacja(async () => {
    const stan = await wczytajSurowe();
    stan.delete(username);
    await zapisz(stan);
    return stan;
  });
}
