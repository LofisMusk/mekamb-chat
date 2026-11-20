import { useEffect, useMemo, useRef } from "react";

import { Ikona } from "./Ikony";
import { godzina } from "./ListaRozmow";
import type { ZadanieRozmowy } from "./Rozmowa";
import { Pusto } from "./Wspolne";
import { Zalacznik } from "./Zalacznik";
import { Awatar } from "./components/ui/avatar";
import { Button } from "./components/ui/button";
import { Podpowiedz } from "./components/ui/tooltip";
import type { Wiadomosc, ZapisRozmowy } from "./lib/historia";
import type { Messenger } from "./lib/messenger";
import { opisStanu } from "./lib/potwierdzenia";
import { ulozWatek } from "./lib/watek";

/**
 * Pełna data i godzina — do `title` dymka.
 *
 * Rozdzielacz mówi, kiedy zaczął się kawałek rozmowy; to mówi, kiedy padło
 * TO zdanie. Nie zajmuje ani jednego piksela, dopóki ktoś nie zapyta.
 */
const PELNA_GODZINA = new Intl.DateTimeFormat(undefined, {
  dateStyle: "medium",
  timeStyle: "short",
});

function pelnaGodzina(czas: number): string {
  return PELNA_GODZINA.format(new Date(czas));
}

/** Wiadomość, której wysyłka jeszcze trwa albo się nie powiodła. */
export interface WLocie {
  id: string;
  tresc: string;
  czas: number;
  blad: boolean;
}

/**
 * Otwarta rozmowa: nagłówek, wiadomości, pole pisania.
 *
 * W całym wątku jest JEDNA plama `glowny` poza własnymi dymkami: strzałka
 * wysyłania, która taki dymek tworzy. Połączenie, wideo i szczegóły są
 * duchami — gdyby któryś był plamą, własny dymek przestałby się wyróżniać.
 */
