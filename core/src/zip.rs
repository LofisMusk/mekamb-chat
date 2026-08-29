//! Minimalny ZIP z jednym wpisem — opakowanie kopii zapasowej.
//!
//! # Po co w ogóle ZIP, skoro kopia jest już jednym blobem
//!
//! Wyeksportowana kopia (`kopia`) to samodzielny szyfrogram — z punktu widzenia
//! bezpieczeństwa plik `.zip` niczego nie dodaje. ZIP jest tu **wygodą i
//! rozpoznawalnością**: menedżer plików, mail i chmura traktują `.zip` jak
//! zwykły plik do przeniesienia, a użytkownik od razu wie, co trzyma w ręku.
//!
//! # Dlaczego własny, a nie biblioteka
//!
//! Żeby web i Android tworzyły **bajt w bajt ten sam plik**. Biblioteka ZIP w
//! JS i inna w Kotlinie prędzej czy później rozjechałyby się na szczególe
//! (znacznik czasu, kolejność pól), a wtedy plik z jednego klienta bywałby nie
//! do otwarcia w drugim. Jeden wpis, metoda „stored" (bez kompresji — zawartość
//! jest już skompresowana i zaszyfrowana, więc deflate nic by nie dał) i zerowe
//! znaczniki czasu sprawiają, że format jest krótki, deterministyczny i wspólny.
//!
//! To pełnoprawny ZIP: otworzy go każdy menedżer archiwów. W środku i tak leży
//! sam szyfrogram, więc otwarcie archiwum niczego nie zdradza.

use crate::error::{Error, Result};

/// Największe przyjmowane archiwum i wpis — zapora przed spreparowanym plikiem.
const MAKS: usize = 128 * 1024 * 1024;

/// CRC-32 (IEEE) — ZIP wymaga go przy każdym wpisie.
///
/// Liczony wprost, bez tablicy: wpis jest jeden, więc narzut nie ma znaczenia,
/// a brak tablicy to jedna rzecz mniej, która mogłaby różnić się między
/// platformami.
fn crc32(dane: &[u8]) -> u32 {
    let mut crc = 0xffff_ffffu32;
    for &bajt in dane {
        crc ^= u32::from(bajt);
        for _ in 0..8 {
            let maska = (crc & 1).wrapping_neg();
            crc = (crc >> 1) ^ (0xedb8_8320 & maska);
        }
    }
    !crc
}

/// Pakuje jedną zawartość jako wpis ZIP o podanej nazwie (metoda „stored").
pub fn zapakuj_zip(nazwa_wpisu: &str, zawartosc: &[u8]) -> Result<Vec<u8>> {
    let nazwa = nazwa_wpisu.as_bytes();
    let rozmiar = u32::try_from(zawartosc.len())
        .map_err(|_| Error::InvalidInput("zawartość ZIP za duża".into()))?;
    let dlugosc_nazwy = u16::try_from(nazwa.len())
        .map_err(|_| Error::InvalidInput("nazwa wpisu za długa".into()))?;
    let crc = crc32(zawartosc);

    let mut out = Vec::new();

    // --- Nagłówek lokalny ---
    out.extend_from_slice(&0x0403_4b50u32.to_le_bytes()); // sygnatura "PK\x03\x04"
    out.extend_from_slice(&20u16.to_le_bytes()); // wersja potrzebna do rozpakowania
    out.extend_from_slice(&0u16.to_le_bytes()); // flagi
    out.extend_from_slice(&0u16.to_le_bytes()); // metoda: 0 = stored
    out.extend_from_slice(&0u16.to_le_bytes()); // czas (0 — celowo deterministyczne)
    out.extend_from_slice(&0u16.to_le_bytes()); // data
    out.extend_from_slice(&crc.to_le_bytes());
    out.extend_from_slice(&rozmiar.to_le_bytes()); // rozmiar skompresowany = surowy
    out.extend_from_slice(&rozmiar.to_le_bytes());
    out.extend_from_slice(&dlugosc_nazwy.to_le_bytes());
    out.extend_from_slice(&0u16.to_le_bytes()); // długość pola dodatkowego
    out.extend_from_slice(nazwa);
    let offset_naglowka = 0u32;
    out.extend_from_slice(zawartosc);

    let poczatek_katalogu =
        u32::try_from(out.len()).map_err(|_| Error::InvalidInput("archiwum ZIP za duże".into()))?;

    // --- Katalog centralny (jeden wpis) ---
    out.extend_from_slice(&0x0201_4b50u32.to_le_bytes()); // sygnatura "PK\x01\x02"
    out.extend_from_slice(&20u16.to_le_bytes()); // wersja twórcy
    out.extend_from_slice(&20u16.to_le_bytes()); // wersja potrzebna
    out.extend_from_slice(&0u16.to_le_bytes()); // flagi
    out.extend_from_slice(&0u16.to_le_bytes()); // metoda: stored
    out.extend_from_slice(&0u16.to_le_bytes()); // czas
    out.extend_from_slice(&0u16.to_le_bytes()); // data
    out.extend_from_slice(&crc.to_le_bytes());
    out.extend_from_slice(&rozmiar.to_le_bytes());
    out.extend_from_slice(&rozmiar.to_le_bytes());
    out.extend_from_slice(&dlugosc_nazwy.to_le_bytes());
    out.extend_from_slice(&0u16.to_le_bytes()); // pole dodatkowe
    out.extend_from_slice(&0u16.to_le_bytes()); // komentarz
    out.extend_from_slice(&0u16.to_le_bytes()); // numer dysku
    out.extend_from_slice(&0u16.to_le_bytes()); // atrybuty wewnętrzne
    out.extend_from_slice(&0u32.to_le_bytes()); // atrybuty zewnętrzne
    out.extend_from_slice(&offset_naglowka.to_le_bytes());
    out.extend_from_slice(nazwa);

    let rozmiar_katalogu = u32::try_from(out.len())
        .and_then(|caly| u32::try_from(caly as usize - poczatek_katalogu as usize))
        .map_err(|_| Error::InvalidInput("archiwum ZIP za duże".into()))?;

    // --- Koniec katalogu centralnego (EOCD) ---
    out.extend_from_slice(&0x0605_4b50u32.to_le_bytes()); // "PK\x05\x06"
    out.extend_from_slice(&0u16.to_le_bytes()); // numer dysku
    out.extend_from_slice(&0u16.to_le_bytes()); // dysk z katalogiem
    out.extend_from_slice(&1u16.to_le_bytes()); // wpisów na tym dysku
    out.extend_from_slice(&1u16.to_le_bytes()); // wpisów łącznie
    out.extend_from_slice(&rozmiar_katalogu.to_le_bytes());
    out.extend_from_slice(&poczatek_katalogu.to_le_bytes());
    out.extend_from_slice(&0u16.to_le_bytes()); // komentarz

    Ok(out)
}

