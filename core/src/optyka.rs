//! Transfer optyczny — animowany kod QR i kody fountain.
//!
//! # Po co to istnieje
//!
//! Historia rozmów **nie ma trafiać na serwer w żadnej postaci**, nawet jako
//! szyfrogram z kluczem, którego serwer nie zna. Przy parowaniu drugiego
//! urządzenia trzeba jednak przenieść to, co powstało, zanim ono istniało.
//! Zostaje jedyna droga, która nie dotyka sieci: ekran jednego urządzenia
//! i aparat drugiego.
//!
//! # Dlaczego kody fountain, a nie ponumerowane klatki w kółko
//!
//! Karuzela ponumerowanych klatek kończy się problemem kolekcjonera kuponów:
//! ostatnie brakujące klatki trzeba wyczekać przez cały obrót, a przy ~170
//! klatkach ogon transferu potrafi trwać dłużej niż cała reszta.
//!
//! Kod fountain jest **bez współczynnika**: nadajnik generuje nieskończony
//! strumień ramek, a odbiornikowi wystarczy *dowolne* K plus kilka procent.
//! Zgubiona klatka nie wymaga powtórki konkretnie jej — kosztuje ułamek
//! sekundy i tyle. Dlatego też kod QR może iść przy korekcji L: o poprawność
//! dba ta warstwa, a nie korekcja wewnątrz pojedynczego kodu.
//!
//! # Pierwsze K ramek jest systematycznych
//!
//! Ramka o ziarnie mniejszym niż K niesie po prostu blok o tym numerze. Czyste
//! ujęcie od początku kończy transfer w **dokładnie** K klatkach, bez żadnego
//! narzutu; kodowanie XOR-em zaczyna się dopiero tam, gdzie jest do czego
//! służyć — do łatania dziur.
//!
//! # Czego to nie chroni
//!
//! Nagrania ekranu. Ktoś, kto sfilmuje monitor przez całą transmisję, ma
//! wszystkie ramki. Dlatego dane są zaszyfrowane kluczem uzgodnionym przez
//! ECDH z kodu pokazanego na **drugim** urządzeniu — patrz `parowanie`.
//! Filmujący ekran nadajnika nie widział tamtego kodu.

use aes_gcm::aead::{Aead, AeadCore, KeyInit, OsRng};
use aes_gcm::{Aes256Gcm, Key, Nonce};
use sha2::{Digest, Sha256};
use std::collections::HashMap;

use crate::error::{Error, Result};

/// Wersja formatu ramki. Zmiana kształtu wymaga podniesienia po obu stronach.
const WERSJA: u8 = 1;

/// Bajty nagłówka przed ładunkiem.
///
/// `1 wersja + 4 k + 2 rozmiar_bloku + 4 dlugosc + 12 nonce + 32 suma + 4 ziarno`
pub const NAGLOWEK: usize = 59;

/// Największy przyjmowany transfer po rozpakowaniu.
///
/// Zapora przed bombą kompresyjną: ramki przychodzą z aparatu, więc źródło jest
/// z definicji niezaufane, choćby dlatego, że ktoś mógł podstawić inny ekran.
const MAKS_PO_ROZPAKOWANIU: usize = 64 * 1024 * 1024;

/// Skala wag w rozkładzie stopni.
const SKALA: u64 = 1 << 20;

// ---------------------------------------------------------------------------
// Generator liczb — musi dawać to samo na każdej platformie
// ---------------------------------------------------------------------------

/// SplitMix64 — nadajnik i odbiornik muszą zgadzać się **co do bitu**.
///
/// Własny, a nie z `rand`: domyślny generator tamtej biblioteki nie ma
/// stabilnej definicji między wersjami, a tutaj rozjazd o jeden bit znaczy inny
/// zestaw bloków w ramce i dekoder, który nie odtwarza niczego. Algorytm jest
/// opublikowany i jednoznaczny, więc da się go powtórzyć w dowolnym języku.
struct Losowy(u64);

impl Losowy {
    fn nowy(ziarno: u32) -> Self {
        Losowy(u64::from(ziarno).wrapping_mul(0x9e37_79b9_7f4a_7c15) ^ 0x5deb_ce62_8b6a_1c1d)
    }

