import { useEffect, useRef, useState } from "react";

import { KodQr } from "./KodQr";
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
    return (
      <button
        className="przenies"
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
        {pracuje ? "Przygotowuję…" : "Przenieś na inne urządzenie"}
      </button>
    );
  }

  const minuty = Math.floor(zostalo / 60);
  const sekundy = String(zostalo % 60).padStart(2, "0");

  return (
    <section className="karta przeniesienie">
      <h2>Przenieś konto</h2>

      {zostalo > 0 ? (
        <>
          <p>Zeskanuj ten kod na nowym urządzeniu:</p>
          <KodQr tresc={kod.tresc} opis="Kod QR do przeniesienia konta" />
          <p className="wskazowka">
            Kod ważny jeszcze <strong>{minuty}:{sekundy}</strong>. Można go użyć tylko raz.
          </p>

          <details className="sekret-recznie">
            <summary>Nowe urządzenie nie ma aparatu?</summary>
            <code className="sekret">{kod.tresc}</code>
          </details>

          <p className="ostrzezenie">
            <strong>Kto zobaczy ten kod, przejmuje konto.</strong> Nie fotografuj go
            i nie wysyłaj — pokaż wprost z ekranu na ekran.
          </p>
        </>
      ) : (
        <p className="ostrzezenie">
          Kod wygasł. Zamknij to okno i zacznij od nowa.
        </p>
      )}

      <p className="wskazowka">
        Przenoszona jest tożsamość i możliwość kontynuowania rozmów.
        <strong> Wcześniejsze wiadomości nie</strong> — aplikacja nigdzie ich nie zapisuje.
      </p>

      <button
        className="rozlacz"
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
        Odebrane — usuń konto z tego urządzenia
      </button>

      <p className="wskazowka">
        Trzeba to zrobić. Dwa urządzenia z tym samym kontem rozsypią szyfrowanie
        rozmowy i żadna ze stron nie odczyta już wiadomości.
      </p>
    </section>
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
      <h2>Odbierz konto</h2>
      <p>Na starym urządzeniu wybierz „Przenieś na inne urządzenie".</p>

      {skanuje ? (
        <>
          <video ref={wideo} className="podglad-aparatu" playsInline muted />
          <button onClick={() => setSkanuje(false)}>Przerwij skanowanie</button>
        </>
      ) : (
        <button onClick={() => setSkanuje(true)}>Zeskanuj kod aparatem</button>
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

      <button onClick={onAnuluj}>Wróć</button>

      <p className="wskazowka">
        Odebranie zastąpi konto na tym urządzeniu. Kod działa raz i wygasa po kwadransie.
      </p>
    </section>
  );
}
