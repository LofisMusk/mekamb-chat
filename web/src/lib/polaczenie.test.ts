import { describe, expect, it } from "vitest";

import { polaczZeSkrzynka } from "./polaczenie";

/**
 * Atrapa gniazda z ręcznie sterowanym cyklem życia.
 *
 * Prawdziwy WebSocket nie da się w teście zerwać w wybranym momencie, a to
 * właśnie zerwanie było błędem: klient go nie obsługiwał.
 */
class UdawaneGniazdo {
  static otwarte: UdawaneGniazdo[] = [];

  readyState = 0; // CONNECTING
  binaryType = "blob";
  wyslane: string[] = [];
  zamkniete = false;

  onopen: (() => void) | null = null;
  onmessage: ((e: { data: unknown }) => void) | null = null;
  onclose: (() => void) | null = null;
  onerror: (() => void) | null = null;

  constructor() {
    UdawaneGniazdo.otwarte.push(this);
  }

  send(dane: string) {
    if (this.readyState !== 1) throw new Error("gniazdo nie jest otwarte");
    this.wyslane.push(dane);
  }

  close() {
    this.zamkniete = true;
    this.readyState = 3; // CLOSED
  }

  // --- sterowanie z testu ---
  polacz() {
    this.readyState = 1; // OPEN
    this.onopen?.();
  }

  zerwij() {
    this.readyState = 3;
    this.onclose?.();
  }

  przyslij(dane: unknown) {
    this.onmessage?.({ data: dane });
  }
}

/** Zegar sterowany ręcznie — bez czekania na prawdziwe 30 sekund. */
function udawanyZegar() {
  let nastepnyId = 1;
  const odstepy = new Map<number, { fn: () => void; ms: number }>();
  const timery = new Map<number, { fn: () => void; ms: number }>();

  return {
    zegar: {
      ustawOdstep: (fn: () => void, ms: number) => {
        const id = nastepnyId++;
        odstepy.set(id, { fn, ms });
        return id;
      },
      wyczyscOdstep: (id: number) => void odstepy.delete(id),
      ustawTimer: (fn: () => void, ms: number) => {
        const id = nastepnyId++;
        timery.set(id, { fn, ms });
        return id;
      },
      wyczyscTimer: (id: number) => void timery.delete(id),
    },
    /** Wyzwala wszystkie aktywne podtrzymania. */
    tyknijPing: () => {
      for (const { fn } of [...odstepy.values()]) fn();
    },
    /** Wyzwala zaplanowane ponowienia i zwraca odstępy, na jakie czekały. */
    tyknijPonowienia: (): number[] => {
      const wpisy = [...timery.entries()];
      timery.clear();
      const odstepyMs = wpisy.map(([, w]) => w.ms);
      for (const [, w] of wpisy) w.fn();
      return odstepyMs;
    },
    ilePodtrzyman: () => odstepy.size,
    ilePonowien: () => timery.size,
  };
}

function zestaw() {
  UdawaneGniazdo.otwarte = [];
  const zegar = udawanyZegar();
  const ramki: ArrayBuffer[] = [];
  const stany: string[] = [];

  const polaczenie = polaczZeSkrzynka({
    otworz: () => new UdawaneGniazdo() as unknown as WebSocket,
    naRamke: (r) => void ramki.push(r),
    naStan: (s) => void stany.push(s),
    zegar: zegar.zegar,
  });

  return { zegar, ramki, stany, polaczenie, gniazda: UdawaneGniazdo.otwarte };
}

