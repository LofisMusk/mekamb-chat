//! Bindingi UniFFI rdzenia mekamb-chat dla klienta Android.
//!
//! # Dlaczego API jest blokujące, skoro transport jest asynchroniczny
//!
//! UniFFI potrafi wystawiać funkcje `async`, ale ich obsługa po stronie Kotlina
//! wciąga dodatkowe zależności i komplikuje cykl życia obiektów. Zamiast tego
//! trzymamy runtime tokio **wewnątrz Rusta** i wystawiamy metody blokujące,
//! a Kotlin woła je z `Dispatchers.IO`.
//!
//! To nie jest uproszczenie kosztem poprawności: model wątków jest ten sam,
//! tylko granica async biegnie w innym miejscu. Gdyby kiedyś zaczęło to
//! przeszkadzać, zmiana dotyczy wyłącznie tego pliku.
//!
//! # Co MUSI zrobić strona Kotlina
//!
//! Po każdej operacji zmieniającej stan zapisać [`MekambClient::export_state`]
//! — **zaszyfrowany** kluczem z Android Keystore. Zrzut zawiera klucze prywatne.

use std::collections::HashMap;
use std::sync::Mutex;

use mekamb_core::framing::ChatMessage;
use mekamb_core::group::{Conversation, Incoming, Provider};
use mekamb_core::identity::{DeviceIdentity, DeviceSeed};
use mekamb_transport::{Delivery, Envelope, EnvelopeKind, RelayPolicy, Transport};

uniffi::setup_scaffolding!();

/// Błąd przekazywany do Kotlina.
///
/// Warianty są zgrubne celowo. Szczegół „dlaczego deszyfrowanie się nie
/// powiodło" jest wyciekiem informacji, więc nie przechodzi przez tę granicę.
#[derive(Debug, thiserror::Error, uniffi::Error)]
pub enum MekambError {
    #[error("nieprawidłowe dane wejściowe: {powod}")]
    InvalidInput { powod: String },

    #[error("operacja kryptograficzna nie powiodła się: {powod}")]
    Crypto { powod: String },

    #[error("nie udało się przetworzyć wiadomości przychodzącej")]
    MessageRejected,

    #[error("błąd sieci: {powod}")]
    Network { powod: String },
}

impl From<mekamb_core::Error> for MekambError {
    fn from(error: mekamb_core::Error) -> Self {
        use mekamb_core::Error as E;
        match error {
            E::MessageRejected => Self::MessageRejected,
            E::InvalidSeedLength { .. }
            | E::InvalidInput(_)
            | E::InvalidIdentity(_)
            | E::Framing(_) => {
                Self::InvalidInput { powod: error.to_string() }
            }
            E::Group(_) => Self::Crypto { powod: error.to_string() },
            E::Storage(_) => Self::Network { powod: error.to_string() },
        }
    }
}

/// Rodzaj zdarzenia odebranego z sieci.
#[derive(Debug, Clone, uniffi::Enum)]
pub enum IncomingEvent {
    /// Wiadomość aplikacyjna wraz z **uwierzytelnionym** nadawcą.
    Message {
        sender_user_id: String,
        sender_device_id: String,
        text: String,
        /// Czas zadeklarowany przez nadawcę — nie jest faktem.
        sent_at_ms: u64,
        message_id: Vec<u8>,
    },
    /// Skład grupy uległ zmianie.
    MembershipChanged,
    /// Propozycja odłożona do czasu commitu.
    ProposalQueued,
    /// Dołączyliśmy do nowej rozmowy.
    JoinedConversation { group_id: Vec<u8> },
}

/// Commit oczekujący na potwierdzenie przez `GroupRelay`.
#[derive(Debug, Clone, uniffi::Record)]
pub struct PendingCommit {
    pub commit: Vec<u8>,
    pub welcome: Option<Vec<u8>>,
}

/// Jak dostarczono wiadomość — interfejs pokazuje to użytkownikowi.
#[derive(Debug, Clone, Copy, uniffi::Enum)]
pub enum DeliveryMode {
    /// Prosto do urządzenia odbiorcy, z pominięciem infrastruktury.
    Direct,
    /// Odbiorca nieosiągalny — szyfrogram czeka w skrzynce.
    Mailbox,
}

