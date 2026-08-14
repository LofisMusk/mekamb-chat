import type { ReceivedAttachment } from "./messenger";
import { type StanWiadomosci, wyzszyStan } from "./potwierdzenia";
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

/**
 * Ślad po rozmowie audio/wideo w wątku.
 *
 * # Dlaczego to jest zapis LOKALNY, a nie wiadomość MLS
 *
 * „Nieodebrana" jest faktem o TYM urządzeniu, nie o rozmowie. Dzwoniący widzi
 * „nikt nie odebrał", odbierający „nie odebrałeś", a trzecie urządzenie tej
 * samej osoby nie widzi nic, bo nic się przy nim nie wydarzyło. Wysyłanie tego
 * kanałem MLS znaczyłoby uzgadnianie czegoś, co z każdej strony wygląda inaczej
 * i z żadnej nie jest nieprawdą.
 *
 * Przy okazji: rozmowa, która się nie zestawiła, nie ma czym wysłać wiadomości
 * — więc „nieodebrana" musiałaby i tak powstać lokalnie.
 */
export interface ZapisRozmowy {
  /** Czy szła z obrazem. Decyduje o ikonie — tej samej co przy dzwonieniu. */
  wideo: boolean;
  /**
   * Ile trwała, w sekundach. Brak znaczy, że nie doszła do skutku.
   *
   * Zero i brak to nie to samo: zero byłoby rozmową odebraną i natychmiast
   * przerwaną, a brak — taką, której nikt nie odebrał.
   */
  sekundy?: number;
  /** Czy to my dzwoniliśmy. Rozstrzyga między „nieodebrana" a „odrzucona". */
  wychodzaca: boolean;
}

/** Wiadomość w postaci pokazywanej użytkownikowi. */
export interface Wiadomosc {
  id: string;
  autor: string;
  tresc: string;
  czas: number;
  wlasna: boolean;
  zalacznik?: ReceivedAttachment;

  /** Obecne, gdy wpis jest śladem po rozmowie, a nie wiadomością. */
  rozmowa?: ZapisRozmowy;

  /**
   * Dokąd doszła własna wiadomość.
   *
   * Brak znaczy „wysłana" — tak wyglądają wszystkie zapisy sprzed wersji 5
   * i tak samo wygląda wiadomość, na którą potwierdzenie jeszcze nie wróciło.
   * Przy cudzych wiadomościach pole nie ma sensu i zostaje puste.
   */
  stan?: StanWiadomosci;
}

/**
 * Ile wiadomości trzymamy na rozmowę.
 *
 * Każdy odczyt i zapis skarbca przechodzi przez szyfrowanie całości —
 * nieograniczona historia zamieniłaby to w rosnący bez końca koszt przy każdej
 * wiadomości. Ten sam zapis niesie potem transfer optyczny przy parowaniu.
 */
const LIMIT_WIADOMOSCI = 500;

/**
 * Wersja formatu.
 *
 * 2 dołożyła nazwę rozmówcy, 3 znacznik przeczytania, 4 załącznik po stronie
 * Androida, 5 stan wysyłki własnej wiadomości, 6 ślad po rozmowie A/V. Każda
 * podnoszona po obu stronach naraz: przy wersji 2 klient Androida dostał nowe
 * pole, ale ZOSTAWIŁ numer 1 —
 * przez chwilę oba klienty deklarowały ten sam numer przy niezgodnych
 * kształtach, więc transfer optyczny historii między nimi dałby historię nie do
 * odczytania. Numer wersji ma odróżniać układy, nie datę zmiany.
 */
const WERSJA = 6;

/**
 * Wersje, które umiemy wczytać.
 *
 * 3 różni się od 4 wyłącznie tym, że Android nie zapisywał wtedy załączników,
 * 4 od 5 brakiem stanu wysyłki, a 5 od 6 brakiem śladu po rozmowie A/V. Każde
 * z tych pól jest opcjonalne, a jego brak jest nieodróżnialny od pustej
 * wartości — „wysłana" i „to nie jest rozmowa". Kształt pozostałych pól jest
 * ten sam, więc odczyt jest bezstratny.
 *
 * Odrzucenie starszego zapisu byłoby tu **skasowaniem historii użytkownika**:
 * `wczytajWszystko` zwraca przy niezgodnym numerze pustkę, a serwer nie ma
 * kopii. Reguła „numer odróżnia układy" zostaje, ale od odrzucania jest
 * niezgodny układ, nie każdy inny numer.
 */
