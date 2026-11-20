import { useCallback, useEffect, useRef, useState } from "react";

import { Ikona, type NazwaIkony } from "./Ikony";
import { Awatar } from "./components/ui/avatar";
import { cn } from "./components/ui/cn";
import { t } from "./lib/jezyk";
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
  onAktywnosc,
  onBlad,
}: {
  messenger: Messenger;
  groupId: Uint8Array;
  sygnal: SygnalRozmowy | null;
  zadanie: ZadanieRozmowy | null;
  /** Zgłasza ślad po rozmowie do wątku — patrz `ZapisRozmowy` w `historia.ts`. */
  onZdarzenie: (zapis: ZapisRozmowy) => void;
  /**
   * Mówi wyżej, czy rozmowa zajmuje ekran.
   *
   * Rozmowa jest OSOBNYM ekranem, a nie paskiem doklejonym nad wątkiem —
   * więc ktoś musi wiedzieć, że reszty układu nie należy w tej chwili rysować.
   * Ta wiedza jest tutaj (tu powstaje rozmowa), a decyzja o układzie wyżej.
   */
  onAktywnosc: (aktywna: boolean) => void;
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

  /**
   * Czy rozmowa doszła do skutku — choćby na sekundę, choćby z jedną osobą.
   *
   * Zapalane raz i nigdy nie gaszone przed końcem rozmowy: rozłączenie czyta
   * je już po tym, jak wszystkie połączenia są zamknięte, więc odczyt bieżącego
   * stanu odpowiadałby zawsze „nikogo nie było".
   */
  const zestawiona = useRef(false);

  /**
   * Przyjmuje migawkę rozmowy i zapala znacznik zestawienia.
   *
   * Jedno miejsce dla obu dróg wejścia w rozmowę — dzwonienia i odbierania.
   * Osobne zapalanie w każdej z nich byłoby tą samą regułą napisaną dwa razy,
   * a różnica między kopiami ujawniałaby się tylko po jednej stronie łącza.
   */
  const zapamietajStan = (migawka: CallState) => {
    if (migawka.uczestnicy.some((u) => u.faza === "trwa")) zestawiona.current = true;
    setStan(migawka);
  };

  const zapamietajStrumien = (username: string, stream: MediaStream) => {
    setStrumienie((poprzednie) => {
      // Ten sam strumień przychodzi ponownie przy każdej renegocjacji (np. gdy
      // ktoś włączy kamerę). Nowa mapa z tą samą zawartością to przerysowanie
      // bez powodu.
      if (poprzednie.get(username) === stream) return poprzednie;
      return new Map(poprzednie).set(username, stream);
    });
  };

  /**
   * Sygnały, które przyszły, zanim ktokolwiek odebrał.
   *
   * # Dlaczego bez tego rozmowa się nie zestawiała
   *
   * Dzwoniący wysyła ofertę i NATYCHMIAST zaczyna sypać kandydatami ICE —
   * `onicecandidate` odzywa się zaraz po `setLocalDescription`, a nie po
   * odebraniu. Po tej stronie przez te kilka sekund `call` jest jeszcze `null`,
   * bo na ekranie stoi pytanie „odebrać?". Wcześniejsze `call?.przyjmijSygnal`
   * po cichu wyrzucało więc do kosza KAŻDEGO kandydata dzwoniącego.
   *
   * Gdy w końcu ktoś odebrał, dzwoniący miał już zebrane wszystko, co miał do
   * zebrania, i nie nadawał tego drugi raz. Zostawało połączenie znające
   * kandydatów tylko jednej strony — czyli takie, które nigdy się nie zestawi.
   * Z zewnątrz wyglądało to dokładnie jak „dzwonienie nie działa": rozmowa
   * ruszała, licznik szedł, i nikt nikogo nie słyszał.
   *
   * Kolejka jest w referencji, nie w stanie: dołożenie kandydata nie ma powodu
   * przerysowywać ekranu, a przerysowanie nie ma prawa jej zgubić.
   */
  const oczekujace = useRef<SygnalRozmowy[]>([]);

  const przekaz = useCallback(
    (rozmowa: Call, s: SygnalRozmowy) =>
      rozmowa.przyjmijSygnal(
        s.nadawca,
        s.kind,
        s.callId,
        s.payload,
        s.dtlsFingerprint,
        s.target,
      ),
    [],
  );

  useEffect(() => {
    if (!sygnal) return;

    // Oferta, gdy nie mamy jeszcze rozmowy — to zaproszenie przychodzące.
    if (sygnal.kind === "offer" && !call) {
      setPrzychodzace(sygnal);
      return;
    }

    // Wszystko inne przed odebraniem czeka w kolejce. Rozłączenie jest
    // wyjątkiem: dzwoniący się rozmyślił i nie ma już czego odbierać.
    if (!call) {
      if (sygnal.kind === "hangup") {
        oczekujace.current = [];
        setPrzychodzace(null);
      } else {
        oczekujace.current.push(sygnal);
      }
      return;
    }

    void przekaz(call, sygnal).catch(onBlad);
  }, [sygnal, call, przekaz, onBlad]);

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
    zestawiona.current = false;
    oczekujace.current = [];
    try {
      const nowa = await Call.rozpocznij(
        messenger,
        groupId,
        messenger.accessToken,
        wideo,
        zapamietajStan,
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
    zestawiona.current = false;

    try {
      const nowa = await Call.odbierz(
        messenger,
        groupId,
        messenger.accessToken,
        zaproszenie.callId,
        wideo,
        zapamietajStan,
        zapamietajStrumien,
      );
      setCall(nowa);
      setOdKiedy(Date.now());
      setMikrofon(true);
      setObraz(true);

      // Ofertę, która nas obudziła, trzeba przetworzyć po zestawieniu rozmowy.
      await przekaz(nowa, zaproszenie);

      /*
       * Dopiero teraz kandydaci, którzy przyszli w trakcie dzwonienia.
       *
       * Kolejność ma znaczenie: kandydat przed opisem zdalnym trafiłby do
       * drugiej kolejki, tej w `PeerLink`. Działałoby, ale przechodzenie przez
       * dwie kolejki po to, żeby wyjść w tym samym miejscu, jest okrężną drogą
       * do stanu, w którym i tak trzeba mieć ofertę przetworzoną najpierw.
       *
       * Błąd na pojedynczym kandydacie nie może przerwać reszty — jeden
       * nieprzydatny adres to nie powód, żeby zerwać rozmowę.
       */
      const zalegle = oczekujace.current;
      oczekujace.current = [];

      for (const s of zalegle) {
        await przekaz(nowa, s).catch(() => {});
      }
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
  const rozlacz = (powiadom = true) => {
    /*
     * „Czy ktoś odebrał" musi być pamiętane, a nie odczytane w chwili końca.
     *
     * Gdy to DRUGA strona się rozłącza, w chwili sprzątania wszyscy uczestnicy
     * są już `zakonczona` — pytanie „czy ktoś jest w trakcie" odpowiada wtedy
     * „nie" na rozmowę, która właśnie trwała kwadrans. W wątku zostawałoby po
     * niej „Nikt nie odebrał", co jest po prostu nieprawdą.
     */
    const ktos = zestawiona.current;

    onZdarzenie({
      wideo: stan?.wideo ?? false,
      sekundy: ktos ? Math.floor(sekundy) : undefined,
      wychodzaca: wychodzaca.current,
    });

    call?.zakoncz(powiadom);
    setCall(null);
    setStan(null);
    setOdKiedy(null);
    setSekundy(0);
    setStrumienie(new Map());
    oczekujace.current = [];
  };

  /*
   * Rozłączenie przez DRUGĄ stronę też kończy rozmowę.
   *
   * `hangup` docierał dotąd tylko do `PeerLink`, który zamykał swoje
   * połączenie — i na tym się kończyło. Ekran rozmowy zostawał na wierzchu
   * z licznikiem lecącym dalej, bo nikt nie powiedział mu, że nie ma już z kim
   * rozmawiać. Wyjściem był przycisk „Rozłącz", czyli rozłączanie się
   * z rozmowy, która dawno się skończyła.
   *
   * Warunek jest o WSZYSTKICH uczestnikach, nie o pierwszym z brzegu: w mesh
   * odejście jednej osoby z trzech nie kończy rozmowy pozostałym. Pusta lista
   * nie liczy się jako „wszyscy wyszli" — tak wygląda rozmowa tuż po
   * zestawieniu, zanim pojawi się w niej ktokolwiek.
   *
   * Rozłączenia nie odsyłamy z powrotem: druga strona właśnie je przysłała.
   */
  const wszyscyOdeszli =
    stan !== null &&
    stan.uczestnicy.length > 0 &&
    stan.uczestnicy.every((u) => u.faza === "zakonczona");

  useEffect(() => {
    if (wszyscyOdeszli) rozlaczRef.current(false);
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [wszyscyOdeszli]);

  // Przez referencję, żeby efekt wyżej nie musiał zależeć od funkcji
  // odtwarzanej przy każdym renderze — inaczej zamykałby rozmowę w kółko.
  const rozlaczRef = useRef(rozlacz);
  rozlaczRef.current = rozlacz;

  /*
   * Rozmowa na ekranie znaczy, że reszty układu nie ma.
   *
   * Zgłaszamy to w efekcie, a nie w trakcie renderowania: zmiana stanu rodzica
   * podczas własnego renderu jest ostrzeżeniem Reacta i w trybie ścisłym
   * potrafi zapętlić przerysowanie.
   */
  const naEkranie = call !== null || przychodzace !== null;
  useEffect(() => {
    onAktywnosc(naEkranie);
  }, [naEkranie, onAktywnosc]);

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

  /**
   * Odrzucenie MÓWI dzwoniącemu, że to odmowa.
   *
   * Wcześniej gasiliśmy tylko własny ekran, a po drugiej stronie telefon
   * dzwonił dalej, aż ktoś się poddał — nie do odróżnienia od „nie ma go przy
   * telefonie". Rozłączenie jest jedynym sygnałem, jakim można powiedzieć „nie
   * teraz", więc musi wyjść.
   */
  const odrzuc = () => {
    if (przychodzace) {
      void messenger
        .sendCallSignal(groupId, "hangup", przychodzace.callId, "", "", przychodzace.nadawca)
        .catch(() => {
          // Nieudana odmowa nie może zatrzymać zamknięcia ekranu: dzwoniący
          // najwyżej doczeka swojego, a użytkownik i tak już odmówił.
        });
    }

    // Odrzucona rozmowa zostaje w wątku. Zniknięcie bez śladu znaczy, że po
    // odłożeniu telefonu nie da się już sprawdzić, kto dzwonił.
    onZdarzenie({ wideo: false, wychodzaca: false });
    setPrzychodzace(null);
    oczekujace.current = [];
  };

  if (przychodzace) {
    return (
      <section
        className="fixed inset-0 z-50 flex items-center justify-center bg-black/60 p-4 backdrop-blur-md"
        aria-label={t("Rozmowa przychodząca", "Incoming call")}
      >
        {/*
          Karta na środku, reszta ekranu przygaszona i rozmyta.

          Dzwoniący nie zabiera całego ekranu — to nie jest jeszcze rozmowa,
          tylko pytanie „odebrać?". Rozmyte tło zostawia kontekst tego, co
          robiłeś, zamiast wymazywać go czernią na pełny ekran.
        */}
        <div className="dark flex w-full max-w-sm flex-col items-center gap-8 rounded-l border border-white/10 bg-[#0a0a0a] px-6 pb-8 pt-10 text-white shadow-2xl">
          <div className="flex flex-col items-center gap-2 text-center">
            <Awatar nazwa={przychodzace.nadawca} rozmiar="xl" className="mb-2" />
            <strong className="text-[22px] font-semibold tracking-[-0.02em]">{przychodzace.nadawca}</strong>
            <span className="text-tresc text-white/70">{t("dzwoni…", "is calling…")}</span>
            <span className="flex items-center gap-1.5 text-podpis text-white/50">
              <Ikona nazwa="blokada" rozmiar={12} />
              {t("szyfrowane end-to-end", "end-to-end encrypted")}
            </span>
          </div>

          {/* Okrągłe przyciski z podpisem pod spodem — kształt niesie akcję,
              podpis ją nazywa. Zielone i czerwone wypełnienie to jedyne plamy
              koloru pod akcją w całej aplikacji: „zielone odbiera, czerwone
              odrzuca" rozpoznaje się bez czytania, w pośpiechu. */}
          <div className="flex w-full items-start justify-between px-2">
            <AkcjaDzwonienia ikona="rozlacz" podpis={t("Odrzuć", "Decline")} kolor="czerwony" onClick={odrzuc} />
            <AkcjaDzwonienia
              ikona="kamera"
              podpis={t("Z obrazem", "With video")}
              kolor="zielony"
              onClick={() => void odbierz(true)}
            />
            <AkcjaDzwonienia
              ikona="sluchawka"
              podpis={t("Odbierz", "Accept")}
              kolor="zielony"
              onClick={() => void odbierz(false)}
            />
          </div>
        </div>
      </section>
    );
  }

  // Bez trwającej rozmowy ten komponent nie ma nic do pokazania: przyciski
  // startu stoją w nagłówku wątku, tam gdzie w projekcie.
  if (!call) return null;

  /*
   * Po jednym kafelku na OSOBĘ, nie na urządzenie ani na sygnał.
   *
   * Warstwa niżej (`calls.ts`) trzyma połączenia w mapie po nazwie użytkownika,
   * a `memberUserIds` już usuwa duplikaty — więc w normalnym biegu ta lista jest
   * unikalna. Dedup po nazwie jest tu zabezpieczeniem brzegowym: gdyby ta sama
   * osoba trafiła na listę dwa razy (np. dwa urządzenia albo powtórzony sygnał),
   * bez tego widać by ją było jako dwa kafelki, a React ostrzegałby o
   * zdublowanym `key`. Zostawiamy ostatni wpis, bo niesie najświeższy stan fazy.
   */
  const uczestnicy = [
    ...new Map((stan?.uczestnicy ?? []).map((u) => [u.username, u])).values(),
  ];
  const zerwane = uczestnicy.filter((u) => u.odrzuconyOdcisk).length;

  /*
   * Czy z tego urządzenia w ogóle wychodzi obraz.
   *
   * Ze STANU rozmowy, a nie z trybu, w którym się zaczęła: po włączeniu kamery
   * w rozmowie głosowej `call.wideo` dalej mówi „to rozmowa audio", więc ikona
   * i podgląd zostałyby przy nieaktualnej odpowiedzi.
   */
  const maObraz = stan?.wideo ?? false;

  /*
   * Rozmowa jest OSOBNYM ekranem, nie paskiem nad wątkiem.
   *
   * Pasek doklejony nad wiadomościami stawiał obok siebie dwie rzeczy o różnej
   * pilności: rozmowę, która dzieje się TERAZ, i historię, która poczeka.
   * Ekran zabiera cały układ (patrz `Czat`) i ma jedno zadanie. Wyjście z niego
   * jest jedno: rozłączenie.
   *
   * Zawsze ciemny, jak na iOS i Androidzie: jasne tło przy wideo świeci w twarz
   * i wypłukuje obraz rozmówcy.
   */
  return (
    <section
      className="dark fixed inset-0 z-50 flex flex-col gap-3 bg-[#0a0a0a] p-3 pt-[calc(var(--bezpiecznie-gora)+12px)] pb-[calc(var(--bezpiecznie-dol)+16px)] text-white"
      aria-label={t("Trwająca rozmowa", "Call in progress")}
    >
      <div className="flex items-center justify-center gap-2 py-1 text-tresc">
        <Ikona nazwa={maObraz ? "kamera" : "sluchawka"} rozmiar={16} />
        <strong className="font-semibold">{opisRozmowy(uczestnicy)}</strong>
        <span className="tabular-nums text-white/60">{trwanie(sekundy)}</span>
      </div>

      {/*
        Kafelki: ja i wszyscy, z którymi rozmawiam, w jednej siatce. Obraz albo
        awatar, nazwa i droga połączenia w jednym miejscu — żeby było wiadomo,
        czyj obraz się właśnie widzi.

        Droga połączenia ZOSTAJE przy każdej osobie z osobna. „Bezpośrednio" to
        zdanie o tym, że ta osoba zna Twój adres IP, a w rozmowie mesh każda
        para negocjuje osobno — jedna etykieta na całą rozmowę byłaby nieprawdą
        wobec połowy uczestników.
      */}
      <div className="siatka-kafelkow" data-ilu={Math.min(uczestnicy.length + 1, 4)}>
        <Kafelek nazwa={t("Ty", "You")} stream={call.strumienLokalny()} wlasny obrazWlaczony={maObraz && obraz} />

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
        <p className="mx-auto max-w-md text-center text-podpis text-alarm">
          {t(
            `Połączenie z ${zerwane === 1 ? "jedną osobą" : `${zerwane} osobami`} zostało zerwane, bo certyfikat nie zgadzał się z odciskiem przysłanym zaszyfrowanym kanałem. Rozmowa z pozostałymi trwa dalej.`,
            `The connection with ${zerwane === 1 ? "one person" : `${zerwane} people`} was dropped because their certificate didn't match the fingerprint sent over the encrypted channel. The call with everyone else continues.`,
          )}
        </p>
      )}

      {/*
        Przyciski POD obrazem, nie nad nim: kciuk sięga dołu ekranu, a
        „Rozłącz" jest tu jedynym wyjściem — więc stoi tam, gdzie w każdym
        innym telefonie.
      */}
      <div className="flex items-center justify-center gap-4 pt-2">
        <PrzyciskRozmowy
          ikona={mikrofon ? "mikrofon" : "mikrofonWyciszony"}
          opis={mikrofon ? t("Wycisz mikrofon", "Mute") : t("Włącz mikrofon", "Unmute")}
          zaznaczony={!mikrofon}
          onClick={() => {
            przelacz("audio", !mikrofon);
            setMikrofon((m) => !m);
          }}
        />
        {/*
          Przycisk kamery jest ZAWSZE, także w rozmowie głosowej — decyzja
          podjęta w chwili dzwonienia nie jest ostateczna.
        */}
        <PrzyciskRozmowy
          ikona={maObraz ? "kamera" : "kameraWylaczona"}
          opis={maObraz ? t("Wyłącz obraz", "Turn camera off") : t("Włącz kamerę", "Turn camera on")}
          zaznaczony={maObraz}
          onClick={() => void przelaczKamere()}
        />
        <button
          type="button"
          title={t("Rozłącz", "Hang up")}
          aria-label={t("Rozłącz", "Hang up")}
          onClick={() => rozlacz()}
          className="flex size-16 items-center justify-center rounded-full bg-[#dc2626] text-white transition-opacity hover:opacity-90"
        >
          <Ikona nazwa="rozlacz" rozmiar={30} />
        </button>
      </div>
    </section>
  );
}

/** Okrągły przycisk sterowania rozmową. Zaznaczony = biała plama, jak w systemowym telefonie. */
function PrzyciskRozmowy({
  ikona,
  opis,
  zaznaczony,
  onClick,
}: {
  ikona: NazwaIkony;
  opis: string;
  zaznaczony: boolean;
  onClick: () => void;
}) {
  return (
    <button
      type="button"
      title={opis}
      aria-label={opis}
      aria-pressed={zaznaczony}
      onClick={onClick}
      className={cn(
        "flex size-14 items-center justify-center rounded-full transition-colors",
        zaznaczony ? "bg-white text-black" : "bg-white/15 text-white hover:bg-white/25",
      )}
    >
      <Ikona nazwa={ikona} rozmiar={22} />
    </button>
  );
}

/** Duży okrągły przycisk z podpisem — odbierz/odrzuć. */
function AkcjaDzwonienia({
  ikona,
  podpis,
  kolor,
  onClick,
}: {
  ikona: NazwaIkony;
  podpis: string;
  kolor: "zielony" | "czerwony";
  onClick: () => void;
}) {
  return (
    <span className="flex flex-col items-center gap-2">
      <button
        type="button"
        aria-label={podpis}
        onClick={onClick}
        className={cn(
          "flex size-16 items-center justify-center rounded-full text-white transition-opacity hover:opacity-90",
          kolor === "zielony" ? "bg-[#16a34a]" : "bg-[#dc2626]",
        )}
      >
        <Ikona nazwa={ikona} rozmiar={26} />
      </button>
      <span className="text-meta text-white/80">{podpis}</span>
    </span>
  );
}

/** Co pokazać pod nazwą uczestnika: stan połączenia albo drogę, którą idą media. */
function StanUczestnika({ uczestnik }: { uczestnik: PeerState }) {
  if (uczestnik.odrzuconyOdcisk) {
    return (
      <span className="tryb uwaga">
        <Ikona nazwa="ostrzezenie" rozmiar={12} />
        {t("obcy certyfikat", "unknown certificate")}
      </span>
    );
  }

  if (uczestnik.faza === "laczenie") {
    return (
      <span className="tryb">
        <Ikona nazwa="zegar" rozmiar={12} />
        {t("łączę…", "connecting…")}
      </span>
    );
  }

  if (uczestnik.faza !== "trwa") {
    return (
      <span className="tryb">
        <Ikona nazwa="brakSieci" rozmiar={12} />
        {t("rozłączony", "disconnected")}
      </span>
    );
  }

  const przekaznik = uczestnik.droga === "relay";

  return (
    <span
      className="tryb"
      title={
        przekaznik
          ? t("Media idą przez serwer TURN — to on zna oba adresy IP.", "Media goes through the TURN server — it knows both IP addresses.")
          : t("Media idą wprost — ta osoba zna Twój adres IP.", "Media goes direct — this person knows your IP address.")
      }
    >
      <Ikona nazwa={przekaznik ? "przezSerwer" : "bezposrednio"} rozmiar={12} />
      {przekaznik ? t("przez przekaźnik", "via relay") : t("bezpośrednio", "direct")}
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
    <div
      className={cn(
        "relative flex min-h-0 items-center justify-center overflow-hidden rounded-l bg-white/[0.06]",
        widacObraz && "z-obrazem",
      )}
    >
      <video
        ref={ref}
        autoPlay
        playsInline
        // Własny podgląd MUSI być wyciszony — inaczej słychać siebie z opóźnieniem
        // i rozmowa staje się nie do prowadzenia.
        muted={wlasny}
        // Lustrzany tylko własny: tak wygląda odbicie w lustrze, do którego
        // wszyscy są przyzwyczajeni.
        className={cn("obraz-kafelka absolute inset-0 size-full object-cover", wlasny && "odbity")}
      />

      {!widacObraz && <Awatar nazwa={nazwa} rozmiar="xl" />}

      <span className="podpis-kafelka absolute inset-x-0 bottom-0 flex flex-wrap items-center gap-2 p-3 text-meta">
        <span className="font-medium">{nazwa}</span>
        {uczestnik && <StanUczestnika uczestnik={uczestnik} />}
      </span>
    </div>
  );
}

/** Jednym zdaniem: z kim rozmawiamy albo na kogo czekamy. */
function opisRozmowy(uczestnicy: CallState["uczestnicy"]): string {
  const trwa = uczestnicy.filter((u) => u.faza === "trwa" && !u.odrzuconyOdcisk);

  if (trwa.length === 0) return t("Łączę…", "Connecting…");
  if (trwa.length === 1) return t(`Rozmowa z ${trwa[0]?.username}`, `Call with ${trwa[0]?.username}`);
  return t(`Rozmowa · ${trwa.length} osób`, `Call · ${trwa.length} people`);
}

/*
 * `WideoUczestnika` i `AudioUczestnika` zniknęły — zastąpił je `Kafelek`.
 *
 * Były dwoma składnikami robiącymi to samo (podpięcie strumienia do elementu),
 * wybieranymi na podstawie trybu rozmowy. Odkąd tryb zmienia się w trakcie,
 * ten wybór musiałby przemontowywać element w połowie rozmowy — czyli urywać
 * dźwięk dokładnie wtedy, gdy ktoś włącza kamerę.
 */
