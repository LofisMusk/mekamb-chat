//! Kopia zapasowa historii chroniona hasłem.
//!
//! # Po co to istnieje, skoro jest już transfer optyczny
//!
//! Transfer optyczny (`optyka`) przenosi historię między dwoma urządzeniami tej
//! samej osoby **w tej samej chwili** — nic nie ląduje na dysku. Kopia zapasowa
//! to co innego: użytkownik chce wyeksportować rozmowy do **pliku**, odłożyć go
//! i wczytać kiedy indziej, może na innym urządzeniu. Plik zostaje w magazynie,
//! więc — inaczej niż przy transferze optycznym — jest realnie narażony.
//!
//! # Dlaczego hasło, a nie klucz z urządzenia
//!
//! Historia w skarbcu jest zaszyfrowana kluczem z Keystore/enklawy, który **nie
//! opuszcza urządzenia**. Do pliku, który ma dać się otworzyć gdzie indziej,
//! tego klucza użyć nie można. Zostaje sekret, który zna wyłącznie człowiek:
//! hasło. Zrzucenie samego JSON-a do pliku (choćby „w zipie") oddałoby całą
//! treść rozmów każdemu, kto ten plik przeczyta — a to jest dokładnie to, przed
//! czym broni się reszta projektu (`docs/THREAT_MODEL.md`).
//!
//! # Dlaczego Argon2id, a nie HKDF/PBKDF2
//!
//! Plik chroni **tylko** hasło, a hasła bywają słabe. HKDF i PBKDF2 liczą się
//! na GPU miliardami na sekundę, więc słownik przeszedłby słabe hasło w chwilę.
//! Argon2id jest memory-hard: każda próba kosztuje pamięć, więc atak masowy jest
//! drogi. Parametry są przypięte do wersji formatu (poniżej) — zmiana wymaga
//! nowej wersji, żeby stary plik dało się nadal otworzyć.
//!
//! # Format kontenera
//!
//! ```text
//! MAGIA(4) | WERSJA(1) | salt(16) | nonce(12) | szyfrogram(AES-256-GCM)
//! ```
//!
//! Szyfrogram to `AES-256-GCM(deflate(jawne))`. Kompresja **przed** szyfrowaniem,
//! bo szyfrogram jest nieściśliwy — a historia to głównie tekst, więc plik
//! wychodzi znacznie mniejszy. Ten sam kontener otwiera web i Android: to jest
//! kod współdzielony w rdzeniu, nie dwie implementacje, które mogłyby się
//! rozjechać na formacie.

use aes_gcm::aead::rand_core::RngCore;
use aes_gcm::aead::{Aead, AeadCore, KeyInit, OsRng};
use aes_gcm::{Aes256Gcm, Key, Nonce};
use argon2::{Algorithm, Argon2, Params, Version};
use zeroize::Zeroize;

use crate::error::{Error, Result};

/// Znacznik pliku — cztery bajty „MKBK" (Mekamb Kopia).
const MAGIA: [u8; 4] = *b"MKBK";

/// Wersja formatu. Zmiana kształtu albo parametrów KDF wymaga jej podniesienia,
/// żeby stary plik dało się nadal rozpoznać i otworzyć właściwym kodem.
const WERSJA: u8 = 1;

/// Długość soli KDF w bajtach.
const SOL: usize = 16;

/// Nagłówek jawny przed szyfrogramem: `MAGIA + WERSJA + salt + nonce`.
const NAGLOWEK: usize = MAGIA.len() + 1 + SOL + 12;

/// Największa przyjmowana treść po rozpakowaniu.
///
/// Zapora przed bombą kompresyjną: plik przychodzi z zewnątrz, więc źródło jest
/// niezaufane. Ta sama granica co w transferze optycznym.
const MAKS_PO_ROZPAKOWANIU: usize = 64 * 1024 * 1024;

/// Parametry Argon2id przypięte do [`WERSJA`].
///
/// 19 MiB pamięci, 2 przebiegi, jeden wątek — rekomendacja OWASP dla Argon2id,
/// a jednocześnie wielkość, którą uciągnie i telefon, i pojedynczy wątek WASM
/// w przeglądarce. Zapisane jako stałe, bo muszą być **identyczne** przy
/// pieczętowaniu i otwieraniu; gdyby się rozjechały, poprawne hasło nie
/// odtworzyłoby klucza.
const PAMIEC_KIB: u32 = 19 * 1024;
const PRZEBIEGI: u32 = 2;
const WATKI: u32 = 1;

/// Wyprowadza 32-bajtowy klucz z hasła i soli — Argon2id o stałych parametrach.
fn klucz_z_hasla(haslo: &str, sol: &[u8]) -> Result<[u8; 32]> {
    let params = Params::new(PAMIEC_KIB, PRZEBIEGI, WATKI, Some(32))
        .map_err(|_| Error::InvalidInput("złe parametry Argon2".into()))?;
    let argon = Argon2::new(Algorithm::Argon2id, Version::V0x13, params);

    let mut klucz = [0u8; 32];
    argon
        .hash_password_into(haslo.as_bytes(), sol, &mut klucz)
        .map_err(|_| Error::InvalidInput("nie udało się wyprowadzić klucza z hasła".into()))?;
    Ok(klucz)
}

