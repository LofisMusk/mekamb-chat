//! Bindingi WebAssembly rdzenia mekamb-chat.
//!
//! # Co przecieka do JavaScriptu, a co nie
//!
//! API jest celowo wąskie i wysokopoziomowe: `send`, `receive`, `create_group`.
//! Żaden typ kryptograficzny nie przechodzi przez granicę — JavaScript widzi
//! bajty i łańcuchy znaków. Dzięki temu nie da się z warstwy UI przypadkiem
//! użyć MLS w sposób, którego rdzeń nie przewidział.
//!
//! # Co MUSI zrobić strona JavaScriptu
//!
//! Po każdej operacji zmieniającej stan trzeba zapisać wynik
//! [`MekambClient::export_state`] — **zaszyfrowany**. Zrzut zawiera klucze
//! prywatne i zapisanie go jawnie w IndexedDB jest równoznaczne z oddaniem
//! wszystkich rozmów.

use std::collections::HashMap;

use mekamb_core::framing::ChatMessage;
use mekamb_core::group::{Conversation, Incoming, Provider};
use mekamb_core::identity::{DeviceIdentity, DeviceSeed};
use wasm_bindgen::prelude::*;

/// Włącza czytelne komunikaty panik w konsoli przeglądarki.
#[wasm_bindgen(start)]
pub fn start() {
    console_error_panic_hook::set_once();
}

/// Wynik przetworzenia wiadomości przychodzącej, w postaci strawnej dla JS.
#[wasm_bindgen(getter_with_clone)]
pub struct IncomingMessage {
    /// `"message"`, `"membership-changed"` albo `"proposal-queued"`.
    pub kind: String,
    /// Uwierzytelniony nadawca — pusty dla zdarzeń niebędących wiadomością.
    pub sender_user_id: String,
    pub sender_device_id: String,
    pub text: String,
    /// Czas zadeklarowany przez nadawcę. **Nie jest faktem** — patrz PROTOCOL.md.
    pub sent_at_ms: f64,
    pub message_id: Vec<u8>,
}

/// Commit oczekujący na potwierdzenie przez `GroupRelay`.
#[wasm_bindgen(getter_with_clone)]
pub struct PendingCommitJs {
    pub commit: Vec<u8>,
    pub welcome: Option<Vec<u8>>,
}

/// Klient jednego urządzenia: tożsamość, magazyn i otwarte rozmowy.
#[wasm_bindgen]
pub struct MekambClient {
    identity: DeviceIdentity,
    provider: Provider,
    conversations: HashMap<Vec<u8>, Conversation>,
}

#[wasm_bindgen]
impl MekambClient {
    /// Tworzy zupełnie nową tożsamość z losowym ziarnem.
    #[wasm_bindgen(constructor)]
    pub fn new(user_id: &str, device_id: &str) -> Result<MekambClient, JsError> {
        let identity = DeviceIdentity::generate(user_id, device_id).map_err(to_js)?;

        Ok(Self {
            identity,
            provider: Provider::new(),
            conversations: HashMap::new(),
        })
    }

    /// Odtwarza klienta z zapisanego ziarna i zrzutu stanu.
    ///
    /// `state` pochodzi z [`Self::export_state`] i musi zostać odszyfrowany
    /// przez wywołującego, zanim tu trafi.
    pub fn restore(
        user_id: &str,
        device_id: &str,
        seed: &[u8],
        state: &[u8],
    ) -> Result<MekambClient, JsError> {
        let identity =
            DeviceIdentity::new(user_id, device_id, DeviceSeed::from_bytes(seed).map_err(to_js)?)
                .map_err(to_js)?;

        Ok(Self {
            identity,
            provider: Provider::import_state(state).map_err(to_js)?,
            conversations: HashMap::new(),
        })
    }

    /// Ziarno tożsamości urządzenia.
    ///
    /// Zapisać wyłącznie zaszyfrowane. Kto ma te 32 bajty, ten jest tym urządzeniem.
    #[wasm_bindgen(js_name = exportSeed)]
    pub fn export_seed(&self) -> Vec<u8> {
        self.identity.seed().expose_secret_bytes().to_vec()
    }

    /// Zrzut stanu MLS. **Zawiera klucze prywatne — zapisać zaszyfrowany.**
    #[wasm_bindgen(js_name = exportState)]
    pub fn export_state(&self) -> Vec<u8> {
        self.provider.export_state_containing_private_keys()
    }

    /// Klucz publiczny podpisu MLS tego urządzenia.
    ///
    /// Publikowany w katalogu; z niego liczony jest safety number, po którym
    /// rozmówcy weryfikują, że nikt nie podstawił im obcego urządzenia.
    #[wasm_bindgen(js_name = mlsPublicKey)]
    pub fn mls_public_key(&self) -> Vec<u8> {
        self.identity.signature_keypair().to_public_vec()
    }

