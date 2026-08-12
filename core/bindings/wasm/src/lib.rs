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
    /// `"message"`, `"call-signal"`, `"membership-changed"` albo `"proposal-queued"`.
    pub kind: String,
    /// Uwierzytelniony nadawca — pusty dla zdarzeń niebędących wiadomością.
    pub sender_user_id: String,
    pub sender_device_id: String,
    pub text: String,
    /// Czas zadeklarowany przez nadawcę. **Nie jest faktem** — patrz PROTOCOL.md.
    pub sent_at_ms: f64,
    pub message_id: Vec<u8>,

    /// Wypełnione, gdy wiadomość niesie załącznik zamiast tekstu.
    pub attachment: Option<AttachmentInfo>,

    /// Wypełnione, gdy wiadomość niesie sygnalizację rozmowy.
    pub call: Option<CallSignalInfo>,

    /// Wypełnione, gdy wiadomość jest potwierdzeniem dostarczenia albo odczytu.
    pub receipt: Option<ReceiptInfo>,
}

/// Potwierdzenie odebrane kanałem MLS.
///
/// Nie niesie chwili odczytu — to dokładnie ta informacja, której nie chcemy
/// oddawać. Ukrycie **momentu** wysyłki jest zadaniem klienta, który zbiera
/// potwierdzenia i wysyła je paczką po losowym opóźnieniu.
#[derive(Clone)]
#[wasm_bindgen(getter_with_clone)]
pub struct ReceiptInfo {
    /// `"delivered"` albo `"read"`.
    pub kind: String,
    /// Identyfikatory potwierdzanych wiadomości, sklejone po 16 bajtów.
    ///
    /// Jedna płaska tablica, bo `Vec<Vec<u8>>` nie przechodzi przez
    /// `wasm-bindgen` bez ręcznego opakowania. Rozcina je `rozetnijIdentyfikatory`
    /// po stronie JS.
    pub message_ids: Vec<u8>,
}

/// Sygnalizacja rozmowy odebrana kanałem MLS.
#[derive(Clone)]
#[wasm_bindgen(getter_with_clone)]
pub struct CallSignalInfo {
    /// `"offer"`, `"answer"`, `"ice"` albo `"hangup"`.
    pub kind: String,
    pub call_id: Vec<u8>,
    pub payload: String,
    /// Odcisk DTLS **uwierzytelniony przez MLS**. Przed zestawieniem
    /// połączenia trzeba porównać go z tym w SDP.
    pub dtls_fingerprint: String,
    /// Adresat sygnału. Puste = dla wszystkich.
    pub target: String,
}

/// Metadane załącznika odebrane z kanału MLS.
///
/// `key` i `nonce` są sekretami — przyszły zaszyfrowane i służą wyłącznie do
/// odszyfrowania bloba pobranego z serwera. Nie wolno ich nigdzie zapisać
/// w postaci jawnej.
#[derive(Clone)]
#[wasm_bindgen(getter_with_clone)]
pub struct AttachmentInfo {
    pub blob_id: String,
    pub key: Vec<u8>,
    pub nonce: Vec<u8>,
    pub mime_type: String,
    pub size_bytes: f64,
    pub file_name: Option<String>,
}

/// Zaszyfrowana wiadomość razem z jej identyfikatorem.
///
/// # Dlaczego identyfikator wraca do wołającego
///
/// Bo potwierdzenia wskazują wiadomości właśnie po nim. Wcześniej rdzeń losował
/// go w środku i nie oddawał, a klient webowy zapisywał własne wiadomości pod
/// własnym UUID-em — czyli pod czymś, czego druga strona nigdy nie widziała.
/// Potwierdzenie odczytu nie trafiłoby wtedy w żaden dymek, a nikt by nie
/// zauważył dlaczego: ptaszek po prostu nigdy by się nie zmienił.
#[wasm_bindgen(getter_with_clone)]
pub struct SentMessage {
    pub ciphertext: Vec<u8>,
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
        let identity = DeviceIdentity::new(
            user_id,
            device_id,
            DeviceSeed::from_bytes(seed).map_err(to_js)?,
        )
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

