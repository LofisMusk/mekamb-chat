import { Dialog as DialogPrimitive } from "radix-ui";
import { useEffect, useState } from "react";

import { Ikona, type NazwaIkony } from "./Ikony";
import { Migotanie } from "./Wspolne";
import type { Messenger, ReceivedAttachment } from "./lib/messenger";
import { t } from "./lib/jezyk";

/*
 * Przycisk pliku w dymku bierze kolor z tekstu dymka (`currentColor`), a nie
 * z tokenów: ten sam składnik stoi w dymku `glowny` i w `wglebienie`, więc obrys
 * w `linia` znikałby w jednym z nich.
 */
const klasyPliku =
  "inline-flex max-w-full cursor-pointer items-center gap-2 rounded-md border border-current/25 px-2.5 py-1.5 text-meta text-current no-underline transition-colors hover:bg-current/10 disabled:cursor-default disabled:opacity-60";

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
  const [naPelnym, setNaPelnym] = useState(false);

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
  const nazwa = zalacznik.fileName ?? t("załącznik", "attachment");

  // Ikona mówi, czego nie widać: dokument nie ma podglądu, więc jego rodzaj
  // jest jedyną informacją, jaką da się pokazać przed pobraniem.
  const piktogram: NazwaIkony = obraz ? "zdjecie" : wideo ? "film" : "plik";

  if (!url) {
    if (media) {
      // Prostokąt na miejscu zdjęcia, a nie sam napis: wątek nie skacze, kiedy
      // obraz w końcu się pojawi.
      return pobiera ? (
        <Migotanie
          className="zalacznik-media h-44 w-60 max-w-full rounded-[14px]"
          opis={t("Odszyfrowuję…", "Decrypting…")}
        />
      ) : (
        <span className="flex items-center gap-1.5 px-1 py-1 text-meta opacity-80">
          <Ikona nazwa="niepowodzenie" rozmiar={14} />
          {t("nie udało się odszyfrować", "couldn't decrypt")}
        </span>
      );
    }

    return (
      <button
        type="button"
        className={klasyPliku}
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
        <span className="truncate">{pobiera ? t("Odszyfrowuję…", "Decrypting…") : t(`${nazwa} · ${rozmiarMb} MB`, `${nazwa} · ${rozmiarMb} MB`)}</span>
      </button>
    );
  }

  // Zdjęcie otwiera się na pełny ekran; nagranie ma własne sterowanie, więc
  // kliknięcie w nie znaczyłoby „pauza", a nie „powiększ" — zostaje w wątku.
  if (obraz) {
    return (
      <>
        <button
          type="button"
          className="zalacznik-media block cursor-zoom-in rounded-[14px] transition-[filter] duration-150 hover:brightness-[1.04]"
          onClick={() => setNaPelnym(true)}
          aria-label={t(`Powiększ zdjęcie: ${nazwa}`, `Enlarge photo: ${nazwa}`)}
        >
          <img className="zalacznik" src={url} alt={nazwa} />
        </button>
        <Pelnoekranowy url={url} nazwa={nazwa} otwarty={naPelnym} onZmiana={setNaPelnym} />
      </>
    );
  }
  if (wideo) return <video className="zalacznik zalacznik-media" src={url} controls playsInline />;

  return (
    <a className={klasyPliku} href={url} download={zalacznik.fileName ?? "zalacznik"}>
      <Ikona nazwa="pobierz" rozmiar={14} />
      <span className="truncate">{t("Pobierz", "Download")} {nazwa}</span>
    </a>
  );
}

/**
 * Zdjęcie na pełny ekran.
 *
 * # Dlaczego to nie jest zwykłe `<a target="_blank">`
 *
 * Bo adres jest `blob:` odszyfrowanym w pamięci tej karty — nowa karta i tak
 * nie miałaby do niego dostępu po jej zamknięciu, a przy okazji odszyfrowane
 * zdjęcie trafiłoby do historii przeglądarki jako osobny wpis. Nakładka trzyma
 * je w tej samej karcie i znika bez śladu. `Escape`, klik w tło i systemowe
 * „wstecz" (gest) zamykają ją tak samo — bezpieczne wyjście ma być łatwe.
 */
function Pelnoekranowy({
  url,
  nazwa,
  otwarty,
  onZmiana,
}: {
  url: string;
  nazwa: string;
  otwarty: boolean;
  onZmiana: (otwarty: boolean) => void;
}) {
  // Dialog Radix, nie własna nakładka: pułapka fokusu, `Escape` i powrót
  // fokusu do miniatury przychodzą razem z nim. Tło jest czarne w obu motywach
  // — zdjęcie ogląda się na czerni, nie na kolorze aplikacji.
  return (
    <DialogPrimitive.Root open={otwarty} onOpenChange={onZmiana}>
      <DialogPrimitive.Portal>
        <DialogPrimitive.Overlay className="fixed inset-0 z-[60] bg-black/88 data-[state=open]:animate-in data-[state=open]:fade-in-0 data-[state=closed]:animate-out data-[state=closed]:fade-out-0" />
        <DialogPrimitive.Content
          aria-describedby={undefined}
          className="fixed inset-0 z-[60] flex cursor-zoom-out items-center justify-center p-4 outline-none md:p-10 data-[state=open]:animate-in data-[state=open]:fade-in-0 data-[state=closed]:animate-out data-[state=closed]:fade-out-0"
          onClick={() => onZmiana(false)}
        >
          <DialogPrimitive.Title className="tylko-dla-czytnika">{t("Zdjęcie:", "Photo:")} {nazwa}</DialogPrimitive.Title>
          <DialogPrimitive.Close
            className="absolute top-[max(16px,var(--bezpiecznie-gora))] right-4 grid size-10 cursor-pointer place-items-center rounded-full bg-white/12 text-white transition-colors hover:bg-white/22"
            aria-label={t("Zamknij", "Close")}
          >
            <Ikona nazwa="zamknij" rozmiar={20} />
          </DialogPrimitive.Close>
          {/* Klik w samo zdjęcie NIE zamyka — inaczej próba przyjrzenia się
              szczegółowi wyrzucałaby z podglądu. Zamyka tło i krzyżyk. */}
          <img
            className="max-h-full max-w-full cursor-default rounded-sm object-contain"
            src={url}
            alt={nazwa}
            onClick={(e) => e.stopPropagation()}
          />
        </DialogPrimitive.Content>
      </DialogPrimitive.Portal>
    </DialogPrimitive.Root>
  );
}
