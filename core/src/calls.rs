//! Weryfikacja odcisku DTLS w sygnalizacji rozmów.
//!
//! # Na czym polega problem
//!
//! WebRTC szyfruje media przez DTLS-SRTP, a tożsamość drugiej strony sprowadza
//! się do **odcisku certyfikatu DTLS** zapisanego w SDP. Kto kontroluje
//! sygnalizację, ten może podmienić ten odcisk na własny, zestawić dwa
//! połączenia i słuchać w środku. Samo „WebRTC jest szyfrowane" nie chroni
//! przed niczym takim.
//!
//! # Jak to zamykamy
//!
//! Odcisk podróżuje **wewnątrz kanału MLS**, w [`crate::framing::CallSignalBody`],
//! niezależnie od SDP. Przed zestawieniem połączenia porównujemy jeden z drugim.
//! Podmiot kontrolujący sygnalizację musiałby sfałszować wiadomość MLS, a tego
//! nie potrafi.
//!
//! # Niezgodność zrywa połączenie bez pytania
//!
//! Zapytanie użytkownika „odcisk się nie zgadza, kontynuować?" przerzucałoby
//! decyzję kryptograficzną na osobę, która nie ma jak jej ocenić. Odpowiedź
//! „tak" byłaby wtedy najczęstsza, a to dokładnie ten przypadek, przed którym
//! ochrona miała bronić.

use crate::error::{Error, Result};

/// Algorytm odcisku. Jedyny akceptowany — starsze są podatne na kolizje,
/// a lista dozwolonych z jedną pozycją nie pozwala na negocjację w dół.
const ALGORITHM: &str = "sha-256";

/// Wyciąga wszystkie odciski DTLS z SDP.
///
/// **Wszystkie**, nie pierwszy. SDP może nieść odcisk na poziomie sesji i osobne
/// dla każdej ścieżki mediów; wystarczyłoby dopisać drugą ścieżkę z własnym
/// odciskiem, żeby sprawdzenie tylko pierwszego dało się obejść.
pub fn extract_fingerprints(sdp: &str) -> Vec<String> {
    sdp.lines()
        .filter_map(|linia| {
            let linia = linia.trim();
            let reszta = linia.strip_prefix("a=fingerprint:")?;

            let (algorytm, wartosc) = reszta.split_once(char::is_whitespace)?;

            if algorytm.eq_ignore_ascii_case(ALGORITHM) {
                Some(normalizuj(wartosc))
            } else {
                // Inny algorytm traktujemy jak odcisk, którego nie znamy —
                // trafia na listę w postaci, która nigdy nie zgodzi się
                // z oczekiwaną, więc weryfikacja odpadnie.
                Some(format!(
                    "{}:{}",
                    algorytm.to_ascii_lowercase(),
                    normalizuj(wartosc)
                ))
            }
        })
        .collect()
}

/// Sprowadza odcisk do postaci porównywalnej: małe litery, bez separatorów.
fn normalizuj(wartosc: &str) -> String {
    wartosc
        .chars()
        .filter(|c| c.is_ascii_alphanumeric())
        .map(|c| c.to_ascii_lowercase())
        .collect()
}

/// Sprawdza, czy SDP niesie **wyłącznie** oczekiwany odcisk DTLS.
///
/// `expected` pochodzi z kanału MLS, czyli ze źródła, którego kontrolujący
/// sygnalizację nie potrafi podrobić.
///
/// Zwraca błąd, gdy:
/// - w SDP nie ma żadnego odcisku,
/// - którykolwiek odcisk różni się od oczekiwanego,
/// - oczekiwany odcisk jest pusty albo w złym formacie.
pub fn verify_sdp_fingerprint(sdp: &str, expected: &str) -> Result<()> {
    let oczekiwany = normalizuj(expected);

    // SHA-256 to 32 bajty, czyli 64 znaki szesnastkowe.
    if oczekiwany.len() != 64 || !oczekiwany.chars().all(|c| c.is_ascii_hexdigit()) {
        return Err(Error::InvalidInput(
            "oczekiwany odcisk DTLS ma nieprawidłowy format".into(),
        ));
    }

    let znalezione = extract_fingerprints(sdp);

    if znalezione.is_empty() {
        return Err(Error::MessageRejected);
    }

    // Każdy odcisk w SDP musi zgadzać się z oczekiwanym. Wystarczy jeden obcy,
    // żeby połączenie mogło pójść nie tam, gdzie trzeba.
    let wszystkie_zgodne = znalezione
        .iter()
        .all(|znaleziony| stale_rowne(znaleziony, &oczekiwany));

    if wszystkie_zgodne {
        Ok(())
    } else {
        Err(Error::MessageRejected)
    }
}

