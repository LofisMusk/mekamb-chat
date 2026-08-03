//! Rozmowy oparte na grupach MLS.
//!
//! # DM to grupa dwuosobowa
//!
//! Nie ma osobnej ścieżki kodu dla rozmów prywatnych i grupowych. DM to po
//! prostu grupa o rozmiarze 2. Dzięki temu cała logika kryptograficzna istnieje
//! w jednym egzemplarzu, zamiast w dwóch, które mogą się rozjechać.
//!
//! # Commity wymagają kolejności, wiadomości nie
//!
//! Wiadomości aplikacyjne w obrębie epoki są przemienne — mogą lecieć wprost
//! między urządzeniami przez iroh. **Commity** (dodanie, usunięcie, aktualizacja
//! członka) zmieniają epokę i wymagają jednego autorytatywnego porządku: jeśli
//! dwie osoby jednocześnie kogoś dodadzą, ktoś musi rozstrzygnąć, kto był
//! pierwszy. Tę rolę pełni `GroupRelay` (Durable Object).
//!
//! Dlatego commit **nie jest scalany od razu**. [`Conversation::stage_add_member`]
//! zwraca bajty do wysłania, a stan zmienia dopiero
//! [`Conversation::confirm_pending_commit`] — wołane po potwierdzeniu przez
//! relay. Gdyby scalać natychmiast, przy odrzuceniu commitu przez relay klient
//! zostałby w epoce, której reszta grupy nie zna, i wypadłby z rozmowy.

use openmls::prelude::{
    Ciphersuite, GroupId, KeyPackage, KeyPackageBundle, LeafNodeIndex, MlsGroup,
    MlsGroupCreateConfig, MlsGroupJoinConfig, MlsMessageBodyIn, MlsMessageIn, MlsMessageOut,
    OpenMlsProvider as _, ProcessedMessageContent, ProtocolMessage, StagedWelcome,
    tls_codec::{Deserialize as _, Serialize as _},
};
use openmls_basic_credential::SignatureKeyPair;
use openmls_rust_crypto::OpenMlsRustCrypto;

use crate::error::{Error, Result};
use crate::framing::ChatMessage;
use crate::identity::{DeviceIdentity, parse_credential_identity};

/// Dostawca kryptografii i magazynu.
///
/// Na razie magazyn w pamięci. Trwałe implementacje (SQLite na Androidzie,
/// IndexedDB w przeglądarce) podmieniają wyłącznie tę część — logika grup
/// pozostaje wspólna, bo OpenMLS abstrahuje magazyn traitem `StorageProvider`.
pub type Provider = OpenMlsRustCrypto;

/// Ciphersuite używany w całym projekcie.
///
/// Obowiązkowy do zaimplementowania wariant z RFC 9420, więc gwarantuje
/// interoperacyjność z innymi implementacjami MLS. Ed25519 pasuje do kluczy
/// wyprowadzanych w [`crate::identity`].
pub const CIPHERSUITE: Ciphersuite = Ciphersuite::MLS_128_DHKEMX25519_AES128GCM_SHA256_Ed25519;

/// Rozmiar dopełnienia wiadomości w bajtach.
///
/// MLS szyfruje treść, ale nie ukrywa jej **długości**. Bez dopełnienia
/// obserwator ruchu odróżnia „ok" od dłuższej wypowiedzi. Dopełnianie do
/// wielokrotności 256 bajtów kosztuje trochę pasma i zaciera ten sygnał.
const PADDING_SIZE: usize = 256;

/// Rezultat przetworzenia wiadomości przychodzącej.
#[derive(Debug)]
pub enum Incoming {
    /// Wiadomość aplikacyjna wraz z **uwierzytelnionym** nadawcą.
    ///
    /// `sender_user_id` pochodzi z credentiala MLS zweryfikowanego przez
    /// bibliotekę, a nie z jakiegokolwiek pola dostarczonego przez serwer.
    Message {
        sender_user_id: String,
        sender_device_id: String,
        message: Box<ChatMessage>,
    },
    /// Commit zmieniający skład grupy został przetworzony i scalony.
    MembershipChanged,
    /// Propozycja odłożona do czasu commitu.
    ProposalQueued,
}

/// Commit oczekujący na potwierdzenie przez relay.
///
/// `welcome` jest obecne tylko wtedy, gdy commit dodaje kogoś do grupy.
#[derive(Debug)]
pub struct PendingCommit {
    /// Commit do rozesłania pozostałym członkom (przez `GroupRelay`).
    pub commit: Vec<u8>,
    /// Welcome do wysłania nowo dodanemu członkowi.
    pub welcome: Option<Vec<u8>>,
}

/// Rozmowa: DM albo grupa.
pub struct Conversation {
    group: MlsGroup,
}

impl Conversation {
    /// Zakłada nową rozmowę, w której jesteśmy jedynym członkiem.
    pub fn create(provider: &Provider, identity: &DeviceIdentity) -> Result<Self> {
        let (credential, signer) = identity.credential_with_key();
        store_signer(provider, &signer)?;

        let group = MlsGroup::new(provider, &signer, &create_config(), credential)
            .map_err(|e| Error::Group(format!("nie udało się utworzyć grupy: {e}")))?;

        Ok(Self { group })
    }

