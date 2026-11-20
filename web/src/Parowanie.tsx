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
import { t } from "./lib/jezyk";

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
        if (!ctx) throw new Error(t("przeglądarka nie daje kontekstu 2D", "the browser provides no 2D context"));

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
              ? t("Historii nie dało się odczytać — spróbuj sparować jeszcze raz.", "Couldn't read the history — try pairing again.")
              : t(`Doszło ${wynik.wiadomosci} wiadomości w ${wynik.rozmow} nowych rozmowach.`, `Received ${wynik.wiadomosci} messages in ${wynik.rozmow} new conversations.`),
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
        <strong>{t("Urządzenie podłączone", "Device connected")}</strong>
        <p className="wskazowka">{podsumowanie ?? t("Składam historię…", "Putting the history together…")}</p>
      </section>
    );
  }

  if (faza === "odbiera") {
    const { odzyskane, wszystkich } = postep;
    return (
      <section className="karta">
        <strong>{t("Czytam historię", "Reading history")}</strong>
        <video ref={wideo} className="podglad-aparatu" playsInline muted />
        <p className="wskazowka">
          {wszystkich === 0
            ? t("Skieruj aparat na ekran starego urządzenia.", "Point the camera at the old device's screen.")
            : t(`${odzyskane} z ${wszystkich} części.`, `${odzyskane} of ${wszystkich} parts.`)}
        </p>
        <p className="wskazowka">
          {t("Zgubiona klatka nic nie psuje — kod nadaje się w kółko, aż uzbiera się całość.", "A missed frame doesn't hurt — the code repeats until everything is collected.")}
        </p>
      </section>
    );
  }

  return (
    <section className="karta">
      <strong>{t("Podłącz to urządzenie", "Connect this device")}</strong>
      <p className="wskazowka">
        {t("Na urządzeniu, którego już używasz, wybierz „Podłącz nowe urządzenie\" i zeskanuj ten kod.", "On a device you already use, choose “Connect a new device” and scan this code.")}
      </p>

      <KodTekstowy tresc={zaproszenie} />

      <p className="wskazowka">
        {t("Twoje rozmowy pojawią się tutaj same. Historia sprzed dzisiaj przyjdzie z ekranu tamtego urządzenia — nic z niej nie idzie przez serwer.", "Your conversations will show up here on their own. History from before today comes from that device's screen — none of it goes through the server.")}
      </p>

      <button onClick={() => setFaza("odbiera")}>
        <Ikona nazwa="aparat" rozmiar={16} />
        {t("Tamto urządzenie pokazuje kod — czytaj", "The other device is showing a code — reading")}
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
        <strong>{t("Pokaż to nowemu urządzeniu", "Show this to the new device")}</strong>
        {klatka && <PlotnoQr bok={klatka.bok} ciemny={ciemny} />}
        <p className="wskazowka">
          {t("Trzymaj oba ekrany naprzeciw siebie. Historia idzie prosto z ekranu do aparatu —", "Hold both screens facing each other. History goes straight from screen to camera —")}
          {" "}<strong>{t("nic z niej nie dotyka serwera", "none of it touches the server")}</strong>.
        </p>
        <p className="wskazowka">
          {t("Około", "About")} {Math.ceil((ileKlatek * (CO_ILE_KLUCZ / (CO_ILE_KLUCZ - 1))) / KLATEK_NA_SEKUNDE)}{" "}
          {t("sekund przy dobrym ujęciu. Kod nadaje się w kółko, więc zgubiona klatka nic nie psuje.", "seconds with a good angle. The code repeats, so a missed frame doesn't hurt.")}
        </p>
        {dodawanie && dodawanie.pominiete.length > 0 && (
          <p className="wskazowka">
            {dodawanie.pominiete.length} {t("rozmów nie przyjęło nowego urządzenia. Powtórz parowanie później — te, które już przeszły, zostaną pominięte.", "conversations didn't accept the new device. Pair again later — the ones that already went through will be skipped.")}
          </p>
        )}
        <button onClick={() => setFaza("koniec")}>
          <Ikona nazwa="zamknij" rozmiar={16} />
          {t("Nowe urządzenie ma komplet", "The new device has everything")}
        </button>
      </section>
    );
  }

  if (faza === "dodaje") {
    return (
      <section className="karta">
        <strong>{t("Wprowadzam do rozmów", "Adding to conversations")}</strong>
        <p className="wskazowka">
          {dodawanie
            ? t(`${dodawanie.zrobione} z ${dodawanie.wszystkich} rozmów.`, `${dodawanie.zrobione} of ${dodawanie.wszystkich} conversations.`)
            : t("Uzgadniam z serwerem kolejność zmian…", "Agreeing the order of changes with the server…")}
        </p>
        <p className="wskazowka">
          {t("Każda rozmowa to osobna zmiana składu grupy, więc idą po kolei.", "Each conversation is a separate membership change, so they go one by one.")}
        </p>
      </section>
    );
  }

  if (faza === "koniec") {
    return (
      <section className="karta">
        <strong>{t("Gotowe", "Done")}</strong>
        <p className="wskazowka">
          {t("Oba urządzenia działają teraz równolegle. Nowe wiadomości trafią na oba same z siebie.", "Both devices now work side by side. New messages will reach both on their own.")}
        </p>
        <p className="wskazowka">
          {t("Rozmówcy zobaczą zmianę numeru bezpieczeństwa — to normalne, doszło Ci urządzenie.", "Your contacts will see the safety number change — that's normal, you added a device.")}
        </p>
      </section>
    );
  }

  return (
    <section className="karta">
      <strong>{t("Podłącz nowe urządzenie", "Connect a new device")}</strong>
      <p className="wskazowka">
        {t("Zaloguj się na nowym urządzeniu, wybierz tam „Podłącz to urządzenie\" i zeskanuj kod, który się pokaże.", "Sign in on the new device, choose “Connect this device” there and scan the code it shows.")}
      </p>

      <video ref={wideo} className="podglad-aparatu" playsInline muted />

      <label>
        {t("Albo przepisz kod", "Or type the code")}
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
            if (!udane) onBlad(new Error(t("to nie jest kod parowania", "this isn't a pairing code")));
          });
        }}
        disabled={!wpisany.trim()}
      >
        <Ikona nazwa="dostarczone" rozmiar={16} />
        {t("Podłącz", "Connect")}
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
      <strong>{t("Urządzenia", "Devices")}</strong>
      <p className="wskazowka">
        {t("Tego samego konta można używać na kilku urządzeniach naraz. Każde dostaje własne klucze i wchodzi do rozmów osobno — to nie jest kopia, więc oba działają dalej.", "You can use the same account on several devices at once. Each gets its own keys and joins conversations separately — it isn't a copy, so both keep working.")}
      </p>
      <p className="wskazowka">
        {t("Historia sprzed podłączenia idzie prosto z ekranu do aparatu.", "History from before connecting goes straight from screen to camera.")}{" "}
        <strong>{t("Nic z niej nie trafia na serwer", "None of it reaches the server")}</strong>{t(", nawet zaszyfrowane.", ", not even encrypted.")}
      </p>

      <button onClick={() => setRola("stare")}>
        <Ikona nazwa="kodQr" rozmiar={16} />
        {t("Podłącz nowe urządzenie", "Connect a new device")}
      </button>

      <button onClick={() => setRola("nowe")}>
        <Ikona nazwa="aparat" rozmiar={16} />
        {t("To urządzenie jest nowe — podłącz je", "This device is new — connect it")}
      </button>

      {lista.length > 1 && (
        <>
          <p className="wskazowka">
            {t("Zgubione urządzenie odetnij tutaj. Przestanie odszyfrowywać wszystko, co przyjdzie później — tego, co już przeczytało, nie da się cofnąć.", "Cut off a lost device here. It will stop decrypting anything that arrives later — what it has already read can't be undone.")}
          </p>
          <ul className="lista-urzadzen">
            {lista.map((u) => (
              <li key={u.deviceId}>
                <span>{u.deviceId}</span>
                {u.deviceId === messenger.account.deviceId ? (
                  <span className="wskazowka">{t("to urządzenie", "this device")}</span>
                ) : (
                  <button
                    disabled={usuwane !== null}
                    onClick={() => void odbierzDostep(u.deviceId)}
                  >
                    <Ikona nazwa="kosz" rozmiar={16} />
                    {usuwane === u.deviceId ? t("Odbieram…", "Revoking…") : t("Odbierz dostęp", "Revoke access")}
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
