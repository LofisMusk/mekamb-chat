//! Tożsamość urządzenia i wyprowadzanie kluczy.
//!
//! # Dlaczego jedno ziarno, a nie kilka kluczy
//!
//! Urządzenie przechowuje **jedno** 32-bajtowe ziarno. Wszystkie klucze
//! powstają z niego przez HKDF-SHA256 z **rozłącznymi etykietami**. Dzięki temu
//! kopia zapasowa tożsamości to 32 bajty, a nie zbiór kluczy do zsynchronizowania.
//!
//! # Dlaczego rozdzielne etykiety, a nie jeden klucz do wszystkiego
//!
//! `NodeId` w iroh oraz klucz podpisu MLS to obie pary Ed25519 i kusi, żeby użyć
//! tej samej. **Nie robimy tego.** Ten sam klucz używany w dwóch protokołach
//! pozwala potencjalnie przenieść podpis z jednego kontekstu do drugiego
//! (cross-protocol attack). Rozdzielenie kosztuje jedno wywołanie HKDF i usuwa
//! całą klasę problemów.
//!
//! Etykiety są wersjonowane. Zmiana schematu wyprowadzania wymaga nowej etykiety,
//! nigdy modyfikacji istniejącej — inaczej starym urządzeniom zmieniłyby się
//! klucze pod ręką.

use hkdf::Hkdf;
use openmls::prelude::{BasicCredential, CredentialWithKey};
use openmls_basic_credential::SignatureKeyPair;
use openmls_traits::types::SignatureScheme;
use rand::{TryRng, rngs::SysRng};
use sha2::Sha256;
use zeroize::{Zeroize, ZeroizeOnDrop};

use crate::error::{Error, Result};

/// Długość ziarna urządzenia w bajtach.
pub const SEED_LEN: usize = 32;

/// Etykieta HKDF dla klucza podpisu MLS.
const LABEL_MLS_SIGNATURE: &[u8] = b"mekamb-chat/v1/mls-signature";

/// Etykieta HKDF dla klucza węzła iroh.
const LABEL_IROH_NODE: &[u8] = b"mekamb-chat/v1/iroh-node";

/// Schemat podpisu używany w całym projekcie.
///
/// Ed25519 jest obowiązkowy w RFC 9420 i pasuje do kluczy węzłów iroh, więc obie
/// warstwy korzystają z tej samej prymitywy — przy rozdzielnych kluczach.
pub const SIGNATURE_SCHEME: SignatureScheme = SignatureScheme::ED25519;

/// Ziarno urządzenia — materiał, z którego powstają wszystkie jego klucze.
///
/// Nigdy nie opuszcza urządzenia inaczej niż przez świadomy eksport tożsamości
/// albo parowanie nowego urządzenia. Czyszczone z pamięci przy porzuceniu.
#[derive(Zeroize, ZeroizeOnDrop)]
pub struct DeviceSeed([u8; SEED_LEN]);

impl std::fmt::Debug for DeviceSeed {
    fn fmt(&self, f: &mut std::fmt::Formatter<'_>) -> std::fmt::Result {
        // Ziarno nie trafia do logów nawet przez przypadkowe `{:?}`.
        f.write_str("DeviceSeed(***)")
    }
}

impl DeviceSeed {
    /// Losuje nowe ziarno z systemowego generatora.
    pub fn generate() -> Self {
        let mut seed = [0u8; SEED_LEN];
        SysRng
            .try_fill_bytes(&mut seed)
            .expect("systemowy generator losowy musi być dostępny");
        Self(seed)
    }

    /// Odtwarza ziarno z bajtów (import kopii zapasowej, parowanie urządzenia).
    pub fn from_bytes(bytes: &[u8]) -> Result<Self> {
        let arr: [u8; SEED_LEN] = bytes.try_into().map_err(|_| Error::InvalidSeedLength {
            expected: SEED_LEN,
            got: bytes.len(),
        })?;
        Ok(Self(arr))
    }

    /// Udostępnia surowe bajty ziarna.
    ///
    /// Wyłącznie do zapisu w zaszyfrowanym magazynie lub eksportu tożsamości.
    /// Nazwa jest celowo krzykliwa — każde wywołanie powinno rzucać się w oczy
    /// przy przeglądzie kodu.
    pub fn expose_secret_bytes(&self) -> &[u8; SEED_LEN] {
        &self.0
    }

