import { ownSdpFingerprint, verifySdpFingerprint } from "../wasm/mekamb_wasm";
import { API_URL } from "./api";
import type { Messenger } from "./messenger";

/**
 * Rozmowy audio i wideo.
 *
 * # Co tu chroni prywatność
 *
 * Media idą **bezpośrednio** między przeglądarkami przez WebRTC — serwer ich
 * nie widzi i nie przechowuje. Ale samo „WebRTC jest szyfrowane" nie wystarcza:
 * tożsamość drugiej strony sprowadza się do odcisku certyfikatu DTLS zapisanego
 * w SDP, a kto kontroluje sygnalizację, ten może go podmienić i słuchać
 * w środku.
 *
 * Dlatego odcisk podróżuje **wewnątrz kanału MLS**, niezależnie od SDP,
 * i jest porównywany przed zestawieniem połączenia. Niezgodność zrywa rozmowę
 * **bez pytania użytkownika**: pytanie przerzucałoby decyzję kryptograficzną
 * na osobę, która nie ma jak jej ocenić.
 *
 * # Czego nie chroni
 *
 * Połączenie bezpośrednie ujawnia Twój adres IP rozmówcy. Przy połączeniu przez
 * TURN adres widzi serwer przekaźnikowy zamiast rozmówcy. Jedno albo drugie —
 * interfejs pokazuje, które.
 */

/** Jak zestawiono połączenie — pokazywane użytkownikowi. */
export type CallRoute = "direct" | "relay" | "unknown";

export interface CallState {
  /** `"dzwoni"`, `"łączę"`, `"trwa"`, `"zakończona"`. */
  faza: "dzwoni" | "laczenie" | "trwa" | "zakonczona";
  /** Czy rozmowa ma obraz. */
  wideo: boolean;
  droga: CallRoute;
  /** Ustawiane, gdy połączenie zerwano z powodu niezgodnego odcisku. */
  odrzuconyOdcisk?: boolean;
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
 * Jedna rozmowa.
 *
 * Obiekt żyje od wybrania numeru do rozłączenia i sam sprząta zasoby —
 * pozostawiony strumień z mikrofonu zostawiłby zapaloną diodę kamery.
 */
export class Call {
  private pc: RTCPeerConnection | null = null;
  private lokalny: MediaStream | null = null;
  /** Kandydaci ICE, które przyszły przed ustawieniem opisu zdalnego. */
  private kolejkaIce: string[] = [];

  private constructor(
    private readonly messenger: Messenger,
    private readonly groupId: Uint8Array,
    readonly callId: Uint8Array,
    readonly wideo: boolean,
    private readonly onStan: (stan: CallState) => void,
    private readonly onZdalnyStrumien: (stream: MediaStream) => void,
  ) {}

  /** Dzwoni do rozmówcy. */
  static async zadzwon(
    messenger: Messenger,
    groupId: Uint8Array,
    token: string,
    wideo: boolean,
    onStan: (stan: CallState) => void,
    onZdalnyStrumien: (stream: MediaStream) => void,
  ): Promise<Call> {
    const callId = crypto.getRandomValues(new Uint8Array(16));
    const call = new Call(messenger, groupId, callId, wideo, onStan, onZdalnyStrumien);

    await call.przygotuj(token);
    const oferta = await call.pc!.createOffer();
    await call.pc!.setLocalDescription(oferta);

    // Odcisk własnego certyfikatu wysyłamy kanałem MLS, obok SDP. Odbiorca
    // porówna jedno z drugim.
    await messenger.sendCallSignal(
      groupId,
      "offer",
      callId,
      oferta.sdp ?? "",
      ownSdpFingerprint(oferta.sdp ?? ""),
    );

    call.onStan({ faza: "dzwoni", wideo, droga: "unknown" });
    return call;
  }

  /** Odbiera połączenie przychodzące. */
  static async odbierz(
    messenger: Messenger,
    groupId: Uint8Array,
    token: string,
    callId: Uint8Array,
    ofertaSdp: string,
    odciskZMls: string,
    wideo: boolean,
    onStan: (stan: CallState) => void,
    onZdalnyStrumien: (stream: MediaStream) => void,
  ): Promise<Call> {
    const call = new Call(messenger, groupId, callId, wideo, onStan, onZdalnyStrumien);

    // Weryfikacja PRZED zestawieniem czegokolwiek. Gdybyśmy najpierw ustawili
    // opis zdalny, a dopiero potem sprawdzali, przez chwilę istniałoby
    // połączenie z niezweryfikowaną stroną.
    call.sprawdzOdcisk(ofertaSdp, odciskZMls);

    await call.przygotuj(token);
    await call.pc!.setRemoteDescription({ type: "offer", sdp: ofertaSdp });
    await call.oproznijKolejkeIce();

    const odpowiedz = await call.pc!.createAnswer();
    await call.pc!.setLocalDescription(odpowiedz);

    await messenger.sendCallSignal(
      groupId,
      "answer",
      callId,
      odpowiedz.sdp ?? "",
      ownSdpFingerprint(odpowiedz.sdp ?? ""),
    );

    call.onStan({ faza: "laczenie", wideo, droga: "unknown" });
    return call;
  }

