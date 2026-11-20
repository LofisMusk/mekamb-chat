import { type ReactNode, useEffect, useMemo, useState } from "react";

import { Ikona, type NazwaIkony } from "./Ikony";
import {
  AlertDialog,
  AlertDialogAction,
  AlertDialogCancel,
  AlertDialogContent,
  AlertDialogDescription,
  AlertDialogFooter,
  AlertDialogHeader,
  AlertDialogTitle,
  AlertDialogTrigger,
} from "./components/ui/alert-dialog";
import { Awatar } from "./components/ui/avatar";
import { Button } from "./components/ui/button";
import { cn } from "./components/ui/cn";
import { Input, klasyPola } from "./components/ui/input";
import { t } from "./lib/jezyk";
import type { Messenger } from "./lib/messenger";
import {
  JEDNOSTKI_ZNIKANIA,
  PRESETY_ZNIKANIA,
  opisZnikania,
} from "./lib/znikanie";

/**
 * Skład rozmowy, kod bezpieczeństwa i to, co się z rozmową robi.
 *
 * Skład bierzemy z drzewa MLS, nie z własnej listy w interfejsie — to jedyne
 * miejsce, które wie, kto naprawdę jest w grupie po wszystkich commitach.
 * Własna lista rozjechałaby się przy pierwszej zmianie zrobionej przez kogoś
 * innego.
 *
 * Panel jest też miejscem na decyzje o rozmowie, które nie mieszczą się w pasku
 * wątku: dodanie kogoś, opuszczenie grupy, zablokowanie osoby i znikanie
 * wiadomości. Wszystkie dotyczą TEJ rozmowy i jej składu, więc mieszkają obok
 * kodu bezpieczeństwa, a nie w ustawieniach konta.
 */