    /// Otwiera rozmowę zapisaną w magazynie.
    ///
    /// Zwraca `false`, gdy magazyn tej grupy nie zna — rozmowa jest w historii,
    /// ale bez stanu MLS (np. po przeniesieniu konta).
    ///
    /// Wołający musi to zrobić dla każdej znanej rozmowy PO odtworzeniu klienta.
    /// Bez tego klient ma pełny stan na dysku i pustą listę otwartych rozmów,
    /// więc po odświeżeniu karty nie da się ani wysłać, ani odebrać niczego.
    #[wasm_bindgen(js_name = openConversation)]
    pub fn open_conversation(&mut self, group_id: &[u8]) -> Result<bool, JsError> {
        if self.conversations.contains_key(group_id) {
            return Ok(true);
        }

        match Conversation::load(&self.provider, group_id).map_err(to_js)? {
            Some(conversation) => {
                self.conversations.insert(group_id.to_vec(), conversation);
                Ok(true)
            }
            None => Ok(false),
        }
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
        let package = mekamb_core::group::deserialize_key_package(&self.provider, key_package)
            .map_err(to_js)?;

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
        let conversation =
            Conversation::join_from_welcome(&self.provider, welcome).map_err(to_js)?;
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
    ) -> Result<SentMessage, JsError> {
        let message = ChatMessage::text(text, sent_at_ms as u64);
        let message_id = message.message_id.clone();

        let Self {
            identity,
            provider,
            conversations,
        } = self;

        let ciphertext = pobierz_mut(conversations, group_id)?
            .send(provider, identity, &message)
            .map_err(to_js)?;

        Ok(SentMessage {
            ciphertext,
            message_id,
        })
    }

    /// Szyfruje i pakuje paczkę potwierdzeń.
    ///
    /// `message_ids` to sklejone identyfikatory po 16 bajtów — jedna płaska
    /// tablica, bo `Vec<Vec<u8>>` nie przechodzi przez `wasm-bindgen` bez
    /// ręcznego opakowania.
    ///
    /// Potwierdzenie jest zwykłą wiadomością aplikacyjną MLS, więc serwer widzi
    /// wyłącznie szyfrogram. **Nie ukrywa to chwili**, w której koperta poszła
    /// — o to dba wołający, opóźniając wysyłkę (patrz `lib/potwierdzenia.ts`).
    #[wasm_bindgen(js_name = sendReceipt)]
    pub fn send_receipt(
        &mut self,
        group_id: &[u8],
        kind: &str,
        message_ids: &[u8],
        sent_at_ms: f64,
    ) -> Result<Vec<u8>, JsError> {
        let rodzaj = match kind {
            "delivered" => mekamb_core::framing::ReceiptKind::Delivered,
            "read" => mekamb_core::framing::ReceiptKind::Read,
            inne => {
                return Err(JsError::new(&format!(
                    "nieznany rodzaj potwierdzenia: {inne}"
                )));
            }
        };

        if message_ids.is_empty() || message_ids.len() % mekamb_core::framing::MESSAGE_ID_LEN != 0 {
            return Err(JsError::new(
                "identyfikatory potwierdzeń muszą być wielokrotnością 16 bajtów i nie mogą być puste",
            ));
        }

        let identyfikatory = message_ids
            .chunks(mekamb_core::framing::MESSAGE_ID_LEN)
            .map(<[u8]>::to_vec)
            .collect();

        let message = ChatMessage::receipt(rodzaj, identyfikatory, sent_at_ms as u64);

        let Self {
            identity,
            provider,
            conversations,
        } = self;

        pobierz_mut(conversations, group_id)?
            .send(provider, identity, &message)
            .map_err(to_js)
    }

    /// Szyfruje i pakuje wiadomość z załącznikiem.
    ///
    /// Wołane PO wgraniu szyfrogramu na serwer: `blob_id` pochodzi z odpowiedzi
    /// serwera, a klucz z [`seal_attachment`]. Klucz podróżuje wewnątrz MLS,
    /// więc serwer przechowuje plik, którego nie potrafi odczytać.
    #[wasm_bindgen(js_name = sendAttachment)]
    #[allow(clippy::too_many_arguments)]
    pub fn send_attachment(
        &mut self,
        group_id: &[u8],
        blob_id: &str,
        key: &[u8],
        nonce: &[u8],
        mime_type: &str,
        size_bytes: f64,
        file_name: Option<String>,
        sent_at_ms: f64,
    ) -> Result<SentMessage, JsError> {
        let message = mekamb_core::framing::ChatMessage::attachment(
            mekamb_core::framing::AttachmentBody {
                blob_id: blob_id.to_string(),
                decryption_key: key.to_vec(),
                nonce: nonce.to_vec(),
                mime_type: mime_type.to_string(),
                size_bytes: size_bytes as u64,
                file_name,
            },
            sent_at_ms as u64,
        );
        let message_id = message.message_id.clone();

        let Self {
            identity,
            provider,
            conversations,
        } = self;

        let ciphertext = pobierz_mut(conversations, group_id)?
            .send(provider, identity, &message)
            .map_err(to_js)?;

        Ok(SentMessage {
            ciphertext,
            message_id,
        })
    }

