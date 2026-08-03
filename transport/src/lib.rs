//! Transport P2P komunikatora **mekamb-chat**.
//!
//! # Zasada: najpierw bezpośrednio, skrzynka dopiero gdy trzeba
//!
//! Wiadomość idzie wprost między urządzeniami przez QUIC (iroh). Serwer wchodzi
//! do gry tylko wtedy, gdy odbiorcy nie da się osiągnąć — wtedy szyfrogram
//! trafia do jego skrzynki i czeka. Dzięki temu w typowym przypadku
//! infrastruktura w ogóle nie widzi ruchu.
//!
//! Decyzja „bezpośrednio czy do skrzynki" jest podejmowana **tutaj**, a nie
//! w kodzie klienta. Android i przeglądarka wołają [`Transport::deliver`]
//! i nie muszą wiedzieć, którą drogą poszła wiadomość.
//!
//! # Tożsamość transportowa to nie tożsamość autora
//!
//! `EndpointId` w iroh jest wyprowadzany z osobnego klucza niż credential MLS
//! (patrz `mekamb_core::identity`). Wiedza „ten pakiet przyszedł od węzła X"
//! **nie** jest dowodem, kto napisał wiadomość — o autorstwie rozstrzyga
//! wyłącznie zweryfikowany credential MLS po odszyfrowaniu.
//!
//! # Przeglądarka
//!
//! Ten sam kod działa w przeglądarce po kompilacji do WASM, ale wyłącznie
//! w trybie relay: sandbox nie pozwala wysyłać pakietów UDP, więc przebijanie
//! NAT jest niedostępne. Szyfrowanie pozostaje niezmienione.

use iroh::{
    Endpoint, EndpointAddr, EndpointId, RelayMode, SecretKey,
    endpoint::{Connection, presets},
};
use mekamb_core::{Error, Result, identity::DeviceIdentity};

// Koperta mieszka w rdzeniu, żeby bindingi WASM mogły jej użyć bez wciągania
// całego stosu QUIC. Transport re-eksportuje ją dla wygody wywołujących.
pub use mekamb_core::envelope::{Envelope, EnvelopeKind, MAX_ENVELOPE_BYTES};

/// Identyfikator protokołu negocjowany w handshake QUIC.
///
/// Wersjonowany: gdy format koperty przestanie być zgodny wstecz, zmiana ALPN
/// sprawi, że stare i nowe klienty po prostu się nie połączą — zamiast połączyć
/// się i nie zrozumieć.
pub const ALPN: &[u8] = b"mekamb-chat/1";

/// Bajt potwierdzenia odbioru.
///
/// Bez potwierdzenia nadawca nie odróżniłby „dostarczono" od „strumień się
/// urwał", a przy takiej wątpliwości musiałby dublować wiadomość do skrzynki.
const ACK: u8 = 0x01;

/// Polityka sieciowa punktu końcowego.
#[derive(Clone, Copy, Debug, PartialEq, Eq)]
pub enum RelayPolicy {
    /// Publiczne relaye n0 plus wyszukiwanie adresów. Ustawienie produkcyjne.
    Public,
    /// Bez relayów i bez wyszukiwania — wyłącznie połączenia bezpośrednie
    /// po adresach znanych z katalogu.
    Disabled,
    /// Bez relayów, gniazdo wyłącznie na pętli zwrotnej.
    ///
    /// Do testów i CI. Nie chodzi tylko o hermetyczność: nowsze wersje macOS
    /// wymagają zgody „Local Network" na ruch do adresów LAN, której binarka
    /// testowa nie dostaje. Bez wymuszenia loopbacku testy P2P wieszają się na
    /// timeoucie na maszynie deweloperskiej, choć kod jest poprawny.
    #[cfg(not(target_arch = "wasm32"))]
    LoopbackOnly,
}

/// Jak faktycznie została dostarczona wiadomość.
///
/// Zwracane do warstwy wyżej, żeby interfejs mógł pokazać tryb połączenia —
/// użytkownik ma prawo wiedzieć, czy ruch omija infrastrukturę.
#[derive(Clone, Copy, Debug, PartialEq, Eq)]
pub enum Delivery {
    /// Prosto do urządzenia odbiorcy.
    Direct,
    /// Odbiorca nieosiągalny — szyfrogram czeka w skrzynce.
    Mailbox,
}

