//! Generator kodów QR — ISO/IEC 18004, tryb bajtowy, korekcja poziomu M.
//!
//! # Dlaczego własny, a nie biblioteka
//!
//! Ten sam powód, dla którego własne są STUN i warstwa P2P: kod, który
//! przenosi klucze konta, ma być w całości czytelny w tym repozytorium.
//! Kod QR nie jest przy tym elementem bezpieczeństwa — to sposób zapisu, nie
//! szyfr — więc własna implementacja niczego nie osłabia. Osłabiłby ją błąd
//! dający kod nie do zeskanowania, dlatego testy porównują wynik z **osobną
//! implementacją**, a nie z tym samym kodem puszczonym w drugą stronę.
//!
//! # Zakres
//!
//! Wersje 1–10 przy korekcji M, czyli do 216 bajtów. To z zapasem wystarcza
//! na `otpauth://` i na kod parowania. Większe wejście jest błędem,
//! a nie cichym przejściem na słabszą korekcję — kod przenoszony aparatem
//! między urządzeniami musi znieść odbicia i krzywe ujęcie.

/** Największa obsługiwana wersja. */
const MAX_VERSION = 10;

/**
 * Parametry bloków dla korekcji poziomu M, wersje 1–10.
 *
 * `ec` — bajty korekcji na blok. Grupy różnią się liczbą bajtów danych:
 * przy niektórych wersjach dane nie dzielą się równo, więc część bloków jest
 * o jeden bajt dłuższa.
 */
const BLOKI: readonly { ec: number; grupy: readonly (readonly [number, number])[] }[] = [
  { ec: 10, grupy: [[1, 16]] }, // 1
  { ec: 16, grupy: [[1, 28]] }, // 2
  { ec: 26, grupy: [[1, 44]] }, // 3
  { ec: 18, grupy: [[2, 32]] }, // 4
  { ec: 24, grupy: [[2, 43]] }, // 5
  { ec: 16, grupy: [[4, 27]] }, // 6
  { ec: 18, grupy: [[4, 31]] }, // 7
  { ec: 22, grupy: [[2, 38], [2, 39]] }, // 8
  { ec: 22, grupy: [[3, 36], [2, 37]] }, // 9
  { ec: 26, grupy: [[4, 43], [1, 44]] }, // 10
];

/** Środki wzorów wyrównania. Wersja 1 ich nie ma. */
const WYROWNANIE: readonly (readonly number[])[] = [
  [], [6, 18], [6, 22], [6, 26], [6, 30],
  [6, 34], [6, 22, 38], [6, 24, 42], [6, 26, 46], [6, 28, 50],
];

function parametry(wersja: number): { ec: number; grupy: readonly (readonly [number, number])[] } {
  const wpis = BLOKI[wersja - 1];
  if (!wpis) throw new Error(`nieobsługiwana wersja kodu QR: ${wersja}`);
  return wpis;
}

// ---------------------------------------------------------------------------
// Arytmetyka GF(256) — potrzebna do kodu Reeda-Solomona
// ---------------------------------------------------------------------------

const EXP = new Uint8Array(512);
const LOG = new Uint8Array(256);

{
  let x = 1;
  for (let i = 0; i < 255; i++) {
    EXP[i] = x;
    LOG[x] = i;
    // Wielomian pierwotny 0x11d, standardowy dla QR.
    x <<= 1;
    if (x & 0x100) x ^= 0x11d;
  }
  for (let i = 255; i < 512; i++) EXP[i] = EXP[i - 255] ?? 0;
}

const exp = (i: number): number => EXP[i] ?? 0;
const log = (i: number): number => LOG[i] ?? 0;

function mnoz(a: number, b: number): number {
  if (a === 0 || b === 0) return 0;
  return exp(log(a) + log(b));
}

/** Wielomian generujący dla zadanej liczby bajtów korekcji. */
function generator(stopien: number): Uint8Array {
  let wielomian = new Uint8Array([1]);

  for (let i = 0; i < stopien; i++) {
    const nowy = new Uint8Array(wielomian.length + 1);
    for (let j = 0; j < wielomian.length; j++) {
      const wspolczynnik = wielomian[j] ?? 0;
      nowy[j] = (nowy[j] ?? 0) ^ wspolczynnik;
      nowy[j + 1] = (nowy[j + 1] ?? 0) ^ mnoz(wspolczynnik, exp(i));
    }
    wielomian = nowy;
  }
  return wielomian;
}