    fn nastepny(&mut self) -> u64 {
        self.0 = self.0.wrapping_add(0x9e37_79b9_7f4a_7c15);
        let mut z = self.0;
        z = (z ^ (z >> 30)).wrapping_mul(0xbf58_476d_1ce4_e5b9);
        z = (z ^ (z >> 27)).wrapping_mul(0x94d0_49bb_1331_11eb);
        z ^ (z >> 31)
    }

    /// Liczba z zakresu `[0, n)`.
    fn ponizej(&mut self, n: u32) -> u32 {
        (self.nastepny() % u64::from(n)) as u32
    }
}

// ---------------------------------------------------------------------------
// Rozkład stopni
// ---------------------------------------------------------------------------

/// Skumulowane wagi stopni 1..=k.
///
/// # Dlaczego same liczby całkowite
///
/// Klasyczny rozkład robust soliton wymaga `ln` i `sqrt`. `sqrt` jest w IEEE754
/// dokładny, ale **`ln` nie jest identyczne bit w bit** między platformami:
/// inna libm na Androidzie, inna w WASM, inna na x86. Rozjazd na ostatnim bicie
/// daje inny stopień ramki, a wtedy odbiornik XOR-uje nie te bloki co trzeba
/// i nie odtwarza niczego — awaria, która pojawiłaby się wyłącznie przy
/// parowaniu telefonu z laptopem, czyli nigdy w testach jednej platformy.
///
/// Dlatego zamiast robust soliton jest tu **ideal soliton z płaskim dodatkiem
/// na stopień 1**. Dodatek pełni tę samą rolę co ogon `tau`: dokłada singletonów,
/// od których dekoder ma się od czego odbić. Wierność wobec podręcznika nie ma
/// tu znaczenia — liczy się, żeby obie strony liczyły **to samo** i żeby
/// dekoder wychodził z realnych strat. To drugie sprawdza test gubiący 30%
/// ramek, i to on jest właściwym dowodem, a nie zgodność wzoru.
fn rozklad(k: u32) -> Vec<u64> {
    let mut skumulowane = Vec::with_capacity(k as usize);
    let mut suma = 0u64;

    for d in 1..=u64::from(k) {
        let waga = if d == 1 {
            // Ideal soliton daje 1/k; dodatek to 5% całej masy.
            SKALA / u64::from(k) + SKALA / 20
        } else {
            SKALA / (d * (d - 1))
        };

        // Przy dużym `d` waga schodzi do zera po zaokrągleniu. Zostawiamy
        // jedynkę, żeby żaden stopień nie zniknął z rozkładu całkowicie.
        suma += waga.max(1);
        skumulowane.push(suma);
    }

    skumulowane
}

/// Losuje stopień z rozkładu.
fn stopien(skumulowane: &[u64], r: &mut Losowy) -> usize {
    let calosc = *skumulowane.last().unwrap_or(&1);
    let trafienie = r.nastepny() % calosc;

    // Wyszukiwanie binarne: pierwszy próg większy od trafienia.
    skumulowane.partition_point(|&p| p <= trafienie) + 1
}

/// Które bloki wchodzą w ramkę o danym ziarnie.
///
/// Ziarno mniejsze od `k` znaczy ramkę systematyczną — sam blok o tym numerze.
/// Reszta to XOR losowo wybranego podzbioru.
fn bloki_ramki(ziarno: u32, k: u32, skumulowane: &[u64]) -> Vec<u32> {
    if ziarno < k {
        return vec![ziarno];
    }

    let mut r = Losowy::nowy(ziarno);
    let ile = stopien(skumulowane, &mut r).min(k as usize);

    let mut wybrane: Vec<u32> = Vec::with_capacity(ile);
    while wybrane.len() < ile {
        let kandydat = r.ponizej(k);
        if !wybrane.contains(&kandydat) {
            wybrane.push(kandydat);
        }
    }
    wybrane
}

// ---------------------------------------------------------------------------
// Nadajnik
// ---------------------------------------------------------------------------

/// Strumień ramek do pokazania na ekranie.
pub struct NadajnikOptyczny {
    naglowek: [u8; NAGLOWEK],
    bloki: Vec<Vec<u8>>,
    k: u32,
    skumulowane: Vec<u64>,
    licznik: u32,
}