const CZYTANE_WERSJE = new Set([3, 4, 5, WERSJA]);

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
    // Historia z UKŁADU, którego nie znamy, jest odrzucana w całości. Próba
    // odgadnięcia go dałaby rozmowy poprzestawiane w czasie — gorsze niż pusty
    // ekran, bo wygląda na prawdziwe. Wersje z listy czytamy normalnie: różnią
    // się polem, którego brak jest nieodróżnialny od jego pustej wartości.
    if (!CZYTANE_WERSJE.has(zapis.wersja)) return { wersja: WERSJA, rozmowy: {} };
    return { ...zapis, wersja: WERSJA };
  } catch {
    return { wersja: WERSJA, rozmowy: {} };
  }
}

/**
 * Kolejka mutacji historii — jeden rekord, jeden zapis naraz.
 *
 * # Dlaczego to musi być zserializowane
 *
 * Cała historia leży w JEDNYM zaszyfrowanym rekordzie, więc każda zmiana to
 * `wczytaj → zmień → zapisz`, a odczyt i zapis są asynchroniczne (szyfrowanie
 * + IndexedDB). Dwie takie operacje puszczone naraz czytają ten sam stan i
 * zapisują po kolei — a ta, która pisze DRUGA, przywraca to, co przeczytała na
 * starcie, kasując zmianę pierwszej.
 *
 * Tak właśnie znikał znacznik odczytu: wejście do rozmowy odpala z tej samej
 * zmiany `wiadomosci` i `oznaczPrzeczytane`, i `zapiszRozmowe`. Pierwsze
 * podnosiło `przeczytaneDo`, drugie — zachowując `przeczytaneDo` odczytane
 * PRZED tą zmianą — przepisywało je z powrotem na starą wartość. Licznik
 * nieprzeczytanych zostawał na „1" mimo że rozmowa była właśnie otwarta.
 */
let kolejkaHistorii: Promise<unknown> = Promise.resolve();

function zSerializacja<T>(operacja: () => Promise<T>): Promise<T> {
  const wynik = kolejkaHistorii.then(operacja, operacja);
  // Łańcuch nie może się urwać na błędzie jednej mutacji — kolejne muszą
  // wystartować niezależnie od tego, czy poprzednia się powiodła.
  kolejkaHistorii = wynik.catch(() => {});
  return wynik;
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
  /**
   * Nazwa rozmówcy — albo `undefined`, gdy wywołujący jej nie zna.
   *
   * To rozróżnienie jest konieczne, odkąd zapisujemy rozmowy, których nie ma
   * na ekranie: nanoszenie ptaszka albo śladu po rozmowie na wątek otwarty
   * gdzie indziej nie wie, jak ta rozmowa się nazywa. Pusty napis podany
   * zamiast tego KASOWAŁBY nazwę i wiersz na liście zostawał bez imienia —
   * z powodu wyłącznie technicznego, po zdarzeniu, które nazwy nie dotyczyło.
   */
  rozmowca: string | undefined,
  wiadomosci: Wiadomosc[],
): Promise<void> {
  await zSerializacja(async () => {
    const zapis = await wczytajWszystko();
    const klucz = kluczRozmowy(groupId);

    // Obcinamy od początku — najstarsze idą pierwsze.
    const przyciete = wiadomosci.slice(-LIMIT_WIADOMOSCI);
    zapis.rozmowy[klucz] = {
      rozmowca: rozmowca ?? zapis.rozmowy[klucz]?.rozmowca ?? "",
      wiadomosci: przyciete.map(doZapisu) as Wiadomosc[],
      // Zapis nie jest przeczytaniem — znacznik zostaje taki, jaki był.
      przeczytaneDo: zapis.rozmowy[klucz]?.przeczytaneDo,
    };

    await saveHistory(new TextEncoder().encode(JSON.stringify(zapis)));
  });
}

/**
 * Dopisuje jedną wiadomość do rozmowy — atomowo względem innych zapisów.
 *
 * Osobno od [`zapiszRozmowe`], bo tu odczyt i zapis MUSZĄ być jedną operacją:
 * dwie wiadomości, które przyjdą tuż po sobie do wątku spoza ekranu, czytałyby
 * ten sam stan dysku i druga nadpisałaby pierwszą — wiadomość przepadłaby bez
 * śladu. Dedup po identyfikatorze, bo ta sama koperta może dojść dwa razy
 * (ponowne dostarczenie ze skrzynki przy zerwanym połączeniu).
 */