/// Klient jednego urządzenia.
///
/// `Mutex` w środku, bo UniFFI wystawia obiekty jako współdzielone i Kotlin
/// może wołać metody z różnych wątków. Operacje MLS są krótkie, więc blokada
/// nie jest wąskim gardłem.
#[derive(uniffi::Object)]
pub struct MekambClient {
    inner: Mutex<ClientState>,
}

struct ClientState {
    identity: DeviceIdentity,
    provider: Provider,
    conversations: HashMap<Vec<u8>, Conversation>,
}

#[uniffi::export]
impl MekambClient {
    /// Tworzy nową tożsamość urządzenia z losowym ziarnem.
    #[uniffi::constructor]
    pub fn new(user_id: String, device_id: String) -> Result<Self, MekambError> {
        let identity = DeviceIdentity::generate(user_id, device_id)?;

        Ok(Self {
            inner: Mutex::new(ClientState {
                identity,
                provider: Provider::new(),
                conversations: HashMap::new(),
            }),
        })
    }

    /// Odtwarza klienta z zapisanego ziarna i zrzutu stanu.
    #[uniffi::constructor]
    pub fn restore(
        user_id: String,
        device_id: String,
        seed: Vec<u8>,
        state: Vec<u8>,
    ) -> Result<Self, MekambError> {
        let identity = DeviceIdentity::new(user_id, device_id, DeviceSeed::from_bytes(&seed)?)?;

        Ok(Self {
            inner: Mutex::new(ClientState {
                identity,
                provider: Provider::import_state(&state)?,
                conversations: HashMap::new(),
            }),
        })
    }

    /// Ziarno tożsamości. **Zapisać wyłącznie zaszyfrowane.**
    pub fn export_seed(&self) -> Vec<u8> {
        self.lock().identity.seed().expose_secret_bytes().to_vec()
    }

    /// Zrzut stanu MLS. **Zawiera klucze prywatne — zapisać zaszyfrowany.**
    pub fn export_state(&self) -> Vec<u8> {
        self.lock().provider.export_state_containing_private_keys()
    }

    /// Klucz publiczny podpisu MLS — publikowany w katalogu.
    pub fn mls_public_key(&self) -> Vec<u8> {
        self.lock().identity.signature_keypair().to_public_vec()
    }

    /// 32 bajty klucza węzła iroh, rozłączne z kluczem MLS.
    pub fn iroh_secret(&self) -> Vec<u8> {
        self.lock().identity.seed().iroh_secret_bytes().to_vec()
    }

    pub fn credential_identity(&self) -> String {
        self.lock().identity.credential_identity()
    }

    /// Tworzy key package do publikacji na serwerze.
    pub fn create_key_package(&self) -> Result<Vec<u8>, MekambError> {
        let state = self.lock();
        let bundle = Conversation::create_key_package(&state.provider, &state.identity)?;
        Ok(mekamb_core::group::serialize_key_package(bundle.key_package())?)
    }

    /// Zakłada rozmowę i zwraca jej identyfikator.
    pub fn create_conversation(&self) -> Result<Vec<u8>, MekambError> {
        let mut state = self.lock();
        let conversation = Conversation::create(&state.provider, &state.identity)?;
        let group_id = conversation.group_id().to_vec();
        state.conversations.insert(group_id.clone(), conversation);
        Ok(group_id)
    }

    /// Przygotowuje dodanie członka. Commit wymaga potwierdzenia przez relay.
    pub fn add_member(
        &self,
        group_id: Vec<u8>,
        key_package: Vec<u8>,
    ) -> Result<PendingCommit, MekambError> {
        let mut state = self.lock();

        // Weryfikacja podpisu i okresu ważności dzieje się TUTAJ — key package
        // pochodzi z serwera, który nie jest zaufanym źródłem.
        let package = mekamb_core::group::deserialize_key_package(&state.provider, &key_package)?;

        let ClientState { identity, provider, conversations } = &mut *state;
        let conversation = conversations
            .get_mut(&group_id)
            .ok_or_else(|| MekambError::InvalidInput { powod: "nie ma takiej rozmowy".into() })?;

        let pending = conversation.stage_add_member(provider, identity, &package)?;

        Ok(PendingCommit { commit: pending.commit, welcome: pending.welcome })
    }

