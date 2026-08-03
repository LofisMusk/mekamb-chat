//! Usuwanie metadanych z plików multimedialnych.
//!
//! # Po co
//!
//! Zdjęcie z telefonu niesie w EXIF-ie współrzędne GPS z dokładnością do
//! kilku metrów, model aparatu, numer seryjny i czas wykonania. Wysłanie go
//! „bezpiecznym" komunikatorem, który szyfruje treść, ale zostawia EXIF,
//! oznacza że odbiorca — albo ktokolwiek, komu odbiorca prześle plik dalej —
//! dostaje adres domowy nadawcy.
//!
//! Szyfrowanie nie pomaga na dane, które sami dobrowolnie umieszczamy w środku
//! szyfrogramu. Dlatego czyścimy **przed** zaszyfrowaniem i domyślnie.
//!
//! # Dlaczego bez przekodowywania pikseli
//!
//! Najprostszy sposób usunięcia metadanych to wczytanie obrazu i zapisanie go
//! od nowa. Kosztuje to jednak stratę jakości przy JPEG i sporo czasu na
//! telefonie. Zamiast tego przepisujemy strukturę pliku, przepuszczając
//! wyłącznie te fragmenty, które są potrzebne do wyświetlenia — piksele
//! zostają bit w bit takie same.
//!
//! # Czego ten moduł NIE robi
//!
//! Nie czyści wideo. Kontenery MP4 i MOV trzymają metadane w zagnieżdżonych
//! boksach `moov`/`udta`, a przepisanie ich wymaga pełnego parsera kontenera.
//! Nagrania z telefonu **też mają GPS**, więc jest to realna luka, a nie
//! drobiazg — interfejs musi o tym uprzedzić, dopóki nie zostanie zamknięta.

use crate::error::{Error, Result};

/// Czy dla danego typu potrafimy usunąć metadane.
pub fn can_strip(mime_type: &str) -> bool {
    matches!(mime_type, "image/jpeg" | "image/jpg" | "image/png")
}

/// Usuwa metadane z obrazu, zostawiając piksele nietknięte.
///
/// Dla nieobsługiwanych typów zwraca dane bez zmian — decyzja „czyścić czy
/// ostrzec" należy do warstwy wyżej, bo tylko ona może porozmawiać
/// z użytkownikiem.
pub fn strip_image_metadata(bytes: &[u8], mime_type: &str) -> Result<Vec<u8>> {
    match mime_type {
        "image/jpeg" | "image/jpg" => strip_jpeg(bytes),
        "image/png" => strip_png(bytes),
        _ => Ok(bytes.to_vec()),
    }
}

/// Segmenty JPEG, które przepuszczamy.
///
/// Wszystko poza tą listą wylatuje. Lista dozwolonych, a nie zakazanych —
/// przy odwrotnym podejściu każdy nowy, nieznany typ segmentu przechodziłby
/// domyślnie, a to dokładnie ten przypadek, którego chcemy uniknąć.
fn jpeg_segment_dozwolony(marker: u8) -> bool {
    match marker {
        // APP0 — JFIF: gęstość pikseli i miniatura. Bez danych osobowych.
        0xE0 => true,
        // APP2 — profil kolorów ICC. Potrzebny do wiernych barw.
        0xE2 => true,
        // Tablice kwantyzacji, Huffmana, nagłówki ramki — bez nich nie ma obrazu.
        0xDB | 0xC4 | 0xC0..=0xC3 | 0xC5..=0xC7 | 0xC9..=0xCB | 0xCD..=0xCF => true,
        // Restart interval.
        0xDD => true,
        // APP1 (EXIF i XMP), APP13 (IPTC), COM (komentarz) i cała reszta — nie.
        _ => false,
    }
}

