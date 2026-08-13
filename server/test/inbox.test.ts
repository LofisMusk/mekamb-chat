import { SELF, env } from "cloudflare:test";
import { describe, expect, it } from "vitest";

import { issueToken } from "../src/crypto";
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

  it("potwierdzenie przestaje wysyłać kopertę TEMU urządzeniu", async () => {
    const skrzynka = inbox("potwierdzajacy");
    await skrzynka.deposit(koperta("pierwsza"));
    await skrzynka.deposit(koperta("druga"));
    expect(await skrzynka.pendingCountFor("telefon")).toBe(2);

    // Identyfikatory rosną od jedynki — pierwszy wpis w tej skrzynce ma id 1.
    await skrzynka.acknowledge(1, "telefon");

    // Dla tego urządzenia zostaje jedna. Sam dziennik nadal trzyma obie —
    // kasuje je dopiero retencja, bo inne urządzenia mogą ich jeszcze nie mieć.
    expect(await skrzynka.pendingCountFor("telefon")).toBe(1);
    expect(await skrzynka.pendingCount()).toBe(2);
  });

  /**
   * Sedno naprawy wielu urządzeń: potwierdzenie JEDNEGO urządzenia nie może
   * zabrać koperty pozostałym. Wcześniej kolejka kasowała ją po pierwszym
   * `ack`, więc kto przetworzył ją pierwszy, kasował ją reszcie konta — a że
   * tą samą drogą idą `welcome` i commity MLS, urządzenie, które kopertę
   * straciło, nigdy nie wchodziło do grupy. „On widzi moją wiadomość, ja jego
   * odpowiedzi już nie" brało się dokładnie stąd.
   */
  it("potwierdzenie jednego urządzenia nie ukrywa koperty przed drugim", async () => {
    const skrzynka = inbox("dwa-urzadzenia");
    await skrzynka.deposit(koperta("welcome"));
    await skrzynka.deposit(koperta("wiadomosc"));

    // Telefon odbiera i potwierdza obie.
    await skrzynka.acknowledge(1, "telefon");
    await skrzynka.acknowledge(2, "telefon");
    expect(await skrzynka.pendingCountFor("telefon")).toBe(0);

    // Laptop tego samego konta wciąż ma do odebrania obie — nietknięte.
    expect(await skrzynka.pendingCountFor("laptop")).toBe(2);
  });

  it("potwierdzenie nieistniejącego wpisu jest nieszkodliwe", async () => {
    const skrzynka = inbox("obce-potwierdzenie");
    await skrzynka.deposit(koperta("moja"));

    // Powtórzone albo spóźnione potwierdzenie nie może niczego zepsuć.
    await skrzynka.acknowledge(99999, "telefon");

    expect(await skrzynka.pendingCount()).toBe(1);
    expect(await skrzynka.pendingCountFor("telefon")).toBe(1);
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

/**
 * Trasa `GET /inbox/:userId/connect` — kto ma prawo czytać skrzynkę.
 *
 * # Sedno
 *
 * Ta trasa nie miała żadnego uwierzytelnienia. Jedynym globalnym middleware
 * jest CORS, a CORS nie jest kontrolą dostępu — nie dotyczy `curl`-a ani
 * klienta natywnego. Ktokolwiek znał nazwę użytkownika, mógł podłączyć się do
 * cudzej skrzynki, odebrać zaległe koperty i wysłać `ack:<id>`, KASUJĄC je
 * z kolejki, zanim dotarły do właściciela.
 *
 * Wiadomość przepadała bez śladu, a nadawca nie widział błędu — dokładnie ten
 * rodzaj awarii, którego w tym projekcie nie wolno zostawić bez testu.
 */
describe("dostęp do skrzynki", () => {
  async function konto(nazwa: string) {
    const userId = crypto.randomUUID();
    const username = `${nazwa}-${userId.slice(0, 8)}`;

    await env.DB.prepare(
      "INSERT INTO users (id, username, opaque_record, totp_secret_enc, created_at) VALUES (?, ?, '', '', ?)",
    )
      .bind(userId, username, Date.now())
      .run();

    const token = await issueToken(env.TOKEN_SIGNING_KEY, {
      userId,
      deviceId: "test",
      expiresAt: Date.now() + 60_000,
    });

    return { username, token };
  }

  function polacz(skrzynka: string, token?: string) {
    const naglowki: Record<string, string> = { Upgrade: "websocket" };
    if (token) naglowki["Sec-WebSocket-Protocol"] = token;

    return SELF.fetch(`https://mekamb/inbox/${skrzynka}/connect`, { headers: naglowki });
  }

  it("bez tokenu nie da się podłączyć", async () => {
    const { username } = await konto("ofiara");
    expect((await polacz(username)).status).toBe(401);
  });

  it("podrobiony token nie wystarcza", async () => {
    const { username } = await konto("ofiara");
    expect((await polacz(username, "kompletnie.zmyslony.token")).status).toBe(401);
  });

  it("cudzy token nie otwiera cudzej skrzynki", async () => {
    // Najważniejszy przypadek: napastnik MA własne konto i własny ważny token.
    const ofiara = await konto("ofiara");
    const napastnik = await konto("napastnik");

    expect((await polacz(ofiara.username, napastnik.token)).status).toBe(403);
  });

  it("właściciel podłącza się do swojej", async () => {
    const wlasciciel = await konto("wlasciciel");
    const odpowiedz = await polacz(wlasciciel.username, wlasciciel.token);

    expect(odpowiedz.status).toBe(101);
    // Przeglądarka zrywa połączenie, jeśli serwer nie potwierdzi podprotokołu.
    expect(odpowiedz.headers.get("Sec-WebSocket-Protocol")).toBe(wlasciciel.token);
  });
});