impl NadajnikOptyczny {
    /// Przygotowuje transfer: kompresja, szyfrowanie, podział na bloki.
    ///
    /// Kolejność jest istotna. Kompresja **przed** szyfrowaniem, bo szyfrogram
    /// jest nieściśliwy z definicji — odwrotna kolejność nie dałaby nic.
    /// Historia to głównie polski tekst, więc zysk jest duży i wprost skraca
    /// czas trzymania telefonu nad ekranem.
    pub fn nowy(dane: &[u8], klucz: &[u8; 32], rozmiar_bloku: usize) -> Result<Self> {
        if rozmiar_bloku == 0 || rozmiar_bloku > u16::MAX as usize {
            return Err(Error::InvalidInput(format!(
                "zły rozmiar bloku: {rozmiar_bloku}"
            )));
        }

        let spakowane = miniz_oxide::deflate::compress_to_vec(dane, 6);

        let szyfr = Aes256Gcm::new(Key::<Aes256Gcm>::from_slice(klucz));
        let nonce = Aes256Gcm::generate_nonce(&mut OsRng);
        let szyfrogram = szyfr
            .encrypt(&nonce, spakowane.as_ref())
            .map_err(|_| Error::InvalidInput("nie udało się zaszyfrować transferu".into()))?;

        let suma = Sha256::digest(&szyfrogram);

        let bloki: Vec<Vec<u8>> = szyfrogram
            .chunks(rozmiar_bloku)
            .map(|kawalek| {
                let mut blok = kawalek.to_vec();
                blok.resize(rozmiar_bloku, 0);
                blok
            })
            .collect();

        let k = u32::try_from(bloki.len())
            .map_err(|_| Error::InvalidInput("transfer za duży".into()))?;
        if k == 0 {
            return Err(Error::InvalidInput("pusty transfer".into()));
        }

        let dlugosc = u32::try_from(szyfrogram.len())
            .map_err(|_| Error::InvalidInput("transfer za duży".into()))?;

        let mut naglowek = [0u8; NAGLOWEK];
        naglowek[0] = WERSJA;
        naglowek[1..5].copy_from_slice(&k.to_be_bytes());
        naglowek[5..7].copy_from_slice(&(rozmiar_bloku as u16).to_be_bytes());
        naglowek[7..11].copy_from_slice(&dlugosc.to_be_bytes());
        naglowek[11..23].copy_from_slice(nonce.as_slice());
        naglowek[23..55].copy_from_slice(&suma);

        Ok(NadajnikOptyczny {
            naglowek,
            bloki,
            k,
            skumulowane: rozklad(k),
            licznik: 0,
        })
    }

    /// Ile bloków ma transfer — tyle ramek wystarczy przy czystym ujęciu.
    pub fn ile_blokow(&self) -> u32 {
        self.k
    }

    /// Kolejna ramka. Strumień jest nieskończony.
    pub fn nastepna_ramka(&mut self) -> Vec<u8> {
        let ziarno = self.licznik;
        self.licznik = self.licznik.wrapping_add(1);

        let rozmiar = self.bloki[0].len();
        let mut ladunek = vec![0u8; rozmiar];
        for indeks in bloki_ramki(ziarno, self.k, &self.skumulowane) {
            for (cel, zrodlo) in ladunek.iter_mut().zip(&self.bloki[indeks as usize]) {
                *cel ^= zrodlo;
            }
        }

        let mut ramka = Vec::with_capacity(NAGLOWEK + rozmiar);
        ramka.extend_from_slice(&self.naglowek);
        ramka[55..59].copy_from_slice(&ziarno.to_be_bytes());
        ramka.extend_from_slice(&ladunek);
        ramka
    }
}

// ---------------------------------------------------------------------------
// Odbiornik
// ---------------------------------------------------------------------------

/// Co ramka zmieniła w odbiorze.
#[derive(Clone, Copy, PartialEq, Eq, Debug)]
pub enum Postep {
    /// Przyjęta; brakuje jeszcze bloków.
    Trwa { odzyskane: u32, wszystkich: u32 },
    /// Komplet — można wołać [`OdbiornikOptyczny::odbierz`].
    Gotowe,
    /// Ramka z **innego** transferu: aparat patrzy na inny ekran.
    Obca,
    /// Nieczytelna albo w nieznanej wersji formatu.
    Niepoprawna,
}