  /** Przetwarza sygnał odebrany kanałem MLS. */
  async przyjmijSygnal(kind: string, payload: string, odciskZMls: string): Promise<void> {
    if (!this.pc) return;

    switch (kind) {
      case "answer": {
        this.sprawdzOdcisk(payload, odciskZMls);
        await this.pc.setRemoteDescription({ type: "answer", sdp: payload });
        await this.oproznijKolejkeIce();
        break;
      }

      case "ice": {
        // Kandydat może dotrzeć przed odpowiedzią — wtedy czeka w kolejce.
        if (this.pc.remoteDescription) {
          await this.pc.addIceCandidate(JSON.parse(payload) as RTCIceCandidateInit);
        } else {
          this.kolejkaIce.push(payload);
        }
        break;
      }

      case "hangup":
        this.zakoncz();
        break;
    }
  }

  /** Kończy rozmowę i zwalnia mikrofon oraz kamerę. */
  zakoncz(powiadomDrugaStrone = false): void {
    if (powiadomDrugaStrone && this.pc) {
      void this.messenger.sendCallSignal(this.groupId, "hangup", this.callId, "", "");
    }

    this.lokalny?.getTracks().forEach((track) => track.stop());
    this.pc?.close();

    this.pc = null;
    this.lokalny = null;

    this.onStan({ faza: "zakonczona", wideo: this.wideo, droga: "unknown" });
  }

  /** Strumień z mikrofonu i kamery — do podglądu własnego obrazu. */
  strumienLokalny(): MediaStream | null {
    return this.lokalny;
  }

  private async przygotuj(token: string): Promise<void> {
    this.lokalny = await navigator.mediaDevices.getUserMedia({
      audio: true,
      video: this.wideo,
    });

    this.pc = new RTCPeerConnection({ iceServers: await pobierzIceServers(token) });

    for (const track of this.lokalny.getTracks()) {
      this.pc.addTrack(track, this.lokalny);
    }

    this.pc.ontrack = (event) => {
      const [stream] = event.streams;
      if (stream) this.onZdalnyStrumien(stream);
    };

    this.pc.onicecandidate = (event) => {
      if (!event.candidate) return;

      void this.messenger.sendCallSignal(
        this.groupId,
        "ice",
        this.callId,
        JSON.stringify(event.candidate.toJSON()),
        "",
      );
    };

    this.pc.onconnectionstatechange = () => {
      if (!this.pc) return;

      if (this.pc.connectionState === "connected") {
        void this.ustalDroge();
      } else if (this.pc.connectionState === "failed") {
        this.zakoncz();
      }
    };
  }

  /**
   * Porównuje odcisk z SDP z tym, który przyszedł kanałem MLS.
   *
   * Niezgodność zrywa rozmowę bez pytania — patrz komentarz na górze pliku.
   */
  private sprawdzOdcisk(sdp: string, odciskZMls: string): void {
    try {
      verifySdpFingerprint(sdp, odciskZMls);
    } catch {
      this.onStan({
        faza: "zakonczona",
        wideo: this.wideo,
        droga: "unknown",
        odrzuconyOdcisk: true,
      });
      this.zakoncz();
      throw new Error(
        "odcisk certyfikatu nie zgadza się z tym, który przyszedł zaszyfrowanym kanałem — " +
          "połączenie zerwane",
      );
    }
  }

  private async oproznijKolejkeIce(): Promise<void> {
    const oczekujacy = this.kolejkaIce;
    this.kolejkaIce = [];

    for (const kandydat of oczekujacy) {
      await this.pc?.addIceCandidate(JSON.parse(kandydat) as RTCIceCandidateInit).catch(() => {
        // Nieprawidłowy kandydat z sieci nie może przerwać zestawiania połączenia.
      });
    }
  }

  /** Ustala, czy połączenie idzie wprost, czy przez przekaźnik. */
  private async ustalDroge(): Promise<void> {
    if (!this.pc) return;

    let droga: CallRoute = "unknown";

    const statystyki = await this.pc.getStats();
    statystyki.forEach((raport) => {
      if (raport.type === "candidate-pair" && raport.state === "succeeded") {
        // Raport statystyk, nie obiekt RTCIceCandidate — pole `candidateType`
        // istnieje tylko w tej pierwszej postaci.
        const lokalny = statystyki.get(raport.localCandidateId) as
          | { candidateType?: string }
          | undefined;

        // Typ „relay" znaczy, że media idą przez TURN — wtedy adres IP widzi
        // przekaźnik zamiast rozmówcy.
        droga = lokalny?.candidateType === "relay" ? "relay" : "direct";
      }
    });

    this.onStan({ faza: "trwa", wideo: this.wideo, droga });
  }
}
