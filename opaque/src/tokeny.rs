//! Niepowiązywalne tokeny doręczeniowe (sealed sender).
//!
//! # Problem
//!
//! Zostawienie koperty w cudzej skrzynce jest **nieuwierzytelnione** i to jest
//! decyzja, nie przeoczenie: serwer nie ma się dowiadywać, kto do kogo pisze.
//! Tożsamość nadawcy potwierdza MLS, wewnątrz szyfrogramu, gdzie serwer jej nie
//! widzi.
//!
//! Ceną jest to, że nadawać może **każdy**, więc każdy może zalewać cudzą
//! skrzynkę. Dołożenie tokenu w zwykłej postaci nie pomaga: token, po którym
//! serwer rozpoznaje konto, przywraca dokładnie ten wyciek, który usunęliśmy.
//!
//! # Rozwiązanie
//!
//! OPRF w wariancie Privacy Pass. Serwer podpisuje **oślepioną** wartość, więc
//! przy wydaniu nie widzi tokenu, a przy realizacji nie widzi, komu go wydał.
//!
//! ```text
//! wydanie     klient: t ← losowe, T = H2C(t), r ← losowy skalar, B = r·T
//!             serwer: Z = k·B                (+ dowód, że użył swojego k)
//!             klient: N = r⁻¹·Z = k·T        i chowa parę (t, N)
//!
//! realizacja  klient: pokazuje (t, N) — bez żadnego tokenu konta
//!             serwer: sprawdza k·H2C(t) == N i że t nie było jeszcze użyte
//! ```
//!
//! Serwer widzi przy wydaniu `B` (rozkład równomierny, bo `r` jest losowe)
//! i przy realizacji `(t, N)`. Nic ich nie łączy.
//!
//! # Dlaczego jest dowód, a nie sam OPRF
//!
//! Bo bez niego złośliwy serwer **znakuje** użytkowników: wydaje tokeny innym
//! kluczem każdemu z osobna i przy realizacji rozpoznaje, czyj był. Anonimowość
//! zniknęłaby wobec dokładnie tego przeciwnika, którego wymienia
//! `docs/THREAT_MODEL.md` jako złośliwy serwer — czyli schemat wyglądałby na
//! sealed sender, nie będąc nim.
//!
//! Dlatego serwer dołącza dowód Chauma-Pedersena, że do oślepionej wartości
//! użył tego samego `k`, co do swojego opublikowanego klucza publicznego.
//! Klient, który go nie sprawdzi, płaci własną anonimowością, więc sprawdzenie
//! jest częścią [`odslon`], a nie osobnym krokiem do pominięcia.
//!
//! # Dlaczego to leży w `opaque`, a nie w `core`
//!
//! Bo jako jedyna kryptografia w projekcie musi działać także **na serwerze**,
//! a Worker ładuje wyłącznie WASM zbudowany z tej skrzyni. `core` jest po
//! stronie klientów. Reguła „kryptografia w Rust, raz" zostaje zachowana:
//! implementacja jest jedna, a strony biorą z niej swoje połowy.

use curve25519_dalek::{
    constants::RISTRETTO_BASEPOINT_POINT, ristretto::CompressedRistretto,
    ristretto::RistrettoPoint, scalar::Scalar,
};
use rand::rngs::OsRng;
use sha2::{Digest, Sha512};

use crate::error::{Error, Result};

/// Długość elementu grupy i skalara po skompresowaniu.
pub const PUNKT_LEN: usize = 32;

/// Długość jednorazowego ziarna tokenu.
pub const ZIARNO_LEN: usize = 32;

/// Etykieta odwzorowania w grupę. **Zamrożona** — zmiana unieważnia wszystkie
/// wydane tokeny naraz.
const LABEL_H2C: &[u8] = b"mekamb-chat/v1/token-doreczeniowy";

/// Etykieta wyzwania w dowodzie. Zamrożona z tego samego powodu.
const LABEL_DOWOD: &[u8] = b"mekamb-chat/v1/token-dowod";

/// Odwzorowuje ziarno w element grupy.
///
/// `hash_from_bytes` na Ristretto daje punkt bez znanego logarytmu dyskretnego,
/// czego cały schemat wymaga: gdyby klient umiał wskazać `T = x·G` ze znanym
/// `x`, policzyłby `k·T` sam z klucza publicznego i wydawałby sobie tokeny.
fn w_grupe(ziarno: &[u8]) -> RistrettoPoint {
    let mut hasher = Sha512::new();
    hasher.update(LABEL_H2C);
    hasher.update(ziarno);
    RistrettoPoint::from_hash(hasher)
}

