import { useRef, useState } from "react";

import { Ikona } from "./Ikony";
import { Pusto, Znacznik } from "./Wspolne";
import {
  AlertDialog,
  AlertDialogAction,
  AlertDialogCancel,
  AlertDialogContent,
  AlertDialogDescription,
  AlertDialogFooter,
  AlertDialogHeader,
  AlertDialogTitle,
} from "./components/ui/alert-dialog";
import { Arkusz } from "./components/ui/arkusz";
import { Awatar } from "./components/ui/avatar";
import { Button } from "./components/ui/button";
import { cn } from "./components/ui/cn";
import {
  ContextMenu,
  ContextMenuContent,
  ContextMenuItem,
  ContextMenuTrigger,
  DropdownMenu,
  DropdownMenuContent,
  DropdownMenuItem,
  DropdownMenuTrigger,
} from "./components/ui/dropdown-menu";
import { Input } from "./components/ui/input";
import { ScrollArea } from "./components/ui/scroll-area";
import { Podpowiedz } from "./components/ui/tooltip";
import { type PozycjaListy, type Wiadomosc, kluczRozmowy } from "./lib/historia";
import { t } from "./lib/jezyk";

/**
 * Lista rozmów: nagłówek, prośby, szukanie i wiersze.
 *
 * Kolumna 320 px na desktopie, cały ekran na telefonie. Rozpoczęcie rozmowy
 * NIE jest tu plamą `glowny`: na desktopie obok stoi wątek ze strzałką
 * wysyłania, a na ekranie ma być najwyżej jedna akcja główna. „Nowa rozmowa"
 * jest więc duchem z menu — tak samo jak w pasku wątku.
 */

const GODZINA = new Intl.DateTimeFormat(undefined, { hour: "2-digit", minute: "2-digit" });

/**
 * Godzina wiadomości — bez daty.
 *
 * Dzień rozdziela osobna etykieta w wątku; na liście liczy się „o której",
 * a data przy każdym wierszu jest szumem.
 */
export function godzina(czas: number): string {
  return GODZINA.format(new Date(czas));
}

/**
 * Jak wiadomość brzmi na liście rozmów.
 *
 * Załącznik nie ma treści do zacytowania, a od kiedy własne zdjęcie jest
 * zdjęciem (a nie napisem „wysłano: kot.jpg"), wiersz listy zostawał pusty.
 * Rodzaj pliku mówi tyle, ile da się powiedzieć jednym słowem — nazwy pliku
 * świadomie nie pokazujemy, bo bywa nią data i model aparatu.
 */
export function zapowiedz(w: Wiadomosc): string {
  if (w.rozmowa) {
    if (w.rozmowa.sekundy === undefined) return t("Nieodebrana rozmowa", "Missed call");
    return w.rozmowa.wideo ? t("Rozmowa wideo", "Video call") : t("Rozmowa głosowa", "Voice call");
  }

  if (w.tresc) return w.tresc;
  if (!w.zalacznik) return "";

  if (w.zalacznik.mimeType.startsWith("image/")) return t("Zdjęcie", "Photo");
  if (w.zalacznik.mimeType.startsWith("video/")) return t("Nagranie", "Video");
  return t("Plik", "File");
}

