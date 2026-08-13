//! Generator kodów QR — ISO/IEC 18004, tryb bajtowy, korekcja L albo M.
//!
//! # Dlaczego to jest tutaj, a nie w kliencie
//!
//! Bo klientów jest dwóch. Kod QR niesie klucz przeniesienia konta i sekret
//! TOTP; druga implementacja po drugiej stronie prędzej czy później rozjechałaby
//! się z pierwszą, a rozjazd objawiłby się kodem, którego nie da się zeskanować
//! — czyli u użytkownika stojącego z dwoma telefonami, nie w testach.
//!
//! Tak samo trzymamy tu kodowanie kopert i szyfrowanie załączników.
//!
//! # Skąd ten kod
//!
//! Przeniesiony z `web/src/lib/qr.ts`, gdzie powstał pierwszy i został
//! sprawdzony modułem po module wobec osobnego generatora. Testy tutaj
//! porównują wynik z macierzami wygenerowanymi tamtą, zweryfikowaną
//! implementacją — port ma dawać **dokładnie to samo**, a nie „coś, co też się
//! skanuje".
//!
//! # Zakres
//!
//! Wersje 1–40, poziom korekcji L albo M. Przepełnienie jest **błędem**,
//! a nie cichym przejściem na słabszą korekcję: kod pokazywany z ekranu przed
//! aparatem musi znieść odbicia i krzywe ujęcie, więc o poziomie decyduje
//! wołający świadomie, a nie generator pod naciskiem danych.
//!
//! Do wersji 10 przy korekcji M było tu przez długi czas — 216 bajtów wystarcza
//! na klucz przeniesienia i sekret TOTP. Transfer optyczny historii potrzebuje
//! czegoś zupełnie innego: przy 40-L mieści się **2953 bajty na ramkę**, czyli
//! blisko czternaście razy więcej. Przy dziesięciu klatkach na sekundę to
//! różnica między dziewięcioma sekundami a dwiema minutami trzymania telefonu
//! nad ekranem.
//!
//! Poprawność wszystkich 80 kombinacji wersja × poziom sprawdza test wobec
//! niezależnej biblioteki `qrcode` — tablice bloków mają 80 wierszy
//! przepisanych z normy, a literówka w którymkolwiek daje kod, który zwykle
//! nadal się skanuje, bo korekcja błędów naprawia go w locie.

use crate::error::{Error, Result};

/// Największa obsługiwana wersja.
const MAX_VERSION: usize = 40;

/// Bajty korekcji na blok oraz podział na grupy.
///
/// Grupy różnią się liczbą bajtów danych: przy niektórych wersjach dane nie
/// dzielą się równo, więc część bloków jest o jeden bajt dłuższa.
struct Bloki {
    ec: usize,
    grupy: &'static [(usize, usize)],
}

/// Poziom korekcji błędów.
///
/// Dwa poziomy, nie cztery. `M` obowiązuje kody pokazywane z ekranu przed
/// aparatem: muszą znieść odbicia i krzywe ujęcie. `L` istnieje wyłącznie dla
/// transferu optycznego, gdzie o poprawność dba warstwa wyżej — kody fountain
/// w `optyka.rs` odtwarzają całość z dowolnego podzbioru ramek, więc gubiona
/// ramka kosztuje ułamek sekundy, a każdy bajt korekcji zabrany danym
/// spowalnia transfer na stałe.
///
/// Q i H nie mają tu zastosowania i nie ma po co utrzymywać ich tablic.
#[derive(Clone, Copy, PartialEq, Eq, Debug)]
pub enum Korekcja {
    /// Około 7% odzysku — najwięcej danych na ramkę.
    L,
    /// Około 15% odzysku — domyślny dla kodów statycznych.
    M,
}

impl Korekcja {
    /// Bity poziomu w informacji o formacie.
    ///
    /// Kolejność jest z normy i **nie** jest naturalna: L to 01, M to 00.
    /// Zamiana miejscami daje kod, który wygląda poprawnie i nie skanuje się
    /// wcale, bo dekoder próbuje odczytać go inną korekcją.
    fn bity(self) -> u32 {
        match self {
            Korekcja::L => 0b01,
            Korekcja::M => 0b00,
        }
    }

    fn tablica(self) -> &'static [Bloki; MAX_VERSION] {
        match self {
            Korekcja::L => &BLOKI_L,
            Korekcja::M => &BLOKI_M,
        }
    }
}

