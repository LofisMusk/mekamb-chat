//! Koperta transportowa — zewnętrzna warstwa routingu.
//!
//! # Co jest, a co nie jest zaszyfrowane
//!
//! Koperta jest **na zewnątrz** szyfrowania MLS. Jej pole `payload` to gotowa
//! wiadomość MLS (nieczytelna dla nikogo poza grupą), ale `group_id` i `kind`
//! są jawne — odbiorca musi wiedzieć, do której rozmowy skierować ładunek,
//! zanim będzie w stanie cokolwiek odszyfrować.
//!
//! Przy dostarczaniu bezpośrednim (iroh) koperta jest dodatkowo zamknięta
//! w szyfrowaniu QUIC/TLS, więc widzi ją wyłącznie druga strona. Przy
//! doręczaniu przez skrzynkę serwerową `group_id` jest widoczny dla serwera.
//! To świadomie akceptowany wyciek: serwer i tak zna skład grup, bo przez niego
//! przechodzą commity. Patrz `docs/THREAT_MODEL.md`.

use crate::error::{Error, Result};

/// Wersja formatu koperty.
pub const ENVELOPE_VERSION: u32 = 1;

/// Górny limit rozmiaru koperty.
///
/// Bez limitu peer mógłby zestawić strumień i wysyłać w nieskończoność,
/// wyczerpując pamięć odbiorcy. Duże pliki idą osobnym kanałem (R2 albo własny
/// strumień), a nie w kopercie wiadomości.
pub const MAX_ENVELOPE_BYTES: usize = 1024 * 1024;

/// Rodzaj przenoszonej wiadomości MLS.
///
/// Rozróżnienie jest istotne, bo commity i wiadomości aplikacyjne idą różnymi
/// drogami: commity wymagają autorytatywnej kolejności z `GroupRelay`,
/// wiadomości nie.
#[derive(Clone, Copy, Debug, PartialEq, Eq, prost::Enumeration)]
#[repr(i32)]
pub enum EnvelopeKind {
    Unspecified = 0,
    /// Wiadomość aplikacyjna — może iść bezpośrednio P2P.
    Application = 1,
    /// Commit zmieniający epokę — wymaga kolejności z `GroupRelay`.
    Commit = 2,
    /// Welcome dla nowo dodanego członka.
    Welcome = 3,
}

#[derive(Clone, PartialEq, prost::Message)]
pub struct Envelope {
    #[prost(uint32, tag = "1")]
    pub version: u32,

    #[prost(bytes = "vec", tag = "2")]
    pub group_id: Vec<u8>,

    #[prost(enumeration = "EnvelopeKind", tag = "3")]
    pub kind: i32,

    /// Zserializowana wiadomość MLS. Nieczytelna poza grupą.
    #[prost(bytes = "vec", tag = "4")]
    pub payload: Vec<u8>,
}

impl Envelope {
    pub fn new(group_id: Vec<u8>, kind: EnvelopeKind, payload: Vec<u8>) -> Self {
        Self {
            version: ENVELOPE_VERSION,
            group_id,
            kind: kind as i32,
            payload,
        }
    }

    pub fn encode_to_vec(&self) -> Vec<u8> {
        prost::Message::encode_to_vec(self)
    }

    /// Parsuje kopertę odebraną z sieci.
    ///
    /// Dane wejściowe są wrogie z założenia — każdy błąd kończy się `Err`,
    /// nigdy paniką.
    pub fn decode(bytes: &[u8]) -> Result<Self> {
        if bytes.len() > MAX_ENVELOPE_BYTES {
            return Err(Error::Framing(format!(
                "koperta ma {} bajtów, limit to {MAX_ENVELOPE_BYTES}",
                bytes.len()
            )));
        }

        let envelope = <Self as prost::Message>::decode(bytes)
            .map_err(|e| Error::Framing(format!("nie udało się zdekodować koperty: {e}")))?;

        if envelope.version != ENVELOPE_VERSION {
            return Err(Error::Framing(format!(
                "nieobsługiwana wersja koperty: {} (obsługiwana: {ENVELOPE_VERSION})",
                envelope.version
            )));
        }

        if envelope.group_id.is_empty() {
            return Err(Error::Framing("koperta bez identyfikatora grupy".into()));
        }

        // `Unspecified` odrzucamy jawnie — oznacza albo uszkodzenie, albo rodzaj
        // z nowszej wersji protokołu, którego nie umiemy poprawnie skierować.
        if envelope.kind() == EnvelopeKind::Unspecified {
            return Err(Error::Framing("koperta z nierozpoznanym rodzajem".into()));
        }

        Ok(envelope)
    }
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn koperta_robi_pelne_kolo() {
        let oryginal = Envelope::new(
            b"grupa-1".to_vec(),
            EnvelopeKind::Application,
            vec![1, 2, 3],
        );
        let odtworzona = Envelope::decode(&oryginal.encode_to_vec()).unwrap();

        assert_eq!(odtworzona, oryginal);
        assert_eq!(odtworzona.kind(), EnvelopeKind::Application);
    }

    #[test]
    fn obca_wersja_jest_odrzucana() {
        let mut koperta = Envelope::new(b"g".to_vec(), EnvelopeKind::Commit, vec![]);
        koperta.version = 42;
        assert!(Envelope::decode(&koperta.encode_to_vec()).is_err());
    }

    #[test]
    fn nierozpoznany_rodzaj_jest_odrzucany() {
        let koperta = Envelope::new(b"g".to_vec(), EnvelopeKind::Unspecified, vec![]);
        assert!(Envelope::decode(&koperta.encode_to_vec()).is_err());
    }

    #[test]
    fn koperta_bez_grupy_jest_odrzucana() {
        let koperta = Envelope::new(vec![], EnvelopeKind::Application, vec![1]);
        assert!(Envelope::decode(&koperta.encode_to_vec()).is_err());
    }

    #[test]
    fn smieci_nie_powoduja_paniki() {
        for bajty in [vec![], vec![0xFF; 64], vec![0x08], vec![0x22, 0xFF]] {
            let _ = Envelope::decode(&bajty);
        }
    }
}