fn strip_jpeg(bytes: &[u8]) -> Result<Vec<u8>> {
    if bytes.len() < 4 || bytes[0] != 0xFF || bytes[1] != 0xD8 {
        return Err(Error::InvalidInput("to nie jest plik JPEG".into()));
    }

    let mut out = Vec::with_capacity(bytes.len());
    out.extend_from_slice(&bytes[0..2]); // SOI

    let mut i = 2;
    while i + 1 < bytes.len() {
        if bytes[i] != 0xFF {
            return Err(Error::InvalidInput("uszkodzona struktura JPEG".into()));
        }

        // Wypełniacze 0xFF są dozwolone między segmentami.
        let mut marker_pos = i + 1;
        while marker_pos < bytes.len() && bytes[marker_pos] == 0xFF {
            marker_pos += 1;
        }
        if marker_pos >= bytes.len() {
            break;
        }

        let marker = bytes[marker_pos];

        // SOS: po nim idą dane skompresowane aż do końca pliku. Kopiujemy
        // resztę dosłownie — tu są piksele i nic więcej nie parsujemy.
        if marker == 0xDA {
            out.extend_from_slice(&bytes[i..]);
            return Ok(out);
        }

        // Markery bez ładunku.
        if marker == 0xD9 || (0xD0..=0xD7).contains(&marker) {
            out.extend_from_slice(&[0xFF, marker]);
            i = marker_pos + 1;
            continue;
        }

        let len_pos = marker_pos + 1;
        if len_pos + 1 >= bytes.len() {
            return Err(Error::InvalidInput("obcięty segment JPEG".into()));
        }

        let dlugosc = u16::from_be_bytes([bytes[len_pos], bytes[len_pos + 1]]) as usize;
        if dlugosc < 2 {
            return Err(Error::InvalidInput("nieprawidłowa długość segmentu JPEG".into()));
        }

        let koniec = len_pos
            .checked_add(dlugosc)
            .ok_or_else(|| Error::InvalidInput("przepełnienie długości segmentu".into()))?;
        if koniec > bytes.len() {
            return Err(Error::InvalidInput("segment JPEG wykracza poza plik".into()));
        }

        if jpeg_segment_dozwolony(marker) {
            out.extend_from_slice(&[0xFF, marker]);
            out.extend_from_slice(&bytes[len_pos..koniec]);
        }

        i = koniec;
    }

    Ok(out)
}

/// Chunki PNG, które przepuszczamy.
///
/// Znów lista dozwolonych. `tEXt`, `zTXt`, `iTXt`, `eXIf` i `tIME` odpadają —
/// pierwsze trzy bywają nośnikiem dowolnych danych, `eXIf` niesie to samo co
/// w JPEG, a `tIME` zdradza moment edycji.
fn png_chunk_dozwolony(typ: &[u8]) -> bool {
    matches!(
        typ,
        b"IHDR" | b"PLTE" | b"IDAT" | b"IEND"     // krytyczne — bez nich nie ma obrazu
            | b"tRNS" | b"gAMA" | b"cHRM" | b"sRGB" | b"iCCP"  // wierność barw
            | b"pHYs" | b"sBIT" | b"bKGD" | b"hIST"            // parametry wyświetlania
            | b"acTL" | b"fcTL" | b"fdAT"                      // animacja (APNG)
    )
}

const PNG_SIGNATURE: [u8; 8] = [0x89, b'P', b'N', b'G', 0x0D, 0x0A, 0x1A, 0x0A];

fn strip_png(bytes: &[u8]) -> Result<Vec<u8>> {
    if bytes.len() < 8 || bytes[0..8] != PNG_SIGNATURE {
        return Err(Error::InvalidInput("to nie jest plik PNG".into()));
    }

    let mut out = Vec::with_capacity(bytes.len());
    out.extend_from_slice(&PNG_SIGNATURE);

    let mut i = 8;
    while i + 8 <= bytes.len() {
        let dlugosc = u32::from_be_bytes([bytes[i], bytes[i + 1], bytes[i + 2], bytes[i + 3]]) as usize;
        let typ = &bytes[i + 4..i + 8];

        // 4 bajty długości + 4 typu + dane + 4 CRC.
        let koniec = i
            .checked_add(12)
            .and_then(|podstawa| podstawa.checked_add(dlugosc))
            .ok_or_else(|| Error::InvalidInput("przepełnienie długości chunku PNG".into()))?;

        if koniec > bytes.len() {
            return Err(Error::InvalidInput("chunk PNG wykracza poza plik".into()));
        }

        if png_chunk_dozwolony(typ) {
            // Kopiujemy razem z CRC — nie ruszamy zawartości, więc suma
            // kontrolna pozostaje prawidłowa.
            out.extend_from_slice(&bytes[i..koniec]);
        }

        let koniec_pliku = typ == b"IEND";
        i = koniec;

        if koniec_pliku {
            break;
        }
    }

    Ok(out)
}

#[cfg(test)]
mod tests {
    use super::*;

    /// Buduje minimalny JPEG z segmentem EXIF zawierającym rozpoznawalny ciąg.
    fn jpeg_z_exifem(exif: &[u8]) -> Vec<u8> {
        let mut plik = vec![0xFF, 0xD8]; // SOI

        // APP1 (EXIF)
        plik.extend_from_slice(&[0xFF, 0xE1]);
        plik.extend_from_slice(&((exif.len() + 2) as u16).to_be_bytes());
        plik.extend_from_slice(exif);

        // APP0 (JFIF) — ma przetrwać
        plik.extend_from_slice(&[0xFF, 0xE0, 0x00, 0x06, b'J', b'F', b'I', b'F']);

        // SOS i „piksele"
        plik.extend_from_slice(&[0xFF, 0xDA, 0x00, 0x02]);
        plik.extend_from_slice(b"UDAWANE-PIKSELE");
        plik.extend_from_slice(&[0xFF, 0xD9]); // EOI

        plik
    }

