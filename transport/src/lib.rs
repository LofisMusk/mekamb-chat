//! Transport P2P komunikatora mekamb-chat.
//!
//! # Dlaczego własna implementacja
//!
//! Pierwotnie tę warstwę zapewniał iroh. Działał i jest otwartoźródłowy —
//! problem leżał gdzie indziej: iroh ciągnie `reqwest`, ten
//! `rustls-platform-verifier`, a ten **przerywa proces na Androidzie**, jeśli
//! nie zainicjalizuje się go przez JNI. Nie dało się tego wyłączyć flagą,
//! bo zależność jest twarda.
//!
//! Nasze potrzeby są przy tym wąskie: wysłać kopertę do urządzenia o znanym
//! kluczu publicznym. Nie potrzebujemy strumieni, multipleksowania, relayów po
//! HTTP, odkrywania przez DNS ani metryk.
//!
//! # Z czego się składa
//!
//! | Warstwa | Rozwiązanie |
//! |---|---|
//! | Gniazdo | zwykły UDP |
//! | Poznanie własnego adresu | STUN (RFC 5389), własna implementacja żądania |
//! | Zestawienie połączenia | jednoczesne pakiety, klasyczne przebijanie NAT |
//! | Szyfrowanie i uwierzytelnienie | Noise IK przez `snow` |
//! | Odbiorca nieosiągalny | skrzynka na serwerze |
//!
//! **Kryptografii nie piszemy.** Noise jest wyspecyfikowany i przeanalizowany
//! formalnie, a `snow` jest jego niezależną implementacją w czystym Rust.
//! Nasza rola sprowadza się do wyboru wzorca i podłączenia kluczy.
//!
//! # Tożsamość transportowa to nie tożsamość autora
//!
//! Klucz transportowy jest wyprowadzany z osobnej etykiety HKDF niż credential
//! MLS. Wiedza „ten pakiet przyszedł od klucza X" **nie** jest dowodem, kto
//! napisał wiadomość — o autorstwie rozstrzyga wyłącznie zweryfikowany
//! credential MLS po odszyfrowaniu.
//!
//! # Czego ta warstwa NIE robi
//!
//! **Nie ma przekaźnika.** Przy symetrycznym NAT po obu stronach przebicie się
//! nie uda i wtedy wchodzi skrzynka. To świadomy wybór: własny relay wymagałby
//! serwera z UDP, a cała architektura stoi na Cloudflare Workers, które UDP
//! nie obsługują. Skrzynka przenosi wyłącznie szyfrogram, więc bezpieczeństwo
//! na tym nie traci — traci bezpośredniość.
//!
//! **Nie ukrywa adresu IP przed rozmówcą.** Połączenie bezpośrednie z definicji
//! go ujawnia. Interfejs musi pokazywać, którą drogą idzie ruch.

use std::collections::HashMap;
use std::net::SocketAddr;
use std::sync::Arc;
use std::time::Duration;

use mekamb_core::envelope::MAX_ENVELOPE_BYTES;
use mekamb_core::identity::DeviceIdentity;
use tokio::net::UdpSocket;
use tokio::sync::Mutex;

pub mod error;
pub mod session;
pub mod stun;

pub use error::{Error, Result};
pub use mekamb_core::envelope::{Envelope, EnvelopeKind};
pub use session::{MAX_PAYLOAD, StaticKeypair};

/// Domyślne serwery STUN.
///
/// Dwa różne podmioty, żeby awaria jednego nie odcinała możliwości poznania
/// własnego adresu. Serwer STUN **nie musi być zaufany**: gdyby skłamał
/// o naszym adresie, połączenie bezpośrednie po prostu by się nie zestawiło
/// i zadziałałby fallback na skrzynkę.
pub const DEFAULT_STUN_SERVERS: [&str; 2] = ["stun.cloudflare.com:3478", "stun.l.google.com:19302"];

/// Jak długo próbujemy przebić NAT, zanim uznamy odbiorcę za nieosiągalnego.
const PUNCH_TIMEOUT: Duration = Duration::from_secs(5);

/// Odstęp między kolejnymi pakietami przebijającymi.
const PUNCH_INTERVAL: Duration = Duration::from_millis(250);

/// Największy pakiet, jaki przyjmujemy z sieci.
const MAX_DATAGRAM: usize = 65535;

