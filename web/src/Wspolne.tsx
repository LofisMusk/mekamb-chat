import { useEffect, useState } from "react";

import { Ikona, type NazwaIkony } from "./Ikony";
import { PALETA_AKCENTOW, wczytajAkcent, zapiszAkcent, zastosujAkcent } from "./lib/akcent";
import type { WyborJezyka } from "./lib/jezyk";
import {
  type WyborMotywu,
  pilnujMotywu,
  rozwin,
  systemJasny,
  wczytajWybor,
  zapiszWybor,
  zastosuj,
} from "./lib/motyw";

/**
 * Części wspólne interfejsu.
 *
 * Trafia tu tylko to, czego używa więcej niż jeden ekran. Składnik używany raz
 * ma stać tam, gdzie jest używany — wspólny plik, do którego wpada wszystko,
 * po pół roku jest drugą aplikacją.
 */

/** Znak firmowy: obrys akcentu z tarczą w środku. Nigdy wypełniony. */
export function ZnakMarki() {
  return (
    <span className="marka-znak" aria-hidden="true">
      <Ikona nazwa="tarcza" rozmiar={16} />
    </span>
  );
}

/** Pusty stan — ikona, zdanie i ewentualnie podpowiedź, co z tym zrobić. */
export function Pusto({
  ikona,
  tytul,
  wskazowka,
}: {
  ikona: NazwaIkony;
  tytul: string;
  wskazowka?: string;
}) {
  return (
    <div className="pusto">
      <Ikona nazwa={ikona} rozmiar={28} />
      <span>{tytul}</span>
      {wskazowka && <span className="wskazowka">{wskazowka}</span>}
    </div>
  );
}

/**
 * Pasek błędu.
 *
 * Zamykalny, bo komunikat nie ma zostawać na ekranie na zawsze — a nie znika
 * sam, bo błąd, który zdążył zniknąć, zanim go przeczytano, jest gorszy niż
 * żaden: użytkownik wie tylko tyle, że coś mignęło.
 */
/**
 * Pasek błędu, który sam znika po 5 sekundach.
 *
 * # Dlaczego znika, a wcześniej nie
 *
 * Baner wisiał aż do kliknięcia „×" — a większość komunikatów to rzecz, którą
 * przeczytasz raz i chcesz, żeby zeszła z drogi. Zostawianie ich na ekranie
 * zamieniało pomocną informację w natręta. Zegar startuje od nowa przy KAŻDEJ
 * zmianie treści (`tekst` w zależnościach), więc dwa błędy pod rząd dostają po
 * pełne 5 sekund, a nie resztkę cudzego okna. Najechanie kursorem pauzuje
 * odliczanie — dłuższy komunikat da się doczytać, zanim zniknie.
 */
export function PasekBledu({ tekst, onZamknij }: { tekst: string; onZamknij: () => void }) {
  const [zatrzymane, setZatrzymane] = useState(false);

  useEffect(() => {
    if (zatrzymane) return;
    const id = setTimeout(onZamknij, 5000);
    return () => clearTimeout(id);
  }, [tekst, zatrzymane, onZamknij]);

  return (
    <div
      className="blad"
      role="alert"
      onMouseEnter={() => setZatrzymane(true)}
      onMouseLeave={() => setZatrzymane(false)}
    >
      <Ikona nazwa="ostrzezenie" rozmiar={16} />
      <p>{tekst}</p>
      <button aria-label="Zamknij komunikat" onClick={onZamknij}>
        <Ikona nazwa="zamknij" rozmiar={14} />
      </button>
    </div>
  );
}

const MOTYWY: { wybor: WyborMotywu; ikona: NazwaIkony; etykieta: string }[] = [
  { wybor: "ciemny", ikona: "ksiezyc", etykieta: "Ciemny" },
  { wybor: "jasny", ikona: "slonce", etykieta: "Jasny" },
  { wybor: "auto", ikona: "ekran", etykieta: "Systemowy" },
];

