/**
 * Trwałe połączenie ze skrzynką.
 *
 * # Co było zepsute
 *
 * Klient otwierał WebSocket i zostawiał go samemu sobie. Nie wysyłał
 * podtrzymania, więc bezczynne połączenie było zrywane po drodze; nie
 * obsługiwał zamknięcia, więc po zerwaniu nie wracało już nic. Jedynym
 * sposobem na sprawne gniazdo było przeładowanie strony — a że historia
 * rozmów żyła wtedy tylko w pamięci komponentu, przeładowanie ją kasowało.
 * Stąd „wiadomości przychodzą dopiero po odświeżeniu" i niemożność rozmowy.
 *
 * Serwer od początku odpowiadał `pong` na `ping` ([`server/src/inbox.ts`]),
 * tylko druga połowa nigdy nie powstała.
 *
 * # Dlaczego to jest osobno od komponentu
 *
 * Poprzednia wersja trzymała gniazdo w `useEffect` z zależnościami od
 * `groupId` i od funkcji obsługi błędu, która nie była memoizowana. Każde
 * przerysowanie zrywało więc połączenie i otwierało nowe. Połączenie sieciowe
 * nie może zależeć od tożsamości funkcji w Reakcie — tutaj zależy wyłącznie
 * od konta.
 */

/** Co ile wysyłamy podtrzymanie. */
const PING_MS = 30_000;

/** Od tylu milisekund zaczyna się odczekiwanie przed ponowieniem. */
const PONOWIENIE_MIN_MS = 1_000;

/** Powyżej tego nie czekamy dłużej — użytkownik patrzy na ekran. */
const PONOWIENIE_MAX_MS = 30_000;

export type StanPolaczenia = "laczenie" | "polaczone" | "rozlaczone";

export interface Polaczenie {
  /** Zamyka na stałe. Po tym nie ma już ponowień. */
  zamknij(): void;
}

export interface OpcjePolaczenia {
  /** Otwiera surowe gniazdo. Wstrzykiwane, żeby dało się to przetestować. */
  otworz: () => WebSocket;
  /**
   * Wywoływane dla każdej ramki z serwera.
   *
   * `potwierdz` jest związane z TYM gniazdem, które ramkę przyniosło.
   * Potwierdzanie przez wspólną referencję trafiałoby po ponowieniu na już
   * zamknięte gniazdo, a koperta zostawałaby w kolejce na zawsze.
   */
  naRamke: (ramka: ArrayBuffer, potwierdz: (id: bigint) => void) => void;
  /** Zmiany stanu do pokazania użytkownikowi. */
  naStan?: (stan: StanPolaczenia) => void;
  /** Podmieniane w testach, żeby nie czekać naprawdę. */
  zegar?: {
    ustawOdstep: (fn: () => void, ms: number) => number;
    wyczyscOdstep: (id: number) => void;
    ustawTimer: (fn: () => void, ms: number) => number;
    wyczyscTimer: (id: number) => void;
  };
}

const ZEGAR_SYSTEMOWY: NonNullable<OpcjePolaczenia["zegar"]> = {
  ustawOdstep: (fn, ms) => setInterval(fn, ms) as unknown as number,
  wyczyscOdstep: (id) => clearInterval(id),
  ustawTimer: (fn, ms) => setTimeout(fn, ms) as unknown as number,
  wyczyscTimer: (id) => clearTimeout(id),
};

/**
 * Otwiera połączenie i utrzymuje je aż do jawnego zamknięcia.
 *
 * Po zerwaniu ponawia z rosnącym odstępem. Odstęp rośnie, żeby telefon bez
 * zasięgu nie próbował w kółko co sekundę i nie zjadał baterii; jest
 * ograniczony z góry, bo po odzyskaniu sieci użytkownik ma zobaczyć wiadomości
 * od razu, a nie po kilku minutach.
 */
export function polaczZeSkrzynka(opcje: OpcjePolaczenia): Polaczenie {
  const zegar = opcje.zegar ?? ZEGAR_SYSTEMOWY;

  let gniazdo: WebSocket | null = null;
  let pingId: number | null = null;
  let ponowienieId: number | null = null;
  let odstep = PONOWIENIE_MIN_MS;
  let zamkniete = false;

  const zatrzymajPing = () => {
    if (pingId !== null) {
      zegar.wyczyscOdstep(pingId);
      pingId = null;
    }
  };

  const zaplanujPonowienie = () => {
    if (zamkniete || ponowienieId !== null) return;

    ponowienieId = zegar.ustawTimer(() => {
      ponowienieId = null;
      odstep = Math.min(odstep * 2, PONOWIENIE_MAX_MS);
      polacz();
    }, odstep);
  };

  const polacz = () => {
    if (zamkniete) return;

    opcje.naStan?.("laczenie");
    const socket = opcje.otworz();
    gniazdo = socket;
    socket.binaryType = "arraybuffer";

    socket.onopen = () => {
      // Zerowanie odstępu dopiero po UDANYM połączeniu. Zerowane przy próbie
      // dawałoby stały, najkrótszy odstęp, gdy serwer odrzuca połączenia od
      // razu — czyli dokładnie wtedy, gdy odczekanie jest najbardziej
      // potrzebne.
      odstep = PONOWIENIE_MIN_MS;
      opcje.naStan?.("polaczone");

      zatrzymajPing();
      pingId = zegar.ustawOdstep(() => {
        // Bez podtrzymania bezczynne połączenie jest zrywane po drodze —
        // i to zerwanie bywa ciche, bez `close` po tej stronie.
        try {
          socket.send("ping");
        } catch {
          // Gniazdo padło między sprawdzeniem a wysłaniem. `onclose`
          // zaplanuje ponowienie.
        }
      }, PING_MS);
    };

    socket.onmessage = (event) => {
      // `pong` to odpowiedź na podtrzymanie, nie koperta.
      if (typeof event.data === "string") return;

      opcje.naRamke(event.data as ArrayBuffer, (id) => {
        if (socket.readyState !== WebSocket.OPEN) return;
        socket.send(`ack:${id}`);
      });
    };

    socket.onclose = () => {
      zatrzymajPing();
      if (zamkniete) return;
      opcje.naStan?.("rozlaczone");
      zaplanujPonowienie();
    };

    socket.onerror = () => {
      // Po błędzie przeglądarka i tak wywoła `onclose`; zamykamy jawnie, żeby
      // nie zostało gniazdo w stanie CONNECTING, które nigdy się nie rozwiąże.
      try {
        socket.close();
      } catch {
        // Nieistotne — liczy się tylko to, żeby doszło do `onclose`.
      }
    };
  };

  polacz();

  return {
    zamknij() {
      zamkniete = true;
      zatrzymajPing();
      if (ponowienieId !== null) {
        zegar.wyczyscTimer(ponowienieId);
        ponowienieId = null;
      }
      try {
        gniazdo?.close();
      } catch {
        // Zamykanie zamkniętego gniazda nie jest błędem.
      }
    },
  };
}
