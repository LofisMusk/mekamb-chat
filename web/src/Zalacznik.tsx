import { useEffect, useState } from "react";

import { Ikona, type NazwaIkony } from "./Ikony";
import type { Messenger, ReceivedAttachment } from "./lib/messenger";

/**
 * Załącznik w rozmowie.
 *
 * # Zdjęcia i nagrania odszyfrowują się same
 *
 * Wcześniej każde wymagało kliknięcia i wyglądało jak odnośnik do pliku —
 * a zdjęcie w rozmowie ma być zdjęciem, nie zadaniem do wykonania.
 * Deszyfrowanie dzieje się lokalnie, więc jedynym kosztem jest pobranie
 * szyfrogramu, które i tak nastąpiłoby po kliknięciu.
 *
 * Pozostałe pliki zostają za przyciskiem: dokumentu i tak nie ma jak pokazać
 * w wątku, a pobieranie ich w tle byłoby ruchem, o który nikt nie prosił.
 */
export function Zalacznik({
  messenger,
  zalacznik,
  onBlad,
}: {
  messenger: Messenger;
  zalacznik: ReceivedAttachment;
  onBlad: (e: unknown) => void;
}) {
  const [url, setUrl] = useState<string | null>(null);
  const [pobiera, setPobiera] = useState(false);

  const obraz = zalacznik.mimeType.startsWith("image/");
  const wideo = zalacznik.mimeType.startsWith("video/");
  const media = obraz || wideo;

  useEffect(() => {
    if (!media) return;
    let aktualne = true;

    setPobiera(true);
    messenger
      .openAttachmentUrl(zalacznik)
      .then((adres) => {
        if (aktualne) setUrl(adres);
        // Karta mogła zniknąć w trakcie — wtedy zwalniamy od razu, bo
        // sprzątanie po odmontowanym komponencie już nie nastąpi.
        else URL.revokeObjectURL(adres);
      })
      .catch(onBlad)
      .finally(() => {
        if (aktualne) setPobiera(false);
      });

    return () => {
      aktualne = false;
    };
  }, [messenger, zalacznik, media, onBlad]);

  useEffect(() => {
    // Adres `blob:` wskazuje na odszyfrowane dane w pamięci karty. Bez
    // zwolnienia zostaje tam do jej zamknięcia.
    return () => {
      if (url) URL.revokeObjectURL(url);
    };
  }, [url]);

  const rozmiarMb = (zalacznik.sizeBytes / 1024 / 1024).toFixed(1);
  const nazwa = zalacznik.fileName ?? "załącznik";

  // Ikona mówi, czego nie widać: dokument nie ma podglądu, więc jego rodzaj
  // jest jedyną informacją, jaką da się pokazać przed pobraniem.
  const piktogram: NazwaIkony = obraz ? "zdjecie" : wideo ? "film" : "plik";

  if (!url) {
    if (media) {
      return (
        <span className="zalacznik-czeka">
          <Ikona nazwa={pobiera ? "zegar" : "niepowodzenie"} rozmiar={14} />
          {pobiera ? "Odszyfrowuję…" : "nie udało się odszyfrować"}
        </span>
      );
    }

    return (
      <button
        className="zalacznik-pobierz"
        disabled={pobiera}
        onClick={async () => {
          setPobiera(true);
          try {
            setUrl(await messenger.openAttachmentUrl(zalacznik));
          } catch (err) {
            onBlad(err);
          } finally {
            setPobiera(false);
          }
        }}
      >
        <Ikona nazwa={pobiera ? "zegar" : piktogram} rozmiar={14} />
        {pobiera ? "Odszyfrowuję…" : `${nazwa} · ${rozmiarMb} MB`}
      </button>
    );
  }

  if (obraz) return <img className="zalacznik" src={url} alt={nazwa} />;
  if (wideo) return <video className="zalacznik" src={url} controls playsInline />;

  return (
    <a className="zalacznik-pobierz" href={url} download={zalacznik.fileName ?? "zalacznik"}>
      <Ikona nazwa="pobierz" rozmiar={14} />
      Pobierz {nazwa}
    </a>
  );
}