export function PanelListy({
  rozmowy,
  prosby,
  wszystkich,
  szukane,
  onSzukane,
  nazwaPozycji,
  otwarta,
  onNowyCzat,
  onNowaGrupa,
  onPrzyjmij,
  onOdrzuc,
  onOtworz,
  onUsun,
}: {
  rozmowy: PozycjaListy[];
  prosby: PozycjaListy[];
  wszystkich: number;
  szukane: string;
  onSzukane: (s: string) => void;
  nazwaPozycji: (p: PozycjaListy) => string;
  otwarta: Uint8Array | null;
  onNowyCzat: () => void;
  onNowaGrupa: () => void;
  onPrzyjmij: (p: PozycjaListy) => void;
  onOdrzuc: (p: PozycjaListy) => void;
  onOtworz: (p: PozycjaListy) => void;
  onUsun: (p: PozycjaListy) => void;
}) {
  const kluczOtwartej = otwarta ? kluczRozmowy(otwarta) : null;

  // Rozmowa czekająca na potwierdzenie usunięcia — jedno pytanie dla wszystkich
  // dróg (gest, przycisk spod wiersza, menu). Usuwamy dopiero po „Usuń".
  const [doUsuniecia, setDoUsuniecia] = useState<PozycjaListy | null>(null);

  return (
    <aside className="panel-listy" aria-label={t("Lista rozmów", "Conversation list")}>
      <div className="flex h-16 shrink-0 items-center gap-1 pr-2 pl-4">
        <h2 className="flex-1 text-tytul">{t("Rozmowy", "Chats")}</h2>

        {/*
          Dwa wejścia zamiast dawnej zakładki Kontakty: „Nowy czat” (nazwa
          użytkownika → rozmowa jeden na jeden) i „Nowa grupa" (wybór osób).
          Pod jednym przyciskiem, bo oba odpowiadają na to samo pytanie:
          „z kim chcę zacząć rozmawiać".
        */}
        <DropdownMenu>
          <Podpowiedz tresc={t("Nowa rozmowa", "New conversation")}>
            <DropdownMenuTrigger asChild>
              <Button variant="ghost" size="icon" aria-label={t("Nowa rozmowa", "New conversation")}>
                <Ikona nazwa="dodaj" rozmiar={20} />
              </Button>
            </DropdownMenuTrigger>
          </Podpowiedz>
          <DropdownMenuContent align="end">
            <DropdownMenuItem onSelect={onNowyCzat}>
              <Ikona nazwa="kontakty" rozmiar={16} />
              {t("Nowy czat", "New chat")}
            </DropdownMenuItem>
            <DropdownMenuItem onSelect={onNowaGrupa}>
              <Ikona nazwa="osoby" rozmiar={16} />
              {t("Nowa grupa", "New group")}
            </DropdownMenuItem>
          </DropdownMenuContent>
        </DropdownMenu>
      </div>

      {/* Szukanie pojawia się dopiero, gdy jest w czym szukać — pole nad pustą
          listą jest obietnicą bez pokrycia. */}
      {wszystkich > 0 && (
        <div className="relative shrink-0 px-4 pb-2">
          <span className="pointer-events-none absolute top-1/2 left-7 -translate-y-1/2 text-tekst-trzeci">
            <Ikona nazwa="szukaj" rozmiar={15} />
          </span>
          <Input
            type="search"
            value={szukane}
            onChange={(e) => onSzukane(e.target.value)}
            placeholder={t("Szukaj", "Search")}
            aria-label={t("Szukaj rozmowy", "Search conversations")}
            className="h-9 pl-9 text-meta pointer-coarse:h-10"
          />
        </div>
      )}

      {/* Prośby — nad rozmowami, zwijane, z licznikiem. Osobno, żeby nieproszona
          rozmowa nigdy nie mieszała się z prawdziwymi. */}
      {prosby.length > 0 && (
        <Prosby prosby={prosby} nazwaPozycji={nazwaPozycji} onPrzyjmij={onPrzyjmij} onOdrzuc={onOdrzuc} />
      )}

      {wszystkich === 0 ? (
        prosby.length > 0 ? null : (
          <div className="flex flex-1 flex-col items-center justify-center pb-10">
            <Pusto
              className="flex-none"
              ikona="rozmowy"
              tytul={t("Nie masz jeszcze żadnej rozmowy", "No conversations yet")}
              wskazowka={t("Wystarczy nazwa użytkownika drugiej osoby.", "All you need is the other person's username.")}
            />
            <Button variant="outline" onClick={onNowyCzat}>
              <Ikona nazwa="kontakty" rozmiar={16} />
              {t("Nowy czat", "New chat")}
            </Button>
          </div>
        )
      ) : rozmowy.length === 0 ? (
        <Pusto ikona="szukaj" tytul={t("Nic nie pasuje", "Nothing matches")} wskazowka={t("Szukamy po nazwie i po ostatniej wiadomości.", "We search by name and by the last message.")} />
      ) : (
        <ScrollArea className="flex-1">
          <ul className="flex flex-col gap-0.5 px-2 pt-1 pb-3">
            {rozmowy.map((pozycja) => {
              const klucz = kluczRozmowy(pozycja.groupId);

              return (
                <WierszRozmowy
                  key={klucz}
                  pozycja={pozycja}
                  nazwa={nazwaPozycji(pozycja)}
                  otwarta={klucz === kluczOtwartej}
                  onOtworz={() => onOtworz(pozycja)}
                  // Każda droga usuwania prowadzi przez potwierdzenie, nie kasuje wprost.
                  onUsun={() => setDoUsuniecia(pozycja)}
                />
              );
            })}
          </ul>
        </ScrollArea>
      )}

      {/*
        Potwierdzenie usunięcia rozmowy.

        Kasowanie jest nieodwracalne — historia żyje wyłącznie na tym urządzeniu —
        więc żadna droga (gest, przycisk, menu) nie usuwa wprost; wszystkie kończą
        tutaj. `Escape` znaczy „anuluj", bo bezpieczniejsza odpowiedź ma być
        tą łatwą, a fokus startuje na „Anuluj" z tego samego powodu.
      */}
      <AlertDialog open={doUsuniecia !== null} onOpenChange={(o) => !o && setDoUsuniecia(null)}>
        <AlertDialogContent>
          <AlertDialogHeader>
            <AlertDialogTitle>
              {t("Usunąć rozmowę z", "Delete the conversation with")} {doUsuniecia ? nazwaPozycji(doUsuniecia) : ""}?
            </AlertDialogTitle>
            <AlertDialogDescription>
              {t("Historia tej rozmowy jest tylko na tym urządzeniu — serwer jej nie ma, więc po usunięciu nikt jej nie odtworzy.", "This conversation's history exists only on this device — the server doesn't have it, so once deleted no one can restore it.")}
            </AlertDialogDescription>
          </AlertDialogHeader>
          <AlertDialogFooter>
            <AlertDialogCancel>{t("Anuluj", "Cancel")}</AlertDialogCancel>
            <AlertDialogAction
              onClick={() => {
                const cel = doUsuniecia;
                setDoUsuniecia(null);
                if (cel) onUsun(cel);
              }}
            >
              <Ikona nazwa="kosz" rozmiar={16} />
              {t("Usuń", "Delete")}
            </AlertDialogAction>
          </AlertDialogFooter>
        </AlertDialogContent>
      </AlertDialog>
    </aside>
  );
}

