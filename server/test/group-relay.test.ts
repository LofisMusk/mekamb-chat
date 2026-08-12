import { SELF, env } from "cloudflare:test";
import { describe, expect, it } from "vitest";

import { issueToken } from "../src/crypto";

/**
 * Testy `GroupRelay` — gwarancji, dla której ten obiekt w ogóle istnieje.
 *
 * Cała reszta systemu jest P2P. Ta część nie jest, bo commity MLS wymagają
 * jednego autorytatywnego porządku. Jeśli te testy przestaną przechodzić, grupy
 * będą się rozpadać na niezgodne gałęzie.
 */

function relay(groupId: string) {
  return env.GROUP_RELAY.get(env.GROUP_RELAY.idFromName(groupId));
}

/** Skraca wywołania w testach. */
function zglos(grupa: ReturnType<typeof relay>, epoka: number) {
  return grupa.claimEpoch(epoka);
}

describe("GroupRelay", () => {
  it("nowa grupa zaczyna w epoce 0", async () => {
    expect(await relay("nowa").epoch()).toBe(0);
  });

  it("przyjmuje commit zgodny z bieżącą epoką i podnosi ją", async () => {
    const grupa = relay("zgodna");

    const wynik = await zglos(grupa, 0);

    expect(wynik.accepted).toBe(true);
    expect(wynik.epoch).toBe(1);
    expect(await grupa.epoch()).toBe(1);
  });

  it("odrzuca commit na nieaktualnej epoce i zwraca aktualną", async () => {
    const grupa = relay("nieaktualna");
    await zglos(grupa, 0);

    // Drugi klient wciąż myśli, że grupa jest w epoce 0.
    const wynik = await zglos(grupa, 0);

    expect(wynik.accepted).toBe(false);
    expect(wynik.epoch).toBe(1);
    expect(await grupa.epoch()).toBe(1);
  });

  /**
   * Właściwy test wyścigu: dwa commity zgłoszone równolegle na tej samej epoce.
   *
   * Dokładnie jeden musi przejść. Gdyby przeszły oba, grupa miałaby dwie różne
   * historie dla tej samej epoki i część członków nie odszyfrowałaby już nic.
   */
  it("z dwóch równoległych commitów przechodzi dokładnie jeden", async () => {
    const grupa = relay("wyscig");

    const wyniki = await Promise.all([
      zglos(grupa, 0),
      zglos(grupa, 0),
    ]);

    const przyjete = wyniki.filter((w) => w.accepted);
    expect(przyjete).toHaveLength(1);
    expect(await grupa.epoch()).toBe(1);
  });

  it("dziesięć równoległych commitów podnosi epokę dokładnie o jeden", async () => {
    const grupa = relay("zalew");

    const wyniki = await Promise.all(
      Array.from({ length: 10 }, () => zglos(grupa, 0)),
    );

    expect(wyniki.filter((w) => w.accepted)).toHaveLength(1);
    expect(await grupa.epoch()).toBe(1);
  });

  it("po odrzuceniu ponowienie na nowej epoce przechodzi", async () => {
    const grupa = relay("ponowienie");
    await zglos(grupa, 0);

    const odrzucony = await zglos(grupa, 0);
    expect(odrzucony.accepted).toBe(false);

    // Klient przetworzył cudzy commit i ponawia na epoce zwróconej przez relay.
    const ponowiony = await zglos(grupa, odrzucony.epoch);

    expect(ponowiony.accepted).toBe(true);
    expect(ponowiony.epoch).toBe(2);
  });

  it("stan epoki przeżywa między wywołaniami", async () => {
    const grupa = relay("trwalosc");

    for (let i = 0; i < 5; i += 1) {
      const wynik = await zglos(grupa, i);
      expect(wynik.accepted).toBe(true);
    }

    expect(await grupa.epoch()).toBe(5);
  });

  /**
   * Sedno: relay nie wie, kto jest w grupie.
   *
   * Trzymał kiedyś listę członków, bo sam rozsyłał commity — i była to jedyna
   * w systemie struktura mówiąca serwerowi wprost, kto z kim rozmawia. Dziś
   * rozsyła nadawca, a ten obiekt widzi wyłącznie rosnący licznik przy
   * nieprzezroczystym identyfikatorze. Gdyby lista wróciła, wróciłby też wyciek.
   */
  it("nie wystawia składu grupy", async () => {
    const grupa = relay("bez-skladu");
    await zglos(grupa, 0);

    /*
     * `in` ani odczyt właściwości nie zadziałają: uchwyt Durable Object jest
     * proxy i oddaje funkcję dla każdej nazwy. Prawdę mówi dopiero WYWOŁANIE.
     */
    const istnieje = async (nazwa: string) => {
      try {
        // Odczyt właściwości też musi być w środku: dla nieznanej nazwy rzuca
        // już on, a nie dopiero wywołanie.
        await (grupa as unknown as Record<string, () => Promise<unknown>>)[nazwa]?.();
        return true;
      } catch {
        return false;
      }
    };

    expect(await istnieje("members")).toBe(false);
    expect(await istnieje("setMembers")).toBe(false);
  });

  /** Kontrola dla testu wyżej: metoda, która istnieje, wywołuje się bez błędu. */
  it("wystawia zajmowanie epoki", async () => {
    expect(await relay("kontrola-epoki").claimEpoch(0)).toMatchObject({ accepted: true });
  });

  /** Zajęcie epoki nie może niczego dostarczać — commit idzie osobną drogą. */
  it("zajęcie epoki nie wkłada niczego do skrzynek", async () => {
    const grupa = relay("bez-rozsylania");
    await zglos(grupa, 0);

    const skrzynka = env.USER_INBOX.get(env.USER_INBOX.idFromName("nikt-nie-dostaje"));
    expect(await skrzynka.pendingCount()).toBe(0);
  });
});

