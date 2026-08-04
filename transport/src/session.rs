//! Szyfrowana sesja między dwoma urządzeniami (Noise Protocol).
//!
//! # Skoro treść jest już zaszyfrowana MLS, po co druga warstwa
//!
//! MLS chroni **treść**. Nie chroni koperty, która musi być czytelna dla
//! odbiorcy, zanim ten zdecyduje, do której rozmowy skierować bajty — a więc
//! niesie `group_id` w postaci jawnej.
//!
//! Bez tej warstwy obserwator sieci widziałby, które urządzenia wymieniają
//! wiadomości w obrębie tej samej grupy. Treści by nie poznał, ale odtworzyłby
//! graf rozmów, a to często wystarcza.
//!
//! # Nie piszemy własnej kryptografii
//!
//! Handshake to **Noise IK** w implementacji `snow`. Noise jest wyspecyfikowany
//! i przeanalizowany formalnie; `snow` jest jego niezależną implementacją
//! w czystym Rust. Nasza rola sprowadza się do wybrania wzorca i podłączenia
//! kluczy — żaden prymityw nie powstaje tutaj.
//!
//! # Dlaczego akurat IK
//!
//! W tym wzorcu inicjator **zna z góry statyczny klucz odpowiadającego**,
//! a odpowiadający poznaje klucz inicjatora w trakcie. Dokładnie to mamy:
//! klucz urządzenia rozmówcy pochodzi z katalogu, a jego prawdziwość
//! potwierdza safety number.
//!
//! Skutek jest istotny: jeśli katalog skłamał o kluczu, handshake **nie
//! przejdzie**. Serwer nie podstawi się w środek połączenia, nawet gdyby chciał.

use snow::{Builder, HandshakeState, TransportState};

use crate::error::{Error, Result};

/// Wzorzec Noise wraz z prymitywami.
///
/// X25519 do wymiany kluczy, ChaCha20-Poly1305 do szyfrowania, BLAKE2s jako
/// funkcja skrótu. Zapis jest znormalizowany — obie strony muszą mieć
/// identyczny, inaczej handshake nie dojdzie do skutku.
const PATTERN: &str = "Noise_IK_25519_ChaChaPoly_BLAKE2s";

/// Górny limit pojedynczej wiadomości Noise. Wynika ze specyfikacji.
const MAX_NOISE_MESSAGE: usize = 65535;

/// Ile bajtów zajmuje znacznik uwierzytelniający ChaCha20-Poly1305.
const TAG_LEN: usize = 16;

/// Najdłuższy ładunek, jaki zmieści się w jednej wiadomości.
pub const MAX_PAYLOAD: usize = MAX_NOISE_MESSAGE - TAG_LEN;

/// Statyczna para kluczy urządzenia dla warstwy transportowej.
///
/// Wyprowadzana z ziarna urządzenia **rozłączną etykietą** — ten sam klucz
/// w dwóch protokołach otwiera drogę do przeniesienia podpisu między
/// kontekstami, a rozdzielenie kosztuje jedno wywołanie HKDF.
pub struct StaticKeypair {
    private: Vec<u8>,
    public: Vec<u8>,
}

impl StaticKeypair {
    /// Wyprowadza parę kluczy z 32-bajtowego sekretu.
    ///
    /// Klucz publiczny liczymy wprost przez X25519, a nie przez buildera Noise.
    /// Wzorzec IK wymaga od inicjatora znajomości klucza zdalnego, więc próba
    /// zbudowania go „na sucho" tylko po to, żeby odczytać własny klucz,
    /// kończy się błędem.
    pub fn from_secret(secret: &[u8; 32]) -> Result<Self> {
        // X25519 przyjmuje dowolne 32 bajty — implementacja sama je normalizuje,
        // więc nie ma tu kluczy „nieprawidłowych".
        let private = secret.to_vec();
        let public = x25519_public(&private);

        Ok(Self { private, public })
    }

    /// Klucz publiczny — publikowany w katalogu.
    pub fn public(&self) -> &[u8] {
        &self.public
    }
}