    /// Scala commit po potwierdzeniu przez `GroupRelay`.
    pub fn confirm_commit(&self, group_id: Vec<u8>) -> Result<(), MekambError> {
        let mut state = self.lock();
        let ClientState { provider, conversations, .. } = &mut *state;
        Ok(pobierz(conversations, &group_id)?.confirm_pending_commit(provider)?)
    }

    /// Porzuca commit odrzucony przez relay — ktoś był pierwszy.
    pub fn discard_commit(&self, group_id: Vec<u8>) -> Result<(), MekambError> {
        let mut state = self.lock();
        let ClientState { provider, conversations, .. } = &mut *state;
        Ok(pobierz(conversations, &group_id)?.discard_pending_commit(provider)?)
    }

    /// Numer epoki — wysyłany razem z commitem do `GroupRelay`.
    pub fn epoch(&self, group_id: Vec<u8>) -> Result<u64, MekambError> {
        let state = self.lock();
        let conversation = state
            .conversations
            .get(&group_id)
            .ok_or_else(|| MekambError::InvalidInput { powod: "nie ma takiej rozmowy".into() })?;
        Ok(conversation.epoch())
    }

    /// Identyfikatory `user_id:device_id` członków rozmowy.
    pub fn members(&self, group_id: Vec<u8>) -> Result<Vec<String>, MekambError> {
        let state = self.lock();
        let conversation = state
            .conversations
            .get(&group_id)
            .ok_or_else(|| MekambError::InvalidInput { powod: "nie ma takiej rozmowy".into() })?;
        Ok(conversation.members())
    }

    /// Szyfruje wiadomość tekstową i pakuje ją w kopertę gotową do wysłania.
    pub fn seal_text(
        &self,
        group_id: Vec<u8>,
        text: String,
        sent_at_ms: u64,
    ) -> Result<Vec<u8>, MekambError> {
        let mut state = self.lock();
        let ClientState { identity, provider, conversations } = &mut *state;

        let message = ChatMessage::text(text, sent_at_ms);
        let ciphertext = pobierz(conversations, &group_id)?.send(provider, identity, &message)?;

        Ok(Envelope::new(group_id, EnvelopeKind::Application, ciphertext).encode_to_vec())
    }

    /// Przetwarza kopertę odebraną z sieci.
    ///
    /// Obsługuje też zaproszenia: koperta typu `welcome` wprowadza nas do nowej
    /// rozmowy i zwraca [`IncomingEvent::JoinedConversation`].
    pub fn open_envelope(&self, bytes: Vec<u8>) -> Result<IncomingEvent, MekambError> {
        let envelope = Envelope::decode(&bytes)?;
        let mut state = self.lock();

        if envelope.kind() == EnvelopeKind::Welcome {
            let conversation = Conversation::join_from_welcome(&state.provider, &envelope.payload)?;
            let group_id = conversation.group_id().to_vec();
            state.conversations.insert(group_id.clone(), conversation);
            return Ok(IncomingEvent::JoinedConversation { group_id });
        }

        let ClientState { provider, conversations, .. } = &mut *state;
        let incoming = pobierz(conversations, &envelope.group_id)?.receive(provider, &envelope.payload)?;

        Ok(match incoming {
            Incoming::Message { sender_user_id, sender_device_id, message } => {
                IncomingEvent::Message {
                    sender_user_id,
                    sender_device_id,
                    text: message.as_text().unwrap_or_default().to_string(),
                    sent_at_ms: message.sent_at_ms,
                    message_id: message.message_id.clone(),
                }
            }
            Incoming::MembershipChanged => IncomingEvent::MembershipChanged,
            Incoming::ProposalQueued => IncomingEvent::ProposalQueued,
        })
    }
}

impl MekambClient {
    fn lock(&self) -> std::sync::MutexGuard<'_, ClientState> {
        // Zatrucie muteksu oznacza panikę w innym wątku podczas operacji MLS.
        // Stan jest wtedy niepewny, więc odzyskiwanie go byłoby gorsze niż
        // wyraźne przerwanie.
        self.inner.lock().expect("stan klienta został uszkodzony przez panikę")
    }
}

