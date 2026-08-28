import { kluczRozmowy } from "./historia";
import { loadRequests, saveRequests } from "./vault";

/**
 * Prośby o rozmowę — zapora przed zalewem nieproszonych rozmów.
 *
 * # Reguła
 *
 * Rozmowa przychodząca przez **Welcome** od kogoś, z kim nie mamy jeszcze
 * zaakceptowanej rozmowy (nie jest naszym kontaktem), trafia do PRÓŚB, a nie
 * wprost na listę. Jeśli zaprasza kontakt — wchodzi od razu. Rozmowy, które
 * zakładamy sami, są zaakceptowane z definicji.
 *
 * # Jak to przechowujemy
 *
 * Nie „które są prośbami", tylko „które są ZAAKCEPTOWANE" — zbiór `groupId`
 * (hex). Rozmowa obecna w historii, ale spoza tego zbioru, jest prośbą.
 * Odwrotny zapis (zbiór próśb) wymagałby dopisywania każdej istniejącej
 * rozmowy przy wdrożeniu; ten sam efekt daje jednorazowe zasianie zbioru
 * wszystkimi dotychczasowymi rozmowami (patrz `zainicjuj`), po którym nowa
 * rozmowa spoza zbioru jest zawsze świeżą prośbą.
 *
 * # Dlaczego to jest LOKALNE
 *
 * „Kontakt" jest pojęciem tego urządzenia, nie faktem o grupie MLS. Odrzucenie
 * prośby też jest lokalne: nie ma w rdzeniu drogi na opuszczenie grupy, a nawet
 * gdyby była, „nie chcę tego widzieć" to nie to samo co „wypisz mnie". Odrzucamy
 * więc ukryciem (skasowaniem lokalnej historii — patrz `usunRozmowe`); nadawca
 * może teoretycznie napisać znowu, ale jego pierwsza, nieproszona wiadomość
 * nigdy nie wpada między prawdziwe rozmowy ani nie udaje „nowej wiadomości".
 */

/** Wersja formatu zapisu. */
const WERSJA = 1;

interface ZapisanyPlik {
  wersja: number;
  /** `groupId` (hex) rozmów, które przeszły przez akceptację. */
  zaakceptowane: string[];
  /**
   * Czy zbiór był już raz zasiany dotychczasowymi rozmowami.
   *
   * Bez tego pierwsze uruchomienie z tą funkcją uznałoby WSZYSTKIE istniejące
   * rozmowy za prośby — bo żadnej nie ma jeszcze w zbiorze.
   */
  zainicjowano: boolean;
}

/** Stan próśb w postaci wygodnej dla interfejsu. */
export interface StanProsb {
  /** `groupId` (hex) rozmów zaakceptowanych. */
  zaakceptowane: Set<string>;
  /** Czy zbiór był już zasiany dotychczasowymi rozmowami. */
  zainicjowano: boolean;
}

function pusty(): StanProsb {
  return { zaakceptowane: new Set(), zainicjowano: false };
}

async function wczytajSurowe(): Promise<StanProsb> {
  const bajty = await loadRequests();
  if (!bajty) return pusty();

  try {
    const zapis = JSON.parse(new TextDecoder().decode(bajty)) as ZapisanyPlik;
    if (zapis.wersja !== WERSJA) return pusty();
    return {
      zaakceptowane: new Set(zapis.zaakceptowane ?? []),
      zainicjowano: Boolean(zapis.zainicjowano),
    };
  } catch {
    return pusty();
  }
}

let kolejka: Promise<unknown> = Promise.resolve();

function zSerializacja<T>(operacja: () => Promise<T>): Promise<T> {
  const wynik = kolejka.then(operacja, operacja);
  kolejka = wynik.catch(() => {});
  return wynik;
}

async function zapisz(stan: StanProsb): Promise<void> {
  const plik: ZapisanyPlik = {
    wersja: WERSJA,
    zaakceptowane: [...stan.zaakceptowane],
    zainicjowano: stan.zainicjowano,
  };
  await saveRequests(new TextEncoder().encode(JSON.stringify(plik)));
}

/** Wczytuje stan — do zasiania interfejsu przy starcie. */
export async function wczytajProsby(): Promise<StanProsb> {
  return wczytajSurowe();
}

/**
 * Zasiewa zbiór wszystkimi dotychczasowymi rozmowami — jednorazowo.
 *
 * Uruchamiane raz, przy pierwszym starcie z tą funkcją: bez tego każda rozmowa
 * sprzed wdrożenia próśb wyglądałaby jak prośba. Powtórne wywołanie nic nie
 * robi (`zainicjowano`), więc świeża rozmowa spoza zbioru jest już prawdziwą
 * prośbą.
 */
export async function zainicjuj(idsHex: readonly string[]): Promise<StanProsb> {
  return zSerializacja(async () => {
    const stan = await wczytajSurowe();
    if (stan.zainicjowano) return stan;

    for (const id of idsHex) stan.zaakceptowane.add(id);
    stan.zainicjowano = true;
    await zapisz(stan);
    return stan;
  });
}

/** Oznacza rozmowę jako zaakceptowaną. Zwraca świeży stan. */
export async function zaakceptuj(groupId: Uint8Array): Promise<StanProsb> {
  return zSerializacja(async () => {
    const stan = await wczytajSurowe();
    stan.zaakceptowane.add(kluczRozmowy(groupId));
    await zapisz(stan);
    return stan;
  });
}

/**
 * Zapomina rozmowę ze zbioru zaakceptowanych.
 *
 * Wołane przy usuwaniu rozmowy, żeby po skasowaniu i ewentualnym ponownym
 * założeniu ta sama grupa nie została z „duchem" akceptacji — a przy odrzuceniu
 * prośby, żeby zbiór nie puchł o rozmowy, których już nie ma.
 */
export async function zapomnij(groupId: Uint8Array): Promise<StanProsb> {
  return zSerializacja(async () => {
    const stan = await wczytajSurowe();
    stan.zaakceptowane.delete(kluczRozmowy(groupId));
    await zapisz(stan);
    return stan;
  });
}
