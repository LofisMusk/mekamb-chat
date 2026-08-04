//! Minimalny klient STUN (RFC 5389) — wyłącznie do poznania własnego adresu.
//!
//! # Po co to jest
//!
//! Urządzenie za NAT-em nie zna adresu, pod którym widzi je świat. Bez tej
//! wiedzy nie da się umówić na połączenie bezpośrednie: obie strony musiałyby
//! zgadywać, dokąd wysłać pierwszy pakiet.
//!
//! STUN rozwiązuje to najprościej, jak się da — wysyłamy pakiet do serwera,
//! a on odsyła adres, z którego pakiet przyszedł.
//!
//! # Dlaczego własna implementacja zamiast biblioteki
//!
//! Potrzebujemy **jednego** typu żądania i **jednego** atrybutu odpowiedzi.
//! Cała reszta RFC 5389 — uwierzytelnianie, integralność, przekierowania — jest
//! dla nas martwa. Gotowa biblioteka wniosłaby kilka tysięcy linii kodu
//! i własne zależności po to, żeby wykorzystać z niej dwa procenty.
//!
//! # Czego STUN nie robi
//!
//! Nie przekazuje ruchu i nie widzi treści. Dowiaduje się jedynie, że dany
//! adres IP odpytał go o własny adres — tyle samo, co każdy router po drodze.
//! Serwer STUN nie musi być zaufany: gdyby skłamał o naszym adresie,
//! połączenie bezpośrednie po prostu by się nie zestawiło i zadziałałby
//! fallback na skrzynkę.

use std::io;
use std::net::SocketAddr;
use std::time::Duration;

use tokio::net::UdpSocket;

use crate::error::{Error, Result};

/// Znacznik protokołu z RFC 5389. Wchodzi też w maskowanie adresu.
const MAGIC_COOKIE: u32 = 0x2112_A442;

/// Typ komunikatu: Binding Request.
const BINDING_REQUEST: u16 = 0x0001;

/// Typ komunikatu: Binding Success Response.
const BINDING_SUCCESS: u16 = 0x0101;

/// Atrybut niosący adres, zamaskowany magicznym znacznikiem.
///
/// Maskowanie istnieje dlatego, że część routerów przepisywała adresy
/// znalezione w ładunku pakietu, psując odpowiedź. XOR sprawia, że adres
/// nie wygląda jak adres.
const XOR_MAPPED_ADDRESS: u16 = 0x0020;

/// Ile czekamy na odpowiedź serwera.
const TIMEOUT: Duration = Duration::from_secs(3);

/// Ile razy ponawiamy. UDP gubi pakiety i to jest normalne, a nie awaria.
const RETRIES: usize = 3;

/// Pyta serwer STUN o adres, pod którym widzi nasze gniazdo.
///
/// Używa **tego samego gniazda**, którym potem wysyłamy dane. To nie jest
/// szczegół: NAT przypisuje mapowanie do konkretnej pary (gniazdo lokalne,
/// cel), więc adres poznany innym gniazdem byłby bezużyteczny.
pub async fn discover_public_address(socket: &UdpSocket, server: SocketAddr) -> Result<SocketAddr> {
    let transaction_id: [u8; 12] = rand::random();
    let request = build_request(&transaction_id);

    for _ in 0..RETRIES {
        socket
            .send_to(&request, server)
            .await
            .map_err(|e| Error::Transport(format!("nie udało się wysłać zapytania STUN: {e}")))?;

        let mut bufor = [0u8; 512];

        match tokio::time::timeout(TIMEOUT, socket.recv_from(&mut bufor)).await {
            // Cisza w tej rundzie — ponawiamy.
            Err(_) => continue,

            Ok(Err(e)) => {
                return Err(Error::Transport(format!("błąd odbioru odpowiedzi STUN: {e}")));
            }

            Ok(Ok((ile, from))) => {
                // Odpowiedź musi przyjść od serwera, którego pytaliśmy, i nieść
                // nasz identyfikator transakcji. Bez tego sprawdzenia dowolny
                // host mógłby wstrzyknąć nam fałszywy adres.
                if from != server {
                    continue;
                }

                if let Some(adres) = parse_response(&bufor[..ile], &transaction_id) {
                    return Ok(adres);
                }
            }
        }
    }

    Err(Error::Transport("serwer STUN nie odpowiedział".into()))
}

/// Buduje Binding Request: 20 bajtów nagłówka, bez atrybutów.
fn build_request(transaction_id: &[u8; 12]) -> Vec<u8> {
    let mut pakiet = Vec::with_capacity(20);

    pakiet.extend_from_slice(&BINDING_REQUEST.to_be_bytes());
    // Długość ładunku — u nas zawsze zero, bo nie wysyłamy atrybutów.
    pakiet.extend_from_slice(&0u16.to_be_bytes());
    pakiet.extend_from_slice(&MAGIC_COOKIE.to_be_bytes());
    pakiet.extend_from_slice(transaction_id);

    pakiet
}

