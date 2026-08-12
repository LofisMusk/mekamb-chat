import { useEffect, useState } from "react";

import { Ikona, type NazwaIkony } from "./Ikony";
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
export function PasekBledu({ tekst, onZamknij }: { tekst: string; onZamknij: () => void }) {
  return (
    <div className="blad" role="alert">
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
