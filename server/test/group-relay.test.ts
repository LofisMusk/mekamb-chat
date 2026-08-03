import { env } from "cloudflare:test";
import { describe, expect, it } from "vitest";

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

const COMMIT = new TextEncoder().encode("udawany commit MLS").buffer as ArrayBuffer;

describe("GroupRelay", () => {
  it("nowa grupa zaczyna w epoce 0", async () => {
    expect(await relay("nowa").epoch()).toBe(0);
  });

  it("przyjmuje commit zgodny z bieżącą epoką i podnosi ją", async () => {
    const grupa = relay("zgodna");

    const wynik = await grupa.submitCommit(0, COMMIT);

    expect(wynik.accepted).toBe(true);
    expect(wynik.epoch).toBe(1);
    expect(await grupa.epoch()).toBe(1);
  });

  it("odrzuca commit na nieaktualnej epoce i zwraca aktualną", async () => {
    const grupa = relay("nieaktualna");
    await grupa.submitCommit(0, COMMIT);

    // Drugi klient wciąż myśli, że grupa jest w epoce 0.
    const wynik = await grupa.submitCommit(0, COMMIT);

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
      grupa.submitCommit(0, COMMIT),
      grupa.submitCommit(0, COMMIT),
    ]);

    const przyjete = wyniki.filter((w) => w.accepted);
    expect(przyjete).toHaveLength(1);
    expect(await grupa.epoch()).toBe(1);
  });

  it("dziesięć równoległych commitów podnosi epokę dokładnie o jeden", async () => {
    const grupa = relay("zalew");

    const wyniki = await Promise.all(
      Array.from({ length: 10 }, () => grupa.submitCommit(0, COMMIT)),
    );

    expect(wyniki.filter((w) => w.accepted)).toHaveLength(1);
    expect(await grupa.epoch()).toBe(1);
  });

  it("po odrzuceniu ponowienie na nowej epoce przechodzi", async () => {
    const grupa = relay("ponowienie");
    await grupa.submitCommit(0, COMMIT);

    const odrzucony = await grupa.submitCommit(0, COMMIT);
    expect(odrzucony.accepted).toBe(false);

    // Klient przetworzył cudzy commit i ponawia na epoce zwróconej przez relay.
    const ponowiony = await grupa.submitCommit(odrzucony.epoch, COMMIT);

    expect(ponowiony.accepted).toBe(true);
    expect(ponowiony.epoch).toBe(2);
  });

  it("stan epoki przeżywa między wywołaniami", async () => {
    const grupa = relay("trwalosc");

    for (let i = 0; i < 5; i += 1) {
      const wynik = await grupa.submitCommit(i, COMMIT);
      expect(wynik.accepted).toBe(true);
    }

    expect(await grupa.epoch()).toBe(5);
  });

  it("commity trafiają do skrzynek członków grupy", async () => {
    const grupa = relay("rozsylanie");
    await grupa.setMembers(["alice", "bob"]);

    await grupa.submitCommit(0, COMMIT);

    for (const userId of ["alice", "bob"]) {
      const skrzynka = env.USER_INBOX.get(env.USER_INBOX.idFromName(userId));
      expect(await skrzynka.pendingCount()).toBe(1);
    }
  });
});