fn do_punktu(bajty: &[u8]) -> Result<RistrettoPoint> {
    let tablica: [u8; PUNKT_LEN] = bajty
        .try_into()
        .map_err(|_| Error::Token("element grupy musi mieć 32 bajty".into()))?;

    CompressedRistretto(tablica)
        .decompress()
        .ok_or_else(|| Error::Token("element grupy jest nieprawidłowy".into()))
}

fn do_skalara(bajty: &[u8]) -> Result<Scalar> {
    let tablica: [u8; PUNKT_LEN] = bajty
        .try_into()
        .map_err(|_| Error::Token("skalar musi mieć 32 bajty".into()))?;

    Option::<Scalar>::from(Scalar::from_canonical_bytes(tablica))
        .ok_or_else(|| Error::Token("skalar nie jest kanoniczny".into()))
}

/// Wyzwanie dowodu. Wiąże wszystkie wartości, żeby dowodu nie dało się przenieść.
fn wyzwanie(
    klucz_publiczny: &RistrettoPoint,
    oslepione: &RistrettoPoint,
    ocenione: &RistrettoPoint,
    a1: &RistrettoPoint,
    a2: &RistrettoPoint,
) -> Scalar {
    let mut hasher = Sha512::new();
    hasher.update(LABEL_DOWOD);
    for punkt in [klucz_publiczny, oslepione, ocenione, a1, a2] {
        hasher.update(punkt.compress().as_bytes());
    }
    Scalar::from_hash(hasher)
}

// --- Serwer ------------------------------------------------------------------

/// Klucz wydawania tokenów. **Sekret** — kto go ma, wydaje tokeny bez ograniczeń.
pub struct KluczTokenow(Scalar);

impl KluczTokenow {
    /// Losuje nowy klucz. Wołane raz, przy stawianiu instancji.
    pub fn losuj() -> Self {
        Self(Scalar::random(&mut OsRng))
    }

    pub fn z_bajtow(bajty: &[u8]) -> Result<Self> {
        Ok(Self(do_skalara(bajty)?))
    }

    pub fn do_bajtow(&self) -> [u8; PUNKT_LEN] {
        self.0.to_bytes()
    }

    /// Klucz publiczny do opublikowania klientom.
    ///
    /// Bez niego klient nie ma czego sprawdzić w dowodzie, więc znakowanie
    /// przez serwer przestaje być wykrywalne.
    pub fn klucz_publiczny(&self) -> [u8; PUNKT_LEN] {
        (RISTRETTO_BASEPOINT_POINT * self.0).compress().to_bytes()
    }

    /// Ocenia oślepioną wartość i dowodzi, że użyła tego samego klucza.
    ///
    /// Wołane na ścieżce **uwierzytelnionej**: serwer wie, komu wydaje, i tylko
    /// tutaj może to policzyć. Przy realizacji już nie będzie wiedział.
    pub fn ocen(&self, oslepione: &[u8]) -> Result<Ocena> {
        let b = do_punktu(oslepione)?;
        let z = b * self.0;

        // Dowód Chauma-Pedersena: log_G(K) == log_B(Z), bez ujawnienia k.
        let s = Scalar::random(&mut OsRng);
        let a1 = RISTRETTO_BASEPOINT_POINT * s;
        let a2 = b * s;

        let k_pub = RISTRETTO_BASEPOINT_POINT * self.0;
        let c = wyzwanie(&k_pub, &b, &z, &a1, &a2);

        Ok(Ocena {
            ocenione: z.compress().to_bytes(),
            wyzwanie: c.to_bytes(),
            odpowiedz: (s + c * self.0).to_bytes(),
        })
    }

    /// Sprawdza token pokazany przy realizacji.
    ///
    /// **Nie sprawdza, czy token był już użyty** — o to dba wołający, bo tylko
    /// on ma trwały magazyn. Bez tego jeden token wystarczyłby na dowolną liczbę
    /// nadań i cała ochrona przed zalewaniem skrzynek byłaby pozorna.
    pub fn sprawdz(&self, ziarno: &[u8], odslonione: &[u8]) -> Result<bool> {
        if ziarno.len() != ZIARNO_LEN {
            return Err(Error::Token("ziarno tokenu musi mieć 32 bajty".into()));
        }

        let n = do_punktu(odslonione)?;
        Ok(w_grupe(ziarno) * self.0 == n)
    }
}