fn pobierz<'a>(
    conversations: &'a mut HashMap<Vec<u8>, Conversation>,
    group_id: &[u8],
) -> Result<&'a mut Conversation, MekambError> {
    conversations
        .get_mut(group_id)
        .ok_or_else(|| MekambError::InvalidInput { powod: "nie ma takiej rozmowy".into() })
}

/// Sieć P2P urządzenia.
///
/// Na Androidzie transport działa w pełni: przebija NAT i łączy się wprost
/// z drugim urządzeniem. To główna różnica względem klienta webowego, który
/// zawsze musi iść przez pośrednika.
#[derive(uniffi::Object)]
pub struct MekambTransport {
    runtime: tokio::runtime::Runtime,
    transport: Transport,
}

#[uniffi::export]
impl MekambTransport {
    /// Uruchamia węzeł P2P na kluczu wyprowadzonym z ziarna urządzenia.
    #[uniffi::constructor]
    pub fn start(iroh_secret: Vec<u8>) -> Result<Self, MekambError> {
        let secret: [u8; 32] =
            iroh_secret.try_into().map_err(|_| MekambError::InvalidInput {
                powod: "klucz węzła musi mieć 32 bajty".into(),
            })?;

        let runtime = tokio::runtime::Runtime::new().map_err(|e| MekambError::Network {
            powod: format!("nie udało się uruchomić runtime: {e}"),
        })?;

        let transport = runtime
            .block_on(Transport::bind_with_secret(secret, RelayPolicy::Public))?;

        Ok(Self { runtime, transport })
    }

    /// Identyfikator węzła — publikowany w katalogu, żeby inni mogli zadzwonić.
    pub fn endpoint_id(&self) -> String {
        self.transport.endpoint_id().to_string()
    }

    /// Czeka na gotowość węzła do przyjmowania połączeń.
    pub fn wait_online(&self) {
        self.runtime.block_on(self.transport.wait_online());
    }

    /// Odbiera jedną kopertę. Blokuje do nadejścia albo zamknięcia transportu.
    ///
    /// Kotlin woła to w pętli na `Dispatchers.IO`.
    pub fn receive_next(&self) -> Result<Option<Vec<u8>>, MekambError> {
        let odebrane = self.runtime.block_on(self.transport.accept_next());

        match odebrane {
            None => Ok(None),
            Some(Err(e)) => Err(e.into()),
            Some(Ok(received)) => Ok(Some(received.envelope.encode_to_vec())),
        }
    }

    pub fn close(&self) {
        self.runtime.block_on(self.transport.close());
    }
}

/// Rozstrzyga, czy kopertę uda się dostarczyć bezpośrednio.
///
/// Zwraca [`DeliveryMode::Mailbox`], gdy adres jest nieznany albo połączenie
/// zawiodło — wtedy warstwa Kotlina wysyła kopertę HTTP-em do skrzynki.
/// Nieosiągalny odbiorca **nie jest błędem**: ma pełne prawo być offline.
#[uniffi::export]
pub fn try_direct_delivery(
    transport: &MekambTransport,
    peer_endpoint_id: Option<String>,
    envelope: Vec<u8>,
) -> DeliveryMode {
    let Some(id) = peer_endpoint_id else {
        return DeliveryMode::Mailbox;
    };

    let Ok(endpoint_id) = id.parse::<iroh_endpoint_id::EndpointId>() else {
        return DeliveryMode::Mailbox;
    };

    let Ok(koperta) = Envelope::decode(&envelope) else {
        return DeliveryMode::Mailbox;
    };

    let wynik = transport.runtime.block_on(
        transport
            .transport
            .send_direct(endpoint_id.into(), &koperta),
    );

    match wynik {
        Ok(()) => DeliveryMode::Direct,
        Err(_) => DeliveryMode::Mailbox,
    }
}

/// Alias porządkujący nazwę typu z iroh.
mod iroh_endpoint_id {
    pub use iroh::EndpointId;
}

/// Zamiana [`Delivery`] z transportu na typ wystawiany do Kotlina.
impl From<Delivery> for DeliveryMode {
    fn from(delivery: Delivery) -> Self {
        match delivery {
            Delivery::Direct => Self::Direct,
            Delivery::Mailbox => Self::Mailbox,
        }
    }
}
