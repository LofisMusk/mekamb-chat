import { ownSdpFingerprint, verifySdpFingerprint } from "../wasm/mekamb_wasm";
import { API_URL } from "./api";
import type { Messenger } from "./messenger";

/**
 * Rozmowy audio i wideo — dwuosobowe i grupowe.
 *
 * # Co chroni prywatność
 *
 * Media idą **bezpośrednio** między przeglądarkami przez WebRTC. Ale samo
 * „WebRTC jest szyfrowane" nie wystarcza: tożsamość drugiej strony sprowadza
 * się do odcisku certyfikatu DTLS zapisanego w SDP, a kto kontroluje
 * sygnalizację, ten może go podmienić i słuchać w środku.
 *
 * Dlatego odcisk podróżuje **wewnątrz kanału MLS**, niezależnie od SDP,
 * i jest porównywany przed zestawieniem połączenia. Niezgodność zrywa rozmowę
 * **bez pytania użytkownika**: pytanie przerzucałoby decyzję kryptograficzną
 * na osobę, która nie ma jak jej ocenić.
 *
 * # Topologia mesh, nie serwer mediów
 *
 * W rozmowie grupowej każda para uczestników zestawia **osobne** połączenie.
 * Nie ma serwera mediów, więc nie ma miejsca, w którym dałoby się podsłuchać
 * całą rozmowę naraz — ale przepustowość rośnie liniowo z liczbą osób.
 *
 * Przy pięciu uczestnikach każdy wysyłałby cztery strumienie w górę, co
 * przekracza typowe łącze domowe. Stąd twardy limit czterech osób.
 */

/** Maksymalna liczba uczestników rozmowy. Powyżej mesh przestaje działać. */
export const MAX_UCZESTNIKOW = 4;

/** Jak zestawiono połączenie z konkretnym uczestnikiem. */
export type CallRoute = "direct" | "relay" | "unknown";

export interface PeerState {
  username: string;
  faza: "laczenie" | "trwa" | "zakonczona";
  droga: CallRoute;
  /** Ustawiane, gdy połączenie zerwano przez niezgodny odcisk certyfikatu. */
  odrzuconyOdcisk?: boolean;
}

export interface CallState {
  wideo: boolean;
  uczestnicy: PeerState[];
}

interface IceServer {
  urls: string | string[];
  username?: string;
  credential?: string;
}

/**
 * Pobiera poświadczenia STUN/TURN z Workera.
 *
 * TURN jest potrzebny tylko wtedy, gdy obie strony siedzą za restrykcyjnym
 * NAT-em. Poświadczenia są krótkożyjące — trwały sekret w kliencie pozwalałby
 * dowolnej osobie zużywać nasz darmowy limit transferu.
 */
async function pobierzIceServers(token: string): Promise<IceServer[]> {
  try {
    const response = await fetch(`${API_URL}/calls/ice-servers`, {
      headers: { Authorization: `Bearer ${token}` },
    });

    if (response.ok) {
      const { iceServers } = (await response.json()) as { iceServers: IceServer[] };
      return iceServers;
    }
  } catch {
    // Brak TURN-a nie blokuje rozmowy — bez niego nie uda się tylko połączenie
    // między dwoma restrykcyjnymi NAT-ami.
  }

  return [{ urls: "stun:stun.cloudflare.com:3478" }];
}

/**
 * Połączenie z jednym uczestnikiem.
 *
 * W rozmowie dwuosobowej jest jedno, w grupowej po jednym na każdą inną osobę.
 */
class PeerLink {
  private pc: RTCPeerConnection;
  /** Kandydaci ICE, którzy przyszli przed ustawieniem opisu zdalnego. */
  private kolejkaIce: string[] = [];
  faza: PeerState["faza"] = "laczenie";
  droga: CallRoute = "unknown";
  odrzuconyOdcisk = false;

  private constructor(
    readonly username: string,
    pc: RTCPeerConnection,
    private readonly wyslijSygnal: (
      kind: "offer" | "answer" | "ice" | "hangup",
      payload: string,
      odcisk: string,
    ) => Promise<void>,
    private readonly onZmiana: () => void,
  ) {
    this.pc = pc;
  }

  static async utworz(
    username: string,
    lokalny: MediaStream,
    iceServers: IceServer[],
    wyslijSygnal: PeerLink["wyslijSygnal"],
    onZmiana: () => void,
    onStrumien: (username: string, stream: MediaStream) => void,
  ): Promise<PeerLink> {
    const pc = new RTCPeerConnection({ iceServers });
    const link = new PeerLink(username, pc, wyslijSygnal, onZmiana);

    for (const track of lokalny.getTracks()) {
      pc.addTrack(track, lokalny);
    }

    pc.ontrack = (event) => {
      const [stream] = event.streams;
      if (stream) onStrumien(username, stream);
    };

    pc.onicecandidate = (event) => {
      if (!event.candidate) return;
      void wyslijSygnal("ice", JSON.stringify(event.candidate.toJSON()), "");
    };

    pc.onconnectionstatechange = () => {
      if (pc.connectionState === "connected") {
        void link.ustalDroge();
      } else if (pc.connectionState === "failed" || pc.connectionState === "closed") {
        link.faza = "zakonczona";
        onZmiana();
      }
    };

    return link;
  }