/**
 * Wiersz listy rozmów z gestem „przeciągnij w lewo, żeby usunąć".
 *
 * # Dlaczego gest, a nie widoczny przycisk
 *
 * Kasowanie jest nieodwracalne (historia jest tylko tutaj), więc nie ma być
 * pod ręką na jedno dotknięcie obok „otwórz". Gest wymaga świadomego ruchu,
 * a przycisk „Usuń" spod spodu daje jeszcze chwilę na wycofanie się — puszczenie
 * palca przed progiem cofa wiersz na miejsce.
 *
 * Na myszy gestu nie ma, więc tę samą drogę daje menu: kebab na najechanie
 * i prawy przycisk (Radix `ContextMenu`) na całym wierszu.
 *
 * Gest liczy się jako poziomy dopiero, gdy przesunięcie w bok wyraźnie wygrywa
 * z pionowym; inaczej każde przewinięcie listy kciukiem odsłaniałoby kosze.
 */
function WierszRozmowy({
  pozycja,
  nazwa,
  otwarta,
  onOtworz,
  onUsun,
}: {
  pozycja: PozycjaListy;
  nazwa: string;
  otwarta: boolean;
  onOtworz: () => void;
  onUsun: () => void;
}) {
  // Ile odsłonić pod wierszem i od którego progu puszczenie palca kasuje.
  const SZEROKOSC_AKCJI = 88;
  const PROG_USUNIECIA = 64;

  const [przesuniecie, setPrzesuniecie] = useState(0);
  const [odsloniete, setOdsloniete] = useState(false);
  const start = useRef<{ x: number; y: number } | null>(null);
  const kierunek = useRef<"nieznany" | "poziomy" | "pionowy">("nieznany");

  const zakonczGest = () => {
    // Za progiem kasujemy; bliżej — chowamy albo zostawiamy odsłonięty przycisk.
    if (przesuniecie <= -PROG_USUNIECIA) {
      onUsun();
      setPrzesuniecie(0);
      setOdsloniete(false);
    } else if (przesuniecie <= -SZEROKOSC_AKCJI / 2) {
      setPrzesuniecie(-SZEROKOSC_AKCJI);
      setOdsloniete(true);
    } else {
      setPrzesuniecie(0);
      setOdsloniete(false);
    }
    start.current = null;
    kierunek.current = "nieznany";
  };

  /*
   * Kosz jest niewidoczny w spoczynku.
   *
   * Wiersz ma zaokrąglone rogi, więc jego nieprzezroczyste tło nie dochodzi do
   * samych narożników — a pod spodem leżał `alarm-tlo`. Alarmowa czerwień
   * prześwitywała w czterech rogach każdego wiersza. Kosz odsłaniamy dopiero,
   * gdy wiersz faktycznie się przesuwa.
   */
  const odslania = przesuniecie !== 0 || odsloniete;
  const ostatnia = pozycja.ostatnia;

  return (
    <li className="group/wiersz relative overflow-hidden rounded-md">
      <button
        type="button"
        className={cn(
          "absolute inset-y-0 right-0 flex w-[88px] cursor-pointer flex-col items-center justify-center gap-0.5 bg-alarm-tlo text-podpis font-medium text-alarm transition-opacity duration-150",
          odslania ? "opacity-100" : "pointer-events-none opacity-0",
        )}
        aria-label={t(`Usuń rozmowę z ${nazwa}`, `Delete conversation with ${nazwa}`)}
        onClick={onUsun}
        tabIndex={odsloniete ? 0 : -1}
      >
        <Ikona nazwa="kosz" rozmiar={20} />
        <span>{t("Usuń", "Delete")}</span>
      </button>

      <ContextMenu>
        <ContextMenuTrigger asChild>
          <button
            type="button"
            aria-current={otwarta ? "true" : undefined}
            className={cn(
              "relative z-[1] flex w-full cursor-pointer touch-pan-y items-center gap-3 rounded-md px-2.5 py-2.5 text-left",
              "transition-[background-color] duration-150",
              otwarta ? "bg-wglebienie-mocne" : "bg-tlo hover:bg-wglebienie",
            )}
            style={{
              transform: `translateX(${przesuniecie}px)`,
              transition: start.current ? "none" : "transform .25s var(--krzywa), background-color .15s",
            }}
            onClick={() => {
              // Odsłonięty kosz przechwytuje dotknięcie na schowanie, a nie na
              // wejście do rozmowy — inaczej „cofnięcie" gestu otwierałoby wątek.
              if (odsloniete) {
                setPrzesuniecie(0);
                setOdsloniete(false);
                return;
              }
              onOtworz();
            }}
            onTouchStart={(e) => {
              const t = e.touches[0];
              if (!t) return;
              start.current = { x: t.clientX, y: t.clientY };
              kierunek.current = "nieznany";
            }}
            onTouchMove={(e) => {
              const t = e.touches[0];
              if (!start.current || !t) return;
              const dx = t.clientX - start.current.x;
              const dy = t.clientY - start.current.y;

              if (kierunek.current === "nieznany") {
                if (Math.abs(dx) < 8 && Math.abs(dy) < 8) return;
                // Pionowy gest zostaje przewijaniem listy — wiersza nie ruszamy.
                kierunek.current = Math.abs(dx) > Math.abs(dy) ? "poziomy" : "pionowy";
              }
              if (kierunek.current !== "poziomy") return;

              const bazowe = odsloniete ? -SZEROKOSC_AKCJI : 0;
              // Tylko w lewo, z lekkim oporem za odsłoniętą szerokością.
              setPrzesuniecie(Math.max(-SZEROKOSC_AKCJI - 24, Math.min(0, bazowe + dx)));
            }}
            onTouchEnd={zakonczGest}
            onTouchCancel={zakonczGest}
          >
            <Awatar nazwa={nazwa} rozmiar="md" />

            <span className="flex min-w-0 flex-1 flex-col gap-0.5">
              <span className="flex items-baseline gap-2">
                <span className="min-w-0 flex-1 truncate text-tresc font-medium">{nazwa}</span>
                {ostatnia && (
                  <span
                    className={cn(
                      "shrink-0 text-podpis tabular-nums",
                      pozycja.nieprzeczytane > 0 ? "font-medium text-tekst" : "text-tekst-drugi",
                    )}
                  >
                    {godzina(ostatnia.czas)}
                  </span>
                )}
              </span>

              {/*
                Dwa wiersze podglądu, nie jeden.

                Jeden ucinał zdanie po dwóch słowach, bo nazwa i godzina
                zabierają wiersz wyżej. Wiersz listy przestawał mówić cokolwiek
                o rozmowie i trzeba było ją otworzyć, żeby się dowiedzieć, czy
                warto ją otwierać.
              */}
              <span className="flex items-start gap-2">
                <span
                  className={cn(
                    "flex min-w-0 flex-1 items-start gap-1.5 text-meta",
                    pozycja.nieprzeczytane > 0 ? "text-tekst" : "text-tekst-drugi",
                  )}
                >
                  {ostatnia?.zalacznik && (
                    <span className="mt-0.5">
                      <Ikona nazwa="spinacz" rozmiar={13} />
                    </span>
                  )}
                  <span className="line-clamp-2 min-w-0 break-words">
                    {ostatnia ? (ostatnia.wlasna ? t("Ty: ", "You: ") : "") + zapowiedz(ostatnia) : t("brak wiadomości", "no messages")}
                  </span>
                </span>
                {pozycja.nieprzeczytane > 0 && (
                  <Znacznik liczba={pozycja.nieprzeczytane} className="mt-px" />
                )}
              </span>
            </span>
          </button>
        </ContextMenuTrigger>
        <ContextMenuContent>
          <ContextMenuItem onSelect={onOtworz}>
            <Ikona nazwa="rozmowy" rozmiar={16} />
            {t("Otwórz", "Open")}
          </ContextMenuItem>
          <ContextMenuItem variant="destructive" onSelect={onUsun}>
            <Ikona nazwa="kosz" rozmiar={16} />
            {t("Usuń rozmowę", "Delete conversation")}
          </ContextMenuItem>
        </ContextMenuContent>
      </ContextMenu>

      {/*
        Kebab — droga do usunięcia na desktopie, gdzie gestu nie ma.

        Tylko przy realnym wskaźniku (`pointer-fine`) i dopiero na najechanie
        wiersza, fokus albo otwarte menu — lista w spoczynku ma być czysta.
        Rodzeństwo wiersza, nie dziecko: przycisk w przycisku jest niepoprawny.
      */}
      <DropdownMenu>
        <DropdownMenuTrigger asChild>
          <Button
            variant="ghost"
            size="icon-sm"
            aria-label={t(`Więcej — rozmowa z ${nazwa}`, `More — conversation with ${nazwa}`)}
            className={cn(
              "absolute top-1/2 right-2 z-[2] hidden -translate-y-1/2 bg-karta pointer-fine:inline-flex",
              "opacity-0 group-hover/wiersz:opacity-100 focus-visible:opacity-100 data-[state=open]:opacity-100",
            )}
          >
            <Ikona nazwa="wiecej" rozmiar={18} />
          </Button>
        </DropdownMenuTrigger>
        <DropdownMenuContent align="end">
          <DropdownMenuItem variant="destructive" onSelect={onUsun}>
            <Ikona nazwa="kosz" rozmiar={16} />
            {t("Usuń rozmowę", "Delete conversation")}
          </DropdownMenuItem>
        </DropdownMenuContent>
      </DropdownMenu>
    </li>
  );
}