/// Pieczętuje jawne dane pod hasłem: kompresja, wyprowadzenie klucza, AES-256-GCM.
///
/// Zwraca gotowy kontener (patrz format modułu). Puste hasło jest odrzucane —
/// „bez hasła" to nie zabezpieczenie, tylko jawny zrzut pod inną nazwą, a przed
/// tym cały ten moduł ma bronić.
pub fn seal_backup(haslo: &str, jawne: &[u8]) -> Result<Vec<u8>> {
    if haslo.is_empty() {
        return Err(Error::InvalidInput("hasło nie może być puste".into()));
    }

    let mut sol = [0u8; SOL];
    OsRng.fill_bytes(&mut sol);

    let mut klucz = klucz_z_hasla(haslo, &sol)?;
    let szyfr = Aes256Gcm::new(Key::<Aes256Gcm>::from_slice(&klucz));
    klucz.zeroize();

    let nonce = Aes256Gcm::generate_nonce(&mut OsRng);
    let spakowane = miniz_oxide::deflate::compress_to_vec(jawne, 6);
    let szyfrogram = szyfr
        .encrypt(&nonce, spakowane.as_ref())
        .map_err(|_| Error::InvalidInput("nie udało się zaszyfrować kopii".into()))?;

    let mut kontener = Vec::with_capacity(NAGLOWEK + szyfrogram.len());
    kontener.extend_from_slice(&MAGIA);
    kontener.push(WERSJA);
    kontener.extend_from_slice(&sol);
    kontener.extend_from_slice(nonce.as_slice());
    kontener.extend_from_slice(&szyfrogram);
    Ok(kontener)
}

/// Otwiera kontener pod hasłem: sprawdza nagłówek, wyprowadza klucz, odszyfrowuje,
/// rozpakowuje.
///
/// Złe hasło i uszkodzony plik dają ten sam błąd [`Error::MessageRejected`]: AES-GCM
/// nie odróżnia „nie ten klucz" od „przekręcony bajt", i słusznie — obie
/// odpowiedzi znaczą „tego pliku nie otworzysz tym hasłem". Nieznana wersja albo
/// obcy znacznik to [`Error::InvalidInput`]: to nie jest nasz plik, a nie
/// „złe hasło".
pub fn open_backup(haslo: &str, kontener: &[u8]) -> Result<Vec<u8>> {
    if kontener.len() < NAGLOWEK {
        return Err(Error::InvalidInput("plik jest za krótki na kopię".into()));
    }
    if kontener[..MAGIA.len()] != MAGIA {
        return Err(Error::InvalidInput("to nie jest plik kopii Mekamb".into()));
    }
    if kontener[MAGIA.len()] != WERSJA {
        return Err(Error::InvalidInput(format!(
            "nieznana wersja kopii: {}",
            kontener[MAGIA.len()]
        )));
    }

    let po_wersji = MAGIA.len() + 1;
    let sol = &kontener[po_wersji..po_wersji + SOL];
    let nonce = &kontener[po_wersji + SOL..NAGLOWEK];
    let szyfrogram = &kontener[NAGLOWEK..];

    let mut klucz = klucz_z_hasla(haslo, sol)?;
    let szyfr = Aes256Gcm::new(Key::<Aes256Gcm>::from_slice(&klucz));
    klucz.zeroize();

    let spakowane = szyfr
        .decrypt(Nonce::from_slice(nonce), szyfrogram)
        .map_err(|_| Error::MessageRejected)?;

    miniz_oxide::inflate::decompress_to_vec_with_limit(&spakowane, MAKS_PO_ROZPAKOWANIU)
        .map_err(|_| Error::MessageRejected)
}

/// Nazwa jedynego wpisu w archiwum — czym jest plik, widać po rozszerzeniu.
const NAZWA_WPISU: &str = "historia.mkbk";

/// Eksportuje jawną historię do gotowego pliku `.zip` chronionego hasłem.
///
/// Łączy [`seal_backup`] z [`crate::zip::zapakuj_zip`] w jednej kolejności, więc
/// klient robi jedno wywołanie i nie ma jak pomylić „najpierw zaszyfruj, potem
/// spakuj". Plik jest prawdziwym ZIP-em, a w środku sam szyfrogram.
pub fn export_backup(haslo: &str, jawne: &[u8]) -> Result<Vec<u8>> {
    let zapieczetowane = seal_backup(haslo, jawne)?;
    crate::zip::zapakuj_zip(NAZWA_WPISU, &zapieczetowane)
}

