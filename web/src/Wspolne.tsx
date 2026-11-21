import NumberFlow from "@number-flow/react";
import { useEffect, useId, useState } from "react";

import { Ikona, type NazwaIkony } from "./Ikony";
import { cn } from "./components/ui/cn";
import { ToggleGroup, ToggleGroupItem } from "./components/ui/toggle-group";
import { Podpowiedz } from "./components/ui/tooltip";
import { type Jezyk, t, ustawJezyk, useJezyk } from "./lib/jezyk";
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

/**
 * Znak firmowy: znak z ikony aplikacji w obrysie `linia`.
 *
 * Nie plama: znak nie jest akcją, a plama `glowny` na ekranie należy do akcji
 * głównej. Wypełniony znak obok wypełnionego „Załóż konto" konkurowałby z nim
 * o to, gdzie patrzeć najpierw.
 */
export function ZnakMarki({ className }: { className?: string }) {
  return (
    <span
      className={cn(
        "grid size-9 shrink-0 place-items-center rounded-md border border-linia-mocna text-tekst",
        className,
      )}
      aria-hidden="true"
    >
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
 * Przełącznik PL/EN. Ten sam wzorzec co motyw: segment, jedna decyzja.
 *
 * Stoi też na ekranie powitania — osoba nieznająca angielskiego musi do
 * polskiego dotrzeć przed zalogowaniem, a nie dopiero w ustawieniach.
 */
export function WyborJezykaUI({ className }: { className?: string }) {
  const biezacy = useJezyk();
  return (
    <ToggleGroup
      type="single"
      value={biezacy}
      aria-label={t("Język", "Language")}
      className={className}
      onValueChange={(wartosc) => {
        if (wartosc) ustawJezyk(wartosc as Jezyk);
      }}
    >
      <ToggleGroupItem value="en" aria-label="English">EN</ToggleGroupItem>
      <ToggleGroupItem value="pl" aria-label="Polski">PL</ToggleGroupItem>
    </ToggleGroup>
  );
}

const ZDARZENIE_MOTYWU = "mekamb:motyw";

/**
 * Zapis, potem natychmiastowe zastosowanie i powiadomienie przełączników.
 *
 * Kolejność ma znaczenie: nasłuch zmian systemu czyta wybór z magazynu, więc
 * bez zapisu najbliższe przełączenie motywu systemowego cofnęłoby ten wybór.
 */
export function ustawMotyw(wybor: WyborMotywu) {
  zapiszWybor(wybor);
  zastosuj(rozwin(wybor, systemJasny()));
  window.dispatchEvent(new Event(ZDARZENIE_MOTYWU));
}