    /// Identyfikator w postaci `user_id:device_id`.
    #[wasm_bindgen(js_name = credentialIdentity)]
    pub fn credential_identity(&self) -> String {
        self.identity.credential_identity()
    }

    /// Tworzy key package, którym inni mogą nas dodać do grupy offline.
    #[wasm_bindgen(js_name = createKeyPackage)]
    pub fn create_key_package(&mut self) -> Result<Vec<u8>, JsError> {
        let bundle =
            Conversation::create_key_package(&self.provider, &self.identity).map_err(to_js)?;

        // Do sieci idzie sam key package; reszta pakietu (klucze prywatne)
        // zostaje w magazynie.
        mekamb_core::group::serialize_key_package(bundle.key_package()).map_err(to_js)
    }

    /// Zakłada rozmowę i zwraca jej identyfikator.
    #[wasm_bindgen(js_name = createConversation)]
    pub fn create_conversation(&mut self) -> Result<Vec<u8>, JsError> {
        let conversation = Conversation::create(&self.provider, &self.identity).map_err(to_js)?;
        let group_id = conversation.group_id().to_vec();
        self.conversations.insert(group_id.clone(), conversation);
        Ok(group_id)
    }

    /// Przygotowuje dodanie członka na podstawie jego key package.
    ///
    /// Zwrócony commit trzeba wysłać do `GroupRelay` i dopiero po jego
    /// potwierdzeniu wywołać [`Self::confirm_commit`]. Scalenie od razu
    /// zostawiłoby nas w epoce, której reszta grupy nie zna.
    #[wasm_bindgen(js_name = addMember)]
    pub fn add_member(
        &mut self,
        group_id: &[u8],
        key_package: &[u8],
    ) -> Result<PendingCommitJs, JsError> {
        // Weryfikacja podpisu i okresu ważności dzieje się TUTAJ. Key package
        // pochodzi z serwera, który nie jest zaufanym źródłem.
        let package =
            mekamb_core::group::deserialize_key_package(&self.provider, key_package).map_err(to_js)?;

        let Self {
            identity,
            provider,
            conversations,
        } = self;

        let pending = pobierz_mut(conversations, group_id)?
            .stage_add_member(provider, identity, &package)
            .map_err(to_js)?;

        Ok(PendingCommitJs {
            commit: pending.commit,
            welcome: pending.welcome,
        })
    }

    /// Scala commit po potwierdzeniu przez `GroupRelay`.
    #[wasm_bindgen(js_name = confirmCommit)]
    pub fn confirm_commit(&mut self, group_id: &[u8]) -> Result<(), JsError> {
        let Self {
            provider,
            conversations,
            ..
        } = self;

        pobierz_mut(conversations, group_id)?
            .confirm_pending_commit(provider)
            .map_err(to_js)
    }

    /// Porzuca commit odrzucony przez `GroupRelay` (ktoś był pierwszy).
    #[wasm_bindgen(js_name = discardCommit)]
    pub fn discard_commit(&mut self, group_id: &[u8]) -> Result<(), JsError> {
        let Self {
            provider,
            conversations,
            ..
        } = self;

        pobierz_mut(conversations, group_id)?
            .discard_pending_commit(provider)
            .map_err(to_js)
    }

    /// Dołącza do rozmowy na podstawie wiadomości Welcome.
    #[wasm_bindgen(js_name = joinFromWelcome)]
    pub fn join_from_welcome(&mut self, welcome: &[u8]) -> Result<Vec<u8>, JsError> {
        let conversation = Conversation::join_from_welcome(&self.provider, welcome).map_err(to_js)?;
        let group_id = conversation.group_id().to_vec();
        self.conversations.insert(group_id.clone(), conversation);
        Ok(group_id)
    }

    /// Szyfruje wiadomość tekstową dla grupy.
    #[wasm_bindgen(js_name = sendText)]
    pub fn send_text(
        &mut self,
        group_id: &[u8],
        text: &str,
        sent_at_ms: f64,
    ) -> Result<Vec<u8>, JsError> {
        let message = ChatMessage::text(text, sent_at_ms as u64);
        let Self {
            identity,
            provider,
            conversations,
        } = self;

        pobierz_mut(conversations, group_id)?
            .send(provider, identity, &message)
            .map_err(to_js)
    }

    /// Przetwarza wiadomość odebraną z sieci.
    #[wasm_bindgen(js_name = receive)]
    pub fn receive(&mut self, group_id: &[u8], bytes: &[u8]) -> Result<IncomingMessage, JsError> {
        let Self {
            provider,
            conversations,
            ..
        } = self;

        let incoming = pobierz_mut(conversations, group_id)?
            .receive(provider, bytes)
            .map_err(to_js)?;

        Ok(match incoming {
            Incoming::Message {
                sender_user_id,
                sender_device_id,
                message,
            } => IncomingMessage {
                kind: "message".into(),
                sender_user_id,
                sender_device_id,
                text: message.as_text().unwrap_or_default().to_string(),
                sent_at_ms: message.sent_at_ms as f64,
                message_id: message.message_id.clone(),
            },
            Incoming::MembershipChanged => zdarzenie("membership-changed"),
            Incoming::ProposalQueued => zdarzenie("proposal-queued"),
        })
    }