/**
 * Sekcja próśb o rozmowę — zwijana, z licznikiem, nad listą rozmów.
 *
 * # Po co osobno
 *
 * Nieproszona rozmowa nie ma prawa wpaść między prawdziwe ani udawać „nowej
 * wiadomości" — to jest cała zapora. Każda prośba niesie podgląd i dwie decyzje:
 * „Przyjmij" (staje się zwykłą rozmową, nadawca staje się kontaktem) albo
 * „Odrzuć" (wychodzimy z grupy i znika lokalnie).
 *
 * Domyślnie zwinięta: prośby są sygnałem, że ktoś czeka, a nie treścią, którą
 * czyta się co chwilę.
 */
function Prosby({
  prosby,
  nazwaPozycji,
  onPrzyjmij,
  onOdrzuc,
}: {
  prosby: PozycjaListy[];
  nazwaPozycji: (p: PozycjaListy) => string;
  onPrzyjmij: (p: PozycjaListy) => void;
  onOdrzuc: (p: PozycjaListy) => void;
}) {
  const [rozwiniete, setRozwiniete] = useState(false);

  return (
    <section className="mx-2 mb-2 shrink-0 rounded-md border border-linia" aria-label={t("Prośby o rozmowę", "Message requests")}>
      <button
        type="button"
        className="flex h-10 w-full cursor-pointer items-center gap-2.5 rounded-md px-2.5 text-meta font-medium text-tekst-drugi transition-colors hover:text-tekst"
        aria-expanded={rozwiniete}
        onClick={() => setRozwiniete((r) => !r)}
      >
        <Ikona nazwa="rozwin" rozmiar={14} klasa={rozwiniete ? "obrocona" : undefined} />
        <span className="flex-1 text-left">{t("Prośby o rozmowę", "Message requests")}</span>
        <Znacznik liczba={prosby.length} />
      </button>

      {rozwiniete && (
        <ul className="flex flex-col gap-0.5 px-1 pb-1">
          {prosby.map((pozycja) => {
            const nazwa = nazwaPozycji(pozycja);
            return (
              <li key={kluczRozmowy(pozycja.groupId)} className="flex items-center gap-2.5 rounded-sm p-1.5">
                <Awatar nazwa={nazwa} rozmiar="sm" />
                <span className="flex min-w-0 flex-1 flex-col">
                  <span className="truncate text-meta font-medium">{nazwa}</span>
                  <span className="truncate text-podpis text-tekst-drugi">
                    {pozycja.ostatnia ? zapowiedz(pozycja.ostatnia) : t("chce zacząć rozmowę", "wants to start a conversation")}
                  </span>
                </span>
                <Podpowiedz tresc={t("Przyjmij", "Accept")}>
                  <Button
                    variant="outline"
                    size="icon-sm"
                    aria-label={t(`Przyjmij prośbę od ${nazwa}`, `Accept request from ${nazwa}`)}
                    onClick={() => onPrzyjmij(pozycja)}
                  >
                    <Ikona nazwa="wyslane" rozmiar={16} />
                  </Button>
                </Podpowiedz>
                <Podpowiedz tresc={t("Odrzuć", "Decline")}>
                  <Button
                    variant="ghost"
                    size="icon-sm"
                    aria-label={t(`Odrzuć prośbę od ${nazwa}`, `Decline request from ${nazwa}`)}
                    onClick={() => onOdrzuc(pozycja)}
                  >
                    <Ikona nazwa="zamknij" rozmiar={16} />
                  </Button>
                </Podpowiedz>
              </li>
            );
          })}
        </ul>
      )}
    </section>
  );
}

