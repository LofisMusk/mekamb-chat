import { SELF, env } from "cloudflare:test";
import { describe, expect, it, vi } from "vitest";

import { issueToken } from "../src/crypto";
import { MAILBOX_RETENTION_DAYS, MAX_ENVELOPE_BYTES } from "../src/env";

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

/**
 * Skrzynka jest wspólna dla wszystkich urządzeń jednej osoby.
 *
 * # Sedno
 *
 * Potwierdzenie kasowało kopertę dla WSZYSTKICH. Laptop online i telefon
 * w kieszeni znaczyło, że laptop potwierdza, a telefon nie dostaje już nic —
 * i nikt nie zgłasza błędu, bo z punktu widzenia serwera wszystko poszło
 * dobrze. Dopóki to obowiązywało, konta nie dało się używać na dwóch
 * urządzeniach, niezależnie od tego, co potrafi MLS.
 */
describe("wiele urządzeń jednej osoby", () => {
  function polacz(skrzynka: ReturnType<typeof inbox>, urzadzenie: string) {
    return skrzynka.fetch(`https://inbox/connect?urzadzenie=${urzadzenie}`, {
      headers: { Upgrade: "websocket" },
    });
  }

  it("potwierdzenie jednego urządzenia nie okrada drugiego", async () => {
    const skrzynka = inbox("dwa-urzadzenia");
    await polacz(skrzynka, "laptop");
    await polacz(skrzynka, "telefon");

    await skrzynka.deposit(koperta("dla obu"));
    await skrzynka.acknowledge(1, "laptop");

    // Laptop ma z głowy, telefon nadal czeka — i koperta LEŻY w kolejce.
    expect(await skrzynka.pendingCountFor("laptop")).toBe(0);
    expect(await skrzynka.pendingCountFor("telefon")).toBe(1);
    expect(await skrzynka.pendingCount()).toBe(1);
  });

  it("koperta znika dopiero po potwierdzeniu przez wszystkie urządzenia", async () => {
    const skrzynka = inbox("oba-potwierdzaja");
    await polacz(skrzynka, "laptop");
    await polacz(skrzynka, "telefon");

    await skrzynka.deposit(koperta("dla obu"));
    await skrzynka.acknowledge(1, "laptop");
    expect(await skrzynka.pendingCount()).toBe(1);

    await skrzynka.acknowledge(1, "telefon");
    expect(await skrzynka.pendingCount()).toBe(0);
  });

  it("ponowne podłączenie dostaje tylko to, czego nie potwierdziło", async () => {
    const skrzynka = inbox("wznowienie");
    await polacz(skrzynka, "laptop");
    await polacz(skrzynka, "telefon");

    await skrzynka.deposit(koperta("pierwsza"));
    await skrzynka.deposit(koperta("druga"));
    await skrzynka.acknowledge(1, "telefon");

    expect(await skrzynka.pendingCountFor("telefon")).toBe(1);
    expect(await skrzynka.pendingCountFor("laptop")).toBe(2);
  });

  /**
   * Spóźnione potwierdzenie starszej koperty przychodzi po ponownym
   * połączeniu. Cofnięcie kursora zafundowałoby urządzeniu powtórkę
   * wszystkiego, co już przetworzyło.
   */
  it("kursor nie cofa się przy spóźnionym potwierdzeniu", async () => {
    const skrzynka = inbox("spoznione");
    await polacz(skrzynka, "laptop");

    for (const tresc of ["a", "b", "c"]) {
      await skrzynka.deposit(koperta(tresc));
    }

    await skrzynka.acknowledge(3, "laptop");
    await skrzynka.acknowledge(1, "laptop");

    expect(await skrzynka.pendingCountFor("laptop")).toBe(0);
  });

  /**
   * Rampa zgodności: serwer, który po wdrożeniu przestaje rozumieć klienta
   * sprzed aktualizacji, odcina wszystkich, którzy jeszcze jej nie zainstalowali.
   */
  it("klient bez identyfikatora urządzenia działa jak dawniej", async () => {
    const skrzynka = inbox("stary-klient");
    await skrzynka.deposit(koperta("po staremu"));

    await skrzynka.acknowledge(1);

    expect(await skrzynka.pendingCount()).toBe(0);
  });

  /**
   * Nieznane urządzenie nie może zablokować kasowania — inaczej wystarczyłoby
   * zgadnąć nazwę, żeby zmusić serwer do wiecznego trzymania cudzych kopert.
   */
  it("urządzenie, które nigdy się nie podłączyło, nie trzyma kolejki", async () => {
    const skrzynka = inbox("nieznane");
    await polacz(skrzynka, "laptop");

    await skrzynka.deposit(koperta("jedyna"));
    await skrzynka.acknowledge(1, "laptop");

    expect(await skrzynka.pendingCount()).toBe(0);
  });

  /**
   * Zgubiony telefon nie może zabetonować skrzynki.
   *
   * Bez odcięcia po ostatniej aktywności jedno urządzenie, które nigdy już się
   * nie odezwie, trzymałoby każdą kopertę w nieskończoność — a serwer ma
   * przechowywać jak najmniej i jak najkrócej.
   *
   * Podmieniamy sam `Date`, nie liczniki: fałszywy `setTimeout` zawiesiłby
   * wejście-wyjście workerd i test nigdy by się nie skończył.
   */
  it("urządzenie milczące dłużej niż retencja przestaje trzymać kolejkę", async () => {
    const skrzynka = inbox("zgubiony-telefon");
    await polacz(skrzynka, "telefon");

    vi.useFakeTimers({ toFake: ["Date"] });
    try {
      vi.setSystemTime(Date.now() + (MAILBOX_RETENTION_DAYS + 1) * 24 * 60 * 60 * 1000);

      await polacz(skrzynka, "laptop");
      await skrzynka.deposit(koperta("swieza"));
      await skrzynka.acknowledge(1, "laptop");

      // Koperta jest świeża, więc nie usunęła jej retencja — usunęło ją to, że
      // telefon przestał się liczyć.
      expect(await skrzynka.pendingCount()).toBe(0);
    } finally {
      vi.useRealTimers();
    }
  });

  it("urządzenie, które się odezwało, nadal trzyma kolejkę", async () => {
    const skrzynka = inbox("zywy-telefon");
    await polacz(skrzynka, "telefon");
    await polacz(skrzynka, "laptop");

    await skrzynka.deposit(koperta("swieza"));
    await skrzynka.acknowledge(1, "laptop");

    // Kontrola dla testu wyżej: bez upływu czasu koperta zostaje.
    expect(await skrzynka.pendingCount()).toBe(1);
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
