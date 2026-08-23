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
 * Dlatego potwierdzenie nie kasuje koperty, tylko dopisuje wiersz do
 * **zbioru odczytów tego urządzenia** (tabela `device_reads`). Koperta znika,
 * gdy przeczytają ją wszystkie urządzenia, które odezwały się w ciągu ostatnich
 * `MAILBOX_RETENTION_DAYS`. Wcześniej pierwsze potwierdzenie kasowało kopertę
 * dla wszystkich, więc drugie urządzenie nigdy jej nie widziało — i to, a nie
 * MLS, uniemożliwiało używanie konta na laptopie i telefonie naraz.
 *
 * # Dlaczego ZBIÓR, a nie jedna liczba
 *
 * Bo klient potwierdza koperty **nie po kolei**. Koperta, której nie udało się
 * przetworzyć, zostaje nietknięta do ponowienia, a następna — jeśli przeszła —
 * jest potwierdzana od razu (`web/src/lib/koperty.ts`, `android/…/Skrzynka.kt`).
 * Pojedynczy kursor `ostatni_id` podnoszony do `MAX` przeskakiwał wtedy
 * pominiętą kopertę NA ZAWSZE: `flushTo` wysyłał tylko `id > kursor`, a
 * `sprzatnij` kasował wszystko poniżej. Potwierdzenie koperty 2 gubiło więc
 * kopertę 1, której klient celowo nie potwierdził — czyli cała polityka
 * ponawiania nie robiła nic, a zgubiony tamtędy commit albo Welcome to znana
 * awaria, w której nic się nie odszyfrowuje i nikt nie widzi błędu.
 *
 * Zbiór przeczytanych identyfikatorów nie ma tej krawędzi: dziura w środku
 * zostaje dziurą i wraca przy następnym połączeniu.
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
 * Pod tym identyfikatorem księgujemy klienta, który nie podał swojego.
 *
 * Rampa zgodności: aplikacja sprzed wprowadzenia wielu urządzeń nie przysyła
 * identyfikatora, a token wystawiony przy logowaniu bez `deviceId` też go nie
 * niesie (`auth.ts`). Taki klient dostaje JEDNO wspólne konto odczytów zamiast
 * dawnego `DELETE`, który kasował kopertę wszystkim urządzeniom naraz — czyli
 * dokładnie tego, czego ten obiekt ma nie robić. Z punktu widzenia starego
 * klienta nic się nie zmienia: dostaje to, czego nie potwierdził.
 */
export const URZADZENIE_NIEZNANE = "nieznane";

/**
 * Co siedzi w gnieździe po przebudzeniu z hibernacji.
 *
 * Mapa w pamięci obiektu nie przetrwa uśpienia, a `deviceId` jest potrzebny
 * przy każdym potwierdzeniu — więc jedzie z samym gniazdem.
 */
interface Przypiete {
  urzadzenie: string;
}