    /// Szyfruje sygnalizację rozmowy i pakuje ją do wysłania.
    ///
    /// `dtls_fingerprint` podróżuje **wewnątrz** MLS, niezależnie od SDP.
    /// Odbiorca porówna jedno z drugim przed zestawieniem połączenia.
    ///
    /// Lista argumentów jest długa, ale każdy jest osobnym polem protokołu —
    /// zwinięcie ich w strukturę tylko przeniosłoby to samo o poziom wyżej,
    /// a przy granicy WASM dołożyłoby konwersję.
    #[wasm_bindgen(js_name = sendCallSignal)]
    #[allow(clippy::too_many_arguments)]
    pub fn send_call_signal(
        &mut self,
        group_id: &[u8],
        kind: &str,
        call_id: &[u8],
        payload: &str,
        dtls_fingerprint: &str,
        target: &str,
        sent_at_ms: f64,
    ) -> Result<Vec<u8>, JsError> {
        let rodzaj = match kind {
            "offer" => mekamb_core::framing::CallSignalKind::Offer,
            "answer" => mekamb_core::framing::CallSignalKind::Answer,
            "ice" => mekamb_core::framing::CallSignalKind::IceCandidate,
            "hangup" => mekamb_core::framing::CallSignalKind::Hangup,
            inne => return Err(JsError::new(&format!("nieznany rodzaj sygnału: {inne}"))),
        };

        let message = mekamb_core::framing::ChatMessage::call_signal(
            mekamb_core::framing::CallSignalBody {
                kind: rodzaj as i32,
                call_id: call_id.to_vec(),
                payload: payload.to_string(),
                dtls_fingerprint: dtls_fingerprint.to_string(),
                target: target.to_string(),
            },
            sent_at_ms as u64,
        );

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
                call: message.as_call_signal().map(|c| CallSignalInfo {
                    kind: match mekamb_core::framing::CallSignalKind::try_from(c.kind) {
                        Ok(mekamb_core::framing::CallSignalKind::Offer) => "offer",
                        Ok(mekamb_core::framing::CallSignalKind::Answer) => "answer",
                        Ok(mekamb_core::framing::CallSignalKind::IceCandidate) => "ice",
                        Ok(mekamb_core::framing::CallSignalKind::Hangup) => "hangup",
                        // Nierozpoznany rodzaj z sieci — interfejs ma go zignorować,
                        // a nie zgadywać, co nadawca miał na myśli.
                        _ => "nieznany",
                    }
                    .into(),
                    call_id: c.call_id.clone(),
                    payload: c.payload.clone(),
                    dtls_fingerprint: c.dtls_fingerprint.clone(),
                    target: c.target.clone(),
                }),
                attachment: message.as_attachment().map(|a| AttachmentInfo {
                    blob_id: a.blob_id.clone(),
                    key: a.decryption_key.clone(),
                    nonce: a.nonce.clone(),
                    mime_type: a.mime_type.clone(),
                    size_bytes: a.size_bytes as f64,
                    file_name: a.file_name.clone(),
                }),
                receipt: message.as_receipt().map(|r| ReceiptInfo {
                    kind: match mekamb_core::framing::ReceiptKind::try_from(r.kind) {
                        Ok(mekamb_core::framing::ReceiptKind::Delivered) => "delivered",
                        Ok(mekamb_core::framing::ReceiptKind::Read) => "read",
                        // Nierozpoznany rodzaj z sieci — interfejs ma go zignorować,
                        // a nie zgadywać, co nadawca miał na myśli.
                        _ => "nieznany",
                    }
                    .into(),
                    message_ids: r.message_ids.concat(),
                }),
            },
            Incoming::MembershipChanged => zdarzenie("membership-changed"),
            Incoming::ProposalQueued => zdarzenie("proposal-queued"),
        })
    }

    /// Do której rozmowy należy koperta.
    ///
    /// Zwraca `None`, gdy do żadnej znanej — dla `welcome` zawsze, bo tej
    /// rozmowy jeszcze nie mamy, a także dla koperty spreparowanej albo
    /// przeznaczonej dla innego urządzenia.
    ///
    /// Dopasowanie musi być tutaj, a nie w JavaScripcie: klucz routingu
    /// wyprowadza się z identyfikatora rozmowy, a ten nie opuszcza rdzenia
    /// w postaci nadającej się do policzenia znacznika.
    #[wasm_bindgen(js_name = matchEnvelope)]
    pub fn match_envelope(&self, bytes: &[u8]) -> Result<Option<Vec<u8>>, JsError> {
        let envelope = mekamb_core::Envelope::decode(bytes).map_err(to_js)?;

        Ok(self
            .conversations
            .keys()
            .find(|group_id| envelope.pasuje_do(group_id))
            .cloned())
    }

    /// Identyfikatory `user_id:device_id` członków rozmowy.
    pub fn members(&self, group_id: &[u8]) -> Result<Vec<String>, JsError> {
        Ok(self.conversation(group_id)?.members())
    }

    /// Safety number rozmowy — kod do porównania z rozmówcą innym kanałem.
    ///
    /// Liczony z kluczy tożsamości **z drzewa MLS**, więc podstawienie cudzego
    /// urządzenia przez serwer zmienia wynik. Bez porównania tego kodu
    /// szyfrowanie broni przed podsłuchem, ale nie przed podstawieniem
    /// uczestnika rozmowy.
    #[wasm_bindgen(js_name = safetyNumber)]
    pub fn safety_number(&self, group_id: &[u8]) -> Result<String, JsError> {
        self.conversation(group_id)?.safety_number().map_err(to_js)
    }

    /// Odcisk tego urządzenia — do przepisania z ekranu na ekran przy linkowaniu.
    #[wasm_bindgen(js_name = deviceFingerprint)]
    pub fn device_fingerprint(&self) -> Result<String, JsError> {
        mekamb_core::device_fingerprint(&self.identity.signature_keypair().to_public_vec())
            .map_err(to_js)
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
        attachment: None,
        call: None,
        receipt: None,
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
/// Koperta **nie niesie identyfikatora rozmowy** — zamiast niego jedzie losowa
/// sól i znacznik z niej wyprowadzony, inny dla każdej koperty. Uzasadnienie
/// w `core/src/envelope.rs`.
///
/// Kodowanie robi Rust, a nie JavaScript: drugi enkoder protobufa po stronie
/// interfejsu prędzej czy później rozjechałby się z pierwszym, a tutaj rozjazd
/// znaczyłby kopertę, której nikt nie umie skierować.
#[wasm_bindgen(js_name = encodeEnvelope)]
pub fn encode_envelope(group_id: &[u8], kind: &str, payload: &[u8]) -> Result<Vec<u8>, JsError> {
    let kind = match kind {
        "application" => mekamb_core::EnvelopeKind::Application,
        "commit" => mekamb_core::EnvelopeKind::Commit,
        "welcome" => mekamb_core::EnvelopeKind::Welcome,
        inne => return Err(JsError::new(&format!("nieznany rodzaj koperty: {inne}"))),
    };

    Ok(mekamb_core::Envelope::new(group_id, kind, payload.to_vec()).encode_to_vec())
}

/// Nazwa obiektu porządkującego epoki dla tej rozmowy.
///
/// Osobno wyprowadzona, nie surowy identyfikator: serwer widzi tę wartość
/// w adresie żądania, a z niej nie da się wrócić do klucza routingu kopert.
#[wasm_bindgen(js_name = relayId)]
pub fn relay_id(group_id: &[u8]) -> String {
    mekamb_core::identyfikator_relaya(group_id)
}

/// Koperta odebrana z sieci, rozłożona na części dla JavaScriptu.
#[wasm_bindgen(getter_with_clone)]
pub struct DecodedEnvelope {
    /// `"application"`, `"commit"` albo `"welcome"`.
    pub kind: String,
    pub payload: Vec<u8>,
}

/// Rozkłada kopertę odebraną z sieci.
///
/// **Nie mówi, do której rozmowy należy** — tego nie da się odczytać bez klucza
/// rozmowy. Od dopasowania jest [`MekambClient::match_envelope`].
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
        kind: kind.into(),
        payload: envelope.payload,
    })
}

