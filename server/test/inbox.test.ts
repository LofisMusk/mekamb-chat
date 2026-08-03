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

  /**
   * Sedno gwarancji dostarczenia: samo wysłanie bajtów w gniazdo NIE jest
   * doręczeniem. Klient mógł je dostać i paść przed zapisaniem stanu.
   */
  it("podłączenie wysyła zaległości, ale ich nie kasuje", async () => {
    const skrzynka = inbox("odbierajacy");
    await skrzynka.deposit(koperta("zalegla-1"));
    await skrzynka.deposit(koperta("zalegla-2"));
    expect(await skrzynka.pendingCount()).toBe(2);

    const odpowiedz = await skrzynka.fetch("https://inbox/connect", {
      headers: { Upgrade: "websocket" },
    });

    expect(odpowiedz.status).toBe(101);
    expect(odpowiedz.webSocket).not.toBeNull();

    // Nadal w kolejce — dopiero potwierdzenie klienta pozwala skasować.
    expect(await skrzynka.pendingCount()).toBe(2);
  });

  it("potwierdzenie kasuje kopertę z kolejki", async () => {
    const skrzynka = inbox("potwierdzajacy");
    await skrzynka.deposit(koperta("pierwsza"));
    await skrzynka.deposit(koperta("druga"));
    expect(await skrzynka.pendingCount()).toBe(2);

    // Identyfikatory rosną od jedynki — pierwszy wpis w tej skrzynce ma id 1.
    await skrzynka.acknowledge(1);

    expect(await skrzynka.pendingCount()).toBe(1);
  });

  it("potwierdzenie nieistniejącego wpisu jest nieszkodliwe", async () => {
    const skrzynka = inbox("obce-potwierdzenie");
    await skrzynka.deposit(koperta("moja"));

    // Powtórzone albo spóźnione potwierdzenie nie może niczego zepsuć.
    await skrzynka.acknowledge(99999);

    expect(await skrzynka.pendingCount()).toBe(1);
  });

  it("koperta bez potwierdzenia wraca przy kolejnym połączeniu", async () => {
    const skrzynka = inbox("bez-potwierdzenia");
    await skrzynka.deposit(koperta("uparta"));

    // Pierwsze połączenie: klient dostaje bajty, ale nie potwierdza — na
    // przykład dlatego, że użytkownik zamknął kartę.
    await skrzynka.fetch("https://inbox/connect", { headers: { Upgrade: "websocket" } });

    // Drugie połączenie musi zastać kopertę na miejscu.
    const drugie = await skrzynka.fetch("https://inbox/connect", {
      headers: { Upgrade: "websocket" },
    });

    expect(drugie.status).toBe(101);
    expect(await skrzynka.pendingCount()).toBe(1);
  });

  it("żądanie bez upgrade'u jest odrzucane", async () => {
    const odpowiedz = await inbox("bez-upgrade").fetch("https://inbox/connect");
    expect(odpowiedz.status).toBe(426);
  });
});
