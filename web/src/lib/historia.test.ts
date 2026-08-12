import { beforeEach, describe, expect, it, vi } from "vitest";

import {
  type Wiadomosc,
  kluczRozmowy,
  listaRozmow,
  oznaczPrzeczytane,
  wczytajRozmowe,
  zapiszRozmowe,
} from "./historia";

/** Skarbiec w pamięci — IndexedDB w testach nie ma. */
let dysk: Uint8Array | null = null;

vi.mock("./vault", () => ({
  loadHistory: async () => dysk,
  saveHistory: async (h: Uint8Array) => void (dysk = h),
}));

const GRUPA_A = new Uint8Array([1, 2, 3]);
const GRUPA_B = new Uint8Array([9, 9, 9]);

function wiadomosc(id: string, czas = 1000): Wiadomosc {
  return { id, autor: "ala", tresc: `treść ${id}`, czas, wlasna: false };
}

describe("historia rozmów", () => {
  beforeEach(() => {
    dysk = null;
  });

  it("pusta historia to pusta lista, nie błąd", async () => {
    await expect(wczytajRozmowe(GRUPA_A)).resolves.toEqual([]);
  });

  it("zapisana rozmowa wraca w całości", async () => {
    const wiadomosci = [wiadomosc("a", 1), wiadomosc("b", 2)];
    await zapiszRozmowe(GRUPA_A, "ala", wiadomosci);

    await expect(wczytajRozmowe(GRUPA_A)).resolves.toEqual(wiadomosci);
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
  /// zapisie i jedzie w zrzucie przeniesienia.
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
  /// załącznika po stronie Androida, 4 nie miała stanu wysyłki — więc odczyt
  /// starszego zapisu jest bezstratny, a brakujące pole ma sensowną wartość
  /// domyślną.
  it.each([3, 4])("historia z wersji %i czyta się bez straty", async (wersja) => {
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

    // …i po pierwszym zapisie leży już w bieżącej wersji.
    await zapiszRozmowe(GRUPA_A, "bartek", odczytane);
    expect(JSON.parse(new TextDecoder().decode(dysk!)).wersja).toBe(5);
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
  /// przeniesienie konta między nimi dawało historię nie do odczytania.
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
});
