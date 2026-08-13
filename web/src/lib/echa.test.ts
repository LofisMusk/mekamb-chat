import { beforeEach, describe, expect, it } from "vitest";

import { czyWlasna, zapamietaj, zapomnijWszystko } from "./echa";

/**
 * Sedno: wysyłamy także do własnej skrzynki, więc koperta wraca do nadawcy,
 * a MLS nie pozwala przetworzyć własnej wiadomości. Bez rozpoznania echa
 * koperta wisiałaby w kolejce przez trzy połączenia, zanim zostałaby uznana
 * za martwą.
 */

function koperta(tresc: string): Uint8Array {
  return new TextEncoder().encode(tresc);
}

describe("echa własnych kopert", () => {
  beforeEach(() => zapomnijWszystko());

  it("rozpoznaje kopertę, którą sami nadaliśmy", async () => {
    const nasza = koperta("wyslane z laptopa");
    await zapamietaj(nasza);

    expect(await czyWlasna(nasza)).toBe(true);
  });

  it("nie rozpoznaje cudzej koperty", async () => {
    await zapamietaj(koperta("nasza"));

    expect(await czyWlasna(koperta("od rozmowcy"))).toBe(false);
  });

  it("rozpoznaje po zawartości, nie po tożsamości obiektu", async () => {
    // Koperta wraca ze skrzynki jako świeże bajty, nigdy jako ta sama tablica.
    await zapamietaj(koperta("te same bajty"));

    expect(await czyWlasna(koperta("te same bajty"))).toBe(true);
  });

  /**
   * Echo wraca dokładnie raz na urządzenie. Gdyby wpis został, kolejna koperta
   * o identycznej treści zostałaby błędnie uznana za własną i **przepadłaby**
   * bez pokazania.
   */
  it("rozpoznaną kopertę zapomina", async () => {
    const nasza = koperta("jednorazowa");
    await zapamietaj(nasza);

    expect(await czyWlasna(nasza)).toBe(true);
    expect(await czyWlasna(nasza)).toBe(false);
  });

  it("wycinek większego bufora liczy się poprawnie", async () => {
    // Ramka ze skrzynki ma osiem bajtów identyfikatora z przodu, więc koperta
    // jest podtablicą — z niezerowym `byteOffset`.
    const ramka = new Uint8Array([1, 2, 3, 4, 5, 6, 7, 8, 42, 43, 44]);
    const wycinek = ramka.subarray(8);

    await zapamietaj(new Uint8Array([42, 43, 44]));

    expect(await czyWlasna(wycinek)).toBe(true);
  });

  it("zapomnienie wszystkiego czyści pamięć", async () => {
    const nasza = koperta("do zapomnienia");
    await zapamietaj(nasza);

    zapomnijWszystko();

    expect(await czyWlasna(nasza)).toBe(false);
  });
});