export function Uczestnicy({
  messenger,
  groupId,
  nazwaGrupy,
  onZmienNazweGrupy,
  nick,
  zablokowani,
  onZablokuj,
  onOdblokuj,
  onDodajOsobe,
  onOpuscGrupe,
  znikanieSekundy,
  onZnikanie,
}: {
  messenger: Messenger;
  groupId: Uint8Array;
  /** Współdzielona nazwa grupy — pusta, gdy nikt jej nie nadał. */
  nazwaGrupy: string;
  /** Zmienia (albo czyści pustym napisem) nazwę grupy — rozsyła metadaną. */
  onZmienNazweGrupy: (nazwa: string) => void;
  /** Nick rozmówcy do wyświetlenia — pod spodem zostaje nazwa użytkownika. */
  nick: (username: string) => string;
  /** Zablokowane nazwy użytkowników — do pokazania stanu przy osobie. */
  zablokowani: Set<string>;
  onZablokuj: (username: string) => void;
  onOdblokuj: (username: string) => void;
  /** Dodaje osobę (po nazwie użytkownika) do TEJ rozmowy — rozbudowuje grupę. */
  onDodajOsobe: (username: string) => Promise<void>;
  /** Opuszcza tę grupę — wychodzimy z MLS, nie tylko chowamy ją lokalnie. */
  onOpuscGrupe: () => void;
  /** Czas życia wiadomości w tej rozmowie w sekundach; `null` = znikanie wyłączone. */
  znikanieSekundy: number | null;
  onZnikanie: (sekundy: number | null) => void;
}) {
  // Skład czytamy przy każdym otwarciu inspektora; dodawanie osób wróciło tu
  // z „Nowej grupy", bo grupę rozbudowuje się właśnie stąd, patrząc na skład.
  const [odswiezenie, setOdswiezenie] = useState(0);

  /*
   * Skład czytamy OSTROŻNIE.
   *
   * `members()` rzuca dla grupy, której nie ma w stanie MLS — a taka grupa
   * potrafi zostać na liście rozmów, bo historia i stan MLS to dwa osobne
   * zapisy. Wyjątek leciał stąd przez render i zabierał całą aplikację:
   * po ponownym uruchomieniu kliknięcie takiej rozmowy dawało czarny ekran.
   */
  const osoby = useMemo(
    () => {
      try {
        return messenger.memberUserIds(groupId);
      } catch {
        return [];
      }
    },
    // eslint-disable-next-line react-hooks/exhaustive-deps
    [messenger, groupId, odswiezenie],
  );

  const grupa = osoby.length > 2;
  const ja = messenger.account.userId;

  return (
    <div className="flex flex-col gap-6 p-4">
      {/*
        Nazwa grupy — edytowalna i WSPÓLDZIELONA (metadana MLS), nie lokalna
        etykieta. Tylko dla grup: DM nazywa się rozmówcą, nie da się go
        „przemianować". Pusty zapis kasuje nazwę i wraca do sklejanych nazw
        uczestników.
      */}
      {grupa && (
        <Sekcja ikona="info" tytul={t("Nazwa grupy", "Group name")}>
          <NazwaGrupy nazwa={nazwaGrupy} onZapisz={onZmienNazweGrupy} />
        </Sekcja>
      )}

      <Sekcja
        ikona="osoby"
        tytul={
          osoby.length === 2
            ? t("Rozmowa prywatna", "Private conversation")
            : t(`Grupa · ${osoby.length} osób`, `Group · ${osoby.length} people`)
        }
      >
        <ul className="flex flex-col">
          {osoby.map((osoba) => {
            const jaTo = osoba === ja;
            const zablokowana = zablokowani.has(osoba);
            return (
              <li key={osoba} className="flex min-h-11 items-center gap-3">
                <Awatar nazwa={nick(osoba)} rozmiar="sm" />
                <span className="min-w-0 flex-1">
                  <span className="block truncate text-tresc">{nick(osoba)}</span>
                  {nick(osoba) !== osoba && (
                    <span className="block truncate text-podpis text-tekst-drugi">@{osoba}</span>
                  )}
                </span>
                {jaTo ? (
                  <span className="text-podpis text-tekst-drugi">{t("Ty", "You")}</span>
                ) : (
                  <>
                    {zablokowana && (
                      <span className="flex items-center gap-1 text-podpis text-alarm">
                        <Ikona nazwa="blokuj" rozmiar={12} />
                        {t("zablokowany", "blocked")}
                      </span>
                    )}
                    {/*
                      Blokada per osoba przy niej samej, nie w osobnym menu:
                      to o tej osobie się decyduje. Blokujemy po NAZWIE
                      użytkownika (nie nicku) — to ona jest tożsamością.
                    */}
                    <Button
                      variant="ghost"
                      size="icon-sm"
                      aria-label={
                        zablokowana
                          ? t(`Odblokuj ${nick(osoba)}`, `Unblock ${nick(osoba)}`)
                          : t(`Zablokuj ${nick(osoba)}`, `Block ${nick(osoba)}`)
                      }
                      title={zablokowana ? t("Odblokuj", "Unblock") : t("Zablokuj", "Block")}
                      onClick={() => (zablokowana ? onOdblokuj(osoba) : onZablokuj(osoba))}
                    >
                      <Ikona nazwa="blokuj" rozmiar={15} />
                    </Button>
                  </>
                )}
              </li>
            );
          })}
        </ul>

        {/*
          Dodanie osoby do ISTNIEJĄCEJ rozmowy — rozbudowa grupy albo zamiana DM-a
          w grupę. `addMember` dokłada wszystkie urządzenia osoby jednym commitem
          (inwariant rdzenia), a kod bezpieczeństwa się przy tym zmienia — dlatego
          po dodaniu odświeżamy skład.
        */}
        <DodajOsobe
          onDodaj={async (username) => {
            await onDodajOsobe(username);
            setOdswiezenie((n) => n + 1);
          }}
        />
      </Sekcja>

      {/* Znikanie wiadomości — retencja lokalna tej rozmowy, domyślnie wyłączona. */}
      <Znikanie sekundy={znikanieSekundy} onZmien={onZnikanie} />

      <KodBezpieczenstwa messenger={messenger} groupId={groupId} odswiezenie={odswiezenie} />

      {/*
        Opuszczenie grupy — NAPRAWDĘ wychodzimy z MLS, a nie chowamy rozmowę.
        Tylko dla grup: z DM-a „wychodzi się" przez usunięcie albo blokadę, a
        wypisanie się z rozmowy dwóch osób jest tym samym co jej skasowanie.
        Nieodwracalne (żeby wrócić, ktoś musi zaprosić ponownie), więc za linią
        i z pytaniem.
      */}
      {grupa && <OpuscGrupe onOpusc={onOpuscGrupe} />}
    </div>
  );
}