/// Bloki i korekcja przy poziomie L, dla wersji 1–40.
const BLOKI_L: [Bloki; MAX_VERSION] = [
    Bloki {
        ec: 7,
        grupy: &[(1, 19)],
    },
    Bloki {
        ec: 10,
        grupy: &[(1, 34)],
    },
    Bloki {
        ec: 15,
        grupy: &[(1, 55)],
    },
    Bloki {
        ec: 20,
        grupy: &[(1, 80)],
    },
    Bloki {
        ec: 26,
        grupy: &[(1, 108)],
    },
    Bloki {
        ec: 18,
        grupy: &[(2, 68)],
    },
    Bloki {
        ec: 20,
        grupy: &[(2, 78)],
    },
    Bloki {
        ec: 24,
        grupy: &[(2, 97)],
    },
    Bloki {
        ec: 30,
        grupy: &[(2, 116)],
    },
    Bloki {
        ec: 18,
        grupy: &[(2, 68), (2, 69)],
    },
    Bloki {
        ec: 20,
        grupy: &[(4, 81)],
    },
    Bloki {
        ec: 24,
        grupy: &[(2, 92), (2, 93)],
    },
    Bloki {
        ec: 26,
        grupy: &[(4, 107)],
    },
    Bloki {
        ec: 30,
        grupy: &[(3, 115), (1, 116)],
    },
    Bloki {
        ec: 22,
        grupy: &[(5, 87), (1, 88)],
    },
    Bloki {
        ec: 24,
        grupy: &[(5, 98), (1, 99)],
    },
    Bloki {
        ec: 28,
        grupy: &[(1, 107), (5, 108)],
    },
    Bloki {
        ec: 30,
        grupy: &[(5, 120), (1, 121)],
    },
    Bloki {
        ec: 28,
        grupy: &[(3, 113), (4, 114)],
    },
    Bloki {
        ec: 28,
        grupy: &[(3, 107), (5, 108)],
    },
    Bloki {
        ec: 28,
        grupy: &[(4, 116), (4, 117)],
    },
    Bloki {
        ec: 28,
        grupy: &[(2, 111), (7, 112)],
    },
    Bloki {
        ec: 30,
        grupy: &[(4, 121), (5, 122)],
    },
    Bloki {
        ec: 30,
        grupy: &[(6, 117), (4, 118)],
    },
    Bloki {
        ec: 26,
        grupy: &[(8, 106), (4, 107)],
    },
    Bloki {
        ec: 28,
        grupy: &[(10, 114), (2, 115)],
    },
    Bloki {
        ec: 30,
        grupy: &[(8, 122), (4, 123)],
    },
    Bloki {
        ec: 30,
        grupy: &[(3, 117), (10, 118)],
    },
    Bloki {
        ec: 30,
        grupy: &[(7, 116), (7, 117)],
    },
    Bloki {
        ec: 30,
        grupy: &[(5, 115), (10, 116)],
    },
    Bloki {
        ec: 30,
        grupy: &[(13, 115), (3, 116)],
    },
    Bloki {
        ec: 30,
        grupy: &[(17, 115)],
    },
    Bloki {
        ec: 30,
        grupy: &[(17, 115), (1, 116)],
    },
    Bloki {
        ec: 30,
        grupy: &[(13, 115), (6, 116)],
    },
    Bloki {
        ec: 30,
        grupy: &[(12, 121), (7, 122)],
    },
    Bloki {
        ec: 30,
        grupy: &[(6, 121), (14, 122)],
    },
    Bloki {
        ec: 30,
        grupy: &[(17, 122), (4, 123)],
    },
    Bloki {
        ec: 30,
        grupy: &[(4, 122), (18, 123)],
    },
    Bloki {
        ec: 30,
        grupy: &[(20, 117), (4, 118)],
    },
    Bloki {
        ec: 30,
        grupy: &[(19, 118), (6, 119)],
    },
];

/// Bloki i korekcja przy poziomie M, dla wersji 1–40.
const BLOKI_M: [Bloki; MAX_VERSION] = [
    Bloki {
        ec: 10,
        grupy: &[(1, 16)],
    },
    Bloki {
        ec: 16,
        grupy: &[(1, 28)],
    },
    Bloki {
        ec: 26,
        grupy: &[(1, 44)],
    },
    Bloki {
        ec: 18,
        grupy: &[(2, 32)],
    },
    Bloki {
        ec: 24,
        grupy: &[(2, 43)],
    },
    Bloki {
        ec: 16,
        grupy: &[(4, 27)],
    },
    Bloki {
        ec: 18,
        grupy: &[(4, 31)],
    },
    Bloki {
        ec: 22,
        grupy: &[(2, 38), (2, 39)],
    },
    Bloki {
        ec: 22,
        grupy: &[(3, 36), (2, 37)],
    },
    Bloki {
        ec: 26,
        grupy: &[(4, 43), (1, 44)],
    },
    Bloki {
        ec: 30,
        grupy: &[(1, 50), (4, 51)],
    },
    Bloki {
        ec: 22,
        grupy: &[(6, 36), (2, 37)],
    },
    Bloki {
        ec: 22,
        grupy: &[(8, 37), (1, 38)],
    },
    Bloki {
        ec: 24,
        grupy: &[(4, 40), (5, 41)],
    },
    Bloki {
        ec: 24,
        grupy: &[(5, 41), (5, 42)],
    },
    Bloki {
        ec: 28,
        grupy: &[(7, 45), (3, 46)],
    },
    Bloki {
        ec: 28,
        grupy: &[(10, 46), (1, 47)],
    },
    Bloki {
        ec: 26,
        grupy: &[(9, 43), (4, 44)],
    },
    Bloki {
        ec: 26,
        grupy: &[(3, 44), (11, 45)],
    },
    Bloki {
        ec: 26,
        grupy: &[(3, 41), (13, 42)],
    },
    Bloki {
        ec: 26,
        grupy: &[(17, 42)],
    },
    Bloki {
        ec: 28,
        grupy: &[(17, 46)],
    },
    Bloki {
        ec: 28,
        grupy: &[(4, 47), (14, 48)],
    },
    Bloki {
        ec: 28,
        grupy: &[(6, 45), (14, 46)],
    },
    Bloki {
        ec: 28,
        grupy: &[(8, 47), (13, 48)],
    },
    Bloki {
        ec: 28,
        grupy: &[(19, 46), (4, 47)],
    },
    Bloki {
        ec: 28,
        grupy: &[(22, 45), (3, 46)],
    },
    Bloki {
        ec: 28,
        grupy: &[(3, 45), (23, 46)],
    },
    Bloki {
        ec: 28,
        grupy: &[(21, 45), (7, 46)],
    },
    Bloki {
        ec: 28,
        grupy: &[(19, 47), (10, 48)],
    },
    Bloki {
        ec: 28,
        grupy: &[(2, 46), (29, 47)],
    },
    Bloki {
        ec: 28,
        grupy: &[(10, 46), (23, 47)],
    },
    Bloki {
        ec: 28,
        grupy: &[(14, 46), (21, 47)],
    },
    Bloki {
        ec: 28,
        grupy: &[(14, 46), (23, 47)],
    },
    Bloki {
        ec: 28,
        grupy: &[(12, 47), (26, 48)],
    },
    Bloki {
        ec: 28,
        grupy: &[(6, 47), (34, 48)],
    },
    Bloki {
        ec: 28,
        grupy: &[(29, 46), (14, 47)],
    },
    Bloki {
        ec: 28,
        grupy: &[(13, 46), (32, 47)],
    },
    Bloki {
        ec: 28,
        grupy: &[(40, 47), (7, 48)],
    },
    Bloki {
        ec: 28,
        grupy: &[(18, 47), (31, 48)],
    },
];