  /** Wysyła ofertę — wołane przez stronę, która inicjuje tę parę. */
  async zaproponuj(): Promise<void> {
    const oferta = await this.pc.createOffer();
    await this.pc.setLocalDescription(oferta);

    await this.wyslijSygnal("offer", oferta.sdp ?? "", ownSdpFingerprint(oferta.sdp ?? ""));
  }

  /** Przetwarza sygnał od tego uczestnika. */
  async przyjmij(kind: string, payload: string, odciskZMls: string): Promise<void> {
    switch (kind) {
      case "offer": {
        this.sprawdzOdcisk(payload, odciskZMls);

        await this.pc.setRemoteDescription({ type: "offer", sdp: payload });
        await this.oproznijKolejkeIce();

        const odpowiedz = await this.pc.createAnswer();
        await this.pc.setLocalDescription(odpowiedz);

        await this.wyslijSygnal(
          "answer",
          odpowiedz.sdp ?? "",
          ownSdpFingerprint(odpowiedz.sdp ?? ""),
        );
        break;
      }

      case "answer": {
        this.sprawdzOdcisk(payload, odciskZMls);
        await this.pc.setRemoteDescription({ type: "answer", sdp: payload });
        await this.oproznijKolejkeIce();
        break;
      }

      case "ice": {
        // Kandydat może dotrzeć przed opisem zdalnym — wtedy czeka w kolejce.
        if (this.pc.remoteDescription) {
          await this.pc.addIceCandidate(JSON.parse(payload) as RTCIceCandidateInit);
        } else {
          this.kolejkaIce.push(payload);
        }
        break;
      }

      case "hangup":
        this.zamknij();
        break;
    }
  }

  zamknij(): void {
    this.pc.close();
    this.faza = "zakonczona";
    this.onZmiana();
  }

  stan(): PeerState {
    return {
      username: this.username,
      faza: this.faza,
      droga: this.droga,
      odrzuconyOdcisk: this.odrzuconyOdcisk || undefined,
    };
  }

  /**
   * Porównuje odcisk z SDP z tym, który przyszedł kanałem MLS.
   *
   * Niezgodność zrywa połączenie z tym uczestnikiem — bez pytania. W rozmowie
   * grupowej pozostali uczestnicy zostają, bo każda para ma osobne połączenie
   * i osobne zaufanie.
   */
  private sprawdzOdcisk(sdp: string, odciskZMls: string): void {
    try {
      verifySdpFingerprint(sdp, odciskZMls);
    } catch {
      this.odrzuconyOdcisk = true;
      this.zamknij();
      throw new Error(
        `odcisk certyfikatu od ${this.username} nie zgadza się z tym, który przyszedł ` +
          "zaszyfrowanym kanałem — połączenie zerwane",
      );
    }
  }

  private async oproznijKolejkeIce(): Promise<void> {
    const oczekujacy = this.kolejkaIce;
    this.kolejkaIce = [];

    for (const kandydat of oczekujacy) {
      await this.pc.addIceCandidate(JSON.parse(kandydat) as RTCIceCandidateInit).catch(() => {
        // Nieprawidłowy kandydat z sieci nie może przerwać zestawiania.
      });
    }
  }

  private async ustalDroge(): Promise<void> {
    const statystyki = await this.pc.getStats();

    statystyki.forEach((raport) => {
      if (raport.type === "candidate-pair" && raport.state === "succeeded") {
        const lokalny = statystyki.get(raport.localCandidateId) as
          | { candidateType?: string }
          | undefined;

        // Typ „relay" znaczy, że media idą przez TURN — wtedy adres IP widzi
        // przekaźnik zamiast rozmówcy.
        this.droga = lokalny?.candidateType === "relay" ? "relay" : "direct";
      }
    });

    this.faza = "trwa";
    this.onZmiana();
  }
}

/**
 * Rozmowa — jedna lub wiele osób.
 *
 * Obiekt żyje od wybrania numeru do rozłączenia i sam sprząta zasoby;
 * pozostawiony strumień z mikrofonu zostawiłby zapaloną diodę kamery.
 */
export class Call {
  private links = new Map<string, PeerLink>();
  private lokalny: MediaStream | null = null;
  private iceServers: IceServer[] = [];