/** Bajty korekcji dla jednego bloku danych. */
function korekcja(dane: Uint8Array, ileEc: number): Uint8Array {
  const gen = generator(ileEc);
  const reszta = new Uint8Array(dane.length + ileEc);
  reszta.set(dane);

  for (let i = 0; i < dane.length; i++) {
    const czynnik = reszta[i] ?? 0;
    if (czynnik === 0) continue;
    for (let j = 0; j < gen.length; j++) {
      reszta[i + j] = (reszta[i + j] ?? 0) ^ mnoz(gen[j] ?? 0, czynnik);
    }
  }
  return reszta.subarray(dane.length);
}

// ---------------------------------------------------------------------------
// Kodowanie danych
// ---------------------------------------------------------------------------

/** Ile bajtów danych mieści wersja przy korekcji M. */
function pojemnosc(wersja: number): number {
  return parametry(wersja).grupy.reduce((suma, [ile, dlugosc]) => suma + ile * dlugosc, 0);
}

/**
 * Najmniejsza wersja mieszcząca dane.
 *
 * Nagłówek to 4 bity trybu i licznik długości — 8 bitów do wersji 9, 16 od 10.
 */
function dobierzWersje(ileBajtow: number): number {
  for (let wersja = 1; wersja <= MAX_VERSION; wersja++) {
    const naglowek = wersja < 10 ? 12 : 20;
    if (Math.ceil((naglowek + ileBajtow * 8) / 8) <= pojemnosc(wersja)) return wersja;
  }
  throw new Error(`dane nie mieszczą się w kodzie QR: ${ileBajtow} bajtów`);
}

/** Składa strumień danych: nagłówek, treść, terminator i wypełnienie. */
function ulozDane(bajty: Uint8Array, wersja: number): Uint8Array {
  const pojemnoscBajtow = pojemnosc(wersja);
  const bity: number[] = [];
  const dopisz = (wartosc: number, ile: number) => {
    for (let i = ile - 1; i >= 0; i--) bity.push((wartosc >> i) & 1);
  };

  dopisz(0b0100, 4); // tryb bajtowy
  dopisz(bajty.length, wersja < 10 ? 8 : 16);
  for (const bajt of bajty) dopisz(bajt, 8);

  // Terminator — do czterech zer, o ile jest jeszcze miejsce.
  dopisz(0, Math.min(4, pojemnoscBajtow * 8 - bity.length));

  // Wyrównanie do pełnego bajtu.
  while (bity.length % 8 !== 0) bity.push(0);

  const dane = new Uint8Array(pojemnoscBajtow);
  const pelneBajty = bity.length / 8;

  for (let i = 0; i < pelneBajty; i++) {
    let bajt = 0;
    for (let j = 0; j < 8; j++) bajt = (bajt << 1) | (bity[i * 8 + j] ?? 0);
    dane[i] = bajt;
  }

  // Resztę wypełniają na przemian 0xEC i 0x11 — tak stanowi norma.
  for (let i = pelneBajty; i < pojemnoscBajtow; i++) {
    dane[i] = (i - pelneBajty) % 2 === 0 ? 0xec : 0x11;
  }
  return dane;
}

/**
 * Dzieli dane na bloki, dolicza korekcję i przeplata jedno z drugim.
 *
 * Przeplot jest tym, co daje kodowi odporność na uszkodzenia: sąsiadujące
 * moduły należą do różnych bloków, więc plama na wydruku rozkłada się na
 * wszystkie zamiast zniszczyć jeden.
 */
function przeplec(dane: Uint8Array, wersja: number): Uint8Array {
  const { ec, grupy } = parametry(wersja);

  const blokiDanych: Uint8Array[] = [];
  let pozycja = 0;
  for (const [ile, dlugosc] of grupy) {
    for (let i = 0; i < ile; i++) {
      blokiDanych.push(dane.subarray(pozycja, pozycja + dlugosc));
      pozycja += dlugosc;
    }
  }
  const blokiEc = blokiDanych.map((blok) => korekcja(blok, ec));

  const wynik: number[] = [];
  const najdluzszy = Math.max(...blokiDanych.map((b) => b.length));

  for (let i = 0; i < najdluzszy; i++) {
    for (const blok of blokiDanych) {
      if (i < blok.length) wynik.push(blok[i] ?? 0);
    }
  }
  for (let i = 0; i < ec; i++) {
    for (const blok of blokiEc) wynik.push(blok[i] ?? 0);
  }
  return new Uint8Array(wynik);
}