/// Środki wzorów wyrównania. Wersja 1 ich nie ma.
const WYROWNANIE: [&[usize]; MAX_VERSION] = [
    &[],
    &[6, 18],
    &[6, 22],
    &[6, 26],
    &[6, 30],
    &[6, 34],
    &[6, 22, 38],
    &[6, 24, 42],
    &[6, 26, 46],
    &[6, 28, 50],
    &[6, 30, 54],
    &[6, 32, 58],
    &[6, 34, 62],
    &[6, 26, 46, 66],
    &[6, 26, 48, 70],
    &[6, 26, 50, 74],
    &[6, 30, 54, 78],
    &[6, 30, 56, 82],
    &[6, 30, 58, 86],
    &[6, 34, 62, 90],
    &[6, 28, 50, 72, 94],
    &[6, 26, 50, 74, 98],
    &[6, 30, 54, 78, 102],
    &[6, 28, 54, 80, 106],
    &[6, 32, 58, 84, 110],
    &[6, 30, 58, 86, 114],
    &[6, 34, 62, 90, 118],
    &[6, 26, 50, 74, 98, 122],
    &[6, 30, 54, 78, 102, 126],
    &[6, 26, 52, 78, 104, 130],
    &[6, 30, 56, 82, 108, 134],
    &[6, 34, 60, 86, 112, 138],
    &[6, 30, 58, 86, 114, 142],
    &[6, 34, 62, 90, 118, 146],
    &[6, 30, 54, 78, 102, 126, 150],
    &[6, 24, 50, 76, 102, 128, 154],
    &[6, 28, 54, 80, 106, 132, 158],
    &[6, 32, 58, 84, 110, 136, 162],
    &[6, 26, 54, 82, 110, 138, 166],
    &[6, 30, 58, 86, 114, 142, 170],
];

// ---------------------------------------------------------------------------
// Arytmetyka GF(256) — potrzebna do kodu Reeda-Solomona
// ---------------------------------------------------------------------------

/// Tablice potęg i logarytmów w GF(256).
///
/// Liczone raz przy pierwszym użyciu. Wielomian pierwotny 0x11d, standardowy
/// dla kodów QR.
struct Galois {
    exp: [u8; 512],
    log: [u8; 256],
}

impl Galois {
    fn new() -> Self {
        let mut exp = [0u8; 512];
        let mut log = [0u8; 256];

        let mut x: u16 = 1;
        for (i, wpis) in exp.iter_mut().enumerate().take(255) {
            *wpis = x as u8;
            log[x as usize] = i as u8;
            x <<= 1;
            if x & 0x100 != 0 {
                x ^= 0x11d;
            }
        }
        for i in 255..512 {
            exp[i] = exp[i - 255];
        }

        Self { exp, log }
    }

    fn mnoz(&self, a: u8, b: u8) -> u8 {
        if a == 0 || b == 0 {
            return 0;
        }
        self.exp[self.log[a as usize] as usize + self.log[b as usize] as usize]
    }

    /// Wielomian generujący dla zadanej liczby bajtów korekcji.
    fn generator(&self, stopien: usize) -> Vec<u8> {
        let mut wielomian = vec![1u8];

        for i in 0..stopien {
            let mut nowy = vec![0u8; wielomian.len() + 1];
            for (j, &wspolczynnik) in wielomian.iter().enumerate() {
                nowy[j] ^= wspolczynnik;
                nowy[j + 1] ^= self.mnoz(wspolczynnik, self.exp[i]);
            }
            wielomian = nowy;
        }
        wielomian
    }

    /// Bajty korekcji dla jednego bloku danych.
    fn korekcja(&self, dane: &[u8], ile_ec: usize) -> Vec<u8> {
        let wielomian = self.generator(ile_ec);
        let mut reszta = vec![0u8; dane.len() + ile_ec];
        reszta[..dane.len()].copy_from_slice(dane);

        for i in 0..dane.len() {
            let czynnik = reszta[i];
            if czynnik == 0 {
                continue;
            }
            for (j, &g) in wielomian.iter().enumerate() {
                reszta[i + j] ^= self.mnoz(g, czynnik);
            }
        }

        reszta[dane.len()..].to_vec()
    }
}

// ---------------------------------------------------------------------------
// Kodowanie danych
// ---------------------------------------------------------------------------