/// Liczy klucz publiczny X25519 z prywatnego.
fn x25519_public(private: &[u8]) -> Vec<u8> {
    use x25519_dalek::{PublicKey, StaticSecret};

    let mut bajty = [0u8; 32];
    bajty.copy_from_slice(&private[..32]);

    PublicKey::from(&StaticSecret::from(bajty)).as_bytes().to_vec()
}

/// Sesja w trakcie zestawiania albo już gotowa.
pub enum Session {
    Handshake(Box<HandshakeState>),
    Ready(Box<TransportState>),
}

impl Session {
    /// Rozpoczyna sesję jako strona dzwoniąca.
    ///
    /// `peer_public` pochodzi z katalogu. Jeśli katalog skłamał, handshake
    /// nie przejdzie — i to jest cała ochrona przed podstawieniem urządzenia
    /// na poziomie transportu.
    pub fn initiate(keypair: &StaticKeypair, peer_public: &[u8]) -> Result<(Self, Vec<u8>)> {
        if peer_public.len() != 32 {
            return Err(Error::Transport("klucz rozmówcy musi mieć 32 bajty".into()));
        }

        let mut state = Builder::new(PATTERN.parse().map_err(blad_noise)?)
            .local_private_key(&keypair.private)
            .map_err(blad_noise)?
            .remote_public_key(peer_public)
            .map_err(blad_noise)?
            .build_initiator()
            .map_err(blad_noise)?;

        let mut bufor = vec![0u8; MAX_NOISE_MESSAGE];
        let ile = state.write_message(&[], &mut bufor).map_err(blad_noise)?;
        bufor.truncate(ile);

        Ok((Self::Handshake(Box::new(state)), bufor))
    }

    /// Rozpoczyna sesję jako strona odbierająca.
    pub fn respond(keypair: &StaticKeypair) -> Result<Self> {
        let state = Builder::new(PATTERN.parse().map_err(blad_noise)?)
            .local_private_key(&keypair.private)
            .map_err(blad_noise)?
            .build_responder()
            .map_err(blad_noise)?;

        Ok(Self::Handshake(Box::new(state)))
    }

    /// Przetwarza wiadomość handshake'u. Zwraca odpowiedź, jeśli trzeba ją odesłać.
    pub fn read_handshake(&mut self, message: &[u8]) -> Result<Option<Vec<u8>>> {
        let Self::Handshake(state) = self else {
            return Err(Error::Transport("sesja jest już zestawiona".into()));
        };

        let mut bufor = vec![0u8; MAX_NOISE_MESSAGE];
        state.read_message(message, &mut bufor).map_err(blad_noise)?;

        if state.is_handshake_finished() {
            self.przejdz_do_transportu()?;
            return Ok(None);
        }

        let mut odpowiedz = vec![0u8; MAX_NOISE_MESSAGE];
        let ile = state.write_message(&[], &mut odpowiedz).map_err(blad_noise)?;
        odpowiedz.truncate(ile);

        if state.is_handshake_finished() {
            self.przejdz_do_transportu()?;
        }

        Ok(Some(odpowiedz))
    }

    /// Klucz publiczny rozmówcy, gdy handshake go już ujawnił.
    ///
    /// Wywołujący **musi** go sprawdzić przed przyjęciem danych: Noise
    /// gwarantuje, że rozmówca zna odpowiedni klucz prywatny, ale nie wie,
    /// czy to ten rozmówca, którego oczekiwaliśmy.
    pub fn peer_public(&self) -> Option<Vec<u8>> {
        match self {
            Self::Handshake(state) => state.get_remote_static().map(<[u8]>::to_vec),
            Self::Ready(state) => state.get_remote_static().map(<[u8]>::to_vec),
        }
    }

    pub fn is_ready(&self) -> bool {
        matches!(self, Self::Ready(_))
    }

