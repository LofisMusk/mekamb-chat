import { beforeEach, describe, expect, it, vi } from "vitest";

import {
  type Wiadomosc,
  dopiszWiadomosc,
  kluczRozmowy,
  listaRozmow,
  oznaczPrzeczytane,
  scalHistorie,
  scalWiadomosci,
  usunRozmowe,
  wczytajRozmowe,
  zapiszRozmowe,
} from "./historia";

/** Skarbiec w pamięci — IndexedDB w testach nie ma. */
let dysk: Uint8Array | null = null;

/**
 * Opóźnienie odczytu i zapisu — 0 w większości testów.
 *
 * Prawdziwy skarbiec szyfruje i pisze do IndexedDB, więc odczyt i zapis TRWAJĄ.
 * Dopiero to opóźnienie odsłania wyścig dwóch mutacji na jednym rekordzie,
 * którego serializacja ma pilnować.
 */
let opoznienie = 0;

vi.mock("./vault", () => ({
  loadHistory: async () => {
    if (opoznienie) await new Promise((r) => setTimeout(r, opoznienie));
    return dysk;
  },
  saveHistory: async (h: Uint8Array) => {
    if (opoznienie) await new Promise((r) => setTimeout(r, opoznienie));
    dysk = h;
  },
}));

const GRUPA_A = new Uint8Array([1, 2, 3]);
const GRUPA_B = new Uint8Array([9, 9, 9]);

function wiadomosc(id: string, czas = 1000): Wiadomosc {
  return { id, autor: "ala", tresc: `treść ${id}`, czas, wlasna: false };
}