/// Wyciąga adres z odpowiedzi. `None`, gdy pakiet nie jest tym, na co czekamy.
///
/// Dane przychodzą z sieci, więc każde odchylenie od oczekiwanego kształtu
/// kończy się odrzuceniem, nigdy paniką.
fn parse_response(pakiet: &[u8], transaction_id: &[u8; 12]) -> Option<SocketAddr> {
    if pakiet.len() < 20 {
        return None;
    }

    let typ = u16::from_be_bytes([pakiet[0], pakiet[1]]);
    let cookie = u32::from_be_bytes([pakiet[4], pakiet[5], pakiet[6], pakiet[7]]);

    if typ != BINDING_SUCCESS || cookie != MAGIC_COOKIE || &pakiet[8..20] != transaction_id {
        return None;
    }

    let dlugosc = u16::from_be_bytes([pakiet[2], pakiet[3]]) as usize;
    let koniec = 20usize.checked_add(dlugosc)?;
    if koniec > pakiet.len() {
        return None;
    }

    przeszukaj_atrybuty(&pakiet[20..koniec], transaction_id)
}

fn przeszukaj_atrybuty(mut atrybuty: &[u8], transaction_id: &[u8; 12]) -> Option<SocketAddr> {
    while atrybuty.len() >= 4 {
        let typ = u16::from_be_bytes([atrybuty[0], atrybuty[1]]);
        let dlugosc = u16::from_be_bytes([atrybuty[2], atrybuty[3]]) as usize;

        let wartosc = atrybuty.get(4..4 + dlugosc)?;

        if typ == XOR_MAPPED_ADDRESS {
            return odmaskuj_adres(wartosc, transaction_id);
        }

        // Atrybuty są dopełniane do wielokrotności czterech bajtów.
        let krok = 4 + dlugosc.next_multiple_of(4);
        atrybuty = atrybuty.get(krok..)?;
    }

    None
}

/// Zdejmuje maskę z adresu.
///
/// Port jest XOR-owany górną połową znacznika, adres IPv4 całym znacznikiem,
/// a IPv6 znacznikiem sklejonym z identyfikatorem transakcji.
fn odmaskuj_adres(wartosc: &[u8], transaction_id: &[u8; 12]) -> Option<SocketAddr> {
    if wartosc.len() < 4 {
        return None;
    }

    let rodzina = wartosc[1];
    let port = u16::from_be_bytes([wartosc[2], wartosc[3]]) ^ (MAGIC_COOKIE >> 16) as u16;

    match rodzina {
        // IPv4
        0x01 => {
            let surowy = u32::from_be_bytes(wartosc.get(4..8)?.try_into().ok()?);
            let ip = std::net::Ipv4Addr::from(surowy ^ MAGIC_COOKIE);
            Some(SocketAddr::from((ip, port)))
        }

        // IPv6
        0x02 => {
            let surowy: [u8; 16] = wartosc.get(4..20)?.try_into().ok()?;

            let mut maska = [0u8; 16];
            maska[..4].copy_from_slice(&MAGIC_COOKIE.to_be_bytes());
            maska[4..].copy_from_slice(transaction_id);

            let mut ip = [0u8; 16];
            for i in 0..16 {
                ip[i] = surowy[i] ^ maska[i];
            }

            Some(SocketAddr::from((std::net::Ipv6Addr::from(ip), port)))
        }

        _ => None,
    }
}

/// Rozwiązuje nazwę serwera STUN na adres.
pub async fn resolve(server: &str) -> Result<SocketAddr> {
    tokio::net::lookup_host(server)
        .await
        .map_err(|e: io::Error| Error::Transport(format!("nie udało się rozwiązać {server}: {e}")))?
        .next()
        .ok_or_else(|| Error::Transport(format!("{server} nie wskazuje na żaden adres")))
}

#[cfg(test)]
mod tests {
    use super::*;

    fn odpowiedz_ipv4(transaction_id: &[u8; 12], ip: [u8; 4], port: u16) -> Vec<u8> {
        let zamaskowany_port = port ^ (MAGIC_COOKIE >> 16) as u16;
        let zamaskowany_ip = u32::from_be_bytes(ip) ^ MAGIC_COOKIE;

        let mut atrybut = Vec::new();
        atrybut.extend_from_slice(&XOR_MAPPED_ADDRESS.to_be_bytes());
        atrybut.extend_from_slice(&8u16.to_be_bytes());
        atrybut.push(0); // rezerwa
        atrybut.push(0x01); // IPv4
        atrybut.extend_from_slice(&zamaskowany_port.to_be_bytes());
        atrybut.extend_from_slice(&zamaskowany_ip.to_be_bytes());

        let mut pakiet = Vec::new();
        pakiet.extend_from_slice(&BINDING_SUCCESS.to_be_bytes());
        pakiet.extend_from_slice(&(atrybut.len() as u16).to_be_bytes());
        pakiet.extend_from_slice(&MAGIC_COOKIE.to_be_bytes());
        pakiet.extend_from_slice(transaction_id);
        pakiet.extend_from_slice(&atrybut);

        pakiet
    }

