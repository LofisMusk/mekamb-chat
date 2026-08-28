import { useEffect, useMemo, useState } from "react";

import { Ikona } from "./Ikony";
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
    <>
      {/*
        Nazwa grupy — edytowalna i WSPÓLDZIELONA (metadana MLS), nie lokalna
        etykieta. Tylko dla grup: DM nazywa się rozmówcą, nie da się go
        „przemianować". Pusty zapis kasuje nazwę i wraca do sklejanych nazw
        uczestników.
      */}
      {grupa && (
        <section className="sekcja-inspektora">
          <h3 className="naglowek-sekcji">
            <Ikona nazwa="info" rozmiar={13} />
            Nazwa grupy
          </h3>
          <NazwaGrupy nazwa={nazwaGrupy} onZapisz={onZmienNazweGrupy} />
        </section>
      )}

      <section className="sekcja-inspektora">
        <h3 className="naglowek-sekcji">
          <Ikona nazwa="osoby" rozmiar={13} />
          {osoby.length === 2 ? "Rozmowa prywatna" : `Grupa · ${osoby.length} osób`}
        </h3>

        <ul className="lista-osob">
          {osoby.map((osoba) => {
            const jaTo = osoba === ja;
            const zablokowana = zablokowani.has(osoba);
            return (
              <li key={osoba}>
                <span className="awatar maly" aria-hidden="true">
                  {nick(osoba).slice(0, 1)}
                </span>
                <span className="kto">{nick(osoba)}</span>
                {jaTo ? (
                  <span className="tryb">Ty</span>
                ) : (
                  <>
                    {zablokowana && (
                      <span className="tryb uwaga">
                        <Ikona nazwa="blokuj" rozmiar={12} />
                        zablokowany
                      </span>
                    )}
                    {/*
                      Blokada per osoba przy niej samej, nie w osobnym menu:
                      to o tej osobie się decyduje. Blokujemy po NAZWIE
                      użytkownika (nie nicku) — to ona jest tożsamością.
                    */}
                    <button
                      type="button"
                      className="ikonowy maly"
                      aria-label={
                        zablokowana ? `Odblokuj ${nick(osoba)}` : `Zablokuj ${nick(osoba)}`
                      }
                      title={zablokowana ? "Odblokuj" : "Zablokuj"}
                      onClick={() => (zablokowana ? onOdblokuj(osoba) : onZablokuj(osoba))}
                    >
                      <Ikona nazwa="blokuj" rozmiar={15} />
                    </button>
                  </>
                )}
              </li>
            );
          })}
        </ul>
      </section>

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
    </>
  );
}

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
      <section className="sekcja-inspektora">
        <button type="button" className="cichy" onClick={() => setOtwarte(true)}>
          <Ikona nazwa="dodaj" rozmiar={14} />
          Dodaj osobę
        </button>
      </section>
    );
  }

  return (
    <section className="sekcja-inspektora">
      <h3 className="naglowek-sekcji">
        <Ikona nazwa="dodaj" rozmiar={13} />
        Dodaj osobę
      </h3>
      <form
        className="dodaj-osobe"
        onSubmit={(e) => {
          e.preventDefault();
          void dodaj();
        }}
      >
        <input
          autoFocus
          value={nazwa}
          onChange={(e) => setNazwa(e.target.value)}
          placeholder="Nazwa użytkownika"
          aria-label="Nazwa użytkownika do dodania"
          disabled={pracuje}
        />
        <button className="ikonowy glowny" disabled={!nazwa.trim() || pracuje} aria-label="Dodaj">
          <Ikona nazwa={pracuje ? "zegar" : "wyslij"} rozmiar={16} />
        </button>
        <button
          type="button"
          className="ikonowy"
          aria-label="Anuluj"
          disabled={pracuje}
          onClick={() => {
            setNazwa("");
            setOtwarte(false);
          }}
        >
          <Ikona nazwa="zamknij" rozmiar={16} />
        </button>
      </form>
      <p className="wskazowka">
        Dołączą wszystkie urządzenia tej osoby. Kod bezpieczeństwa się zmieni — to
        oczekiwane przy każdej zmianie składu.
      </p>
    </section>
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

  return (
    <section className="sekcja-inspektora">
      <h3 className="naglowek-sekcji">
        <Ikona nazwa="zegar" rozmiar={13} />
        Znikające wiadomości
      </h3>

      <p className="wskazowka">
        {sekundy
          ? `Wiadomości znikają z tego urządzenia po: ${opisZnikania(sekundy)}.`
          : "Wyłączone — wiadomości zostają, dopóki ich nie usuniesz."}
      </p>

      <div className="wybor-znikania">
        {PRESETY_ZNIKANIA.map((p) => (
          <button
            key={p.sekundy}
            type="button"
            className={sekundy === p.sekundy ? "chip aktywny" : "chip"}
            aria-pressed={sekundy === p.sekundy}
            onClick={() => onZmien(p.sekundy)}
          >
            {p.etykieta}
          </button>
        ))}
        <button
          type="button"
          className={wlasny ? "chip aktywny" : "chip"}
          aria-pressed={wlasny}
          onClick={() => setWlasny((w) => !w)}
        >
          Własny…
        </button>
        {sekundy !== null && (
          <button type="button" className="chip niszczacy-chip" onClick={() => onZmien(null)}>
            Wyłącz
          </button>
        )}
      </div>

      {wlasny && (
        <form
          className="wlasny-czas"
          onSubmit={(e) => {
            e.preventDefault();
            zastosujWlasny();
          }}
        >
          <input
            type="number"
            min={1}
            value={ile}
            onChange={(e) => setIle(e.target.value)}
            aria-label="Ile"
          />
          <select
            value={jednostka}
            onChange={(e) => setJednostka(Number(e.target.value))}
            aria-label="Jednostka czasu"
          >
            {JEDNOSTKI_ZNIKANIA.map((j) => (
              <option key={j.mnoznik} value={j.mnoznik}>
                {j.etykieta}
              </option>
            ))}
          </select>
          <button className="glowny" type="submit">
            Ustaw
          </button>
        </form>
      )}
    </section>
  );
}

