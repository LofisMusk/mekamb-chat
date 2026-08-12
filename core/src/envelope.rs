//! Koperta transportowa — zewnętrzna warstwa routingu.
//!
//! # Co jest, a co nie jest zaszyfrowane
//!
//! Koperta jest **na zewnątrz** szyfrowania MLS. Jej `payload` to gotowa
//! wiadomość MLS, nieczytelna dla nikogo poza grupą.
//!
//! # Dlaczego nie ma tu identyfikatora rozmowy
//!
//! Bo był jawny, a serwer widzi każdą kopertę idącą przez skrzynkę. Dwie
//! koperty z tym samym `group_id` mówiły mu „to ta sama rozmowa" — czyli
//! pozwalały zbudować graf rozmów bez odszyfrowania choćby bajtu treści.
//! Wystarczyło do tego samo patrzenie na ruch.
//!
//! Zamiast identyfikatora koperta niesie **sól** i **znacznik**:
//!
//! ```text
//! klucz    = HKDF(group_id, "…/koperta-routing")
//! znacznik = HKDF-with-salt(sól, klucz, "…/koperta-znacznik")
//! ```
//!
//! Sól jest losowa dla każdej koperty, więc znacznik **za każdym razem jest
//! inny** — dwie koperty tej samej rozmowy są dla serwera nie do powiązania.
//! Odbiorca liczy znacznik dla każdej swojej rozmowy i porównuje; przy
//! kilkudziesięciu rozmowach to kilkadziesiąt HKDF-ów na kopertę, czyli koszt
//! niemierzalny wobec samego deszyfrowania MLS.
//!
//! Klucz wyprowadzamy z `group_id`, bo to jedyna wartość, którą **znają
//! wszyscy członkowie i nie zna jej serwer** — pod warunkiem że nigdzie mu jej
//! nie pokazujemy. Dlatego `GroupRelay` nazywa się osobno wyprowadzonym
//! [`identyfikator_relaya`], a nie surowym `group_id`: z niego nie da się
//! wrócić do klucza routingu.
//!
//! # Czego to nie ukrywa
//!
//! Rodzaju koperty (`kind`) — odbiorca musi wiedzieć, czy to zaproszenie do
//! nowej rozmowy, zanim będzie miał czym cokolwiek dopasować. Serwer widzi
//! więc, że ktoś kogoś właśnie dodaje do grupy, choć nie wie do której.
//!
//! Nie ukrywa też, kto do czyjej skrzynki nadaje — to osobna sprawa i osobny
//! mechanizm. Patrz `docs/THREAT_MODEL.md`.

use hkdf::Hkdf;
use rand::{TryRng, rngs::SysRng};
use sha2::Sha256;

use crate::error::{Error, Result};

/// Wersja formatu koperty.
///
/// 2 zastąpiła jawny `group_id` parą sól/znacznik. Wersji 1 **nie umiemy już
/// czytać** i jest to świadome: koperta v1 zdradza rozmowę, więc przyjmowanie
/// jej dalej znaczyłoby, że wystarczy ją podrobić, żeby wyciek wrócił.
pub const ENVELOPE_VERSION: u32 = 2;

/// Górny limit rozmiaru koperty.
///
/// Bez limitu peer mógłby zestawić strumień i wysyłać w nieskończoność,
/// wyczerpując pamięć odbiorcy. Duże pliki idą osobnym kanałem (R2 albo własny
/// strumień), a nie w kopercie wiadomości.
pub const MAX_ENVELOPE_BYTES: usize = 1024 * 1024;

/// Długość soli. 16 bajtów wystarcza, żeby powtórzenie było nierealne.
pub const SOL_LEN: usize = 16;

/// Długość znacznika.
///
/// 16 bajtów: zgadnięcie znacznika bez klucza to 2⁻¹²⁸, a każdy dodatkowy bajt
/// to bajt doklejony do każdej koperty.
pub const ZNACZNIK_LEN: usize = 16;

/// Etykieta klucza routingu. **Zamrożona** — zmiana odcina wszystkie urządzenia
/// od rozmów, bo przestałyby rozpoznawać własne koperty.
const LABEL_ROUTING: &[u8] = b"mekamb-chat/v1/koperta-routing";

/// Etykieta znacznika. Zamrożona z tego samego powodu.
const LABEL_ZNACZNIK: &[u8] = b"mekamb-chat/v1/koperta-znacznik";