/** Sekcja panelu: mały nagłówek z ikoną i treść pod nim. */
function Sekcja({ ikona, tytul, children }: { ikona: NazwaIkony; tytul: string; children: ReactNode }) {
  return (
    <section className="flex flex-col gap-2">
      <h3 className="flex items-center gap-1.5 text-podpis font-medium text-tekst-drugi">
        <Ikona nazwa={ikona} rozmiar={13} />
        {tytul}
      </h3>
      {children}
    </section>
  );
}

const WSKAZOWKA = "text-podpis leading-relaxed text-tekst-drugi";

/**
 * Dodawanie osoby do istniejącej rozmowy.
 *
 * Jedno pole na nazwę użytkownika — katalog nie ma listy do przeglądania
 * (decyzja, nie brak), więc kogoś dodaje się po nazwie, tak samo jak w „Nowym
 * czacie". Zwinięte domyślnie: rozbudowa składu jest rzadka, a rozłożony
 * formularz sugerowałby, że to podstawowa czynność w tym panelu.
 */
function DodajOsobe({ onDodaj }: { onDodaj: (username: string) => Promise<void> }) {
  const [otwarte, setOtwarte] = useState(false);
  const [nazwa, setNazwa] = useState("");
  const [pracuje, setPracuje] = useState(false);

  const dodaj = async () => {
    const kandydat = nazwa.trim();
    if (!kandydat || pracuje) return;
    setPracuje(true);
    try {
      await onDodaj(kandydat);
      setNazwa("");
      setOtwarte(false);
    } catch {
      // Powód pokazał już wywołujący (`onBlad`). Zostawiamy pole otwarte
      // z wpisaną nazwą, żeby dało się poprawić i spróbować ponownie.
    } finally {
      setPracuje(false);
    }
  };

  if (!otwarte) {
    return (
      <Button variant="ghost" size="sm" className="self-start" onClick={() => setOtwarte(true)}>
        <Ikona nazwa="dodaj" rozmiar={14} />
        {t("Dodaj osobę", "Add person")}
      </Button>
    );
  }

  return (
    <div className="flex flex-col gap-2">
      <form
        className="flex items-center gap-2"
        onSubmit={(e) => {
          e.preventDefault();
          void dodaj();
        }}
      >
        <Input
          autoFocus
          value={nazwa}
          onChange={(e) => setNazwa(e.target.value)}
          placeholder={t("Nazwa użytkownika", "Username")}
          aria-label={t("Nazwa użytkownika do dodania", "Username to add")}
          disabled={pracuje}
        />
        <Button size="icon" disabled={!nazwa.trim() || pracuje} aria-label={t("Dodaj", "Add")}>
          <Ikona nazwa={pracuje ? "zegar" : "wyslij"} rozmiar={16} />
        </Button>
        <Button
          type="button"
          variant="ghost"
          size="icon"
          aria-label={t("Anuluj", "Cancel")}
          disabled={pracuje}
          onClick={() => {
            setNazwa("");
            setOtwarte(false);
          }}
        >
          <Ikona nazwa="zamknij" rozmiar={16} />
        </Button>
      </form>
      <p className={WSKAZOWKA}>
        {t(
          "Dołączą wszystkie urządzenia tej osoby. Kod bezpieczeństwa się zmieni — to oczekiwane przy każdej zmianie składu.",
          "All of this person's devices will join. The safety number will change — that's expected whenever members change.",
        )}
      </p>
    </div>
  );
}

/**
 * Znikanie wiadomości w tej rozmowie.
 *
 * # Co to znaczy i czego nie znaczy
 *
 * To retencja LOKALNA: po wybranym czasie wiadomości znikają z tego urządzenia.
 * Nie kasuje ich rozmówcy — historia żyje u każdego osobno i nie ma jej gdzie
 * indziej skasować. Mówimy to wprost, bo „znikające wiadomości" łatwo pomylić
 * z obietnicą, której ta wersja nie składa.
 *
 * Domyślnie wyłączone. Wybór to preset albo własny czas; „Wyłącz" kasuje ustawienie.
 */