/// Zbiera ramki i odtwarza z nich całość.
///
/// # Dlaczego klucz podaje się dopiero przy składaniu
///
/// Zbieranie ramek go nie potrzebuje — potrzebuje go wyłącznie ostatni krok.
/// Ma to znaczenie praktyczne przy parowaniu: klucz uzgadnia się z materiałem,
/// który przychodzi tą samą kamerą co ramki, więc odbiornik musi umieć
/// **zacząć zbierać, zanim pozna klucz**. Trzymanie klucza w konstruktorze
/// zmuszałoby do wyrzucenia wszystkiego, co złapano do tej pory.
pub struct OdbiornikOptyczny {
    naglowek: Option<Opis>,
    bloki: Vec<Option<Vec<u8>>>,
    /// Ramki, których jeszcze nie da się rozwiązać: nierozstrzygnięte indeksy
    /// i bieżąca wartość XOR.
    oczekujace: Vec<(Vec<u32>, Vec<u8>)>,
    /// Z którego bloku korzystają które oczekujące ramki — bez tego każde
    /// odzyskanie przeglądałoby całą listę.
    wystapienia: HashMap<u32, Vec<usize>>,
    odzyskane: u32,
    skumulowane: Vec<u64>,
}

#[derive(Clone)]
struct Opis {
    k: u32,
    rozmiar_bloku: usize,
    dlugosc: usize,
    nonce: [u8; 12],
    suma: [u8; 32],
}

impl OdbiornikOptyczny {
    pub fn nowy() -> Self {
        OdbiornikOptyczny {
            naglowek: None,
            bloki: Vec::new(),
            oczekujace: Vec::new(),
            wystapienia: HashMap::new(),
            odzyskane: 0,
            skumulowane: Vec::new(),
        }
    }

    /// Ile bloków ma transfer, o ile widzieliśmy już choć jedną ramkę.
    pub fn wszystkich(&self) -> Option<u32> {
        self.naglowek.as_ref().map(|o| o.k)
    }

    /// Ile bloków już odzyskano.
    pub fn odzyskane(&self) -> u32 {
        self.odzyskane
    }

    /// Przyjmuje ramkę odczytaną z kodu QR.
    pub fn dodaj_ramke(&mut self, ramka: &[u8]) -> Postep {
        let Some(opis) = rozbierz_naglowek(ramka) else {
            return Postep::Niepoprawna;
        };

        if ramka.len() != NAGLOWEK + opis.rozmiar_bloku {
            return Postep::Niepoprawna;
        }

        match &self.naglowek {
            // Suma rozstrzyga tożsamość transferu: ta sama treść to ten sam
            // transfer, inna to inny ekran albo inne parowanie.
            Some(znany) if znany.suma != opis.suma => return Postep::Obca,
            Some(_) => {}
            None => {
                self.bloki = vec![None; opis.k as usize];
                self.skumulowane = rozklad(opis.k);
                self.naglowek = Some(opis.clone());
            }
        }

        if self.odzyskane == opis.k {
            return Postep::Gotowe;
        }

        let ziarno = u32::from_be_bytes([ramka[55], ramka[56], ramka[57], ramka[58]]);
        let ladunek = ramka[NAGLOWEK..].to_vec();

        let indeksy = bloki_ramki(ziarno, opis.k, &self.skumulowane);
        self.wchlon(indeksy, ladunek);

        if self.odzyskane == opis.k {
            Postep::Gotowe
        } else {
            Postep::Trwa {
                odzyskane: self.odzyskane,
                wszystkich: opis.k,
            }
        }
    }

