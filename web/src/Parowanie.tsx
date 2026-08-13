import jsQR from "jsqr";
import { useCallback, useEffect, useRef, useState } from "react";

import { Ikona } from "./Ikony";
import { OpticalReceiver, OpticalSender, PairingKeys } from "./wasm/mekamb_wasm";
import { api } from "./lib/api";
import { listaRozmow, scalHistorie } from "./lib/historia";
import type { Messenger } from "./lib/messenger";
import {
  type PostepParowania,
  odczytajZaproszenie,
  wprowadzDoRozmow,
  zbudujZaproszenie,
} from "./lib/parowanie";
import { qrMatrix } from "./lib/qr";
import { loadHistory } from "./lib/vault";

/**
 * Parowanie drugiego urządzenia — dwa ekrany jednego obrzędu.
 *
 * # Podział ról
 *
 * [`PodlaczTeUrzadzenie`] stoi na **nowym** urządzeniu: pokazuje kod, potem
 * czyta z ekranu historię. [`SparujNoweUrzadzenie`] stoi na **starym**:
 * skanuje kod, wprowadza nowe urządzenie do rozmów i nadaje historię.
 *
 * Kierunek nie jest dowolny — uzasadnienie przy `lib/parowanie.ts`.
 *
 * # Dlaczego jsQR, a nie BarcodeDetector
 *
 * `BarcodeDetector` zwraca `rawValue` jako **łańcuch znaków**, więc binarna
 * ramka transferu wraca z niego przepuszczona przez UTF-8 i nie da się jej
 * odtworzyć. `jsQR` oddaje `binaryData`, czyli surowe bajty. Do statycznego
 * kodu zaproszenia, który jest tekstem, `BarcodeDetector` nadal by wystarczył —
 * ale trzymanie dwóch dekoderów na jednym ekranie nie jest warte tej różnicy.
 */

/** Kod, którym stare urządzenie podaje swój efemeryczny klucz publiczny. */
const SCHEMAT_NADAWCY = "mekamb://parowanie-nadawca";

/**
 * Co która klatka to kod z kluczem nadawcy, a nie ramka danych.
 *
 * Nowe urządzenie może zacząć patrzeć w dowolnej chwili, więc klucz musi
 * wracać na ekran regularnie — pokazany raz na początku przepadłby dla
 * każdego, kto spóźnił się o sekundę. Ósma klatka to jakieś 12% przepustowości
 * i tyle samo procent dłuższy transfer.
 */
const CO_ILE_KLUCZ = 8;

/** Ile klatek na sekundę pokazujemy. Szybciej aparat nie nadąża z naświetlaniem. */
const KLATEK_NA_SEKUNDE = 10;