/// Zaszyfrowany załącznik gotowy do wysłania.
#[wasm_bindgen(getter_with_clone)]
pub struct SealedAttachmentJs {
    /// Do wgrania na serwer. Nieczytelne bez klucza.
    pub ciphertext: Vec<u8>,
    /// **Sekret.** Trafia do wiadomości MLS, nigdy obok szyfrogramu.
    pub key: Vec<u8>,
    pub nonce: Vec<u8>,
}

/// Szyfruje plik przed wgraniem na serwer.
///
/// Każde wywołanie losuje świeży klucz i nonce — powtórzenie pary w AES-GCM
/// pozwoliłoby odzyskać strumień klucza, więc nie polegamy tu na żadnym
/// liczniku.
///
/// `mime_type` wchodzi do danych uwierzytelnionych: podmiana deklarowanego typu
/// pliku unieważnia szyfrogram.
#[wasm_bindgen(js_name = sealAttachment)]
pub fn seal_attachment(plaintext: &[u8], mime_type: &str) -> Result<SealedAttachmentJs, JsError> {
    let sealed = mekamb_core::seal_attachment(plaintext, mime_type).map_err(to_js)?;

    Ok(SealedAttachmentJs {
        ciphertext: sealed.ciphertext.clone(),
        key: sealed.key.to_vec(),
        nonce: sealed.nonce.to_vec(),
    })
}