// ---------------------------------------------------------------------------
// Budowa macierzy
// ---------------------------------------------------------------------------

/**
 * Macierz modułów trzymana płasko.
 *
 * `NIEUSTALONY` odróżnia moduł jeszcze niewypełniony od jasnego — bez tego
 * rozróżnienia nie da się wiedzieć, gdzie wolno wpisywać dane.
 */
const NIEUSTALONY = -1;
const JASNY = 0;
const CIEMNY = 1;

interface Macierz {
  bok: number;
  pola: Int8Array;
}

function pusta(bok: number): Macierz {
  return { bok, pola: new Int8Array(bok * bok).fill(NIEUSTALONY) };
}

const pobierz = (m: Macierz, y: number, x: number): number => m.pola[y * m.bok + x] ?? NIEUSTALONY;

const ustaw = (m: Macierz, y: number, x: number, ciemny: boolean): void => {
  m.pola[y * m.bok + x] = ciemny ? CIEMNY : JASNY;
};

function wzoryStale(m: Macierz, wersja: number): void {
  const rozmiar = m.bok;

  // Trzy wzory pozycjonujące wraz z separatorami.
  for (const [wY, wX] of [[0, 0], [0, rozmiar - 7], [rozmiar - 7, 0]] as const) {
    for (let y = -1; y <= 7; y++) {
      for (let x = -1; x <= 7; x++) {
        const py = wY + y;
        const px = wX + x;
        if (py < 0 || py >= rozmiar || px < 0 || px >= rozmiar) continue;

        // Pierścień wokół wzoru to separator i musi być CAŁY jasny.
        // Liczenie go tą samą regułą co wzór zapalało jego naroża.
        if (y < 0 || y > 6 || x < 0 || x > 6) {
          ustaw(m, py, px, false);
          continue;
        }

        const naBrzegu = y === 0 || y === 6 || x === 0 || x === 6;
        const wSrodku = y >= 2 && y <= 4 && x >= 2 && x <= 4;
        ustaw(m, py, px, naBrzegu || wSrodku);
      }
    }
  }

  // Linie taktujące.
  for (let i = 8; i < rozmiar - 8; i++) {
    ustaw(m, 6, i, i % 2 === 0);
    ustaw(m, i, 6, i % 2 === 0);
  }

  // Wzory wyrównania. Pomijamy TYLKO te trzy, które nachodzą na wzory
  // pozycjonujące. Warunek „pole już zajęte" odrzucał też te leżące na linii
  // taktującej — a one są wymagane i mają ją przykryć.
  const srodki = WYROWNANIE[wersja - 1] ?? [];
  const ostatni = rozmiar - 7;
  for (const y of srodki) {
    for (const x of srodki) {
      const naWzorzePozycjonujacym =
        (y === 6 && x === 6) || (y === 6 && x === ostatni) || (y === ostatni && x === 6);
      if (naWzorzePozycjonujacym) continue;

      for (let dy = -2; dy <= 2; dy++) {
        for (let dx = -2; dx <= 2; dx++) {
          ustaw(m, y + dy, x + dx, Math.max(Math.abs(dy), Math.abs(dx)) !== 1);
        }
      }
    }
  }

  // Moduł, który zawsze jest ciemny.
  ustaw(m, rozmiar - 8, 8, true);

  // Informacja o wersji — dopiero od wersji 7.
  if (wersja >= 7) {
    const bity = infoWersji(wersja);
    for (let i = 0; i < 18; i++) {
      const bit = ((bity >> i) & 1) === 1;
      const y = Math.floor(i / 3);
      const x = rozmiar - 11 + (i % 3);
      ustaw(m, y, x, bit);
      ustaw(m, x, y, bit);
    }
  }
}

/** BCH(18,6) dla numeru wersji. */
function infoWersji(wersja: number): number {
  let reszta = wersja << 12;
  for (let i = 0; i < 12; i++) {
    if ((reszta >> (17 - i)) & 1) reszta ^= 0x1f25 << (5 - i);
  }
  return (wersja << 12) | (reszta & 0xfff);
}

