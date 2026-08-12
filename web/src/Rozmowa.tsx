import { useEffect, useRef, useState } from "react";

import { Ikona } from "./Ikony";
import { Call } from "./lib/calls";
import type { CallState } from "./lib/calls";
import type { Messenger } from "./lib/messenger";

/** Sygnalizacja odebrana kanałem MLS, przekazana do komponentu rozmowy. */
export interface SygnalRozmowy {
  kind: string;
  callId: Uint8Array;
  payload: string;
  dtlsFingerprint: string;
  /** Adresat — w rozmowie mesh każda para negocjuje osobno. */
  target: string;
  nadawca: string;
}

/** Prośba o rozpoczęcie rozmowy z nagłówka wątku. Licznik odróżnia kliknięcia. */
export interface ZadanieRozmowy {
  wideo: boolean;
  n: number;
}

/** Czas trwania jako `mm:ss` — godziny dopiero wtedy, gdy są. */
function trwanie(sekundy: number): string {
  const s = Math.max(0, Math.floor(sekundy));
  const minuty = Math.floor(s / 60);
  const reszta = String(s % 60).padStart(2, "0");

  if (minuty < 60) return `${minuty}:${reszta}`;
  return `${Math.floor(minuty / 60)}:${String(minuty % 60).padStart(2, "0")}:${reszta}`;
}

/**
 * Rozmowa audio i wideo — dwuosobowa albo grupowa.
 *
 * # Co widzi użytkownik i dlaczego
 *
 * Przy każdym uczestniku pokazujemy **drogę połączenia**: „bezpośrednio" znaczy,
 * że media idą wprost — i że ta osoba zna wtedy Twój adres IP. „Przez
 * przekaźnik" znaczy, że adres widzi serwer TURN. Milczenie sugerowałoby,
 * że nie ujawnia się nic.
 *
 * Rozmowa grupowa to topologia mesh: każda para ma osobne połączenie i osobne
 * zaufanie. Zerwanie jednego przez niezgodny odcisk certyfikatu nie kończy
 * rozmowy z pozostałymi.
 */
