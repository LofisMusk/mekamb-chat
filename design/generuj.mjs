/**
 * Generator zestawu ikon na obie platformy.
 *
 * Czyta `ikony.mjs` i wypisuje `web/src/Ikony.tsx` oraz
 * `android/.../Ikony.kt`. Uruchamiany ręcznie po zmianie źródła:
 *
 *     node design/generuj.mjs
 *
 * # Dlaczego pliki są w repozytorium, a nie budowane
 *
 * Bo inaczej build Androida zależałby od Node'a, a build weba od kroku, który
 * łatwo pominąć. Zamiast tego pliki są zwykłym kodem pod kontrolą wersji,
 * a `web/src/lib/ikony.test.ts` pilnuje, żeby zgadzały się ze źródłem. Rozjazd
 * wywala CI — czyli dokładnie wtedy, gdy powstaje, a nie gdy ktoś zauważy dwie
 * różne strzałki na dwóch telefonach.
 *
 * # Dlaczego zwykły ESM, a nie TypeScript
 *
 * Żeby dało się to uruchomić samym `node`, bez dokładania uruchamiacza TS do
 * zależności. Typy są obok, w `ikony.d.mts`.
 */

import { readFileSync, writeFileSync } from "node:fs";
import { fileURLToPath, pathToFileURL } from "node:url";
import { dirname, join } from "node:path";

import { GRUBOSC, IKONY, PLOTNO } from "./ikony.mjs";

const KORZEN = join(dirname(fileURLToPath(import.meta.url)), "..");

export const SCIEZKA_WEB = join(KORZEN, "web", "src", "Ikony.tsx");
export const SCIEZKA_ANDROID = join(
  KORZEN,
  "android",
  "app",
  "src",
  "main",
  "java",
  "com",
  "mekamb",
  "chat",
  "Ikony.kt",
);

/**
 * Ostrzeżenie na górze wygenerowanych plików.
 *
 * Wprost, w pierwszej linii i po polsku: plik wygląda jak zwykły kod, więc bez
 * tego pierwsza poprawka trafi tutaj i zniknie przy najbliższym generowaniu.
 */
function naglowek(zrodlo) {
  return [
    "PLIK GENEROWANY — nie edytuj ręcznie.",
    "",
    `Źródłem jest \`design/ikony.mjs\`; ten plik powstaje z \`node design/generuj.mjs\`.`,
    "Poprawka wpisana tutaj zniknie przy najbliższym generowaniu, a test",
    "`web/src/lib/ikony.test.ts` wywali się, zanim zdąży komukolwiek pomóc.",
    "",
    `Zestaw: ${IKONY.length} ikon, płótno ${PLOTNO}×${PLOTNO}, kontur ${String(GRUBOSC).replace(".", ",")}.`,
    ...lam(zrodlo, 76),
  ];
}

/** Łamanie zdania na wiersze — komentarz szerszy niż ekran czyta się gorzej niż żaden. */
function lam(zdanie, limit) {
  const wiersze = [""];

  for (const slowo of zdanie.split(" ")) {
    const ostatni = wiersze.length - 1;
    if (wiersze[ostatni] === "") wiersze[ostatni] = slowo;
    else if ((wiersze[ostatni] + " " + slowo).length <= limit) wiersze[ostatni] += " " + slowo;
    else wiersze.push(slowo);
  }

  return wiersze;
}

/**
 * Dzieli ścieżkę na wiersze na granicach podścieżek.
 *
 * Ścieżka pisana jednym ciągiem potrafi mieć 200 znaków; złamana w losowym
 * miejscu jest nieczytelna. Granica podścieżki (`M`) jest jedynym miejscem,
 * w którym przełamanie coś znaczy — oddziela kolejne pociągnięcia rysunku.
 */