export function Watek({
  messenger,
  groupId,
  rozmowca,
  nick,
  wiadomosci,
  wLocie,
  setWiadomosci,
  setWLocie,
  tresc,
  setTresc,
  setZadanieRozmowy,
  szczegolyOtwarte,
  setSzczegolyOtwarte,
  onBlad,
}: {
  messenger: Messenger;
  groupId: Uint8Array;
  rozmowca: string;
  nick: (username: string) => string;
  wiadomosci: Wiadomosc[];
  wLocie: WLocie[];
  setWiadomosci: React.Dispatch<React.SetStateAction<Wiadomosc[]>>;
  setWLocie: React.Dispatch<React.SetStateAction<WLocie[]>>;
  tresc: string;
  setTresc: (t: string) => void;
  setZadanieRozmowy: (z: ZadanieRozmowy) => void;
  szczegolyOtwarte: boolean;
  setSzczegolyOtwarte: (o: boolean | ((o: boolean) => boolean)) => void;
  onBlad: (e: unknown) => void;
}) {
  const lista = useRef<HTMLOListElement | null>(null);
  const pole = useRef<HTMLTextAreaElement | null>(null);

  /*
   * Wiadomości w locie idą przez ten sam układ co reszta.
   *
   * Rysowane osobno pod listą wypadały spod rozdzielacza dnia i nie sklejały
   * się z poprzednim dymkiem — wysłanie wiadomości rozbijało blok, który po
   * potwierdzeniu z powrotem się zrastał. Widać było skok.
   */
  const wszystkie = useMemo(
    () => [
      ...wiadomosci,
      ...wLocie.map((w) => ({ id: w.id, autor: "Ty", tresc: w.tresc, czas: w.czas, wlasna: true })),
    ],
    [wiadomosci, wLocie],
  );

  const stanyWysylki = useMemo(() => new Map(wLocie.map((w) => [w.id, w])), [wLocie]);
  const uklad = useMemo(() => ulozWatek(wszystkie, Date.now()), [wszystkie]);

  /*
   * Zjazd na dół po nowej wiadomości.
   *
   * Tylko wtedy, gdy użytkownik już był na dole. Przewijanie do dołu komuś,
   * kto czyta starszą część rozmowy, wyrywa mu tekst sprzed oczu — a nowa
   * wiadomość i tak zostanie zauważona, bo lista ma znacznik.
   */
  const naDole = useRef(true);
  useEffect(() => {
    const el = lista.current;
    if (el && naDole.current) el.scrollTop = el.scrollHeight;
  }, [uklad.length]);

  // Pole rośnie z treścią. Wysokość zerujemy przed odczytem `scrollHeight`,
  // bo inaczej pole raz urośnięte nigdy już nie zmaleje.
  useEffect(() => {
    const el = pole.current;
    if (!el) return;

    el.style.height = "auto";
    el.style.height = `${el.scrollHeight}px`;
  }, [tresc]);

  const wyslij = async () => {
    if (!tresc.trim()) return;

    // Wiadomość pojawia się natychmiast ze znacznikiem „wysyłam". Wcześniej
    // przez cały czas wysyłki — a przy nieudanej próbie bezpośredniej to kilka
    // sekund — nie działo się nic i nie było wiadomo, czy cokolwiek poszło.
    //
    // Identyfikator „w locie" jest tymczasowy i służy tylko do znalezienia tego
    // dymka po powrocie z wysyłki. Do historii trafia identyfikator Z RDZENIA:
    // potwierdzenia drugiej strony wskazują wiadomości właśnie po nim, więc
    // zapisanie własnego UUID-a znaczyłoby ptaszek, który nigdy się nie zmieni.
    const id = crypto.randomUUID();
    const wyslana = tresc;
    setWLocie((p) => [...p, { id, tresc: wyslana, czas: Date.now(), blad: false }]);
    setTresc("");

    try {
      const messageId = await messenger.sendText(groupId, wyslana);

      setWiadomosci((p) => [
        ...p,
        { id: messageId, autor: "Ty", tresc: wyslana, czas: Date.now(), wlasna: true },
      ]);
      setWLocie((p) => p.filter((w) => w.id !== id));
    } catch (err) {
      // Zostaje w locie, oznaczona jako nieudana. Treść nie przepada:
      // zawiodła sieć, nie użytkownik.
      setWLocie((p) => p.map((w) => (w.id === id ? { ...w, blad: true } : w)));
      onBlad(err);
    }
  };

  return (
    <div className="flex h-full min-h-0 min-w-0 flex-col">
      <header className="flex h-16 shrink-0 items-center gap-1 border-b border-linia px-2 md:gap-2 md:px-4">
        {/* Na wąskim ekranie rozmowa zajmuje cały widok, więc bez tego nie ma
            jak wrócić do listy. Na szerokim lista stoi obok i strzałka jest
            zbędna. Wyjście idzie przez historię przeglądarki, więc strzałka,
            gest i systemowe „wstecz" robią dokładnie to samo. */}
        <Button
          variant="ghost"
          size="icon"
          className="md:hidden"
          aria-label="Wróć do listy rozmów"
          onClick={() => history.back()}
        >
          <Ikona nazwa="wstecz" rozmiar={20} />
        </Button>

        {/* Tożsamość jest też wejściem do szczegółów: to w nią się klika,
            żeby zobaczyć, kto jest w rozmowie. */}
        <button
          type="button"
          className="flex min-w-0 flex-1 cursor-pointer items-center gap-3 rounded-md py-1 pr-2 text-left"
          onClick={() => setSzczegolyOtwarte((o) => !o)}
          aria-label={`${rozmowca} — szczegóły rozmowy`}
        >
          <Awatar nazwa={rozmowca} rozmiar="md" />
          <span className="flex min-w-0 flex-col">
            <span className="truncate text-tresc font-semibold tracking-[-0.01em]">{rozmowca}</span>
          </span>
        </button>

        <div className="flex shrink-0 items-center">
          <Podpowiedz tresc="Zadzwoń">
            <Button
              variant="ghost"
              size="icon"
              aria-label="Zadzwoń"
              onClick={() => setZadanieRozmowy({ wideo: false, n: Date.now() })}
            >
              <Ikona nazwa="sluchawka" rozmiar={19} />
            </Button>
          </Podpowiedz>
          <Podpowiedz tresc="Rozmowa z obrazem">
            <Button
              variant="ghost"
              size="icon"
              aria-label="Rozmowa z obrazem"
              onClick={() => setZadanieRozmowy({ wideo: true, n: Date.now() })}
            >
              <Ikona nazwa="kamera" rozmiar={19} />
            </Button>
          </Podpowiedz>
          <Podpowiedz tresc="Uczestnicy i kod bezpieczeństwa">
            <Button
              variant="ghost"
              size="icon"
              aria-label="Uczestnicy i kod bezpieczeństwa"
              aria-pressed={szczegolyOtwarte}
              className="aria-pressed:bg-wglebienie"
              onClick={() => setSzczegolyOtwarte((o) => !o)}
            >
              <Ikona nazwa="osoby" rozmiar={19} />
            </Button>
          </Podpowiedz>
        </div>
      </header>

      {/* Rozmowy A/V tu NIE MA — jest osobnym ekranem ponad układem (`Czat`).
          Ślad po niej idzie do tej samej listy co wiadomości: rozmowa
          i wiadomość dzieją się w tej samej osi czasu i mają się w niej
          przeplatać. */}

      <ol
        className="wiadomosci"
        ref={lista}
        onScroll={(e) => {
          const el = e.currentTarget;
          naDole.current = el.scrollHeight - el.scrollTop - el.clientHeight < 80;
        }}
      >
        {/* W `<ol>` wolno stać tylko elementom `<li>` — pusty stan też. */}
        {uklad.length === 0 && (
          <li className="pusto-watku">
            <Pusto ikona="rozmowy" tytul="Tu jeszcze nic nie ma" wskazowka="Napisz pierwszy." />
          </li>
        )}

        {uklad.map((pozycja) =>
          pozycja.rodzaj === "rozdzielacz" ? (
            /* Dzień wytłuszczony, godzina zwykła — jedno zdanie, nie dwie
               etykiety. Godziny nie ma w dymkach, więc to jedyne miejsce
               w wątku, które odpowiada na pytanie „kiedy". */
            <li key={pozycja.klucz} className="rozdzielacz">
              <strong>{pozycja.etykieta}</strong> {godzina(pozycja.czas)}
            </li>
          ) : pozycja.wiadomosc.rozmowa ? (
            <ZdarzenieRozmowy
              key={pozycja.klucz}
              wiadomosc={pozycja.wiadomosc}
              rozmowa={pozycja.wiadomosc.rozmowa}
            />
          ) : (
            <Dymek
              key={pozycja.klucz}
              messenger={messenger}
              wiadomosc={pozycja.wiadomosc}
              nick={nick}
              ciag={pozycja.ciag}
              ogon={pozycja.ogon}
              ostatniaWlasna={pozycja.ostatniaWlasna}
              stan={stanyWysylki.get(pozycja.wiadomosc.id)}
              onBlad={onBlad}
            />
          ),
        )}
      </ol>

      <div className="shrink-0 px-3 pt-1 pb-[calc(8px+var(--bezpiecznie-dol))] md:px-4 md:pb-3">
        <form
          className="flex items-end gap-2"
          onSubmit={(e) => {
            e.preventDefault();
            void wyslij();
          }}
        >
          <DolaczPlik
            messenger={messenger}
            groupId={groupId}
            setWiadomosci={setWiadomosci}
            setWLocie={setWLocie}
            onBlad={onBlad}
          />

          {/* Pole: `wglebienie`, promień 20, bez obramowania. Rośnie z treścią,
              ale nie w nieskończoność — jednowierszowe pole przy dłuższej
              wiadomości pokazuje ostatnie kilka słów i nie da się przeczytać
              tego, co się właśnie napisało. */}
          <div className="pole-pisania flex min-h-10 min-w-0 flex-1 items-end rounded-pole bg-wglebienie px-4">
            <textarea
              ref={pole}
              rows={1}
              value={tresc}
              onChange={(e) => setTresc(e.target.value)}
              placeholder="Napisz wiadomość"
              aria-label="Treść wiadomości"
              className="max-h-32 min-h-0 w-full flex-1 resize-none bg-transparent py-[9px] text-tresc leading-[1.4] text-tekst outline-none placeholder:text-tekst-trzeci"
              onPaste={(e) => {
                /*
                 * Wklejone zdjęcie ląduje w wiadomości, nie w polu tekstowym.
                 *
                 * Zrzut ekranu albo skopiowany obraz trafia do schowka jako plik —
                 * pole tekstowe ignoruje pliki, więc gest, który wszędzie indziej
                 * „wkleja obrazek", tutaj po cichu przepadał. Sam tekst zostawiamy
                 * polu: `preventDefault` tylko wtedy, gdy naprawdę mamy obraz.
                 */
                const plik = obrazZeSchowka(e.clipboardData);
                if (!plik) return;
                e.preventDefault();
                void wyslijPlik(messenger, groupId, plik, setWiadomosci, setWLocie, onBlad);
              }}
              onKeyDown={(e) => {
                /*
                 * Enter wysyła, Shift+Enter łamie wiersz.
                 *
                 * Odwrotnie niż w formularzu, bo to pole rozmowy: wysłanie jest tu
                 * czynnością wykonywaną co kilkanaście sekund, a nowy akapit —
                 * rzadko.
                 */
                if (e.key === "Enter" && !e.shiftKey && !e.nativeEvent.isComposing) {
                  e.preventDefault();
                  void wyslij();
                }
              }}
            />
          </div>

          {/*
            Strzałka: okrąg `glowny` 36×36 — jedyna plama w wątku poza własnymi
            dymkami. Wolno jej, bo mówi dokładnie to, co dymek, który za chwilę
            powstanie: „to jest moje". Wyszarzała, gdy nie ma czego wysłać.
            Pole dotyku dokłada `::after` do 44 px bez powiększania kółka.
          */}
          <button
            type="submit"
            disabled={!tresc.trim()}
            aria-label="Wyślij"
            className="relative mb-0.5 grid size-9 shrink-0 cursor-pointer place-items-center rounded-full bg-glowny text-glowny-tekst transition-[background-color,color] duration-150 after:absolute after:-inset-1 after:content-[''] hover:bg-glowny/88 disabled:cursor-default disabled:bg-wglebienie disabled:text-tekst-trzeci"
          >
            <Ikona nazwa="wyslij" rozmiar={18} />
          </button>
        </form>

        {/* Obietnica przed wysłaniem, nie po. Po fakcie nie daje już wyboru. */}
        <p className="mt-1.5 flex items-center justify-center gap-1.5 text-center text-podpis text-tekst-trzeci md:justify-start md:pl-12">
          <Ikona nazwa="tarcza" rozmiar={12} />
          Ze zdjęć i nagrań usuwamy lokalizację oraz dane urządzenia przed wysłaniem.
        </p>
      </div>
    </div>
  );
}