    /// Wprowadza ramkę do układu i rozwiązuje, co się da (peeling).
    fn wchlon(&mut self, indeksy: Vec<u32>, mut wartosc: Vec<u8>) {
        // Najpierw odejmujemy to, co już znamy.
        let mut nieznane: Vec<u32> = Vec::with_capacity(indeksy.len());
        for i in indeksy {
            match &self.bloki[i as usize] {
                Some(znany) => xor_w_miejscu(&mut wartosc, znany),
                None => nieznane.push(i),
            }
        }

        let mut do_rozwiniecia: Vec<u32> = Vec::new();

        match nieznane.len() {
            0 => return, // nic nowego — ramka nadmiarowa
            1 => {
                let i = nieznane[0];
                self.bloki[i as usize] = Some(wartosc);
                self.odzyskane += 1;
                do_rozwiniecia.push(i);
            }
            _ => {
                let pozycja = self.oczekujace.len();
                for &i in &nieznane {
                    self.wystapienia.entry(i).or_default().push(pozycja);
                }
                self.oczekujace.push((nieznane, wartosc));
                return;
            }
        }

        // Kaskada: każdy świeżo odzyskany blok może rozwiązać kolejne ramki.
        while let Some(i) = do_rozwiniecia.pop() {
            let Some(dotkniete) = self.wystapienia.remove(&i) else {
                continue;
            };

            let znany = self.bloki[i as usize]
                .clone()
                .expect("dopiero co ustawiony");

            for pozycja in dotkniete {
                let (nieznane, wartosc) = &mut self.oczekujace[pozycja];
                if !nieznane.contains(&i) {
                    continue;
                }

                nieznane.retain(|&x| x != i);
                xor_w_miejscu(wartosc, &znany);

                if nieznane.len() == 1 {
                    let j = nieznane[0];
                    if self.bloki[j as usize].is_none() {
                        self.bloki[j as usize] = Some(wartosc.clone());
                        self.odzyskane += 1;
                        do_rozwiniecia.push(j);
                    }
                    nieznane.clear();
                }
            }
        }
    }

    /// Składa całość: sprawdza sumę, odszyfrowuje, rozpakowuje.
    ///
    /// Suma liczona jest z **szyfrogramu**, więc niezgodność wychodzi przed
    /// deszyfrowaniem — a to znaczy, że uszkodzony transfer nie dociera nawet
    /// do AES-a.
    pub fn odbierz(&self, klucz: &[u8; 32]) -> Result<Vec<u8>> {
        let opis = self
            .naglowek
            .as_ref()
            .ok_or_else(|| Error::InvalidInput("nie odebrano żadnej ramki".into()))?;

        if self.odzyskane != opis.k {
            return Err(Error::InvalidInput(format!(
                "brakuje bloków: {} z {}",
                self.odzyskane, opis.k
            )));
        }

        let mut szyfrogram = Vec::with_capacity(opis.k as usize * opis.rozmiar_bloku);
        for blok in &self.bloki {
            szyfrogram.extend_from_slice(blok.as_ref().expect("komplet sprawdzony wyżej"));
        }
        szyfrogram.truncate(opis.dlugosc);

        if Sha256::digest(&szyfrogram).as_slice() != opis.suma {
            return Err(Error::MessageRejected);
        }

        let szyfr = Aes256Gcm::new(Key::<Aes256Gcm>::from_slice(klucz));
        let spakowane = szyfr
            .decrypt(Nonce::from_slice(&opis.nonce), szyfrogram.as_ref())
            .map_err(|_| Error::MessageRejected)?;

        miniz_oxide::inflate::decompress_to_vec_with_limit(&spakowane, MAKS_PO_ROZPAKOWANIU)
            .map_err(|_| Error::MessageRejected)
    }
}

fn rozbierz_naglowek(ramka: &[u8]) -> Option<Opis> {
    if ramka.len() < NAGLOWEK || ramka[0] != WERSJA {
        return None;
    }

    let k = u32::from_be_bytes(ramka[1..5].try_into().ok()?);
    let rozmiar_bloku = u16::from_be_bytes(ramka[5..7].try_into().ok()?) as usize;
    let dlugosc = u32::from_be_bytes(ramka[7..11].try_into().ok()?) as usize;

    if k == 0 || rozmiar_bloku == 0 {
        return None;
    }

    // Deklarowana długość musi mieścić się w deklarowanej liczbie bloków —
    // inaczej spreparowana ramka kazałaby alokować dowolnie dużo.
    if dlugosc > k as usize * rozmiar_bloku {
        return None;
    }

    Some(Opis {
        k,
        rozmiar_bloku,
        dlugosc,
        nonce: ramka[11..23].try_into().ok()?,
        suma: ramka[23..55].try_into().ok()?,
    })
}

