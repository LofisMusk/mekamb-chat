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
use mekamb_transport::{Delivery, Envelope, EnvelopeKind, PeerAddr, Transport};

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
            | E::Framing(_) => Self::InvalidInput {
                powod: error.to_string(),
            },
            E::Group(_) => Self::Crypto {
                powod: error.to_string(),
            },
            E::Storage(_) => Self::Network {
                powod: error.to_string(),
            },
        }
    }
}

impl From<mekamb_transport::Error> for MekambError {
    fn from(error: mekamb_transport::Error) -> Self {
        use mekamb_transport::Error as E;
        match error {
            // Nieosiągalny odbiorca nie jest awarią — ma prawo być offline.
            E::PeerUnreachable | E::Transport(_) => Self::Network {
                powod: error.to_string(),
            },
            E::Core(inner) => inner.into(),
        }
    }
}

/// Rodzaj zdarzenia odebranego z sieci.
#[derive(Debug, Clone, uniffi::Enum)]
pub enum IncomingEvent {
    /// Wiadomość aplikacyjna wraz z **uwierzytelnionym** nadawcą.
    Message {
        /// Rozmowa, do której należy ta wiadomość.
        ///
        /// Bez tego pola klient nie ma jak rozpoznać, gdzie ją zapisać —
        /// dopisywał ją do rozmowy akurat otwartej na ekranie, więc wiadomość
        /// z jednej rozmowy lądowała w historii drugiej. Wiązanie WASM niosło
        /// identyfikator od początku (`receive` zwraca `groupId`), to tutaj go
        /// brakowało.
        group_id: Vec<u8>,
        sender_user_id: String,
        sender_device_id: String,
        text: String,
        /// Czas zadeklarowany przez nadawcę — nie jest faktem.
        sent_at_ms: u64,
        message_id: Vec<u8>,
    },
    /// Załącznik: metadane i klucz do odszyfrowania pobranego szyfrogramu.
    ///
    /// Klucz jedzie **wewnątrz** wiadomości MLS, a szyfrogram leży w R2 —
    /// serwer nigdy nie ma obu naraz.
    Attachment {
        group_id: Vec<u8>,
        sender_user_id: String,
        sender_device_id: String,
        blob_id: String,
        decryption_key: Vec<u8>,
        nonce: Vec<u8>,
        mime_type: String,
        size_bytes: u64,
        file_name: Option<String>,
        sent_at_ms: u64,
        message_id: Vec<u8>,
    },
    /// Sygnalizacja rozmowy A/V — oferta, odpowiedź, kandydat ICE albo rozłączenie.
    CallSignal {
        group_id: Vec<u8>,
        sender_user_id: String,
        sender_device_id: String,
        kind: CallSignalKind,
        call_id: Vec<u8>,
        payload: String,
        /// Odcisk DTLS zadeklarowany w MLS — do porównania z tym z SDP.
        dtls_fingerprint: String,
        /// Adresat sygnału w rozmowie mesh; pusty znaczy „do wszystkich".
        target: String,
        sent_at_ms: u64,
    },
    /// Potwierdzenie dostarczenia albo odczytu naszych wiadomości.
    ///
    /// Nie niesie chwili odczytu — to dokładnie ta informacja, której nie
    /// chcemy oddawać. Ukrycie **momentu** wysyłki jest zadaniem klienta,
    /// który zbiera potwierdzenia i wysyła je paczką po losowym opóźnieniu.
    Receipt {
        group_id: Vec<u8>,
        sender_user_id: String,
        sender_device_id: String,
        kind: ReceiptKind,
        /// Identyfikatory potwierdzanych wiadomości, po 16 bajtów każdy.
        message_ids: Vec<Vec<u8>>,
    },
    /// Skład grupy uległ zmianie.
    MembershipChanged,
    /// Propozycja odłożona do czasu commitu.
    ProposalQueued,
    /// Dołączyliśmy do nowej rozmowy.
    JoinedConversation { group_id: Vec<u8> },
}

/// Zaszyfrowana wiadomość razem z jej identyfikatorem.
///
/// # Dlaczego identyfikator wraca do wołającego
///
/// Bo potwierdzenia wskazują wiadomości właśnie po nim. Wcześniej rdzeń losował
/// go w środku i nie oddawał, a klient Androida w ogóle go nie zapisywał —
/// potwierdzenie odczytu nie trafiłoby wtedy w żaden dymek, a nikt by nie
/// zauważył dlaczego: ptaszek po prostu nigdy by się nie zmienił.
#[derive(Debug, Clone, uniffi::Record)]
pub struct ZapakowanaWiadomosc {
    /// Gotowa koperta do wysłania.
    pub koperta: Vec<u8>,
    /// Identyfikator wiadomości — 16 bajtów, do wiązania z potwierdzeniami.
    pub message_id: Vec<u8>,
}

/// Rodzaj potwierdzenia.
///
/// Własny typ zamiast łańcucha znaków z tego samego powodu co przy sygnale
/// rozmowy: literówka ma być błędem kompilacji Kotlina, a nie cichym brakiem
/// ptaszka na dymku.
#[derive(Debug, Clone, Copy, PartialEq, Eq, uniffi::Enum)]
pub enum ReceiptKind {
    /// Koperta dotarła i została przetworzona.
    Delivered,
    /// Rozmowa była otwarta na ekranie.
    Read,
}

impl From<ReceiptKind> for mekamb_core::framing::ReceiptKind {
    fn from(kind: ReceiptKind) -> Self {
        match kind {
            ReceiptKind::Delivered => Self::Delivered,
            ReceiptKind::Read => Self::Read,
        }
    }
}