/**
 * Ślad po rozmowie A/V w wątku.
 *
 * # Dlaczego to nie jest dymek
 *
 * Bo nikt tego nie powiedział. Dymek — z bokiem i ogonkiem — mówi „ta osoba
 * napisała to zdanie". Rozmowa się wydarzyła, a nie została wysłana, więc stoi
 * na środku, tak samo jak rozdzielacz dnia.
 *
 * Ikona jest DOKŁADNIE ta, którą się w tę rozmowę weszło: słuchawka przy
 * głosowej, kamera przy wideo.
 */
function ZdarzenieRozmowy({ wiadomosc, rozmowa }: { wiadomosc: Wiadomosc; rozmowa: ZapisRozmowy }) {
  const odbyta = rozmowa.sekundy !== undefined;

  // Nieodebrana wychodząca to „nikt nie odebrał", przychodząca — „nie odebrałeś".
  // To dwie różne rzeczy i tylko druga jest czymś, co się przegapiło.
  const opis = odbyta
    ? `${rozmowa.wideo ? "Rozmowa wideo" : "Rozmowa głosowa"} · ${trwanieRozmowy(rozmowa.sekundy ?? 0)}`
    : rozmowa.wychodzaca
      ? "Nikt nie odebrał"
      : `Nieodebrana rozmowa ${rozmowa.wideo ? "wideo" : "głosowa"}`;

  return (
    <li className={odbyta ? "zdarzenie" : "zdarzenie nieodebrane"}>
      <Ikona nazwa={rozmowa.wideo ? "kamera" : "sluchawka"} rozmiar={14} />
      <span>{opis}</span>
      <span className="czas-zdarzenia">{godzina(wiadomosc.czas)}</span>
    </li>
  );
}