/** BCH(15,5) dla poziomu korekcji i maski, z obowiązkową maską 0x5412. */
function infoFormatu(maska: number): number {
  const dane = (0b00 << 3) | maska; // 00 = poziom M
  let reszta = dane << 10;
  for (let i = 0; i < 5; i++) {
    if ((reszta >> (14 - i)) & 1) reszta ^= 0x537 << (4 - i);
  }
  return ((dane << 10) | (reszta & 0x3ff)) ^ 0x5412;
}

function wpiszFormat(m: Macierz, maska: number): void {
  const rozmiar = m.bok;
  const bity = infoFormatu(maska);
  const bit = (i: number) => ((bity >> i) & 1) === 1;

  // Kolejność bitów jest w każdej z dwóch kopii inna i nie da się jej zgadnąć
  // — odwrócona daje kod, który wygląda poprawnie, ale nie niesie czytelnego
  // poziomu korekcji ani maski, więc żaden czytnik go nie odczyta.

  // Kopia pierwsza: wiersz 8 od lewej, potem kolumna 8 od góry.
  for (let x = 0; x <= 5; x++) ustaw(m, 8, x, bit(14 - x));
  ustaw(m, 8, 7, bit(8));
  ustaw(m, 8, 8, bit(7));
  ustaw(m, 7, 8, bit(6));
  for (let y = 0; y <= 5; y++) ustaw(m, y, 8, bit(y));

  // Kopia druga: wiersz 8 od prawej, potem kolumna 8 od dołu.
  for (let j = 0; j <= 7; j++) ustaw(m, 8, rozmiar - 1 - j, bit(j));
  for (let i = 0; i <= 6; i++) ustaw(m, rozmiar - 1 - i, 8, bit(14 - i));
}

/** Osiem masek z normy. */
function maskuj(maska: number, y: number, x: number): boolean {
  switch (maska) {
    case 0: return (y + x) % 2 === 0;
    case 1: return y % 2 === 0;
    case 2: return x % 3 === 0;
    case 3: return (y + x) % 3 === 0;
    case 4: return (Math.floor(y / 2) + Math.floor(x / 3)) % 2 === 0;
    case 5: return ((y * x) % 2) + ((y * x) % 3) === 0;
    case 6: return (((y * x) % 2) + ((y * x) % 3)) % 2 === 0;
    default: return (((y + x) % 2) + ((y * x) % 3)) % 2 === 0;
  }
}

/** Wpisuje dane zygzakiem od prawego dolnego rogu, z nałożoną maską. */
function wpiszDane(m: Macierz, dane: Uint8Array, maska: number): void {
  const rozmiar = m.bok;
  let bit = 0;
  let doGory = true;

  for (let prawa = rozmiar - 1; prawa > 0; prawa -= 2) {
    // Szósta kolumna to linia taktująca — cała kolumna jest przesunięta.
    if (prawa === 6) prawa = 5;

    for (let i = 0; i < rozmiar; i++) {
      const y = doGory ? rozmiar - 1 - i : i;

      for (const x of [prawa, prawa - 1]) {
        if (pobierz(m, y, x) !== NIEUSTALONY) continue;

        const wartosc =
          bit < dane.length * 8 && (((dane[bit >> 3] ?? 0) >> (7 - (bit % 8))) & 1) === 1;
        bit++;

        ustaw(m, y, x, wartosc !== maskuj(maska, y, x));
      }
    }
    doGory = !doGory;
  }
}

/**
 * Kara za wygląd — norma każe wybrać maskę o najniższym wyniku.
 *
 * Chodzi o czytelność dla skanera: układy przypominające wzór pozycjonujący
 * albo duże jednolite plamy mylą go tym bardziej, im większy kod.
 */