/** Odczytuje identyfikator urządzenia przypięty do gniazda. */
function urzadzenieGniazda(ws: WebSocket): string {
  try {
    return (ws.deserializeAttachment() as Przypiete | null)?.urzadzenie ?? URZADZENIE_NIEZNANE;
  } catch {
    // Gniazdo sprzed tej wersji nie ma nic przypiętego — trafia na wspólne
    // konto odczytów, tak samo jak klient bez identyfikatora.
    return URZADZENIE_NIEZNANE;
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

      // Urządzenia, które kiedykolwiek się podłączyły. Od pierwszego
      // podłączenia urządzenie **trzyma kolejkę**: koperta, której nie
      // przeczytało, nie zostanie skasowana.
      this.ctx.storage.sql.exec(`
        CREATE TABLE IF NOT EXISTS urzadzenia (
          device_id  TEXT PRIMARY KEY,
          widziane_o INTEGER NOT NULL
        );
      `);

      // Co które urządzenie przeczytało. Zbiór, nie kursor — powód w nagłówku.
      this.ctx.storage.sql.exec(`
        CREATE TABLE IF NOT EXISTS device_reads (
          device_id   TEXT    NOT NULL,
          envelope_id INTEGER NOT NULL,
          PRIMARY KEY (device_id, envelope_id)
        );
      `);

      this.przeniesKursory();
    });
  }

  /**
   * Przenosi stare kursory do zbiorów odczytów i kasuje starą tabelę.
   *
   * Kursor `ostatni_id` znaczył „wszystko do tego numeru przeczytane", więc
   * przekłada się dokładnie: każdy wpis w kolejce o numerze nie większym niż
   * kursor był dla tego urządzenia przeczytany. Kopert już skasowanych nie
   * odtwarzamy, bo nie ma po co — liczy się tylko to, co jeszcze leży.
   *
   * Bez tego kroku aktualizacja serwera pokazałaby każdemu urządzeniu całą
   * zaległą kolejkę od nowa: nowy kod nie zna `kursory`, więc zbiór odczytów
   * byłby pusty.
   */
  private przeniesKursory(): void {
    const istnieje = this.ctx.storage.sql
      .exec<{
        n: number;
      }>("SELECT COUNT(*) AS n FROM sqlite_master WHERE type = 'table' AND name = 'kursory'")
      .toArray()[0];

    if (!istnieje || istnieje.n === 0) return;

    this.ctx.storage.sql.exec(
      `INSERT OR IGNORE INTO urzadzenia (device_id, widziane_o)
            SELECT device_id, widziane_o FROM kursory`,
    );

    this.ctx.storage.sql.exec(
      `INSERT OR IGNORE INTO device_reads (device_id, envelope_id)
            SELECT k.device_id, q.id
              FROM kursory k
              JOIN queue q ON q.id <= k.ostatni_id`,
    );

    this.ctx.storage.sql.exec("DROP TABLE kursory");
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

    // Identyfikator przychodzi wyłącznie od Workera, który bierze go
    // z PODPISANEGO tokenu (`index.ts`). Jego brak nie jest już osobną,
    // kasującą ścieżką — to po prostu wspólne konto odczytów.
    const urzadzenie =
      new URL(request.url).searchParams.get("urzadzenie") || URZADZENIE_NIEZNANE;

    const pair = new WebSocketPair();
    const [client, server] = [pair[0], pair[1]];

    // Hibernacja: obiekt może zostać wyładowany z pamięci, a połączenie przetrwa.
    this.ctx.acceptWebSocket(server);
    server.serializeAttachment({ urzadzenie } satisfies Przypiete);

    this.zarejestrujUrzadzenie(urzadzenie);

    await this.flushTo(server, urzadzenie);

    return new Response(null, { status: 101, webSocket: client });
  }

  /**
   * Odnotowuje urządzenie i chwilę, w której się odezwało.
   *
   * # Dlaczego zaczyna od zera, a nie od bieżącego końca kolejki
   *
   * Pusty zbiór odczytów znaczy „nie widziałem jeszcze niczego", więc świeżo
   * podłączone urządzenie dostaje wszystko, co w kolejce zostało. Zapisanie mu
   * na starcie całej kolejki jako przeczytanej byłoby cichym skasowaniem
   * zaległości dla nowego urządzenia.
   *
   * # Kolejność, na której to stoi
   *
   * Urządzenie **trzyma kolejkę dopiero od pierwszego podłączenia**. Zanim się
   * odezwie, nikt o nim tutaj nie wie i jego koperty mogą zostać skasowane po
   * potwierdzeniu przez pozostałe urządzenia. Dlatego parowanie
   * musi podłączyć nowe urządzenie do skrzynki ZANIM stare wyśle Welcome —
   * inaczej powtórzyłaby się awaria opisana w CLAUDE.md, gdzie Welcome nigdy
   * nie dotarł i żadna wiadomość się nie odszyfrowała.
   */
  private zarejestrujUrzadzenie(urzadzenie: string): void {
    this.ctx.storage.sql.exec(
      `INSERT INTO urzadzenia (device_id, widziane_o) VALUES (?, ?)
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
   * Urządzenie dostaje wszystko, czego nie ma w swoim zbiorze odczytów —
   * łącznie z kopertą pominiętą wcześniej, po której potwierdziło już nowszą.
   * To jest ta różnica, przez którą ponawianie w ogóle działa.
   */
  private async flushTo(socket: WebSocket, urzadzenie: string): Promise<void> {
    const pending = this.ctx.storage.sql
      .exec<{
        id: number;
        envelope: ArrayBuffer;
      }>(
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
      }>(
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
   * błędu. Zamiast tego każde urządzenie prowadzi własny zbiór odczytów,
   * a koperta znika dopiero, gdy przeczytają ją wszystkie znane urządzenia.
   *
   * Bez `urzadzenie` (klient sprzed tej wersji) potwierdzenie idzie na wspólne
   * konto `URZADZENIE_NIEZNANE`, a nie kasuje koperty wszystkim — dawne
   * `DELETE` było tą samą awarią, którą ten obiekt miał zlikwidować, tylko
   * wywołaną z drugiej strony.
   *
   * Potwierdzenie zapisujemy jako FAKT („to urządzenie przeczytało tę
   * kopertę"), więc jest idempotentne i nie zależy od kolejności: spóźnione
   * potwierdzenie starszej koperty dokłada ją do zbioru i nie rusza niczego
   * innego. Kursor podnoszony do `MAX` gubił w tym miejscu koperty pominięte.
   *
   * Wywoływane z kanału WebSocket, ale wystawione jako osobna metoda, żeby dało
   * się je sprawdzić bez zestawiania gniazda w teście.
   */
  async acknowledge(id: number, urzadzenie: string = URZADZENIE_NIEZNANE): Promise<void> {
    // Urządzenie, które potwierdza, z definicji się odezwało — a od tej chwili
    // trzyma kolejkę, więc musi być widoczne dla [`sprzatnij`].
    this.zarejestrujUrzadzenie(urzadzenie);

    this.ctx.storage.sql.exec(
      "INSERT OR IGNORE INTO device_reads (device_id, envelope_id) VALUES (?, ?)",
      urzadzenie,
      id,
    );

    this.sprzatnij();
  }

  /**
   * Kasuje koperty przeczytane przez wszystkie żywe urządzenia.
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

    const zywe = this.ctx.storage.sql
      .exec<{ n: number }>("SELECT COUNT(*) AS n FROM urzadzenia WHERE widziane_o > ?", prog)
      .toArray()[0];

    if (!zywe || zywe.n === 0) return;

    this.ctx.storage.sql.exec(
      `DELETE FROM queue
        WHERE id IN (
                SELECT r.envelope_id
                  FROM device_reads r
                  JOIN urzadzenia u ON u.device_id = r.device_id
                 WHERE u.widziane_o > ?
                 GROUP BY r.envelope_id
                HAVING COUNT(*) >= ?
              )`,
      prog,
      zywe.n,
    );

    this.zapomnijOsierocone();
  }

  /**
   * Kasuje odczyty wskazujące koperty, których już nie ma.
   *
   * Bez tego tabela rośnie bez końca: numery kolejki nigdy się nie powtarzają,
   * więc wpis po skasowanej kopercie nie przyda się nikomu. Trafiają tu także
   * potwierdzenia numerów, których nigdy nie było.
   */
  private zapomnijOsierocone(): void {
    this.ctx.storage.sql.exec(
      "DELETE FROM device_reads WHERE envelope_id NOT IN (SELECT id FROM queue)",
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

    // Najpierw znikają urządzenia, które przestały się odzywać, razem z ich
    // odczytami — dopiero wtedy `sprzatnij` może ruszyć koperty, które taki
    // nieboszczyk trzymał.
    this.ctx.storage.sql.exec(
      "DELETE FROM device_reads WHERE device_id IN (SELECT device_id FROM urzadzenia WHERE widziane_o < ?)",
      cutoff,
    );
    this.ctx.storage.sql.exec("DELETE FROM urzadzenia WHERE widziane_o < ?", cutoff);
    this.sprzatnij();

    this.ctx.storage.sql.exec("DELETE FROM queue WHERE created_at < ?", cutoff);
    this.zapomnijOsierocone();

    // Alarm odnawiamy tylko wtedy, gdy jest jeszcze co pilnować — inaczej
    // pusta skrzynka budziłaby obiekt codziennie bez powodu.
    if ((await this.pendingCount()) > 0) {
      await this.ctx.storage.setAlarm(Date.now() + 24 * 60 * 60 * 1000);
    }
  }
}
