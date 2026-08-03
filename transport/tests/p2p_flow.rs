//! Testy transportu: dwa węzły rozmawiają bezpośrednio, bez żadnego serwera.
//!
//! Wszystko działa na `RelayPolicy::LoopbackOnly`, więc testy nie wychodzą do sieci
//! zewnętrznej i nie zależą od dostępności publicznych relayów n0.

use std::sync::Mutex;
use std::time::Duration;

use mekamb_core::framing::ChatMessage;
use mekamb_core::group::{Conversation, Incoming, Provider};
use mekamb_core::identity::DeviceIdentity;
use mekamb_transport::{Delivery, Envelope, EnvelopeKind, Mailbox, RelayPolicy, Transport};

/// Limit czasu operacji sieciowych w testach.
///
/// Bez niego nieudane połączenie wiesza test zamiast go oblać.
const TIMEOUT: Duration = Duration::from_secs(20);

/// Skrzynka zapisująca doręczenia w pamięci — udaje Durable Object `UserInbox`.
#[derive(Default)]
struct SkrzynkaTestowa {
    zdeponowane: Mutex<Vec<(String, Vec<u8>)>>,
}

impl SkrzynkaTestowa {
    fn liczba_depozytow(&self) -> usize {
        self.zdeponowane.lock().unwrap().len()
    }
}

impl Mailbox for SkrzynkaTestowa {
    async fn deposit(&self, recipient_user_id: &str, envelope: &[u8]) -> mekamb_core::Result<()> {
        self.zdeponowane
            .lock()
            .unwrap()
            .push((recipient_user_id.to_string(), envelope.to_vec()));
        Ok(())
    }
}

/// Skrzynka, która zawsze zawodzi — do sprawdzenia, że błąd obu dróg propaguje.
struct SkrzynkaNiedostepna;

impl Mailbox for SkrzynkaNiedostepna {
    async fn deposit(&self, _: &str, _: &[u8]) -> mekamb_core::Result<()> {
        Err(mekamb_core::Error::Storage("skrzynka niedostępna".into()))
    }
}

#[tokio::test]
async fn dwa_wezly_wymieniaja_koperte_bezposrednio() {
    let nadawca = Transport::bind_with_secret([1u8; 32], RelayPolicy::LoopbackOnly)
        .await
        .unwrap();
    let odbiorca = Transport::bind_with_secret([2u8; 32], RelayPolicy::LoopbackOnly)
        .await
        .unwrap();

    let adres_odbiorcy = odbiorca.addr();

    let odbior = tokio::spawn(async move {
        let wynik = odbiorca.accept_next().await;
        odbiorca.close().await;
        wynik
    });

    let koperta = Envelope::new(
        b"grupa-testowa".to_vec(),
        EnvelopeKind::Application,
        b"ladunek mls".to_vec(),
    );

    tokio::time::timeout(TIMEOUT, nadawca.send_direct(adres_odbiorcy, &koperta))
        .await
        .expect("wysyłka przekroczyła limit czasu")
        .expect("wysyłka bezpośrednia nieudana");

    let odebrane = tokio::time::timeout(TIMEOUT, odbior)
        .await
        .expect("odbiór przekroczył limit czasu")
        .unwrap()
        .expect("transport zamknięty przed odebraniem")
        .expect("nie udało się przetworzyć koperty");

    assert_eq!(odebrane.envelope, koperta);
    assert_eq!(odebrane.from, nadawca.endpoint_id());

    nadawca.close().await;
}

