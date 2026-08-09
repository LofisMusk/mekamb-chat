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

const COMMIT = new TextEncoder().encode("udawana koperta z commitem").buffer as ArrayBuffer;
// Nazwy są unikalne per test: skrzynki Durable Objects zachowują stan
// w obrębie pliku, więc współdzielony odbiorca zliczałby koperty ze wszystkich
// wcześniejszych przypadków.
const CZLONKOWIE = ["nadawca-wspolny", "odbiorca-wspolny"];
const NADAWCA = "nadawca-wspolny";

/** Skraca wywołania w testach — sygnatura relaya ma cztery argumenty. */
function zglos(grupa: ReturnType<typeof relay>, epoka: number) {
  return grupa.submitCommit(epoka, COMMIT, CZLONKOWIE, NADAWCA);
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

  it("commit trafia do pozostałych członków, z pominięciem nadawcy", async () => {
    const grupa = relay("rozsylanie");

    await grupa.submitCommit(0, COMMIT, ["fan-a", "fan-b", "fan-c"], "fan-a");

    // Nadawca scalił commit u siebie, a przetworzenie własnego commitu w MLS
    // kończy się błędem — dostarczanie mu go byłoby szkodliwe.
    const nadawca = env.USER_INBOX.get(env.USER_INBOX.idFromName("fan-a"));
    expect(await nadawca.pendingCount()).toBe(0);

    for (const userId of ["fan-b", "fan-c"]) {
      const skrzynka = env.USER_INBOX.get(env.USER_INBOX.idFromName(userId));
      expect(await skrzynka.pendingCount()).toBe(1);
    }
  });

  it("odrzucony commit nie zmienia składu grupy", async () => {
    const grupa = relay("sklad-po-odrzuceniu");
    await grupa.submitCommit(0, COMMIT, ["sklad-a", "sklad-b"], "sklad-a");

    // Druga próba na nieaktualnej epoce, z zupełnie innym składem.
    const odrzucony = await grupa.submitCommit(0, COMMIT, ["mallory"], "mallory");

    expect(odrzucony.accepted).toBe(false);
    expect(await grupa.members()).toEqual(["sklad-a", "sklad-b"]);
  });
});

/**
 * Trasa `POST /groups/:groupId/commit` — styk tokenu z routingiem.
 *
 * Sedno: relay rozpoznaje nadawcę, porównując go z listą członków, a ta jest
 * listą NAZW użytkowników. Token niesie wewnętrzny UUID konta, więc trasa musi
 * go przetłumaczyć. Bez tego nadawca nie zgadza się z żadnym członkiem
 * i dostaje z powrotem własny commit — a własnego commitu MLS nie potrafi
 * przetworzyć, więc koperta krąży po kolejce aż do odrzucenia.
 */
describe("trasa commitu a tożsamość nadawcy", () => {
  it("nie odsyła nadawcy jego własnego commitu", async () => {
    const userId = crypto.randomUUID();
    const username = `nadawca-${userId.slice(0, 8)}`;
    const odbiorca = `odbiorca-${userId.slice(0, 8)}`;

    await env.DB.prepare(
      "INSERT INTO users (id, username, opaque_record, totp_secret_enc, created_at) VALUES (?, ?, '', '', ?)",
    )
      .bind(userId, username, Date.now())
      .run();

    // Token niesie UUID — dokładnie tak, jak po prawdziwym zalogowaniu.
    const bearer = await issueToken(env.TOKEN_SIGNING_KEY, {
      userId,
      deviceId: "test",
      expiresAt: Date.now() + 60_000,
    });

    const odpowiedz = await SELF.fetch(`https://mekamb/groups/${userId.slice(0, 8)}/commit`, {
      method: "POST",
      headers: { Authorization: `Bearer ${bearer}`, "Content-Type": "application/json" },
      body: JSON.stringify({
        epoch: 0,
        envelope: btoa("udawana koperta z commitem"),
        members: [username, odbiorca],
      }),
    });

    expect(odpowiedz.status).toBe(200);

    const wlasna = env.USER_INBOX.get(env.USER_INBOX.idFromName(username));
    const cudza = env.USER_INBOX.get(env.USER_INBOX.idFromName(odbiorca));

    expect(await wlasna.pendingCount()).toBe(0);
    expect(await cudza.pendingCount()).toBe(1);
  });
});