/// Etykieta nazwy obiektu porządkującego epoki. Zamrożona: zmiana rozdzieliłaby
/// grupę na dwa niezależne liczniki epok.
const LABEL_RELAY: &[u8] = b"mekamb-chat/v1/relay";

/// Wyprowadza klucz routingu rozmowy.
///
/// Sekret w tym sensie, że serwer go nie zna — bo nie zna `group_id`.
fn klucz_routingu(group_id: &[u8]) -> [u8; 32] {
    let mut klucz = [0u8; 32];
    Hkdf::<Sha256>::new(None, group_id)
        .expand(LABEL_ROUTING, &mut klucz)
        .expect("32 bajty mieszczą się w wyjściu HKDF-SHA256");
    klucz
}

/// Liczy znacznik dla danej soli.
fn znacznik(klucz: &[u8; 32], sol: &[u8]) -> [u8; ZNACZNIK_LEN] {
    let mut wynik = [0u8; ZNACZNIK_LEN];
    Hkdf::<Sha256>::new(Some(sol), klucz)
        .expand(LABEL_ZNACZNIK, &mut wynik)
        .expect("16 bajtów mieści się w wyjściu HKDF-SHA256");
    wynik
}

/// Nazwa obiektu porządkującego epoki dla tej rozmowy.
///
/// Osobne wyprowadzenie, nie `group_id`: serwer widzi tę wartość w adresie
/// żądania, a z niej nie da się wrócić do klucza routingu. Gdyby relay nazywał
/// się surowym identyfikatorem, serwer mógłby policzyć znaczniki sam i cała
/// reszta tego modułu nie dawałaby nic.
pub fn identyfikator_relaya(group_id: &[u8]) -> String {
    let mut wynik = [0u8; 16];
    Hkdf::<Sha256>::new(None, group_id)
        .expand(LABEL_RELAY, &mut wynik)
        .expect("16 bajtów mieści się w wyjściu HKDF-SHA256");
    hex::encode(wynik)
}

/// Rodzaj przenoszonej wiadomości MLS.
///
/// Rozróżnienie jest istotne, bo commity i wiadomości aplikacyjne idą różnymi
/// drogami: commity wymagają autorytatywnej kolejności z `GroupRelay`,
/// wiadomości nie.
#[derive(Clone, Copy, Debug, PartialEq, Eq, prost::Enumeration)]
#[repr(i32)]
pub enum EnvelopeKind {
    Unspecified = 0,
    /// Wiadomość aplikacyjna — może iść bezpośrednio P2P.
    Application = 1,
    /// Commit zmieniający epokę — wymaga kolejności z `GroupRelay`.
    Commit = 2,
    /// Welcome dla nowo dodanego członka.
    Welcome = 3,
}

#[derive(Clone, PartialEq, prost::Message)]
pub struct Envelope {
    #[prost(uint32, tag = "1")]
    pub version: u32,

    /// Losowa sól tej koperty. Inna dla każdej — stąd niepowiązywalność.
    #[prost(bytes = "vec", tag = "2")]
    pub sol: Vec<u8>,

    #[prost(enumeration = "EnvelopeKind", tag = "3")]
    pub kind: i32,

    /// Zserializowana wiadomość MLS. Nieczytelna poza grupą.
    #[prost(bytes = "vec", tag = "4")]
    pub payload: Vec<u8>,

    /// Znacznik rozmowy liczony z soli i klucza routingu.
    ///
    /// Pusty przy `Welcome`: odbiorca nie zna jeszcze rozmowy, więc nie ma czym
    /// dopasowywać — musi po prostu spróbować przetworzyć zaproszenie.
    #[prost(bytes = "vec", tag = "5")]
    pub znacznik: Vec<u8>,
}

impl Envelope {
    /// Buduje kopertę zaadresowaną do rozmowy.
    ///
    /// `Welcome` idzie bez znacznika — patrz [`Envelope::znacznik`].
    pub fn new(group_id: &[u8], kind: EnvelopeKind, payload: Vec<u8>) -> Self {
        let mut sol = [0u8; SOL_LEN];
        SysRng
            .try_fill_bytes(&mut sol)
            .expect("systemowy generator losowy musi być dostępny");

        let znacznik = if kind == EnvelopeKind::Welcome {
            Vec::new()
        } else {
            znacznik(&klucz_routingu(group_id), &sol).to_vec()
        };

        Self {
            version: ENVELOPE_VERSION,
            sol: sol.to_vec(),
            kind: kind as i32,
            payload,
            znacznik,
        }
    }