/// Porównanie odporne na atak czasowy.
///
/// Odcisk jest publiczny, więc wyciek czasu nie jest tu krytyczny — ale
/// porównanie kryptograficzne kończące się na pierwszej różnicy to nawyk,
/// którego lepiej nie mieć.
fn stale_rowne(a: &str, b: &str) -> bool {
    if a.len() != b.len() {
        return false;
    }

    a.bytes()
        .zip(b.bytes())
        .fold(0u8, |acc, (x, y)| acc | (x ^ y))
        == 0
}

#[cfg(test)]
mod tests {
    use super::*;

    const ODCISK: &str = "AB:CD:EF:01:23:45:67:89:AB:CD:EF:01:23:45:67:89:\
AB:CD:EF:01:23:45:67:89:AB:CD:EF:01:23:45:67:89";

    const INNY: &str = "11:22:33:44:55:66:77:88:99:00:11:22:33:44:55:66:\
77:88:99:00:11:22:33:44:55:66:77:88:99:00:11:22";

    fn sdp_z_odciskami(odciski: &[&str]) -> String {
        let mut sdp = String::from("v=0\r\no=- 0 0 IN IP4 127.0.0.1\r\ns=-\r\n");
        for odcisk in odciski {
            sdp.push_str(&format!("a=fingerprint:sha-256 {odcisk}\r\n"));
        }
        sdp.push_str("m=audio 9 UDP/TLS/RTP/SAVPF 111\r\n");
        sdp
    }

    #[test]
    fn zgodny_odcisk_przechodzi() {
        assert!(verify_sdp_fingerprint(&sdp_z_odciskami(&[ODCISK]), ODCISK).is_ok());
    }

    /// Sedno ochrony: podmiana odcisku w SDP przez kontrolującego sygnalizację
    /// musi zerwać połączenie.
    #[test]
    fn podmieniony_odcisk_jest_odrzucany() {
        assert!(verify_sdp_fingerprint(&sdp_z_odciskami(&[INNY]), ODCISK).is_err());
    }

    /// Wystarczyłoby dopisać drugą ścieżkę mediów z własnym odciskiem, gdyby
    /// sprawdzać tylko pierwszy.
    #[test]
    fn dodatkowy_obcy_odcisk_jest_wykrywany() {
        let sdp = sdp_z_odciskami(&[ODCISK, INNY]);

        assert!(
            verify_sdp_fingerprint(&sdp, ODCISK).is_err(),
            "obcy odcisk na drugiej ścieżce przeszedł"
        );
    }

    #[test]
    fn wiele_kopii_tego_samego_odcisku_przechodzi() {
        // Odcisk na poziomie sesji i powtórzony przy ścieżce to normalna
        // sytuacja — przeglądarki tak robią.
        let sdp = sdp_z_odciskami(&[ODCISK, ODCISK, ODCISK]);
        assert!(verify_sdp_fingerprint(&sdp, ODCISK).is_ok());
    }

    #[test]
    fn brak_odcisku_jest_odrzucany() {
        let sdp = "v=0\r\no=- 0 0 IN IP4 127.0.0.1\r\ns=-\r\nm=audio 9 UDP/TLS/RTP/SAVPF 111\r\n";
        assert!(verify_sdp_fingerprint(sdp, ODCISK).is_err());
    }

    /// Słabszy algorytm nie może przejść — inaczej dałoby się zejść na taki,
    /// dla którego znalezienie kolizji jest osiągalne.
    #[test]
    fn slabszy_algorytm_nie_przechodzi() {
        let sdp = "v=0\r\na=fingerprint:sha-1 AB:CD:EF:01:23:45:67:89:AB:CD:EF:01:23:45:67:89:AB:CD:EF:01\r\n";
        assert!(verify_sdp_fingerprint(sdp, ODCISK).is_err());
    }

    #[test]
    fn wielkosc_liter_i_separatory_nie_maja_znaczenia() {
        let bez_dwukropkow = ODCISK.replace(':', "").to_lowercase();
        let sdp = sdp_z_odciskami(&[&bez_dwukropkow]);

        assert!(verify_sdp_fingerprint(&sdp, ODCISK).is_ok());
    }

    #[test]
    fn nieprawidlowy_oczekiwany_odcisk_jest_odrzucany() {
        let sdp = sdp_z_odciskami(&[ODCISK]);

        for zly in ["", "za-krotki", "ZZ:ZZ", &"ab".repeat(50)] {
            assert!(
                verify_sdp_fingerprint(&sdp, zly).is_err(),
                "przeszedł nieprawidłowy oczekiwany odcisk: {zly}"
            );
        }
    }

    /// SDP przychodzi z sieci, więc bywa spreparowane.
    #[test]
    fn smieciowe_sdp_nie_powoduje_paniki() {
        for smiec in [
            "",
            "a=fingerprint:",
            "a=fingerprint:sha-256",
            "\0\0\0",
            &"x".repeat(10_000),
        ] {
            let _ = verify_sdp_fingerprint(smiec, ODCISK);
            let _ = extract_fingerprints(smiec);
        }
    }
}