/// Rodzaj sygnału rozmowy A/V.
///
/// Własny typ zamiast łańcucha znaków, jak w wiązaniu WASM: UniFFI generuje
/// z tego enum Kotlina, więc literówka w nazwie rodzaju przestaje być błędem
/// wykrywanym dopiero w czasie działania.
#[derive(Debug, Clone, Copy, PartialEq, Eq, uniffi::Enum)]
pub enum CallSignalKind {
    Offer,
    Answer,
    IceCandidate,
    Hangup,
    /// Sygnał, którego ta wersja nie rozumie — do zignorowania, nie do awarii.
    Unspecified,
}

impl From<mekamb_core::framing::CallSignalKind> for CallSignalKind {
    fn from(kind: mekamb_core::framing::CallSignalKind) -> Self {
        match kind {
            mekamb_core::framing::CallSignalKind::Offer => Self::Offer,
            mekamb_core::framing::CallSignalKind::Answer => Self::Answer,
            mekamb_core::framing::CallSignalKind::IceCandidate => Self::IceCandidate,
            mekamb_core::framing::CallSignalKind::Hangup => Self::Hangup,
            mekamb_core::framing::CallSignalKind::Unspecified => Self::Unspecified,
        }
    }
}

impl From<CallSignalKind> for mekamb_core::framing::CallSignalKind {
    fn from(kind: CallSignalKind) -> Self {
        match kind {
            CallSignalKind::Offer => Self::Offer,
            CallSignalKind::Answer => Self::Answer,
            CallSignalKind::IceCandidate => Self::IceCandidate,
            CallSignalKind::Hangup => Self::Hangup,
            CallSignalKind::Unspecified => Self::Unspecified,
        }
    }
}

/// Zaszyfrowany załącznik gotowy do wysłania.
///
/// Klucz i nonce **nie** jadą razem z szyfrogramem: szyfrogram trafia do R2,
/// a klucz do wiadomości MLS. Serwer nigdy nie ma obu naraz.
#[derive(Debug, uniffi::Record)]
pub struct SealedAttachment {
    pub ciphertext: Vec<u8>,
    pub key: Vec<u8>,
    pub nonce: Vec<u8>,
}

/// Kod QR jako płaska tablica modułów.
///
/// Płasko, bo UniFFI nie przenosi zagnieżdżonych list bez kosztu po obu
/// stronach, a odbiorca i tak rysuje to w pętli po współrzędnych.
#[derive(Debug, Clone, uniffi::Record)]
pub struct KodQr {
    /// Bok kodu w modułach, bez cichego marginesu.
    pub bok: u32,
    /// `true` znaczy moduł ciemny. Długość to `bok * bok`.
    pub moduly: Vec<bool>,
}

/// Szyfruje załącznik kluczem jednorazowym.
///
/// Klucz nie wraca do serwera w żadnej postaci — jedzie osobno, w wiadomości
/// MLS. Ta sama implementacja obsługuje klienta webowego (`sealAttachment`
/// w wiązaniu WASM), więc format nie ma jak się rozjechać między platformami.
#[uniffi::export]
pub fn seal_attachment(
    plaintext: Vec<u8>,
    mime_type: String,
) -> Result<SealedAttachment, MekambError> {
    let sealed = mekamb_core::seal_attachment(&plaintext, &mime_type)?;

    // Kopiujemy zamiast przenosić: `SealedAttachment` w rdzeniu implementuje
    // `Drop`, żeby wyzerować klucz przy zwolnieniu, a to wyklucza rozbiórkę
    // struktury na części.
    Ok(SealedAttachment {
        ciphertext: sealed.ciphertext.clone(),
        key: sealed.key.to_vec(),
        nonce: sealed.nonce.to_vec(),
    })
}

/// Odszyfrowuje załącznik pobrany z serwera.
#[uniffi::export]
pub fn open_attachment(
    ciphertext: Vec<u8>,
    key: Vec<u8>,
    nonce: Vec<u8>,
    mime_type: String,
) -> Result<Vec<u8>, MekambError> {
    Ok(mekamb_core::open_attachment(
        &ciphertext,
        &key,
        &nonce,
        &mime_type,
    )?)
}

/// Górny limit rozmiaru załącznika — interfejs odsiewa za duże pliki od razu.
#[uniffi::export]
pub fn max_attachment_bytes() -> u64 {
    mekamb_core::MAX_ATTACHMENT_BYTES as u64
}

/// Usuwa metadane z pliku — zdjęcia albo wideo.
///
/// Wołane **przed** zaszyfrowaniem: dane umieszczone w środku szyfrogramu
/// docierają do odbiorcy tak samo jak sama treść, więc szyfrowanie nie chroni
/// przed tym, co sami tam włożyliśmy. Obraz i dźwięk zostają nietknięte.
#[uniffi::export]
pub fn strip_metadata(bytes: Vec<u8>, mime_type: String) -> Result<Vec<u8>, MekambError> {
    Ok(mekamb_core::media::strip_metadata(&bytes, &mime_type)?)
}

/// Czy dla tego typu pliku potrafimy usunąć metadane.
#[uniffi::export]
pub fn can_strip_metadata(mime_type: String) -> bool {
    mekamb_core::can_strip(&mime_type)
}

/// Sprawdza, czy SDP niesie DOKŁADNIE ten odcisk, który przyszedł kanałem MLS.
///
/// To jest miejsce, w którym rozmowa A/V przestaje ufać sygnalizacji. SDP
/// przechodzi przez serwer; odcisk przychodzi zaszyfrowanym kanałem MLS.
/// Niezgodność znaczy, że ktoś podstawił własne połączenie DTLS — wtedy
/// zrywamy, bez pytania użytkownika o zgodę.
#[uniffi::export]
pub fn verify_sdp_fingerprint(sdp: String, expected: String) -> Result<(), MekambError> {
    Ok(mekamb_core::calls::verify_sdp_fingerprint(&sdp, &expected)?)
}