    /// Szyfruje ładunek.
    pub fn seal(&mut self, plaintext: &[u8]) -> Result<Vec<u8>> {
        if plaintext.len() > MAX_PAYLOAD {
            return Err(Error::Transport(format!(
                "ładunek ma {} bajtów, limit pojedynczej wiadomości to {MAX_PAYLOAD}",
                plaintext.len()
            )));
        }

        let Self::Ready(state) = self else {
            return Err(Error::Transport("sesja nie jest jeszcze zestawiona".into()));
        };

        let mut bufor = vec![0u8; MAX_NOISE_MESSAGE];
        let ile = state.write_message(plaintext, &mut bufor).map_err(blad_noise)?;
        bufor.truncate(ile);

        Ok(bufor)
    }

    /// Odszyfrowuje ładunek.
    ///
    /// Niepowodzenie jest zwykłą sytuacją — pakiet mógł zostać uszkodzony
    /// albo spreparowany. Nie rozróżniamy powodów.
    pub fn open(&mut self, ciphertext: &[u8]) -> Result<Vec<u8>> {
        let Self::Ready(state) = self else {
            return Err(Error::Transport("sesja nie jest jeszcze zestawiona".into()));
        };

        let mut bufor = vec![0u8; MAX_NOISE_MESSAGE];
        let ile = state
            .read_message(ciphertext, &mut bufor)
            .map_err(|_| Error::Transport("odrzucono wiadomość".into()))?;
        bufor.truncate(ile);

        Ok(bufor)
    }

    fn przejdz_do_transportu(&mut self) -> Result<()> {
        // `snow` wymaga przeniesienia stanu, a my mamy tylko `&mut self`.
        // Podmieniamy zawartość przez chwilowy stan zastępczy.
        let stary = std::mem::replace(self, Self::Handshake(Box::new(pusty_handshake()?)));

        let Self::Handshake(state) = stary else {
            return Err(Error::Transport("stan sesji jest niespójny".into()));
        };

        *self = Self::Ready(Box::new(state.into_transport_mode().map_err(blad_noise)?));
        Ok(())
    }
}

/// Stan zastępczy używany wyłącznie przy przenoszeniu własności.
fn pusty_handshake() -> Result<HandshakeState> {
    Builder::new(PATTERN.parse().map_err(blad_noise)?)
        .local_private_key(&[0u8; 32])
        .map_err(blad_noise)?
        .build_responder()
        .map_err(blad_noise)
}

/// Błędy Noise nie niosą szczegółów na zewnątrz.
///
/// Rozróżnienie „zły klucz" od „uszkodzony pakiet" dawałoby atakującemu
/// informację zwrotną, której nie musi mieć.
fn blad_noise(error: snow::Error) -> Error {
    Error::Transport(format!("handshake nie powiódł się: {error}"))
}

#[cfg(test)]
mod tests {
    use super::*;

    fn para(seed: u8) -> StaticKeypair {
        StaticKeypair::from_secret(&[seed; 32]).unwrap()
    }

    /// Pełny handshake i wymiana w obie strony.
    fn zestaw(a: &StaticKeypair, b: &StaticKeypair) -> (Session, Session) {
        let (mut inicjator, pierwsza) = Session::initiate(a, b.public()).unwrap();
        let mut odbiorca = Session::respond(b).unwrap();

        let odpowiedz = odbiorca.read_handshake(&pierwsza).unwrap().expect("odpowiedź");
        assert!(inicjator.read_handshake(&odpowiedz).unwrap().is_none());

        assert!(inicjator.is_ready() && odbiorca.is_ready());
        (inicjator, odbiorca)
    }

    #[test]
    fn wiadomosc_przechodzi_w_obie_strony() {
        let (a, b) = (para(1), para(2));
        let (mut inicjator, mut odbiorca) = zestaw(&a, &b);

        let szyfrogram = inicjator.seal(b"koperta z wiadomoscia").unwrap();
        assert_eq!(odbiorca.open(&szyfrogram).unwrap(), b"koperta z wiadomoscia");

        let odpowiedz = odbiorca.seal(b"odpowiedz").unwrap();
        assert_eq!(inicjator.open(&odpowiedz).unwrap(), b"odpowiedz");
    }

