//! Dostawca kryptografii i magazynu wraz z zapisem stanu.
//!
//! # Po co własny provider zamiast `OpenMlsRustCrypto`
//!
//! Gotowy provider z OpenMLS trzyma magazyn w prywatnym polu i nie pozwala go
//! ani odczytać w całości, ani wstrzyknąć. Dla aplikacji serwerowej to bez
//! znaczenia, dla klienta — przeciwnie: przeglądarka musi odtworzyć stan MLS
//! po odświeżeniu strony, a telefon po ubiciu procesu. Bez tego każda rozmowa
//! ginęłaby przy zamknięciu aplikacji.
//!
//! Składamy więc własny provider z publicznych części: `RustCrypto` odpowiada
//! za kryptografię, `MemoryStorage` za przechowywanie, a my dokładamy eksport
//! i import.
//!
//! # Migawka, nie zapis przyrostowy
//!
//! [`MekambProvider::export_state`] zrzuca **cały** stan naraz. Przy kilkunastu
//! rozmowach to kilkadziesiąt kilobajtów, więc zapis po każdej zmianie jest
//! całkowicie znośny i znacznie prostszy niż śledzenie różnic. Gdyby stan
//! kiedyś urósł, zapis przyrostowy wymaga podmiany wyłącznie tego modułu.

use openmls_memory_storage::MemoryStorage;
use openmls_rust_crypto::RustCrypto;
use openmls_traits::OpenMlsProvider;

use crate::error::{Error, Result};

/// Dostawca kryptografii i magazynu dla jednego urządzenia.
#[derive(Default, Debug)]
pub struct MekambProvider {
    crypto: RustCrypto,
    storage: MemoryStorage,
}

impl OpenMlsProvider for MekambProvider {
    type CryptoProvider = RustCrypto;
    type RandProvider = RustCrypto;
    type StorageProvider = MemoryStorage;

    fn storage(&self) -> &Self::StorageProvider {
        &self.storage
    }

    fn crypto(&self) -> &Self::CryptoProvider {
        &self.crypto
    }

    fn rand(&self) -> &Self::RandProvider {
        &self.crypto
    }
}

impl MekambProvider {
    /// Tworzy pusty magazyn.
    pub fn new() -> Self {
        Self::default()
    }

    /// Zrzuca stan MLS do bajtów.
    ///
    /// # To są klucze prywatne
    ///
    /// Zrzut zawiera materiał kluczy: klucze podpisu, sekrety epok, stan
    /// ratchetu. Zapisanie go w postaci jawnej gdziekolwiek — IndexedDB, plik,
    /// kopia zapasowa — jest równoznaczne z oddaniem wszystkich rozmów.
    ///
    /// Wywołujący **musi** zaszyfrować wynik przed zapisem: kluczem z Android
    /// Keystore na telefonie, kluczem z rozszerzenia WebAuthn PRF albo
    /// wyprowadzonym z hasła w przeglądarce.
    ///
    /// Nazwa jest celowo krzykliwa, żeby każde użycie rzucało się w oczy przy
    /// przeglądzie kodu.
    pub fn export_state_containing_private_keys(&self) -> Vec<u8> {
        let values = self
            .storage
            .values
            .read()
            .expect("magazyn nie jest współdzielony między wątkami");

        // Format: [liczba wpisów u32][długość klucza u32][klucz][długość wartości u32][wartość]...
        // Prosty i samoopisujący się; nie potrzebujemy tu zgodności z niczym
        // zewnętrznym, bo zrzut nigdy nie opuszcza urządzenia.
        let mut out = Vec::new();
        out.extend_from_slice(&(values.len() as u32).to_be_bytes());

        for (key, value) in values.iter() {
            out.extend_from_slice(&(key.len() as u32).to_be_bytes());
            out.extend_from_slice(key);
            out.extend_from_slice(&(value.len() as u32).to_be_bytes());
            out.extend_from_slice(value);
        }

        out
    }

    /// Odtwarza magazyn ze zrzutu.
    ///
    /// Dane wejściowe traktujemy jako potencjalnie uszkodzone — zwracamy błąd,
    /// nigdy nie panikujemy.
    pub fn import_state(bytes: &[u8]) -> Result<Self> {
        let mut cursor = Cursor::new(bytes);
        let count = cursor.read_u32()?;

        let provider = Self::new();
        {
            let mut values = provider
                .storage
                .values
                .write()
                .expect("magazyn nie jest współdzielony między wątkami");

            for _ in 0..count {
                let key_len = cursor.read_u32()? as usize;
                let key = cursor.read_bytes(key_len)?;
                let value_len = cursor.read_u32()? as usize;
                let value = cursor.read_bytes(value_len)?;
                values.insert(key, value);
            }
        }

        if !cursor.is_exhausted() {
            return Err(Error::Storage(
                "zrzut stanu zawiera nadmiarowe bajty".into(),
            ));
        }

        Ok(provider)
    }

    /// Liczba wpisów w magazynie. Przydatne w testach i diagnostyce.
    pub fn entry_count(&self) -> usize {
        self.storage
            .values
            .read()
            .expect("magazyn nie jest współdzielony między wątkami")
            .len()
    }
}

/// Odczyt bajtów z kontrolą zakresu.
struct Cursor<'a> {
    bytes: &'a [u8],
    position: usize,
}

impl<'a> Cursor<'a> {
    fn new(bytes: &'a [u8]) -> Self {
        Self { bytes, position: 0 }
    }

    fn read_u32(&mut self) -> Result<u32> {
        let raw = self.read_bytes(4)?;
        Ok(u32::from_be_bytes([raw[0], raw[1], raw[2], raw[3]]))
    }

    fn read_bytes(&mut self, len: usize) -> Result<Vec<u8>> {
        let end = self
            .position
            .checked_add(len)
            .ok_or_else(|| Error::Storage("zrzut stanu deklaruje zbyt duży rozmiar".into()))?;

        if end > self.bytes.len() {
            return Err(Error::Storage("zrzut stanu jest niekompletny".into()));
        }

        let slice = self.bytes[self.position..end].to_vec();
        self.position = end;
        Ok(slice)
    }

    fn is_exhausted(&self) -> bool {
        self.position == self.bytes.len()
    }
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn pusty_magazyn_robi_pelne_kolo() {
        let provider = MekambProvider::new();
        let zrzut = provider.export_state_containing_private_keys();

        let odtworzony = MekambProvider::import_state(&zrzut).unwrap();
        assert_eq!(odtworzony.entry_count(), 0);
    }

    #[test]
    fn uszkodzony_zrzut_jest_odrzucany() {
        // Deklaruje jeden wpis, ale nie ma za nim żadnych danych.
        let zly = 1u32.to_be_bytes().to_vec();
        assert!(MekambProvider::import_state(&zly).is_err());

        // Deklaruje absurdalną długość klucza.
        let mut ogromny = 1u32.to_be_bytes().to_vec();
        ogromny.extend_from_slice(&u32::MAX.to_be_bytes());
        assert!(MekambProvider::import_state(&ogromny).is_err());

        // Nadmiarowe bajty na końcu oznaczają, że format się nie zgadza.
        let mut nadmiar = 0u32.to_be_bytes().to_vec();
        nadmiar.push(0xFF);
        assert!(MekambProvider::import_state(&nadmiar).is_err());
    }

    #[test]
    fn smieci_nie_powoduja_paniki() {
        for bajty in [vec![], vec![0xFF], vec![0xFF; 3], vec![0xAB; 64]] {
            let _ = MekambProvider::import_state(&bajty);
        }
    }
}