export async function dopiszWiadomosc(
  groupId: Uint8Array,
  rozmowca: string | undefined,
  wiadomosc: Wiadomosc,
): Promise<void> {
  await zSerializacja(async () => {
    const zapis = await wczytajWszystko();
    const klucz = kluczRozmowy(groupId);
    const istniejaca = zapis.rozmowy[klucz];
    const poprzednie = istniejaca ? istniejaca.wiadomosci.map(zZapisu) : [];
    if (poprzednie.some((w) => w.id === wiadomosc.id)) return;

    const wiadomosci = [...poprzednie, wiadomosc].slice(-LIMIT_WIADOMOSCI);
    zapis.rozmowy[klucz] = {
      rozmowca: rozmowca ?? istniejaca?.rozmowca ?? "",
      wiadomosci: wiadomosci.map(doZapisu) as Wiadomosc[],
      // Dopisanie nie jest przeczytaniem — znacznik zostaje taki, jaki był.
      przeczytaneDo: istniejaca?.przeczytaneDo,
    };
    await saveHistory(new TextEncoder().encode(JSON.stringify(zapis)));
  });
}

/**
 * Klucz tożsamości wiadomości przy scalaniu.
 *
 * `id` pochodzi z rdzenia (`sendText` zwraca `message_id`) i jest tym samym
 * po obu stronach rozmowy, więc jako klucz nadaje się idealnie. Zapisy sprzed
 * wersji 5 mają go **pustego** — dla nich zostaje treść, autor i czas. To
 * gorszy klucz: dwie identyczne wiadomości wysłane w tej samej milisekundzie
 * zlałyby się w jedną. Zdarza się to na tyle rzadko, a alternatywa —
 * zdublowanie całej starej historii przy każdym parowaniu — jest na tyle
 * gorsza, że wybór nie jest trudny.
 */
function kluczWiadomosci(w: Wiadomosc): string {
  return w.id ? `id:${w.id}` : `t:${w.autor} ${w.czas} ${w.tresc}`;
}

/** Łączy dwa zapisy tej samej wiadomości. */
function polaczWiadomosci(a: Wiadomosc, b: Wiadomosc): Wiadomosc {
  return {
    ...a,
    // Załącznik mógł nie dojść do jednego z urządzeń.
    zalacznik: a.zalacznik ?? b.zalacznik,
    // Stan idzie tylko w górę: „przeczytane" na telefonie nie ma się cofać
    // do „wysłane" dlatego, że laptop nie dostał jeszcze potwierdzenia.
    stan:
      a.stan && b.stan ? wyzszyStan(a.stan, b.stan) : (a.stan ?? b.stan),
  };
}

/**
 * Scala dwa zbiory wiadomości tej samej rozmowy.
 *
 * # Dlaczego to nie jest „merge" w sensie gita
 *
 * Wiadomości są niezmienne i rozłączne — nie ma konfliktów do rozstrzygania,
 * jest suma zbiorów po identyfikatorze. Cała trudność siedzi w kolejności
 * i w tym, czego scalać NIE wolno.
 *
 * # Kolejność
 *
 * Sortowanie po `(czas, id)`, nie po samym czasie. `czas` to `Date.now()`
 * nadawcy, więc rozjazd zegara laptopa i telefonu realnie miesza kolejność,
 * a przy równych znacznikach potrzebny jest rozstrzygnik, który da **ten sam**
 * wynik po obu stronach — inaczej dwa urządzenia pokazywałyby wątek inaczej
 * po tym samym scaleniu.
 *
 * # Czego nie scalamy
 *
 * Śladów po rozmowach A/V. „Nieodebrana" jest faktem o TYM urządzeniu, nie
 * o rozmowie — uzasadnienie przy [`ZapisRozmowy`]. Wpisy przychodzące z drugiego
 * urządzenia są więc pomijane; własne zostają nietknięte.
 */
export function scalWiadomosci(nasze: Wiadomosc[], obce: Wiadomosc[]): Wiadomosc[] {
  const poKluczu = new Map<string, Wiadomosc>();

  for (const w of nasze) {
    poKluczu.set(kluczWiadomosci(w), w);
  }

  for (const w of obce) {
    if (w.rozmowa) continue;

    const klucz = kluczWiadomosci(w);
    const juz = poKluczu.get(klucz);
    poKluczu.set(klucz, juz ? polaczWiadomosci(juz, w) : w);
  }

  return (
    [...poKluczu.values()]
      .sort((a, b) => a.czas - b.czas || (a.id < b.id ? -1 : a.id > b.id ? 1 : 0))
      // Przycinamy PO scaleniu, nie przed. Odwrotna kolejność gubi wiadomości
      // istniejące tylko po jednej stronie: dwa ogony po 500 dają w sumie
      // więcej niż 500, a obcięcie każdego z osobna wyrzuca to, czego drugie
      // urządzenie nigdy nie widziało.
      .slice(-LIMIT_WIADOMOSCI)
  );
}

