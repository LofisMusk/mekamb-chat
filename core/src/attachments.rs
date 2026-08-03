//! Szyfrowanie załączników.
//!
//! # Dlaczego załącznik ma własny klucz, a nie klucz rozmowy
//!
//! Każdy załącznik dostaje **świeży, losowy** klucz i nonce. Kusi, żeby
//! wyprowadzić je z sekretu grupy — byłoby mniej danych do przenoszenia.
//! Nie robimy tego z dwóch powodów:
//!
//! 1. **Nonce w AES-GCM nie może się powtórzyć.** Powtórzenie pary
//!    (klucz, nonce) w GCM nie osłabia szyfru „trochę" — pozwala odzyskać
//!    strumień klucza i sfałszować dowolną wiadomość. Świeży klucz na
//!    załącznik usuwa tę możliwość z definicji, zamiast polegać na poprawnym
//!    liczeniu licznika.
//! 2. **Ujawnienie jednego załącznika nie ujawnia pozostałych.** Klucz można
//!    przekazać dalej (np. przy udostępnianiu pojedynczego pliku) bez
//!    konsekwencji dla reszty rozmowy.
//!
//! Klucz podróżuje w [`crate::framing::AttachmentBody`], czyli **wewnątrz**
//! wiadomości MLS. Serwer przechowuje wyłącznie szyfrogram i nie ma jak go
//! odczytać.
//!
//! # Czego to nie ukrywa
//!
//! Rozmiaru. Serwer widzi, ile bajtów zajmuje załącznik, a to zdradza sporo
//! o jego rodzaju. Dopełnianie plików do stałych progów byłoby kosztowne przy
//! wideo; świadomie tego nie robimy i odnotowujemy w modelu zagrożeń.

use aes_gcm::aead::{Aead, KeyInit, Payload};
use aes_gcm::{Aes256Gcm, Key, Nonce};
use rand::{TryRng, rngs::SysRng};
use zeroize::Zeroize;

use crate::error::{Error, Result};

/// Długość klucza załącznika.
pub const ATTACHMENT_KEY_LEN: usize = 32;

/// Długość nonce'a AES-GCM.
pub const ATTACHMENT_NONCE_LEN: usize = 12;

/// Górny limit rozmiaru pojedynczego załącznika.
///
/// 25 MB to kompromis: mieści zdjęcia i krótkie wideo z telefonu, a jednocześnie
/// nie wymaga przesyłania wieloczęściowego. Większe pliki wymagałyby wysyłki
/// prosto do R2 z pominięciem Workera — to osobna funkcja, nie zmiana stałej.
pub const MAX_ATTACHMENT_BYTES: usize = 25 * 1024 * 1024;

/// Zaszyfrowany załącznik wraz z materiałem potrzebnym do odczytu.
pub struct SealedAttachment {
    /// Do wysłania na serwer. Nieczytelne bez klucza.
    pub ciphertext: Vec<u8>,
    /// **Sekret.** Podróżuje wewnątrz wiadomości MLS, nigdy obok szyfrogramu.
    pub key: [u8; ATTACHMENT_KEY_LEN],
    pub nonce: [u8; ATTACHMENT_NONCE_LEN],
}

/// Szyfruje załącznik świeżym kluczem.
///
/// `mime_type` trafia do danych uwierzytelnionych, więc podmiana deklarowanego
/// typu pliku unieważnia szyfrogram. Bez tego serwer albo pośrednik mógłby
/// podać wideo jako obraz i skierować je do innego dekodera niż zamierzony.
pub fn seal_attachment(plaintext: &[u8], mime_type: &str) -> Result<SealedAttachment> {
    if plaintext.is_empty() {
        return Err(Error::InvalidInput("załącznik jest pusty".into()));
    }
    if plaintext.len() > MAX_ATTACHMENT_BYTES {
        return Err(Error::InvalidInput(format!(
            "załącznik ma {} bajtów, limit to {MAX_ATTACHMENT_BYTES}",
            plaintext.len()
        )));
    }

    let mut key_bytes = [0u8; ATTACHMENT_KEY_LEN];
    let mut nonce_bytes = [0u8; ATTACHMENT_NONCE_LEN];
    SysRng
        .try_fill_bytes(&mut key_bytes)
        .and_then(|()| SysRng.try_fill_bytes(&mut nonce_bytes))
        .expect("systemowy generator losowy musi być dostępny");

    let cipher = Aes256Gcm::new(Key::<Aes256Gcm>::from_slice(&key_bytes));

    let ciphertext = cipher
        .encrypt(
            Nonce::from_slice(&nonce_bytes),
            Payload { msg: plaintext, aad: mime_type.as_bytes() },
        )
        .map_err(|_| Error::Group("nie udało się zaszyfrować załącznika".into()))?;

    Ok(SealedAttachment { ciphertext, key: key_bytes, nonce: nonce_bytes })
}