function zawin(sciezka, limit) {
  // Podścieżka bywa sama dłuższa niż wiersz (spinacz to jedno pociągnięcie
  // o dziewięciu poleceniach). Wtedy dzielimy dalej — na granicach poleceń,
  // bo w środku pary liczb przełamanie już niczego nie oddziela.
  const czesci = sciezka
    .split(/(?= M(?=[\d-]))/)
    .flatMap((czesc) => (czesc.length <= limit ? [czesc] : czesc.split(/(?= [ACHLQSTVZ](?=[\d-]))/)));

  const wiersze = [];

  for (const czesc of czesci) {
    const ostatni = wiersze.length - 1;
    if (ostatni >= 0 && (wiersze[ostatni] + czesc).length <= limit) {
      wiersze[ostatni] += czesc;
    } else {
      wiersze.push(czesc.trimStart());
    }
  }

  return wiersze;
}

/** Zapis ścieżki jako wyrażenia w danym języku — jeden napis albo sklejenie kilku. */
function napis(sciezka, wciecie, limit) {
  const wiersze = zawin(sciezka, limit);

  if (wiersze.length === 1) return `"${wiersze[0]}"`;

  return wiersze
    .map((w, i) => `${i === 0 ? "" : wciecie}"${i === 0 ? w : ` ${w}`}"`)
    .join(" +\n");
}

// --- Web ---------------------------------------------------------------------

export function zrodloWeb() {
  const komentarz = naglowek(
    "Komponent rysuje kontur w `currentColor`, więc ikona bierze kolor z tekstu " +
      "obok — w tym systemie kolor niesie stan, a nie sama ikona.",
  );

  const wiersze = [
    "/*",
    ...komentarz.map((w) => (w ? ` * ${w}` : " *")),
    " */",
    "",
    "/** Nazwy ikon. Zamknięty zbiór — literówka jest błędem kompilacji, nie pustym miejscem. */",
    "export type NazwaIkony =",
    ...IKONY.map((i, n) => `  | "${i.nazwa}"${n === IKONY.length - 1 ? ";" : ""}`),
    "",
    "/** Ścieżki konturu na płótnie 24×24. */",
    "export const SCIEZKI: Record<NazwaIkony, string> = {",
  ];

  for (const ikona of IKONY) {
    wiersze.push(`  /** ${ikona.opis} */`);
    wiersze.push(`  ${ikona.nazwa}: ${napis(ikona.sciezka, "    ", 84)},`);
  }

  wiersze.push(
    "};",
    "",
    "export interface WlasnosciIkony {",
    "  nazwa: NazwaIkony;",
    "  /** Bok w pikselach. Domyślnie 18 — obok tekstu 16 px ikona 24 px dominuje. */",
    "  rozmiar?: number;",
    "  /**",
    "   * Nazwa dla czytnika ekranu.",
    "   *",
    "   * Brak znaczy `aria-hidden`: ikona stojąca obok własnej etykiety odczytana",
    "   * drugi raz jest szumem. Podaj ją tylko wtedy, gdy ikona JEST etykietą.",
    "   */",
    "  etykieta?: string;",
    "  klasa?: string;",
    "}",
    "",
    "/**",
    " * Ikona konturowa.",
    " *",
    " * `stroke` jest niezależny od skali (`vector-effect` nie jest potrzebny, bo",
    " * płótno i rozmiar są proporcjonalne), a `fill=\"none\"` pilnuje zasady systemu:",
    " * akcent jest linią, nigdy plamą.",
    " */",
    "export function Ikona({ nazwa, rozmiar = 18, etykieta, klasa }: WlasnosciIkony) {",
    "  return (",
    "    <svg",
    "      className={klasa ? `ikona ${klasa}` : \"ikona\"}",
    "      width={rozmiar}",
    "      height={rozmiar}",
    `      viewBox="0 0 ${PLOTNO} ${PLOTNO}"`,
    '      fill="none"',
    '      stroke="currentColor"',
    `      strokeWidth={${GRUBOSC}}`,
    '      strokeLinecap="round"',
    '      strokeLinejoin="round"',
    '      role={etykieta ? "img" : undefined}',
    "      aria-label={etykieta}",
    "      aria-hidden={etykieta ? undefined : true}",
    '      focusable="false"',
    "    >",
    "      <path d={SCIEZKI[nazwa]} />",
    "    </svg>",
    "  );",
    "}",
    "",
  );

  return wiersze.join("\n");
}