/// Jak dostarczono wiadomość.
#[derive(Debug, Clone, Copy, PartialEq, Eq)]
pub enum Delivery {
    /// Prosto do urządzenia odbiorcy, z pominięciem infrastruktury.
    Direct,
    /// Odbiorca nieosiągalny — szyfrogram czeka w skrzynce.
    Mailbox,
}

/// Adres urządzenia w sieci, publikowany w katalogu.
///
/// Serwer **nie jest** zaufanym źródłem tych danych: gdyby podał obcy klucz,
/// handshake Noise by nie przeszedł.
#[derive(Debug, Clone, PartialEq, Eq)]
pub struct PeerAddr {
    /// Statyczny klucz publiczny urządzenia (X25519, 32 bajty).
    pub public_key: Vec<u8>,
    /// Adresy, pod którymi urządzenie może być osiągalne — lokalny i publiczny.
    pub addresses: Vec<SocketAddr>,
}

/// Odebrana koperta wraz z uwierzytelnionym kluczem nadawcy.
#[derive(Debug, Clone)]
pub struct Received {
    pub envelope: Envelope,
    /// Klucz publiczny nadawcy, potwierdzony przez handshake Noise.
    pub sender_key: Vec<u8>,
}

/// Skrzynka na wiadomości dla nieosiągalnych odbiorców.
pub trait Mailbox {
    fn deposit(
        &self,
        recipient: &str,
        envelope: &Envelope,
    ) -> impl std::future::Future<Output = Result<()>> + Send;
}

/// Węzeł P2P urządzenia.
pub struct Transport {
    socket: Arc<UdpSocket>,
    keypair: Arc<StaticKeypair>,
    /// Sesje po adresie rozmówcy — jeden adres to jedna sesja.
    sessions: Arc<Mutex<HashMap<SocketAddr, session::Session>>>,
    local_addrs: Vec<SocketAddr>,
}

impl Transport {
    /// Uruchamia węzeł na kluczu wyprowadzonym z tożsamości urządzenia.
    pub async fn bind(identity: &DeviceIdentity) -> Result<Self> {
        Self::bind_with_secret(identity.seed().iroh_secret_bytes()).await
    }

    /// Uruchamia węzeł bez odpytywania STUN.
    ///
    /// Przydatne w testach i w sieci lokalnej: pomija ruch na zewnątrz, więc
    /// nie zależy od dostępności czegokolwiek poza maszyną.
    pub async fn bind_local(secret: &[u8; 32]) -> Result<Self> {
        let socket = UdpSocket::bind("127.0.0.1:0")
            .await
            .map_err(|e| Error::Transport(format!("nie udało się otworzyć gniazda: {e}")))?;

        let local_addrs = socket.local_addr().map(|a| vec![a]).unwrap_or_default();

        Ok(Self {
            socket: Arc::new(socket),
            keypair: Arc::new(StaticKeypair::from_secret(secret)?),
            sessions: Arc::new(Mutex::new(HashMap::new())),
            local_addrs,
        })
    }

    /// Uruchamia węzeł na podanym sekrecie.
    ///
    /// Odpytuje serwery STUN, żeby poznać własny adres publiczny. Niepowodzenie
    /// **nie jest błędem**: bez adresu publicznego działa jeszcze połączenie
    /// w obrębie sieci lokalnej, a poza nią zadziała skrzynka.
    pub async fn bind_with_secret(secret: [u8; 32]) -> Result<Self> {
        let socket = UdpSocket::bind("0.0.0.0:0")
            .await
            .map_err(|e| Error::Transport(format!("nie udało się otworzyć gniazda: {e}")))?;

        let keypair = StaticKeypair::from_secret(&secret)?;

        let port = socket
            .local_addr()
            .map(|a| a.port())
            .map_err(|e| Error::Transport(format!("gniazdo bez adresu: {e}")))?;

        let mut local_addrs = Vec::new();

        // Adres w sieci lokalnej. Bez niego dwa urządzenia w tej samej sieci
        // wifi nie miałyby jak się znaleźć: adres nasłuchu (0.0.0.0) jest dla
        // rozmówcy bezużyteczny, a próba dojścia do siebie przez adres
        // publiczny wymaga od routera zawracania pakietów, czego wiele
        // routerów nie robi.
        if let Some(lan) = adres_w_sieci_lokalnej() {
            local_addrs.push(SocketAddr::new(lan, port));
        }

        for serwer in DEFAULT_STUN_SERVERS {
            let Ok(adres_serwera) = stun::resolve(serwer).await else {
                continue;
            };

            if let Ok(publiczny) = stun::discover_public_address(&socket, adres_serwera).await {
                if !local_addrs.contains(&publiczny) {
                    local_addrs.push(publiczny);
                }
                // Jeden działający serwer wystarcza.
                break;
            }
        }

        Ok(Self {
            socket: Arc::new(socket),
            keypair: Arc::new(keypair),
            sessions: Arc::new(Mutex::new(HashMap::new())),
            local_addrs,
        })
    }