/// Ile bajtów danych mieści wersja przy danym poziomie korekcji.
fn pojemnosc(wersja: usize, korekcja: Korekcja) -> usize {
    korekcja.tablica()[wersja - 1]
        .grupy
        .iter()
        .map(|(ile, dlugosc)| ile * dlugosc)
        .sum()
}

/// Ile bajtów mieści konkretna wersja przy danym poziomie korekcji.
///
/// Nagłówek to 4 bity trybu i licznik długości — 8 bitów do wersji 9, 16 od 10.
fn maks_bajtow_wersji(wersja: usize, korekcja: Korekcja) -> usize {
    let naglowek = if wersja < 10 { 12 } else { 20 };
    (pojemnosc(wersja, korekcja) * 8 - naglowek) / 8
}

/// Ile bajtów zmieści największy kod QR przy danym poziomie korekcji.
///
/// Liczone z tablic, nie wpisane ręcznie: wpisana liczba rozjechałaby się
/// z tablicą przy pierwszej pomyłce, a objawem byłby kod odrzucony dopiero
/// u użytkownika. Nadajnik optyczny dobiera po tym rozmiar bloku.
pub fn maks_bajtow(korekcja: Korekcja) -> usize {
    maks_bajtow_wersji(MAX_VERSION, korekcja)
}

/// Najmniejsza wersja mieszcząca dane.
///
/// Nagłówek to 4 bity trybu i licznik długości — 8 bitów do wersji 9, 16 od 10.
fn dobierz_wersje(ile_bajtow: usize, korekcja: Korekcja) -> Result<usize> {
    for wersja in 1..=MAX_VERSION {
        let naglowek = if wersja < 10 { 12 } else { 20 };
        if (naglowek + ile_bajtow * 8).div_ceil(8) <= pojemnosc(wersja, korekcja) {
            return Ok(wersja);
        }
    }
    Err(Error::InvalidInput(format!(
        "dane nie mieszczą się w kodzie QR: {ile_bajtow} bajtów"
    )))
}

/// Składa strumień danych: nagłówek, treść, terminator i wypełnienie.
fn uloz_dane(bajty: &[u8], wersja: usize, korekcja: Korekcja) -> Vec<u8> {
    let pojemnosc_bajtow = pojemnosc(wersja, korekcja);
    let mut bity: Vec<u8> = Vec::with_capacity(pojemnosc_bajtow * 8);

    let dopisz = |bity: &mut Vec<u8>, wartosc: u32, ile: u32| {
        for i in (0..ile).rev() {
            bity.push(((wartosc >> i) & 1) as u8);
        }
    };

    dopisz(&mut bity, 0b0100, 4); // tryb bajtowy
    dopisz(
        &mut bity,
        bajty.len() as u32,
        if wersja < 10 { 8 } else { 16 },
    );
    for &bajt in bajty {
        dopisz(&mut bity, bajt as u32, 8);
    }

    // Terminator — do czterech zer, o ile jest jeszcze miejsce.
    let wolne = pojemnosc_bajtow * 8 - bity.len();
    dopisz(&mut bity, 0, wolne.min(4) as u32);

    // Wyrównanie do pełnego bajtu.
    while bity.len() % 8 != 0 {
        bity.push(0);
    }

    let pelne_bajty = bity.len() / 8;
    let mut dane = vec![0u8; pojemnosc_bajtow];

    for i in 0..pelne_bajty {
        let mut bajt = 0u8;
        for j in 0..8 {
            bajt = (bajt << 1) | bity[i * 8 + j];
        }
        dane[i] = bajt;
    }

    // Resztę wypełniają na przemian 0xEC i 0x11 — tak stanowi norma.
    for (i, bajt) in dane.iter_mut().enumerate().skip(pelne_bajty) {
        *bajt = if (i - pelne_bajty) % 2 == 0 {
            0xec
        } else {
            0x11
        };
    }
    dane
}

/// Dzieli dane na bloki, dolicza korekcję i przeplata jedno z drugim.
///
/// Przeplot daje kodowi odporność na uszkodzenia: sąsiadujące moduły należą do
/// różnych bloków, więc plama rozkłada się na wszystkie zamiast zniszczyć jeden.
fn przeplec(gf: &Galois, dane: &[u8], wersja: usize, korekcja: Korekcja) -> Vec<u8> {
    let Bloki { ec, grupy } = &korekcja.tablica()[wersja - 1];

    let mut bloki_danych: Vec<&[u8]> = Vec::new();
    let mut pozycja = 0;
    for &(ile, dlugosc) in *grupy {
        for _ in 0..ile {
            bloki_danych.push(&dane[pozycja..pozycja + dlugosc]);
            pozycja += dlugosc;
        }
    }

    let bloki_ec: Vec<Vec<u8>> = bloki_danych.iter().map(|b| gf.korekcja(b, *ec)).collect();

    let najdluzszy = bloki_danych.iter().map(|b| b.len()).max().unwrap_or(0);
    let mut wynik = Vec::new();

    for i in 0..najdluzszy {
        for blok in &bloki_danych {
            if i < blok.len() {
                wynik.push(blok[i]);
            }
        }
    }
    for i in 0..*ec {
        for blok in &bloki_ec {
            wynik.push(blok[i]);
        }
    }
    wynik
}

// ---------------------------------------------------------------------------
// Budowa macierzy
// ---------------------------------------------------------------------------

/// Moduł jeszcze nieustalony — odróżniany od jasnego, bo tylko w takie wolno
/// wpisywać dane.
const NIEUSTALONY: i8 = -1;
const JASNY: i8 = 0;
const CIEMNY: i8 = 1;

