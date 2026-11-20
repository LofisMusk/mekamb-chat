import NumberFlow from "@number-flow/react";
import { useEffect, useId, useState } from "react";

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

/** Znak firmowy: ten sam znak co ikona aplikacji, w kółku akcentu. */
export function ZnakMarki() {
  return (
    <span className="marka-znak" aria-hidden="true">
      <Ikona nazwa="marka" rozmiar={18} />
    </span>
  );
}

/** Pusty stan — ikona, zdanie i ewentualnie podpowiedź, co z tym zrobić. */
export function Pusto({
  ikona,
  tytul,
  wskazowka,
  className,
}: {
  ikona: NazwaIkony;
  tytul: string;
  wskazowka?: string;
  className?: string;
}) {
  return (
    <div
      className={cn(
        "flex flex-1 flex-col items-center justify-center gap-2 px-6 py-10 text-center",
        className,
      )}
    >
      <span className="mb-1 grid size-12 place-items-center rounded-full bg-wglebienie text-tekst-drugi">
        <Ikona nazwa={ikona} rozmiar={22} />
      </span>
      <span className="text-tresc font-medium text-tekst">{tytul}</span>
      {wskazowka && <span className="max-w-72 text-meta text-tekst-drugi">{wskazowka}</span>}
    </div>
  );
}

/**
 * Znacznik liczby: pigułka `glowny`, liczba animowana przez NumberFlow.
 *
 * # Dlaczego wypełniony, skoro plama należy do akcji głównej
 *
 * Bo znacznik nie jest akcją, tylko odpowiedzią na pytanie „czy ktoś coś do
 * mnie powiedział" — tę samą, którą daje dymek `glowny`. Obrysowany ginął
 * wśród obrysowanych przycisków.
 *
 * Liczba, a nie kropka — „trzy" i „trzydzieści" to inna decyzja o tym, czy
 * zaglądać teraz. NumberFlow przewija cyfry zamiast podmieniać je skokiem,
 * więc przybywająca wiadomość jest zauważalna kątem oka; przy „Ogranicz ruch"
 * sam z siebie przestaje animować.
 */
export function Znacznik({ liczba, className }: { liczba: number; className?: string }) {
  return (
    <span
      className={cn(
        "inline-flex h-5 min-w-5 shrink-0 items-center justify-center rounded-full bg-glowny px-1.5 text-podpis leading-none font-semibold text-glowny-tekst tabular-nums",
        className,
      )}
    >
      <NumberFlow value={liczba} />
    </span>
  );
}

/** Liczba w zdaniu („Grupa · 4 osoby") — ta sama animacja, bez pigułki. */
export function Liczba({ wartosc }: { wartosc: number }) {
  return <NumberFlow value={wartosc} className="tabular-nums" />;
}

/**
 * Tło ekranu powitania: delikatny wzór kropek (Magic UI „Dot Pattern").
 *
 * Kropki w kolorze `linia`, czyli dokładnie tak widoczne jak obramowania —
 * tło ma być fakturą, nie obrazkiem. Maska wygasza je ku brzegom, żeby wzór
 * nie dochodził do krawędzi ekranu twardą linią.
 */
export function WzorKropek({ className }: { className?: string }) {
  const id = useId();

  return (
    <svg
      aria-hidden="true"
      className={cn(
        "pointer-events-none absolute inset-0 size-full fill-linia-mocna [mask-image:radial-gradient(ellipse_at_center,black_30%,transparent_75%)]",
        className,
      )}
    >
      <defs>
        <pattern id={id} width={20} height={20} patternUnits="userSpaceOnUse">
          <circle cx={1.5} cy={1.5} r={1.1} />
        </pattern>
      </defs>
      <rect width="100%" height="100%" fill={`url(#${id})`} />
    </svg>
  );
}

/**
 * Ładowanie: przesuwający się pas na prostokącie o kształcie tego, co przyjdzie.
 *
 * Prostokąt w miejscu treści mówi, GDZIE coś się pojawi; napis „Wczytywanie…"
 * obok niego mówi, że nic się nie zawiesiło — dla czytnika ekranu jest jedynym
 * śladem.
 */
export function Migotanie({ className, opis }: { className?: string; opis: string }) {
  return (
    <span className={cn("migotanie block", className)} role="status">
      <span className="tylko-dla-czytnika">{opis}</span>
    </span>
  );
}

// Etykiety liczone przy renderze, nie przy imporcie — inaczej zostałyby
// w języku, w którym aplikacja wystartowała.
const MOTYWY = (): { wybor: WyborMotywu; ikona: NazwaIkony; etykieta: string }[] => [
  { wybor: "jasny", ikona: "slonce", etykieta: t("Jasny", "Light") },
  { wybor: "ciemny", ikona: "ksiezyc", etykieta: t("Ciemny", "Dark") },
  { wybor: "auto", ikona: "ekran", etykieta: t("Systemowy", "System") },
];

/**
 * Wybór motywu.
 *
 * Trzy stany, nie przełącznik dwustanowy: „jasny / ciemny" bez trzeciej opcji
 * znaczy, że wybór raz podjęty przestaje słuchać systemu — telefon przełączony
 * wieczorem na ciemny zostawia aplikację jasną. „Za systemem" musi więc być
 * osobnym, widocznym stanem, a nie domyślnym zachowaniem, o którym nikt nie wie.
 */
export function WyborMotywuUI({ zEtykietami = false }: { zEtykietami?: boolean }) {
  const [wybor, setWybor] = useState<WyborMotywu>(() => wczytajWybor());

  // Nasłuch zmian systemu zakładamy raz i pytamy o bieżący wybór przez
  // funkcję — inaczej przepinalibyśmy zdarzenia przy każdym kliknięciu.
  useEffect(() => pilnujMotywu(() => wczytajWybor()), []);

  // Zmiana z innego miejsca (paleta poleceń) — dociągamy stan przy fokusie
  // okna i przy własnym zdarzeniu, zamiast trzymać drugą kopię wyboru.
  useEffect(() => {
    const odswiez = () => setWybor(wczytajWybor());
    window.addEventListener(ZDARZENIE_MOTYWU, odswiez);
    return () => window.removeEventListener(ZDARZENIE_MOTYWU, odswiez);
  }, []);

  return (
    <ToggleGroup
      type="single"
      value={wybor}
      aria-label={t("Motyw", "Theme")}
      className={zEtykietami ? "w-full" : undefined}
      onValueChange={(wartosc) => {
        // Klik w już wybraną pozycję odznacza ją w Radiksie — a motyw „żaden"
        // nie istnieje, więc taki klik po prostu niczego nie zmienia.
        if (wartosc) ustawMotyw(wartosc as WyborMotywu);
      }}
    >
      {MOTYWY().map((motyw) =>
        zEtykietami ? (
          <ToggleGroupItem key={motyw.wybor} value={motyw.wybor}>
            <Ikona nazwa={motyw.ikona} rozmiar={15} />
            {motyw.etykieta}
          </ToggleGroupItem>
        ) : (
          <Podpowiedz key={motyw.wybor} tresc={motyw.etykieta}>
            <ToggleGroupItem value={motyw.wybor} aria-label={motyw.etykieta}>
              <Ikona nazwa={motyw.ikona} rozmiar={15} />
            </ToggleGroupItem>
          </Podpowiedz>
        ),
      )}
    </ToggleGroup>
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
