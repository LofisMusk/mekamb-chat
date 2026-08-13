import { useEffect, useRef, useState } from "react";

import { Ikona } from "./Ikony";
import { KodQr } from "./KodQr";
import { listaRozmow } from "./lib/historia";
import {
  type KodPrzeniesienia,
  odbierzPrzeniesienie,
  przygotujPrzeniesienie,
} from "./lib/przeniesienie";
import { wipe } from "./lib/vault";

/**
 * Ekran źródłowy: pokazuje kod do zeskanowania na nowym urządzeniu.
 *
 * # Dlaczego to kończy się skasowaniem konta
 *
 * Dwa urządzenia z tą samą tożsamością MLS współdzielą liść w drzewie grupy.
 * Gdy oba zaczną wysyłać, ratchet się rozjedzie i **obie strony przestaną się
 * rozszyfrowywać** — bezpowrotnie, bo nie ma czego naprawić. Zostawienie
 * decyzji użytkownikowi znaczyłoby zostawienie mu pułapki, więc przycisk
 * kasuje konto ze starego urządzenia i mówi o tym wprost.
 */
export function PrzeniesStad({ token, onBlad }: { token: string; onBlad: (e: unknown) => void }) {
  const [kod, setKod] = useState<KodPrzeniesienia | null>(null);
  const [pracuje, setPracuje] = useState(false);
  const [zostalo, setZostalo] = useState(0);

  // Odliczanie jest tu istotne, a nie ozdobne: kod żyje kwadrans i przestaje
  // działać bez ostrzeżenia, a użytkownik stoi wtedy z dwoma telefonami.
  useEffect(() => {
    if (!kod) return;
    setZostalo(kod.wygasaZa);

    const timer = setInterval(() => {
      setZostalo((s) => Math.max(0, s - 1));
    }, 1000);
    return () => clearInterval(timer);
  }, [kod]);

  if (!kod) {
    // Karta, a nie goły przycisk: ten składnik stoi w siatce konta obok innych
    // kart, a jeden przycisk bez powierzchni wygląda tam jak coś, co wypadło.
    return (
      <div className="karta">
        <strong>Przeniesienie konta</strong>
        <p className="wskazowka">
          Tożsamość, rozmowy i cała historia przechodzą na nowe urządzenie. To urządzenie
          traci wtedy dostęp do konta.
        </p>
        <button
          disabled={pracuje}
          onClick={async () => {
            setPracuje(true);
            try {
              setKod(await przygotujPrzeniesienie(token));
            } catch (err) {
              onBlad(err);
            } finally {
              setPracuje(false);
            }
          }}
        >
          <Ikona nazwa="kodQr" rozmiar={16} />
          {pracuje ? "Przygotowuję…" : "Przenieś na inne urządzenie"}
        </button>
      </div>
    );
  }

  const minuty = Math.floor(zostalo / 60);
  const sekundy = String(zostalo % 60).padStart(2, "0");

  return (
    <section className="karta">
      <strong>Przenieś konto</strong>

      {zostalo > 0 ? (
        <>
          <p className="wskazowka">Zeskanuj ten kod na nowym urządzeniu:</p>
          <KodQr tresc={kod.tresc} opis="Kod QR do przeniesienia konta" />
          <p className="wskazowka">
            Kod ważny jeszcze <strong>{minuty}:{sekundy}</strong>. Można go użyć tylko raz.
          </p>

          <details className="sekret-recznie">
            <summary>Nowe urządzenie nie ma aparatu?</summary>
            <code className="sekret">{kod.tresc}</code>
          </details>

          <div className="ostrzezenie">
            <strong>Kto zobaczy ten kod, przejmuje konto.</strong>
            <p>Nie fotografuj go i nie wysyłaj — pokaż wprost z ekranu na ekran.</p>
          </div>
        </>
      ) : (
        <div className="ostrzezenie">
          <strong>Kod wygasł.</strong>
          <p>Zamknij to okno i zacznij od nowa.</p>
        </div>
      )}

      <p className="wskazowka">
        Zrzut niesie tożsamość, możliwość kontynuowania rozmów <strong>i historię</strong> —
        wszystko, co to urządzenie wie o koncie. To nie jest kopia zapasowa: kod działa raz
        i wygasa po kwadransie.
      </p>

      <button
        className="niszczacy"
        onClick={async () => {
          if (
            !confirm(
              "Czy nowe urządzenie odebrało konto? Ten telefon straci do niego dostęp bezpowrotnie.",
            )
          ) {
            return;
          }
          await wipe();
          location.reload();
        }}
      >
        <Ikona nazwa="kosz" rozmiar={16} />
        Odebrane — usuń konto z tego urządzenia
      </button>

      <p className="wskazowka">
        Trzeba to zrobić. Dwa urządzenia z tym samym kontem rozsypią szyfrowanie
        rozmowy i żadna ze stron nie odczyta już wiadomości.
      </p>
    </section>
  );
}