    fn png_z_tekstem(tekst: &[u8]) -> Vec<u8> {
        let mut plik = PNG_SIGNATURE.to_vec();

        let chunk = |typ: &[u8], dane: &[u8]| {
            let mut c = (dane.len() as u32).to_be_bytes().to_vec();
            c.extend_from_slice(typ);
            c.extend_from_slice(dane);
            c.extend_from_slice(&[0, 0, 0, 0]); // CRC — nieistotny dla tego testu
            c
        };

        plik.extend_from_slice(&chunk(b"IHDR", &[0; 13]));
        plik.extend_from_slice(&chunk(b"tEXt", tekst));
        plik.extend_from_slice(&chunk(b"IDAT", b"UDAWANE-PIKSELE"));
        plik.extend_from_slice(&chunk(b"IEND", b""));

        plik
    }

    #[test]
    fn exif_znika_z_jpega() {
        const GPS: &[u8] = b"Exif\0\0GPS 52.2297N 21.0122E Canon EOS";
        let oryginal = jpeg_z_exifem(GPS);

        assert!(zawiera(&oryginal, GPS), "test jest bez sensu, jeśli EXIF-u nie było");

        let oczyszczony = strip_image_metadata(&oryginal, "image/jpeg").unwrap();

        assert!(!zawiera(&oczyszczony, GPS), "EXIF przetrwał czyszczenie");
        assert!(!zawiera(&oczyszczony, b"52.2297N"), "współrzędne przetrwały");
    }

    /// Piksele muszą zostać nietknięte — inaczej czyszczenie kosztowałoby jakość.
    #[test]
    fn piksele_i_jfif_przezywaja_czyszczenie_jpega() {
        let oczyszczony =
            strip_image_metadata(&jpeg_z_exifem(b"Exif\0\0cokolwiek"), "image/jpeg").unwrap();

        assert!(zawiera(&oczyszczony, b"UDAWANE-PIKSELE"), "utracono dane obrazu");
        assert!(zawiera(&oczyszczony, b"JFIF"), "utracono segment JFIF");
        assert_eq!(&oczyszczony[0..2], &[0xFF, 0xD8], "brak znacznika SOI");
    }

    #[test]
    fn chunki_tekstowe_znikaja_z_pnga() {
        const OPIS: &[u8] = b"Comment\0Zrobione telefonem, 52.2297N 21.0122E";
        let oryginal = png_z_tekstem(OPIS);

        assert!(zawiera(&oryginal, OPIS));

        let oczyszczony = strip_image_metadata(&oryginal, "image/png").unwrap();

        assert!(!zawiera(&oczyszczony, OPIS), "chunk tEXt przetrwał");
        assert!(zawiera(&oczyszczony, b"UDAWANE-PIKSELE"), "utracono dane obrazu");
        assert!(zawiera(&oczyszczony, b"IHDR"), "utracono nagłówek");
        assert!(zawiera(&oczyszczony, b"IEND"), "utracono zakończenie");
    }

    #[test]
    fn nieobslugiwany_typ_przechodzi_bez_zmian() {
        let dane = b"dowolna zawartosc".to_vec();
        assert_eq!(strip_image_metadata(&dane, "video/mp4").unwrap(), dane);
        assert!(!can_strip("video/mp4"));
        assert!(can_strip("image/jpeg"));
    }

    /// Pliki od użytkownika bywają uszkodzone albo spreparowane — parser ma
    /// zwracać błąd, nigdy panikować.
    #[test]
    fn uszkodzone_pliki_nie_powoduja_paniki() {
        let przypadki: Vec<Vec<u8>> = vec![
            vec![],
            vec![0xFF],
            vec![0xFF, 0xD8],
            vec![0xFF, 0xD8, 0xFF, 0xE1, 0xFF, 0xFF],       // deklaruje ogromny segment
            vec![0xFF, 0xD8, 0xFF, 0xE1, 0x00, 0x00],       // długość poniżej minimum
            PNG_SIGNATURE.to_vec(),
            [PNG_SIGNATURE.to_vec(), vec![0xFF; 8]].concat(), // chunk poza plikiem
            vec![0xAB; 128],
        ];

        for dane in przypadki {
            let _ = strip_image_metadata(&dane, "image/jpeg");
            let _ = strip_image_metadata(&dane, "image/png");
        }
    }

    #[test]
    fn czyszczenie_jest_idempotentne() {
        let raz = strip_image_metadata(&jpeg_z_exifem(b"Exif\0\0x"), "image/jpeg").unwrap();
        let dwa = strip_image_metadata(&raz, "image/jpeg").unwrap();
        assert_eq!(raz, dwa);
    }

    fn zawiera(stog: &[u8], igla: &[u8]) -> bool {
        stog.windows(igla.len()).any(|okno| okno == igla)
    }
}