/// Odpowiedź serwera przy wydaniu.
#[derive(Debug, Clone)]
pub struct Ocena {
    pub ocenione: [u8; PUNKT_LEN],
    pub wyzwanie: [u8; PUNKT_LEN],
    pub odpowiedz: [u8; PUNKT_LEN],
}

// --- Klient ------------------------------------------------------------------

/// Oślepiona prośba razem z tym, co trzeba zachować do odsłonięcia.
#[derive(Debug, Clone)]
pub struct Proba {
    /// Ziarno tokenu. Pokazywane dopiero przy realizacji.
    pub ziarno: [u8; ZIARNO_LEN],
    /// Czynnik oślepiający. **Nie opuszcza urządzenia.**
    pub oslepiacz: [u8; PUNKT_LEN],
    /// Do wysłania serwerowi.
    pub oslepione: [u8; PUNKT_LEN],
}

/// Przygotowuje jedną prośbę o token.
pub fn oslep() -> Proba {
    let mut ziarno = [0u8; ZIARNO_LEN];
    rand::RngCore::fill_bytes(&mut OsRng, &mut ziarno);

    // Skalar losowy jest odwracalny z przytłaczającym prawdopodobieństwem;
    // zero wykluczamy jawnie, bo dałoby punkt neutralny i token nie do użycia.
    let mut r = Scalar::random(&mut OsRng);
    while r == Scalar::ZERO {
        r = Scalar::random(&mut OsRng);
    }

    let oslepione = w_grupe(&ziarno) * r;

    Proba {
        ziarno,
        oslepiacz: r.to_bytes(),
        oslepione: oslepione.compress().to_bytes(),
    }
}

/// Gotowy token do zachowania i późniejszego pokazania.
#[derive(Debug, Clone, PartialEq, Eq)]
pub struct Token {
    pub ziarno: [u8; ZIARNO_LEN],
    pub odslonione: [u8; PUNKT_LEN],
}

/// Odsłania ocenę serwera, sprawdzając wcześniej jego dowód.
///
/// Sprawdzenie jest **tutaj**, a nie osobnym krokiem: klient, który by je
/// pominął, płaciłby własną anonimowością, a pominięcie kroku jest łatwiejsze
/// niż jego wykonanie.
pub fn odslon(proba: &Proba, ocena: &Ocena, klucz_publiczny: &[u8]) -> Result<Token> {
    let k_pub = do_punktu(klucz_publiczny)?;
    let b = do_punktu(&proba.oslepione)?;
    let z = do_punktu(&ocena.ocenione)?;

    let c = do_skalara(&ocena.wyzwanie)?;
    let odp = do_skalara(&ocena.odpowiedz)?;

    // Odtworzenie zobowiązań z odpowiedzi: jeśli serwer użył tego samego `k`,
    // wychodzą dokładnie te, na które policzył wyzwanie.
    let a1 = RISTRETTO_BASEPOINT_POINT * odp - k_pub * c;
    let a2 = b * odp - z * c;

    if wyzwanie(&k_pub, &b, &z, &a1, &a2) != c {
        return Err(Error::Token(
            "serwer nie dowiódł, że użył swojego klucza — token odrzucony".into(),
        ));
    }

    let r = do_skalara(&proba.oslepiacz)?;
    let odwrotny = r.invert();

    Ok(Token {
        ziarno: proba.ziarno,
        odslonione: (z * odwrotny).compress().to_bytes(),
    })
}

#[cfg(test)]
mod tests {
    use super::*;

    /// Pełne koło: wydanie i realizacja jednego tokenu.
    #[test]
    fn token_przechodzi_pelne_kolo() {
        let klucz = KluczTokenow::losuj();
        let proba = oslep();

        let ocena = klucz.ocen(&proba.oslepione).unwrap();
        let token = odslon(&proba, &ocena, &klucz.klucz_publiczny()).unwrap();

        assert!(klucz.sprawdz(&token.ziarno, &token.odslonione).unwrap());
    }