// --- Android -----------------------------------------------------------------

export function zrodloAndroid() {
  const komentarz = naglowek(
    "Rysowane wprost, bo projekt zakłada Phosphor, którego na Androida nie ma " +
      "bez pliku z krojem, a `material-icons-extended` waży kilka megabajtów " +
      "przy APK ważącym 5,4 MB.",
  );

  const wiersze = [
    "package com.mekamb.chat",
    "",
    "import androidx.compose.ui.graphics.Color",
    "import androidx.compose.ui.graphics.SolidColor",
    "import androidx.compose.ui.graphics.StrokeCap",
    "import androidx.compose.ui.graphics.StrokeJoin",
    "import androidx.compose.ui.graphics.vector.ImageVector",
    "import androidx.compose.ui.graphics.vector.PathParser",
    "import androidx.compose.ui.unit.dp",
    "",
    "/*",
    ...komentarz.map((w) => (w ? ` * ${w}` : " *")),
    " */",
    "",
    `private const val GRUBOSC = ${GRUBOSC}f`,
    "",
    "private fun ikona(nazwa: String, sciezka: String): ImageVector =",
    "    ImageVector.Builder(",
    "        name = nazwa,",
    `        defaultWidth = ${PLOTNO}.dp,`,
    `        defaultHeight = ${PLOTNO}.dp,`,
    `        viewportWidth = ${PLOTNO}f,`,
    `        viewportHeight = ${PLOTNO}f,`,
    "    ).apply {",
    "        // `addPath`, a nie `path {}`: ścieżki są zapisane w notacji SVG, więc",
    "        // trafiają gotowe, bez przepisywania na wywołania.",
    "        addPath(",
    "            pathData = PathParser().parsePathString(sciezka).toNodes(),",
    "            stroke = SolidColor(Color.Black),",
    "            strokeLineWidth = GRUBOSC,",
    "            strokeLineCap = StrokeCap.Round,",
    "            strokeLineJoin = StrokeJoin.Round,",
    "        )",
    "    }.build()",
    "",
    "object Ikony {",
  ];

  IKONY.forEach((ikona, n) => {
    if (n > 0) wiersze.push("");
    wiersze.push(`    /** ${ikona.opis} */`);

    const wartosc = napis(ikona.sciezka, "        ", 88);

    if (!wartosc.includes("\n") && `    val ${ikona.kotlin} = ikona("${ikona.nazwa}", ${wartosc})`.length <= 100) {
      wiersze.push(`    val ${ikona.kotlin} = ikona("${ikona.nazwa}", ${wartosc})`);
    } else {
      wiersze.push(`    val ${ikona.kotlin} = ikona(`);
      wiersze.push(`        "${ikona.nazwa}",`);
      wiersze.push(`        ${wartosc},`);
      wiersze.push("    )");
    }
  });

  wiersze.push("}", "");

  return wiersze.join("\n");
}

// --- Uruchomienie ------------------------------------------------------------

/** Czy plik na dysku zgadza się z tym, co generator by wypisał. */
export function zgodne(sciezka, oczekiwane) {
  try {
    return readFileSync(sciezka, "utf8") === oczekiwane;
  } catch {
    return false;
  }
}

// Tylko przy uruchomieniu wprost. Test importuje ten moduł, żeby porównać
// wynik z plikami na dysku — gdyby import je nadpisywał, test zawsze by
// przechodził i nie pilnowałby niczego.
if (process.argv[1] && import.meta.url === pathToFileURL(process.argv[1]).href) {
  writeFileSync(SCIEZKA_WEB, zrodloWeb());
  writeFileSync(SCIEZKA_ANDROID, zrodloAndroid());
  console.log(`Wygenerowano ${IKONY.length} ikon:\n  ${SCIEZKA_WEB}\n  ${SCIEZKA_ANDROID}`);
}
