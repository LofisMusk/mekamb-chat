import { DurableObject } from "cloudflare:workers";

import { MAILBOX_RETENTION_DAYS, MAX_ENVELOPE_BYTES, type Env } from "./env";

/**
 * `UserInbox` — skrzynka jednego użytkownika.
 *
 * # Rola w architekturze P2P-first
 *
 * W typowym przypadku ten obiekt nie widzi wiadomości: idą one wprost między
 * urządzeniami przez iroh. Skrzynka wchodzi do gry tylko wtedy, gdy odbiorcy nie
 * dało się osiągnąć — telefon spał, sieć była za restrykcyjnym NAT-em, aplikacja
 * była zamknięta.
 *
 * # Hibernacja WebSocketów
 *
 * Połączenia przyjmujemy przez `acceptWebSocket`, a nie przez zwykłą pętlę
 * `addEventListener`. Różnica jest finansowa: uśpione połączenie nie utrzymuje
 * obiektu w pamięci, więc bezczynni użytkownicy nie zużywają darmowego limitu
 * GB-sekund. Przy zwykłym WebSockecie każdy zalogowany klient kosztowałby
 * nieprzerwanie.
 *
 * # Jedna skrzynka, wiele urządzeń
 *
 * Skrzynka adresowana jest NAZWĄ UŻYTKOWNIKA, nie urządzeniem — bo nadawca zna
 * tylko nazwę. Wszystkie urządzenia jednej osoby czytają więc tę samą kolejkę
 * i każde musi dostać swoją kopię.
 *
 * Dlatego potwierdzenie nie kasuje koperty, tylko przesuwa **kursor tego
 * urządzenia** (tabela `kursory`). Koperta znika, gdy minie kursory wszystkich
 * urządzeń, które odezwały się w ciągu ostatnich `MAILBOX_RETENTION_DAYS`.
 * Wcześniej pierwsze potwierdzenie kasowało kopertę dla wszystkich, więc drugie
 * urządzenie nigdy jej nie widziało — i to, a nie MLS, uniemożliwiało używanie
 * konta na laptopie i telefonie naraz.
 *
 * # Czego ten obiekt nie widzi
 *
 * Koperty są nieprzezroczyste. Serwer zna ich rozmiar, czas i adresata —
 * i nic ponadto. Doszedł do tego identyfikator urządzenia przy odbiorze; nadal
 * nie ma go przy nadawaniu, więc kto do kogo pisze pozostaje nieznane.
 */
/**
 * Skleja identyfikator kolejki z kopertą.
 *
 * Osiem bajtów big-endian na początku, potem oryginalne bajty. Klient odsyła
 * ten identyfikator w potwierdzeniu, dzięki czemu serwer wie, co skasować.
 */
function withId(id: number, envelope: ArrayBuffer): ArrayBuffer {
  const out = new Uint8Array(8 + envelope.byteLength);
  new DataView(out.buffer).setBigUint64(0, BigInt(id));
  out.set(new Uint8Array(envelope), 8);
  return out.buffer;
}

/** Długość prefiksu z identyfikatorem koperty. */
export const ENVELOPE_ID_BYTES = 8;

/**
 * Co siedzi w gnieździe po przebudzeniu z hibernacji.
 *
 * Mapa w pamięci obiektu nie przetrwa uśpienia, a `deviceId` jest potrzebny
 * przy każdym potwierdzeniu — więc jedzie z samym gniazdem.
 */
interface Przypiete {
  urzadzenie: string | null;
}

/** Odczytuje identyfikator urządzenia przypięty do gniazda. */
function urzadzenieGniazda(ws: WebSocket): string | null {
  try {
    return (ws.deserializeAttachment() as Przypiete | null)?.urzadzenie ?? null;
  } catch {
    // Gniazdo sprzed tej wersji nie ma nic przypiętego. Zachowuje się wtedy
    // jak dawniej — patrz [`acknowledge`].
    return null;
  }
}

export class UserInbox extends DurableObject<Env> {
  constructor(ctx: DurableObjectState, env: Env) {
    super(ctx, env);

    ctx.blockConcurrencyWhile(async () => {
      this.ctx.storage.sql.exec(`
        CREATE TABLE IF NOT EXISTS queue (
          id         INTEGER PRIMARY KEY AUTOINCREMENT,
          envelope   BLOB NOT NULL,
          created_at INTEGER NOT NULL
        );
      `);

      // Kursor na urządzenie. Powstaje przy pierwszym podłączeniu i od tej
      // chwili urządzenie **trzyma kolejkę**: nic poniżej jego kursora nie
      // zostanie skasowane.
      this.ctx.storage.sql.exec(`
        CREATE TABLE IF NOT EXISTS kursory (
          device_id  TEXT PRIMARY KEY,
          ostatni_id INTEGER NOT NULL,
          widziane_o INTEGER NOT NULL
        );
      `);
    });
  }