/**
 * Trasa `POST /groups/:groupId/commit`.
 *
 * Sedno: przez tę trasę nie przechodzi ani commit, ani skład grupy. Serwer
 * zajmuje kolejną epokę i tyle — rozesłanie robi nadawca, który skład i tak
 * zna z drzewa MLS. Wcześniej to było jedyne miejsce, w którym serwer
 * dostawał gotową listę „kto z kim rozmawia".
 */
describe("trasa zajęcia epoki", () => {
  async function zalogowany() {
    const userId = crypto.randomUUID();
    const username = `nadawca-${userId.slice(0, 8)}`;

    await env.DB.prepare(
      "INSERT INTO users (id, username, opaque_record, totp_secret_enc, created_at) VALUES (?, ?, '', '', ?)",
    )
      .bind(userId, username, Date.now())
      .run();

    const bearer = await issueToken(env.TOKEN_SIGNING_KEY, {
      userId,
      deviceId: "test",
      expiresAt: Date.now() + 60_000,
    });

    return { userId, username, bearer };
  }

  it("zajmuje epokę i nie dostarcza niczego do skrzynek", async () => {
    const { userId, username, bearer } = await zalogowany();
    const odbiorca = `odbiorca-${userId.slice(0, 8)}`;

    const odpowiedz = await SELF.fetch(`https://mekamb/groups/${userId.slice(0, 8)}/commit`, {
      method: "POST",
      headers: { Authorization: `Bearer ${bearer}`, "Content-Type": "application/json" },
      body: JSON.stringify({ epoch: 0 }),
    });

    expect(odpowiedz.status).toBe(200);
    await expect(odpowiedz.json()).resolves.toMatchObject({ accepted: true, epoch: 1 });

    // Nikt niczego nie dostał — commit rozsyła nadawca osobnym żądaniem.
    for (const kto of [username, odbiorca]) {
      const skrzynka = env.USER_INBOX.get(env.USER_INBOX.idFromName(kto));
      expect(await skrzynka.pendingCount()).toBe(0);
    }
  });

  it("nieaktualna epoka daje 409 z epoką bieżącą", async () => {
    const { userId, bearer } = await zalogowany();
    const grupa = `konflikt-${userId.slice(0, 8)}`;

    const zajmij = () =>
      SELF.fetch(`https://mekamb/groups/${grupa}/commit`, {
        method: "POST",
        headers: { Authorization: `Bearer ${bearer}`, "Content-Type": "application/json" },
        body: JSON.stringify({ epoch: 0 }),
      });

    expect((await zajmij()).status).toBe(200);

    const drugi = await zajmij();
    expect(drugi.status).toBe(409);
    await expect(drugi.json()).resolves.toMatchObject({ accepted: false, epoch: 1 });
  });
});