function Znikanie({
  sekundy,
  onZmien,
}: {
  sekundy: number | null;
  onZmien: (sekundy: number | null) => void;
}) {
  const [wlasny, setWlasny] = useState(false);
  const [ile, setIle] = useState("1");
  const [jednostka, setJednostka] = useState(JEDNOSTKI_ZNIKANIA[1]?.mnoznik ?? 3600);

  const zastosujWlasny = () => {
    const liczba = Number(ile);
    if (!Number.isFinite(liczba) || liczba <= 0) return;
    onZmien(Math.floor(liczba * jednostka));
    setWlasny(false);
  };

  const chip = (aktywny: boolean) =>
    cn(
      "h-8 rounded-full border px-3 text-meta transition-colors",
      aktywny
        ? "border-glowny bg-glowny text-glowny-tekst"
        : "border-linia-mocna text-tekst hover:bg-wglebienie",
    );

  return (
    <Sekcja ikona="zegar" tytul={t("Znikające wiadomości", "Disappearing messages")}>
      <p className={WSKAZOWKA}>
        {sekundy
          ? t(
              `Wiadomości znikają z tego urządzenia po: ${opisZnikania(sekundy)}. U rozmówcy zostają.`,
              `Messages disappear from this device after ${opisZnikania(sekundy)}. They stay on the other person's device.`,
            )
          : t(
              "Wyłączone — wiadomości zostają, dopóki ich nie usuniesz.",
              "Off — messages stay until you delete them.",
            )}
      </p>

      <div className="flex flex-wrap gap-1.5">
        {PRESETY_ZNIKANIA.map((p) => (
          <button
            key={p.sekundy}
            type="button"
            className={chip(sekundy === p.sekundy)}
            aria-pressed={sekundy === p.sekundy}
            onClick={() => onZmien(p.sekundy)}
          >
            {p.etykieta}
          </button>
        ))}
        <button type="button" className={chip(wlasny)} aria-pressed={wlasny} onClick={() => setWlasny((w) => !w)}>
          {t("Własny…", "Custom…")}
        </button>
        {sekundy !== null && (
          <button
            type="button"
            className="h-8 rounded-full border border-alarm/45 px-3 text-meta text-alarm hover:bg-alarm-tlo"
            onClick={() => onZmien(null)}
          >
            {t("Wyłącz", "Turn off")}
          </button>
        )}
      </div>

      {wlasny && (
        <form
          className="flex items-center gap-2"
          onSubmit={(e) => {
            e.preventDefault();
            zastosujWlasny();
          }}
        >
          <Input
            type="number"
            min={1}
            value={ile}
            onChange={(e) => setIle(e.target.value)}
            aria-label={t("Ile", "Amount")}
            className="w-20"
          />
          <select
            value={jednostka}
            onChange={(e) => setJednostka(Number(e.target.value))}
            aria-label={t("Jednostka czasu", "Time unit")}
            className={cn(klasyPola, "w-auto")}
          >
            {JEDNOSTKI_ZNIKANIA.map((j) => (
              <option key={j.mnoznik} value={j.mnoznik}>
                {j.etykieta}
              </option>
            ))}
          </select>
          <Button type="submit">{t("Ustaw", "Set")}</Button>
        </form>
      )}
    </Sekcja>
  );
}

/**
 * Przycisk opuszczenia grupy z potwierdzeniem.
 *
 * Za linią i w kolorze alarmu jako obrys, bo to wyjście nieodwracalne: żeby
 * wrócić, ktoś z grupy musi zaprosić ponownie. Pytanie przed, nie po — po
 * fakcie nie ma już czego cofać.
 */
function OpuscGrupe({ onOpusc }: { onOpusc: () => void }) {
  return (
    <section className="border-t border-linia pt-4">
      <AlertDialog>
        <AlertDialogTrigger asChild>
          <Button variant="destructive" className="w-full">
            <Ikona nazwa="opusc" rozmiar={16} />
            {t("Opuść grupę", "Leave group")}
          </Button>
        </AlertDialogTrigger>
        <AlertDialogContent>
          <AlertDialogHeader>
            <AlertDialogTitle>{t("Opuścić tę grupę?", "Leave this group?")}</AlertDialogTitle>
            <AlertDialogDescription>
              {t(
                "Wyjdziesz z grupy u wszystkich — przestaniesz dostawać jej wiadomości. Żeby wrócić, ktoś będzie musiał zaprosić Cię ponownie.",
                "You'll leave the group for everyone and stop receiving its messages. To come back, someone will have to invite you again.",
              )}
            </AlertDialogDescription>
          </AlertDialogHeader>
          <AlertDialogFooter>
            <AlertDialogCancel>{t("Anuluj", "Cancel")}</AlertDialogCancel>
            <AlertDialogAction onClick={onOpusc}>{t("Opuść", "Leave")}</AlertDialogAction>
          </AlertDialogFooter>
        </AlertDialogContent>
      </AlertDialog>
    </section>
  );
}

