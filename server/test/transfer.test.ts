import { SELF, env } from "cloudflare:test";
import { describe, expect, it } from "vitest";

import { issueToken } from "../src/crypto";
import { cleanupExpiredTransfers } from "../src/transfer";

/**
 * Zrzut przeniesienia to **całe konto**: tożsamość urządzenia i stan MLS.
 * Dwie własności decydują o tym, czy da się to bezpiecznie zostawić na
 * serwerze — jednorazowość odbioru i krótkie życie. Obie są tu sprawdzane na
 * prawdziwym magazynie, a nie na atrapie, bo to R2 decyduje, co naprawdę
 * zostaje po skasowaniu.
 */

const ID = "vX3kQ9pLmN2rT7wYbC4dEg";
const INNY_ID = "aB1cD2eF3gH4iJ5kL6mN7o";

async function token(userId = "alicja"): Promise<string> {
  return issueToken(env.TOKEN_SIGNING_KEY, {
    userId,
    deviceId: "test",
    expiresAt: Date.now() + 60_000,
  });
}

/** Kubełek jest w typach opcjonalny, bo produkcja może działać bez R2. */
function magazyn(): R2Bucket {
  if (!env.ATTACHMENTS) throw new Error("testy wymagają kubełka R2");
  return env.ATTACHMENTS;
}

function zrzut(tresc = "udawany-zaszyfrowany-skarbiec"): ArrayBuffer {
  return new TextEncoder().encode(tresc).buffer as ArrayBuffer;
}

async function wyslij(id: string, dane: ArrayBuffer, bearer: string): Promise<Response> {
  return SELF.fetch(`https://mekamb/transfer/${id}`, {
    method: "PUT",
    headers: { Authorization: `Bearer ${bearer}` },
    body: dane,
  });
}

async function odbierz(id: string): Promise<Response> {
  return SELF.fetch(`https://mekamb/transfer/${id}`);
}

describe("przeniesienie konta", () => {
  it("zrzut wraca dokładnie taki, jaki poszedł", async () => {
    const oryginal = zrzut();
    expect((await wyslij(ID, oryginal, await token())).status).toBe(200);

    const odpowiedz = await odbierz(ID);
    expect(odpowiedz.status).toBe(200);
    expect(new Uint8Array(await odpowiedz.arrayBuffer())).toEqual(new Uint8Array(oryginal));
  });

  /// Sedno pierwsze: zrzut ma zniknąć po odczycie. Zostawiony czeka na kogoś
  /// innego, a leży w nim wszystko, czym jest konto.
  it("drugi odbiór nie zwraca już niczego", async () => {
    await wyslij(ID, zrzut(), await token());

    expect((await odbierz(ID)).status).toBe(200);
    expect((await odbierz(ID)).status).toBe(404);

    // I naprawdę zniknął z magazynu, a nie tylko przestał być wydawany.
    expect(await magazyn().get(`transfer/${ID}`)).toBeNull();
  });

  /// Sedno drugie: po czasie zrzut przestaje być wydawany, nawet gdy nikt po
  /// niego nie przyszedł.
  it("zrzut po terminie nie jest wydawany i znika", async () => {
    await magazyn().put(`transfer/${ID}`, zrzut(), {
      customMetadata: { wygasa: String(Date.now() - 1000) },
    });

    expect((await odbierz(ID)).status).toBe(404);
    expect(await magazyn().get(`transfer/${ID}`)).toBeNull();
  });

  /// Zrzut bez daty ważności to zrzut, którego nie umiemy przeterminować —
  /// leżałby bez końca, więc traktujemy go jak przeterminowany.
  it("zrzut bez daty ważności jest odrzucany", async () => {
    await magazyn().put(`transfer/${ID}`, zrzut());

    expect((await odbierz(ID)).status).toBe(404);
  });

  it("wysłanie wymaga uwierzytelnienia", async () => {
    const odpowiedz = await SELF.fetch(`https://mekamb/transfer/${ID}`, {
      method: "PUT",
      body: zrzut(),
    });
    expect(odpowiedz.status).toBe(401);
  });

  /// Odbiór jest celowo bez tokenu: urządzenie docelowe jeszcze nie ma konta.
  it("odbiór działa bez tokenu", async () => {
    await wyslij(ID, zrzut(), await token());
    expect((await odbierz(ID)).status).toBe(200);
  });

  it("nieprawidłowy identyfikator jest odrzucany", async () => {
    for (const zly of ["krotkie", "za-dlugie-za-dlugie-za-dlugie", "ma.kropke.w.srodkuXXXXX"]) {
      expect((await odbierz(zly)).status).toBe(400);
    }
  });

  /// Rozróżnianie „nie ma", „wygasło" i „już odebrane" powiedziałoby
  /// zgadującemu identyfikatory, że trafił w istniejący.
  it("brak, wygaśnięcie i powtórny odbiór dają ten sam komunikat", async () => {
    const brak = await odbierz(INNY_ID);

    await wyslij(ID, zrzut(), await token());
    await odbierz(ID);
    const powtorny = await odbierz(ID);

    expect(await powtorny.json()).toEqual(await brak.json());
  });

  it("pusty zrzut jest odrzucany", async () => {
    const odpowiedz = await wyslij(ID, new ArrayBuffer(0), await token());
    expect(odpowiedz.status).toBe(400);
  });

  /// Odbiór kasuje zrzut sam, więc sprzątanie dotyczy tylko porzuconych.
  it("sprzątanie usuwa porzucone zrzuty i nie rusza świeżych", async () => {
    await magazyn().put(`transfer/${ID}`, zrzut(), {
      customMetadata: { wygasa: String(Date.now() - 1000) },
    });
    await wyslij(INNY_ID, zrzut(), await token());

    expect(await cleanupExpiredTransfers(env)).toBe(1);
    expect(await magazyn().get(`transfer/${ID}`)).toBeNull();
    expect(await magazyn().get(`transfer/${INNY_ID}`)).not.toBeNull();
  });

  /// Zrzut jest jednorazowy — pośrednik, który by go zapamiętał, zostawiłby
  /// kopię konta w cache.
  it("odpowiedź zabrania buforowania", async () => {
    await wyslij(ID, zrzut(), await token());
    const odpowiedz = await odbierz(ID);

    expect(odpowiedz.headers.get("cache-control")).toBe("no-store");
  });
});
