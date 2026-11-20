/**
 * Kolor akcentu — jedna decyzja, która przemalowuje akcje, własne dymki
 * i znaczniki.
 *
 * Ten sam wybór co `Akcent` w Nocturne.kt na Androidzie: osiem kolorów,
 * jeden zestaw dla obu platform. Domyślny (`null`, nic nie zapisane) zostaje
 * niebieskim z arkusza stylów — nie duplikujemy go tutaj jako dziewiątą
 * pozycję, żeby „wróć do domyślnego" nie musiało pamiętać, który wpis to
 * właściwie jest.
 *
 * # `probka` kontra `fill`
 *
 * Próbka w selektorze pokazuje żywy odcień — tak jak w Nocturne.kt. Ale część
 * z tych odcieni (zieleń, pomarańcz, róż, turkus) pod BIAŁYM tekstem daje mniej
 * niż 4,5:1 — dokładnie ta sama pułapka, która wcześniej zmusiła markowy cyjan
 * do zejścia na `--babel-wlasny: #0E7490` (patrz `styles.css`). Dlatego akcje,
 * własne dymki i znaczniki dostają `fill`: ten sam odcień przyciemniony
 * dokładnie tyle, żeby biały tekst na nim czytał się bez mrużenia oczu.
 */

import { ZDARZENIE_MOTYWU } from "./motyw";

export interface Akcent {
  id: string;
  /** Żywy odcień — sam kolor próbki w selektorze. */
  probka: string;
  /** Odcień użyty jako wypełnienie pod białym tekstem — kontrastowo bezpieczny. */
  fill: string;
}

export const PALETA_AKCENTOW: Akcent[] = [
  { id: "niebieski", probka: "#007AFF", fill: "#007AFF" },
  { id: "zielony", probka: "#34C759", fill: "#19702F" },
  { id: "pomaranczowy", probka: "#FF9500", fill: "#B35900" },
  { id: "malinowy", probka: "#FF375F", fill: "#D6274F" },
  { id: "fioletowy", probka: "#AF52DE", fill: "#9A3FC7" },
  { id: "indygo", probka: "#5856D6", fill: "#5856D6" },
  { id: "turkusowy", probka: "#00C7BE", fill: "#0A7A73" },
  { id: "grafitowy", probka: "#8E8E93", fill: "#5E5E63" },
];

const KLUCZ = "mekamb.akcent";

function znajdz(id: string | null): Akcent | undefined {
  return id ? PALETA_AKCENTOW.find((a) => a.id === id) : undefined;
}

/** Zapisany wybór, albo `null` — czyli „zostań przy domyślnym z arkusza". */
export function wczytajAkcent(magazyn: Pick<Storage, "getItem"> = localStorage): string | null {
  try {
    const zapisany = magazyn.getItem(KLUCZ);
    return znajdz(zapisany) ? zapisany : null;
  } catch {
    // Prywatne okno bez dostępu do magazynu — domyślny akcent i tyle.
    return null;
  }
}

export function zapiszAkcent(
  id: string | null,
  magazyn: Pick<Storage, "setItem" | "removeItem"> = localStorage,
): void {
  try {
    if (id) magazyn.setItem(KLUCZ, id);
    else magazyn.removeItem(KLUCZ);
  } catch {
    // jw. — wybór zadziała do końca sesji i tyle.
  }
}

/**
 * Wpisuje akcent do dokumentu jako właściwości inline na `<html>`.
 *
 * Inline, nie przez klasę: te same pięć ról (`--akcent`, `--akcent-tekst`,
 * `--akcent-tlo`, `--babel-wlasny`, `--znacznik-tlo`) muszą wygrać z regułami
 * obu motywów w arkuszu, a motyw i akcent to dwa niezależne wybory — zmiana
 * jednego nie ma czyścić drugiego. `null` usuwa właściwości i oddaje kolor
 * z powrotem arkuszowi (czyli niebieskiemu systemowemu).
 */
export function zastosujAkcent(id: string | null, dokument: Document = document): void {
  const styl = dokument.documentElement.style;
  const akcent = znajdz(id);

  if (!akcent) {
    styl.removeProperty("--akcent");
    styl.removeProperty("--akcent-tekst");
    styl.removeProperty("--akcent-tlo");
    styl.removeProperty("--babel-wlasny");
    styl.removeProperty("--znacznik-tlo");
    return;
  }

  // Tło tinted liczone z `fill`, nie z żywej próbki — inaczej róż i pomarańcz
  // dawałyby agresywnie nasycone plamy zamiast delikatnego podkładu.
  const jasny = dokument.documentElement.dataset.motyw !== "ciemny";
  const tlo = jasny
    ? `color-mix(in srgb, ${akcent.fill} 12%, white)`
    : `color-mix(in srgb, ${akcent.fill} 24%, black)`;

  styl.setProperty("--akcent", akcent.fill);
  styl.setProperty("--akcent-tekst", akcent.fill);
  styl.setProperty("--akcent-tlo", tlo);
  styl.setProperty("--babel-wlasny", akcent.fill);
  styl.setProperty("--znacznik-tlo", akcent.fill);
}

/**
 * Włącza akcent i przelicza go od nowa przy każdej zmianie motywu.
 *
 * Tło tinted (`--akcent-tlo`) zależy od tego, czy motyw jest jasny czy ciemny
 * (patrz `zastosujAkcent`), więc zmiana motywu — klikiem albo za systemem —
 * musi przeliczyć akcent od nowa. `ZDARZENIE_MOTYWU` odpala się po obu drogach,
 * bo obie kończą się w `zastosuj()` z `motyw.ts`.
 */
export function pilnujAkcentu(dajId: () => string | null, dokument: Document = document): () => void {
  const odswiez = () => zastosujAkcent(dajId(), dokument);

  odswiez();
  dokument.addEventListener(ZDARZENIE_MOTYWU, odswiez);

  return () => dokument.removeEventListener(ZDARZENIE_MOTYWU, odswiez);
}
