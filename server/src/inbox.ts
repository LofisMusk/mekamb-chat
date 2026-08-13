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
 * Skrzynka nazywa się NAZWĄ UŻYTKOWNIKA, więc wszystkie urządzenia jednego
 * konta dzielą tę samą kolejkę. Kasowanie koperty po pierwszym potwierdzeniu
 * działało tylko dla jednego odbiorcy: kto przetworzył kopertę pierwszy,
 * `ack:<id>` KASOWAŁ ją pozostałym urządzeniom — a że tą samą drogą idą
 * `welcome` i commity MLS, urządzenie, które kopertę straciło, nigdy nie
 * wchodziło do grupy. „Piszę do kolegi, on widzi, ale ja jego odpowiedzi już
 * nie" i „nie da się zrobić grupy" brały się dokładnie stąd, a nadawca nie
 * widział żadnego błędu.
 *
 * Dlatego kolejka jest teraz DZIENNIKIEM tylko do dopisywania, a przeczytanie
 * odnotowujemy OSOBNO dla każdego urządzenia (`device_reads`). Potwierdzenie
 * jednego urządzenia przestaje mu wysyłać kopertę i nie rusza pozostałych.
 * Koperty kasuje wyłącznie retencja — bo skrzynka celowo nie zna składu grup,
 * więc nie wie, ILE urządzeń ma jeszcze kopertę odebrać, i nie może skasować
 * jej „gdy wszyscy odczytali". Urządzenie tożsamościuje się kryptograficznie:
 * bierzemy je z uwierzytelnionego tokenu przy `/connect`, nie z danych klienta.
 *
 * # Czego ten obiekt nie widzi
 *
 * Koperty są nieprzezroczyste. Serwer zna ich rozmiar, czas i adresata —
 * i nic ponadto.
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

      // Przeczytania per urządzenie. Jeden wiersz = to urządzenie ma już tę
      // kopertę i nie trzeba mu jej wysyłać ponownie. Klucz złożony odsiewa
      // powtórzone potwierdzenia bez osobnego sprawdzania.
      this.ctx.storage.sql.exec(`
        CREATE TABLE IF NOT EXISTS device_reads (
          device_id   TEXT NOT NULL,
          envelope_id INTEGER NOT NULL,
          PRIMARY KEY (device_id, envelope_id)
        );
      `);
    });
  }

  /**
   * Identyfikator urządzenia dla tego gniazda.
   *
   * Bierzemy go z uwierzytelnionego tokenu przy `/connect` i przypinamy do
   * gniazda przez `serializeAttachment`, żeby przetrwał hibernację. Puste,
   * gdy połączenie przyszło bez tożsamości urządzenia (starszy klient albo
   * wywołanie z testu) — takie urządzenia dzielą jedną „bezimienną" kolejkę,
   * czyli zachowują się jak przed tą zmianą i niczego nie psują nowym.
   */
  private static urzadzenieGniazda(ws: WebSocket): string {
    const dane = ws.deserializeAttachment() as { device?: string } | null;
    return dane?.device ?? "";
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

    // Tożsamość urządzenia z adresu żądania. `/connect` w Workerze bierze ją
    // z uwierzytelnionego tokenu, nie z danych klienta, i dokleja tu.
    const urzadzenie = new URL(request.url).searchParams.get("device") ?? "";

    const pair = new WebSocketPair();
    const [client, server] = [pair[0], pair[1]];

    // Hibernacja: obiekt może zostać wyładowany z pamięci, a połączenie przetrwa.
    // Tożsamość urządzenia musi ją przeżyć, więc idzie w załącznik gniazda,
    // a nie do zmiennej w pamięci obiektu.
    this.ctx.acceptWebSocket(server);
    server.serializeAttachment({ device: urzadzenie });

    await this.flushTo(server, urzadzenie);

    return new Response(null, { status: 101, webSocket: client });
  }

  /**
   * Wysyła temu urządzeniu koperty, których jeszcze nie potwierdziło.
   *
   * **Nie kasuje ich z kolejki** — to robi dopiero retencja. Potwierdzenie
   * klienta tylko odnotowuje, że TO urządzenie już kopertę ma; inne urządzenia
   * tego samego konta dostaną ją niezależnie. Klient, który dostał bajty
   * i zaraz potem padł, ma je zobaczyć ponownie.
   */
  private async flushTo(socket: WebSocket, urzadzenie: string): Promise<void> {
    const pending = this.ctx.storage.sql
      .exec<{ id: number; envelope: ArrayBuffer }>(
        `SELECT id, envelope FROM queue
         WHERE id NOT IN (SELECT envelope_id FROM device_reads WHERE device_id = ?)
         ORDER BY id`,
        urzadzenie,
      )
      .toArray();

    for (const row of pending) {
      socket.send(withId(row.id, row.envelope));
    }
  }

  /**
   * Liczba kopert w dzienniku.
   *
   * To NIE jest „ile zostało do doręczenia" — dziennik trzyma kopertę aż do
   * retencji, także po tym, jak jedyne urządzenie ją potwierdziło. Do
   * sprawdzenia, ile czeka konkretne urządzenie, jest [`pendingCountFor`].
   */
  async pendingCount(): Promise<number> {
    const row = this.ctx.storage.sql
      .exec<{ n: number }>("SELECT COUNT(*) AS n FROM queue")
      .toArray()[0];
    return row?.n ?? 0;
  }

  /** Ile kopert czeka na potwierdzenie konkretnego urządzenia. */
  async pendingCountFor(urzadzenie: string): Promise<number> {
    const row = this.ctx.storage.sql
      .exec<{ n: number }>(
        `SELECT COUNT(*) AS n FROM queue
         WHERE id NOT IN (SELECT envelope_id FROM device_reads WHERE device_id = ?)`,
        urzadzenie,
      )
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

    // `ack:<id>` — TO urządzenie przetworzyło i ZAPISAŁO kopertę. Odnotowujemy
    // przeczytanie tylko dla niego; koperta zostaje w dzienniku dla pozostałych.
    const ack = /^ack:(\d+)$/.exec(message);
    if (ack?.[1]) {
      await this.acknowledge(Number(ack[1]), UserInbox.urzadzenieGniazda(ws));
    }
  }

  /**
   * Odnotowuje, że dane urządzenie ma już tę kopertę.
   *
   * Nie kasuje koperty z dziennika: inne urządzenia tego konta mogą jej jeszcze
   * nie mieć, a skrzynka nie wie, ile ich jest. Kasuje ją dopiero retencja.
   *
   * `INSERT OR IGNORE` czyni powtórzone potwierdzenie nieszkodliwym, a wpis dla
   * nieistniejącej koperty (spóźnione albo spreparowane) niczego nie psuje —
   * po prostu nigdy się z żadną nie zejdzie.
   *
   * Wywoływane z kanału WebSocket, ale wystawione jako osobna metoda, żeby dało
   * się je sprawdzić bez zestawiania gniazda w teście.
   */
  async acknowledge(id: number, urzadzenie: string): Promise<void> {
    this.ctx.storage.sql.exec(
      "INSERT OR IGNORE INTO device_reads (device_id, envelope_id) VALUES (?, ?)",
      urzadzenie,
      id,
    );
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

    // Najpierw ślady przeczytań usuwanych kopert, potem same koperty — inaczej
    // `device_reads` rosłoby bez końca dla urządzeń, które już dawno wszystko
    // odebrały. AUTOINCREMENT nie używa identyfikatorów ponownie, więc osierocony
    // wpis nikogo nie zasłoni, ale zostawiony jest czystym marnotrawstwem miejsca.
    this.ctx.storage.sql.exec(
      "DELETE FROM device_reads WHERE envelope_id IN (SELECT id FROM queue WHERE created_at < ?)",
      cutoff,
    );
    this.ctx.storage.sql.exec("DELETE FROM queue WHERE created_at < ?", cutoff);

    // Alarm odnawiamy tylko wtedy, gdy jest jeszcze co pilnować — inaczej
    // pusta skrzynka budziłaby obiekt codziennie bez powodu.
    if ((await this.pendingCount()) > 0) {
      await this.ctx.storage.setAlarm(Date.now() + 24 * 60 * 60 * 1000);
    }
  }
}