/// Odszyfrowuje załącznik pobrany z serwera.
///
/// Zwraca błąd, gdy szyfrogram został zmieniony, klucz jest zły albo
/// `mime_type` nie zgadza się z tym, który podano przy szyfrowaniu.
pub fn open_attachment(
    ciphertext: &[u8],
    key: &[u8],
    nonce: &[u8],
    mime_type: &str,
) -> Result<Vec<u8>> {
    if key.len() != ATTACHMENT_KEY_LEN {
        return Err(Error::InvalidInput(format!(
            "klucz załącznika ma {} bajtów, oczekiwano {ATTACHMENT_KEY_LEN}",
            key.len()
        )));
    }
    if nonce.len() != ATTACHMENT_NONCE_LEN {
        return Err(Error::InvalidInput(format!(
            "nonce ma {} bajtów, oczekiwano {ATTACHMENT_NONCE_LEN}",
            nonce.len()
        )));
    }

    // Limit sprawdzamy PRZED deszyfrowaniem: bez tego wystarczyłoby podać
    // ogromny szyfrogram, żeby wyczerpać pamięć odbiorcy.
    if ciphertext.len() > MAX_ATTACHMENT_BYTES + 64 {
        return Err(Error::InvalidInput("szyfrogram załącznika przekracza limit".into()));
    }

    let cipher = Aes256Gcm::new(Key::<Aes256Gcm>::from_slice(key));

    cipher
        .decrypt(
            Nonce::from_slice(nonce),
            Payload { msg: ciphertext, aad: mime_type.as_bytes() },
        )
        // Bez szczegółów: rozróżnianie „zły klucz" od „naruszony szyfrogram"
        // dawałoby atakującemu oracle.
        .map_err(|_| Error::MessageRejected)
}

impl Drop for SealedAttachment {
    fn drop(&mut self) {
        self.key.zeroize();
        self.nonce.zeroize();
    }
}

impl std::fmt::Debug for SealedAttachment {
    fn fmt(&self, f: &mut std::fmt::Formatter<'_>) -> std::fmt::Result {
        f.debug_struct("SealedAttachment")
            .field("ciphertext_len", &self.ciphertext.len())
            .field("key", &"***")
            .finish()
    }
}

#[cfg(test)]
mod tests {
    use super::*;

    const OBRAZ: &str = "image/jpeg";

    #[test]
    fn zalacznik_robi_pelne_kolo() {
        let plik = b"udawana zawartosc zdjecia".repeat(100);

        let zapieczetowany = seal_attachment(&plik, OBRAZ).unwrap();
        let odczytany =
            open_attachment(&zapieczetowany.ciphertext, &zapieczetowany.key, &zapieczetowany.nonce, OBRAZ)
                .unwrap();

        assert_eq!(odczytany, plik);
    }

    /// Sedno: serwer przechowuje szyfrogram, więc nie może w nim być treści.
    #[test]
    fn tresc_nie_wystepuje_w_szyfrogramie() {
        const SEKRET: &[u8] = b"ZDJECIE-DOWODU-OSOBISTEGO";
        let zapieczetowany = seal_attachment(SEKRET, OBRAZ).unwrap();

        assert!(
            !zapieczetowany
                .ciphertext
                .windows(SEKRET.len())
                .any(|okno| okno == SEKRET),
            "treść załącznika znaleziona w szyfrogramie"
        );
    }

    #[test]
    fn kazdy_zalacznik_dostaje_inny_klucz() {
        let a = seal_attachment(b"to samo", OBRAZ).unwrap();
        let b = seal_attachment(b"to samo", OBRAZ).unwrap();

        assert_ne!(a.key, b.key, "powtórzony klucz");
        assert_ne!(a.nonce, b.nonce, "powtórzony nonce");
        // Ten sam plik musi dać różne szyfrogramy, inaczej obserwator
        // rozpoznawałby powtórzenia.
        assert_ne!(a.ciphertext, b.ciphertext);
    }

    #[test]
    fn zmodyfikowany_szyfrogram_jest_odrzucany() {
        let mut zapieczetowany = seal_attachment(b"oryginal", OBRAZ).unwrap();
        let ostatni = zapieczetowany.ciphertext.len() - 1;
        zapieczetowany.ciphertext[ostatni] ^= 0x01;

        assert!(
            open_attachment(&zapieczetowany.ciphertext, &zapieczetowany.key, &zapieczetowany.nonce, OBRAZ)
                .is_err()
        );
    }

    /// Typ pliku jest uwierzytelniony, więc nie da się podać wideo jako obrazu.
    #[test]
    fn podmiana_typu_pliku_uniewaznia_szyfrogram() {
        let zapieczetowany = seal_attachment(b"zawartosc", OBRAZ).unwrap();

        assert!(
            open_attachment(
                &zapieczetowany.ciphertext,
                &zapieczetowany.key,
                &zapieczetowany.nonce,
                "video/mp4",
            )
            .is_err(),
            "podmieniony mime_type został przyjęty"
        );
    }

    #[test]
    fn obcy_klucz_nie_odszyfruje() {
        let zapieczetowany = seal_attachment(b"tajne", OBRAZ).unwrap();

        assert!(
            open_attachment(&zapieczetowany.ciphertext, &[7u8; 32], &zapieczetowany.nonce, OBRAZ)
                .is_err()
        );
    }

    #[test]
    fn nieprawidlowe_rozmiary_sa_odrzucane() {
        let zapieczetowany = seal_attachment(b"x", OBRAZ).unwrap();

        assert!(open_attachment(&zapieczetowany.ciphertext, &[0u8; 16], &zapieczetowany.nonce, OBRAZ).is_err());
        assert!(open_attachment(&zapieczetowany.ciphertext, &zapieczetowany.key, &[0u8; 8], OBRAZ).is_err());
    }

    #[test]
    fn pusty_i_za_duzy_zalacznik_sa_odrzucane() {
        assert!(seal_attachment(b"", OBRAZ).is_err());
        assert!(seal_attachment(&vec![0u8; MAX_ATTACHMENT_BYTES + 1], OBRAZ).is_err());
    }

    #[test]
    fn klucz_nie_wycieka_przez_debug() {
        let zapieczetowany = seal_attachment(b"tajne", OBRAZ).unwrap();
        assert!(format!("{zapieczetowany:?}").contains("***"));
    }
}