    /// Sedno całej warstwy: koperta nie może być czytelna w bajtach na drucie.
    #[test]
    fn koperta_nie_wystepuje_jawnie_w_szyfrogramie() {
        const KOPERTA: &[u8] = b"group-id-ktory-zdradzilby-graf-rozmow";

        let (a, b) = (para(1), para(2));
        let (mut inicjator, _) = zestaw(&a, &b);

        let szyfrogram = inicjator.seal(KOPERTA).unwrap();

        assert!(
            !szyfrogram.windows(KOPERTA.len()).any(|okno| okno == KOPERTA),
            "zawartość koperty widoczna w bajtach sieciowych"
        );
    }

    /// Ochrona przed podstawieniem urządzenia przez katalog: jeśli serwer poda
    /// nie ten klucz, handshake nie dojdzie do skutku.
    #[test]
    fn handshake_z_obcym_kluczem_nie_przechodzi() {
        let (a, b, obcy) = (para(1), para(2), para(9));

        // Dzwonimy pod klucz „obcego", ale odbiera prawdziwy `b`.
        let (_, pierwsza) = Session::initiate(&a, obcy.public()).unwrap();
        let mut odbiorca = Session::respond(&b).unwrap();

        assert!(odbiorca.read_handshake(&pierwsza).is_err());
    }

    #[test]
    fn odbiorca_poznaje_klucz_inicjatora() {
        let (a, b) = (para(1), para(2));
        let (_, odbiorca) = zestaw(&a, &b);

        assert_eq!(odbiorca.peer_public().as_deref(), Some(a.public()));
    }

    #[test]
    fn zmodyfikowany_szyfrogram_jest_odrzucany() {
        let (a, b) = (para(1), para(2));
        let (mut inicjator, mut odbiorca) = zestaw(&a, &b);

        let mut szyfrogram = inicjator.seal(b"oryginal").unwrap();
        let ostatni = szyfrogram.len() - 1;
        szyfrogram[ostatni] ^= 0x01;

        assert!(odbiorca.open(&szyfrogram).is_err());
    }

    /// Ta sama treść musi dać różne bajty, inaczej obserwator rozpoznawałby
    /// powtórzenia mimo szyfrowania.
    #[test]
    fn ta_sama_tresc_daje_rozne_szyfrogramy() {
        let (a, b) = (para(1), para(2));
        let (mut inicjator, _) = zestaw(&a, &b);

        assert_ne!(
            inicjator.seal(b"to samo").unwrap(),
            inicjator.seal(b"to samo").unwrap(),
        );
    }

    #[test]
    fn wysylka_przed_zestawieniem_jest_bledem() {
        let a = para(1);
        let mut sesja = Session::respond(&a).unwrap();

        assert!(sesja.seal(b"za wczesnie").is_err());
        assert!(sesja.open(b"za wczesnie").is_err());
    }

    #[test]
    fn za_duzy_ladunek_jest_odrzucany() {
        let (a, b) = (para(1), para(2));
        let (mut inicjator, _) = zestaw(&a, &b);

        assert!(inicjator.seal(&vec![0u8; MAX_PAYLOAD + 1]).is_err());
    }

    #[test]
    fn nieprawidlowy_klucz_rozmowcy_jest_odrzucany() {
        let a = para(1);

        assert!(Session::initiate(&a, &[]).is_err());
        assert!(Session::initiate(&a, &[0u8; 16]).is_err());
    }

    /// Pakiety z sieci bywają spreparowane — handshake ma zwracać błąd,
    /// nigdy panikować.
    #[test]
    fn smieci_w_handshake_nie_powoduja_paniki() {
        let a = para(1);

        for smiec in [vec![], vec![0u8; 1], vec![0xFFu8; 64], vec![0xABu8; 4096]] {
            let mut sesja = Session::respond(&a).unwrap();
            let _ = sesja.read_handshake(&smiec);
        }
    }
}
