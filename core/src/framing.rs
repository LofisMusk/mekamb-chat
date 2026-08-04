//! Ładunek aplikacyjny przenoszony wewnątrz wiadomości MLS.
//!
//! Format jest opisany normatywnie w [`proto/chat.proto`]. Struktury poniżej są
//! deklarowane bezpośrednio w Rust, żeby nie wciągać `protoc` do CI Androida
//! i WASM — numery pól muszą się zgadzać z plikiem `.proto`.
//!
//! Wszystko w tym module trafia do sieci **wyłącznie** zaszyfrowane przez MLS.

use rand::{TryRng, rngs::SysRng};

use crate::error::{Error, Result};

/// Wersja formatu ładunku.
///
/// Odbiorca odrzuca nieznane wersje zamiast zgadywać. Rozjazd wersji między
/// klientami to jedno z ryzyk projektu, więc wolimy czytelny błąd niż ciche
/// błędne parsowanie.
pub const PAYLOAD_VERSION: u32 = 1;

/// Długość identyfikatora wiadomości w bajtach.
pub const MESSAGE_ID_LEN: usize = 16;

#[derive(Clone, PartialEq, prost::Message)]
pub struct ChatMessage {
    #[prost(uint32, tag = "1")]
    pub protocol_version: u32,

    #[prost(bytes = "vec", tag = "2")]
    pub message_id: Vec<u8>,

    /// Czas wg zegara **nadawcy**. Deklaracja, nie fakt — patrz `chat.proto`.
    #[prost(uint64, tag = "3")]
    pub sent_at_ms: u64,

    #[prost(oneof = "Body", tags = "4, 5, 6")]
    pub body: Option<Body>,

    #[prost(bytes = "vec", optional, tag = "7")]
    pub reply_to: Option<Vec<u8>>,
}

#[derive(Clone, PartialEq, prost::Oneof)]
pub enum Body {
    #[prost(message, tag = "4")]
    Text(TextBody),
    #[prost(message, tag = "5")]
    Attachment(AttachmentBody),
    #[prost(message, tag = "6")]
    CallSignal(CallSignalBody),
}

#[derive(Clone, PartialEq, prost::Message)]
pub struct TextBody {
    #[prost(string, tag = "1")]
    pub content: String,
}

#[derive(Clone, PartialEq, prost::Message)]
pub struct AttachmentBody {
    #[prost(string, tag = "1")]
    pub blob_id: String,
    #[prost(bytes = "vec", tag = "2")]
    pub decryption_key: Vec<u8>,
    #[prost(bytes = "vec", tag = "3")]
    pub nonce: Vec<u8>,
    #[prost(string, tag = "4")]
    pub mime_type: String,
    #[prost(uint64, tag = "5")]
    pub size_bytes: u64,
    #[prost(string, optional, tag = "6")]
    pub file_name: Option<String>,
}

#[derive(Clone, PartialEq, prost::Message)]
pub struct CallSignalBody {
    #[prost(enumeration = "CallSignalKind", tag = "1")]
    pub kind: i32,
    #[prost(bytes = "vec", tag = "2")]
    pub call_id: Vec<u8>,
    #[prost(string, tag = "3")]
    pub payload: String,
    /// Odcisk DTLS drugiej strony. Weryfikowany przed zestawieniem połączenia;
    /// niezgodność = zerwanie, bez pytania użytkownika.
    #[prost(string, tag = "4")]
    pub dtls_fingerprint: String,
    /// Adresat sygnału — `user_id` uczestnika.
    ///
    /// Wiadomości MLS trafiają do CAŁEJ grupy, a w rozmowie mesh każda para
    /// negocjuje osobne połączenie. Bez adresata trzecia osoba próbowałaby
    /// przetworzyć ofertę przeznaczoną dla kogoś innego.
    ///
    /// Puste = sygnał dla wszystkich.
    #[prost(string, tag = "5")]
    pub target: String,
}