  private constructor(
    private readonly messenger: Messenger,
    private readonly groupId: Uint8Array,
    readonly callId: Uint8Array,
    readonly wideo: boolean,
    private readonly onStan: (stan: CallState) => void,
    private readonly onStrumien: (username: string, stream: MediaStream) => void,
  ) {}

  /**
   * Rozpoczyna rozmowę z pozostałymi uczestnikami rozmowy tekstowej.
   *
   * Ofertę wysyłamy do **wszystkich naraz** — mesh nie ma centralnego węzła,
   * więc każdy z każdym.
   */
  static async rozpocznij(
    messenger: Messenger,
    groupId: Uint8Array,
    token: string,
    wideo: boolean,
    onStan: (stan: CallState) => void,
    onStrumien: (username: string, stream: MediaStream) => void,
  ): Promise<Call> {
    const uczestnicy = messenger
      .memberUserIds(groupId)
      .filter((osoba) => osoba !== messenger.account.userId);

    if (uczestnicy.length + 1 > MAX_UCZESTNIKOW) {
      throw new Error(
        `rozmowa obsługuje najwyżej ${MAX_UCZESTNIKOW} osób — przy większej liczbie ` +
          "każdy musiałby wysyłać tyle strumieni, ile jest pozostałych uczestników",
      );
    }

    const callId = crypto.getRandomValues(new Uint8Array(16));
    const call = new Call(messenger, groupId, callId, wideo, onStan, onStrumien);

    await call.przygotuj(token);

    for (const username of uczestnicy) {
      const link = await call.utworzLink(username);
      await link.zaproponuj();
    }

    call.powiadom();
    return call;
  }

  /** Odbiera rozmowę po nadejściu pierwszej oferty. */
  static async odbierz(
    messenger: Messenger,
    groupId: Uint8Array,
    token: string,
    callId: Uint8Array,
    wideo: boolean,
    onStan: (stan: CallState) => void,
    onStrumien: (username: string, stream: MediaStream) => void,
  ): Promise<Call> {
    const call = new Call(messenger, groupId, callId, wideo, onStan, onStrumien);
    await call.przygotuj(token);
    return call;
  }

  /**
   * Przetwarza sygnał odebrany kanałem MLS.
   *
   * Sygnały spoza tej rozmowy i adresowane do kogoś innego są pomijane:
   * wiadomości MLS trafiają do całej grupy, więc każdy widzi wszystko.
   */
  async przyjmijSygnal(
    od: string,
    kind: string,
    callId: Uint8Array,
    payload: string,
    odcisk: string,
    target: string,
  ): Promise<void> {
    if (!this.tenSamCall(callId)) return;
    if (target && target !== this.messenger.account.userId) return;
    if (od === this.messenger.account.userId) return;

    // Pierwsza oferta od nowej osoby tworzy połączenie z nią.
    let link = this.links.get(od);
    if (!link) {
      if (kind !== "offer") return;
      link = await this.utworzLink(od);
    }

    await link.przyjmij(kind, payload, odcisk);
    this.powiadom();
  }

  /** Kończy rozmowę i zwalnia mikrofon oraz kamerę. */
  zakoncz(powiadomPozostalych = true): void {
    if (powiadomPozostalych) {
      for (const username of this.links.keys()) {
        void this.messenger.sendCallSignal(
          this.groupId,
          "hangup",
          this.callId,
          "",
          "",
          username,
        );
      }
    }

    for (const link of this.links.values()) {
      link.zamknij();
    }
    this.links.clear();

    this.lokalny?.getTracks().forEach((track) => track.stop());
    this.lokalny = null;

    this.powiadom();
  }

  strumienLokalny(): MediaStream | null {
    return this.lokalny;
  }

  private tenSamCall(callId: Uint8Array): boolean {
    return (
      callId.length === this.callId.length &&
      callId.every((bajt, i) => bajt === this.callId[i])
    );
  }

  private async przygotuj(token: string): Promise<void> {
    this.lokalny = await navigator.mediaDevices.getUserMedia({
      audio: true,
      video: this.wideo,
    });

    this.iceServers = await pobierzIceServers(token);
  }

  private async utworzLink(username: string): Promise<PeerLink> {
    const link = await PeerLink.utworz(
      username,
      this.lokalny!,
      this.iceServers,
      (kind, payload, odcisk) =>
        this.messenger.sendCallSignal(
          this.groupId,
          kind,
          this.callId,
          payload,
          odcisk,
          username,
        ),
      () => this.powiadom(),
      this.onStrumien,
    );

    this.links.set(username, link);
    return link;
  }

  private powiadom(): void {
    this.onStan({
      wideo: this.wideo,
      uczestnicy: [...this.links.values()].map((l) => l.stan()),
    });
  }
}