fn xor_w_miejscu(cel: &mut [u8], zrodlo: &[u8]) {
    for (c, z) in cel.iter_mut().zip(zrodlo) {
        *c ^= z;
    }
}

#[cfg(test)]
mod tests {
    use super::*;

    const KLUCZ: [u8; 32] = [7u8; 32];

    /// Dane podobne do zapisanej historii: powtarzalna struktura JSON-a
    /// i zmienna treść.
    ///
    /// Powtarzający się jeden napis byłby złym wzorcem — deflate ściskał go
    /// osiemdziesięciokrotnie, więc cały transfer schodził do JEDNEGO bloku
    /// i testy narzutu nie sprawdzały niczego.
    fn dane(ile: usize) -> Vec<u8> {
        let mut out = Vec::with_capacity(ile + 128);
        let mut x: u32 = 12_345;
        let mut n = 0u32;

        while out.len() < ile {
            x = x.wrapping_mul(1_664_525).wrapping_add(1_013_904_223);
            out.extend_from_slice(
                format!(
                    "{{\"id\":\"{x:08x}\",\"autor\":\"kasia\",\"czas\":{},\"tresc\":\"wiadomosc {n} {x:x}\"}}\n",
                    1_700_000_000_000u64 + u64::from(n) * 37,
                )
                .as_bytes(),
            );
            n += 1;
        }

        out.truncate(ile);
        out
    }

    /// Podstawa: co weszło, to ma wyjść.
    #[test]
    fn pelny_obieg_odtwarza_dane() {
        let zrodlo = dane(50_000);
        let mut nadajnik = NadajnikOptyczny::nowy(&zrodlo, &KLUCZ, 512).unwrap();
        let mut odbiornik = OdbiornikOptyczny::nowy();

        loop {
            if odbiornik.dodaj_ramke(&nadajnik.nastepna_ramka()) == Postep::Gotowe {
                break;
            }
        }

        assert_eq!(odbiornik.odbierz(&KLUCZ).unwrap(), zrodlo);
    }

    /// Czyste ujęcie ma kosztować **dokładnie** K klatek — po to pierwsze K
    /// ramek jest systematycznych. Gdyby liczyły się jako zwykłe ramki
    /// fountain, transfer trwałby o kilkanaście procent dłużej bez powodu.
    #[test]
    fn czyste_ujecie_konczy_sie_po_k_ramkach() {
        let zrodlo = dane(20_000);
        let mut nadajnik = NadajnikOptyczny::nowy(&zrodlo, &KLUCZ, 512).unwrap();
        let k = nadajnik.ile_blokow();
        let mut odbiornik = OdbiornikOptyczny::nowy();

        for _ in 0..k {
            odbiornik.dodaj_ramke(&nadajnik.nastepna_ramka());
        }

        assert_eq!(odbiornik.odzyskane(), k);
        assert_eq!(odbiornik.odbierz(&KLUCZ).unwrap(), zrodlo);
    }

    /// Sedno kodów fountain: aparat gubi klatki i to ma być **tanie**.
    /// Zgubiona ramka nie wymaga powtórki konkretnie jej.
    #[test]
    fn wychodzi_z_utraty_trzydziestu_procent_ramek() {
        let zrodlo = dane(40_000);
        let mut nadajnik = NadajnikOptyczny::nowy(&zrodlo, &KLUCZ, 512).unwrap();
        let k = nadajnik.ile_blokow();
        let mut odbiornik = OdbiornikOptyczny::nowy();

        assert!(k >= 10, "wzorzec za mały, test niczego nie sprawdza: k={k}");

        // Deterministyczne „gubienie": co dziesiąta, jedenasta i dwunasta.
        let mut wyslane = 0u32;
        let mut przyjete = 0u32;
        while odbiornik.odzyskane() < k {
            let ramka = nadajnik.nastepna_ramka();
            wyslane += 1;

            if wyslane % 10 < 3 {
                continue;
            }

            przyjete += 1;
            odbiornik.dodaj_ramke(&ramka);

            assert!(wyslane < k * 10, "dekoder utknął");
        }

        assert_eq!(odbiornik.odbierz(&KLUCZ).unwrap(), zrodlo);

        // Narzut liczymy wobec PRZYJĘTYCH ramek: sam kod fountain nie powinien
        // potrzebować dużo ponad K, niezależnie od tego, ile przepadło po
        // drodze. Podwojenie znaczyłoby, że rozkład stopni jest do wyrzucenia.
        assert!(
            przyjete < k * 2,
            "za duży narzut: {przyjete} przyjętych na {k} bloków"
        );
    }