    /// Identyfikatory `user_id:device_id` członków rozmowy.
    pub fn members(&self, group_id: &[u8]) -> Result<Vec<String>, JsError> {
        Ok(self.conversation(group_id)?.members())
    }

    /// Numer bieżącej epoki — wysyłany razem z commitem do `GroupRelay`.
    pub fn epoch(&self, group_id: &[u8]) -> Result<u64, JsError> {
        Ok(self.conversation(group_id)?.epoch())
    }

    fn conversation(&self, group_id: &[u8]) -> Result<&Conversation, JsError> {
        self.conversations
            .get(group_id)
            .ok_or_else(|| JsError::new("nie ma takiej rozmowy w tym kliencie"))
    }

}

/// Wyszukuje rozmowę bez pożyczania całego klienta.
///
/// Metoda na `&mut self` blokowałaby jednoczesny dostęp do `provider`, którego
/// wszystkie operacje MLS i tak potrzebują.
fn pobierz_mut<'a>(
    conversations: &'a mut HashMap<Vec<u8>, Conversation>,
    group_id: &[u8],
) -> Result<&'a mut Conversation, JsError> {
    conversations
        .get_mut(group_id)
        .ok_or_else(|| JsError::new("nie ma takiej rozmowy w tym kliencie"))
}

fn zdarzenie(kind: &str) -> IncomingMessage {
    IncomingMessage {
        kind: kind.into(),
        sender_user_id: String::new(),
        sender_device_id: String::new(),
        text: String::new(),
        sent_at_ms: 0.0,
        message_id: Vec::new(),
    }
}

/// Błędy rdzenia przechodzą do JS bez szczegółów kryptograficznych.
///
/// `Error::MessageRejected` celowo nie mówi, *dlaczego* wiadomość odpadła —
/// rozróżnianie „zły podpis" od „zła epoka" dawałoby atakującemu oracle.
fn to_js(error: mekamb_core::Error) -> JsError {
    JsError::new(&error.to_string())
}

/// Buduje kopertę transportową wokół wiadomości MLS.
///
/// Koperta jest **jawna** — niesie identyfikator grupy i rodzaj ładunku, żeby
/// odbiorca wiedział, gdzie skierować bajty, zanim cokolwiek odszyfruje.
/// Kodowanie robi Rust, a nie JavaScript: drugi enkoder protobufa po stronie
/// interfejsu prędzej czy później rozjechałby się z pierwszym.
#[wasm_bindgen(js_name = encodeEnvelope)]
pub fn encode_envelope(group_id: &[u8], kind: &str, payload: &[u8]) -> Result<Vec<u8>, JsError> {
    let kind = match kind {
        "application" => mekamb_core::EnvelopeKind::Application,
        "commit" => mekamb_core::EnvelopeKind::Commit,
        "welcome" => mekamb_core::EnvelopeKind::Welcome,
        inne => return Err(JsError::new(&format!("nieznany rodzaj koperty: {inne}"))),
    };

    Ok(mekamb_core::Envelope::new(group_id.to_vec(), kind, payload.to_vec()).encode_to_vec())
}

/// Koperta odebrana z sieci, rozłożona na części dla JavaScriptu.
#[wasm_bindgen(getter_with_clone)]
pub struct DecodedEnvelope {
    pub group_id: Vec<u8>,
    /// `"application"`, `"commit"` albo `"welcome"`.
    pub kind: String,
    pub payload: Vec<u8>,
}

/// Rozkłada kopertę odebraną z sieci.
///
/// Dane wejściowe są wrogie z założenia — błąd zamiast paniki.
#[wasm_bindgen(js_name = decodeEnvelope)]
pub fn decode_envelope(bytes: &[u8]) -> Result<DecodedEnvelope, JsError> {
    let envelope = mekamb_core::Envelope::decode(bytes).map_err(to_js)?;

    let kind = match envelope.kind() {
        mekamb_core::EnvelopeKind::Application => "application",
        mekamb_core::EnvelopeKind::Commit => "commit",
        mekamb_core::EnvelopeKind::Welcome => "welcome",
        mekamb_core::EnvelopeKind::Unspecified => {
            return Err(JsError::new("koperta z nierozpoznanym rodzajem"));
        }
    };

    Ok(DecodedEnvelope {
        group_id: envelope.group_id,
        kind: kind.into(),
        payload: envelope.payload,
    })
}