    /// Zakłada rozmowę o z góry ustalonym identyfikatorze.
    ///
    /// Przydatne, gdy identyfikator grupy jest wyprowadzany deterministycznie
    /// (np. DM między dwoma użytkownikami), żeby obie strony nie założyły dwóch
    /// równoległych rozmów.
    pub fn create_with_id(
        provider: &Provider,
        identity: &DeviceIdentity,
        group_id: &[u8],
    ) -> Result<Self> {
        let (credential, signer) = identity.credential_with_key();
        store_signer(provider, &signer)?;

        let group = MlsGroup::new_with_group_id(
            provider,
            &signer,
            &create_config(),
            GroupId::from_slice(group_id),
            credential,
        )
        .map_err(|e| Error::Group(format!("nie udało się utworzyć grupy: {e}")))?;

        Ok(Self { group })
    }

    /// Przygotowuje dodanie członka na podstawie jego key package.
    ///
    /// **Nie zmienia jeszcze stanu grupy.** Zwrócony commit należy wysłać do
    /// `GroupRelay`, a po jego potwierdzeniu wywołać
    /// [`Self::confirm_pending_commit`]. Uzasadnienie na górze modułu.
    pub fn stage_add_member(
        &mut self,
        provider: &Provider,
        identity: &DeviceIdentity,
        key_package: &KeyPackage,
    ) -> Result<PendingCommit> {
        let signer = identity.signature_keypair();

        let (commit, welcome, _group_info) = self
            .group
            .add_members(provider, &signer, core::slice::from_ref(key_package))
            .map_err(|e| Error::Group(format!("nie udało się dodać członka: {e}")))?;

        Ok(PendingCommit {
            commit: serialize_message(&commit)?,
            welcome: Some(serialize_message(&welcome)?),
        })
    }

    /// Przygotowuje usunięcie członka wskazanego indeksem liścia.
    pub fn stage_remove_member(
        &mut self,
        provider: &Provider,
        identity: &DeviceIdentity,
        leaf_index: u32,
    ) -> Result<PendingCommit> {
        let signer = identity.signature_keypair();

        let (commit, welcome, _group_info) = self
            .group
            .remove_members(provider, &signer, &[LeafNodeIndex::new(leaf_index)])
            .map_err(|e| Error::Group(format!("nie udało się usunąć członka: {e}")))?;

        Ok(PendingCommit {
            commit: serialize_message(&commit)?,
            welcome: welcome.as_ref().map(serialize_message).transpose()?,
        })
    }

    /// Scala commit przygotowany wcześniej — po potwierdzeniu przez relay.
    pub fn confirm_pending_commit(&mut self, provider: &Provider) -> Result<()> {
        self.group
            .merge_pending_commit(provider)
            .map_err(|e| Error::Group(format!("nie udało się scalić commitu: {e}")))
    }

    /// Porzuca commit odrzucony przez relay (ktoś inny był pierwszy).
    ///
    /// Po tym wywołaniu operację można ponowić na nowej epoce.
    pub fn discard_pending_commit(&mut self, provider: &Provider) -> Result<()> {
        self.group
            .clear_pending_commit(provider.storage())
            .map_err(|e| Error::Group(format!("nie udało się porzucić commitu: {e}")))
    }

    /// Dołącza do rozmowy na podstawie wiadomości Welcome.
    pub fn join_from_welcome(provider: &Provider, welcome_bytes: &[u8]) -> Result<Self> {
        let message = MlsMessageIn::tls_deserialize_exact(welcome_bytes)
            .map_err(|_| Error::MessageRejected)?;

        let MlsMessageBodyIn::Welcome(welcome) = message.extract() else {
            return Err(Error::Group("oczekiwano wiadomości Welcome".into()));
        };

        let staged = StagedWelcome::new_from_welcome(provider, &join_config(), welcome, None)
            .map_err(|_| Error::MessageRejected)?;

        let group = staged
            .into_group(provider)
            .map_err(|e| Error::Group(format!("nie udało się dołączyć do grupy: {e}")))?;

        Ok(Self { group })
    }

    /// Tworzy key package, którym inni mogą nas dodać do grupy.
    ///
    /// Publikowany na serwer z zapasem — pozwala dodać nas do rozmowy, gdy
    /// jesteśmy offline. Każdy key package jest **jednorazowy**; ponowne użycie
    /// psułoby gwarancje forward secrecy, więc serwer musi to egzekwować.
    pub fn create_key_package(
        provider: &Provider,
        identity: &DeviceIdentity,
    ) -> Result<KeyPackageBundle> {
        let (credential, signer) = identity.credential_with_key();
        store_signer(provider, &signer)?;

        KeyPackage::builder()
            .build(CIPHERSUITE, provider, &signer, credential)
            .map_err(|e| Error::Group(format!("nie udało się zbudować key package: {e}")))
    }