/**
 * Wybór motywu.
 *
 * Trzy stany, nie przełącznik dwustanowy: „jasny / ciemny" bez trzeciej opcji
 * znaczy, że wybór raz podjęty przestaje słuchać systemu — telefon przełączony
 * wieczorem na ciemny zostawia aplikację jasną. „Za systemem" musi więc być
 * osobnym, widocznym stanem, a nie domyślnym zachowaniem, o którym nikt nie wie.
 */
export function WyborMotywuUI() {
  const [wybor, setWybor] = useState<WyborMotywu>(() => wczytajWybor());

  // Nasłuch zmian systemu zakładamy raz i pytamy o bieżący wybór przez
  // funkcję — inaczej przepinalibyśmy zdarzenia przy każdym kliknięciu.
  useEffect(() => pilnujMotywu(() => wczytajWybor()), []);

  return (
    <div className="wybor-motywu" role="group" aria-label="Motyw">
      {MOTYWY.map((motyw) => (
        <button
          key={motyw.wybor}
          className={wybor === motyw.wybor ? "aktywny" : undefined}
          aria-pressed={wybor === motyw.wybor}
          title={motyw.etykieta}
          onClick={() => {
            // Zapis, potem natychmiastowe zastosowanie. Nasłuch zmian systemu
            // czyta wybór z magazynu, więc kolejność ma znaczenie: bez zapisu
            // najbliższe przełączenie motywu systemowego cofnęłoby ten wybór.
            zapiszWybor(motyw.wybor);
            setWybor(motyw.wybor);
            zastosuj(rozwin(motyw.wybor, systemJasny()));
          }}
        >
          <Ikona nazwa={motyw.ikona} rozmiar={15} />
          <span className="tylko-dla-czytnika">{motyw.etykieta}</span>
        </button>
      ))}
    </div>
  );
}

/**
 * Wybór koloru akcentu — osiem próbek, ten sam zestaw co `Akcent` na Androidzie.
 *
 * Kliknięcie zawsze WYBIERA, nie ma stanu „nic nie wybrane" do kliknięcia
 * z powrotem — kto chce niebieski z powrotem, klika próbkę niebieską. Jeden
 * jasny cel jest tu prostszy niż osobny przycisk „domyślny" obok ośmiu innych.
 */
export function WyborAkcentuUI() {
  const [wybor, setWybor] = useState<string | null>(() => wczytajAkcent());

  return (
    <div className="paleta-akcentow" role="group" aria-label="Kolor akcentu">
      {PALETA_AKCENTOW.map((akcent) => (
        <button
          key={akcent.id}
          type="button"
          className={wybor === akcent.id ? "probka-akcentu wybrana" : "probka-akcentu"}
          aria-label={akcent.id}
          aria-pressed={wybor === akcent.id}
          style={{ background: akcent.probka }}
          onClick={() => {
            zapiszAkcent(akcent.id);
            setWybor(akcent.id);
            zastosujAkcent(akcent.id);
          }}
        />
      ))}
    </div>
  );
}

const JEZYKI: { wybor: WyborJezyka; etykieta: string }[] = [
  { wybor: "pl", etykieta: "PL" },
  { wybor: "en", etykieta: "EN" },
];

/**
 * Wybór języka chromu aplikacji — kontrolowany, bo w przeciwieństwie do motywu
 * i akcentu wynik trzeba przekazać w dół drzewa (nawigacja, lista, wątek),
 * a nie tylko wpisać w `<html>`. Stan i zapis do magazynu leżą u wywołującego
 * (`Czat.tsx`), ten komponent tylko rysuje wybór, tak samo jak `WyborMotywuUI`.
 */
export function WyborJezykaUI({
  jezyk,
  onZmien,
}: {
  jezyk: WyborJezyka;
  onZmien: (j: WyborJezyka) => void;
}) {
  return (
    <div className="wybor-motywu" role="group" aria-label="Język interfejsu">
      {JEZYKI.map((j) => (
        <button
          key={j.wybor}
          className={jezyk === j.wybor ? "aktywny" : undefined}
          aria-pressed={jezyk === j.wybor}
          onClick={() => onZmien(j.wybor)}
        >
          {j.etykieta}
        </button>
      ))}
    </div>
  );
}
