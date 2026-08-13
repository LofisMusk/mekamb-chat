import { useEffect, useRef, useState } from "react";

import { Ikona } from "./Ikony";
import { Call } from "./lib/calls";
import type { CallState, PeerState } from "./lib/calls";
import type { ZapisRozmowy } from "./lib/historia";
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
  onZdarzenie,
  onBlad,
}: {
  messenger: Messenger;
  groupId: Uint8Array;
  sygnal: SygnalRozmowy | null;
  zadanie: ZadanieRozmowy | null;
  /** Zgłasza ślad po rozmowie do wątku — patrz `ZapisRozmowy` w `historia.ts`. */
  onZdarzenie: (zapis: ZapisRozmowy) => void;
  onBlad: (e: unknown) => void;
}) {
  const [call, setCall] = useState<Call | null>(null);
  const [stan, setStan] = useState<CallState | null>(null);
  const [przychodzace, setPrzychodzace] = useState<SygnalRozmowy | null>(null);

  /*
   * Strumienie w STANIE, nie w referencji z licznikiem.
   *
   * Wcześniej mapa leżała w `useRef`, a przerysowanie wymuszał rosnący licznik
   * wpleciony w klucz elementu `<video>`. Klucz zmieniał się przy każdej
   * zmianie czyjegokolwiek strumienia, więc React odmontowywał i montował
   * WSZYSTKIE podglądy naraz — obraz każdego uczestnika gasł do czerni
   * i zapalał się od nowa za każdym razem, gdy ktokolwiek dołączył.
   *
   * Zwykła mapa w stanie wystarcza: strumień jednej osoby jest tym samym
   * obiektem przez całą rozmowę (WebRTC dokłada do niego ścieżki, a nie
   * podmienia go), więc element wideo nie ma powodu się przemontować.
   */
  const [strumienie, setStrumienie] = useState<ReadonlyMap<string, MediaStream>>(new Map());

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

  /*
   * Kto dzwonił. Przez referencję, bo to nie wpływa na wygląd — służy
   * wyłącznie do rozstrzygnięcia, czy nieodebrana rozmowa była „nasza"
   * (nikt nie odebrał), czy „ich" (nie odebraliśmy).
   */
  const wychodzaca = useRef(true);

  const zapamietajStrumien = (username: string, stream: MediaStream) => {
    setStrumienie((poprzednie) => {
      // Ten sam strumień przychodzi ponownie przy każdej renegocjacji (np. gdy
      // ktoś włączy kamerę). Nowa mapa z tą samą zawartością to przerysowanie
      // bez powodu.
      if (poprzednie.get(username) === stream) return poprzednie;
      return new Map(poprzednie).set(username, stream);
    });
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
    wychodzaca.current = true;
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
    wychodzaca.current = false;

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

  /**
   * Kończy rozmowę i zostawia po niej ślad w wątku.
   *
   * Czas liczymy od chwili ZESTAWIENIA, nie od naciśnięcia „zadzwoń": sekundy
   * dzwonienia nie są rozmową i doliczone do niej dawałyby przy nieodebranym
   * połączeniu „rozmowa · 0:24", czyli zdanie wprost nieprawdziwe.
   *
   * Rozmowa, której nikt nie odebrał, nie ma czasu trwania — i to jest różnica
   * między brakiem a zerem: zero znaczyłoby „odebrana i natychmiast przerwana".
   */
  const rozlacz = () => {
    const ktos = (stan?.uczestnicy ?? []).some((u) => u.faza === "trwa");

    onZdarzenie({
      wideo: stan?.wideo ?? false,
      sekundy: ktos ? Math.floor(sekundy) : undefined,
      wychodzaca: wychodzaca.current,
    });

    call?.zakoncz();
    setCall(null);
    setStan(null);
    setOdKiedy(null);
    setSekundy(0);
    setStrumienie(new Map());
  };

  /** Gasi albo zapala ścieżki danego rodzaju w lokalnym strumieniu. */
  const przelacz = (rodzaj: "audio" | "video", wlaczone: boolean) => {
    const lokalny = call?.strumienLokalny();
    if (!lokalny) return;

    const sciezki = rodzaj === "audio" ? lokalny.getAudioTracks() : lokalny.getVideoTracks();
    for (const sciezka of sciezki) sciezka.enabled = wlaczone;
  };

  /**
   * Przycisk kamery — jeden, dwa różne działania.
   *
   * Gdy obraz już idzie, gasimy ścieżkę: nic nie opuszcza urządzenia, a żadne
   * połączenie nie jest negocjowane od nowa. Gdy ścieżki nie ma — bo rozmowa
   * zaczęła się jako głosowa — trzeba dobrać kamerę i renegocjować z każdym
   * uczestnikiem, czym zajmuje się `Call.wlaczKamere`.
   */
  const przelaczKamere = async () => {
    if (!call) return;

    if (call.maWideo()) {
      przelacz("video", !obraz);
      setObraz((o) => !o);
      return;
    }

    try {
      await call.wlaczKamere();
      setObraz(true);
    } catch (err) {
      // Najczęściej: odmowa dostępu do kamery albo zajęta przez inną aplikację.
      onBlad(err);
    }
  };

  if (przychodzace) {
    return (
      <section className="przychodzaca">
        <div className="rozmowa-stan">
          <strong>{przychodzace.nadawca} dzwoni</strong>
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
          <button
            className="niszczacy"
            onClick={() => {
              // Odrzucona rozmowa zostaje w wątku. Zniknięcie bez śladu znaczy,
              // że po odłożeniu telefonu nie da się już sprawdzić, kto dzwonił.
              onZdarzenie({ wideo: false, wychodzaca: false });
              setPrzychodzace(null);
            }}
          >
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

  /*
   * Czy z tego urządzenia w ogóle wychodzi obraz.
   *
   * Ze STANU rozmowy, a nie z trybu, w którym się zaczęła: po włączeniu kamery
   * w rozmowie głosowej `call.wideo` dalej mówi „to rozmowa audio", więc ikona
   * i podgląd zostałyby przy nieaktualnej odpowiedzi.
   */
  const maObraz = stan?.wideo ?? false;

  return (
    <section aria-label="Trwająca rozmowa">
      <div className="rozmowa-pasek">
        <Ikona nazwa={maObraz ? "kamera" : "sluchawka"} rozmiar={17} />

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

          {/*
            Przycisk kamery jest ZAWSZE, także w rozmowie głosowej.

            Wcześniej pojawiał się tylko wtedy, gdy rozmowa zaczęła się
            z obrazem — czyli decyzja podjęta w chwili dzwonienia była
            ostateczna, mimo że sprzęt pozwala ją zmienić w każdej sekundzie.
          */}
          <button
            className={maObraz ? undefined : "aktywny"}
            title={maObraz ? "Wyłącz obraz" : "Włącz kamerę"}
            aria-pressed={!maObraz}
            onClick={() => void przelaczKamere()}
          >
            <Ikona nazwa={maObraz ? "kamera" : "kameraWylaczona"} rozmiar={17} />
            <span className="tylko-dla-czytnika">
              {maObraz ? "Wyłącz obraz" : "Włącz kamerę"}
            </span>
          </button>

          <button className="rozlacz" title="Rozłącz" onClick={rozlacz}>
            <Ikona nazwa="rozlacz" rozmiar={17} />
            <span className="tylko-dla-czytnika">Rozłącz</span>
          </button>
        </span>
      </div>

      {/*
        Kafelki: ja i wszyscy, z którymi rozmawiam, w jednej siatce.

        Wcześniej były dwie osobne rzeczy — lista nazwisk i siatka obrazów bez
        podpisów — więc nie dało się powiedzieć, czyj obraz się właśnie widzi,
        a własnego podglądu nie było wcale. Kafelek łączy jedno z drugim:
        obraz albo awatar, nazwa i droga połączenia w jednym miejscu.

        Droga połączenia ZOSTAJE przy każdej osobie z osobna. „Bezpośrednio" to
        zdanie o tym, że ta osoba zna Twój adres IP, a w rozmowie mesh każda
        para negocjuje osobno — jedna etykieta na całą rozmowę byłaby nieprawdą
        wobec połowy uczestników.
      */}
      <div className="siatka-kafelkow" data-ilu={Math.min(uczestnicy.length + 1, 4)}>
        <Kafelek
          nazwa="Ty"
          stream={call.strumienLokalny()}
          wlasny
          obrazWlaczony={maObraz && obraz}
        />

        {uczestnicy.map((uczestnik) => (
          <Kafelek
            key={uczestnik.username}
            nazwa={uczestnik.username}
            stream={strumienie.get(uczestnik.username) ?? null}
            uczestnik={uczestnik}
            obrazWlaczony
          />
        ))}
      </div>

      {zerwane > 0 && (
        <p className="wskazowka">
          Połączenie z {zerwane === 1 ? "jedną osobą" : `${zerwane} osobami`} zostało zerwane,
          bo certyfikat nie zgadzał się z odciskiem przysłanym zaszyfrowanym kanałem. Rozmowa
          z pozostałymi trwa dalej.
        </p>
      )}
    </section>
  );
}

/** Co pokazać pod nazwą uczestnika: stan połączenia albo drogę, którą idą media. */
function StanUczestnika({ uczestnik }: { uczestnik: PeerState }) {
  if (uczestnik.odrzuconyOdcisk) {
    return (
      <span className="tryb uwaga">
        <Ikona nazwa="ostrzezenie" rozmiar={12} />
        obcy certyfikat
      </span>
    );
  }

  if (uczestnik.faza === "laczenie") {
    return (
      <span className="tryb">
        <Ikona nazwa="zegar" rozmiar={12} />
        łączę…
      </span>
    );
  }

  if (uczestnik.faza !== "trwa") {
    return (
      <span className="tryb">
        <Ikona nazwa="brakSieci" rozmiar={12} />
        rozłączony
      </span>
    );
  }

  const przekaznik = uczestnik.droga === "relay";

  return (
    <span
      className="tryb"
      title={
        przekaznik
          ? "Media idą przez serwer TURN — to on zna oba adresy IP."
          : "Media idą wprost — ta osoba zna Twój adres IP."
      }
    >
      <Ikona nazwa={przekaznik ? "przezSerwer" : "bezposrednio"} rozmiar={12} />
      {przekaznik ? "przez przekaźnik" : "bezpośrednio"}
    </span>
  );
}

/**
 * Jeden uczestnik rozmowy: obraz albo awatar, nazwa i droga połączenia.
 *
 * # Dlaczego element wideo stoi tu zawsze
 *
 * Bo to on odtwarza DŹWIĘK. Gdyby pojawiał się dopiero wraz z obrazem,
 * włączenie kamery w trakcie rozmowy montowałoby go od nowa i przerywało
 * dźwięk w chwili, w której nikt się tego nie spodziewa. Zamiast tego element
 * jest od początku, a awatar przykrywa go, dopóki nie ma czego pokazać.
 */
function Kafelek({
  nazwa,
  stream,
  uczestnik,
  wlasny = false,
  obrazWlaczony,
}: {
  nazwa: string;
  stream: MediaStream | null;
  uczestnik?: PeerState;
  wlasny?: boolean;
  obrazWlaczony: boolean;
}) {
  const ref = useRef<HTMLVideoElement | null>(null);
  const [maSciezke, setMaSciezke] = useState(false);

  useEffect(() => {
    const element = ref.current;
    if (element && element.srcObject !== stream) element.srcObject = stream;

    if (!stream) {
      setMaSciezke(false);
      return;
    }

    /*
     * Ścieżka wideo potrafi dojść PO strumieniu.
     *
     * Tak wygląda włączenie kamery w trakcie rozmowy: strumień jest ten sam od
     * początku, a ścieżka dokłada się do niego po renegocjacji. Jednorazowe
     * sprawdzenie przy montowaniu pokazywałoby wtedy awatar nad działającym
     * obrazem do końca rozmowy.
     */
    const sprawdz = () => setMaSciezke(stream.getVideoTracks().length > 0);
    sprawdz();

    stream.addEventListener("addtrack", sprawdz);
    stream.addEventListener("removetrack", sprawdz);

    return () => {
      stream.removeEventListener("addtrack", sprawdz);
      stream.removeEventListener("removetrack", sprawdz);
    };
  }, [stream]);

  const widacObraz = maSciezke && obrazWlaczony;

  return (
    <div className={widacObraz ? "kafelek z-obrazem" : "kafelek"}>
      <video
        ref={ref}
        autoPlay
        playsInline
        // Własny podgląd MUSI być wyciszony — inaczej słychać siebie z opóźnieniem
        // i rozmowa staje się nie do prowadzenia.
        muted={wlasny}
        // Lustrzany tylko własny: tak wygląda odbicie w lustrze, do którego
        // wszyscy są przyzwyczajeni. Obraz rozmówcy odbity byłby po prostu
        // odwrócony — z napisami czytanymi od tyłu włącznie.
        className={wlasny ? "obraz-kafelka odbity" : "obraz-kafelka"}
      />

      {!widacObraz && (
        <span className="awatar" aria-hidden="true">
          {nazwa.slice(0, 1)}
        </span>
      )}

      <span className="podpis-kafelka">
        <span className="kto">{nazwa}</span>
        {uczestnik && <StanUczestnika uczestnik={uczestnik} />}
      </span>
    </div>
  );
}

/** Jednym zdaniem: z kim rozmawiamy albo na kogo czekamy. */
function opisRozmowy(uczestnicy: CallState["uczestnicy"]): string {
  const trwa = uczestnicy.filter((u) => u.faza === "trwa" && !u.odrzuconyOdcisk);

  if (trwa.length === 0) return "Łączę…";
  if (trwa.length === 1) return `Rozmowa z ${trwa[0]?.username}`;
  return `Rozmowa · ${trwa.length} osób`;
}

/*
 * `WideoUczestnika` i `AudioUczestnika` zniknęły — zastąpił je `Kafelek`.
 *
 * Były dwoma składnikami robiącymi to samo (podpięcie strumienia do elementu),
 * wybieranymi na podstawie trybu rozmowy. Odkąd tryb zmienia się w trakcie,
 * ten wybór musiałby przemontowywać element w połowie rozmowy — czyli urywać
 * dźwięk dokładnie wtedy, gdy ktoś włącza kamerę.
 */