function kara(m: boolean[][]): number {
  const rozmiar = m.length;
  const pole = (y: number, x: number): boolean => m[y]?.[x] ?? false;
  let suma = 0;

  // Reguła 1: pasma pięciu i więcej modułów tego samego koloru.
  for (let i = 0; i < rozmiar; i++) {
    for (const poziomo of [true, false]) {
      let dlugosc = 1;
      for (let j = 1; j < rozmiar; j++) {
        const teraz = poziomo ? pole(i, j) : pole(j, i);
        const poprzednio = poziomo ? pole(i, j - 1) : pole(j - 1, i);

        if (teraz === poprzednio) {
          dlugosc++;
        } else {
          if (dlugosc >= 5) suma += 3 + (dlugosc - 5);
          dlugosc = 1;
        }
      }
      if (dlugosc >= 5) suma += 3 + (dlugosc - 5);
    }
  }

  // Reguła 2: jednolite kwadraty 2×2.
  for (let y = 0; y < rozmiar - 1; y++) {
    for (let x = 0; x < rozmiar - 1; x++) {
      const a = pole(y, x);
      if (a === pole(y, x + 1) && a === pole(y + 1, x) && a === pole(y + 1, x + 1)) suma += 3;
    }
  }

  // Reguła 3: układ mylony ze wzorem pozycjonującym.
  const wzory = [
    [true, false, true, true, true, false, true, false, false, false, false],
    [false, false, false, false, true, false, true, true, true, false, true],
  ];
  for (let i = 0; i < rozmiar; i++) {
    for (let j = 0; j <= rozmiar - 11; j++) {
      for (const wzor of wzory) {
        let poziomo = true;
        let pionowo = true;
        for (let k = 0; k < 11; k++) {
          if (pole(i, j + k) !== wzor[k]) poziomo = false;
          if (pole(j + k, i) !== wzor[k]) pionowo = false;
        }
        if (poziomo) suma += 40;
        if (pionowo) suma += 40;
      }
    }
  }

  // Reguła 4: odchylenie od równowagi ciemnych i jasnych modułów.
  const ciemne = m.flat().filter(Boolean).length;
  const procent = (ciemne * 100) / (rozmiar * rozmiar);
  suma += Math.floor(Math.abs(procent - 50) / 5) * 10;

  return suma;
}

/**
 * Buduje macierz kodu QR. `true` znaczy moduł ciemny.
 *
 * Maska wybierana jest tak, jak każe norma: liczymy karę dla wszystkich ośmiu
 * i bierzemy najniższą.
 */
export function qrMatrix(tekst: string): boolean[][] {
  let najlepsza = qrMatrixZMaska(tekst, 0);
  let najnizsza = kara(najlepsza);

  for (let maska = 1; maska < 8; maska++) {
    const gotowa = qrMatrixZMaska(tekst, maska);
    const wynik = kara(gotowa);
    if (wynik < najnizsza) {
      najnizsza = wynik;
      najlepsza = gotowa;
    }
  }

  return najlepsza;
}

/**
 * Kod z narzuconą maską.
 *
 * Wyłącznie dla testów: pozwala porównać wynik z osobną implementacją maska
 * po masce. Bez tego różnica w wyborze maski przykrywa różnicę w danych i nie
 * da się odróżnić jednego od drugiego.
 */
export function qrMatrixZMaska(tekst: string, maska: number): boolean[][] {
  const bajty = new TextEncoder().encode(tekst);
  const wersja = dobierzWersje(bajty.length);
  const dane = przeplec(ulozDane(bajty, wersja), wersja);

  const m = pusta(wersja * 4 + 17);
  wzoryStale(m, wersja);
  wpiszFormat(m, maska);
  wpiszDane(m, dane, maska);

  return Array.from({ length: m.bok }, (_, y) =>
    Array.from({ length: m.bok }, (_, x) => pobierz(m, y, x) === CIEMNY),
  );
}

/**
 * Rysuje kod QR jako ścieżkę SVG.
 *
 * SVG, a nie canvas: skaluje się bez rozmycia, działa przy ostrej regule CSP
 * i nie wymaga odczytu pikseli. Cichy margines czterech modułów jest wymagany
 * przez normę — bez niego wiele czytników nie znajduje kodu.
 */
export function qrSvgPath(tekst: string): { d: string; rozmiar: number } {
  const m = qrMatrix(tekst);
  const MARGINES = 4;
  const rozmiar = m.length + MARGINES * 2;

  let d = "";
  for (let y = 0; y < m.length; y++) {
    const wiersz = m[y] ?? [];
    for (let x = 0; x < wiersz.length; x++) {
      if (wiersz[x]) d += `M${x + MARGINES} ${y + MARGINES}h1v1h-1z`;
    }
  }
  return { d, rozmiar };
}