  /**
   * Zostawia kopertę dla użytkownika.
   *
   * # Koperta trafia do kolejki ZAWSZE
   *
   * Wysyłka do podłączonego gniazda jest tylko przyspieszeniem, nie
   * doręczeniem. `socket.send` kończy się powodzeniem, gdy bajty trafią do
   * bufora — a nie gdy klient je przetworzy i zapisze. Jeśli między jednym
   * a drugim zamknie kartę albo straci sieć, wiadomość przepada bezpowrotnie,
   * bo nadawca ma ją za dostarczoną i nikt jej już nie powtórzy.
   *
   * Dlatego wpis znika z kolejki dopiero po potwierdzeniu przez klienta
   * (patrz [`webSocketMessage`]). Kosztem jest możliwość powtórzenia tej samej
   * koperty — a to jest nieszkodliwe, bo `message_id` pozwala ją odsiać.
   */
  async deposit(envelope: ArrayBuffer): Promise<{ delivered: "live" | "queued" }> {
    if (envelope.byteLength > MAX_ENVELOPE_BYTES) {
      throw new Error(`koperta przekracza limit ${MAX_ENVELOPE_BYTES} bajtów`);
    }

    const wiersz = this.ctx.storage.sql
      .exec<{ id: number }>(
        "INSERT INTO queue (envelope, created_at) VALUES (?, ?) RETURNING id",
        envelope,
        Date.now(),
      )
      .toArray()[0];

    await this.scheduleCleanup();

    const sockets = this.ctx.getWebSockets();
    if (sockets.length > 0 && wiersz) {
      let wyslane = false;
      for (const socket of sockets) {
        try {
          socket.send(withId(wiersz.id, envelope));
          wyslane = true;
        } catch {
          // Gniazdo mogło paść między odczytem listy a wysyłką. Nie przerywamy
          // pętli — inne urządzenia tego użytkownika mogą działać.
        }
      }
      if (wyslane) {
        return { delivered: "live" };
      }
    }

    // TODO(faza 5): wyzwolenie push (FCM / Web Push).
    // Ładunek musi być WYŁĄCZNIE budzący — bez nadawcy, bez treści, bez
    // identyfikatora grupy. Patrz docs/THREAT_MODEL.md.

    return { delivered: "queued" };
  }

  /**
   * Podłącza urządzenie i natychmiast wysyła zaległości.
   *
   * Idzie przez `fetch`, a nie przez RPC, bo odpowiedź 101 z uchwytem
   * WebSocketa musi przejść ścieżką HTTP.
   */
  override async fetch(request: Request): Promise<Response> {
    if (request.headers.get("Upgrade") !== "websocket") {
      return new Response("oczekiwano upgrade do WebSocketa", { status: 426 });
    }

    const urzadzenie = new URL(request.url).searchParams.get("urzadzenie") || null;

    const pair = new WebSocketPair();
    const [client, server] = [pair[0], pair[1]];

    // Hibernacja: obiekt może zostać wyładowany z pamięci, a połączenie przetrwa.
    this.ctx.acceptWebSocket(server);
    server.serializeAttachment({ urzadzenie } satisfies Przypiete);

    if (urzadzenie !== null) {
      this.zarejestrujUrzadzenie(urzadzenie);
    }

    await this.flushTo(server, urzadzenie);

    return new Response(null, { status: 101, webSocket: client });
  }

  /**
   * Zakłada kursor urządzenia, jeśli jeszcze go nie ma.
   *
   * # Dlaczego zaczyna od zera, a nie od bieżącego końca kolejki
   *
   * Zero znaczy „nie widziałem jeszcze niczego", więc świeżo podłączone
   * urządzenie dostaje wszystko, co w kolejce zostało. Ustawienie kursora na
   * koniec byłoby cichym skasowaniem zaległości dla nowego urządzenia.
   *
   * # Kolejność, na której to stoi
   *
   * Urządzenie **trzyma kolejkę dopiero od pierwszego podłączenia**. Zanim
   * założy kursor, nikt o nim tutaj nie wie i jego koperty mogą zostać
   * skasowane po potwierdzeniu przez pozostałe urządzenia. Dlatego parowanie
   * musi podłączyć nowe urządzenie do skrzynki ZANIM stare wyśle Welcome —
   * inaczej powtórzyłaby się awaria opisana w CLAUDE.md, gdzie Welcome nigdy
   * nie dotarł i żadna wiadomość się nie odszyfrowała.
   */
  private zarejestrujUrzadzenie(urzadzenie: string): void {
    this.ctx.storage.sql.exec(
      `INSERT INTO kursory (device_id, ostatni_id, widziane_o) VALUES (?, 0, ?)
       ON CONFLICT (device_id) DO UPDATE SET widziane_o = excluded.widziane_o`,
      urzadzenie,
      Date.now(),
    );
  }