/// Odszyfrowuje załącznik pobrany z serwera.
#[wasm_bindgen(js_name = openAttachment)]
pub fn open_attachment(
    ciphertext: &[u8],
    key: &[u8],
    nonce: &[u8],
    mime_type: &str,
) -> Result<Vec<u8>, JsError> {
    mekamb_core::open_attachment(ciphertext, key, nonce, mime_type).map_err(to_js)
}

/// Górny limit rozmiaru załącznika — interfejs odsiewa za duże pliki od razu.
#[wasm_bindgen(js_name = maxAttachmentBytes)]
pub fn max_attachment_bytes() -> usize {
    mekamb_core::MAX_ATTACHMENT_BYTES
}

/// Usuwa metadane z pliku — zdjęcia albo wideo.
///
/// Wołane **przed** zaszyfrowaniem: dane umieszczone w środku szyfrogramu
/// docierają do odbiorcy tak samo jak sama treść, więc szyfrowanie nie chroni
/// przed tym, co sami tam włożyliśmy.
///
/// Obraz i dźwięk zostają nietknięte — usuwamy wyłącznie metadane.
#[wasm_bindgen(js_name = stripMetadata)]
pub fn strip_metadata(bytes: &[u8], mime_type: &str) -> Result<Vec<u8>, JsError> {
    mekamb_core::media::strip_metadata(bytes, mime_type).map_err(to_js)
}

/// Czy dla tego typu pliku potrafimy usunąć metadane.
#[wasm_bindgen(js_name = canStripMetadata)]
pub fn can_strip_metadata(mime_type: &str) -> bool {
    mekamb_core::can_strip(mime_type)
}

// ---------------------------------------------------------------------------
// OPAQUE — strona klienta
//
// Ten sam kod, którego używa serwer (przez osobny moduł WASM) i Android
// (przez UniFFI). Zgodność wynika z konstrukcji: dwie niezależne implementacje
// tego samego protokołu nie są zgodne na poziomie bajtów tylko dlatego,
// że obie „robią OPAQUE".
// ---------------------------------------------------------------------------

/// Wynik pierwszej rundy — żądanie do wysłania i stan do zachowania.
#[wasm_bindgen(getter_with_clone)]
pub struct OpaqueStart {
    pub request: Vec<u8>,
    /// **Sekret.** Zostaje w pamięci klienta między rundami.
    pub state: Vec<u8>,
}

/// Rejestracja, runda 1. Hasło nie opuszcza tego urządzenia.
#[wasm_bindgen(js_name = opaqueRegisterStart)]
pub fn opaque_register_start(password: &str) -> Result<OpaqueStart, JsError> {
    let wynik = mekamb_opaque::client_registration_start(password).map_err(opaque_to_js)?;
    Ok(OpaqueStart {
        request: wynik.request,
        state: wynik.state,
    })
}