    /// Klucz publiczny tego urządzenia — publikowany w katalogu.
    #[allow(clippy::missing_const_for_fn)]
    pub fn public_key(&self) -> &[u8] {
        self.keypair.public()
    }

    /// Adresy, pod którymi urządzenie jest osiągalne.
    pub fn addresses(&self) -> &[SocketAddr] {
        &self.local_addrs
    }

    /// Wysyła kopertę wprost do rozmówcy.
    ///
    /// Próbuje kolejnych adresów, aż któryś odpowie. Błąd **nie jest awarią** —
    /// to sygnał dla wywołującego, żeby skorzystał ze skrzynki.
    pub async fn send_direct(&self, peer: &PeerAddr, envelope: &Envelope) -> Result<()> {
        let bajty = envelope.encode_to_vec();

        if bajty.len() > MAX_PAYLOAD {
            return Err(Error::Transport(format!(
                "koperta ma {} bajtów, limit to {MAX_PAYLOAD}",
                bajty.len()
            )));
        }

        for adres in &peer.addresses {
            if self.wyslij_pod_adres(*adres, &peer.public_key, &bajty).await.is_ok() {
                return Ok(());
            }
        }

        Err(Error::PeerUnreachable)
    }

    /// Dostarcza kopertę: najpierw bezpośrednio, w razie niepowodzenia do skrzynki.
    ///
    /// Nieosiągalny odbiorca **nie jest błędem** — ma pełne prawo być offline.
    pub async fn deliver<M: Mailbox>(
        &self,
        peer: Option<&PeerAddr>,
        recipient: &str,
        envelope: &Envelope,
        mailbox: &M,
    ) -> Result<Delivery> {
        if let Some(peer) = peer {
            if self.send_direct(peer, envelope).await.is_ok() {
                return Ok(Delivery::Direct);
            }
        }

        mailbox.deposit(recipient, envelope).await?;
        Ok(Delivery::Mailbox)
    }

    /// Zestawia sesję i wysyła ładunek pod konkretny adres.
    async fn wyslij_pod_adres(
        &self,
        adres: SocketAddr,
        klucz_rozmowcy: &[u8],
        ladunek: &[u8],
    ) -> Result<()> {
        // Istniejąca sesja oszczędza handshake'u.
        {
            let mut sesje = self.sessions.lock().await;
            if let Some(sesja) = sesje.get_mut(&adres) {
                if sesja.is_ready() {
                    let szyfrogram = sesja.seal(ladunek)?;
                    self.wyslij_datagram(adres, &szyfrogram).await?;
                    return Ok(());
                }
            }
        }

        let (mut sesja, pierwsza) = session::Session::initiate(&self.keypair, klucz_rozmowcy)?;

        // Przebijanie NAT: powtarzamy pierwszą wiadomość handshake'u, aż
        // przyjdzie odpowiedź. Każdy wysłany pakiet otwiera w naszym NAT-cie
        // przejście dla odpowiedzi z tego adresu — bez tego pakiety rozmówcy
        // byłyby odrzucane, zanim do nas dotrą.
        let odpowiedz = self.przebij(adres, &pierwsza).await?;

        if sesja.read_handshake(&odpowiedz)?.is_some() {
            return Err(Error::Transport("nieoczekiwany przebieg handshake'u".into()));
        }

        // Noise potwierdza, że rozmówca zna odpowiedni klucz prywatny — ale to
        // my musimy sprawdzić, czy to TEN klucz, którego oczekiwaliśmy.
        if sesja.peer_public().as_deref() != Some(klucz_rozmowcy) {
            return Err(Error::Transport("rozmówca ma inny klucz niż w katalogu".into()));
        }

        let szyfrogram = sesja.seal(ladunek)?;
        self.wyslij_datagram(adres, &szyfrogram).await?;

        self.sessions.lock().await.insert(adres, sesja);
        Ok(())
    }