    /// Kolejność nie może mieć znaczenia — aparat łapie ramki, jak wypadnie.
    #[test]
    fn kolejnosc_ramek_nie_ma_znaczenia() {
        let zrodlo = dane(15_000);
        let mut nadajnik = NadajnikOptyczny::nowy(&zrodlo, &KLUCZ, 400).unwrap();
        let k = nadajnik.ile_blokow();

        let mut ramki: Vec<Vec<u8>> = (0..k * 2).map(|_| nadajnik.nastepna_ramka()).collect();
        ramki.reverse();

        let mut odbiornik = OdbiornikOptyczny::nowy();
        for ramka in &ramki {
            if odbiornik.dodaj_ramke(ramka) == Postep::Gotowe {
                break;
            }
        }

        assert_eq!(odbiornik.odbierz(&KLUCZ).unwrap(), zrodlo);
    }

    /// Powtórzona ramka jest normalna: nadajnik chodzi w kółko, a aparat
    /// łapie tę samą klatkę dwa razy przy 60 Hz odświeżania.
    #[test]
    fn powtorzone_ramki_nie_psuja_odbioru() {
        let zrodlo = dane(8_000);
        let mut nadajnik = NadajnikOptyczny::nowy(&zrodlo, &KLUCZ, 300).unwrap();
        let mut odbiornik = OdbiornikOptyczny::nowy();

        loop {
            let ramka = nadajnik.nastepna_ramka();
            odbiornik.dodaj_ramke(&ramka);
            if odbiornik.dodaj_ramke(&ramka) == Postep::Gotowe {
                break;
            }
        }

        assert_eq!(odbiornik.odbierz(&KLUCZ).unwrap(), zrodlo);
    }

    /// Aparat skierowany na inny ekran nie może zanieczyścić transferu.
    #[test]
    fn ramka_z_innego_transferu_jest_odrzucana() {
        let mut pierwszy = NadajnikOptyczny::nowy(&dane(5_000), &KLUCZ, 300).unwrap();
        let mut drugi = NadajnikOptyczny::nowy(&dane(6_000), &KLUCZ, 300).unwrap();

        let mut odbiornik = OdbiornikOptyczny::nowy();
        odbiornik.dodaj_ramke(&pierwszy.nastepna_ramka());

        assert_eq!(odbiornik.dodaj_ramke(&drugi.nastepna_ramka()), Postep::Obca);
    }

    /// Zły klucz ma odpaść na AES-ie, a nie wydać śmieci.
    ///
    /// Ramki zbiera się bez klucza, więc pomyłka wychodzi dopiero tutaj —
    /// i ma wyjść jako błąd, nie jako historia pełna znaków zastępczych.
    #[test]
    fn zly_klucz_nie_odszyfrowuje() {
        let zrodlo = dane(4_000);
        let mut nadajnik = NadajnikOptyczny::nowy(&zrodlo, &KLUCZ, 300).unwrap();
        let mut odbiornik = OdbiornikOptyczny::nowy();

        loop {
            if odbiornik.dodaj_ramke(&nadajnik.nastepna_ramka()) == Postep::Gotowe {
                break;
            }
        }

        assert!(odbiornik.odbierz(&[9u8; 32]).is_err());
        // Ten sam komplet ramek z właściwym kluczem musi się złożyć — inaczej
        // test dowodziłby tylko tego, że transfer jest zepsuty.
        assert_eq!(odbiornik.odbierz(&KLUCZ).unwrap(), zrodlo);
    }