/// Skrzynka serwerowa dla odbiorców offline.
///
/// Trait, a nie konkretna implementacja, bo rdzeń transportu nie wykonuje żądań
/// HTTP — robi to warstwa platformowa (Android albo przeglądarka), która ma
/// token dostępowy i zna adres Workera.
pub trait Mailbox {
    /// Zostawia szyfrogram dla odbiorcy.
    fn deposit(&self, recipient_user_id: &str, envelope: &[u8])
    -> impl Future<Output = Result<()>>;
}

/// Wiadomość odebrana z sieci wraz z węzłem, który ją przysłał.
#[derive(Debug)]
pub struct Received {
    /// Węzeł transportowy nadawcy. **Nie** jest dowodem autorstwa.
    pub from: EndpointId,
    pub envelope: Envelope,
}

/// Punkt końcowy sieci P2P tego urządzenia.
pub struct Transport {
    endpoint: Endpoint,
}

impl Transport {
    /// Uruchamia transport na kluczu wyprowadzonym z tożsamości urządzenia.
    ///
    /// Klucz węzła pochodzi z ziarna przez HKDF z etykietą `iroh-node` i jest
    /// **rozłączny** z kluczem podpisu MLS.
    pub async fn bind(identity: &DeviceIdentity, relay: RelayPolicy) -> Result<Self> {
        Self::bind_with_secret(identity.seed().iroh_secret_bytes(), relay).await
    }

    /// Wariant przyjmujący surowe bajty klucza — do testów i narzędzi.
    pub async fn bind_with_secret(secret: [u8; 32], relay: RelayPolicy) -> Result<Self> {
        let secret_key = SecretKey::from_bytes(&secret);

        let builder = match relay {
            RelayPolicy::Public => Endpoint::builder(presets::N0),
            RelayPolicy::Disabled => {
                Endpoint::builder(presets::Minimal).relay_mode(RelayMode::Disabled)
            }
            #[cfg(not(target_arch = "wasm32"))]
            RelayPolicy::LoopbackOnly => Endpoint::builder(presets::Minimal)
                .relay_mode(RelayMode::Disabled)
                .bind_addr("127.0.0.1:0")
                .map_err(|e| Error::Storage(format!("nieprawidłowy adres pętli zwrotnej: {e}")))?,
        };

        let endpoint = builder
            .secret_key(secret_key)
            .alpns(vec![ALPN.to_vec()])
            .bind()
            .await
            .map_err(|e| Error::Storage(format!("nie udało się uruchomić transportu: {e}")))?;

        Ok(Self { endpoint })
    }

    /// Identyfikator tego węzła.
    pub fn endpoint_id(&self) -> EndpointId {
        self.endpoint.id()
    }

    /// Adres, pod którym inni mogą się z nami połączyć.
    ///
    /// Publikowany w katalogu na serwerze, podpisany kluczem tożsamości, żeby
    /// serwer nie mógł go niezauważenie podmienić.
    pub fn addr(&self) -> EndpointAddr {
        self.endpoint.addr()
    }

    /// Czeka, aż węzeł będzie osiągalny z zewnątrz.
    pub async fn wait_online(&self) {
        self.endpoint.online().await;
    }