/**
 * Przycisk opuszczenia grupy z potwierdzeniem.
 *
 * Za linią i w kolorze alarmu jako linia (reguła Nocturne), bo to wyjście
 * nieodwracalne: żeby wrócić, ktoś z grupy musi zaprosić ponownie. Pytanie
 * przed, nie po — po fakcie nie ma już czego cofać.
 */
function OpuscGrupe({ onOpusc }: { onOpusc: () => void }) {
  const [pyta, setPyta] = useState(false);

  useEffect(() => {
    if (!pyta) return;
    const naKlawisz = (e: KeyboardEvent) => {
      if (e.key === "Escape") setPyta(false);
    };
    window.addEventListener("keydown", naKlawisz);
    return () => window.removeEventListener("keydown", naKlawisz);
  }, [pyta]);

  return (
    <section className="strefa-opuszczenia">
      <button type="button" className="niszczacy" onClick={() => setPyta(true)}>
        <Ikona nazwa="opusc" rozmiar={16} />
        Opuść grupę
      </button>

      {pyta && (
        <div
          className="nakladka-modal"
          role="dialog"
          aria-modal="true"
          aria-label="Opuścić grupę"
          onClick={() => setPyta(false)}
        >
          <div className="modal-karta" onClick={(e) => e.stopPropagation()}>
            <h3>Opuścić tę grupę?</h3>
            <p>
              Wyjdziesz z grupy u wszystkich — przestaniesz dostawać jej wiadomości.
              Żeby wrócić, ktoś będzie musiał zaprosić Cię ponownie.
            </p>
            <div className="modal-przyciski">
              <button type="button" onClick={() => setPyta(false)}>
                Anuluj
              </button>
              <button
                type="button"
                className="niszczacy"
                autoFocus
                onClick={() => {
                  setPyta(false);
                  onOpusc();
                }}
              >
                <Ikona nazwa="opusc" rozmiar={16} />
                Opuść
              </button>
            </div>
          </div>
        </div>
      )}
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
    <section className="sekcja-inspektora">
      <h3 className="naglowek-sekcji">
        <Ikona nazwa="odcisk" rozmiar={13} />
        Kod bezpieczeństwa
      </h3>

      <button className="cichy" onClick={() => setPokazany((p) => !p)}>
        <Ikona nazwa="rozwin" rozmiar={14} klasa={pokazany ? "obrocona" : undefined} />
        {pokazany ? "Ukryj kod" : "Pokaż kod"}
      </button>

      {pokazany && (
        <>
          <code className="safety-kod">{kod}</code>
          <p className="wskazowka">
            Porównaj ten kod z rozmówcą <strong>innym kanałem</strong> — na żywo albo
            telefonicznie. Jeśli się zgadza, nikt nie podstawił się w środek rozmowy.
            Porównanie przez tę aplikację nic nie daje: to właśnie ten kanał sprawdzamy.
          </p>
          <p className="wskazowka">
            Kod zmienia się przy każdej zmianie składu rozmowy i przy dołączeniu nowego
            urządzenia — wtedy trzeba porównać go ponownie.
          </p>
        </>
      )}
    </section>
  );
}

/**
 * Edytor nazwy grupy w inspektorze.
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
      className="edytor-nazwy-grupy"
      onSubmit={(e) => {
        e.preventDefault();
        if (zmienione) onZapisz(pole.trim());
      }}
    >
      <input
        value={pole}
        onChange={(e) => setPole(e.target.value)}
        placeholder="Nazwa grupy"
        aria-label="Nazwa grupy"
      />
      <button className="ikonowy glowny" disabled={!zmienione} aria-label="Zapisz nazwę" title="Zapisz">
        <Ikona nazwa="wyslane" rozmiar={16} />
      </button>
    </form>
  );
}