/**
 * „Nowy czat": nazwa użytkownika → rozmowa jeden na jeden.
 *
 * Arkusz, a nie pole wsuwane w nagłówek listy: na telefonie pole pod
 * klawiaturą przy samej górze ekranu było poza zasięgiem kciuka, a jedyną
 * akcją w okienku jest „Zacznij" — więc ono jest tu plamą.
 */
export function NowyCzat({
  otwarty,
  onZmiana,
  onZacznij,
}: {
  otwarty: boolean;
  onZmiana: (otwarty: boolean) => void;
  onZacznij: (nazwa: string) => void;
}) {
  const [nazwa, setNazwa] = useState("");

  const zacznij = () => {
    const kandydat = nazwa.trim();
    if (!kandydat) return;
    onZacznij(kandydat);
    setNazwa("");
    onZmiana(false);
  };

  return (
    <Arkusz
      otwarty={otwarty}
      onZmiana={(o) => {
        if (!o) setNazwa("");
        onZmiana(o);
      }}
      tytul={t("Nowy czat", "New chat")}
      opis={t("Katalog nie ma listy do przeglądania — rozmowę zaczyna się od nazwy użytkownika drugiej osoby.", "The directory has no list to browse — a conversation starts from the other person's username.")}
      stopka={
        <>
          <Button variant="outline" onClick={() => onZmiana(false)}>
            {t("Anuluj", "Cancel")}
          </Button>
          <Button type="submit" form="nowy-czat" disabled={!nazwa.trim()}>
            {t("Zacznij rozmowę", "Start conversation")}
          </Button>
        </>
      }
    >
      <form
        id="nowy-czat"
        onSubmit={(e) => {
          e.preventDefault();
          zacznij();
        }}
      >
        <label>
          {t("Nazwa użytkownika", "Username")}
          <Input
            autoFocus
            value={nazwa}
            onChange={(e) => setNazwa(e.target.value)}
            placeholder={t("np. ala", "e.g. alice")}
            autoCapitalize="none"
            autoCorrect="off"
            spellCheck={false}
          />
        </label>
      </form>
    </Arkusz>
  );
}