#[derive(Clone, Copy, Debug, PartialEq, Eq, prost::Enumeration)]
#[repr(i32)]
pub enum CallSignalKind {
    Unspecified = 0,
    Offer = 1,
    Answer = 2,
    IceCandidate = 3,
    Hangup = 4,
}

impl ChatMessage {
    /// Buduje wiadomość tekstową z nowym losowym identyfikatorem.
    pub fn text(content: impl Into<String>, sent_at_ms: u64) -> Self {
        Self {
            protocol_version: PAYLOAD_VERSION,
            message_id: new_message_id().to_vec(),
            sent_at_ms,
            body: Some(Body::Text(TextBody {
                content: content.into(),
            })),
            reply_to: None,
        }
    }

    /// Buduje wiadomość z załącznikiem.
    ///
    /// `decryption_key` i `nonce` pochodzą z [`crate::attachments::seal_attachment`]
    /// i podróżują tutaj — czyli **wewnątrz** szyfrowania MLS. Umieszczenie ich
    /// gdziekolwiek indziej udostępniłoby plik serwerowi.
    pub fn attachment(body: AttachmentBody, sent_at_ms: u64) -> Self {
        Self {
            protocol_version: PAYLOAD_VERSION,
            message_id: new_message_id().to_vec(),
            sent_at_ms,
            body: Some(Body::Attachment(body)),
            reply_to: None,
        }
    }

    /// Buduje wiadomość z sygnalizacją rozmowy.
    ///
    /// Ładunek idzie **wewnątrz** MLS, więc odcisk DTLS jest uwierzytelniony
    /// kryptograficznie — kontrolujący sygnalizację nie podstawi się w środek
    /// połączenia, bo nie sfałszuje wiadomości MLS.
    pub fn call_signal(body: CallSignalBody, sent_at_ms: u64) -> Self {
        Self {
            protocol_version: PAYLOAD_VERSION,
            message_id: new_message_id().to_vec(),
            sent_at_ms,
            body: Some(Body::CallSignal(body)),
            reply_to: None,
        }
    }

    /// Zwraca sygnalizację rozmowy, jeśli wiadomość ją niesie.
    pub fn as_call_signal(&self) -> Option<&CallSignalBody> {
        match &self.body {
            Some(Body::CallSignal(c)) => Some(c),
            _ => None,
        }
    }

    /// Zwraca metadane załącznika, jeśli wiadomość go niesie.
    pub fn as_attachment(&self) -> Option<&AttachmentBody> {
        match &self.body {
            Some(Body::Attachment(a)) => Some(a),
            _ => None,
        }
    }

    /// Zwraca treść, jeśli to wiadomość tekstowa.
    pub fn as_text(&self) -> Option<&str> {
        match &self.body {
            Some(Body::Text(t)) => Some(&t.content),
            _ => None,
        }
    }

    /// Serializuje ładunek do bajtów.
    pub fn encode_to_vec(&self) -> Vec<u8> {
        prost::Message::encode_to_vec(self)
    }

    /// Parsuje ładunek odebrany z kanału MLS.
    ///
    /// Odrzuca nieznaną wersję protokołu i ładunek bez `body` — pusty wariant
    /// `oneof` oznacza albo uszkodzenie, albo pole z nowszej wersji, której nie
    /// rozumiemy.
    pub fn decode(bytes: &[u8]) -> Result<Self> {
        let message = <Self as prost::Message>::decode(bytes)
            .map_err(|e| Error::Framing(format!("nie udało się zdekodować ładunku: {e}")))?;

        if message.protocol_version != PAYLOAD_VERSION {
            return Err(Error::Framing(format!(
                "nieobsługiwana wersja ładunku: {} (obsługiwana: {})",
                message.protocol_version, PAYLOAD_VERSION
            )));
        }

        if message.body.is_none() {
            return Err(Error::Framing(
                "ładunek nie zawiera treści (nierozpoznany wariant body)".into(),
            ));
        }

        if message.message_id.len() != MESSAGE_ID_LEN {
            return Err(Error::Framing(format!(
                "message_id ma {} bajtów, oczekiwano {MESSAGE_ID_LEN}",
                message.message_id.len()
            )));
        }

        Ok(message)
    }
}