    #[test]
    fn zadanie_ma_ksztalt_z_rfc() {
        let id = [7u8; 12];
        let zadanie = build_request(&id);

        assert_eq!(zadanie.len(), 20);
        assert_eq!(u16::from_be_bytes([zadanie[0], zadanie[1]]), BINDING_REQUEST);
        assert_eq!(u16::from_be_bytes([zadanie[2], zadanie[3]]), 0, "brak atrybutów");
        assert_eq!(&zadanie[8..20], &id);
    }

    #[test]
    fn odczytuje_adres_ipv4() {
        let id = [3u8; 12];
        let pakiet = odpowiedz_ipv4(&id, [203, 0, 113, 7], 51234);

        let adres = parse_response(&pakiet, &id).expect("adres powinien się odczytać");

        assert_eq!(adres.to_string(), "203.0.113.7:51234");
    }

    /// Bez sprawdzenia identyfikatora dowolny host mógłby wstrzyknąć nam
    /// fałszywy adres i skierować połączenia gdzie indziej.
    #[test]
    fn odpowiedz_z_obcym_identyfikatorem_jest_odrzucana() {
        let pakiet = odpowiedz_ipv4(&[1u8; 12], [203, 0, 113, 7], 51234);

        assert!(parse_response(&pakiet, &[2u8; 12]).is_none());
    }

    #[test]
    fn odpowiedz_bez_magicznego_znacznika_jest_odrzucana() {
        let id = [3u8; 12];
        let mut pakiet = odpowiedz_ipv4(&id, [203, 0, 113, 7], 51234);
        pakiet[4] ^= 0xFF;

        assert!(parse_response(&pakiet, &id).is_none());
    }

    #[test]
    fn pomija_nieznane_atrybuty_i_znajduje_wlasciwy() {
        let id = [5u8; 12];

        // Atrybut, którego nie znamy, o nietypowej długości wymuszającej
        // dopełnienie — najczęstsze miejsce na błąd w parserze.
        let mut atrybuty = Vec::new();
        atrybuty.extend_from_slice(&0x8022u16.to_be_bytes()); // SOFTWARE
        atrybuty.extend_from_slice(&5u16.to_be_bytes());
        atrybuty.extend_from_slice(b"nginx");
        atrybuty.extend_from_slice(&[0, 0, 0]); // dopełnienie do 8

        let wlasciwy = odpowiedz_ipv4(&id, [198, 51, 100, 42], 3478);
        atrybuty.extend_from_slice(&wlasciwy[20..]);

        let mut pakiet = Vec::new();
        pakiet.extend_from_slice(&BINDING_SUCCESS.to_be_bytes());
        pakiet.extend_from_slice(&(atrybuty.len() as u16).to_be_bytes());
        pakiet.extend_from_slice(&MAGIC_COOKIE.to_be_bytes());
        pakiet.extend_from_slice(&id);
        pakiet.extend_from_slice(&atrybuty);

        assert_eq!(
            parse_response(&pakiet, &id).map(|a| a.to_string()),
            Some("198.51.100.42:3478".to_string()),
        );
    }

    /// Pakiety z sieci bywają spreparowane. Parser ma zwracać `None`,
    /// nigdy panikować ani zapętlać się.
    #[test]
    fn spreparowane_pakiety_nie_powoduja_paniki() {
        let id = [9u8; 12];

        let przypadki: Vec<Vec<u8>> = vec![
            vec![],
            vec![0; 19],
            vec![0xFF; 20],
            // Deklaruje ładunek większy niż pakiet.
            {
                let mut p = odpowiedz_ipv4(&id, [1, 2, 3, 4], 1234);
                p[2] = 0xFF;
                p[3] = 0xFF;
                p
            },
            // Atrybut o długości zero — naiwna pętla zapętliłaby się tutaj.
            {
                let mut p = Vec::new();
                p.extend_from_slice(&BINDING_SUCCESS.to_be_bytes());
                p.extend_from_slice(&4u16.to_be_bytes());
                p.extend_from_slice(&MAGIC_COOKIE.to_be_bytes());
                p.extend_from_slice(&id);
                p.extend_from_slice(&[0x00, 0x99, 0x00, 0x00]);
                p
            },
            vec![0xAB; 1024],
        ];

        for pakiet in przypadki {
            let _ = parse_response(&pakiet, &id);
        }
    }
}