  /**
   * Wysyła zaległe koperty.
   *
   * **Nie kasuje ich z kolejki** — to robi dopiero potwierdzenie od klienta.
   * Klient, który dostał bajty i zaraz potem padł, ma je zobaczyć ponownie.
   *
   * Urządzenie ze swoim kursorem dostaje tylko to, czego jeszcze nie
   * potwierdziło. Bez kursora (klient sprzed tej wersji) dostaje całą kolejkę,
   * czyli dokładnie to co dawniej.
   */
  private async flushTo(socket: WebSocket, urzadzenie: string | null): Promise<void> {
    const od = urzadzenie === null ? 0 : this.kursor(urzadzenie);

    const pending = this.ctx.storage.sql
      .exec<{
        id: number;
        envelope: ArrayBuffer;
      }>("SELECT id, envelope FROM queue WHERE id > ? ORDER BY id", od)
      .toArray();

    for (const row of pending) {
      socket.send(withId(row.id, row.envelope));
    }
  }

  /** Ostatnia koperta potwierdzona przez to urządzenie; zero, gdy żadna. */
  private kursor(urzadzenie: string): number {
    const row = this.ctx.storage.sql
      .exec<{
        ostatni_id: number;
      }>("SELECT ostatni_id FROM kursory WHERE device_id = ?", urzadzenie)
      .toArray()[0];
    return row?.ostatni_id ?? 0;
  }

  /** Liczba kopert fizycznie leżących w kolejce. */
  async pendingCount(): Promise<number> {
    const row = this.ctx.storage.sql
      .exec<{ n: number }>("SELECT COUNT(*) AS n FROM queue")
      .toArray()[0];
    return row?.n ?? 0;
  }

  /**
   * Ile kopert czeka na konkretne urządzenie.
   *
   * Różni się od [`pendingCount`], bo koperta potwierdzona przez laptopa nadal
   * leży w kolejce dla telefonu. To właśnie ta różnica jest sednem obsługi
   * wielu urządzeń.
   */
  async pendingCountFor(urzadzenie: string): Promise<number> {
    const row = this.ctx.storage.sql
      .exec<{
        n: number;
      }>("SELECT COUNT(*) AS n FROM queue WHERE id > ?", this.kursor(urzadzenie))
      .toArray()[0];
    return row?.n ?? 0;
  }

  /**
   * Kanałem zwrotnym klient przysyła wyłącznie potwierdzenia i pingi.
   *
   * Wiadomości do innych osób idą przez iroh albo przez `POST /inbox/:userId` —
   * ten kanał jest jednokierunkowy i nie przyjmuje treści.
   */
  override async webSocketMessage(ws: WebSocket, message: string | ArrayBuffer): Promise<void> {
    if (typeof message !== "string") return;

    if (message === "ping") {
      ws.send("pong");
      return;
    }

    // `ack:<id>` — klient przetworzył i ZAPISAŁ kopertę, można ją usunąć.
    const ack = /^ack:(\d+)$/.exec(message);
    if (ack?.[1]) {
      await this.acknowledge(Number(ack[1]), urzadzenieGniazda(ws));
    }
  }