/** Ile czego doszło przy scalaniu — do pokazania użytkownikowi. */
export interface WynikScalania {
  rozmow: number;
  wiadomosci: number;
}

/**
 * Wciąga historię z drugiego urządzenia.
 *
 * `surowe` to dokładnie to, co zwraca `loadHistory()` po tamtej stronie —
 * ten sam kształt, ta sama wersja formatu. Przyjmujemy te same numery co przy
 * zwykłym odczycie: układ jest identyczny, więc odrzucenie znanej starszej
 * wersji byłoby skasowaniem historii bez powodu.
 *
 * Zwraca `null`, gdy zrzut jest nieczytelny albo w nieznanym układzie — a nie
 * pusty wynik, bo „nic nie doszło" i „nie dało się odczytać" to dla
 * użytkownika stojącego z dwoma telefonami zupełnie różne komunikaty.
 */
export async function scalHistorie(surowe: Uint8Array): Promise<WynikScalania | null> {
  let obca: ZapisanaHistoria;
  try {
    obca = JSON.parse(new TextDecoder().decode(surowe)) as ZapisanaHistoria;
  } catch {
    return null;
  }

  if (!obca || typeof obca !== "object" || !CZYTANE_WERSJE.has(obca.wersja)) return null;
  if (!obca.rozmowy || typeof obca.rozmowy !== "object") return null;

  const zapis = await wczytajWszystko();
  let rozmow = 0;
  let wiadomosci = 0;

  for (const [klucz, przychodzaca] of Object.entries(obca.rozmowy)) {
    const nasza = zapis.rozmowy[klucz];
    const przed = nasza?.wiadomosci.length ?? 0;

    const scalone = scalWiadomosci(
      (nasza?.wiadomosci ?? []).map(zZapisu),
      (przychodzaca.wiadomosci ?? []).map(zZapisu),
    );

    if (!nasza) rozmow += 1;
    wiadomosci += Math.max(0, scalone.length - przed);

    zapis.rozmowy[klucz] = {
      // Nazwa rozmówcy z naszej strony, jeśli ją mamy: jest tu od dawna
      // i mogła zostać poprawiona ręcznie.
      rozmowca: nasza?.rozmowca || przychodzaca.rozmowca,
      wiadomosci: scalone.map(doZapisu) as Wiadomosc[],
      // Znacznik przeczytania idzie w górę — przeczytane na telefonie ma
      // znaczyć przeczytane, a nie odczytać się z powrotem jako nowe.
      przeczytaneDo: Math.max(nasza?.przeczytaneDo ?? 0, przychodzaca.przeczytaneDo ?? 0) || undefined,
    };
  }

  await saveHistory(new TextEncoder().encode(JSON.stringify(zapis)));
  return { rozmow, wiadomosci };
}

/**
 * Oznacza rozmowę jako przeczytaną do podanej chwili.
 *
 * Wołane, gdy rozmowa jest otwarta na ekranie — czyli wtedy, gdy użytkownik
 * naprawdę na nią patrzy, a nie gdy wiadomość tylko dotarła.
 */
export async function oznaczPrzeczytane(groupId: Uint8Array, doChwili: number): Promise<void> {
  await zSerializacja(async () => {
    const zapis = await wczytajWszystko();
    const rozmowa = zapis.rozmowy[kluczRozmowy(groupId)];
    if (!rozmowa || (rozmowa.przeczytaneDo ?? 0) >= doChwili) return;

    rozmowa.przeczytaneDo = doChwili;
    await saveHistory(new TextEncoder().encode(JSON.stringify(zapis)));
  });
}

/**
 * Usuwa rozmowę z historii tego urządzenia.
 *
 * Kasuje tylko lokalny zapis — grupa MLS i pozostałe urządzenia zostają
 * nietknięte. To celowe: „usuń" znaczy „nie chcę tego widzieć u siebie", a nie
 * „opuść grupę". Wiadomość przysłana po skasowaniu założy wiersz na nowo.
 */
export async function usunRozmowe(groupId: Uint8Array): Promise<void> {
  await zSerializacja(async () => {
    const zapis = await wczytajWszystko();
    const klucz = kluczRozmowy(groupId);
    if (!(klucz in zapis.rozmowy)) return;

    delete zapis.rozmowy[klucz];
    await saveHistory(new TextEncoder().encode(JSON.stringify(zapis)));
  });
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