struct Macierz {
    bok: usize,
    pola: Vec<i8>,
}

impl Macierz {
    fn nowa(bok: usize) -> Self {
        Self {
            bok,
            pola: vec![NIEUSTALONY; bok * bok],
        }
    }

    fn pobierz(&self, y: usize, x: usize) -> i8 {
        self.pola[y * self.bok + x]
    }

    fn ustaw(&mut self, y: usize, x: usize, ciemny: bool) {
        self.pola[y * self.bok + x] = if ciemny { CIEMNY } else { JASNY };
    }
}

/// BCH(18,6) dla numeru wersji.
///
/// Sześć iteracji, nie dwanaście: dzielimy wartość 18-bitową przez generator
/// stopnia 12, więc tyle właśnie trwa dzielenie. Wersja w TypeScripcie robiła
/// dwanaście obrotów i przy ostatnich sześciu liczyła ujemne przesunięcie —
/// JavaScript zawija je po cichu, Rust zgłasza przepełnienie. Wynik jest ten
/// sam, bo warunek i tak przestawał się spełniać; nadmiarowe obroty były
/// martwe.
fn info_wersji(wersja: usize) -> u32 {
    let mut reszta = (wersja as u32) << 12;
    for i in 0..6 {
        if (reszta >> (17 - i)) & 1 != 0 {
            reszta ^= 0x1f25 << (5 - i);
        }
    }
    ((wersja as u32) << 12) | (reszta & 0xfff)
}

/// BCH(15,5) dla poziomu korekcji i maski, z obowiązkową maską 0x5412.
fn info_formatu(maska: u8, korekcja: Korekcja) -> u32 {
    let dane = (korekcja.bity() << 3) | maska as u32;
    let mut reszta = dane << 10;
    for i in 0..5 {
        if (reszta >> (14 - i)) & 1 != 0 {
            reszta ^= 0x537 << (4 - i);
        }
    }
    ((dane << 10) | (reszta & 0x3ff)) ^ 0x5412
}

fn wzory_stale(m: &mut Macierz, wersja: usize) {
    let rozmiar = m.bok;

    // Trzy wzory pozycjonujące wraz z separatorami.
    for (w_y, w_x) in [
        (0isize, 0isize),
        (0, rozmiar as isize - 7),
        (rozmiar as isize - 7, 0),
    ] {
        for y in -1isize..=7 {
            for x in -1isize..=7 {
                let py = w_y + y;
                let px = w_x + x;
                if py < 0 || py >= rozmiar as isize || px < 0 || px >= rozmiar as isize {
                    continue;
                }

                // Pierścień wokół wzoru to separator i musi być CAŁY jasny.
                if !(0..=6).contains(&y) || !(0..=6).contains(&x) {
                    m.ustaw(py as usize, px as usize, false);
                    continue;
                }

                let na_brzegu = y == 0 || y == 6 || x == 0 || x == 6;
                let w_srodku = (2..=4).contains(&y) && (2..=4).contains(&x);
                m.ustaw(py as usize, px as usize, na_brzegu || w_srodku);
            }
        }
    }

    // Linie taktujące.
    for i in 8..rozmiar - 8 {
        m.ustaw(6, i, i % 2 == 0);
        m.ustaw(i, 6, i % 2 == 0);
    }

    // Wzory wyrównania. Pomijamy TYLKO te trzy, które nachodzą na wzory
    // pozycjonujące — te leżące na linii taktującej są wymagane i mają ją
    // przykryć.
    let srodki = WYROWNANIE[wersja - 1];
    let ostatni = rozmiar - 7;
    for &y in srodki {
        for &x in srodki {
            let na_wzorze = (y == 6 && (x == 6 || x == ostatni)) || (y == ostatni && x == 6);
            if na_wzorze {
                continue;
            }
            for dy in -2isize..=2 {
                for dx in -2isize..=2 {
                    m.ustaw(
                        (y as isize + dy) as usize,
                        (x as isize + dx) as usize,
                        dy.abs().max(dx.abs()) != 1,
                    );
                }
            }
        }
    }

    // Moduł, który zawsze jest ciemny.
    m.ustaw(rozmiar - 8, 8, true);

    // Informacja o wersji — dopiero od wersji 7.
    if wersja >= 7 {
        let bity = info_wersji(wersja);
        for i in 0..18 {
            let bit = (bity >> i) & 1 == 1;
            let y = i / 3;
            let x = rozmiar - 11 + (i % 3);
            m.ustaw(y, x, bit);
            m.ustaw(x, y, bit);
        }
    }
}

fn wpisz_format(m: &mut Macierz, maska: u8, korekcja: Korekcja) {
    let rozmiar = m.bok;
    let bity = info_formatu(maska, korekcja);
    let bit = |i: u32| (bity >> i) & 1 == 1;

    // Kolejność bitów jest w każdej z dwóch kopii inna i nie da się jej zgadnąć
    // — odwrócona daje kod, który wygląda poprawnie, ale nie niesie czytelnego
    // poziomu korekcji ani maski.
    for x in 0..=5u32 {
        m.ustaw(8, x as usize, bit(14 - x));
    }
    m.ustaw(8, 7, bit(8));
    m.ustaw(8, 8, bit(7));
    m.ustaw(7, 8, bit(6));
    for y in 0..=5u32 {
        m.ustaw(y as usize, 8, bit(y));
    }

    for j in 0..=7u32 {
        m.ustaw(8, rozmiar - 1 - j as usize, bit(j));
    }
    for i in 0..=6u32 {
        m.ustaw(rozmiar - 1 - i as usize, 8, bit(14 - i));
    }
}