    /// Czy ta koperta należy do podanej rozmowy.
    ///
    /// Porównanie jest w czasie stałym. Nie dlatego, że wyciek czasu zdradziłby
    /// tu treść — tylko dlatego, że zdradzałby, KTÓRA rozmowa pasuje, komuś kto
    /// umie mierzyć czas przetwarzania. To dokładnie ta informacja, którą ten
    /// moduł ukrywa.
    pub fn pasuje_do(&self, group_id: &[u8]) -> bool {
        if self.znacznik.len() != ZNACZNIK_LEN {
            return false;
        }

        let oczekiwany = znacznik(&klucz_routingu(group_id), &self.sol);

        let mut roznica = 0u8;
        for (a, b) in oczekiwany.iter().zip(&self.znacznik) {
            roznica |= a ^ b;
        }
        roznica == 0
    }

    pub fn encode_to_vec(&self) -> Vec<u8> {
        prost::Message::encode_to_vec(self)
    }

    /// Parsuje kopertę odebraną z sieci.
    ///
    /// Dane wejściowe są wrogie z założenia — każdy błąd kończy się `Err`,
    /// nigdy paniką.
    pub fn decode(bytes: &[u8]) -> Result<Self> {
        if bytes.len() > MAX_ENVELOPE_BYTES {
            return Err(Error::Framing(format!(
                "koperta ma {} bajtów, limit to {MAX_ENVELOPE_BYTES}",
                bytes.len()
            )));
        }

        let envelope = <Self as prost::Message>::decode(bytes)
            .map_err(|e| Error::Framing(format!("nie udało się zdekodować koperty: {e}")))?;

        if envelope.version != ENVELOPE_VERSION {
            return Err(Error::Framing(format!(
                "nieobsługiwana wersja koperty: {} (obsługiwana: {ENVELOPE_VERSION})",
                envelope.version
            )));
        }

        // `Unspecified` odrzucamy jawnie — oznacza albo uszkodzenie, albo rodzaj
        // z nowszej wersji protokołu, którego nie umiemy poprawnie skierować.
        if envelope.kind() == EnvelopeKind::Unspecified {
            return Err(Error::Framing("koperta z nierozpoznanym rodzajem".into()));
        }

        if envelope.sol.len() != SOL_LEN {
            return Err(Error::Framing(format!(
                "sól ma {} bajtów, oczekiwano {SOL_LEN}",
                envelope.sol.len()
            )));
        }

        // Welcome nie ma znacznika i nie może go mieć: odbiorca nie zna jeszcze
        // rozmowy. Każdy inny rodzaj bez znacznika byłby kopertą, której nie da
        // się skierować — i próbą przemycenia jej do dowolnej rozmowy.
        let wymagany = envelope.kind() != EnvelopeKind::Welcome;
        if wymagany && envelope.znacznik.len() != ZNACZNIK_LEN {
            return Err(Error::Framing(format!(
                "znacznik ma {} bajtów, oczekiwano {ZNACZNIK_LEN}",
                envelope.znacznik.len()
            )));
        }

        Ok(envelope)
    }
}

#[cfg(test)]
mod tests {
    use super::*;

    const GRUPA: &[u8] = b"grupa-1";
    const INNA: &[u8] = b"grupa-2";

    #[test]
    fn koperta_robi_pelne_kolo() {
        let oryginal = Envelope::new(GRUPA, EnvelopeKind::Application, vec![1, 2, 3]);
        let odtworzona = Envelope::decode(&oryginal.encode_to_vec()).unwrap();

        assert_eq!(odtworzona, oryginal);
        assert_eq!(odtworzona.kind(), EnvelopeKind::Application);
        assert_eq!(odtworzona.payload, vec![1, 2, 3]);
    }

    /// Sedno: koperta nie może nieść identyfikatora rozmowy w postaci jawnej.
    ///
    /// Serwer widzi każdą kopertę idącą przez skrzynkę. Jawny identyfikator
    /// pozwalał mu zbudować graf rozmów bez odszyfrowania choćby bajtu treści.
    #[test]
    fn identyfikator_rozmowy_nie_wychodzi_w_kopercie() {
        let bajty = Envelope::new(GRUPA, EnvelopeKind::Application, vec![7]).encode_to_vec();

        assert!(
            !bajty.windows(GRUPA.len()).any(|okno| okno == GRUPA),
            "identyfikator rozmowy nie może pojawić się w bajtach koperty",
        );
    }