/// Otwiera plik `.zip` kopii pod hasłem i zwraca jawną historię.
///
/// Odwrotność [`export_backup`]: rozpakowuje ZIP i otwiera szyfrogram. Złe hasło
/// albo uszkodzony plik dają błąd, nie zniekształconą historię.
pub fn import_backup(haslo: &str, zip: &[u8]) -> Result<Vec<u8>> {
    let zapieczetowane = crate::zip::rozpakuj_zip(zip)?;
    open_backup(haslo, &zapieczetowane)
}

#[cfg(test)]
mod tests {
    use super::*;

    /// Podstawa: co zapieczętowane, to po tym samym haśle wychodzi bez zmian.
    #[test]
    fn pelny_obieg_odtwarza_dane() {
        let jawne = b"{\"rozmowy\":{\"a\":{\"wiadomosci\":[]}},\"wersja\":5}";
        let plik = seal_backup("poprawne-haslo", jawne).unwrap();
        assert_eq!(open_backup("poprawne-haslo", &plik).unwrap(), jawne);
    }

    /// Złe hasło ma odpaść błędem, a nie wydać śmieci uznane za historię.
    #[test]
    fn zle_haslo_nie_otwiera() {
        let plik = seal_backup("prawdziwe", b"tajna historia").unwrap();
        assert!(matches!(
            open_backup("zgadywane", &plik),
            Err(Error::MessageRejected)
        ));
    }

    /// Puste hasło to nie zabezpieczenie — pieczętowanie musi go odmówić.
    #[test]
    fn puste_haslo_jest_odrzucane() {
        assert!(matches!(
            seal_backup("", b"cokolwiek"),
            Err(Error::InvalidInput(_))
        ));
    }

    /// Dwa pieczętowania tej samej treści dają różne pliki: losowa sól i nonce.
    /// Powtarzalny szyfrogram zdradzałby, że dwie kopie mają tę samą zawartość.
    #[test]
    fn dwa_zapiecietowania_sie_roznia() {
        let a = seal_backup("h", b"to samo").unwrap();
        let b = seal_backup("h", b"to samo").unwrap();
        assert_ne!(a, b);
        assert_eq!(open_backup("h", &a).unwrap(), open_backup("h", &b).unwrap());
    }

    /// Przekręcony bajt szyfrogramu wykrywa znacznik AES-GCM — plik się nie
    /// otworzy, zamiast wydać uszkodzoną historię.
    #[test]
    fn przekrecony_bajt_jest_wykryty() {
        let mut plik = seal_backup("h", b"historia do zepsucia").unwrap();
        let ostatni = plik.len() - 1;
        plik[ostatni] ^= 0xff;
        assert!(open_backup("h", &plik).is_err());
    }

    /// Obcy plik nie jest „złym hasłem": nagłówek rozpoznaje, że to nie kopia.
    #[test]
    fn obcy_plik_odrzucony_po_naglowku() {
        assert!(matches!(
            open_backup("h", b"PK\x03\x04 zwykly zip"),
            Err(Error::InvalidInput(_))
        ));
        assert!(matches!(open_backup("h", &[]), Err(Error::InvalidInput(_))));
    }

    /// Nieznana wersja formatu to komunikat, a nie próba deszyfrowania cudzego
    /// kształtu — inaczej nowszy plik wyglądałby jak złe hasło.
    #[test]
    fn nieznana_wersja_jest_rozpoznana() {
        let mut plik = seal_backup("h", b"cos").unwrap();
        plik[MAGIA.len()] = 99;
        assert!(matches!(
            open_backup("h", &plik),
            Err(Error::InvalidInput(_))
        ));
    }

    /// Pełny obieg przez ZIP: eksport daje prawdziwy plik ZIP, a import pod tym
    /// samym hasłem odtwarza jawną historię co do bajtu.
    #[test]
    fn eksport_import_przez_zip() {
        let jawne = b"{\"rozmowy\":{},\"wersja\":5}";
        let plik = export_backup("h", jawne).unwrap();
        assert_eq!(&plik[..4], b"PK\x03\x04", "eksport nie jest plikiem ZIP");
        assert_eq!(import_backup("h", &plik).unwrap(), jawne);
        assert!(matches!(
            import_backup("złe", &plik),
            Err(Error::MessageRejected)
        ));
    }

    /// Historia to głównie tekst — kontener ma być wyraźnie mniejszy niż jawne
    /// dane, inaczej kompresja przed szyfrowaniem niczego nie daje.
    #[test]
    fn tekst_sie_kompresuje() {
        let jawne = "{\"tresc\":\"dzień dobry\"}\n".repeat(500);
        let plik = seal_backup("h", jawne.as_bytes()).unwrap();
        assert!(
            plik.len() < jawne.len() / 2,
            "kontener {} B na {} B jawnych — kompresja nie zadziałała",
            plik.len(),
            jawne.len()
        );
        assert_eq!(open_backup("h", &plik).unwrap(), jawne.as_bytes());
    }
}