/// Osiem masek z normy.
fn maskuj(maska: u8, y: usize, x: usize) -> bool {
    match maska {
        0 => (y + x) % 2 == 0,
        1 => y % 2 == 0,
        2 => x % 3 == 0,
        3 => (y + x) % 3 == 0,
        4 => (y / 2 + x / 3) % 2 == 0,
        5 => (y * x) % 2 + (y * x) % 3 == 0,
        6 => ((y * x) % 2 + (y * x) % 3) % 2 == 0,
        _ => ((y + x) % 2 + (y * x) % 3) % 2 == 0,
    }
}

/// Wpisuje dane zygzakiem od prawego dolnego rogu, z nałożoną maską.
fn wpisz_dane(m: &mut Macierz, dane: &[u8], maska: u8) {
    let rozmiar = m.bok;
    let mut bit = 0usize;
    let mut do_gory = true;

    let mut prawa = rozmiar - 1;
    loop {
        // Szósta kolumna to linia taktująca — cała kolumna jest przesunięta.
        if prawa == 6 {
            prawa = 5;
        }

        for i in 0..rozmiar {
            let y = if do_gory { rozmiar - 1 - i } else { i };

            for x in [prawa, prawa - 1] {
                if m.pobierz(y, x) != NIEUSTALONY {
                    continue;
                }

                let wartosc = bit < dane.len() * 8 && (dane[bit >> 3] >> (7 - (bit % 8))) & 1 == 1;
                bit += 1;

                m.ustaw(y, x, wartosc != maskuj(maska, y, x));
            }
        }
        do_gory = !do_gory;

        if prawa < 2 {
            break;
        }
        prawa -= 2;
    }
}

/// Kara za wygląd — norma każe wybrać maskę o najniższym wyniku.
fn kara(m: &[Vec<bool>]) -> u32 {
    let rozmiar = m.len();
    let pole = |y: usize, x: usize| m[y][x];
    let mut suma = 0u32;

    // Reguła 1: pasma pięciu i więcej modułów tego samego koloru.
    for i in 0..rozmiar {
        for poziomo in [true, false] {
            let mut dlugosc = 1u32;
            for j in 1..rozmiar {
                let teraz = if poziomo { pole(i, j) } else { pole(j, i) };
                let poprzednio = if poziomo {
                    pole(i, j - 1)
                } else {
                    pole(j - 1, i)
                };

                if teraz == poprzednio {
                    dlugosc += 1;
                } else {
                    if dlugosc >= 5 {
                        suma += 3 + (dlugosc - 5);
                    }
                    dlugosc = 1;
                }
            }
            if dlugosc >= 5 {
                suma += 3 + (dlugosc - 5);
            }
        }
    }

    // Reguła 2: jednolite kwadraty 2×2.
    for y in 0..rozmiar - 1 {
        for x in 0..rozmiar - 1 {
            let a = pole(y, x);
            if a == pole(y, x + 1) && a == pole(y + 1, x) && a == pole(y + 1, x + 1) {
                suma += 3;
            }
        }
    }

    // Reguła 3: układ mylony ze wzorem pozycjonującym.
    const WZORY: [[bool; 11]; 2] = [
        [
            true, false, true, true, true, false, true, false, false, false, false,
        ],
        [
            false, false, false, false, true, false, true, true, true, false, true,
        ],
    ];
    for i in 0..rozmiar {
        for j in 0..=rozmiar - 11 {
            for wzor in WZORY {
                let poziomo = (0..11).all(|k| pole(i, j + k) == wzor[k]);
                let pionowo = (0..11).all(|k| pole(j + k, i) == wzor[k]);
                if poziomo {
                    suma += 40;
                }
                if pionowo {
                    suma += 40;
                }
            }
        }
    }

    // Reguła 4: odchylenie od równowagi ciemnych i jasnych modułów.
    let ciemne = m.iter().flatten().filter(|&&c| c).count();
    let procent = (ciemne * 100) as f64 / (rozmiar * rozmiar) as f64;
    suma += ((procent - 50.0).abs() / 5.0).floor() as u32 * 10;

    suma
}

/// Kod z narzuconą maską — wyłącznie do porównań w testach.
fn macierz_z_maska(
    gf: &Galois,
    bajty: &[u8],
    maska: u8,
    korekcja: Korekcja,
) -> Result<Vec<Vec<bool>>> {
    let wersja = dobierz_wersje(bajty.len(), korekcja)?;
    let dane = przeplec(gf, &uloz_dane(bajty, wersja, korekcja), wersja, korekcja);

    let mut m = Macierz::nowa(wersja * 4 + 17);
    wzory_stale(&mut m, wersja);
    wpisz_format(&mut m, maska, korekcja);
    wpisz_dane(&mut m, &dane, maska);

    Ok((0..m.bok)
        .map(|y| (0..m.bok).map(|x| m.pobierz(y, x) == CIEMNY).collect())
        .collect())
}