    /// Sedno: dwie koperty tej samej rozmowy mają być dla serwera nie do powiązania.
    #[test]
    fn dwie_koperty_tej_samej_rozmowy_wygladaja_inaczej() {
        let a = Envelope::new(GRUPA, EnvelopeKind::Application, vec![1]);
        let b = Envelope::new(GRUPA, EnvelopeKind::Application, vec![1]);

        assert_ne!(a.sol, b.sol);
        assert_ne!(a.znacznik, b.znacznik);
    }

    #[test]
    fn wlasna_rozmowa_sie_dopasowuje() {
        let koperta = Envelope::new(GRUPA, EnvelopeKind::Application, vec![]);

        assert!(koperta.pasuje_do(GRUPA));
        assert!(!koperta.pasuje_do(INNA));
    }

    #[test]
    fn dopasowanie_przezywa_pelne_kolo() {
        let bajty = Envelope::new(GRUPA, EnvelopeKind::Commit, vec![9]).encode_to_vec();
        let odtworzona = Envelope::decode(&bajty).unwrap();

        assert!(odtworzona.pasuje_do(GRUPA));
        assert!(!odtworzona.pasuje_do(INNA));
    }

    /// Welcome nie ma znacznika: odbiorca nie zna jeszcze rozmowy, więc nie ma
    /// czym dopasowywać.
    #[test]
    fn welcome_idzie_bez_znacznika() {
        let koperta = Envelope::new(GRUPA, EnvelopeKind::Welcome, vec![1]);

        assert!(koperta.znacznik.is_empty());
        assert!(Envelope::decode(&koperta.encode_to_vec()).is_ok());
        // Nie da się go dopasować do niczego — i o to chodzi.
        assert!(!koperta.pasuje_do(GRUPA));
    }

    /// Koperta bez znacznika, ale podana jako zwykła wiadomość, to próba
    /// przemycenia ładunku do dowolnej rozmowy.
    #[test]
    fn brak_znacznika_poza_welcome_jest_odrzucany() {
        let mut koperta = Envelope::new(GRUPA, EnvelopeKind::Application, vec![1]);
        koperta.znacznik.clear();

        assert!(Envelope::decode(&koperta.encode_to_vec()).is_err());
    }

    #[test]
    fn zla_dlugosc_soli_jest_odrzucana() {
        let mut koperta = Envelope::new(GRUPA, EnvelopeKind::Application, vec![1]);
        koperta.sol = vec![1, 2, 3];

        assert!(Envelope::decode(&koperta.encode_to_vec()).is_err());
    }

    #[test]
    fn obca_wersja_jest_odrzucana() {
        let mut koperta = Envelope::new(GRUPA, EnvelopeKind::Commit, vec![]);
        koperta.version = 1;
        assert!(Envelope::decode(&koperta.encode_to_vec()).is_err());
    }

    #[test]
    fn nierozpoznany_rodzaj_jest_odrzucany() {
        let koperta = Envelope::new(GRUPA, EnvelopeKind::Unspecified, vec![]);
        assert!(Envelope::decode(&koperta.encode_to_vec()).is_err());
    }

    /// Sedno: z nazwy widzianej przez serwer nie może dać się policzyć znacznika.
    ///
    /// Gdyby relay nazywał się surowym `group_id`, serwer wyprowadziłby klucz
    /// routingu sam i cały ten moduł nie dawałby nic.
    #[test]
    fn nazwa_relaya_nie_zdradza_identyfikatora() {
        let nazwa = identyfikator_relaya(GRUPA);

        assert_ne!(nazwa, hex::encode(GRUPA));
        assert_eq!(
            nazwa,
            identyfikator_relaya(GRUPA),
            "musi być deterministyczna"
        );
        assert_ne!(nazwa, identyfikator_relaya(INNA));
    }

    #[test]
    fn smieci_nie_powoduja_paniki() {
        for bajty in [vec![], vec![0xFF; 64], vec![0x08], vec![0x22, 0xFF]] {
            let _ = Envelope::decode(&bajty);
        }
    }
}
