//! Testy transportu: dwa węzły rozmawiają bezpośrednio, bez żadnego serwera.
//!
//! Wszystko dzieje się na pętli zwrotnej, więc testy nie wychodzą do sieci
//! i nie zależą od dostępności czegokolwiek na zewnątrz.

use std::net::SocketAddr;
use std::sync::Mutex;
use std::time::Duration;

use mekamb_transport::{Delivery, Envelope, EnvelopeKind, Mailbox, PeerAddr, Result, Transport};

/// Skrzynka na potrzeby testów — zapisuje, co do niej trafiło.
#[derive(Default)]
struct SkrzynkaTestowa {
    zlozone: Mutex<Vec<String>>,
}

impl Mailbox for SkrzynkaTestowa {
    async fn deposit(&self, recipient: &str, _envelope: &Envelope) -> Result<()> {
        self.zlozone.lock().unwrap().push(recipient.to_string());
        Ok(())
    }
}

impl SkrzynkaTestowa {
    fn ile(&self) -> usize {
        self.zlozone.lock().unwrap().len()
    }
}

fn koperta(tresc: &[u8]) -> Envelope {
    Envelope::new(
        b"grupa-testowa".to_vec(),
        EnvelopeKind::Application,
        tresc.to_vec(),
    )
}

async fn wezel(seed: u8) -> Transport {
    Transport::bind_local(&[seed; 32])
        .await
        .expect("węzeł powinien wstać")
}

fn adres(t: &Transport) -> SocketAddr {
    t.addresses()[0]
}

fn peer(t: &Transport) -> PeerAddr {
    PeerAddr {
        public_key: t.public_key().to_vec(),
        addresses: vec![adres(t)],
    }
}

#[tokio::test]
async fn wiadomosc_dochodzi_bezposrednio() {
    let alice = wezel(1).await;
    let bob = wezel(2).await;
    let adres_boba = peer(&bob);

    let odbior = tokio::spawn(async move { bob.accept_next().await });
    tokio::time::sleep(Duration::from_millis(50)).await;

    alice
        .send_direct(&adres_boba, &koperta(b"prosto do boba"))
        .await
        .expect("wysyłka bezpośrednia powinna się udać");

    let odebrane = tokio::time::timeout(Duration::from_secs(10), odbior)
        .await
        .expect("odbiór nie powinien się zaciąć")
        .expect("zadanie odbioru")
        .expect("powinna przyjść koperta")
        .expect("koperta powinna być poprawna");

    assert_eq!(odebrane.envelope.payload, b"prosto do boba");
    assert_eq!(odebrane.envelope.group_id, b"grupa-testowa");
}

/// Nadawcę potwierdza handshake, a nie deklaracja w pakiecie.
#[tokio::test]
async fn nadawca_jest_uwierzytelniony_kluczem() {
    let alice = wezel(1).await;
    let bob = wezel(2).await;
    let klucz_alicji = alice.public_key().to_vec();
    let adres_boba = peer(&bob);

    let odbior = tokio::spawn(async move { bob.accept_next().await });
    tokio::time::sleep(Duration::from_millis(50)).await;

    alice
        .send_direct(&adres_boba, &koperta(b"tresc"))
        .await
        .unwrap();

    let odebrane = tokio::time::timeout(Duration::from_secs(10), odbior)
        .await
        .unwrap()
        .unwrap()
        .unwrap()
        .unwrap();

    assert_eq!(odebrane.sender_key, klucz_alicji);
}

/// Sedno warstwy szyfrującej: identyfikator grupy nie może być czytelny
/// w bajtach na drucie, bo odtworzyłby graf rozmów.
#[tokio::test]
async fn koperta_nie_jest_czytelna_w_sieci() {
    use tokio::net::UdpSocket;

    let alice = wezel(1).await;

    let podsluch = UdpSocket::bind("127.0.0.1:0").await.unwrap();
    let adres_podsluchu = podsluch.local_addr().unwrap();

    let cel = PeerAddr {
        public_key: vec![7u8; 32],
        addresses: vec![adres_podsluchu],
    };

    tokio::spawn(async move {
        let _ = alice.send_direct(&cel, &koperta(b"tresc")).await;
    });

    let mut bufor = vec![0u8; 65535];
    let (ile, _) = tokio::time::timeout(Duration::from_secs(5), podsluch.recv_from(&mut bufor))
        .await
        .expect("pakiet powinien dotrzeć")
        .unwrap();
    bufor.truncate(ile);

    assert!(
        !bufor.windows(13).any(|okno| okno == b"grupa-testowa"),
        "identyfikator grupy widoczny w bajtach sieciowych"
    );
}