    /// Powtarza pakiet, aż przyjdzie odpowiedź albo skończy się czas.
    async fn przebij(&self, adres: SocketAddr, pakiet: &[u8]) -> Result<Vec<u8>> {
        let deadline = tokio::time::Instant::now() + PUNCH_TIMEOUT;

        loop {
            self.wyslij_datagram(adres, pakiet).await?;

            let mut bufor = vec![0u8; MAX_DATAGRAM];

            match tokio::time::timeout(PUNCH_INTERVAL, self.socket.recv_from(&mut bufor)).await {
                Ok(Ok((ile, from))) if from == adres => {
                    bufor.truncate(ile);
                    return Ok(bufor);
                }

                // Pakiet od kogoś innego albo cisza — próbujemy dalej.
                _ => {
                    if tokio::time::Instant::now() >= deadline {
                        return Err(Error::PeerUnreachable);
                    }
                }
            }
        }
    }

    async fn wyslij_datagram(&self, adres: SocketAddr, dane: &[u8]) -> Result<()> {
        self.socket
            .send_to(dane, adres)
            .await
            .map(|_| ())
            .map_err(|e| Error::Transport(format!("nie udało się wysłać datagramu: {e}")))
    }

    /// Odbiera jedną kopertę. Blokuje do nadejścia.
    ///
    /// Pakiety, których nie da się przetworzyć, są **pomijane bez przerywania
    /// pętli** — spreparowany datagram z sieci to sytuacja spodziewana, a nie
    /// powód do zamykania transportu.
    pub async fn accept_next(&self) -> Option<Result<Received>> {
        loop {
            let mut bufor = vec![0u8; MAX_DATAGRAM];

            let (ile, from) = match self.socket.recv_from(&mut bufor).await {
                Ok(wynik) => wynik,
                Err(_) => return None,
            };
            bufor.truncate(ile);

            match self.przetworz(from, &bufor).await {
                Ok(Some(odebrane)) => return Some(Ok(odebrane)),
                // Handshake w toku albo pakiet do odrzucenia — czekamy dalej.
                Ok(None) | Err(_) => continue,
            }
        }
    }

    async fn przetworz(&self, from: SocketAddr, dane: &[u8]) -> Result<Option<Received>> {
        let mut sesje = self.sessions.lock().await;

        // Sesja gotowa — to powinna być zaszyfrowana koperta.
        if let Some(sesja) = sesje.get_mut(&from) {
            if sesja.is_ready() {
                let jawne = sesja.open(dane)?;
                let sender_key = sesja.peer_public().unwrap_or_default();

                if jawne.len() > MAX_ENVELOPE_BYTES {
                    return Err(Error::Transport("koperta przekracza limit rozmiaru".into()));
                }

                return Ok(Some(Received {
                    envelope: Envelope::decode(&jawne)?,
                    sender_key,
                }));
            }
        }

        // Nowy rozmówca albo handshake w toku.
        let sesja = sesje
            .entry(from)
            .or_insert(session::Session::respond(&self.keypair)?);

        if let Some(odpowiedz) = sesja.read_handshake(dane)? {
            self.wyslij_datagram(from, &odpowiedz).await?;
        }

        Ok(None)
    }

    /// Zamyka węzeł.
    pub async fn close(&self) {
        self.sessions.lock().await.clear();
    }
}

/// Ustala adres tego urządzenia w sieci lokalnej.
///
/// Sztuczka jest standardowa: „łączymy" gniazdo UDP z adresem w internecie
/// i pytamy o jego adres lokalny. UDP jest bezpołączeniowe, więc **żaden pakiet
/// nie zostaje wysłany** — system tylko wybiera interfejs, którym poszedłby
/// ruch, i to ujawnia właściwy adres.
///
/// Alternatywą byłoby wyliczanie interfejsów, co wymaga wywołań systemowych
/// innych na każdej platformie albo dodatkowej zależności.
fn adres_w_sieci_lokalnej() -> Option<std::net::IpAddr> {
    let sonda = std::net::UdpSocket::bind("0.0.0.0:0").ok()?;

    // Adres z zakresu dokumentacyjnego (RFC 5737) — nie istnieje, ale wystarcza
    // do wskazania trasy wyjściowej.
    sonda.connect("192.0.2.1:9").ok()?;

    let adres = sonda.local_addr().ok()?.ip();
    (!adres.is_unspecified() && !adres.is_loopback()).then_some(adres)
}
