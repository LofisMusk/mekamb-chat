//! Uzgodnienie klucza przy parowaniu drugiego urządzenia.
//!
//! # Każde urządzenie ma własne ziarno
//!
//! Nowe urządzenie NIE kopiuje ziarna starego — ma **własne** i wchodzi do
//! rozmów jako osobny członek, przez zwykły commit MLS. Oba urządzenia działają
//! dalej, równolegle. Współdzielenie jednego ziarna (jednego liścia MLS i
//! jednego ratcheta) rozjechałoby je nieodwracalnie, gdy tylko oba zaczną
//! wysyłać — dlatego parowanie celowo tego nie robi.
//!
//! # Po co tu w ogóle klucz
//!
//! Historii sprzed parowania nie da się dosłać kanałem MLS — nowe urządzenie
//! nie było wtedy w grupie, więc nie ma jak odszyfrować tamtych wiadomości.
//! Idzie więc osobno, transferem optycznym (`optyka`), a ten trzeba zaszyfrować:
//! ktoś, kto sfilmuje ekran nadajnika przez całą transmisję, ma wszystkie ramki.
//!
//! # Dlaczego klucz wychodzi z NOWEGO urządzenia
//!
//! Kierunek jest tu istotny i nie jest dowolny. Kod z kluczem publicznym
//! pokazuje **nowe** urządzenie, a stare go skanuje. Filmujący ekran starego
//! urządzenia — tego, które nadaje historię — nie widział tamtego kodu, więc
//! nie zna sekretu i strumień jest dla niego bezużyteczny.
//!
//! Odwrotny kierunek, czyli klucz wysyłany razem ze strumieniem, nie dawałby
//! nic: kto ma ramki, ten miałby i klucz.

use hkdf::Hkdf;
use rand::{TryRng, rngs::SysRng};
use sha2::Sha256;
use x25519_dalek::{PublicKey, StaticSecret};
use zeroize::Zeroize;

use crate::error::{Error, Result};

/// Etykieta wyprowadzenia klucza transferu.
///
/// Rozłączna z etykietami z `identity.rs`, tak jak każda inna: ten sam materiał
/// wejściowy pod dwiema etykietami daje dwa niezwiązane klucze, a wspólna
/// etykieta wiązałaby ze sobą rzeczy, które nie mają nic wspólnego.
const ETYKIETA_TRANSFERU: &[u8] = b"mekamb-chat/v1/parowanie-transfer";

/// Efemeryczna para kluczy nowego urządzenia.
///
/// Żyje tyle, co jedno parowanie. Nie ma nic wspólnego z ziarnem tożsamości
/// i nigdzie się nie zapisuje — przerwane parowanie ma zostawić po sobie
/// nieużyteczny kod, a nie sekret leżący w skarbcu.
pub struct ParaParowania {
    sekret: StaticSecret,
}

impl ParaParowania {
    /// Losuje nową parę.
    pub fn nowa() -> Result<Self> {
        let mut bajty = [0u8; 32];
        SysRng
            .try_fill_bytes(&mut bajty)
            .map_err(|_| Error::InvalidInput("brak źródła losowości".into()))?;

        let sekret = StaticSecret::from(bajty);
        bajty.zeroize();

        Ok(ParaParowania { sekret })
    }

    /// Klucz publiczny — to on jedzie w kodzie QR.
    pub fn publiczny(&self) -> [u8; 32] {
        PublicKey::from(&self.sekret).to_bytes()
    }

    /// Uzgadnia klucz transferu z kluczem publicznym drugiej strony.
    ///
    /// Surowy wynik X25519 **nie jest** kluczem: ma nierównomierny rozkład
    /// i zależy od krzywej. Przepuszczamy go przez HKDF, tak samo jak każdy
    /// inny materiał kluczowy w tym projekcie.
    pub fn klucz_transferu(&self, obcy_publiczny: &[u8]) -> Result<[u8; 32]> {
        let obcy: [u8; 32] = obcy_publiczny
            .try_into()
            .map_err(|_| Error::InvalidInput("klucz publiczny musi mieć 32 bajty".into()))?;

        let mut wspolny = self
            .sekret
            .diffie_hellman(&PublicKey::from(obcy))
            .to_bytes();

        // Klucz o samych zerach znaczy punkt małego rzędu po drugiej stronie —
        // podstawiony po to, żeby wymusić przewidywalny sekret. To jedyny
        // wynik X25519, który wolno odrzucić, i trzeba to zrobić jawnie.
        if wspolny.iter().all(|&b| b == 0) {
            wspolny.zeroize();
            return Err(Error::MessageRejected);
        }

        let hkdf = Hkdf::<Sha256>::new(None, &wspolny);
        wspolny.zeroize();

        let mut klucz = [0u8; 32];
        hkdf.expand(ETYKIETA_TRANSFERU, &mut klucz)
            .map_err(|_| Error::InvalidInput("nie udało się wyprowadzić klucza".into()))?;

        Ok(klucz)
    }
}

#[cfg(test)]
mod tests {
    use super::*;

    /// Podstawa: obie strony muszą dojść do tego samego klucza.
    #[test]
    fn obie_strony_uzgadniaja_ten_sam_klucz() {
        let nowe = ParaParowania::nowa().unwrap();
        let stare = ParaParowania::nowa().unwrap();

        let u_nowego = nowe.klucz_transferu(&stare.publiczny()).unwrap();
        let u_starego = stare.klucz_transferu(&nowe.publiczny()).unwrap();

        assert_eq!(u_nowego, u_starego);
    }

    /// Ktoś, kto sfilmował ekran, ale nie widział kodu z nowego urządzenia,
    /// ma dojść do innego klucza — na tym stoi cała ochrona transferu.
    #[test]
    fn obcy_nie_trafia_w_ten_sam_klucz() {
        let nowe = ParaParowania::nowa().unwrap();
        let stare = ParaParowania::nowa().unwrap();
        let podgladacz = ParaParowania::nowa().unwrap();

        let prawdziwy = stare.klucz_transferu(&nowe.publiczny()).unwrap();
        let podrobiony = stare.klucz_transferu(&podgladacz.publiczny()).unwrap();

        assert_ne!(prawdziwy, podrobiony);
    }

    #[test]
    fn kazde_parowanie_ma_inny_klucz() {
        let stare = ParaParowania::nowa().unwrap();

        let pierwsze = ParaParowania::nowa().unwrap();
        let drugie = ParaParowania::nowa().unwrap();

        assert_ne!(
            stare.klucz_transferu(&pierwsze.publiczny()).unwrap(),
            stare.klucz_transferu(&drugie.publiczny()).unwrap(),
        );
    }

    #[test]
    fn klucz_zlej_dlugosci_jest_odrzucany() {
        let para = ParaParowania::nowa().unwrap();

        assert!(para.klucz_transferu(&[0u8; 31]).is_err());
        assert!(para.klucz_transferu(&[]).is_err());
    }

    /// Punkt małego rzędu daje wspólny sekret z samych zer — atakujący
    /// wymusiłby wtedy klucz, który zna z góry.
    #[test]
    fn punkt_malego_rzedu_jest_odrzucany() {
        let para = ParaParowania::nowa().unwrap();

        assert!(para.klucz_transferu(&[0u8; 32]).is_err());
    }
}