describe("historia rozmów", () => {
  beforeEach(() => {
    dysk = null;
    opoznienie = 0;
  });

  it("pusta historia to pusta lista, nie błąd", async () => {
    await expect(wczytajRozmowe(GRUPA_A)).resolves.toEqual([]);
  });

  it("zapisana rozmowa wraca w całości", async () => {
    const wiadomosci = [wiadomosc("a", 1), wiadomosc("b", 2)];
    await zapiszRozmowe(GRUPA_A, "ala", wiadomosci);

    await expect(wczytajRozmowe(GRUPA_A)).resolves.toEqual(wiadomosci);
  });

  /*
   * Sedno: zapis BEZ nazwy nie może jej skasować.
   *
   * Tak zapisujemy rozmowy, których nie ma na ekranie — nanosząc ptaszek
   * albo ślad po rozmowie na wątek otwarty gdzie indziej. Wywołujący nie zna
   * wtedy nazwy i nie ma jak jej poznać. Gdyby brak nazwy znaczył „nazwa
   * pusta", wiersz na liście traciłby imię przy każdym potwierdzeniu odczytu,
   * które przyszło do innej rozmowy niż otwarta — czyli przy większości.
   */
  it("zapis bez nazwy zostawia zapisaną nazwę w spokoju", async () => {
    await zapiszRozmowe(GRUPA_A, "ala", [wiadomosc("a", 1)]);
    await zapiszRozmowe(GRUPA_A, undefined, [wiadomosc("a", 1), wiadomosc("b", 2)]);

    const lista = await listaRozmow();
    expect(lista.find((p) => p.rozmowca === "ala")).toBeDefined();
  });

  /// Sedno: dwie rozmowy leżą w jednym rekordzie, więc zapis jednej nie może
  /// skasować drugiej.
  it("zapis jednej rozmowy nie rusza pozostałych", async () => {
    await zapiszRozmowe(GRUPA_A, "ala", [wiadomosc("a")]);
    await zapiszRozmowe(GRUPA_B, "ala", [wiadomosc("b")]);

    expect(await wczytajRozmowe(GRUPA_A)).toHaveLength(1);
    expect(await wczytajRozmowe(GRUPA_B)).toHaveLength(1);
    expect(await listaRozmow()).toHaveLength(2);
  });

  /// `Uint8Array` przechodzi przez JSON jako obiekt `{"0":12,…}`, który po
  /// odczycie wygląda jak tablica i nią nie jest. Klucz załącznika trafiłby
  /// wtedy do deszyfrowania w postaci nie do użycia — zdjęcia przestałyby się
  /// otwierać po odświeżeniu strony, po cichu.
  it("klucz i nonce załącznika wracają jako Uint8Array", async () => {
    const zZalacznikiem: Wiadomosc = {
      ...wiadomosc("z"),
      zalacznik: {
        blobId: "blob-1",
        key: new Uint8Array(32).fill(7),
        nonce: new Uint8Array(12).fill(3),
        mimeType: "image/png",
        sizeBytes: 1234,
        fileName: "zdjecie.png",
      },
    };

    await zapiszRozmowe(GRUPA_A, "ala", [zZalacznikiem]);
    const odczytana = (await wczytajRozmowe(GRUPA_A))[0]!;

    expect(odczytana.zalacznik?.key).toBeInstanceOf(Uint8Array);
    expect(odczytana.zalacznik?.nonce).toBeInstanceOf(Uint8Array);
    expect(odczytana.zalacznik?.key).toEqual(new Uint8Array(32).fill(7));
    expect(odczytana.zalacznik?.mimeType).toBe("image/png");
  });

  /// Historia rośnie bez końca, a cały rekord jest szyfrowany przy każdym
  /// zapisie i jedzie transferem optycznym przy parowaniu.
  it("najstarsze wiadomości są obcinane", async () => {
    const duzo = Array.from({ length: 900 }, (_, i) => wiadomosc(String(i), i));
    await zapiszRozmowe(GRUPA_A, "ala", duzo);

    const odczytane = await wczytajRozmowe(GRUPA_A);
    expect(odczytane.length).toBeLessThanOrEqual(500);
    // Zostają NOWSZE — obcinamy od początku.
    expect(odczytane[odczytane.length - 1]!.id).toBe("899");
  });

  /// Uszkodzony albo obcy zapis nie może wywrócić ekranu rozmowy.
  it("uszkodzony zapis daje pustą historię zamiast wyjątku", async () => {
    dysk = new TextEncoder().encode("to nie jest JSON");
    await expect(wczytajRozmowe(GRUPA_A)).resolves.toEqual([]);

    dysk = new TextEncoder().encode(JSON.stringify({ wersja: 99, rozmowy: { x: [] } }));
    await expect(wczytajRozmowe(GRUPA_A)).resolves.toEqual([]);
  });

  /// Sedno: podniesienie numeru wersji nie może skasować historii, której nikt
  /// nie ma w kopii. Kolejne wersje różnią się polami DOKŁADANYMI — 3 nie miała
  /// załącznika po stronie Androida, 4 nie miała stanu wysyłki, 5 nie miała
  /// śladu po rozmowie A/V — więc odczyt starszego zapisu jest bezstratny,
  /// a brakujące pole ma sensowną wartość domyślną.
  it.each([3, 4, 5])("historia z wersji %i czyta się bez straty", async (wersja) => {
    const klucz = Array.from(GRUPA_A, (b) => b.toString(16).padStart(2, "0")).join("");
    dysk = new TextEncoder().encode(
      JSON.stringify({
        wersja,
        rozmowy: {
          [klucz]: {
            rozmowca: "bartek",
            wiadomosci: [
              { id: "1", autor: "bartek", tresc: "sprzed migracji", czas: 7, wlasna: false },
            ],
          },
        },
      }),
    );

    const odczytane = await wczytajRozmowe(GRUPA_A);

    expect(odczytane).toHaveLength(1);
    expect(odczytane[0]!.tresc).toBe("sprzed migracji");
    // Brak stanu wysyłki znaczy „wysłana" — interfejs nie ma czego zgadywać.
    expect(odczytane[0]!.stan).toBeUndefined();
    // Brak śladu po rozmowie znaczy „to nie jest rozmowa", nie „rozmowa pusta".
    expect(odczytane[0]!.rozmowa).toBeUndefined();

    // …i po pierwszym zapisie leży już w bieżącej wersji.
    await zapiszRozmowe(GRUPA_A, "bartek", odczytane);
    expect(JSON.parse(new TextDecoder().decode(dysk!)).wersja).toBe(6);
  });

  /// Sedno: ślad po rozmowie musi przeżyć zapis, razem z rozróżnieniem
  /// „nie odebrano" od „trwała zero sekund". Brak czasu trwania i zero to dwa
  /// różne zdarzenia, a JSON zapisany bez tej różnicy zamieniłby nieodebraną
  /// rozmowę w odbytą i natychmiast przerwaną.
  it("ślad po rozmowie przeżywa zapis i odczyt", async () => {
    await zapiszRozmowe(GRUPA_A, "bartek", [
      {
        id: "r1",
        autor: "Ty",
        tresc: "",
        czas: 10,
        wlasna: true,
        rozmowa: { wideo: true, sekundy: 154, wychodzaca: true },
      },
      {
        id: "r2",
        autor: "bartek",
        tresc: "",
        czas: 20,
        wlasna: false,
        rozmowa: { wideo: false, wychodzaca: false },
      },
    ]);

    const odczytane = await wczytajRozmowe(GRUPA_A);

    expect(odczytane[0]!.rozmowa).toEqual({ wideo: true, sekundy: 154, wychodzaca: true });
    // Nieodebrana NIE MA czasu trwania — zero znaczyłoby „odebrana i przerwana".
    expect(odczytane[1]!.rozmowa?.sekundy).toBeUndefined();
    expect(odczytane[1]!.rozmowa?.wychodzaca).toBe(false);
  });

  /// Sedno: stan wysyłki musi przeżyć zapis.
  ///
  /// Ptaszek „przeczytane" liczy się z potwierdzenia, które przychodzi raz.
  /// Gdyby nie trafił na dysk, po odświeżeniu strony wszystkie własne
  /// wiadomości wróciłyby do „wysłano" — a drugie potwierdzenie nie przyjdzie.
  it("stan wysyłki przeżywa zapis i odczyt", async () => {
    await zapiszRozmowe(GRUPA_A, "bartek", [
      { id: "1", autor: "Ty", tresc: "hej", czas: 1, wlasna: true, stan: "przeczytane" },
    ]);

    expect((await wczytajRozmowe(GRUPA_A))[0]!.stan).toBe("przeczytane");
  });

  /// Numer wersji ma odróżniać UKŁADY, nie tylko datę zmiany. Przez chwilę
  /// oba klienty deklarowały wersję 1 przy niezgodnych kształtach, więc
  /// transfer optyczny historii między nimi dawał historię nie do odczytania.
  it("nazwa rozmówcy wraca razem z rozmową", async () => {
    await zapiszRozmowe(GRUPA_A, "bartek", [wiadomosc("a")]);

    const lista = await listaRozmow();
    expect(lista).toHaveLength(1);
    expect(lista[0]!.rozmowca).toBe("bartek");
    expect(lista[0]!.groupId).toEqual(GRUPA_A);
  });

  /// Lista ma pokazywać to, do czego wraca się najczęściej.
  it("rozmowy idą od najświeższej", async () => {
    await zapiszRozmowe(GRUPA_A, "stara", [wiadomosc("a", 100)]);
    await zapiszRozmowe(GRUPA_B, "swieza", [wiadomosc("b", 900)]);

    const lista = await listaRozmow();
    expect(lista.map((p) => p.rozmowca)).toEqual(["swieza", "stara"]);
  });

  /// Sedno licznika: „nie widziałeś tego", a nie „nie dostałeś tego".
  it("nowe wiadomości liczą się jako nieprzeczytane", async () => {
    await zapiszRozmowe(GRUPA_A, "ala", [wiadomosc("a", 100), wiadomosc("b", 200)]);

    expect((await listaRozmow())[0]!.nieprzeczytane).toBe(2);

    await oznaczPrzeczytane(GRUPA_A, 200);
    expect((await listaRozmow())[0]!.nieprzeczytane).toBe(0);
  });

  /// Nikt nie ma nieprzeczytanych wiadomości od samego siebie.
  it("własne wiadomości się nie liczą", async () => {
    const wlasna = { ...wiadomosc("x", 300), wlasna: true };
    await zapiszRozmowe(GRUPA_A, "ala", [wlasna]);

    expect((await listaRozmow())[0]!.nieprzeczytane).toBe(0);
  });

  /// Zapis wiadomości nie jest przeczytaniem — inaczej licznik nigdy by nie
  /// wzrósł, bo każda przychodząca wiadomość kasowałaby własny ślad.
  it("zapis rozmowy nie kasuje znacznika przeczytania", async () => {
    await zapiszRozmowe(GRUPA_A, "ala", [wiadomosc("a", 100)]);
    await oznaczPrzeczytane(GRUPA_A, 100);

    await zapiszRozmowe(GRUPA_A, "ala", [wiadomosc("a", 100), wiadomosc("b", 500)]);

    // Doszła jedna nowa, stara zostaje przeczytana.
    expect((await listaRozmow())[0]!.nieprzeczytane).toBe(1);
  });

  /// Znacznik nie może się cofać: starsza chwila po nowszej znaczyłaby, że
  /// przeczytane wiadomości wracają jako nieprzeczytane.
  it("znacznik przeczytania nie cofa się", async () => {
    await zapiszRozmowe(GRUPA_A, "ala", [wiadomosc("a", 100), wiadomosc("b", 200)]);

    await oznaczPrzeczytane(GRUPA_A, 200);
    await oznaczPrzeczytane(GRUPA_A, 100);

    expect((await listaRozmow())[0]!.nieprzeczytane).toBe(0);
  });

  it("różne rozmowy mają różne klucze", () => {
    expect(kluczRozmowy(GRUPA_A)).not.toBe(kluczRozmowy(GRUPA_B));
    expect(kluczRozmowy(new Uint8Array([0x0a, 0xff]))).toBe("0aff");
  });

  /*
   * Sedno: znacznik odczytu nie może zniknąć pod współbieżnym zapisem.
   *
   * Wejście do rozmowy odpala z tej samej zmiany stanu i `oznaczPrzeczytane`,
   * i `zapiszRozmowe`. Oba czytają rekord, zmieniają i zapisują — a przy
   * prawdziwym, wolnym skarbcu ten, który pisze DRUGI, zachowywał odczytane na
   * starcie stare `przeczytaneDo` i cofał podniesienie pierwszego. Objawem był
   * licznik „1" wiszący przy rozmowie, którą się właśnie otworzyło.
   */
  it("odczyt nie ginie pod równoległym zapisem", async () => {
    await zapiszRozmowe(GRUPA_A, "ala", [wiadomosc("a", 100), wiadomosc("b", 200)]);

    opoznienie = 5;
    // Puszczone RAZEM, bez czekania na pierwsze — dokładnie jak w efektach.
    await Promise.all([
      oznaczPrzeczytane(GRUPA_A, 200),
      zapiszRozmowe(GRUPA_A, "ala", [wiadomosc("a", 100), wiadomosc("b", 200)]),
    ]);
    opoznienie = 0;

    expect((await listaRozmow())[0]!.nieprzeczytane).toBe(0);
  });

  /// Sedno: dwie wiadomości do wątku spoza ekranu nie mogą się nadpisać.
  /// Osobny odczyt-przed-zapisem w każdej z nich czytałby ten sam stan dysku
  /// i druga gubiłaby pierwszą — dlatego dopisywanie jest jedną operacją.
  it("równoległe dopisania do rozmowy nie gubią wiadomości", async () => {
    opoznienie = 5;
    await Promise.all([
      dopiszWiadomosc(GRUPA_A, "ala", wiadomosc("a", 100)),
      dopiszWiadomosc(GRUPA_A, "ala", wiadomosc("b", 200)),
    ]);
    opoznienie = 0;

    const odczytane = await wczytajRozmowe(GRUPA_A);
    expect(odczytane.map((w) => w.id).sort()).toEqual(["a", "b"]);
  });

  /// Ta sama koperta może dojść dwa razy (ponowne dostarczenie ze skrzynki).
  /// Dopisanie po identyfikatorze, który już jest, musi być bez skutku.
  it("dopisanie tej samej wiadomości drugi raz nie dubluje", async () => {
    await dopiszWiadomosc(GRUPA_A, "ala", wiadomosc("a", 100));
    await dopiszWiadomosc(GRUPA_A, "ala", wiadomosc("a", 100));

    expect(await wczytajRozmowe(GRUPA_A)).toHaveLength(1);
  });

  /// Dopisanie do rozmowy spoza ekranu nie jest przeczytaniem — wiersz na
  /// liście ma urosnąć o nieprzeczytaną wiadomość, nawet gdy nikt jej nie ogląda.
  it("dopisana wiadomość liczy się jako nieprzeczytana", async () => {
    await dopiszWiadomosc(GRUPA_A, "ala", wiadomosc("a", 100));

    const lista = await listaRozmow();
    expect(lista[0]!.rozmowca).toBe("ala");
    expect(lista[0]!.nieprzeczytane).toBe(1);
  });

  /// Sedno: usunięcie kasuje TYLKO wskazaną rozmowę, reszta zostaje.
  it("usunięcie rozmowy zdejmuje ją z listy, nie ruszając innych", async () => {
    await zapiszRozmowe(GRUPA_A, "ala", [wiadomosc("a", 100)]);
    await zapiszRozmowe(GRUPA_B, "bartek", [wiadomosc("b", 200)]);

    await usunRozmowe(GRUPA_A);

    const lista = await listaRozmow();
    expect(lista).toHaveLength(1);
    expect(lista[0]!.rozmowca).toBe("bartek");
    expect(await wczytajRozmowe(GRUPA_A)).toEqual([]);
  });

  /// Usunięcie nieistniejącej rozmowy to nie błąd — mogła zniknąć wcześniej.
  it("usunięcie nieistniejącej rozmowy jest bez skutku", async () => {
    await expect(usunRozmowe(GRUPA_A)).resolves.toBeUndefined();
  });
});