/// Wyjmuje zawartość PIERWSZEGO wpisu z archiwum ZIP (metoda „stored").
///
/// Czyta wprost nagłówek lokalny na początku pliku — nie przechodzi katalogu
/// centralnego, bo archiwa, które sami tworzymy, mają dokładnie jeden wpis
/// od offsetu zero. Obce archiwa z kompresją są odrzucane błędem, a nie
/// otwierane po cichu jako śmieci.
pub fn rozpakuj_zip(zip: &[u8]) -> Result<Vec<u8>> {
    // Nagłówek lokalny: 30 bajtów stałych + nazwa + pole dodatkowe.
    if zip.len() < 30 || zip[..4] != 0x0403_4b50u32.to_le_bytes() {
        return Err(Error::InvalidInput("to nie jest archiwum ZIP".into()));
    }

    let metoda = u16::from_le_bytes([zip[8], zip[9]]);
    if metoda != 0 {
        return Err(Error::InvalidInput(
            "archiwum używa kompresji — spodziewamy się wpisu bez kompresji".into(),
        ));
    }

    let rozmiar = u32::from_le_bytes([zip[18], zip[19], zip[20], zip[21]]) as usize;
    let crc_deklarowany = u32::from_le_bytes([zip[14], zip[15], zip[16], zip[17]]);
    let dlugosc_nazwy = u16::from_le_bytes([zip[26], zip[27]]) as usize;
    let dlugosc_extra = u16::from_le_bytes([zip[28], zip[29]]) as usize;

    if rozmiar > MAKS {
        return Err(Error::InvalidInput("wpis ZIP za duży".into()));
    }

    let poczatek = 30 + dlugosc_nazwy + dlugosc_extra;
    let koniec = poczatek
        .checked_add(rozmiar)
        .ok_or_else(|| Error::InvalidInput("uszkodzony nagłówek ZIP".into()))?;
    if zip.len() < koniec {
        return Err(Error::InvalidInput("archiwum ZIP ucięte".into()));
    }

    let zawartosc = zip[poczatek..koniec].to_vec();
    if crc32(&zawartosc) != crc_deklarowany {
        return Err(Error::MessageRejected);
    }
    Ok(zawartosc)
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn pelny_obieg_odtwarza_zawartosc() {
        let dane = b"zaszyfrowana kopia historii";
        let zip = zapakuj_zip("historia.mkbk", dane).unwrap();
        assert_eq!(&zip[..4], b"PK\x03\x04");
        assert_eq!(rozpakuj_zip(&zip).unwrap(), dane);
    }

    #[test]
    fn pusta_zawartosc_dziala() {
        let zip = zapakuj_zip("x", b"").unwrap();
        assert_eq!(rozpakuj_zip(&zip).unwrap(), b"");
    }

    #[test]
    fn nie_zip_jest_odrzucany() {
        assert!(matches!(
            rozpakuj_zip(b"to nie jest zip"),
            Err(Error::InvalidInput(_))
        ));
        assert!(matches!(rozpakuj_zip(&[]), Err(Error::InvalidInput(_))));
    }

    #[test]
    fn przekrecony_bajt_lapie_crc() {
        let mut zip = zapakuj_zip("h", b"tresc do zepsucia").unwrap();
        // Psujemy bajt zawartości (za 30-bajtowym nagłówkiem + 1-znakową nazwą).
        let i = 30 + 1 + 5;
        zip[i] ^= 0xff;
        assert!(matches!(rozpakuj_zip(&zip), Err(Error::MessageRejected)));
    }

    #[test]
    fn crc32_znane_wektory() {
        // Wektory z normy: pusty ciąg i „123456789".
        assert_eq!(crc32(b""), 0x0000_0000);
        assert_eq!(crc32(b"123456789"), 0xcbf4_3926);
    }
}