export function Rozmowa({
  messenger,
  groupId,
  sygnal,
  zadanie,
  onBlad,
}: {
  messenger: Messenger;
  groupId: Uint8Array;
  sygnal: SygnalRozmowy | null;
  zadanie: ZadanieRozmowy | null;
  onBlad: (e: unknown) => void;
}) {
  const [call, setCall] = useState<Call | null>(null);
  const [stan, setStan] = useState<CallState | null>(null);
  const [przychodzace, setPrzychodzace] = useState<SygnalRozmowy | null>(null);
  const strumienie = useRef(new Map<string, MediaStream>());
  const [wersjaStrumieni, setWersjaStrumieni] = useState(0);

  /*
   * Wyciszenie jest stanem WIDOKU, nie rdzenia.
   *
   * Gasimy ścieżkę w lokalnym strumieniu (`track.enabled = false`), więc nic
   * nie opuszcza urządzenia, a połączenie zostaje zestawione — inaczej niż przy
   * zerwaniu i odtworzeniu ścieżki, które kosztowałoby ponowną negocjację
   * z każdym uczestnikiem osobno.
   */
  const [mikrofon, setMikrofon] = useState(true);
  const [obraz, setObraz] = useState(true);

  const [odKiedy, setOdKiedy] = useState<number | null>(null);
  const [sekundy, setSekundy] = useState(0);

  const zapamietajStrumien = (username: string, stream: MediaStream) => {
    strumienie.current.set(username, stream);
    setWersjaStrumieni((n) => n + 1);
  };

  useEffect(() => {
    if (!sygnal) return;

    // Oferta, gdy nie mamy jeszcze rozmowy — to zaproszenie przychodzące.
    if (sygnal.kind === "offer" && !call) {
      setPrzychodzace(sygnal);
      return;
    }

    void call
      ?.przyjmijSygnal(
        sygnal.nadawca,
        sygnal.kind,
        sygnal.callId,
        sygnal.payload,
        sygnal.dtlsFingerprint,
        sygnal.target,
      )
      .catch(onBlad);
  }, [sygnal, call, onBlad]);

  /*
   * Prośba z nagłówka uruchamia rozmowę.
   *
   * Zależność na samym liczniku, nie na całym obiekcie: bez niego powtórne
   * kliknięcie „Zadzwoń" w tym samym trybie nie zmieniłoby referencji i nic by
   * się nie stało.
   */
  useEffect(() => {
    if (!zadanie || call) return;
    void zadzwon(zadanie.wideo);
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [zadanie?.n]);

  /*
   * Licznik czasu rozmowy.
   *
   * Liczony z chwili zestawienia, a nie przez dodawanie sekundy co sekundę:
   * karta w tle dostaje rzadsze tiki i licznik zaczynałby się spóźniać
   * o kilkanaście sekund na kwadrans rozmowy.
   */
  useEffect(() => {
    if (odKiedy === null) return;

    const tik = setInterval(() => setSekundy((Date.now() - odKiedy) / 1000), 500);
    return () => clearInterval(tik);
  }, [odKiedy]);

  const zadzwon = async (wideo: boolean) => {
    try {
      const nowa = await Call.rozpocznij(
        messenger,
        groupId,
        messenger.accessToken,
        wideo,
        setStan,
        zapamietajStrumien,
      );
      setCall(nowa);
      setOdKiedy(Date.now());
      setMikrofon(true);
      setObraz(true);
    } catch (err) {
      onBlad(err);
    }
  };

  const odbierz = async (wideo: boolean) => {
    if (!przychodzace) return;
    const zaproszenie = przychodzace;
    setPrzychodzace(null);

    try {
      const nowa = await Call.odbierz(
        messenger,
        groupId,
        messenger.accessToken,
        zaproszenie.callId,
        wideo,
        setStan,
        zapamietajStrumien,
      );
      setCall(nowa);
      setOdKiedy(Date.now());
      setMikrofon(true);
      setObraz(true);

      // Ofertę, która nas obudziła, trzeba przetworzyć po zestawieniu rozmowy.
      await nowa.przyjmijSygnal(
        zaproszenie.nadawca,
        zaproszenie.kind,
        zaproszenie.callId,
        zaproszenie.payload,
        zaproszenie.dtlsFingerprint,
        zaproszenie.target,
      );
    } catch (err) {
      // Najczęstsza przyczyna: odcisk certyfikatu nie zgadza się z tym,
      // który przyszedł zaszyfrowanym kanałem.
      onBlad(err);
    }
  };

  const rozlacz = () => {
    call?.zakoncz();
    setCall(null);
    setStan(null);
    setOdKiedy(null);
    setSekundy(0);
    strumienie.current.clear();
  };

  /** Gasi albo zapala ścieżki danego rodzaju w lokalnym strumieniu. */
  const przelacz = (rodzaj: "audio" | "video", wlaczone: boolean) => {
    const lokalny = call?.strumienLokalny();
    if (!lokalny) return;

    const sciezki = rodzaj === "audio" ? lokalny.getAudioTracks() : lokalny.getVideoTracks();
    for (const sciezka of sciezki) sciezka.enabled = wlaczone;
  };

  if (przychodzace) {
    return (
      <section className="przychodzaca">
        <div className="rozmowa-stan">
          <strong>{przychodzace.nadawca} dzwoni</strong>
          <span className="wskazowka">Szyfrowane end-to-end, tak jak wiadomości.</span>
        </div>

        <div className="rzad-przyciskow">
          <button className="glowny" onClick={() => void odbierz(false)}>
            <Ikona nazwa="sluchawka" rozmiar={16} />
            Odbierz
          </button>
          <button onClick={() => void odbierz(true)}>
            <Ikona nazwa="kamera" rozmiar={16} />
            Z obrazem
          </button>
          <button className="niszczacy" onClick={() => setPrzychodzace(null)}>
            <Ikona nazwa="rozlacz" rozmiar={16} />
            Odrzuć
          </button>
        </div>
      </section>
    );
  }

  // Bez trwającej rozmowy ten komponent nie ma nic do pokazania: przyciski
  // startu stoją w nagłówku wątku, tam gdzie w projekcie.
  if (!call) return null;

  const uczestnicy = stan?.uczestnicy ?? [];
  const zerwane = uczestnicy.filter((u) => u.odrzuconyOdcisk).length;

  return (
    <section aria-label="Trwająca rozmowa">
      <div className="rozmowa-pasek">
        <Ikona nazwa={call.wideo ? "kamera" : "sluchawka"} rozmiar={17} />

        <span className="rozmowa-stan">
          <strong>{opisRozmowy(uczestnicy)}</strong>
          <span className="czas">{trwanie(sekundy)}</span>
        </span>

        <span className="rozmowa-akcje">
          <button
            className={mikrofon ? undefined : "aktywny"}
            title={mikrofon ? "Wycisz mikrofon" : "Włącz mikrofon"}
            aria-pressed={!mikrofon}
            onClick={() => {
              przelacz("audio", !mikrofon);
              setMikrofon((m) => !m);
            }}
          >
            <Ikona nazwa={mikrofon ? "mikrofon" : "mikrofonWyciszony"} rozmiar={17} />
            <span className="tylko-dla-czytnika">
              {mikrofon ? "Wycisz mikrofon" : "Włącz mikrofon"}
            </span>
          </button>

          {call.wideo && (
            <button
              className={obraz ? undefined : "aktywny"}
              title={obraz ? "Wyłącz obraz" : "Włącz obraz"}
              aria-pressed={!obraz}
              onClick={() => {
                przelacz("video", !obraz);
                setObraz((o) => !o);
              }}
            >
              <Ikona nazwa={obraz ? "kamera" : "kameraWylaczona"} rozmiar={17} />
              <span className="tylko-dla-czytnika">{obraz ? "Wyłącz obraz" : "Włącz obraz"}</span>
            </button>
          )}

          <button className="rozlacz" title="Rozłącz" onClick={rozlacz}>
            <Ikona nazwa="rozlacz" rozmiar={17} />
            <span className="tylko-dla-czytnika">Rozłącz</span>
          </button>
        </span>
      </div>

      {/*
        Droga połączenia przy każdej osobie, nie w ustawieniach.

        „Bezpośrednio" to zdanie o tym, że rozmówca zna Twój adres IP. Schowane
        w ustawieniach byłoby informacją, której nikt nigdy nie zobaczy.
      */}
      <ul className="lista-osob">
        {uczestnicy.map((uczestnik) => (
          <li key={uczestnik.username}>
            <span className="kto">{uczestnik.username}</span>
            {uczestnik.odrzuconyOdcisk ? (
              <span className="tryb uwaga">
                <Ikona nazwa="ostrzezenie" rozmiar={12} />
                zerwane — obcy certyfikat
              </span>
            ) : uczestnik.faza === "laczenie" ? (
              <span className="tryb">
                <Ikona nazwa="zegar" rozmiar={12} />
                łączę…
              </span>
            ) : uczestnik.faza === "trwa" ? (
              <span
                className="tryb"
                title={
                  uczestnik.droga === "relay"
                    ? "Media idą przez serwer TURN — to on zna oba adresy IP."
                    : "Media idą wprost — ta osoba zna Twój adres IP."
                }
              >
                <Ikona
                  nazwa={uczestnik.droga === "relay" ? "przezSerwer" : "bezposrednio"}
                  rozmiar={12}
                />
                {uczestnik.droga === "relay" ? "przez przekaźnik" : "bezpośrednio"}
              </span>
            ) : (
              <span className="tryb">
                <Ikona nazwa="brakSieci" rozmiar={12} />
                rozłączony
              </span>
            )}
          </li>
        ))}
      </ul>

      {zerwane > 0 && (
        <p className="wskazowka">
          Połączenie z {zerwane === 1 ? "jedną osobą" : `${zerwane} osobami`} zostało zerwane,
          bo certyfikat nie zgadzał się z odciskiem przysłanym zaszyfrowanym kanałem. Rozmowa
          z pozostałymi trwa dalej.
        </p>
      )}

      {call.wideo && strumienie.current.size > 0 && (
        <div className="siatka-wideo">
          {[...strumienie.current.entries()].map(([username, stream]) => (
            <WideoUczestnika key={`${username}-${wersjaStrumieni}`} stream={stream} />
          ))}
        </div>
      )}

      {!call.wideo &&
        [...strumienie.current.entries()].map(([username, stream]) => (
          <AudioUczestnika key={`${username}-${wersjaStrumieni}`} stream={stream} />
        ))}
    </section>
  );
}

/** Jednym zdaniem: z kim rozmawiamy albo na kogo czekamy. */
function opisRozmowy(uczestnicy: CallState["uczestnicy"]): string {
  const trwa = uczestnicy.filter((u) => u.faza === "trwa" && !u.odrzuconyOdcisk);

  if (trwa.length === 0) return "Łączę…";
  if (trwa.length === 1) return `Rozmowa z ${trwa[0]?.username}`;
  return `Rozmowa · ${trwa.length} osób`;
}

/** Obraz jednego uczestnika. */
function WideoUczestnika({ stream }: { stream: MediaStream }) {
  const ref = useRef<HTMLVideoElement | null>(null);

  useEffect(() => {
    if (ref.current) ref.current.srcObject = stream;
  }, [stream]);

  return <video ref={ref} autoPlay playsInline className="rozmowa-wideo" />;
}

/** Dźwięk jednego uczestnika — bez elementu nie byłoby go słychać. */
function AudioUczestnika({ stream }: { stream: MediaStream }) {
  const ref = useRef<HTMLAudioElement | null>(null);

  useEffect(() => {
    if (ref.current) ref.current.srcObject = stream;
  }, [stream]);

  return <audio ref={ref} autoPlay />;
}