/**
 * Kod bezpieczeństwa rozmowy.
 *
 * # Po co to jest widoczne
 *
 * Szyfrowanie chroni przed podsłuchem, ale nie przed serwerem, który podstawi
 * cudze urządzenie do rozmowy — wiadomości byłyby wtedy szyfrowane poprawnie,
 * tylko do niego. Ten kod liczy się wyłącznie z kluczy uczestników, więc
 * podmiana któregokolwiek go zmienia.
 *
 * Porównanie musi odbyć się **innym kanałem** niż ta aplikacja: na żywo,
 * telefonicznie, przez wideo. Porównanie przez sam komunikator nie ma sensu,
 * bo to dokładnie ten kanał, któremu nie ufamy.
 */
function KodBezpieczenstwa({
  messenger,
  groupId,
  odswiezenie,
}: {
  messenger: Messenger;
  groupId: Uint8Array;
  odswiezenie: number;
}) {
  const [pokazany, setPokazany] = useState(false);

  const kod = useMemo(
    () => {
      try {
        return messenger.safetyNumber(groupId);
      } catch {
        return null;
      }
    },
    // eslint-disable-next-line react-hooks/exhaustive-deps
    [messenger, groupId, odswiezenie],
  );

  if (!kod) return null;

  return (
    <Sekcja ikona="odcisk" tytul={t("Kod bezpieczeństwa", "Safety number")}>
      <Button variant="outline" size="sm" className="self-start" onClick={() => setPokazany((p) => !p)}>
        <Ikona nazwa="rozwin" rozmiar={14} klasa={pokazany ? "obrocona" : undefined} />
        {pokazany ? t("Ukryj kod", "Hide number") : t("Pokaż kod", "Show number")}
      </Button>

      {pokazany && (
        <>
          <code className="safety-kod">{kod}</code>
          <p className={WSKAZOWKA}>
            {t(
              "Porównaj ten kod z rozmówcą innym kanałem — na żywo albo telefonicznie. Jeśli się zgadza, nikt nie podstawił się w środek rozmowy. Porównanie przez tę aplikację nic nie daje: to właśnie ten kanał sprawdzamy.",
              "Compare this number with the other person over another channel — in person or by phone. If it matches, no one has slipped into the middle of the conversation. Comparing it through this app proves nothing: this app is exactly the channel being checked.",
            )}
          </p>
          <p className={WSKAZOWKA}>
            {t(
              "Kod zmienia się przy każdej zmianie składu rozmowy i przy dołączeniu nowego urządzenia — wtedy trzeba porównać go ponownie.",
              "The number changes whenever members change or a new device joins — compare it again then.",
            )}
          </p>
        </>
      )}
    </Sekcja>
  );
}

/**
 * Edytor nazwy grupy w panelu.
 *
 * Zapis dopiero na „Zapisz" albo Enter, nie po każdym znaku — zmiana rozsyła
 * metadaną do całej grupy, więc nie ma jej wysyłać przy każdym naciśnięciu.
 * Puste pole zapisane wprost kasuje nazwę (wraca sklejanie nazw uczestników).
 */
function NazwaGrupy({
  nazwa,
  onZapisz,
}: {
  nazwa: string;
  onZapisz: (nazwa: string) => void;
}) {
  const [pole, setPole] = useState(nazwa);
  useEffect(() => setPole(nazwa), [nazwa]);

  const zmienione = pole.trim() !== nazwa.trim();

  return (
    <form
      className="flex items-center gap-2"
      onSubmit={(e) => {
        e.preventDefault();
        if (zmienione) onZapisz(pole.trim());
      }}
    >
      <Input
        value={pole}
        onChange={(e) => setPole(e.target.value)}
        placeholder={t("Nazwa grupy", "Group name")}
        aria-label={t("Nazwa grupy", "Group name")}
      />
      <Button size="icon" disabled={!zmienione} aria-label={t("Zapisz nazwę", "Save name")} title={t("Zapisz", "Save")}>
        <Ikona nazwa="wyslane" rozmiar={16} />
      </Button>
    </form>
  );
}