/** Czas trwania jako `m:ss`; godziny dopiero wtedy, gdy są. */
function trwanieRozmowy(sekundy: number): string {
  const s = Math.max(0, Math.floor(sekundy));
  const minuty = Math.floor(s / 60);
  const reszta = String(s % 60).padStart(2, "0");

  if (minuty < 60) return `${minuty}:${reszta}`;
  return `${Math.floor(minuty / 60)}:${String(minuty % 60).padStart(2, "0")}:${reszta}`;
}

function Dymek({
  messenger,
  wiadomosc,
  nick,
  ciag,
  ogon,
  ostatniaWlasna,
  stan,
  onBlad,
}: {
  messenger: Messenger;
  wiadomosc: Wiadomosc;
  nick: (username: string) => string;
  ciag: boolean;
  ogon: boolean;
  ostatniaWlasna: boolean;
  stan?: WLocie;
  onBlad: (e: unknown) => void;
}) {
  const klasy = ["", wiadomosc.wlasna ? "wlasna" : "", ciag ? "ciag" : "", ogon ? "ogon" : ""];
  if (stan) klasy.push(stan.blad ? "nieudana" : "w-locie");

  /*
   * Jeden stan zamiast trzech warunków rozsypanych po JSX.
   *
   * Wysyłka w locie ma pierwszeństwo nad zapisanym stanem: dopóki nie wróciło
   * potwierdzenie wysłania, potwierdzenia odczytu nie ma prawa być.
   */
  const stanWysylki = stan ? (stan.blad ? "nieudana" : "w-locie") : (wiadomosc.stan ?? "wyslane");

  const opis = opisStanu(stanWysylki);

  /*
   * Stan wysyłki pod ostatnim własnym dymkiem, nie w każdym.
   *
   * Ptaszek przy każdej własnej wiadomości to kolumna powtórzonego „wysłano",
   * a odpowiada on na pytanie zadawane o JEDNĄ wiadomość — tę ostatnią.
   * Wyjątkiem są stany, z którymi trzeba coś zrobić: „wysyłam" i „nie wysłano"
   * pokazujemy zawsze, bo milczenie przy nich znaczyłoby „doszło".
   */
  const zeStanem =
    wiadomosc.wlasna && (ostatniaWlasna || stanWysylki === "w-locie" || stanWysylki === "nieudana");

  return (
    <>
      {/* Godzina wyszła z dymka na rozdzielacz, ale nie przepadła — `title`
          odpowiada na „a ta konkretna o której?" bez zajmowania wiersza. */}
      <li className={klasy.join(" ").trim()} title={pelnaGodzina(wiadomosc.czas)}>
        {/* Autor tylko na początku bloku i tylko przy cudzych — przy własnych
            mówi to jasność dymka, a powtórzony przy każdej wiadomości jest szumem. */}
        {!wiadomosc.wlasna && !ciag && <span className="autor">{nick(wiadomosc.autor)}</span>}

        {/*
          Załącznik i treść mogą stać w jednym dymku — wiadomość z obrazem musi
          móc nieść zdanie o tym, że z tego pliku nie udało się usunąć metadanych.
        */}
        {wiadomosc.zalacznik && (
          <Zalacznik messenger={messenger} zalacznik={wiadomosc.zalacznik} onBlad={onBlad} />
        )}
        {wiadomosc.tresc && <span className="tresc">{wiadomosc.tresc}</span>}
      </li>

      {zeStanem && (
        <li className={stanWysylki === "nieudana" ? "stan-wysylki nieudany" : "stan-wysylki"}>
          {duzaLitera(opis.etykieta)}
        </li>
      )}
    </>
  );
}