/**
 * Scalanie historii z drugiego urządzenia.
 *
 * # Sedno
 *
 * Wiadomości są niezmienne i rozłączne, więc to nie jest „merge" w sensie
 * gita — to suma zbiorów po identyfikatorze. Cała trudność siedzi w kolejności
 * i w tym, czego scalać NIE wolno.
 */
describe("scalanie historii z drugiego urządzenia", () => {
  beforeEach(() => {
    dysk = null;
  });

  function zrzut(rozmowy: Record<string, unknown>, wersja = 6): Uint8Array {
    return new TextEncoder().encode(JSON.stringify({ wersja, rozmowy }));
  }

  it("suma zbiorów, bez duplikatów", () => {
    const nasze = [wiadomosc("a", 1), wiadomosc("b", 2)];
    const obce = [wiadomosc("b", 2), wiadomosc("c", 3)];

    expect(scalWiadomosci(nasze, obce).map((w) => w.id)).toEqual(["a", "b", "c"]);
  });

  /**
   * `czas` to `Date.now()` NADAWCY, więc zegary laptopa i telefonu realnie się
   * rozjeżdżają. Przy równych znacznikach potrzebny jest rozstrzygnik dający
   * ten sam wynik po obu stronach — inaczej dwa urządzenia pokazywałyby wątek
   * inaczej po tym samym scaleniu.
   */
  it("kolejność jest ta sama niezależnie od strony scalania", () => {
    const nasze = [wiadomosc("z", 5), wiadomosc("a", 5)];
    const obce = [wiadomosc("m", 5), wiadomosc("b", 1)];

    const tam = scalWiadomosci(nasze, obce).map((w) => w.id);
    const zpowrotem = scalWiadomosci(obce, nasze).map((w) => w.id);

    expect(tam).toEqual(zpowrotem);
    expect(tam).toEqual(["b", "a", "m", "z"]);
  });

  /**
   * „Nieodebrana" jest faktem o TYM urządzeniu — trzecie urządzenie tej samej
   * osoby nie widzi nic, bo nic się przy nim nie wydarzyło. Przeciąganie tego
   * przez scalanie wpisywałoby do wątku zdarzenia, których na tym telefonie
   * nigdy nie było.
   */
  it("ślady po rozmowach A/V nie przechodzą z drugiego urządzenia", () => {
    const nasze = [wiadomosc("a", 1)];
    const obce = [
      wiadomosc("b", 2),
      { ...wiadomosc("c", 3), rozmowa: { wideo: false, wychodzaca: true } },
    ];

    expect(scalWiadomosci(nasze, obce).map((w) => w.id)).toEqual(["a", "b"]);
  });

  it("własny ślad po rozmowie zostaje nietknięty", () => {
    const nasze = [{ ...wiadomosc("a", 1), rozmowa: { wideo: true, wychodzaca: false } }];

    expect(scalWiadomosci(nasze, [wiadomosc("b", 2)]).map((w) => w.id)).toEqual(["a", "b"]);
  });

  /** Stan idzie tylko w górę — „przeczytane" nie cofa się do „wysłane". */
  it("stan wysyłki bierze dalszy z dwóch", () => {
    const nasze = [{ ...wiadomosc("a", 1), stan: "wyslane" as const }];
    const obce = [{ ...wiadomosc("a", 1), stan: "przeczytane" as const }];

    expect(scalWiadomosci(nasze, obce)[0]?.stan).toBe("przeczytane");
    expect(scalWiadomosci(obce, nasze)[0]?.stan).toBe("przeczytane");
  });

  /**
   * Sedno przycinania: dwa ogony po 500 dają w sumie więcej niż 500. Obcięcie
   * KAŻDEGO Z OSOBNA przed scaleniem wyrzuca wiadomości, które istnieją tylko
   * po jednej stronie — a to jest dokładnie to, po co scalamy.
   */
  it("przycina po scaleniu, nie przed", () => {
    const nasze = Array.from({ length: 400 }, (_, i) => wiadomosc(`n${i}`, 1000 + i));
    const obce = Array.from({ length: 400 }, (_, i) => wiadomosc(`o${i}`, 1000 + i));

    const scalone = scalWiadomosci(nasze, obce);

    expect(scalone).toHaveLength(500);
    // Zostały najnowsze z OBU zbiorów, a nie 500 z jednego.
    expect(scalone.some((w) => w.id.startsWith("n"))).toBe(true);
    expect(scalone.some((w) => w.id.startsWith("o"))).toBe(true);
  });

  /**
   * Zapisy sprzed wersji 5 mają pusty `id`. Bez klucza zastępczego cała stara
   * historia dublowałaby się przy każdym parowaniu.
   */
  it("zapisy bez identyfikatora nie mnożą się", () => {
    const stara = { ...wiadomosc("", 1), tresc: "sprzed wersji 5" };

    expect(scalWiadomosci([stara], [{ ...stara }])).toHaveLength(1);
  });

  it("wciąga rozmowę, której u nas nie było", async () => {
    const wynik = await scalHistorie(
      zrzut({
        [kluczRozmowy(GRUPA_A)]: { rozmowca: "ala", wiadomosci: [wiadomosc("a", 1)] },
      }),
    );

    expect(wynik).toEqual({ rozmow: 1, wiadomosci: 1 });
    await expect(wczytajRozmowe(GRUPA_A)).resolves.toHaveLength(1);
  });

  it("dokłada do rozmowy, którą już mamy", async () => {
    await zapiszRozmowe(GRUPA_A, "ala", [wiadomosc("a", 1)]);

    const wynik = await scalHistorie(
      zrzut({
        [kluczRozmowy(GRUPA_A)]: {
          rozmowca: "ala",
          wiadomosci: [wiadomosc("a", 1), wiadomosc("b", 2)],
        },
      }),
    );

    expect(wynik).toEqual({ rozmow: 0, wiadomosci: 1 });
    await expect(wczytajRozmowe(GRUPA_A)).resolves.toHaveLength(2);
  });

  it("nie rusza rozmów spoza zrzutu", async () => {
    await zapiszRozmowe(GRUPA_B, "bob", [wiadomosc("x", 1)]);

    await scalHistorie(
      zrzut({ [kluczRozmowy(GRUPA_A)]: { rozmowca: "ala", wiadomosci: [wiadomosc("a", 1)] } }),
    );

    await expect(wczytajRozmowe(GRUPA_B)).resolves.toHaveLength(1);
  });

  it("znacznik przeczytania idzie w górę, nigdy w dół", async () => {
    await zapiszRozmowe(GRUPA_A, "ala", [wiadomosc("a", 1)]);
    await oznaczPrzeczytane(GRUPA_A, 5000);

    await scalHistorie(
      zrzut({
        [kluczRozmowy(GRUPA_A)]: {
          rozmowca: "ala",
          wiadomosci: [wiadomosc("a", 1)],
          przeczytaneDo: 100,
        },
      }),
    );

    const lista = await listaRozmow();
    expect(lista[0]?.nieprzeczytane).toBe(0);
  });

  /**
   * „Nic nie doszło" i „nie dało się odczytać" to dla kogoś stojącego z dwoma
   * telefonami zupełnie różne komunikaty — stąd `null`, a nie zerowy wynik.
   */
  it("nieczytelny zrzut daje null, a nie pusty wynik", async () => {
    await expect(scalHistorie(new TextEncoder().encode("to nie jest JSON"))).resolves.toBeNull();
  });

  it("zrzut w nieznanym układzie jest odrzucany", async () => {
    const wynik = await scalHistorie(
      zrzut({ [kluczRozmowy(GRUPA_A)]: { rozmowca: "ala", wiadomosci: [] } }, 99),
    );

    expect(wynik).toBeNull();
  });

  /** Nieudane scalenie nie może skasować tego, co już mamy. */
  it("odrzucony zrzut nie rusza istniejącej historii", async () => {
    await zapiszRozmowe(GRUPA_A, "ala", [wiadomosc("a", 1)]);

    await scalHistorie(new TextEncoder().encode("śmieci"));

    await expect(wczytajRozmowe(GRUPA_A)).resolves.toHaveLength(1);
  });
});