/**
 * Zakładanie grupy: wybór osób z kontaktów plus dodanie po nazwie.
 *
 * Kontakty to osoby, z którymi już rozmawiamy — katalog nie ma listy do
 * przeglądania (decyzja, nie brak). Kogoś spoza tej listy dodaje się po nazwie
 * użytkownika, tak samo jak w „Nowym czacie". Nazwa grupy jest opcjonalna:
 * bez niej wątek pokazuje sklejone nazwy uczestników.
 */
export function NowaGrupa({
  otwarty,
  onZmiana,
  kontakty,
  nick,
  onUtworz,
}: {
  otwarty: boolean;
  onZmiana: (otwarty: boolean) => void;
  kontakty: string[];
  nick: (username: string) => string;
  onUtworz: (osoby: string[], nazwa: string) => void;
}) {
  const [wybrani, setWybrani] = useState<Set<string>>(new Set());
  const [poNazwie, setPoNazwie] = useState("");
  const [nazwaGrupy, setNazwaGrupy] = useState("");
  // Osoby dodane po nazwie, spoza listy kontaktów.
  const [dodatkowi, setDodatkowi] = useState<string[]>([]);

  const wyczysc = () => {
    setWybrani(new Set());
    setPoNazwie("");
    setNazwaGrupy("");
    setDodatkowi([]);
  };

  const przelacz = (osoba: string) =>
    setWybrani((zbior) => {
      const kolejny = new Set(zbior);
      if (kolejny.has(osoba)) kolejny.delete(osoba);
      else kolejny.add(osoba);
      return kolejny;
    });

  const dodajPoNazwie = () => {
    const nazwa = poNazwie.trim();
    if (!nazwa) return;
    setPoNazwie("");
    // Kontakt z listy → po prostu go zaznacz; ktoś spoza → dołóż jako dodatkowy.
    if (kontakty.includes(nazwa)) {
      setWybrani((zbior) => new Set(zbior).add(nazwa));
    } else {
      setDodatkowi((lista) => (lista.includes(nazwa) ? lista : [...lista, nazwa]));
    }
  };

  const wszyscy = [...new Set([...wybrani, ...dodatkowi])];

  return (
    <Arkusz
      otwarty={otwarty}
      onZmiana={(o) => {
        if (!o) wyczysc();
        onZmiana(o);
      }}
      tytul={t("Nowa grupa", "New group")}
      stopka={
        <>
          <Button variant="outline" onClick={() => onZmiana(false)}>
            {t("Anuluj", "Cancel")}
          </Button>
          <Button
            disabled={wszyscy.length === 0}
            onClick={() => {
              onUtworz(wszyscy, nazwaGrupy);
              wyczysc();
              onZmiana(false);
            }}
          >
            <Ikona nazwa="osoby" rozmiar={16} />
            {t("Utwórz grupę", "Create group")}
          </Button>
        </>
      }
    >
      <label>
        {t("Nazwa grupy (opcjonalnie)", "Group name (optional)")}
        <Input value={nazwaGrupy} onChange={(e) => setNazwaGrupy(e.target.value)} placeholder={t("Nazwa grupy", "Group name")} />
      </label>

      {kontakty.length > 0 && (
        <fieldset className="flex flex-col gap-1.5">
          <legend className="mb-1.5 text-meta font-medium text-tekst-drugi">{t("Z kim rozmawiasz", "Who's in it")}</legend>
          <ul className="flex max-h-56 flex-col gap-0.5 overflow-y-auto rounded-md border border-linia p-1">
            {kontakty.map((osoba) => {
              const zaznaczona = wybrani.has(osoba);
              return (
                <li key={osoba}>
                  <button
                    type="button"
                    role="checkbox"
                    aria-checked={zaznaczona}
                    onClick={() => przelacz(osoba)}
                    className={cn(
                      "flex w-full cursor-pointer items-center gap-3 rounded-sm px-2 py-1.5 text-left text-tresc transition-colors",
                      zaznaczona ? "bg-wglebienie" : "hover:bg-wglebienie",
                    )}
                  >
                    <Awatar nazwa={nick(osoba)} rozmiar="sm" />
                    <span className="min-w-0 flex-1 truncate">{nick(osoba)}</span>
                    {/* Pole wyboru jako okrąg: pusty obrys albo ptaszek. */}
                    <span
                      className={cn(
                        "grid size-5 shrink-0 place-items-center rounded-full border",
                        zaznaczona ? "border-tekst bg-tekst text-tlo" : "border-linia-mocna",
                      )}
                    >
                      {zaznaczona && <Ikona nazwa="wyslane" rozmiar={13} />}
                    </span>
                  </button>
                </li>
              );
            })}
          </ul>
        </fieldset>
      )}

      <form
        onSubmit={(e) => {
          e.preventDefault();
          dodajPoNazwie();
        }}
      >
        <label>
          {t("Dodaj po nazwie", "Add by username")}
          <span className="flex gap-2">
            <Input
              value={poNazwie}
              onChange={(e) => setPoNazwie(e.target.value)}
              placeholder={t("Nazwa użytkownika", "Username")}
              autoCapitalize="none"
              autoCorrect="off"
              spellCheck={false}
            />
            <Button type="submit" variant="outline" size="icon" disabled={!poNazwie.trim()} aria-label={t("Dodaj", "Add")}>
              <Ikona nazwa="dodaj" rozmiar={16} />
            </Button>
          </span>
        </label>
      </form>

      {dodatkowi.length > 0 && (
        <ul className="flex flex-wrap gap-1.5" aria-label={t("Dodani po nazwie", "Added by username")}>
          {dodatkowi.map((osoba) => (
            <li
              key={osoba}
              className="flex items-center gap-1 rounded-full border border-linia py-0.5 pr-0.5 pl-2.5 text-meta"
            >
              <span>{nick(osoba)}</span>
              <button
                type="button"
                className="grid size-6 cursor-pointer place-items-center rounded-full text-tekst-drugi hover:bg-wglebienie hover:text-tekst"
                aria-label={t(`Usuń ${osoba} z grupy`, `Remove ${osoba} from the group`)}
                onClick={() => setDodatkowi((lista) => lista.filter((o) => o !== osoba))}
              >
                <Ikona nazwa="zamknij" rozmiar={12} />
              </button>
            </li>
          ))}
        </ul>
      )}
    </Arkusz>
  );
}