    /// Wyprowadza 32 bajty materiału klucza dla podanej etykiety.
    fn derive(&self, label: &[u8]) -> [u8; 32] {
        let hkdf = Hkdf::<Sha256>::new(None, &self.0);
        let mut okm = [0u8; 32];
        hkdf.expand(label, &mut okm)
            .expect("32 bajty mieszczą się w limicie HKDF-SHA256");
        okm
    }

    /// Para kluczy podpisu MLS tego urządzenia.
    ///
    /// Deterministyczna: to samo ziarno zawsze daje ten sam klucz, więc
    /// odtworzenie urządzenia z kopii zapasowej nie zmienia jego tożsamości.
    pub fn mls_signature_keypair(&self) -> SignatureKeyPair {
        let mut secret = self.derive(LABEL_MLS_SIGNATURE);
        let signing_key = ed25519_dalek::SigningKey::from_bytes(&secret);
        let public = signing_key.verifying_key().to_bytes();
        secret.zeroize();

        // OpenMLS przechowuje dla Ed25519 32-bajtowe ziarno jako klucz prywatny
        // i sam rozwija je przy podpisywaniu.
        SignatureKeyPair::from_raw(
            SIGNATURE_SCHEME,
            signing_key.to_bytes().to_vec(),
            public.to_vec(),
        )
    }

    /// 32 bajty klucza tajnego węzła iroh.
    ///
    /// Zwracane jako surowe bajty, żeby rdzeń nie musiał zależeć od `iroh`
    /// — warstwa transportowa buduje z nich `iroh::SecretKey`.
    pub fn iroh_secret_bytes(&self) -> [u8; 32] {
        self.derive(LABEL_IROH_NODE)
    }
}

/// Pełna tożsamość urządzenia: kto (`user_id`), na czym (`device_id`) i czym
/// się podpisuje (ziarno).
#[derive(Debug)]
pub struct DeviceIdentity {
    user_id: String,
    device_id: String,
    seed: DeviceSeed,
}

impl DeviceIdentity {
    /// Tworzy tożsamość dla podanego użytkownika i urządzenia.
    ///
    /// Oba identyfikatory muszą być niepuste i nie zawierać dwukropka, bo ten
    /// jest separatorem w credentialu MLS — dopuszczenie go pozwoliłoby
    /// spreparować `user_id` udający cudzą parę `użytkownik:urządzenie`.
    pub fn new(
        user_id: impl Into<String>,
        device_id: impl Into<String>,
        seed: DeviceSeed,
    ) -> Result<Self> {
        let user_id = user_id.into();
        let device_id = device_id.into();

        for (name, value) in [("user_id", &user_id), ("device_id", &device_id)] {
            if value.is_empty() {
                return Err(Error::InvalidIdentity(format!("{name} nie może być puste")));
            }
            if value.contains(':') {
                return Err(Error::InvalidIdentity(format!(
                    "{name} nie może zawierać dwukropka (jest separatorem credentiala)"
                )));
            }
        }

        Ok(Self {
            user_id,
            device_id,
            seed,
        })
    }

    /// Tworzy zupełnie nową tożsamość z losowym ziarnem.
    pub fn generate(user_id: impl Into<String>, device_id: impl Into<String>) -> Result<Self> {
        Self::new(user_id, device_id, DeviceSeed::generate())
    }

    pub fn user_id(&self) -> &str {
        &self.user_id
    }

    pub fn device_id(&self) -> &str {
        &self.device_id
    }

    pub fn seed(&self) -> &DeviceSeed {
        &self.seed
    }

    /// Kanoniczna postać identyfikatora w credentialu MLS: `user_id:device_id`.
    ///
    /// Odbiorca po odszyfrowaniu wiadomości widzi dokładnie tę wartość i to ona
    /// — a nie jakiekolwiek pole z serwera — jest źródłem prawdy o autorze.
    pub fn credential_identity(&self) -> String {
        format!("{}:{}", self.user_id, self.device_id)
    }

    /// Para kluczy podpisu MLS tego urządzenia.
    pub fn signature_keypair(&self) -> SignatureKeyPair {
        self.seed.mls_signature_keypair()
    }

    /// Credential MLS wraz z kluczem publicznym, gotowy do budowy key package.
    pub fn credential_with_key(&self) -> (CredentialWithKey, SignatureKeyPair) {
        let keypair = self.signature_keypair();
        let credential = BasicCredential::new(self.credential_identity().into_bytes());
        (
            CredentialWithKey {
                credential: credential.into(),
                signature_key: keypair.to_public_vec().into(),
            },
            keypair,
        )
    }
}