/** Pierwsza litera wielka — opisy stanów są zdaniem, nie etykietą w tabeli. */
function duzaLitera(tekst: string): string {
  return tekst.charAt(0).toUpperCase() + tekst.slice(1);
}

/**
 * Wysyła jeden plik jako załącznik i nanosi go na wątek.
 *
 * Załącznik wchodzi dwiema drogami: spinaczem i wklejeniem ze schowka
 * (Ctrl/⌘+V). Obie robią dokładnie to samo, więc robi to jedna funkcja —
 * inaczej rozjechałyby się przy pierwszej poprawce w jednej z nich.
 */
async function wyslijPlik(
  messenger: Messenger,
  groupId: Uint8Array,
  plik: File,
  setWiadomosci: React.Dispatch<React.SetStateAction<Wiadomosc[]>>,
  setWLocie: React.Dispatch<React.SetStateAction<WLocie[]>>,
  onBlad: (e: unknown) => void,
): Promise<void> {
  // Wgranie pliku trwa dłużej niż tekst — dochodzi czyszczenie metadanych,
  // szyfrowanie i wysyłka. Bez znacznika wygląda to jak zawieszenie.
  const id = crypto.randomUUID();
  const nazwa = plik.name || "zdjęcie";
  setWLocie((p) => [...p, { id, tresc: `wysyłam: ${nazwa}`, czas: Date.now(), blad: false }]);

  try {
    const { stripped, messageId, zalacznik } = await messenger.sendFile(groupId, plik);

    /*
     * Własne zdjęcie jest ZDJĘCIEM, nie napisem „wysłano: kot.jpg".
     *
     * Opis załącznika wraca z `sendFile`, więc własny dymek rysuje ten sam
     * składnik co cudzy i odszyfrowuje ten sam szyfrogram. Treść zostaje pusta,
     * gdy wszystko poszło dobrze; nieudane czyszczenie metadanych mówimy wprost,
     * bo to jedyna rzecz, z którą użytkownik może coś zrobić.
     */
    setWiadomosci((p) => [
      ...p,
      {
        id: messageId,
        autor: "Ty",
        tresc: stripped ? "" : "nie udało się usunąć metadanych z tego pliku",
        czas: Date.now(),
        wlasna: true,
        zalacznik,
      },
    ]);
    setWLocie((p) => p.filter((w) => w.id !== id));
  } catch (err) {
    setWLocie((p) => p.map((w) => (w.id === id ? { ...w, tresc: nazwa, blad: true } : w)));
    onBlad(err);
  }
}