/** Gdzie zapamiętujemy, że ktoś już nie chce tej propozycji. */
const KLUCZ_ODRZUCENIA = "mekamb.import-historii-odrzucony";

function odrzucone(): boolean {
  try {
    return localStorage.getItem(KLUCZ_ODRZUCENIA) === "tak";
  } catch {
    // Prywatne okno bez magazynu. Wtedy propozycja pojawi się ponownie i to
    // jest mniejsza szkoda niż wywrócenie startu aplikacji.
    return false;
  }
}

function zapamietajOdrzucenie() {
  try {
    localStorage.setItem(KLUCZ_ODRZUCENIA, "tak");
  } catch {
    // jw.
  }
}

/**
 * Propozycja przeniesienia historii z drugiego urządzenia.
 *
 * # Dlaczego to w ogóle jest potrzebne
 *
 * Zalogowanie się na nowym urządzeniu daje konto, ale NIE daje rozmów: historia
 * leży zaszyfrowana na starym urządzeniu i serwer nie ma jej kopii. Pusta lista
 * po poprawnym zalogowaniu wygląda jak awaria, a jedyne wyjście — przeniesienie
 * konta kodem QR — było schowane w panelu konta, czyli tam, gdzie nikt nie
 * szuka rozwiązania problemu, którego nie rozumie.
 *
 * # Dlaczego to nie jest okno modalne
 *
 * Bo nie jest pytaniem, na które trzeba odpowiedzieć, żeby korzystać
 * z aplikacji. Kto zakłada pierwsze konto, nie ma czego przenosić i modal
 * byłby dla niego wyłącznie przeszkodą przy pierwszym uruchomieniu. Pasek daje
 * się zamknąć jednym kliknięciem i wtedy nie wraca.
 *
 * # Dlaczego rozwija się w miejscu
 *
 * Przejście na osobny ekran wymagałoby przeniesienia stanu zalogowania przez
 * całą maszynę ekranów wejścia — a odbiór kodu i tak kończy się przeładowaniem
 * strony, bo skarbiec zmienia się pod spodem. Rozwinięcie w miejscu nie zabiera
 * nikomu kontekstu i pozwala się rozmyślić bez „wstecz".
 */
export function ZaproszenieDoImportu({ onBlad }: { onBlad: (e: unknown) => void }) {
  const [widoczne, setWidoczne] = useState(false);
  const [rozwiniete, setRozwiniete] = useState(false);

  useEffect(() => {
    if (odrzucone()) return;
    let aktualne = true;

    // Propozycja tylko przy PUSTEJ historii. Komu wiadomości już przyszły,
    // temu nie ma czego proponować — a przeniesienie skasowałoby mu konto
    // na drugim urządzeniu w zamian za nic.
    void listaRozmow()
      .then((rozmowy) => {
        if (aktualne && rozmowy.length === 0) setWidoczne(true);
      })
      .catch(() => {
        // Nieczytelna historia nie może zablokować wejścia do aplikacji.
      });

    return () => {
      aktualne = false;
    };
  }, []);

  if (!widoczne) return null;

  if (rozwiniete) {
    // Własne przewijanie, bo powłoka czatu ma twardą wysokość widoku: karta
    // wyższa od niej zjadłaby wątek zamiast się przewinąć.
    return (
      <div className="zaproszenie-rozwiniete">
        <OdbierzTutaj
          // Po odebraniu przeładowujemy stronę: skarbiec zmienił się pod spodem,
          // a wszystko, co go już wczytało, trzymałoby stan poprzedniego konta.
          onGotowe={() => location.reload()}
          onAnuluj={() => setRozwiniete(false)}
          onBlad={onBlad}
        />
      </div>
    );
  }

  return (
    <div className="zaproszenie">
      <Ikona nazwa="kodQr" rozmiar={16} />

      <p>
        Masz rozmowy na innym urządzeniu? Przeniesiesz je stamtąd kodem QR — razem z historią.
        <span className="drobne">Stare urządzenie traci wtedy dostęp do konta.</span>
      </p>

      <button onClick={() => setRozwiniete(true)}>Przenieś</button>

      <button
        className="ikonowy"
        aria-label="Nie pokazuj tego więcej"
        title="Nie pokazuj tego więcej"
        onClick={() => {
          zapamietajOdrzucenie();
          setWidoczne(false);
        }}
      >
        <Ikona nazwa="zamknij" rozmiar={14} />
      </button>
    </div>
  );
}

