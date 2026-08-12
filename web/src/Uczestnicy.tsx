import { useMemo, useState } from "react";

import { Ikona } from "./Ikony";
import type { Messenger } from "./lib/messenger";

/**
 * Skład rozmowy i kod bezpieczeństwa.
 *
 * Skład bierzemy z drzewa MLS, nie z własnej listy w interfejsie — to jedyne
 * miejsce, które wie, kto naprawdę jest w grupie po wszystkich commitach.
 * Własna lista rozjechałaby się przy pierwszej zmianie zrobionej przez kogoś
 * innego.
 */
export function Uczestnicy({
  messenger,
  groupId,
  onBlad,
}: {
  messenger: Messenger;
  groupId: Uint8Array;
  onBlad: (e: unknown) => void;
}) {
  const [nowy, setNowy] = useState("");
  const [dodaje, setDodaje] = useState(false);
  // Licznik wymusza odczytanie składu na nowo po każdej udanej zmianie.
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

  return (
    <>
      <section className="sekcja-inspektora">
        <h3 className="naglowek-sekcji">
          <Ikona nazwa="osoby" rozmiar={13} />
          {osoby.length === 2 ? "Rozmowa prywatna" : `Grupa · ${osoby.length} osób`}
        </h3>

        <ul className="lista-osob">
          {osoby.map((osoba) => (
            <li key={osoba}>
              <span className="awatar maly" aria-hidden="true">
                {osoba.slice(0, 1)}
              </span>
              <span className="kto">{osoba}</span>
              {osoba === messenger.account.userId && <span className="tryb">Ty</span>}
            </li>
          ))}
        </ul>

        <form
          className="dodaj-osobe"
          onSubmit={async (e) => {
            e.preventDefault();
            if (!nowy.trim()) return;

            setDodaje(true);
            try {
              await messenger.addMember(groupId, nowy.trim());
              setNowy("");
              setOdswiezenie((n) => n + 1);
            } catch (err) {
              onBlad(err);
            } finally {
              setDodaje(false);
            }
          }}
        >
          <input
            value={nowy}
            onChange={(e) => setNowy(e.target.value)}
            placeholder="Nazwa użytkownika · Username"
            aria-label="Dodaj osobę do rozmowy · Add member"
          />
          <button disabled={dodaje} aria-label="Dodaj osobę" title="Dodaj osobę">
            <Ikona nazwa={dodaje ? "zegar" : "dodaj"} rozmiar={16} />
          </button>
        </form>

        <p className="wskazowka">
          Nowa osoba zobaczy wiadomości wysłane od momentu dołączenia. Wcześniejszych nie da
          się jej pokazać i jest to zamierzone.
        </p>
      </section>

      <KodBezpieczenstwa messenger={messenger} groupId={groupId} odswiezenie={odswiezenie} />
    </>
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