    /// Uszkodzony ładunek ma zostać wykryty przez sumę, zanim ruszy AES.
    #[test]
    fn przekrecony_bajt_wykrywa_suma() {
        let zrodlo = dane(4_000);
        let mut nadajnik = NadajnikOptyczny::nowy(&zrodlo, &KLUCZ, 300).unwrap();
        let mut odbiornik = OdbiornikOptyczny::nowy();

        // Same ramki systematyczne, więc przekręcenie trafia wprost w blok
        // i nie da się go naprawić inną ramką.
        let k = nadajnik.ile_blokow();
        for i in 0..k {
            let mut ramka = nadajnik.nastepna_ramka();
            if i == 0 {
                ramka[NAGLOWEK] ^= 0xff;
            }
            odbiornik.dodaj_ramke(&ramka);
        }

        assert!(odbiornik.odbierz(&KLUCZ).is_err());
    }

    /// Śmieci z aparatu są normalne: rozpoznany kod QR bywa fałszywy.
    #[test]
    fn smieci_sa_odrzucane_bez_paniki() {
        let mut odbiornik = OdbiornikOptyczny::nowy();

        assert_eq!(odbiornik.dodaj_ramke(&[]), Postep::Niepoprawna);
        assert_eq!(odbiornik.dodaj_ramke(&[0u8; 10]), Postep::Niepoprawna);
        assert_eq!(odbiornik.dodaj_ramke(&[0xff; 200]), Postep::Niepoprawna);

        // Poprawna wersja, ale deklaracja długości nie mieści się w blokach.
        let mut zle = vec![0u8; NAGLOWEK + 4];
        zle[0] = WERSJA;
        zle[1..5].copy_from_slice(&1u32.to_be_bytes());
        zle[5..7].copy_from_slice(&4u16.to_be_bytes());
        zle[7..11].copy_from_slice(&999_999u32.to_be_bytes());
        assert_eq!(odbiornik.dodaj_ramke(&zle), Postep::Niepoprawna);
    }

    /// Rozkład stopni musi być identyczny po obu stronach — inaczej odbiornik
    /// XOR-uje nie te bloki co nadajnik. Test pilnuje, że nie wkradła się
    /// zmiennoprzecinkowość ani zależność od kolejności wywołań.
    #[test]
    fn wybor_blokow_jest_powtarzalny() {
        let s = rozklad(200);
        for ziarno in [0u32, 5, 199, 200, 1_000, 65_535, u32::MAX] {
            let a = bloki_ramki(ziarno, 200, &s);
            let b = bloki_ramki(ziarno, 200, &s);
            assert_eq!(a, b, "ziarno {ziarno}");
            assert!(!a.is_empty() && a.len() <= 200);
        }
    }

    /// Ile klatek kosztuje realna historia.
    ///
    /// To jest budżet czasu, w którym użytkownik trzyma telefon nad ekranem —
    /// najbardziej uciążliwa część całego parowania. Regresja w kompresji albo
    /// spuchnięty nagłówek przechodzą bez tego testu niezauważone, bo wszystko
    /// nadal działa: tylko wolniej.
    #[test]
    fn realna_historia_miesci_sie_w_kilkudziesieciu_klatkach() {
        use crate::qr::{Korekcja, maks_bajtow};

        let rozmiar_bloku = maks_bajtow(Korekcja::L) - NAGLOWEK;
        let nadajnik = NadajnikOptyczny::nowy(&dane(500_000), &KLUCZ, rozmiar_bloku).unwrap();
        let klatek = nadajnik.ile_blokow();

        // Przy dziesięciu klatkach na sekundę mówimy o sekundach, nie minutach.
        assert!(
            klatek <= 100,
            "500 kB historii zajmuje {klatek} klatek — to ponad 10 sekund"
        );
    }

    /// Ramka musi zmieścić się w kodzie QR — po to jest cały ten format.
    #[test]
    fn ramka_miesci_sie_w_kodzie_qr() {
        use crate::qr::{Korekcja, maks_bajtow};

        let rozmiar_bloku = maks_bajtow(Korekcja::L) - NAGLOWEK;
        let mut nadajnik = NadajnikOptyczny::nowy(&dane(100_000), &KLUCZ, rozmiar_bloku).unwrap();
        let ramka = nadajnik.nastepna_ramka();

        assert_eq!(ramka.len(), maks_bajtow(Korekcja::L));
        assert!(crate::qr::qr_matrix_bajty(&ramka, Korekcja::L).is_ok());
    }
}
