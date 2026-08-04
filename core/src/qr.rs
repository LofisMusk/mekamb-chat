//! Generator kodów QR — ISO/IEC 18004, tryb bajtowy, korekcja poziomu M.
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
//! Wersje 1–10 przy korekcji M, czyli do 216 bajtów. Większe wejście jest
//! błędem, a nie cichym przejściem na słabszą korekcję: kod pokazywany
//! z ekranu przed aparatem musi znieść odbicia i krzywe ujęcie.

use crate::error::{Error, Result};

/// Największa obsługiwana wersja.
const MAX_VERSION: usize = 10;

/// Bajty korekcji na blok oraz podział na grupy, dla korekcji M.
///
/// Grupy różnią się liczbą bajtów danych: przy niektórych wersjach dane nie
/// dzielą się równo, więc część bloków jest o jeden bajt dłuższa.
struct Bloki {
    ec: usize,
    grupy: &'static [(usize, usize)],
}

const BLOKI: [Bloki; MAX_VERSION] = [
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
        for i in 0..255 {
            exp[i] = x as u8;
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

/// Ile bajtów danych mieści wersja przy korekcji M.
fn pojemnosc(wersja: usize) -> usize {
    BLOKI[wersja - 1]
        .grupy
        .iter()
        .map(|(ile, dlugosc)| ile * dlugosc)
        .sum()
}

/// Najmniejsza wersja mieszcząca dane.
///
/// Nagłówek to 4 bity trybu i licznik długości — 8 bitów do wersji 9, 16 od 10.
fn dobierz_wersje(ile_bajtow: usize) -> Result<usize> {
    for wersja in 1..=MAX_VERSION {
        let naglowek = if wersja < 10 { 12 } else { 20 };
        if (naglowek + ile_bajtow * 8).div_ceil(8) <= pojemnosc(wersja) {
            return Ok(wersja);
        }
    }
    Err(Error::InvalidInput(format!(
        "dane nie mieszczą się w kodzie QR: {ile_bajtow} bajtów"
    )))
}

/// Składa strumień danych: nagłówek, treść, terminator i wypełnienie.
fn uloz_dane(bajty: &[u8], wersja: usize) -> Vec<u8> {
    let pojemnosc_bajtow = pojemnosc(wersja);
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
    for i in pelne_bajty..pojemnosc_bajtow {
        dane[i] = if (i - pelne_bajty) % 2 == 0 {
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
fn przeplec(gf: &Galois, dane: &[u8], wersja: usize) -> Vec<u8> {
    let Bloki { ec, grupy } = &BLOKI[wersja - 1];

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
fn info_formatu(maska: u8) -> u32 {
    let dane = maska as u32; // poziom M to 00 na starszych bitach
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
            let na_wzorze =
                (y == 6 && x == 6) || (y == 6 && x == ostatni) || (y == ostatni && x == 6);
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

fn wpisz_format(m: &mut Macierz, maska: u8) {
    let rozmiar = m.bok;
    let bity = info_formatu(maska);
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
fn macierz_z_maska(gf: &Galois, tekst: &str, maska: u8) -> Result<Vec<Vec<bool>>> {
    let bajty = tekst.as_bytes();
    let wersja = dobierz_wersje(bajty.len())?;
    let dane = przeplec(gf, &uloz_dane(bajty, wersja), wersja);

    let mut m = Macierz::nowa(wersja * 4 + 17);
    wzory_stale(&mut m, wersja);
    wpisz_format(&mut m, maska);
    wpisz_dane(&mut m, &dane, maska);

    Ok((0..m.bok)
        .map(|y| (0..m.bok).map(|x| m.pobierz(y, x) == CIEMNY).collect())
        .collect())
}

/// Buduje macierz kodu QR. `true` znaczy moduł ciemny.
///
/// Maska wybierana jest tak, jak każe norma: liczymy karę dla wszystkich ośmiu
/// i bierzemy najniższą.
pub fn qr_matrix(tekst: &str) -> Result<Vec<Vec<bool>>> {
    let gf = Galois::new();

    let mut najlepsza = macierz_z_maska(&gf, tekst, 0)?;
    let mut najnizsza = kara(&najlepsza);

    for maska in 1..8u8 {
        let gotowa = macierz_z_maska(&gf, tekst, maska)?;
        let wynik = kara(&gotowa);
        if wynik < najnizsza {
            najnizsza = wynik;
            najlepsza = gotowa;
        }
    }

    Ok(najlepsza)
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

            let nasza = macierz_z_maska(&gf, &tekst, maska).unwrap();
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

    #[test]
    fn dane_za_duze_sa_odrzucane() {
        assert!(qr_matrix(&"A".repeat(300)).is_err());
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