/// Rozbija identyfikator credentiala na parę `(user_id, device_id)`.
pub fn parse_credential_identity(raw: &[u8]) -> Result<(String, String)> {
    let text = std::str::from_utf8(raw)
        .map_err(|_| Error::InvalidIdentity("credential nie jest poprawnym UTF-8".into()))?;

    // `split_once` zatrzymuje się na pierwszym dwukropku, a konstruktor zabrania
    // dwukropków w obu polach — więc rozbicie jest jednoznaczne.
    let (user_id, device_id) = text
        .split_once(':')
        .ok_or_else(|| Error::InvalidIdentity("brak separatora w credentialu".into()))?;

    if user_id.is_empty() || device_id.is_empty() || device_id.contains(':') {
        return Err(Error::InvalidIdentity(format!(
            "credential ma nieprawidłowy kształt: {text}"
        )));
    }

    Ok((user_id.to_string(), device_id.to_string()))
}

#[cfg(test)]
mod tests {
    use super::*;

    /// To samo ziarno musi dawać ten sam klucz — inaczej odtworzenie urządzenia
    /// z kopii zapasowej zmieniłoby jego tożsamość i zerwało wszystkie grupy.
    #[test]
    fn wyprowadzanie_kluczy_jest_deterministyczne() {
        let seed = DeviceSeed::from_bytes(&[7u8; SEED_LEN]).unwrap();
        let odtworzone = DeviceSeed::from_bytes(&[7u8; SEED_LEN]).unwrap();

        assert_eq!(
            seed.mls_signature_keypair().to_public_vec(),
            odtworzone.mls_signature_keypair().to_public_vec()
        );
        assert_eq!(seed.iroh_secret_bytes(), odtworzone.iroh_secret_bytes());
    }

    /// Sedno rozdzielenia etykiet: klucz transportowy nie może być równy
    /// kluczowi podpisu.
    #[test]
    fn klucz_mls_i_klucz_iroh_sa_rozne() {
        let seed = DeviceSeed::generate();
        let mls_private = seed.mls_signature_keypair();
        assert_ne!(
            mls_private.public(),
            &seed.iroh_secret_bytes()[..],
            "klucz iroh nie może pokrywać się z kluczem MLS"
        );
        assert_ne!(
            seed.expose_secret_bytes()[..],
            seed.iroh_secret_bytes()[..],
            "klucz pochodny nie może być równy samemu ziarnu"
        );
    }

    #[test]
    fn rozne_ziarna_daja_rozne_klucze() {
        let a = DeviceSeed::generate();
        let b = DeviceSeed::generate();
        assert_ne!(
            a.mls_signature_keypair().to_public_vec(),
            b.mls_signature_keypair().to_public_vec()
        );
    }

    #[test]
    fn ziarno_nie_wycieka_przez_debug() {
        let seed = DeviceSeed::from_bytes(&[0xAB; SEED_LEN]).unwrap();
        let wypisane = format!("{seed:?}");
        assert!(!wypisane.contains("ab"), "Debug nie może ujawniać ziarna");
        assert!(!wypisane.contains("171"));
    }

    #[test]
    fn dwukropek_w_identyfikatorze_jest_odrzucany() {
        let wynik = DeviceIdentity::generate("alice:admin", "telefon");
        assert!(matches!(wynik, Err(Error::InvalidIdentity(_))));
    }

    #[test]
    fn puste_identyfikatory_sa_odrzucane() {
        assert!(DeviceIdentity::generate("", "telefon").is_err());
        assert!(DeviceIdentity::generate("alice", "").is_err());
    }

    #[test]
    fn credential_robi_pelne_kolo() {
        let tozsamosc = DeviceIdentity::generate("alice", "telefon").unwrap();
        let (user, device) =
            parse_credential_identity(tozsamosc.credential_identity().as_bytes()).unwrap();
        assert_eq!(user, "alice");
        assert_eq!(device, "telefon");
    }

    #[test]
    fn nieprawidlowa_dlugosc_ziarna_jest_odrzucana() {
        assert!(matches!(
            DeviceSeed::from_bytes(&[0u8; 16]),
            Err(Error::InvalidSeedLength {
                expected: 32,
                got: 16
            })
        ));
    }
}