    /// Szyfruje wiadomość aplikacyjną dla grupy.
    pub fn send(
        &mut self,
        provider: &Provider,
        identity: &DeviceIdentity,
        message: &ChatMessage,
    ) -> Result<Vec<u8>> {
        let signer = identity.signature_keypair();

        let out = self
            .group
            .create_message(provider, &signer, &message.encode_to_vec())
            .map_err(|e| Error::Group(format!("nie udało się zaszyfrować wiadomości: {e}")))?;

        serialize_message(&out)
    }

    /// Przetwarza wiadomość odebraną z sieci.
    ///
    /// Każdy błąd kryptograficzny mapuje się na [`Error::MessageRejected`] bez
    /// szczegółów — rozróżnianie „zły podpis" od „zła epoka" w komunikacie
    /// zwracanym na zewnątrz dawałoby atakującemu oracle.
    pub fn receive(&mut self, provider: &Provider, bytes: &[u8]) -> Result<Incoming> {
        let message =
            MlsMessageIn::tls_deserialize_exact(bytes).map_err(|_| Error::MessageRejected)?;

        let protocol_message: ProtocolMessage = message
            .try_into_protocol_message()
            .map_err(|_| Error::MessageRejected)?;

        let processed = self
            .group
            .process_message(provider, protocol_message)
            .map_err(|_| Error::MessageRejected)?;

        // Tożsamość nadawcy bierzemy z credentiala zweryfikowanego przez
        // OpenMLS. To jedyne wiarygodne źródło — pola spoza kanału MLS mogły
        // zostać podmienione po drodze.
        let (sender_user_id, sender_device_id) =
            parse_credential_identity(processed.credential().serialized_content())?;

        match processed.into_content() {
            ProcessedMessageContent::ApplicationMessage(application) => {
                let message = ChatMessage::decode(&application.into_bytes())?;
                Ok(Incoming::Message {
                    sender_user_id,
                    sender_device_id,
                    message: Box::new(message),
                })
            }
            ProcessedMessageContent::StagedCommitMessage(staged) => {
                self.group
                    .merge_staged_commit(provider, *staged)
                    .map_err(|e| Error::Group(format!("nie udało się scalić commitu: {e}")))?;
                Ok(Incoming::MembershipChanged)
            }
            ProcessedMessageContent::ProposalMessage(proposal) => {
                self.group
                    .store_pending_proposal(provider.storage(), *proposal)
                    .map_err(|e| {
                        Error::Storage(format!("nie udało się zapisać propozycji: {e}"))
                    })?;
                Ok(Incoming::ProposalQueued)
            }
            ProcessedMessageContent::ExternalJoinProposalMessage(_) => {
                // Dołączanie z zewnątrz nie jest w tej wersji obsługiwane;
                // wpuszczenie go bez świadomej decyzji projektowej byłoby luką.
                Err(Error::Group(
                    "zewnętrzne propozycje dołączenia nie są obsługiwane".into(),
                ))
            }
        }
    }

    /// Identyfikator grupy.
    pub fn group_id(&self) -> &[u8] {
        self.group.group_id().as_slice()
    }

    /// Numer bieżącej epoki. Rośnie z każdym scalonym commitem.
    pub fn epoch(&self) -> u64 {
        self.group.epoch().as_u64()
    }

    /// Identyfikatory `user_id:device_id` wszystkich członków.
    pub fn members(&self) -> Vec<String> {
        self.group
            .members()
            .map(|m| String::from_utf8_lossy(m.credential.serialized_content()).into_owned())
            .collect()
    }
}

/// Konfiguracja zakładania grupy.
fn create_config() -> MlsGroupCreateConfig {
    MlsGroupCreateConfig::builder()
        .padding_size(PADDING_SIZE)
        .ciphersuite(CIPHERSUITE)
        // Drzewo ratchetu podróżuje w wiadomości zamiast być rozsyłane osobno.
        // Kosztuje pasmo, ale usuwa potrzebę pobierania go z serwera — istotne
        // w architekturze P2P-first, gdzie serwer bywa nieosiągalny.
        .use_ratchet_tree_extension(true)
        .build()
}

/// Konfiguracja dołączania do grupy. Musi odpowiadać [`create_config`].
fn join_config() -> MlsGroupJoinConfig {
    MlsGroupJoinConfig::builder()
        .padding_size(PADDING_SIZE)
        .use_ratchet_tree_extension(true)
        .build()
}

/// Zapisuje klucz podpisu w magazynie dostawcy.
///
/// OpenMLS odnajduje go później po kluczu publicznym przy operacjach na grupie.
fn store_signer(provider: &Provider, signer: &SignatureKeyPair) -> Result<()> {
    signer
        .store(provider.storage())
        .map_err(|e| Error::Storage(format!("nie udało się zapisać klucza podpisu: {e}")))
}

/// Serializuje wiadomość MLS do postaci sieciowej.
fn serialize_message(message: &MlsMessageOut) -> Result<Vec<u8>> {
    message
        .tls_serialize_detached()
        .map_err(|e| Error::Group(format!("nie udało się zserializować wiadomości: {e}")))
}