/**
 * Ekran docelowy: przyjmuje kod ze starego urządzenia.
 *
 * Aparat jest udogodnieniem, nie wymaganiem — `BarcodeDetector` jest w Chrome
 * na Androidzie, ale nie w Safari, więc na iPhonie zostaje przepisanie kodu.
 * Pole tekstowe jest zawsze widoczne, żeby nikt nie utknął na ekranie
 * z niedziałającym podglądem.
 */
export function OdbierzTutaj({
  onGotowe,
  onAnuluj,
  onBlad,
}: {
  onGotowe: () => void;
  onAnuluj: () => void;
  onBlad: (e: unknown) => void;
}) {
  const [kod, setKod] = useState("");
  const [pracuje, setPracuje] = useState(false);
  const [skanuje, setSkanuje] = useState(false);
  const wideo = useRef<HTMLVideoElement | null>(null);

  const przyjmij = async (tresc: string) => {
    setPracuje(true);
    try {
      await odbierzPrzeniesienie(tresc);
      onGotowe();
    } catch (err) {
      onBlad(err);
    } finally {
      setPracuje(false);
    }
  };

  useEffect(() => {
    if (!skanuje) return;

    let strumien: MediaStream | null = null;
    let zatrzymane = false;

    void (async () => {
      try {
        const Detektor = (window as unknown as { BarcodeDetector?: new (o: object) => { detect(z: CanvasImageSource): Promise<{ rawValue: string }[]> } }).BarcodeDetector;
        if (!Detektor) throw new Error("ta przeglądarka nie czyta kodów QR z aparatu");

        strumien = await navigator.mediaDevices.getUserMedia({
          video: { facingMode: "environment" },
        });
        if (wideo.current) {
          wideo.current.srcObject = strumien;
          await wideo.current.play();
        }

        const detektor = new Detektor({ formats: ["qr_code"] });

        while (!zatrzymane) {
          await new Promise((r) => setTimeout(r, 250));
          if (!wideo.current) continue;

          const znalezione = await detektor.detect(wideo.current).catch(() => []);
          const pierwszy = znalezione[0]?.rawValue;
          if (pierwszy) {
            zatrzymane = true;
            setSkanuje(false);
            await przyjmij(pierwszy);
          }
        }
      } catch (err) {
        setSkanuje(false);
        onBlad(err);
      }
    })();

    return () => {
      zatrzymane = true;
      strumien?.getTracks().forEach((t) => t.stop());
    };
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [skanuje]);

  return (
    <section className="karta">
      <strong>Odbierz konto</strong>
      <p className="wskazowka">
        Na starym urządzeniu wybierz „Przenieś na inne urządzenie".
      </p>

      {skanuje ? (
        <>
          <video ref={wideo} className="podglad-aparatu" playsInline muted />
          <button onClick={() => setSkanuje(false)}>
            <Ikona nazwa="zamknij" rozmiar={16} />
            Przerwij skanowanie
          </button>
        </>
      ) : (
        <button onClick={() => setSkanuje(true)}>
          <Ikona nazwa="aparat" rozmiar={16} />
          Zeskanuj kod aparatem
        </button>
      )}

      <label>
        Albo przepisz kod
        <input
          value={kod}
          onChange={(e) => setKod(e.target.value)}
          placeholder="mekamb://transfer?…"
        />
      </label>

      <button className="glowny" disabled={pracuje || !kod.trim()} onClick={() => przyjmij(kod)}>
        {pracuje ? "Odbieram…" : "Odbierz konto"}
      </button>

      <button onClick={onAnuluj}>
        <Ikona nazwa="wstecz" rozmiar={16} />
        Wróć
      </button>

      <p className="wskazowka">
        Odebranie zastąpi konto na tym urządzeniu. Kod działa raz i wygasa po kwadransie.
      </p>
    </section>
  );
}