/// Odbiorca nieosiągalny nie jest błędem — wiadomość ma trafić do skrzynki.
#[tokio::test]
async fn nieosiagalny_odbiorca_trafia_do_skrzynki() {
    let alice = wezel(1).await;
    let skrzynka = SkrzynkaTestowa::default();

    let martwy = PeerAddr {
        public_key: vec![9u8; 32],
        addresses: vec!["127.0.0.1:1".parse().unwrap()],
    };

    let sposob = alice
        .deliver(Some(&martwy), "bob", &koperta(b"tresc"), &skrzynka)
        .await
        .expect("dostarczenie przez skrzynkę powinno się udać");

    assert_eq!(sposob, Delivery::Mailbox);
    assert_eq!(skrzynka.ile(), 1);
}

#[tokio::test]
async fn brak_adresu_prowadzi_do_skrzynki() {
    let alice = wezel(1).await;
    let skrzynka = SkrzynkaTestowa::default();

    let sposob = alice
        .deliver(None, "bob", &koperta(b"tresc"), &skrzynka)
        .await
        .unwrap();

    assert_eq!(sposob, Delivery::Mailbox);
    assert_eq!(skrzynka.ile(), 1);
}

/// Ochrona przed podstawieniem urządzenia przez katalog.
#[tokio::test]
async fn podstawiony_klucz_uniemozliwia_polaczenie() {
    let alice = wezel(1).await;
    let bob = wezel(2).await;

    let podszywacz = PeerAddr {
        // Prawdziwy adres Boba, ale klucz kogoś innego — dokładnie to, co
        // zrobiłby serwer wydając spreparowany wpis katalogowy.
        public_key: vec![0xAA; 32],
        addresses: vec![adres(&bob)],
    };

    tokio::spawn(async move { bob.accept_next().await });
    tokio::time::sleep(Duration::from_millis(50)).await;

    assert!(
        alice
            .send_direct(&podszywacz, &koperta(b"tresc"))
            .await
            .is_err(),
        "połączenie z podstawionym kluczem nie powinno dojść do skutku"
    );
}

#[tokio::test]
async fn kolejne_wiadomosci_uzywaja_istniejacej_sesji() {
    let alice = wezel(1).await;
    let bob = wezel(2).await;
    let adres_boba = peer(&bob);

    let odbior = tokio::spawn(async move {
        let a = bob.accept_next().await;
        let b = bob.accept_next().await;
        (a, b)
    });

    tokio::time::sleep(Duration::from_millis(50)).await;
    alice
        .send_direct(&adres_boba, &koperta(b"pierwsza"))
        .await
        .unwrap();
    alice
        .send_direct(&adres_boba, &koperta(b"druga"))
        .await
        .unwrap();

    let (pierwsza, druga) = tokio::time::timeout(Duration::from_secs(10), odbior)
        .await
        .expect("odbiór nie powinien się zaciąć")
        .unwrap();

    assert_eq!(pierwsza.unwrap().unwrap().envelope.payload, b"pierwsza");
    assert_eq!(druga.unwrap().unwrap().envelope.payload, b"druga");
}

/// Datagramy z sieci bywają spreparowane — pętla odbioru ma je pomijać,
/// a nie kończyć pracę.
#[tokio::test]
async fn smieci_z_sieci_nie_zatrzymuja_odbioru() {
    use tokio::net::UdpSocket;

    let alice = wezel(1).await;
    let bob = wezel(2).await;
    let adres_boba = adres(&bob);
    let peer_boba = peer(&bob);

    let odbior = tokio::spawn(async move { bob.accept_next().await });

    let napastnik = UdpSocket::bind("127.0.0.1:0").await.unwrap();
    for smiec in [vec![0u8; 1], vec![0xFFu8; 64], vec![0xABu8; 1200]] {
        let _ = napastnik.send_to(&smiec, adres_boba).await;
    }

    tokio::time::sleep(Duration::from_millis(100)).await;
    alice
        .send_direct(&peer_boba, &koperta(b"prawdziwa"))
        .await
        .unwrap();

    let odebrane = tokio::time::timeout(Duration::from_secs(10), odbior)
        .await
        .expect("odbiór nie powinien się zaciąć")
        .unwrap()
        .expect("powinna przyjść koperta")
        .expect("koperta powinna być poprawna");

    assert_eq!(odebrane.envelope.payload, b"prawdziwa");
}

#[tokio::test]
async fn za_duza_koperta_jest_odrzucana() {
    let alice = wezel(1).await;
    let bob = wezel(2).await;

    let ogromna = Envelope::new(
        b"grupa".to_vec(),
        EnvelopeKind::Application,
        vec![0u8; mekamb_transport::MAX_PAYLOAD + 1],
    );

    assert!(alice.send_direct(&peer(&bob), &ogromna).await.is_err());
}