/// Wynik drugiej rundy rejestracji.
#[wasm_bindgen(getter_with_clone)]
pub struct OpaqueRegisterFinish {
    /// Do wysłania na serwer jako rekord konta.
    pub upload: Vec<u8>,
    /// Klucz wyprowadzony z hasła, **nieznany serwerowi**.
    pub export_key: Vec<u8>,
}

/// Rejestracja, runda 2.
#[wasm_bindgen(js_name = opaqueRegisterFinish)]
pub fn opaque_register_finish(
    state: &[u8],
    password: &str,
    username: &str,
    response: &[u8],
) -> Result<OpaqueRegisterFinish, JsError> {
    let wynik = mekamb_opaque::client_registration_finish(state, password, username, response)
        .map_err(opaque_to_js)?;

    Ok(OpaqueRegisterFinish {
        upload: wynik.upload,
        export_key: wynik.export_key,
    })
}

/// Logowanie, runda 1.
#[wasm_bindgen(js_name = opaqueLoginStart)]
pub fn opaque_login_start(password: &str) -> Result<OpaqueStart, JsError> {
    let wynik = mekamb_opaque::client_login_start(password).map_err(opaque_to_js)?;
    Ok(OpaqueStart {
        request: wynik.request,
        state: wynik.state,
    })
}

/// Wynik drugiej rundy logowania.
#[wasm_bindgen(getter_with_clone)]
pub struct OpaqueLoginFinish {
    /// Dowód do odesłania serwerowi.
    pub finalization: Vec<u8>,
    pub session_key: Vec<u8>,
    pub export_key: Vec<u8>,
}

/// Logowanie, runda 2.
///
/// **Złe hasło wykrywa tutaj klient**, a nie serwer — serwer nie ma czego
/// porównywać, więc nie ma stamtąd czego wyciec.
#[wasm_bindgen(js_name = opaqueLoginFinish)]
pub fn opaque_login_finish(
    state: &[u8],
    password: &str,
    username: &str,
    response: &[u8],
) -> Result<OpaqueLoginFinish, JsError> {
    let wynik = mekamb_opaque::client_login_finish(state, password, username, response)
        .map_err(opaque_to_js)?;

    Ok(OpaqueLoginFinish {
        finalization: wynik.finalization,
        session_key: wynik.session_key,
        export_key: wynik.export_key,
    })
}

fn opaque_to_js(error: mekamb_opaque::Error) -> JsError {
    JsError::new(&error.to_string())
}

/// Sprawdza, czy SDP niesie wyłącznie oczekiwany odcisk DTLS.
///
/// `expected` pochodzi z kanału MLS, czyli ze źródła, którego kontrolujący
/// sygnalizację nie potrafi podrobić. Zwraca błąd przy każdej niezgodności —
/// **wywołujący ma wtedy zerwać połączenie, a nie pytać użytkownika.**
/// Pytanie w tym miejscu przerzucałoby decyzję kryptograficzną na osobę,
/// która nie ma jak jej ocenić.
#[wasm_bindgen(js_name = verifySdpFingerprint)]
pub fn verify_sdp_fingerprint(sdp: &str, expected: &str) -> Result<(), JsError> {
    mekamb_core::verify_sdp_fingerprint(sdp, expected).map_err(to_js)
}

/// Wyciąga odcisk DTLS z własnego SDP, żeby wysłać go kanałem MLS.
///
/// Zwraca błąd, gdy SDP niesie więcej niż jeden różny odcisk — sytuacja,
/// której w naszym własnym SDP nie powinno być, a która u odbiorcy i tak
/// zostałaby odrzucona.
#[wasm_bindgen(js_name = ownSdpFingerprint)]
pub fn own_sdp_fingerprint(sdp: &str) -> Result<String, JsError> {
    let odciski = mekamb_core::extract_fingerprints(sdp);

    let pierwszy = odciski
        .first()
        .ok_or_else(|| JsError::new("własne SDP nie zawiera odcisku DTLS"))?;

    if odciski.iter().any(|o| o != pierwszy) {
        return Err(JsError::new("własne SDP zawiera niespójne odciski DTLS"));
    }

    Ok(pierwszy.clone())
}
