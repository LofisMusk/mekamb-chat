import { SELF, env } from "cloudflare:test";
import { describe, expect, it } from "vitest";

import { MAX_ENVELOPE_BYTES } from "../src/env";

/** Skrzynka wchodzi do gry dopiero, gdy dostarczenie bezpośrednie zawiodło. */

function inbox(userId: string) {
  return env.USER_INBOX.get(env.USER_INBOX.idFromName(userId));
}

function koperta(tresc: string): ArrayBuffer {
  return new TextEncoder().encode(tresc).buffer as ArrayBuffer;
}

describe("UserInbox", () => {
  it("nowa skrzynka jest pusta", async () => {
    expect(await inbox("nowy").pendingCount()).toBe(0);
  });

  it("kolejkuje kopertę, gdy nikt nie jest podłączony", async () => {
    const skrzynka = inbox("offline");

    const wynik = await skrzynka.deposit(koperta("szyfrogram"));

    expect(wynik.delivered).toBe("queued");
    expect(await skrzynka.pendingCount()).toBe(1);
  });

  it("zachowuje kolejność wielu kopert", async () => {
    const skrzynka = inbox("wiele");

    for (const i of [1, 2, 3]) {
      await skrzynka.deposit(koperta(`wiadomosc-${i}`));
    }

    expect(await skrzynka.pendingCount()).toBe(3);
  });

  it("odrzuca kopertę przekraczającą limit rozmiaru", async () => {
    // Przez ścieżkę HTTP, a nie przez RPC: strażnik w samym Durable Objekcie
    // rzuca wyjątkiem, a to jest obrona w głąb, nie normalna ścieżka. Realny
    // klient dostaje odpowiedź 413 z Workera i to zachowanie sprawdzamy.
    const odpowiedz = await SELF.fetch("https://mekamb/inbox/za-duza", {
      method: "POST",
      body: new ArrayBuffer(MAX_ENVELOPE_BYTES + 1),
    });

    expect(odpowiedz.status).toBe(413);
    expect(await inbox("za-duza").pendingCount()).toBe(0);
  });

  it("skrzynki różnych użytkowników są od siebie odizolowane", async () => {
    await inbox("alice").deposit(koperta("dla alice"));

    expect(await inbox("alice").pendingCount()).toBe(1);
    expect(await inbox("bob").pendingCount()).toBe(0);
  });

  it("podłączenie przez WebSocket opróżnia kolejkę", async () => {
    const skrzynka = inbox("odbierajacy");
    await skrzynka.deposit(koperta("zalegla-1"));
    await skrzynka.deposit(koperta("zalegla-2"));
    expect(await skrzynka.pendingCount()).toBe(2);

    const odpowiedz = await skrzynka.fetch("https://inbox/connect", {
      headers: { Upgrade: "websocket" },
    });

    expect(odpowiedz.status).toBe(101);
    expect(odpowiedz.webSocket).not.toBeNull();

    // Zaległości poszły w gnieździe, więc kolejka musi być pusta.
    expect(await skrzynka.pendingCount()).toBe(0);
  });

  it("żądanie bez upgrade'u jest odrzucane", async () => {
    const odpowiedz = await inbox("bez-upgrade").fetch("https://inbox/connect");
    expect(odpowiedz.status).toBe(426);
  });
});
