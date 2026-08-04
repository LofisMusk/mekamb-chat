import { beforeEach, describe, expect, it, vi } from "vitest";

import { odbierzPrzeniesienie, przygotujPrzeniesienie } from "./przeniesienie";
import type { Account } from "./vault";

vi.mock("./api", () => ({ API_URL: "https://serwer.test" }));

const KONTO: Account = { userId: "u-1", username: "alicja", deviceId: "web-abcd1234" };
const ZIARNO = new Uint8Array(32).fill(7);
const STAN = new TextEncoder().encode("UDAWANY-STAN-MLS-".repeat(20));
const HISTORIA = new TextEncoder().encode(
  JSON.stringify({ wersja: 1, rozmowy: { ab12: [{ tresc: "TAJNA-TRESC-ROZMOWY" }] } }),
);

/** Skarbiec w pamięci — podmieniany, bo IndexedDB w testach nie ma. */
const skarbiec = {
  konto: null as Account | null,
  ziarno: null as Uint8Array | null,
  stan: null as Uint8Array | null,
  historia: null as Uint8Array | null,
};

vi.mock("./vault", () => ({
  loadAccount: async () => skarbiec.konto,
  loadSeed: async () => skarbiec.ziarno,
  loadState: async () => skarbiec.stan,
  saveAccount: async (k: Account) => void (skarbiec.konto = k),
  saveSeed: async (z: Uint8Array) => void (skarbiec.ziarno = z),
  saveState: async (s: Uint8Array) => void (skarbiec.stan = s),
  loadHistory: async () => skarbiec.historia,
  saveHistory: async (h: Uint8Array) => void (skarbiec.historia = h),
}));

/** Udawany serwer: pamięta ładunki i pozwala zajrzeć, co dostał. */
const serwer = new Map<string, Uint8Array>();

/** Czy zrzut został już odebrany — endpoint jest jednorazowy. */
const odebrane = new Set<string>();

function podepnijFetch() {
  vi.stubGlobal("fetch", async (url: string, opcje?: RequestInit) => {
    const id = url.split("/transfer/")[1] ?? "";

    if (opcje?.method === "PUT") {
      serwer.set(id, new Uint8Array(opcje.body as ArrayBuffer));
      return new Response(JSON.stringify({ ok: true, wygasaZa: 900 }), { status: 200 });
    }

    const ladunek = serwer.get(id);
    if (!ladunek || odebrane.has(id)) return new Response("brak", { status: 404 });
    odebrane.add(id);
    return new Response(ladunek.buffer as ArrayBuffer, { status: 200 });
  });
}

describe("przeniesienie konta", () => {
  beforeEach(() => {
    serwer.clear();
    odebrane.clear();
    skarbiec.konto = KONTO;
    skarbiec.ziarno = ZIARNO;
    skarbiec.stan = STAN;
    skarbiec.historia = HISTORIA;
    podepnijFetch();
  });

  it("konto wraca w całości na drugim urządzeniu", async () => {
    const { tresc } = await przygotujPrzeniesienie("token");

    // Urządzenie docelowe zaczyna od pustego skarbca.
    skarbiec.konto = null;
    skarbiec.ziarno = null;
    skarbiec.stan = null;
    skarbiec.historia = null;

    const odebraneKonto = await odbierzPrzeniesienie(tresc);

    expect(odebraneKonto).toEqual(KONTO);
    expect(skarbiec.konto).toEqual(KONTO);
    expect(skarbiec.ziarno).toEqual(ZIARNO);
    expect(skarbiec.stan).toEqual(STAN);
    expect(skarbiec.historia).toEqual(HISTORIA);
  });

  /// Konto bez rozmów to normalna sytuacja, nie błąd.
  it("brak historii nie blokuje przeniesienia", async () => {
    skarbiec.historia = null;
    const { tresc } = await przygotujPrzeniesienie("token");

    skarbiec.konto = null;
    await expect(odbierzPrzeniesienie(tresc)).resolves.toEqual(KONTO);
  });

  /// Sedno całej konstrukcji: serwer przechowuje zrzut, więc nie może w nim
  /// być niczego czytelnego. Gdyby było, przeniesienie oddawałoby konto temu,
  /// przed kim cała aplikacja ma bronić.
  it("serwer nie dostaje niczego czytelnego", async () => {
    await przygotujPrzeniesienie("token");

    const ladunek = serwer.values().next().value;
    expect(ladunek).toBeDefined();

    const jakoTekst = new TextDecoder().decode(ladunek);
    expect(jakoTekst).not.toContain("alicja");
    expect(jakoTekst).not.toContain("web-abcd1234");
    expect(jakoTekst).not.toContain("UDAWANY-STAN-MLS");
    expect(jakoTekst).not.toContain("TAJNA-TRESC-ROZMOWY");

    // Bajtowo też — nazwa użytkownika mogła trafić tam w innym kodowaniu.
    const igla = new TextEncoder().encode("alicja");
    const znaleziona = [...(ladunek ?? [])].some((_, i) =>
      igla.every((bajt, j) => ladunek?.[i + j] === bajt),
    );
    expect(znaleziona, "nazwa użytkownika znaleziona w zrzucie").toBe(false);
  });

  /// Klucz jest w kodzie QR, nie na serwerze. Bez kodu zrzut ma być bezużyteczny.
  it("obcy klucz nie odszyfruje zrzutu", async () => {
    const { tresc } = await przygotujPrzeniesienie("token");
    const podmieniony = tresc.replace(/k=[^&]+/, `k=${"A".repeat(43)}`);

    await expect(odbierzPrzeniesienie(podmieniony)).rejects.toThrow();
  });

  it("naruszony zrzut jest odrzucany", async () => {
    const { tresc } = await przygotujPrzeniesienie("token");

    const wpis = [...serwer.entries()][0];
    if (!wpis) throw new Error("serwer nie dostał zrzutu");
    const [id, ladunek] = wpis;
    ladunek[ladunek.length - 1] = (ladunek[ladunek.length - 1] ?? 0) ^ 0x01;
    serwer.set(id, ladunek);

    await expect(odbierzPrzeniesienie(tresc)).rejects.toThrow();
  });

  /// Zrzut to całe konto, więc okno na jego przechwycenie ma być jak najkrótsze.
  it("drugi odbiór tego samego kodu nie przechodzi", async () => {
    const { tresc } = await przygotujPrzeniesienie("token");

    await odbierzPrzeniesienie(tresc);
    await expect(odbierzPrzeniesienie(tresc)).rejects.toThrow(/wygasł albo został już użyty/);
  });

  it("cudzy kod nie jest przyjmowany", async () => {
    for (const zly of ["", "https://example.com", "mekamb://cos-innego?i=a&k=b", "mekamb://transfer?i=tylkoid"]) {
      await expect(odbierzPrzeniesienie(zly)).rejects.toThrow();
    }
  });

  it("niepełne konto nie da się przenieść", async () => {
    skarbiec.stan = null;
    await expect(przygotujPrzeniesienie("token")).rejects.toThrow(/pełnego konta/);
  });

  /// Dwa przeniesienia nie mogą dać tego samego klucza ani identyfikatora —
  /// inaczej jeden podejrzany kod otwierałby też następne.
  it("każde przeniesienie ma własny klucz i identyfikator", async () => {
    const a = await przygotujPrzeniesienie("token");
    const b = await przygotujPrzeniesienie("token");

    expect(a.tresc).not.toBe(b.tresc);
    expect(new URL(a.tresc).searchParams.get("k")).not.toBe(
      new URL(b.tresc).searchParams.get("k"),
    );
  });
});