    /// Sedno: serwer nie może powiązać wydania z realizacją.
    ///
    /// To jest cały powód istnienia tego modułu. Gdyby oślepiona wartość
    /// zdradzała ziarno albo gotowy token, tokeny byłyby zwykłymi
    /// identyfikatorami i wyciek „kto do kogo pisze" wróciłby w całości.
    #[test]
    fn oslepione_nie_zdradza_tokenu() {
        let klucz = KluczTokenow::losuj();
        let proba = oslep();
        let ocena = klucz.ocen(&proba.oslepione).unwrap();
        let token = odslon(&proba, &ocena, &klucz.klucz_publiczny()).unwrap();

        assert_ne!(proba.oslepione, token.odslonione);
        assert_ne!(&proba.oslepione[..], &token.ziarno[..]);
        assert_ne!(ocena.ocenione, token.odslonione);
    }

    /// Sedno: dwa wydania nie dają się odróżnić po tym, co widzi serwer.
    #[test]
    fn dwie_prosby_wygladaja_niezaleznie() {
        let a = oslep();
        let b = oslep();

        assert_ne!(a.ziarno, b.ziarno);
        assert_ne!(a.oslepione, b.oslepione);
    }

    /// Sedno: bez dowodu złośliwy serwer ZNAKUJE użytkowników — wydaje każdemu
    /// tokeny innym kluczem i przy realizacji rozpoznaje, czyj był. Klient musi
    /// to wykryć, inaczej schemat tylko wygląda na anonimowy.
    #[test]
    fn ocena_obcym_kluczem_jest_odrzucana() {
        let uczciwy = KluczTokenow::losuj();
        let znakujacy = KluczTokenow::losuj();

        let proba = oslep();
        let ocena = znakujacy.ocen(&proba.oslepione).unwrap();

        // Klient zna wyłącznie opublikowany klucz publiczny.
        assert!(odslon(&proba, &ocena, &uczciwy.klucz_publiczny()).is_err());
    }

    #[test]
    fn podrobiony_dowod_jest_odrzucany() {
        let klucz = KluczTokenow::losuj();
        let proba = oslep();
        let mut ocena = klucz.ocen(&proba.oslepione).unwrap();

        ocena.odpowiedz[0] ^= 1;

        assert!(odslon(&proba, &ocena, &klucz.klucz_publiczny()).is_err());
    }

    /// Token nie może przejść u serwera z innym kluczem — inaczej wystarczyłoby
    /// postawić własną instancję, żeby wydać sobie tokeny do cudzej.
    #[test]
    fn token_nie_dziala_przy_innym_kluczu() {
        let klucz = KluczTokenow::losuj();
        let obcy = KluczTokenow::losuj();

        let proba = oslep();
        let ocena = klucz.ocen(&proba.oslepione).unwrap();
        let token = odslon(&proba, &ocena, &klucz.klucz_publiczny()).unwrap();

        assert!(!obcy.sprawdz(&token.ziarno, &token.odslonione).unwrap());
    }

    /// Klient nie może wydać sobie tokenu z samego klucza publicznego.
    #[test]
    fn zmyslony_token_nie_przechodzi() {
        let klucz = KluczTokenow::losuj();
        let ziarno = [7u8; ZIARNO_LEN];

        // Najbardziej naiwna próba: podstawić sam punkt z odwzorowania.
        let zmyslony = w_grupe(&ziarno).compress().to_bytes();

        assert!(!klucz.sprawdz(&ziarno, &zmyslony).unwrap());
    }

    #[test]
    fn ziarno_o_zlej_dlugosci_jest_odrzucane() {
        let klucz = KluczTokenow::losuj();
        assert!(klucz.sprawdz(&[1, 2, 3], &[0u8; PUNKT_LEN]).is_err());
    }

    #[test]
    fn smieci_nie_powoduja_paniki() {
        let klucz = KluczTokenow::losuj();

        for bajty in [vec![], vec![0xFF; 32], vec![0u8; 31], vec![9u8; 64]] {
            let _ = klucz.ocen(&bajty);
            let _ = klucz.sprawdz(&[0u8; ZIARNO_LEN], &bajty);
            let _ = KluczTokenow::z_bajtow(&bajty);
        }
    }

    #[test]
    fn klucz_przezywa_zapis_i_odczyt() {
        let klucz = KluczTokenow::losuj();
        let odtworzony = KluczTokenow::z_bajtow(&klucz.do_bajtow()).unwrap();

        assert_eq!(klucz.klucz_publiczny(), odtworzony.klucz_publiczny());
    }
}