/// Właściwy dowód fazy 2: pełny łańcuch MLS → iroh → MLS.
///
/// Alice szyfruje wiadomość przez MLS, wysyła ją bezpośrednio przez QUIC,
/// a Bob odszyfrowuje i widzi uwierzytelnionego nadawcę.
#[tokio::test]
async fn wiadomosc_mls_przechodzi_przez_siec_p2p() {
    let alice = DeviceIdentity::generate("alice", "telefon").unwrap();
    let bob = DeviceIdentity::generate("bob", "laptop").unwrap();
    let provider_alice = Provider::default();
    let provider_boba = Provider::default();

    // Ustalenie rozmowy — w produkcji ta część idzie przez GroupRelay.
    let key_package = Conversation::create_key_package(&provider_boba, &bob).unwrap();
    let mut rozmowa_alice = Conversation::create(&provider_alice, &alice).unwrap();
    let oczekujacy = rozmowa_alice
        .stage_add_member(&provider_alice, &alice, key_package.key_package())
        .unwrap();
    rozmowa_alice
        .confirm_pending_commit(&provider_alice)
        .unwrap();
    let mut rozmowa_boba =
        Conversation::join_from_welcome(&provider_boba, oczekujacy.welcome.as_ref().unwrap())
            .unwrap();

    // Od tego miejsca wszystko leci przez prawdziwą sieć.
    let transport_alice = Transport::bind(&alice, RelayPolicy::LoopbackOnly)
        .await
        .unwrap();
    let transport_boba = Transport::bind(&bob, RelayPolicy::LoopbackOnly)
        .await
        .unwrap();
    let adres_boba = transport_boba.addr();

    let odbior = tokio::spawn(async move {
        let wynik = transport_boba.accept_next().await;
        transport_boba.close().await;
        wynik
    });

    let szyfrogram = rozmowa_alice
        .send(
            &provider_alice,
            &alice,
            &ChatMessage::text("wiadomość przez prawdziwy QUIC", 1_700_000_000_000),
        )
        .unwrap();

    let koperta = Envelope::new(
        rozmowa_alice.group_id().to_vec(),
        EnvelopeKind::Application,
        szyfrogram,
    );

    tokio::time::timeout(TIMEOUT, transport_alice.send_direct(adres_boba, &koperta))
        .await
        .expect("wysyłka przekroczyła limit czasu")
        .expect("wysyłka bezpośrednia nieudana");

    let odebrane = tokio::time::timeout(TIMEOUT, odbior)
        .await
        .unwrap()
        .unwrap()
        .unwrap()
        .unwrap();

    let Incoming::Message {
        sender_user_id,
        sender_device_id,
        message,
    } = rozmowa_boba
        .receive(&provider_boba, &odebrane.envelope.payload)
        .unwrap()
    else {
        panic!("oczekiwano wiadomości aplikacyjnej");
    };

    assert_eq!(sender_user_id, "alice");
    assert_eq!(sender_device_id, "telefon");
    assert_eq!(message.as_text(), Some("wiadomość przez prawdziwy QUIC"));

    // Tożsamość transportowa musi być ROZŁĄCZNA z tożsamością podpisu MLS.
    // Gdyby te klucze się pokrywały, byłaby to podatność opisana w PROTOCOL.md.
    let klucz_mls = alice.signature_keypair().to_public_vec();
    assert_ne!(
        transport_alice.endpoint_id().as_bytes()[..],
        klucz_mls[..],
        "klucz węzła iroh pokrywa się z kluczem podpisu MLS"
    );

    transport_alice.close().await;
}

#[tokio::test]
async fn nieosiagalny_odbiorca_trafia_do_skrzynki() {
    let nadawca = Transport::bind_with_secret([3u8; 32], RelayPolicy::LoopbackOnly)
        .await
        .unwrap();

    // Węzeł, który nigdy nie istniał: znany identyfikator, zero adresów,
    // relaye wyłączone. Połączenie bezpośrednie nie ma jak się udać.
    let widmo = mekamb_transport::Transport::bind_with_secret([9u8; 32], RelayPolicy::LoopbackOnly)
        .await
        .unwrap();
    let adres_widma = iroh::EndpointAddr::new(widmo.endpoint_id());
    widmo.close().await;

    let skrzynka = SkrzynkaTestowa::default();
    let koperta = Envelope::new(b"g".to_vec(), EnvelopeKind::Application, b"tresc".to_vec());

    let sposob = tokio::time::timeout(
        TIMEOUT,
        nadawca.deliver("bob", Some(adres_widma), &koperta, &skrzynka),
    )
    .await
    .expect("dostarczanie przekroczyło limit czasu")
    .expect("dostarczanie zawiodło mimo działającej skrzynki");

    assert_eq!(sposob, Delivery::Mailbox);
    assert_eq!(skrzynka.liczba_depozytow(), 1);

    nadawca.close().await;
}

#[tokio::test]
async fn brak_znanego_adresu_omija_probe_bezposrednia() {
    let nadawca = Transport::bind_with_secret([4u8; 32], RelayPolicy::LoopbackOnly)
        .await
        .unwrap();
    let skrzynka = SkrzynkaTestowa::default();
    let koperta = Envelope::new(b"g".to_vec(), EnvelopeKind::Application, b"x".to_vec());

    // Katalog nie zna adresu odbiorcy — idziemy prosto do skrzynki, bez
    // czekania na timeout połączenia.
    let sposob = nadawca
        .deliver("bob", None, &koperta, &skrzynka)
        .await
        .unwrap();

    assert_eq!(sposob, Delivery::Mailbox);
    assert_eq!(skrzynka.liczba_depozytow(), 1);

    nadawca.close().await;
}

#[tokio::test]
async fn awaria_obu_drog_jest_bledem() {
    let nadawca = Transport::bind_with_secret([5u8; 32], RelayPolicy::LoopbackOnly)
        .await
        .unwrap();
    let koperta = Envelope::new(b"g".to_vec(), EnvelopeKind::Application, b"x".to_vec());

    let wynik = nadawca
        .deliver("bob", None, &koperta, &SkrzynkaNiedostepna)
        .await;

    assert!(
        wynik.is_err(),
        "gdy zawiodą obie drogi, wywołujący musi się o tym dowiedzieć"
    );

    nadawca.close().await;
}