function doBase64url(bajty: Uint8Array): string {
  return btoa(String.fromCharCode(...bajty))
    .replace(/\+/g, "-")
    .replace(/\//g, "_")
    .replace(/=+$/, "");
}

function zBase64url(tekst: string): Uint8Array {
  const u = tekst.replace(/-/g, "+").replace(/_/g, "/");
  const surowe = atob(u.padEnd(Math.ceil(u.length / 4) * 4, "="));
  return Uint8Array.from(surowe, (z) => z.charCodeAt(0));
}

// ---------------------------------------------------------------------------
// Rysowanie
// ---------------------------------------------------------------------------

/** Macierz kodu QR na płótnie. Bez marginesu byłby nie do odczytania. */
function PlotnoQr({ bok, ciemny }: { bok: number; ciemny: (y: number, x: number) => boolean }) {
  const plotno = useRef<HTMLCanvasElement | null>(null);

  useEffect(() => {
    const el = plotno.current;
    const ctx = el?.getContext("2d");
    if (!el || !ctx) return;

    // Cztery moduły marginesu — tyle wymaga norma, a mniej psuje wykrywanie
    // wzorów pozycjonujących przy ostrym kącie patrzenia.
    const margines = 4;
    const pelny = bok + margines * 2;
    const skala = Math.max(1, Math.floor(640 / pelny));

    el.width = pelny * skala;
    el.height = pelny * skala;

    ctx.fillStyle = "#ffffff";
    ctx.fillRect(0, 0, el.width, el.height);
    ctx.fillStyle = "#000000";

    for (let y = 0; y < bok; y++) {
      for (let x = 0; x < bok; x++) {
        if (ciemny(y, x)) {
          ctx.fillRect((x + margines) * skala, (y + margines) * skala, skala, skala);
        }
      }
    }
  }, [bok, ciemny]);

  // Kod QR musi zostać jasny także w ciemnym motywie: aparat czyta kontrast,
  // a nie intencję projektanta.
  return <canvas ref={plotno} className="kod-qr" />;
}

/** Statyczny kod z tekstu. */
function KodTekstowy({ tresc }: { tresc: string }) {
  const macierz = qrMatrix(tresc);
  const ciemny = useCallback((y: number, x: number) => macierz[y]?.[x] ?? false, [macierz]);

  return <PlotnoQr bok={macierz.length} ciemny={ciemny} />;
}

// ---------------------------------------------------------------------------
// Skanowanie
// ---------------------------------------------------------------------------

/** Co udało się odczytać z jednej klatki aparatu. */
interface Odczyt {
  tekst: string;
  bajty: Uint8Array;
}

/**
 * Pętla aparatu: klatka po klatce, dopóki `aktywny`.
 *
 * Bez sztucznego opóźnienia — przy strumieniu dziesięciu klatek na sekundę
 * każde uśpienie to realnie zgubiona ramka. `jsQR` sam jest wolniejszy niż
 * odświeżanie ekranu, więc to on wyznacza tempo.
 */
function useSkaner(aktywny: boolean, naOdczyt: (o: Odczyt) => void, onBlad: (e: unknown) => void) {
  const wideo = useRef<HTMLVideoElement | null>(null);
  const naOdczytRef = useRef(naOdczyt);
  naOdczytRef.current = naOdczyt;

  useEffect(() => {
    if (!aktywny) return;

    let strumien: MediaStream | null = null;
    let zatrzymane = false;
    const plotno = document.createElement("canvas");

    void (async () => {
      try {
        strumien = await navigator.mediaDevices.getUserMedia({
          video: { facingMode: "environment", width: { ideal: 1280 }, height: { ideal: 720 } },
        });

        const el = wideo.current;
        if (!el) return;
        el.srcObject = strumien;
        await el.play();

        const ctx = plotno.getContext("2d", { willReadFrequently: true });
        if (!ctx) throw new Error("przeglądarka nie daje kontekstu 2D");

        while (!zatrzymane) {
          await new Promise(requestAnimationFrame);
          if (zatrzymane || !el.videoWidth) continue;

          plotno.width = el.videoWidth;
          plotno.height = el.videoHeight;
          ctx.drawImage(el, 0, 0);

          const obraz = ctx.getImageData(0, 0, plotno.width, plotno.height);
          const wynik = jsQR(obraz.data, obraz.width, obraz.height, {
            inversionAttempts: "dontInvert",
          });

          if (wynik) {
            naOdczytRef.current({
              tekst: wynik.data,
              bajty: Uint8Array.from(wynik.binaryData),
            });
          }
        }
      } catch (err) {
        if (!zatrzymane) onBlad(err);
      }
    })();

    return () => {
      zatrzymane = true;
      strumien?.getTracks().forEach((t) => t.stop());
    };
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [aktywny]);

  return wideo;
}

// ---------------------------------------------------------------------------
// Nowe urządzenie
// ---------------------------------------------------------------------------

type FazaNowego = "kod" | "odbiera" | "gotowe";

/**
 * Ekran na **nowym** urządzeniu.
 *
 * Zaczyna od kodu z własnym kluczem publicznym, potem czyta z ekranu starego
 * urządzenia historię sprzed sparowania.
 */
export function PodlaczTeUrzadzenie({
  messenger,
  onBlad,
}: {
  messenger: Messenger;
  onBlad: (e: unknown) => void;
}) {
  const [faza, setFaza] = useState<FazaNowego>("kod");
  const [postep, setPostep] = useState({ odzyskane: 0, wszystkich: 0 });
  const [podsumowanie, setPodsumowanie] = useState<string | null>(null);

  // Para przeżywa przerysowania, ale nie przeżywa opuszczenia ekranu:
  // przerwane parowanie ma zostawić po sobie nieużyteczny kod, nie sekret.
  const para = useRef<PairingKeys | null>(null);
  para.current ??= new PairingKeys();

  const odbiornik = useRef<OpticalReceiver | null>(null);
  const kluczTransferu = useRef<Uint8Array | null>(null);

  const zaproszenie = zbudujZaproszenie(
    messenger.account.deviceId,
    para.current.publicKey(),
  );

  const naOdczyt = useCallback(
    (odczyt: Odczyt) => {
      // Kod z kluczem nadawcy wraca na ekran co kilka klatek, więc trafimy
      // na niego niezależnie od tego, kiedy zaczęliśmy patrzeć.
      if (odczyt.tekst.startsWith(`${SCHEMAT_NADAWCY}?`)) {
        if (kluczTransferu.current) return;

        const parametry = new URLSearchParams(odczyt.tekst.slice(`${SCHEMAT_NADAWCY}?`.length));
        const surowy = parametry.get("k");
        if (!surowy) return;

        try {
          kluczTransferu.current = para.current!.transferKey(zBase64url(surowy));
        } catch (err) {
          onBlad(err);
        }
        return;
      }

      odbiornik.current ??= new OpticalReceiver();
      const stan = odbiornik.current.addFrame(odczyt.bajty);
      setPostep({
        odzyskane: odbiornik.current.recovered(),
        wszystkich: odbiornik.current.total(),
      });

      if (stan !== "gotowe" || !kluczTransferu.current) return;

      // Komplet ramek I klucz — dopiero teraz da się cokolwiek złożyć.
      const zebrany = odbiornik.current.finish(kluczTransferu.current);
      setFaza("gotowe");

      void scalHistorie(zebrany)
        .then((wynik) => {
          setPodsumowanie(
            wynik === null
              ? "Historii nie dało się odczytać — spróbuj sparować jeszcze raz."
              : `Doszło ${wynik.wiadomosci} wiadomości w ${wynik.rozmow} nowych rozmowach.`,
          );
        })
        .catch(onBlad);
    },
    [onBlad],
  );

  const wideo = useSkaner(faza === "odbiera", naOdczyt, onBlad);

  if (faza === "gotowe") {
    return (
      <section className="karta">
        <strong>Urządzenie podłączone</strong>
        <p className="wskazowka">{podsumowanie ?? "Składam historię…"}</p>
      </section>
    );
  }

  if (faza === "odbiera") {
    const { odzyskane, wszystkich } = postep;
    return (
      <section className="karta">
        <strong>Czytam historię</strong>
        <video ref={wideo} className="podglad-aparatu" playsInline muted />
        <p className="wskazowka">
          {wszystkich === 0
            ? "Skieruj aparat na ekran starego urządzenia."
            : `${odzyskane} z ${wszystkich} części.`}
        </p>
        <p className="wskazowka">
          Zgubiona klatka nic nie psuje — kod nadaje się w kółko, aż uzbiera się całość.
        </p>
      </section>
    );
  }

  return (
    <section className="karta">
      <strong>Podłącz to urządzenie</strong>
      <p className="wskazowka">
        Na urządzeniu, którego już używasz, wybierz „Podłącz nowe urządzenie" i zeskanuj ten kod.
      </p>

      <KodTekstowy tresc={zaproszenie} />

      <p className="wskazowka">
        Twoje rozmowy pojawią się tutaj same. Historia sprzed dzisiaj przyjdzie z ekranu
        tamtego urządzenia — nic z niej nie idzie przez serwer.
      </p>

      <button onClick={() => setFaza("odbiera")}>
        <Ikona nazwa="aparat" rozmiar={16} />
        Tamto urządzenie pokazuje kod — czytaj
      </button>
    </section>
  );
}

// ---------------------------------------------------------------------------
// Stare urządzenie
// ---------------------------------------------------------------------------

type FazaStarego = "skanuje" | "dodaje" | "nadaje" | "koniec";

/**
 * Ekran na **starym**, już zaufanym urządzeniu.
 *
 * To ono podpisuje zgodę: wprowadza nowe urządzenie do każdej rozmowy commitem
 * MLS, a potem nadaje historię z ekranu.
 */
export function SparujNoweUrzadzenie({
  messenger,
  onBlad,
}: {
  messenger: Messenger;
  onBlad: (e: unknown) => void;
}) {
  const [faza, setFaza] = useState<FazaStarego>("skanuje");
  const [wpisany, setWpisany] = useState("");
  const [dodawanie, setDodawanie] = useState<PostepParowania | null>(null);
  const [klatka, setKlatka] = useState<{ bok: number; moduly: Uint8Array } | null>(null);
  const [ileKlatek, setIleKlatek] = useState(0);

  const para = useRef<PairingKeys | null>(null);
  para.current ??= new PairingKeys();
  const nadajnik = useRef<OpticalSender | null>(null);

  const przyjmij = useCallback(
    async (tresc: string) => {
      const zaproszenie = odczytajZaproszenie(tresc);
      if (!zaproszenie) return false;

      setFaza("dodaje");

      try {
        const klucz = para.current!.transferKey(zaproszenie.kluczPubliczny);

        /*
         * Najpierw rozmowy, potem historia.
         *
         * Nowe urządzenie musi być już podłączone do skrzynki, zanim pójdzie
         * Welcome — kursor w `UserInbox` powstaje przy pierwszym połączeniu
         * i dopiero od tej chwili urządzenie trzyma kolejkę. Odwrotna
         * kolejność powtórzyłaby awarię, w której Welcome nigdy nie dotarł.
         */
        const rozmowy = (await listaRozmow()).map((p) => p.groupId);
        const wynik = await wprowadzDoRozmow(
          messenger,
          zaproszenie.deviceId,
          rozmowy,
          setDodawanie,
        );
        setDodawanie(wynik);

        const historia = (await loadHistory()) ?? new Uint8Array();
        nadajnik.current = new OpticalSender(historia, klucz);
        setIleKlatek(nadajnik.current.blockCount());
        setFaza("nadaje");
      } catch (err) {
        onBlad(err);
        setFaza("skanuje");
      }

      return true;
    },
    [messenger, onBlad],
  );

  const naOdczyt = useCallback(
    (odczyt: Odczyt) => {
      void przyjmij(odczyt.tekst);
    },
    [przyjmij],
  );

  const wideo = useSkaner(faza === "skanuje", naOdczyt, onBlad);

  // Pętla nadawania: co ósma klatka to klucz publiczny, reszta to dane.
  useEffect(() => {
    if (faza !== "nadaje" || !nadajnik.current) return;

    let licznik = 0;
    const kluczKod = `${SCHEMAT_NADAWCY}?k=${doBase64url(para.current!.publicKey())}`;
    const macierzKlucza = qrMatrix(kluczKod);

    const zegar = setInterval(() => {
      if (licznik % CO_ILE_KLUCZ === 0) {
        setKlatka({
          bok: macierzKlucza.length,
          moduly: Uint8Array.from(macierzKlucza.flat(), (c) => (c ? 1 : 0)),
        });
      } else {
        const kod = nadajnik.current!.nextFrame();
        setKlatka({ bok: kod.side, moduly: kod.modules });
      }
      licznik += 1;
    }, 1000 / KLATEK_NA_SEKUNDE);

    return () => clearInterval(zegar);
  }, [faza]);

  const ciemny = useCallback(
    (y: number, x: number) => (klatka ? klatka.moduly[y * klatka.bok + x] === 1 : false),
    [klatka],
  );

  if (faza === "nadaje") {
    return (
      <section className="karta">
        <strong>Pokaż to nowemu urządzeniu</strong>
        {klatka && <PlotnoQr bok={klatka.bok} ciemny={ciemny} />}
        <p className="wskazowka">
          Trzymaj oba ekrany naprzeciw siebie. Historia idzie prosto z ekranu do aparatu —
          {" "}<strong>nic z niej nie dotyka serwera</strong>.
        </p>
        <p className="wskazowka">
          Około {Math.ceil((ileKlatek * (CO_ILE_KLUCZ / (CO_ILE_KLUCZ - 1))) / KLATEK_NA_SEKUNDE)}{" "}
          sekund przy dobrym ujęciu. Kod nadaje się w kółko, więc zgubiona klatka nic nie psuje.
        </p>
        {dodawanie && dodawanie.pominiete.length > 0 && (
          <p className="wskazowka">
            {dodawanie.pominiete.length} rozmów nie przyjęło nowego urządzenia. Powtórz parowanie
            później — te, które już przeszły, zostaną pominięte.
          </p>
        )}
        <button onClick={() => setFaza("koniec")}>
          <Ikona nazwa="zamknij" rozmiar={16} />
          Nowe urządzenie ma komplet
        </button>
      </section>
    );
  }

  if (faza === "dodaje") {
    return (
      <section className="karta">
        <strong>Wprowadzam do rozmów</strong>
        <p className="wskazowka">
          {dodawanie
            ? `${dodawanie.zrobione} z ${dodawanie.wszystkich} rozmów.`
            : "Uzgadniam z serwerem kolejność zmian…"}
        </p>
        <p className="wskazowka">
          Każda rozmowa to osobna zmiana składu grupy, więc idą po kolei.
        </p>
      </section>
    );
  }

  if (faza === "koniec") {
    return (
      <section className="karta">
        <strong>Gotowe</strong>
        <p className="wskazowka">
          Oba urządzenia działają teraz równolegle. Nowe wiadomości trafią na oba same z siebie.
        </p>
        <p className="wskazowka">
          Rozmówcy zobaczą zmianę numeru bezpieczeństwa — to normalne, doszło Ci urządzenie.
        </p>
      </section>
    );
  }

  return (
    <section className="karta">
      <strong>Podłącz nowe urządzenie</strong>
      <p className="wskazowka">
        Zaloguj się na nowym urządzeniu, wybierz tam „Podłącz to urządzenie" i zeskanuj kod,
        który się pokaże.
      </p>

      <video ref={wideo} className="podglad-aparatu" playsInline muted />

      <label>
        Albo przepisz kod
        <input
          value={wpisany}
          onChange={(e) => setWpisany(e.target.value)}
          placeholder="mekamb://parowanie?…"
          spellCheck={false}
        />
      </label>

      <button
        onClick={() => {
          void przyjmij(wpisany).then((udane) => {
            if (!udane) onBlad(new Error("to nie jest kod parowania"));
          });
        }}
        disabled={!wpisany.trim()}
      >
        <Ikona nazwa="dostarczone" rozmiar={16} />
        Podłącz
      </button>
    </section>
  );
}

/**
 * Karta „Urządzenia" w panelu konta.
 *
 * # Dlaczego wybór roli, a nie automat
 *
 * Aplikacja nie ma jak zgadnąć, czy stoisz przy urządzeniu starym, czy nowym —
 * oba są zalogowane i oba wyglądają tak samo. Pytanie wprost jest uczciwsze niż
 * zgadywanie po tym, czy lista rozmów jest pusta: pusta bywa też u kogoś, kto
 * po prostu jeszcze z nikim nie pisał.
 */
export function Urzadzenia({
  messenger,
  onBlad,
}: {
  messenger: Messenger;
  onBlad: (e: unknown) => void;
}) {
  const [rola, setRola] = useState<"brak" | "stare" | "nowe">("brak");
  const [lista, setLista] = useState<{ deviceId: string }[]>([]);
  const [usuwane, setUsuwane] = useState<string | null>(null);

  const odswiez = useCallback(() => {
    void api
      .get<{ devices: { deviceId: string }[] }>(
        `/directory/${encodeURIComponent(messenger.account.userId)}`,
      )
      .then((o) => setLista(o.devices))
      .catch(() => setLista([]));
  }, [messenger]);

  useEffect(odswiez, [odswiez]);

  const odbierzDostep = async (deviceId: string) => {
    setUsuwane(deviceId);
    try {
      const rozmowy = (await listaRozmow()).map((p) => p.groupId);
      await messenger.usunUrzadzenie(deviceId, rozmowy);
      odswiez();
    } catch (err) {
      onBlad(err);
    } finally {
      setUsuwane(null);
    }
  };

  if (rola === "stare") return <SparujNoweUrzadzenie messenger={messenger} onBlad={onBlad} />;
  if (rola === "nowe") return <PodlaczTeUrzadzenie messenger={messenger} onBlad={onBlad} />;

  return (
    <div className="karta">
      <strong>Urządzenia</strong>
      <p className="wskazowka">
        Tego samego konta można używać na kilku urządzeniach naraz. Każde dostaje własne klucze
        i wchodzi do rozmów osobno — to nie jest kopia, więc oba działają dalej.
      </p>
      <p className="wskazowka">
        Historia sprzed podłączenia idzie prosto z ekranu do aparatu.{" "}
        <strong>Nic z niej nie trafia na serwer</strong>, nawet zaszyfrowane.
      </p>

      <button onClick={() => setRola("stare")}>
        <Ikona nazwa="kodQr" rozmiar={16} />
        Podłącz nowe urządzenie
      </button>

      <button onClick={() => setRola("nowe")}>
        <Ikona nazwa="aparat" rozmiar={16} />
        To urządzenie jest nowe — podłącz je
      </button>

      {lista.length > 1 && (
        <>
          <p className="wskazowka">
            Zgubione urządzenie odetnij tutaj. Przestanie odszyfrowywać wszystko, co przyjdzie
            później — tego, co już przeczytało, nie da się cofnąć.
          </p>
          <ul className="lista-urzadzen">
            {lista.map((u) => (
              <li key={u.deviceId}>
                <span>{u.deviceId}</span>
                {u.deviceId === messenger.account.deviceId ? (
                  <span className="wskazowka">to urządzenie</span>
                ) : (
                  <button
                    disabled={usuwane !== null}
                    onClick={() => void odbierzDostep(u.deviceId)}
                  >
                    <Ikona nazwa="kosz" rozmiar={16} />
                    {usuwane === u.deviceId ? "Odbieram…" : "Odbierz dostęp"}
                  </button>
                )}
              </li>
            ))}
          </ul>
        </>
      )}
    </div>
  );
}