/// Odcisk DTLS z własnego SDP — do wysłania kanałem MLS.
#[uniffi::export]
pub fn own_sdp_fingerprint(sdp: String) -> Result<String, MekambError> {
    mekamb_core::calls::extract_fingerprints(&sdp)
        .into_iter()
        .next()
        .ok_or_else(|| MekambError::InvalidInput {
            powod: "SDP nie zawiera odcisku DTLS".into(),
        })
}

/// Generuje kod QR.
///
/// Jedna implementacja dla obu klientów — patrz [`mekamb_core::qr`]. Kod niesie
/// klucz przeniesienia konta i sekret TOTP, więc druga implementacja po drugiej
/// stronie prędzej czy później rozjechałaby się z pierwszą.
#[uniffi::export]
pub fn qr_code(text: String) -> Result<KodQr, MekambError> {
    let macierz = mekamb_core::qr::qr_matrix(&text)?;

    Ok(KodQr {
        bok: macierz.len() as u32,
        moduly: macierz.into_iter().flatten().collect(),
    })
}

/// Commit oczekujący na potwierdzenie przez `GroupRelay`.
///
/// Oba pola są **gotowymi kopertami**, nie surowymi bajtami MLS. Wcześniej
/// wychodziły stąd surowe i Kotlin miał je opakować sam — czego nie robił,
/// więc serwer odrzucał commit, a odbiorca nie miał jak rozpoznać welcome.
/// Kodowanie kopert zostaje po stronie Rusta, jak przy `seal_text`: drugi
/// enkoder po stronie interfejsu prędzej czy później rozjechałby się
/// z pierwszym.
#[derive(Debug, Clone, uniffi::Record)]
pub struct PendingCommit {
    /// Koperta rodzaju `commit` — do zgłoszenia w `GroupRelay`.
    pub commit: Vec<u8>,
    /// Koperta rodzaju `welcome` — do wysłania nowemu członkowi.
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
        Ok(mekamb_core::group::serialize_key_package(
            bundle.key_package(),
        )?)
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
        self.add_members(group_id, vec![key_package])
    }

    /// Przygotowuje dodanie wielu urządzeń **jednym** commitem.
    ///
    /// Jedna osoba ma kilka urządzeń, a członkiem grupy jest urządzenie.
    /// Dodawanie ich po kolei zajmowałoby osobną epokę na każde i mogło się
    /// zatrzymać w połowie — patrz `Conversation::stage_add_members`.
    pub fn add_members(
        &self,
        group_id: Vec<u8>,
        key_packages: Vec<Vec<u8>>,
    ) -> Result<PendingCommit, MekambError> {
        let mut state = self.lock();

        // Weryfikacja podpisu i okresu ważności dzieje się TUTAJ — key package
        // pochodzi z serwera, który nie jest zaufanym źródłem.
        let packages = key_packages
            .iter()
            .map(|bajty| mekamb_core::group::deserialize_key_package(&state.provider, bajty))
            .collect::<mekamb_core::error::Result<Vec<_>>>()?;

        let ClientState {
            identity,
            provider,
            conversations,
        } = &mut *state;
        let conversation =
            conversations
                .get_mut(&group_id)
                .ok_or_else(|| MekambError::InvalidInput {
                    powod: "nie ma takiej rozmowy".into(),
                })?;

        let pending = conversation.stage_add_members(provider, identity, &packages)?;

        Ok(PendingCommit {
            commit: Envelope::new(&group_id, EnvelopeKind::Commit, pending.commit).encode_to_vec(),
            welcome: pending.welcome.map(|welcome| {
                Envelope::new(&group_id, EnvelopeKind::Welcome, welcome).encode_to_vec()
            }),
        })
    }

    /// Scala commit po potwierdzeniu przez `GroupRelay`.
    /// Usuwa urządzenie z rozmowy — odebranie dostępu zgubionemu sprzętowi.
    ///
    /// Zwraca `None`, gdy tego urządzenia w tej rozmowie nie ma. To nie jest
    /// błąd: przy odbieraniu dostępu przechodzi się po wszystkich rozmowach,
    /// a część mogła powstać już po zgubieniu sprzętu.
    pub fn remove_device(
        &self,
        group_id: Vec<u8>,
        credential_identity: String,
    ) -> Result<Option<PendingCommit>, MekambError> {
        let mut state = self.lock();
        let ClientState {
            identity,
            provider,
            conversations,
        } = &mut *state;

        let conversation =
            conversations
                .get_mut(&group_id)
                .ok_or_else(|| MekambError::InvalidInput {
                    powod: "nie ma takiej rozmowy".into(),
                })?;

        let pending = conversation.stage_remove_device(provider, identity, &credential_identity)?;

        Ok(pending.map(|p| PendingCommit {
            commit: p.commit,
            welcome: p.welcome,
        }))
    }

    pub fn confirm_commit(&self, group_id: Vec<u8>) -> Result<(), MekambError> {
        let mut state = self.lock();
        let ClientState {
            provider,
            conversations,
            ..
        } = &mut *state;
        Ok(pobierz(conversations, &group_id)?.confirm_pending_commit(provider)?)
    }

    /// Porzuca commit odrzucony przez relay — ktoś był pierwszy.
    pub fn discard_commit(&self, group_id: Vec<u8>) -> Result<(), MekambError> {
        let mut state = self.lock();
        let ClientState {
            provider,
            conversations,
            ..
        } = &mut *state;
        Ok(pobierz(conversations, &group_id)?.discard_pending_commit(provider)?)
    }

    /// Numer epoki — wysyłany razem z commitem do `GroupRelay`.
    /// Otwiera rozmowę zapisaną w magazynie.
    ///
    /// Zwraca `false`, gdy magazyn tej grupy nie zna — rozmowa jest w historii,
    /// ale bez stanu MLS (np. po przeniesieniu konta).
    ///
    /// Wołający musi to zrobić dla każdej znanej rozmowy PO odtworzeniu klienta.
    /// Bez tego klient ma pełny stan na dysku i pustą listę otwartych rozmów,
    /// więc po restarcie aplikacji nie da się ani wysłać, ani odebrać niczego.
    pub fn open_conversation(&self, group_id: Vec<u8>) -> Result<bool, MekambError> {
        let mut state = self.lock();
        if state.conversations.contains_key(&group_id) {
            return Ok(true);
        }

        match Conversation::load(&state.provider, &group_id)? {
            Some(conversation) => {
                state.conversations.insert(group_id, conversation);
                Ok(true)
            }
            None => Ok(false),
        }
    }

    /// Nazwa obiektu porządkującego epoki dla tej rozmowy.
    ///
    /// Osobno wyprowadzona, nie surowy identyfikator: serwer widzi tę wartość
    /// w adresie żądania, a z niej nie da się wrócić do klucza routingu kopert.
    /// Gdyby relay nazywał się identyfikatorem rozmowy, serwer policzyłby
    /// znaczniki sam i ukrywanie ich w kopercie nie dawałoby nic.
    pub fn relay_id(&self, group_id: Vec<u8>) -> String {
        mekamb_core::identyfikator_relaya(&group_id)
    }

    pub fn epoch(&self, group_id: Vec<u8>) -> Result<u64, MekambError> {
        let state = self.lock();
        let conversation =
            state
                .conversations
                .get(&group_id)
                .ok_or_else(|| MekambError::InvalidInput {
                    powod: "nie ma takiej rozmowy".into(),
                })?;
        Ok(conversation.epoch())
    }

    /// Safety number rozmowy — kod do porównania z rozmówcą innym kanałem.
    ///
    /// Liczony z kluczy tożsamości **z drzewa MLS**, więc podstawienie cudzego
    /// urządzenia przez serwer zmienia wynik.
    pub fn safety_number(&self, group_id: Vec<u8>) -> Result<String, MekambError> {
        let state = self.lock();
        let conversation =
            state
                .conversations
                .get(&group_id)
                .ok_or_else(|| MekambError::InvalidInput {
                    powod: "nie ma takiej rozmowy".into(),
                })?;
        Ok(conversation.safety_number()?)
    }

    /// Odcisk tego urządzenia — do przepisania z ekranu na ekran przy linkowaniu.
    pub fn device_fingerprint(&self) -> Result<String, MekambError> {
        let state = self.lock();
        Ok(mekamb_core::device_fingerprint(
            &state.identity.signature_keypair().to_public_vec(),
        )?)
    }

    /// Identyfikatory `user_id:device_id` członków rozmowy.
    pub fn members(&self, group_id: Vec<u8>) -> Result<Vec<String>, MekambError> {
        let state = self.lock();
        let conversation =
            state
                .conversations
                .get(&group_id)
                .ok_or_else(|| MekambError::InvalidInput {
                    powod: "nie ma takiej rozmowy".into(),
                })?;
        Ok(conversation.members())
    }

    /// Szyfruje wiadomość tekstową i pakuje ją w kopertę gotową do wysłania.
    pub fn seal_text(
        &self,
        group_id: Vec<u8>,
        text: String,
        sent_at_ms: u64,
    ) -> Result<ZapakowanaWiadomosc, MekambError> {
        let mut state = self.lock();
        let ClientState {
            identity,
            provider,
            conversations,
        } = &mut *state;

        let message = ChatMessage::text(text, sent_at_ms);
        let message_id = message.message_id.clone();
        let ciphertext = pobierz(conversations, &group_id)?.send(provider, identity, &message)?;

        Ok(ZapakowanaWiadomosc {
            koperta: Envelope::new(&group_id, EnvelopeKind::Application, ciphertext)
                .encode_to_vec(),
            message_id,
        })
    }

    /// Pakuje załącznik: metadane i klucz jadą w wiadomości MLS.
    ///
    /// Sam szyfrogram trafia osobno do R2 — ta funkcja go nie dotyka. Dzięki
    /// temu serwer nigdy nie ma klucza i szyfrogramu naraz.
    #[allow(clippy::too_many_arguments)]
    pub fn seal_attachment_message(
        &self,
        group_id: Vec<u8>,
        blob_id: String,
        key: Vec<u8>,
        nonce: Vec<u8>,
        mime_type: String,
        size_bytes: u64,
        file_name: Option<String>,
        sent_at_ms: u64,
    ) -> Result<ZapakowanaWiadomosc, MekambError> {
        let mut state = self.lock();
        let ClientState {
            identity,
            provider,
            conversations,
        } = &mut *state;

        let message = ChatMessage::attachment(
            mekamb_core::framing::AttachmentBody {
                blob_id,
                decryption_key: key,
                nonce,
                mime_type,
                size_bytes,
                file_name,
            },
            sent_at_ms,
        );
        let message_id = message.message_id.clone();
        let ciphertext = pobierz(conversations, &group_id)?.send(provider, identity, &message)?;

        Ok(ZapakowanaWiadomosc {
            koperta: Envelope::new(&group_id, EnvelopeKind::Application, ciphertext)
                .encode_to_vec(),
            message_id,
        })
    }

    /// Szyfruje sygnalizację rozmowy A/V i pakuje ją do wysłania.
    ///
    /// `dtls_fingerprint` podróżuje **wewnątrz** MLS, niezależnie od SDP.
    /// Odbiorca porówna jedno z drugim przed zestawieniem połączenia — bez
    /// tego pośrednik mógłby podstawić własne połączenie DTLS, a rozmowa
    /// wyglądałaby na zabezpieczoną.
    #[allow(clippy::too_many_arguments)]
    pub fn seal_call_signal(
        &self,
        group_id: Vec<u8>,
        kind: CallSignalKind,
        call_id: Vec<u8>,
        payload: String,
        dtls_fingerprint: String,
        target: String,
        sent_at_ms: u64,
    ) -> Result<Vec<u8>, MekambError> {
        let mut state = self.lock();
        let ClientState {
            identity,
            provider,
            conversations,
        } = &mut *state;

        let message = ChatMessage::call_signal(
            mekamb_core::framing::CallSignalBody {
                kind: mekamb_core::framing::CallSignalKind::from(kind) as i32,
                call_id,
                payload,
                dtls_fingerprint,
                target,
            },
            sent_at_ms,
        );
        let ciphertext = pobierz(conversations, &group_id)?.send(provider, identity, &message)?;

        Ok(Envelope::new(&group_id, EnvelopeKind::Application, ciphertext).encode_to_vec())
    }

    /// Szyfruje i pakuje paczkę potwierdzeń.
    ///
    /// Potwierdzenie jest zwykłą wiadomością aplikacyjną MLS, więc serwer widzi
    /// wyłącznie szyfrogram. **Nie ukrywa to chwili**, w której koperta poszła
    /// — o to dba wołający, opóźniając wysyłkę (patrz `Potwierdzenia.kt`).
    pub fn send_receipt(
        &self,
        group_id: Vec<u8>,
        kind: ReceiptKind,
        message_ids: Vec<Vec<u8>>,
        sent_at_ms: u64,
    ) -> Result<Vec<u8>, MekambError> {
        let mut state = self.lock();
        let ClientState {
            identity,
            provider,
            conversations,
        } = &mut *state;

        let message = ChatMessage::receipt(kind.into(), message_ids, sent_at_ms);
        let ciphertext = pobierz(conversations, &group_id)?.send(provider, identity, &message)?;

        Ok(Envelope::new(&group_id, EnvelopeKind::Application, ciphertext).encode_to_vec())
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

        let ClientState {
            provider,
            conversations,
            ..
        } = &mut *state;

        /*
         * Rozmowę rozpoznajemy po znaczniku, nie z koperty.
         *
         * Koperta nie niesie identyfikatora rozmowy — niosła go do wersji 2
         * formatu i było to jedyne, czego serwer potrzebował, żeby zbudować
         * graf rozmów z samego ruchu. Teraz każda koperta ma inny znacznik,
         * a dopasowanie kosztuje jedno HKDF na rozmowę.
         */
        let group_id = conversations
            .keys()
            .find(|group_id| envelope.pasuje_do(group_id))
            .cloned()
            .ok_or(MekambError::MessageRejected)?;

        let incoming = pobierz(conversations, &group_id)?.receive(provider, &envelope.payload)?;

        Ok(match incoming {
            Incoming::Message {
                sender_user_id,
                sender_device_id,
                message,
            } => {
                // Rozróżnienie po TREŚCI, nie po deklaracji nadawcy: wiadomość
                // z ciałem załącznika, podana jako tekst, dawała pusty dymek —
                // `as_text` zwraca wtedy `None`, a klient nie miał czego pokazać.
                if let Some(zalacznik) = message.as_attachment() {
                    IncomingEvent::Attachment {
                        group_id,
                        sender_user_id,
                        sender_device_id,
                        blob_id: zalacznik.blob_id.clone(),
                        decryption_key: zalacznik.decryption_key.clone(),
                        nonce: zalacznik.nonce.clone(),
                        mime_type: zalacznik.mime_type.clone(),
                        size_bytes: zalacznik.size_bytes,
                        file_name: zalacznik.file_name.clone(),
                        sent_at_ms: message.sent_at_ms,
                        message_id: message.message_id.clone(),
                    }
                } else if let Some(potwierdzenie) = message.as_receipt() {
                    IncomingEvent::Receipt {
                        group_id,
                        sender_user_id,
                        sender_device_id,
                        // Nierozpoznany rodzaj z sieci traktujemy jak dostarczenie:
                        // to słabsze z dwóch twierdzeń, więc pomyłka w tę stronę
                        // nie pokaże „przeczytane" tam, gdzie nikt nie czytał.
                        kind: match mekamb_core::framing::ReceiptKind::try_from(potwierdzenie.kind)
                        {
                            Ok(mekamb_core::framing::ReceiptKind::Read) => ReceiptKind::Read,
                            _ => ReceiptKind::Delivered,
                        },
                        message_ids: potwierdzenie.message_ids.clone(),
                    }
                } else if let Some(sygnal) = message.as_call_signal() {
                    IncomingEvent::CallSignal {
                        group_id,
                        sender_user_id,
                        sender_device_id,
                        kind: CallSignalKind::from(
                            mekamb_core::framing::CallSignalKind::try_from(sygnal.kind)
                                .unwrap_or(mekamb_core::framing::CallSignalKind::Unspecified),
                        ),
                        call_id: sygnal.call_id.clone(),
                        payload: sygnal.payload.clone(),
                        dtls_fingerprint: sygnal.dtls_fingerprint.clone(),
                        target: sygnal.target.clone(),
                        sent_at_ms: message.sent_at_ms,
                    }
                } else {
                    IncomingEvent::Message {
                        group_id,
                        sender_user_id,
                        sender_device_id,
                        text: message.as_text().unwrap_or_default().to_string(),
                        sent_at_ms: message.sent_at_ms,
                        message_id: message.message_id.clone(),
                    }
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
        self.inner
            .lock()
            .expect("stan klienta został uszkodzony przez panikę")
    }
}

fn pobierz<'a>(
    conversations: &'a mut HashMap<Vec<u8>, Conversation>,
    group_id: &[u8],
) -> Result<&'a mut Conversation, MekambError> {
    conversations
        .get_mut(group_id)
        .ok_or_else(|| MekambError::InvalidInput {
            powod: "nie ma takiej rozmowy".into(),
        })
}

/// Sieć P2P urządzenia.
///
/// Na Androidzie transport działa w pełni: przebija NAT i łączy się wprost
/// z drugim urządzeniem. To główna różnica względem klienta webowego, który
/// zawsze musi iść przez pośrednika.
///
/// Implementacja jest własna — UDP, STUN i Noise. Poprzednia opierała się na
/// iroh, który na Androidzie przerywał proces przez zależność wymagającą
/// inicjalizacji JNI. Szczegóły w `transport/src/lib.rs`.
#[derive(uniffi::Object)]
pub struct MekambTransport {
    runtime: tokio::runtime::Runtime,
    transport: Transport,
}

#[uniffi::export]
impl MekambTransport {
    /// Uruchamia węzeł P2P na kluczu wyprowadzonym z ziarna urządzenia.
    #[uniffi::constructor]
    pub fn start(transport_secret: Vec<u8>) -> Result<Self, MekambError> {
        let secret: [u8; 32] =
            transport_secret
                .try_into()
                .map_err(|_| MekambError::InvalidInput {
                    powod: "klucz węzła musi mieć 32 bajty".into(),
                })?;

        let runtime = tokio::runtime::Runtime::new().map_err(|e| MekambError::Network {
            powod: format!("nie udało się uruchomić runtime: {e}"),
        })?;

        let transport = runtime.block_on(Transport::bind_with_secret(secret))?;

        Ok(Self { runtime, transport })
    }

    /// Klucz publiczny węzła — publikowany w katalogu.
    pub fn public_key(&self) -> Vec<u8> {
        self.transport.public_key().to_vec()
    }

    /// Adresy, pod którymi urządzenie jest osiągalne.
    ///
    /// Zwykle dwa: lokalny i publiczny poznany przez STUN. Pusta lista znaczy,
    /// że nie udało się poznać żadnego — wtedy działa wyłącznie skrzynka.
    pub fn addresses(&self) -> Vec<String> {
        self.transport
            .addresses()
            .iter()
            .map(|a| a.to_string())
            .collect()
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

    /// Zamyka węzeł P2P.
    ///
    /// Nazwa celowo inna niż `close`: UniFFI generuje dla każdego obiektu
    /// `AutoCloseable.close()` do zwalniania uchwytu natywnego, a własna
    /// metoda o tej nazwie tworzy w Kotlinie kolizję przeciążeń.
    pub fn shutdown(&self) {
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
    peer_public_key: Option<Vec<u8>>,
    peer_addresses: Vec<String>,
    envelope: Vec<u8>,
) -> DeliveryMode {
    let Some(public_key) = peer_public_key else {
        return DeliveryMode::Mailbox;
    };

    let addresses: Vec<_> = peer_addresses
        .iter()
        .filter_map(|a| a.parse().ok())
        .collect();
    if addresses.is_empty() {
        return DeliveryMode::Mailbox;
    }

    let Ok(koperta) = Envelope::decode(&envelope) else {
        return DeliveryMode::Mailbox;
    };

    let peer = PeerAddr {
        public_key,
        addresses,
    };

    match transport
        .runtime
        .block_on(transport.transport.send_direct(&peer, &koperta))
    {
        Ok(()) => DeliveryMode::Direct,
        Err(_) => DeliveryMode::Mailbox,
    }
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

// ---------------------------------------------------------------------------
// OPAQUE — strona klienta
//
// Ten sam kod, którego używa serwer (przez WebAssembly) i przeglądarka.
// Zgodność wynika z konstrukcji: dwie niezależne implementacje tego samego
// protokołu nie są zgodne na poziomie bajtów tylko dlatego, że obie
// „robią OPAQUE". Uzasadnienie w `opaque/src/lib.rs`.
// ---------------------------------------------------------------------------

impl From<mekamb_opaque::Error> for MekambError {
    fn from(error: mekamb_opaque::Error) -> Self {
        use mekamb_opaque::Error as E;
        match error {
            // Nieudane uwierzytelnienie ma jeden wariant — rozróżnianie
            // „złe hasło" od „nie ma konta" pozwalałoby sprawdzać, które
            // nazwy są zajęte.
            E::AuthenticationFailed => Self::MessageRejected,
            // Token doręczeniowy: dane z sieci albo dowód, który się nie
            // zgadza. Jedno i drugie jest wejściem do odrzucenia, nie awarią
            // kryptografii po naszej stronie.
            E::InvalidServerKey | E::MalformedMessage | E::Token(_) => Self::InvalidInput {
                powod: error.to_string(),
            },
            E::Protocol => Self::Crypto {
                powod: error.to_string(),
            },
        }
    }
}

/// Pierwsza runda: żądanie do wysłania i stan do zachowania.
#[derive(Debug, Clone, uniffi::Record)]
pub struct OpaqueStart {
    pub request: Vec<u8>,
    /// **Sekret.** Zostaje w pamięci klienta między rundami.
    pub state: Vec<u8>,
}

/// Wynik drugiej rundy rejestracji.
#[derive(Debug, Clone, uniffi::Record)]
pub struct OpaqueRegisterFinish {
    /// Do wysłania na serwer jako rekord konta.
    pub upload: Vec<u8>,
    /// Klucz wyprowadzony z hasła, **nieznany serwerowi**.
    pub export_key: Vec<u8>,
}

/// Wynik drugiej rundy logowania.
#[derive(Debug, Clone, uniffi::Record)]
pub struct OpaqueLoginFinish {
    /// Dowód do odesłania serwerowi.
    pub finalization: Vec<u8>,
    pub session_key: Vec<u8>,
    pub export_key: Vec<u8>,
}

/// Rejestracja, runda 1. Hasło nie opuszcza tego urządzenia.
#[uniffi::export]
pub fn opaque_register_start(password: String) -> Result<OpaqueStart, MekambError> {
    let w = mekamb_opaque::client_registration_start(&password)?;
    Ok(OpaqueStart {
        request: w.request,
        state: w.state,
    })
}

/// Rejestracja, runda 2.
#[uniffi::export]
pub fn opaque_register_finish(
    state: Vec<u8>,
    password: String,
    username: String,
    response: Vec<u8>,
) -> Result<OpaqueRegisterFinish, MekambError> {
    let w = mekamb_opaque::client_registration_finish(&state, &password, &username, &response)?;
    Ok(OpaqueRegisterFinish {
        upload: w.upload,
        export_key: w.export_key,
    })
}

/// Logowanie, runda 1.
#[uniffi::export]
pub fn opaque_login_start(password: String) -> Result<OpaqueStart, MekambError> {
    let w = mekamb_opaque::client_login_start(&password)?;
    Ok(OpaqueStart {
        request: w.request,
        state: w.state,
    })
}

/// Logowanie, runda 2.
///
/// **Złe hasło wykrywa tutaj klient**, a nie serwer — serwer nie ma czego
/// porównywać, więc nie ma stamtąd czego wyciec.
#[uniffi::export]
pub fn opaque_login_finish(
    state: Vec<u8>,
    password: String,
    username: String,
    response: Vec<u8>,
) -> Result<OpaqueLoginFinish, MekambError> {
    let w = mekamb_opaque::client_login_finish(&state, &password, &username, &response)?;
    Ok(OpaqueLoginFinish {
        finalization: w.finalization,
        session_key: w.session_key,
        export_key: w.export_key,
    })
}

// --- Tokeny doręczeniowe (strona klienta) ------------------------------------
//
// Serwerowa połowa jest w `opaque/bindings/wasm`, bo Worker ładuje tamten moduł.
// Uzasadnienie całego schematu: `opaque/src/tokeny.rs`.

/// Oślepiona prośba o token wraz z tym, co trzeba zachować do odsłonięcia.
#[derive(Debug, Clone, uniffi::Record)]
pub struct OslepionyToken {
    /// Pokazywane dopiero przy nadaniu.
    pub ziarno: Vec<u8>,
    /// **Nie opuszcza urządzenia.**
    pub oslepiacz: Vec<u8>,
    /// Do wysłania serwerowi.
    pub oslepione: Vec<u8>,
}

/// Gotowy token doręczeniowy.
#[derive(Debug, Clone, uniffi::Record)]
pub struct TokenDoreczeniowy {
    pub ziarno: Vec<u8>,
    pub odslonione: Vec<u8>,
}

/// Przygotowuje jedną prośbę o token.
#[uniffi::export]
pub fn token_oslep() -> OslepionyToken {
    let proba = mekamb_opaque::tokeny::oslep();

    OslepionyToken {
        ziarno: proba.ziarno.to_vec(),
        oslepiacz: proba.oslepiacz.to_vec(),
        oslepione: proba.oslepione.to_vec(),
    }
}

/// Odsłania ocenę serwera, sprawdzając wcześniej jego dowód.
///
/// Sprawdzenie dowodu jest **w środku**, nie osobnym krokiem: klient, który by
/// je pominął, płaciłby własną anonimowością — złośliwy serwer wydawałby każdemu
/// tokeny innym kluczem i rozpoznawał przy nadaniu, czyj był.
#[uniffi::export]
pub fn token_odslon(
    proba: OslepionyToken,
    ocenione: Vec<u8>,
    wyzwanie: Vec<u8>,
    odpowiedz: Vec<u8>,
    klucz_publiczny: Vec<u8>,
) -> Result<TokenDoreczeniowy, MekambError> {
    fn na_32(bajty: &[u8], co: &str) -> Result<[u8; 32], MekambError> {
        bajty.try_into().map_err(|_| MekambError::InvalidInput {
            powod: format!("{co} musi mieć 32 bajty"),
        })
    }

    let proba = mekamb_opaque::tokeny::Proba {
        ziarno: na_32(&proba.ziarno, "ziarno tokenu")?,
        oslepiacz: na_32(&proba.oslepiacz, "czynnik oślepiający")?,
        oslepione: na_32(&proba.oslepione, "oślepiona wartość")?,
    };

    let ocena = mekamb_opaque::tokeny::Ocena {
        ocenione: na_32(&ocenione, "ocena")?,
        wyzwanie: na_32(&wyzwanie, "wyzwanie")?,
        odpowiedz: na_32(&odpowiedz, "odpowiedź")?,
    };

    let token = mekamb_opaque::tokeny::odslon(&proba, &ocena, &klucz_publiczny).map_err(|e| {
        MekambError::InvalidInput {
            powod: e.to_string(),
        }
    })?;

    Ok(TokenDoreczeniowy {
        ziarno: token.ziarno.to_vec(),
        odslonione: token.odslonione.to_vec(),
    })
}

// ---------------------------------------------------------------------------
// Transfer optyczny
// ---------------------------------------------------------------------------

/// Jak poszło przyjęcie ramki.
#[derive(Debug, Clone, Copy, PartialEq, Eq, uniffi::Enum)]
pub enum PostepOptyczny {
    /// Przyjęta; brakuje jeszcze bloków.
    Trwa,
    /// Komplet — można wołać `zloz`.
    Gotowe,
    /// Ramka z **innego** transferu: aparat patrzy na inny ekran.
    Obca,
    /// Nieczytelna albo w nieznanej wersji formatu.
    Niepoprawna,
}

/// Nadajnik animowanego kodu QR.
///
/// Jedna implementacja dla obu klientów — format ramki, kody fountain i sam
/// generator QR siedzą w [`mekamb_core::optyka`]. Druga implementacja po
/// drugiej stronie rozjechałaby się z pierwszą, a objawem byłby transfer,
/// który nigdy się nie kończy: ramki widać, tylko nie składają się w całość.
#[derive(uniffi::Object)]
pub struct NadajnikOptyczny {
    wnetrze: std::sync::Mutex<mekamb_core::optyka::NadajnikOptyczny>,
}

#[uniffi::export]
impl NadajnikOptyczny {
    /// `dane` idą przez kompresję i AES-GCM, potem w bloki.
    #[uniffi::constructor]
    pub fn new(dane: Vec<u8>, klucz: Vec<u8>) -> Result<Self, MekambError> {
        let klucz: [u8; 32] = klucz.try_into().map_err(|_| MekambError::InvalidInput {
            powod: "klucz transferu musi mieć 32 bajty".into(),
        })?;

        // Rozmiar bloku dobrany pod największy kod QR przy korekcji L —
        // wołający nie ma jak tego policzyć, bo zna tylko wynik.
        let rozmiar = mekamb_core::qr::maks_bajtow(mekamb_core::qr::Korekcja::L)
            - mekamb_core::optyka::NAGLOWEK;

        Ok(NadajnikOptyczny {
            wnetrze: std::sync::Mutex::new(mekamb_core::optyka::NadajnikOptyczny::nowy(
                &dane, &klucz, rozmiar,
            )?),
        })
    }

    /// Ile bloków ma transfer — tyle klatek wystarczy przy czystym ujęciu.
    pub fn ile_blokow(&self) -> u32 {
        self.wnetrze.lock().expect("zatruty zamek").ile_blokow()
    }

    /// Kolejna klatka, gotowa do narysowania. Strumień jest nieskończony.
    pub fn nastepna_klatka(&self) -> Result<KodQr, MekambError> {
        let ramka = self.wnetrze.lock().expect("zatruty zamek").nastepna_ramka();

        let macierz = mekamb_core::qr::qr_matrix_bajty(&ramka, mekamb_core::qr::Korekcja::L)?;

        Ok(KodQr {
            bok: macierz.len() as u32,
            moduly: macierz.into_iter().flatten().collect(),
        })
    }
}

/// Odbiornik animowanego kodu QR.
#[derive(uniffi::Object, Default)]
pub struct OdbiornikOptyczny {
    wnetrze: std::sync::Mutex<mekamb_core::optyka::OdbiornikOptyczny>,
}

#[uniffi::export]
impl OdbiornikOptyczny {
    /// Bez klucza: zbieranie ramek go nie potrzebuje.
    ///
    /// Przy parowaniu klucz uzgadnia się z materiałem przychodzącym tą samą
    /// kamerą, więc odbiornik musi umieć zacząć zbierać, zanim go pozna.
    #[uniffi::constructor]
    pub fn new() -> Self {
        OdbiornikOptyczny {
            wnetrze: std::sync::Mutex::new(mekamb_core::optyka::OdbiornikOptyczny::nowy()),
        }
    }

    /// Przyjmuje ramkę odczytaną z kamery.
    pub fn dodaj_ramke(&self, ramka: Vec<u8>) -> PostepOptyczny {
        use mekamb_core::optyka::Postep;

        match self
            .wnetrze
            .lock()
            .expect("zatruty zamek")
            .dodaj_ramke(&ramka)
        {
            Postep::Trwa { .. } => PostepOptyczny::Trwa,
            Postep::Gotowe => PostepOptyczny::Gotowe,
            Postep::Obca => PostepOptyczny::Obca,
            Postep::Niepoprawna => PostepOptyczny::Niepoprawna,
        }
    }

    /// Ile bloków już odzyskano.
    pub fn odzyskane(&self) -> u32 {
        self.wnetrze.lock().expect("zatruty zamek").odzyskane()
    }

    /// Ile bloków ma transfer; zero, dopóki nie przyszła żadna ramka.
    pub fn wszystkich(&self) -> u32 {
        self.wnetrze
            .lock()
            .expect("zatruty zamek")
            .wszystkich()
            .unwrap_or(0)
    }

    /// Składa całość. Błąd, dopóki brakuje choć jednego bloku.
    pub fn zloz(&self, klucz: Vec<u8>) -> Result<Vec<u8>, MekambError> {
        let klucz: [u8; 32] = klucz.try_into().map_err(|_| MekambError::InvalidInput {
            powod: "klucz transferu musi mieć 32 bajty".into(),
        })?;

        Ok(self
            .wnetrze
            .lock()
            .expect("zatruty zamek")
            .odbierz(&klucz)?)
    }
}

/// Efemeryczna para kluczy do sparowania drugiego urządzenia.
///
/// Klucz publiczny jedzie w kodzie QR pokazanym przez **nowe** urządzenie.
/// Kierunek nie jest dowolny: filmujący ekran starego urządzenia — tego, które
/// nadaje historię — nie widział tamtego kodu, więc nie zna sekretu.
#[derive(uniffi::Object)]
pub struct ParaParowania {
    wnetrze: mekamb_core::parowanie::ParaParowania,
}

#[uniffi::export]
impl ParaParowania {
    #[uniffi::constructor]
    pub fn new() -> Result<Self, MekambError> {
        Ok(ParaParowania {
            wnetrze: mekamb_core::parowanie::ParaParowania::nowa()?,
        })
    }

    /// Klucz publiczny — to on trafia do kodu QR.
    pub fn publiczny(&self) -> Vec<u8> {
        self.wnetrze.publiczny().to_vec()
    }

    /// Uzgadnia klucz transferu z kluczem publicznym drugiej strony.
    pub fn klucz_transferu(&self, obcy_publiczny: Vec<u8>) -> Result<Vec<u8>, MekambError> {
        Ok(self.wnetrze.klucz_transferu(&obcy_publiczny)?.to_vec())
    }
}