/// Buduje macierz kodu QR z dowolnych bajtów. `true` znaczy moduł ciemny.
///
/// Maska wybierana jest tak, jak każe norma: liczymy karę dla wszystkich ośmiu
/// i bierzemy najniższą.
///
/// # Dlaczego bajty, a nie tekst
///
/// Tryb bajtowy koduje bajty — wymaganie `&str` było ograniczeniem API, nie
/// formatu. Ramka transferu optycznego jest binarna, więc przepuszczenie jej
/// przez base64 kosztowałoby **jedną trzecią przepustowości** za nic.
pub fn qr_matrix_bajty(bajty: &[u8], korekcja: Korekcja) -> Result<Vec<Vec<bool>>> {
    let gf = Galois::new();

    let mut najlepsza = macierz_z_maska(&gf, bajty, 0, korekcja)?;
    let mut najnizsza = kara(&najlepsza);

    for maska in 1..8u8 {
        let gotowa = macierz_z_maska(&gf, bajty, maska, korekcja)?;
        let wynik = kara(&gotowa);
        if wynik < najnizsza {
            najnizsza = wynik;
            najlepsza = gotowa;
        }
    }

    Ok(najlepsza)
}

/// Buduje macierz kodu QR z tekstu, przy korekcji M.
///
/// Poziom jest tu zaszyty celowo: kod pokazywany z ekranu przed aparatem musi
/// znieść odbicia i krzywe ujęcie, a wołający nie ma powodu o tym decydować.
/// Słabszą korekcję wybiera się świadomie, przez [`qr_matrix_bajty`].
pub fn qr_matrix(tekst: &str) -> Result<Vec<Vec<bool>>> {
    qr_matrix_bajty(tekst.as_bytes(), Korekcja::M)
}

#[cfg(test)]
mod tests {
    use super::*;

    /// Wzorce z zweryfikowanej implementacji w TypeScripcie.
    ///
    /// Format wiersza: treść szesnastkowo, maska, bok, moduły jako ciąg 0/1.
    /// Szesnastkowo, a nie jako napis w cudzysłowach — inaczej odczyt wzorców
    /// wymagałby parsera JSON, czyli zależności dołożonej wyłącznie dla testu.
    const WZORCE: &str = include_str!("../testy/qr-wzorce.tsv");

    /// Sedno portu: ma dawać **dokładnie to samo**, co implementacja, która
    /// została sprawdzona modułem po module wobec osobnego generatora.
    /// „Też się skanuje" nie wystarcza — korekcja błędów przepuszcza kody
    /// z realnymi usterkami konstrukcyjnymi.
    #[test]
    fn zgadza_sie_z_implementacja_webowa() {
        let gf = Galois::new();
        let mut sprawdzonych = 0;

        for wiersz in WZORCE.lines().filter(|w| !w.trim().is_empty()) {
            let czesci: Vec<&str> = wiersz.split('\t').collect();
            assert_eq!(czesci.len(), 4, "zły format wzorca");

            let bajty: Vec<u8> = (0..czesci[0].len())
                .step_by(2)
                .map(|i| u8::from_str_radix(&czesci[0][i..i + 2], 16).expect("wzorzec"))
                .collect();
            let tekst = String::from_utf8(bajty).expect("wzorzec nie jest tekstem UTF-8");
            let maska: u8 = czesci[1].parse().unwrap();
            let bok: usize = czesci[2].parse().unwrap();
            let oczekiwane = czesci[3];

            let nasza = macierz_z_maska(&gf, tekst.as_bytes(), maska, Korekcja::M).unwrap();
            assert_eq!(nasza.len(), bok, "inny rozmiar dla „{tekst}” maska {maska}");

            let plaska: String = nasza
                .iter()
                .flatten()
                .map(|&c| if c { '1' } else { '0' })
                .collect();

            assert_eq!(plaska, oczekiwane, "różnica dla „{tekst}” maska {maska}");
            sprawdzonych += 1;
        }

        assert!(
            sprawdzonych >= 40,
            "wczytano za mało wzorców: {sprawdzonych}"
        );
    }

    /// Sumy kontrolne macierzy dla wszystkich 40 wersji i obu poziomów.
    ///
    /// Format: wersja, poziom, maska, ziarno, bok, SHA-256 modułów.
    const SUMY: &str = include_str!("../testy/qr-sumy.tsv");

    /// Pełne macierze dla wersji 1 i 10 — przy niezgodnej sumie jest po czym
    /// zobaczyć, **co** się rozjechało.
    ///
    /// Format: ziarno, maska, poziom, bok, moduły jako ciąg 0/1.
    const DUZE: &str = include_str!("../testy/qr-wzorce-duze.tsv");

    /// Generator danych testowych — ten sam co w skrypcie, który wytworzył
    /// wzorce. Rozjazd wywala wszystkie 80 naraz, więc nie da się go przeoczyć.
    fn tresc(ile: usize, ziarno: u32) -> Vec<u8> {
        let mut x = ziarno;
        (0..ile)
            .map(|_| {
                x = x.wrapping_mul(1664525).wrapping_add(1013904223);
                (x >> 24) as u8
            })
            .collect()
    }

    fn poziom(nazwa: &str) -> Korekcja {
        match nazwa {
            "L" => Korekcja::L,
            "M" => Korekcja::M,
            inne => panic!("nieznany poziom korekcji: {inne}"),
        }
    }

    fn plasko(m: &[Vec<bool>]) -> String {
        m.iter()
            .flatten()
            .map(|&c| if c { '1' } else { '0' })
            .collect()
    }