  /**
   * Przyjmuje potwierdzenie od klienta.
   *
   * # Dlaczego to nie jest zwykłe `DELETE`
   *
   * Skrzynka jest wspólna dla wszystkich urządzeń jednej osoby, więc kasowanie
   * koperty na pierwsze potwierdzenie **okradało pozostałe urządzenia**: laptop
   * potwierdzał, a śpiący telefon nie dostawał już nic i nikt nie zgłaszał
   * błędu. Zamiast tego każde urządzenie przesuwa własny kursor, a koperta
   * znika dopiero, gdy minie kursory wszystkich znanych urządzeń.
   *
   * Bez `urzadzenie` (klient sprzed tej wersji) zostaje dawne zachowanie —
   * inaczej aktualizacja serwera odcięłaby wszystkich, którzy jeszcze nie
   * zaktualizowali aplikacji. Ta sama rampa co przy `DELIVERY_TOKEN_REQUIRED`.
   *
   * Wywoływane z kanału WebSocket, ale wystawione jako osobna metoda, żeby dało
   * się je sprawdzić bez zestawiania gniazda w teście.
   */
  async acknowledge(id: number, urzadzenie: string | null = null): Promise<void> {
    if (urzadzenie === null) {
      this.ctx.storage.sql.exec("DELETE FROM queue WHERE id = ?", id);
      return;
    }

    // `MAX` — spóźnione potwierdzenie starszej koperty nie może cofnąć kursora
    // i zafundować urządzeniu powtórki wszystkiego, co już przetworzyło.
    this.ctx.storage.sql.exec(
      `INSERT INTO kursory (device_id, ostatni_id, widziane_o) VALUES (?, ?, ?)
       ON CONFLICT (device_id) DO UPDATE
         SET ostatni_id = MAX(kursory.ostatni_id, excluded.ostatni_id),
             widziane_o = excluded.widziane_o`,
      urzadzenie,
      id,
      Date.now(),
    );

    this.sprzatnij();
  }

  /**
   * Kasuje koperty, które minęły kursory wszystkich żywych urządzeń.
   *
   * Urządzenie milczące dłużej niż `MAILBOX_RETENTION_DAYS` przestaje się
   * liczyć — inaczej jeden zgubiony telefon trzymałby kolejkę w nieskończoność.
   * To jest to odcięcie po ostatniej aktywności, które commit #13 zapisał sobie
   * jako pozostałą pracę.
   *
   * Gdy nie ma ani jednego znanego urządzenia, nie kasujemy nic: pusty zbiór
   * dałby minimum „nieskończoność" i wyczyścił całą kolejkę osobie, która
   * jeszcze się nie podłączyła.
   */
  private sprzatnij(): void {
    const prog = Date.now() - MAILBOX_RETENTION_DAYS * 24 * 60 * 60 * 1000;

    const row = this.ctx.storage.sql
      .exec<{
        najmniejszy: number | null;
      }>("SELECT MIN(ostatni_id) AS najmniejszy FROM kursory WHERE widziane_o > ?", prog)
      .toArray()[0];

    const najmniejszy = row?.najmniejszy;
    if (najmniejszy === null || najmniejszy === undefined) return;

    this.ctx.storage.sql.exec("DELETE FROM queue WHERE id <= ?", najmniejszy);
  }

  override async webSocketClose(ws: WebSocket, code: number, reason: string): Promise<void> {
    // Kodów z zakresu 1005-1015 nie wolno podać w `close()` — są zarezerwowane
    // dla samej przeglądarki i próba ich użycia kończy się wyjątkiem.
    // Zerwane połączenie (1006) zgłasza się właśnie tak, więc bez tego
    // sprawdzenia każde nagłe rozłączenie klienta wywracało obsługę.
    const dozwolony = code >= 1000 && code < 1005;
    ws.close(dozwolony ? code : 1000, dozwolony ? reason : "");
  }

  /** Ustawia alarm czyszczący wygasłe koperty, jeśli jeszcze nie działa. */
  private async scheduleCleanup(): Promise<void> {
    const existing = await this.ctx.storage.getAlarm();
    if (existing === null) {
      await this.ctx.storage.setAlarm(Date.now() + 24 * 60 * 60 * 1000);
    }
  }

  override async alarm(): Promise<void> {
    const cutoff = Date.now() - MAILBOX_RETENTION_DAYS * 24 * 60 * 60 * 1000;

    // Najpierw znikają kursory urządzeń, które przestały się odzywać — dopiero
    // wtedy `sprzatnij` może ruszyć koperty, które taki nieboszczyk trzymał.
    this.ctx.storage.sql.exec("DELETE FROM kursory WHERE widziane_o < ?", cutoff);
    this.sprzatnij();

    this.ctx.storage.sql.exec("DELETE FROM queue WHERE created_at < ?", cutoff);

    // Alarm odnawiamy tylko wtedy, gdy jest jeszcze co pilnować — inaczej
    // pusta skrzynka budziłaby obiekt codziennie bez powodu.
    if ((await this.pendingCount()) > 0) {
      await this.ctx.storage.setAlarm(Date.now() + 24 * 60 * 60 * 1000);
    }
  }
}