    /// Próbuje dostarczyć kopertę bezpośrednio do wskazanego adresu.
    ///
    /// Zwraca `Ok` dopiero po potwierdzeniu odbioru przez drugą stronę.
    pub async fn send_direct(&self, peer: EndpointAddr, envelope: &Envelope) -> Result<()> {
        let bytes = envelope.encode_to_vec();
        if bytes.len() > MAX_ENVELOPE_BYTES {
            return Err(Error::Framing(format!(
                "koperta ma {} bajtów, limit to {MAX_ENVELOPE_BYTES}",
                bytes.len()
            )));
        }

        let connection: Connection = self
            .endpoint
            .connect(peer, ALPN)
            .await
            .map_err(|e| Error::Storage(format!("nie udało się połączyć z peerem: {e}")))?;

        let (mut send, mut recv) = connection
            .open_bi()
            .await
            .map_err(|e| Error::Storage(format!("nie udało się otworzyć strumienia: {e}")))?;

        send.write_all(&bytes)
            .await
            .map_err(|e| Error::Storage(format!("błąd wysyłki: {e}")))?;
        send.finish()
            .map_err(|e| Error::Storage(format!("błąd domknięcia strumienia: {e}")))?;

        let ack = recv
            .read_to_end(1)
            .await
            .map_err(|e| Error::Storage(format!("brak potwierdzenia odbioru: {e}")))?;

        connection.close(0u32.into(), b"ok");

        if ack.first() != Some(&ACK) {
            return Err(Error::Storage(
                "odbiorca nie potwierdził przyjęcia koperty".into(),
            ));
        }

        Ok(())
    }

    /// Dostarcza kopertę: najpierw bezpośrednio, w razie niepowodzenia do skrzynki.
    ///
    /// `peer` może być `None`, gdy katalog nie zna aktualnego adresu odbiorcy —
    /// wtedy od razu idziemy do skrzynki.
    ///
    /// Niepowodzenie połączenia bezpośredniego **nie jest błędem**: odbiorca ma
    /// pełne prawo być offline. Błąd zwracamy dopiero, gdy zawiodą obie drogi.
    pub async fn deliver<M: Mailbox>(
        &self,
        recipient_user_id: &str,
        peer: Option<EndpointAddr>,
        envelope: &Envelope,
        mailbox: &M,
    ) -> Result<Delivery> {
        if let Some(peer) = peer {
            match self.send_direct(peer, envelope).await {
                Ok(()) => return Ok(Delivery::Direct),
                Err(e) => {
                    tracing::debug!(
                        recipient = recipient_user_id,
                        blad = %e,
                        "dostarczenie bezpośrednie nieudane, przechodzę na skrzynkę"
                    );
                }
            }
        }

        mailbox
            .deposit(recipient_user_id, &envelope.encode_to_vec())
            .await?;

        Ok(Delivery::Mailbox)
    }

    /// Odbiera jedną kopertę z sieci.
    ///
    /// Zwraca `None`, gdy transport został zamknięty. Pętla odbioru należy do
    /// wywołującego — biblioteka nie zakłada konkretnego środowiska
    /// uruchomieniowego, bo musi działać i pod tokio, i w przeglądarce.
    pub async fn accept_next(&self) -> Option<Result<Received>> {
        let incoming = self.endpoint.accept().await?;
        Some(self.handle_incoming(incoming).await)
    }

    async fn handle_incoming(&self, incoming: iroh::endpoint::Incoming) -> Result<Received> {
        let connection = incoming
            .await
            .map_err(|e| Error::Storage(format!("połączenie przychodzące nieudane: {e}")))?;

        let from = connection.remote_id();

        let (mut send, mut recv) = connection
            .accept_bi()
            .await
            .map_err(|e| Error::Storage(format!("nie udało się przyjąć strumienia: {e}")))?;

        // Limit obowiązuje przy czytaniu, a nie po nim: bez tego nadawca mógłby
        // wyczerpać pamięć odbiorcy, zanim ktokolwiek sprawdzi rozmiar.
        let bytes = recv
            .read_to_end(MAX_ENVELOPE_BYTES)
            .await
            .map_err(|e| Error::Storage(format!("błąd odczytu koperty: {e}")))?;

        let envelope = Envelope::decode(&bytes)?;

        // Potwierdzamy dopiero po udanym sparsowaniu — nadawca ma się dowiedzieć,
        // że koperta została faktycznie przyjęta, a nie tylko odebrana.
        send.write_all(&[ACK])
            .await
            .map_err(|e| Error::Storage(format!("nie udało się potwierdzić odbioru: {e}")))?;
        send.finish()
            .map_err(|e| Error::Storage(format!("błąd domknięcia potwierdzenia: {e}")))?;

        connection.closed().await;

        Ok(Received { from, envelope })
    }

    /// Domyka transport, czekając na wysłanie zaległych pakietów.
    pub async fn close(&self) {
        self.endpoint.close().await;
    }
}