    /// Wszystkie 80 kombinacji wersja × poziom, wobec **niezależnej**
    /// implementacji (biblioteka `qrcode` z npm).
    ///
    /// Tablice bloków mają 80 wierszy przepisanych z ISO/IEC 18004. Literówka
    /// w którymkolwiek daje kod, który zwykle nadal się skanuje — korekcja
    /// błędów naprawia go w locie — więc „zeskanowało się" niczego tu nie
    /// dowodzi. Dowodzi dopiero zgodność co do modułu z cudzym generatorem.
    ///
    /// Sumy zamiast pełnych macierzy, bo komplet wszystkich 80 to ponad
    /// megabajt wzorców w repozytorium.
    #[test]
    fn zgadza_sie_z_biblioteka_qrcode_na_wszystkich_wersjach() {
        use sha2::{Digest, Sha256};

        let gf = Galois::new();
        let mut sprawdzonych = 0;

        for wiersz in SUMY.lines().filter(|w| !w.trim().is_empty()) {
            let c: Vec<&str> = wiersz.split('\t').collect();
            assert_eq!(c.len(), 6, "zły format wiersza sum");

            let wersja: usize = c[0].parse().unwrap();
            let korekcja = poziom(c[1]);
            let maska: u8 = c[2].parse().unwrap();
            let ziarno: u32 = c[3].parse().unwrap();
            let bok: usize = c[4].parse().unwrap();

            let bajty = tresc(maks_bajtow_wersji(wersja, korekcja), ziarno);

            // Wejście dobrane na maksimum wersji, więc `dobierz_wersje` musi
            // trafić dokładnie w nią — inaczej porównujemy nie to co trzeba.
            assert_eq!(
                dobierz_wersje(bajty.len(), korekcja).unwrap(),
                wersja,
                "zła wersja dla {wersja}-{}",
                c[1]
            );

            let nasza = macierz_z_maska(&gf, &bajty, maska, korekcja).unwrap();
            assert_eq!(nasza.len(), bok, "zły bok dla {wersja}-{}", c[1]);

            let suma = hex::encode(Sha256::digest(plasko(&nasza).as_bytes()));
            assert_eq!(suma, c[5], "różnica dla wersji {wersja}, poziom {}", c[1]);
            sprawdzonych += 1;
        }

        assert_eq!(sprawdzonych, 80, "wczytano za mało wzorców");
    }

    /// To samo, ale z pełną macierzą — żeby niezgodność dało się obejrzeć.
    #[test]
    fn pelne_macierze_zgadzaja_sie_z_biblioteka() {
        let gf = Galois::new();
        let mut sprawdzonych = 0;

        for wiersz in DUZE.lines().filter(|w| !w.trim().is_empty()) {
            let c: Vec<&str> = wiersz.split('\t').collect();
            assert_eq!(c.len(), 5, "zły format wzorca");

            let ziarno: u32 = c[0].parse().unwrap();
            let maska: u8 = c[1].parse().unwrap();
            let korekcja = poziom(c[2]);
            let bok: usize = c[3].parse().unwrap();

            let wersja = (bok - 17) / 4;
            let bajty = tresc(maks_bajtow_wersji(wersja, korekcja), ziarno);

            let nasza = macierz_z_maska(&gf, &bajty, maska, korekcja).unwrap();
            assert_eq!(plasko(&nasza), c[4], "różnica dla wersji {wersja}");
            sprawdzonych += 1;
        }

        assert_eq!(sprawdzonych, 4);
    }

    /// Przepełnienie ma być **błędem**, a nie cichym przejściem na słabszą
    /// korekcję: kod czytany z ekranu przed aparatem musi znieść odbicia.
    #[test]
    fn dane_za_duze_sa_odrzucane() {
        assert!(qr_matrix(&"A".repeat(maks_bajtow(Korekcja::M) + 1)).is_err());
        assert!(qr_matrix_bajty(&vec![b'A'; maks_bajtow(Korekcja::L) + 1], Korekcja::L).is_err());
    }

    /// Największe wejście musi jeszcze wchodzić — inaczej granica jest o jeden
    /// za nisko i nikt tego nie zauważy, bo błąd wygląda tak samo jak
    /// przepełnienie.
    #[test]
    fn najwieksze_dopuszczalne_wejscie_przechodzi() {
        let m = qr_matrix_bajty(&vec![b'A'; maks_bajtow(Korekcja::L)], Korekcja::L).unwrap();
        assert_eq!(m.len(), 177, "wersja 40 ma bok 177 modułów");
    }

    /// Poziom L musi mieścić wyraźnie więcej niż M — po to został dołożony.
    /// Bez tego testu literówka w tablicy bloków dałaby kod, który się skanuje,
    /// tylko transfer optyczny byłby wolniejszy, niż powinien.
    #[test]
    fn poziom_l_miesci_wiecej_niz_m() {
        assert_eq!(maks_bajtow(Korekcja::L), 2953);
        assert_eq!(maks_bajtow(Korekcja::M), 2331);
    }

    /// Bajty zerowe i spoza ASCII przechodzą tą samą drogą co tekst —
    /// ramka transferu optycznego jest binarna i nie jest poprawnym UTF-8.
    #[test]
    fn dowolne_bajty_przechodza() {
        let bajty: Vec<u8> = (0..=255u8).chain(0..=255u8).collect();
        let m = qr_matrix_bajty(&bajty, Korekcja::L).unwrap();
        assert!(m.len() >= 21);
    }

    #[test]
    fn wybrana_maska_daje_kod_o_prawidlowym_rozmiarze() {
        let m = qr_matrix("mekamb").unwrap();
        assert_eq!(m.len(), 21);
        assert!(m.iter().all(|w| w.len() == 21));
    }

    /// Bajty spoza ASCII zajmują w UTF-8 więcej miejsca, niż wynika z długości
    /// napisu — pomylenie jednego z drugim przepełnia kod.
    #[test]
    fn znaki_spoza_ascii_przechodza() {
        let m = qr_matrix("zażółć gęślą jaźń").unwrap();
        assert!(m.len() >= 21);
    }
}
