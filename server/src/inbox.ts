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
 * # Czego ten obiekt nie widzi
 *
 * Koperty są nieprzezroczyste. Serwer zna ich rozmiar, czas i adresata —
 * i nic ponadto.
 */
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
    });
  }

  /**
   * Zostawia kopertę dla użytkownika.
   *
   * Gdy któreś z urządzeń jest podłączone, koperta idzie od razu i nie ląduje
   * w kolejce. Gdy nie ma nikogo — czeka i wyzwala powiadomienie budzące.
   */
  async deposit(envelope: ArrayBuffer): Promise<{ delivered: "live" | "queued" }> {
    if (envelope.byteLength > MAX_ENVELOPE_BYTES) {
      throw new Error(`koperta przekracza limit ${MAX_ENVELOPE_BYTES} bajtów`);
    }

    const sockets = this.ctx.getWebSockets();

    if (sockets.length > 0) {
      let delivered = false;
      for (const socket of sockets) {
        try {
          socket.send(envelope);
          delivered = true;
        } catch {
          // Gniazdo mogło paść między odczytem listy a wysyłką. Nie przerywamy
          // pętli — inne urządzenia tego użytkownika mogą działać.
        }
      }
      if (delivered) {
        return { delivered: "live" };
      }
    }

    this.ctx.storage.sql.exec(
      "INSERT INTO queue (envelope, created_at) VALUES (?, ?)",
      envelope,
      Date.now(),
    );

    await this.scheduleCleanup();

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

    const pair = new WebSocketPair();
    const [client, server] = [pair[0], pair[1]];

    // Hibernacja: obiekt może zostać wyładowany z pamięci, a połączenie przetrwa.
    this.ctx.acceptWebSocket(server);

    await this.flushTo(server);

    return new Response(null, { status: 101, webSocket: client });
  }

  /** Wysyła zakolejkowane koperty i czyści kolejkę. */
  private async flushTo(socket: WebSocket): Promise<void> {
    const pending = this.ctx.storage.sql
      .exec<{ id: number; envelope: ArrayBuffer }>(
        "SELECT id, envelope FROM queue ORDER BY id",
      )
      .toArray();

    for (const row of pending) {
      socket.send(row.envelope);
      // Kasujemy dopiero po udanej wysyłce. Gdyby `send` rzucił, reszta
      // zostaje w kolejce i doczeka następnego połączenia.
      this.ctx.storage.sql.exec("DELETE FROM queue WHERE id = ?", row.id);
    }
  }

  /** Liczba kopert czekających w kolejce. */
  async pendingCount(): Promise<number> {
    const row = this.ctx.storage.sql
      .exec<{ n: number }>("SELECT COUNT(*) AS n FROM queue")
      .toArray()[0];
    return row?.n ?? 0;
  }

  override async webSocketMessage(_ws: WebSocket, message: string | ArrayBuffer): Promise<void> {
    // Klient nie wysyła tym kanałem wiadomości do innych — do tego służy iroh
    // albo endpoint HTTP ze skrzynką. Ten kanał jest jednokierunkowy, więc
    // przyjmujemy tylko pingi podtrzymujące.
    if (typeof message === "string" && message === "ping") {
      _ws.send("pong");
    }
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
    this.ctx.storage.sql.exec("DELETE FROM queue WHERE created_at < ?", cutoff);

    // Alarm odnawiamy tylko wtedy, gdy jest jeszcze co pilnować — inaczej
    // pusta skrzynka budziłaby obiekt codziennie bez powodu.
    if ((await this.pendingCount()) > 0) {
      await this.ctx.storage.setAlarm(Date.now() + 24 * 60 * 60 * 1000);
    }
  }
}