/**
 * Wyławia zdjęcie ze zdarzenia wklejenia.
 *
 * Zwraca pierwszy plik obrazkowy w schowku albo `null`. Wklejenie samego tekstu
 * (najczęstszy przypadek) nie ma tu nic i zostawiamy je polu tekstowemu.
 */
function obrazZeSchowka(dane: DataTransfer | null): File | null {
  if (!dane) return null;
  for (const element of dane.items) {
    if (element.kind === "file" && element.type.startsWith("image/")) {
      const plik = element.getAsFile();
      if (plik) return plik;
    }
  }
  return null;
}

/**
 * Spinacz przy polu, nie prostokąt nad nim.
 *
 * Wielki obszar „Dołącz zdjęcie lub wideo" zajmował tyle miejsca co dwie
 * wiadomości i podpowiadał, że załącznik jest głównym sposobem pisania.
 * Duch, nie plama: plama w wątku należy do strzałki wysyłania.
 */
function DolaczPlik({
  messenger,
  groupId,
  setWiadomosci,
  setWLocie,
  onBlad,
}: {
  messenger: Messenger;
  groupId: Uint8Array;
  setWiadomosci: React.Dispatch<React.SetStateAction<Wiadomosc[]>>;
  setWLocie: React.Dispatch<React.SetStateAction<WLocie[]>>;
  onBlad: (e: unknown) => void;
}) {
  return (
    <Podpowiedz tresc="Dołącz zdjęcie lub wideo" strona="top">
      <label className="relative mb-0.5 grid size-9 shrink-0 cursor-pointer place-items-center rounded-full text-tekst-drugi transition-colors duration-150 after:absolute after:-inset-1 after:content-[''] hover:bg-wglebienie hover:text-tekst has-[:focus-visible]:outline-2 has-[:focus-visible]:outline-offset-2 has-[:focus-visible]:outline-pierscien">
        <input
          type="file"
          accept="image/*,video/*"
          className="tylko-dla-czytnika"
          onChange={async (e) => {
            const plik = e.target.files?.[0];
            // Czyścimy pole od razu, żeby dało się wysłać ten sam plik dwa razy.
            e.target.value = "";
            if (!plik) return;
            await wyslijPlik(messenger, groupId, plik, setWiadomosci, setWLocie, onBlad);
          }}
        />
        <Ikona nazwa="spinacz" rozmiar={20} />
        <span className="tylko-dla-czytnika">Dołącz zdjęcie lub wideo</span>
      </label>
    </Podpowiedz>
  );
}