/// Losuje identyfikator wiadomości.
pub fn new_message_id() -> [u8; MESSAGE_ID_LEN] {
    let mut id = [0u8; MESSAGE_ID_LEN];
    SysRng
        .try_fill_bytes(&mut id)
        .expect("systemowy generator losowy musi być dostępny");
    id
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn tekst_robi_pelne_kolo() {
        let oryginal = ChatMessage::text("cześć, zażółć gęślą jaźń", 1_700_000_000_000);
        let odtworzony = ChatMessage::decode(&oryginal.encode_to_vec()).unwrap();

        assert_eq!(odtworzony, oryginal);
        assert_eq!(odtworzony.as_text(), Some("cześć, zażółć gęślą jaźń"));
        assert_eq!(odtworzony.message_id.len(), MESSAGE_ID_LEN);
    }

    #[test]
    fn identyfikatory_wiadomosci_sie_nie_powtarzaja() {
        let a = ChatMessage::text("x", 0);
        let b = ChatMessage::text("x", 0);
        assert_ne!(a.message_id, b.message_id);
    }

    #[test]
    fn obca_wersja_protokolu_jest_odrzucana() {
        let mut wiadomosc = ChatMessage::text("x", 0);
        wiadomosc.protocol_version = 99;
        assert!(matches!(
            ChatMessage::decode(&wiadomosc.encode_to_vec()),
            Err(Error::Framing(_))
        ));
    }

    #[test]
    fn ladunek_bez_tresci_jest_odrzucany() {
        let pusty = ChatMessage {
            protocol_version: PAYLOAD_VERSION,
            message_id: new_message_id().to_vec(),
            sent_at_ms: 0,
            body: None,
            reply_to: None,
        };
        assert!(ChatMessage::decode(&pusty.encode_to_vec()).is_err());
    }

    #[test]
    fn zly_rozmiar_identyfikatora_jest_odrzucany() {
        let mut wiadomosc = ChatMessage::text("x", 0);
        wiadomosc.message_id = vec![1, 2, 3];
        assert!(ChatMessage::decode(&wiadomosc.encode_to_vec()).is_err());
    }

    #[test]
    fn smieci_nie_powoduja_paniki() {
        // Dane z sieci są wrogie z założenia — parser ma zwracać błąd, nie panikować.
        for bajty in [vec![0xFF; 64], vec![], vec![0x08], vec![0x2A, 0xFF, 0xFF]] {
            let _ = ChatMessage::decode(&bajty);
        }
    }

    /// Sygnalizacja rozmów jedzie tym samym kanałem co tekst — bez niej odcisk
    /// DTLS nie byłby uwierzytelniony.
    #[test]
    fn sygnalizacja_rozmowy_robi_pelne_kolo() {
        let wiadomosc = ChatMessage {
            protocol_version: PAYLOAD_VERSION,
            message_id: new_message_id().to_vec(),
            sent_at_ms: 42,
            body: Some(Body::CallSignal(CallSignalBody {
                kind: CallSignalKind::Offer as i32,
                call_id: vec![9; 16],
                payload: "v=0\r\no=- 0 0 IN IP4 127.0.0.1\r\n".into(),
                dtls_fingerprint: "sha-256 AB:CD".into(),
                target: "bob".into(),
            })),
            reply_to: None,
        };

        let odtworzona = ChatMessage::decode(&wiadomosc.encode_to_vec()).unwrap();
        let Some(Body::CallSignal(signal)) = odtworzona.body else {
            panic!("oczekiwano sygnalizacji rozmowy");
        };
        assert_eq!(signal.kind, CallSignalKind::Offer as i32);
        assert_eq!(signal.dtls_fingerprint, "sha-256 AB:CD");
    }
}