describe("połączenie ze skrzynką", () => {
  it("otwiera gniazdo od razu", () => {
    const { gniazda } = zestaw();
    expect(gniazda).toHaveLength(1);
  });

  /// Sedno pierwsze: bez podtrzymania bezczynne połączenie jest po drodze
  /// zrywane. Serwer odpowiadał `pong` od początku — brakowało tej połowy.
  it("wysyła podtrzymanie po połączeniu", () => {
    const { zegar, gniazda } = zestaw();
    const g = gniazda[0]!;

    g.polacz();
    expect(zegar.ilePodtrzyman()).toBe(1);

    zegar.tyknijPing();
    zegar.tyknijPing();
    expect(g.wyslane).toEqual(["ping", "ping"]);
  });

  it("nie podtrzymuje gniazda, które się nie połączyło", () => {
    const { zegar } = zestaw();
    expect(zegar.ilePodtrzyman()).toBe(0);
  });

  /// Sedno drugie: po zerwaniu klient nie robił NIC. Jedynym ratunkiem było
  /// przeładowanie strony — stąd „wiadomości dopiero po odświeżeniu".
  it("po zerwaniu łączy się ponownie", () => {
    const { zegar, gniazda } = zestaw();

    gniazda[0]!.polacz();
    gniazda[0]!.zerwij();

    expect(zegar.ilePonowien()).toBe(1);
    zegar.tyknijPonowienia();
    expect(gniazda).toHaveLength(2);
  });

  it("odstęp między ponowieniami rośnie i ma górną granicę", () => {
    const { zegar, gniazda } = zestaw();
    const odstepy: number[] = [];

    for (let i = 0; i < 10; i++) {
      gniazda[gniazda.length - 1]!.zerwij();
      odstepy.push(...zegar.tyknijPonowienia());
    }

    // Rośnie…
    expect(odstepy[1]!).toBeGreaterThan(odstepy[0]!);
    // …ale nie w nieskończoność — użytkownik czeka na wiadomości.
    expect(Math.max(...odstepy)).toBeLessThanOrEqual(30_000);
  });

  /// Odstęp zerowany przy PRÓBIE dawałby stały, najkrótszy odstęp, gdy serwer
  /// odrzuca połączenia od razu — czyli wtedy, gdy odczekanie jest najbardziej
  /// potrzebne. Zerujemy dopiero po udanym połączeniu.
  it("udane połączenie zeruje odstęp", () => {
    const { zegar, gniazda } = zestaw();

    gniazda[0]!.zerwij();
    const [pierwszy] = zegar.tyknijPonowienia();
    gniazda[1]!.zerwij();
    const [drugi] = zegar.tyknijPonowienia();
    expect(drugi!).toBeGreaterThan(pierwszy!);

    gniazda[2]!.polacz();
    gniazda[2]!.zerwij();
    const [poUdanym] = zegar.tyknijPonowienia();

    expect(poUdanym).toBe(pierwszy);
  });

  it("koperty trafiają do obsługi, a pong nie", () => {
    const { ramki, gniazda } = zestaw();
    const g = gniazda[0]!;
    g.polacz();

    g.przyslij("pong");
    expect(ramki).toHaveLength(0);

    g.przyslij(new ArrayBuffer(18));
    expect(ramki).toHaveLength(1);
  });

  /// Potwierdzenie musi iść tym gniazdem, które ramkę przyniosło. Wspólna
  /// referencja po ponowieniu wskazywałaby zamknięte gniazdo, a koperta
  /// zostawałaby w kolejce na zawsze.
  it("potwierdzenie idzie gniazdem, które przyniosło ramkę", () => {
    UdawaneGniazdo.otwarte = [];
    const zegar = udawanyZegar();
    const potwierdzenia: ((id: bigint) => void)[] = [];

    polaczZeSkrzynka({
      otworz: () => new UdawaneGniazdo() as unknown as WebSocket,
      naRamke: (_r, potwierdz) => void potwierdzenia.push(potwierdz),
      zegar: zegar.zegar,
    });

    const gniazda = UdawaneGniazdo.otwarte;
    gniazda[0]!.polacz();
    gniazda[0]!.przyslij(new ArrayBuffer(9));

    potwierdzenia[0]!(7n);
    expect(gniazda[0]!.wyslane).toEqual(["ack:7"]);
  });

  it("potwierdzenie na zamkniętym gnieździe nie wywraca się", () => {
    UdawaneGniazdo.otwarte = [];
    const zegar = udawanyZegar();
    const potwierdzenia: ((id: bigint) => void)[] = [];

    polaczZeSkrzynka({
      otworz: () => new UdawaneGniazdo() as unknown as WebSocket,
      naRamke: (_r, potwierdz) => void potwierdzenia.push(potwierdz),
      zegar: zegar.zegar,
    });

    const g = UdawaneGniazdo.otwarte[0]!;
    g.polacz();
    g.przyslij(new ArrayBuffer(9));
    g.zerwij();

    expect(() => potwierdzenia[0]!(7n)).not.toThrow();
  });

  /// Zamknięcie jest jawną decyzją — po nim nie wolno wracać, inaczej
  /// wylogowanie zostawiałoby połączenie żyjące w tle.
  it("po jawnym zamknięciu nie ma ponowień", () => {
    const { zegar, gniazda, polaczenie } = zestaw();

    gniazda[0]!.polacz();
    polaczenie.zamknij();
    gniazda[0]!.zerwij();

    expect(zegar.ilePonowien()).toBe(0);
    expect(zegar.ilePodtrzyman()).toBe(0);
    expect(gniazda).toHaveLength(1);
  });

  it("zgłasza stan połączenia", () => {
    const { stany, gniazda } = zestaw();

    gniazda[0]!.polacz();
    gniazda[0]!.zerwij();

    expect(stany).toEqual(["laczenie", "polaczone", "rozlaczone"]);
  });

  /// Ramki muszą przychodzić także po ponowieniu — inaczej naprawa dotyczyłaby
  /// tylko pierwszego połączenia.
  it("po ponownym połączeniu ramki nadal docierają", () => {
    const { zegar, ramki, gniazda } = zestaw();

    gniazda[0]!.polacz();
    gniazda[0]!.zerwij();
    zegar.tyknijPonowienia();

    gniazda[1]!.polacz();
    gniazda[1]!.przyslij(new ArrayBuffer(18));

    expect(ramki).toHaveLength(1);
  });
});
