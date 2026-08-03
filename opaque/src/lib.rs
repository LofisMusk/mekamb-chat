//! OPAQUE (RFC 9807) — uwierzytelnianie hasłem bez ujawniania hasła serwerowi.
//!
//! # Dlaczego jedna implementacja po obu stronach
//!
//! Pierwotnie serwer używał implementacji w TypeScripcie, a klient natywny miał
//! dostać rustową. Okazało się, że to nie zadziała: `@cloudflare/opaque-ts`
//! realizuje **draft-irtf-cfrg-opaque-07** z 2021 roku, a `opaque-ke` — **RFC
//! 9807**, czyli wersję finalną. Między nimi zmienił się format komunikatów.
//!
//! Dwie niezależne implementacje tego samego protokołu nie są zgodne na poziomie
//! bajtów tylko dlatego, że obie „robią OPAQUE". Rozjazd nie daje „słabszego
//! bezpieczeństwa" — daje logowanie, które nigdy nie przechodzi.
//!
//! Dlatego serwer i wszystkie klienty korzystają z **tego samego kodu**:
//! Worker przez WebAssembly, przeglądarka przez WebAssembly, Android przez
//! UniFFI. Zgodność wynika z konstrukcji, a nie z nadziei.
//!
//! # Co OPAQUE daje ponad zwykły hash hasła
//!
//! Przy `Argon2(hasło)` serwer **widzi hasło** w chwili logowania, a z bazy da
//! się prowadzić atak słownikowy offline. W OPAQUE hasło nie opuszcza klienta
//! w żadnej postaci, a z rekordu w bazie takiego ataku poprowadzić się nie da.
//! Serwer nie ma czego wyciec, bo nigdy tego nie miał.
//!
//! # Czego OPAQUE NIE daje
//!
//! Nie chroni wiadomości. Uwierzytelnia dostęp do infrastruktury — skrzynki,
//! katalogu, key packages. Klucze wiadomości nigdy nie opuszczają urządzenia,
//! więc przejęcie konta nie daje historii rozmów.

use opaque_ke::rand::rngs::OsRng;
use opaque_ke::{
    CipherSuite, ClientLogin, ClientLoginFinishParameters, ClientLoginFinishResult,
    ClientLoginStartResult, ClientRegistration, ClientRegistrationFinishParameters,
    ClientRegistrationFinishResult, ClientRegistrationStartResult, CredentialFinalization,
    CredentialRequest, CredentialResponse, Identifiers, RegistrationRequest, RegistrationResponse,
    RegistrationUpload, ServerLogin, ServerLoginParameters, ServerLoginStartResult, ServerRegistration,
    ServerSetup,
};

mod error;
pub use error::{Error, Result};

/// Zestaw kryptograficzny.
///
/// Ristretto255 zamiast P-256: szybszy, bez przypadków brzegowych przy
/// kodowaniu punktów i bez ryzyka nieprawidłowej implementacji krzywej.
/// Wybór jest wewnętrzny — obie strony to ten sam kod, więc nie musimy się
/// z niczym zgadzać poza sobą.
///
/// `Ksf = Identity` **nie** oznacza braku rozciągania klucza w potocznym sensie:
/// OPAQUE i tak wymusza kosztowną operację OPRF po stronie klienta. Dołożenie
/// Argon2 podniosłoby koszt ataku słownikowego na wykradziony rekord, ale
/// dwukrotnie wydłużyłoby logowanie w przeglądarce na telefonie. Do rozważenia
/// osobno, wraz z pomiarem.
pub struct Suite;

impl CipherSuite for Suite {
    type OprfCs = opaque_ke::Ristretto255;
    type KeyExchange = opaque_ke::TripleDh<opaque_ke::Ristretto255, sha2::Sha512>;
    type Ksf = opaque_ke::ksf::Identity;
}

/// Nazwa serwera wiązana z sesją — chroni przed przeniesieniem uwierzytelnienia
/// do innego wdrożenia.
const SERVER_IDENTITY: &[u8] = b"mekamb-chat";

fn identifiers(username: &str) -> Identifiers<'_> {
    Identifiers {
        client: Some(username.as_bytes()),
        server: Some(SERVER_IDENTITY),
    }
}

// ---------------------------------------------------------------------------
// Serwer
// ---------------------------------------------------------------------------

/// Długoterminowy sekret serwera.
///
/// **Jego zmiana unieważnia wszystkie konta.** Z niego wyprowadzany jest
/// materiał wiążący hasła użytkowników z tym wdrożeniem.
pub struct ServerKey(ServerSetup<Suite>);

impl ServerKey {
    /// Losuje nowy sekret serwera. Wołane raz, przy zakładaniu wdrożenia.
    pub fn generate() -> Self {
        Self(ServerSetup::new(&mut OsRng))
    }

    /// Odtwarza sekret z postaci zapisanej w Workers Secrets.
    pub fn from_bytes(bytes: &[u8]) -> Result<Self> {
        ServerSetup::deserialize(bytes)
            .map(Self)
            .map_err(|_| Error::InvalidServerKey)
    }

    /// Zrzuca sekret do zapisania. **Traktować jak dane nieodwracalne.**
    pub fn to_bytes(&self) -> Vec<u8> {
        self.0.serialize().to_vec()
    }
}

/// Krok 1 rejestracji po stronie serwera.
pub fn server_registration_start(
    key: &ServerKey,
    username: &str,
    request: &[u8],
) -> Result<Vec<u8>> {
    let request = RegistrationRequest::deserialize(request).map_err(|_| Error::MalformedMessage)?;

    let result = ServerRegistration::<Suite>::start(&key.0, request, username.as_bytes())
        .map_err(|_| Error::Protocol)?;

    Ok(result.message.serialize().to_vec())
}

/// Krok 2 rejestracji: zamienia odpowiedź klienta w rekord do zapisania w bazie.
///
/// Z tego rekordu **nie da się** prowadzić ataku słownikowego offline — to
/// zasadnicza różnica względem hasha hasła.
pub fn server_registration_finish(upload: &[u8]) -> Result<Vec<u8>> {
    let upload = RegistrationUpload::<Suite>::deserialize(upload).map_err(|_| Error::MalformedMessage)?;

    Ok(ServerRegistration::finish(upload).serialize().to_vec())
}

/// Wynik pierwszej rundy logowania po stronie serwera.
pub struct ServerLoginStart {
    /// Do odesłania klientowi.
    pub response: Vec<u8>,
    /// Stan do przechowania między rundami. **Sekret.**
    pub state: Vec<u8>,
}

/// Runda 1 logowania.
///
/// `record` jest `None`, gdy konto nie istnieje. Biblioteka produkuje wtedy
/// odpowiedź nieodróżnialną od prawdziwej — to jedyne, co powstrzymuje
/// sprawdzanie, które konta są zajęte. Skrót w tym miejscu zniweczyłby ochronę,
/// którą daje OPAQUE.
pub fn server_login_start(
    key: &ServerKey,
    username: &str,
    record: Option<&[u8]>,
    request: &[u8],
) -> Result<ServerLoginStart> {
    let record = match record {
        Some(bytes) => Some(
            ServerRegistration::<Suite>::deserialize(bytes).map_err(|_| Error::MalformedMessage)?,
        ),
        None => None,
    };

    let request = CredentialRequest::deserialize(request).map_err(|_| Error::MalformedMessage)?;

    let result: ServerLoginStartResult<Suite> = ServerLogin::start(
        &mut OsRng,
        &key.0,
        record,
        request,
        username.as_bytes(),
        ServerLoginParameters { context: None, identifiers: identifiers(username) },
    )
    .map_err(|_| Error::Protocol)?;

    Ok(ServerLoginStart {
        response: result.message.serialize().to_vec(),
        state: result.state.serialize().to_vec(),
    })
}

/// Runda 2 logowania: weryfikuje dowód klienta i zwraca klucz sesji.
///
/// Zgodność kluczy sesji po obu stronach jest dowodem, że klient znał hasło —
/// a serwer nigdy go nie zobaczył.
pub fn server_login_finish(state: &[u8], username: &str, finalization: &[u8]) -> Result<Vec<u8>> {
    let state = ServerLogin::<Suite>::deserialize(state).map_err(|_| Error::MalformedMessage)?;
    let finalization =
        CredentialFinalization::deserialize(finalization).map_err(|_| Error::MalformedMessage)?;

    let result = state
        .finish(
            finalization,
            ServerLoginParameters { context: None, identifiers: identifiers(username) },
        )
        // Niepowodzenie znaczy „klient nie znał hasła". Nie rozróżniamy powodów.
        .map_err(|_| Error::AuthenticationFailed)?;

    Ok(result.session_key.to_vec())
}

// ---------------------------------------------------------------------------
// Klient
// ---------------------------------------------------------------------------

/// Wynik pierwszej rundy rejestracji po stronie klienta.
pub struct ClientRegistrationStart {
    /// Do wysłania na serwer.
    pub request: Vec<u8>,
    /// Stan do zachowania między rundami. **Sekret.**
    pub state: Vec<u8>,
}

/// Runda 1 rejestracji. Hasło zostaje na urządzeniu.
pub fn client_registration_start(password: &str) -> Result<ClientRegistrationStart> {
    let result: ClientRegistrationStartResult<Suite> =
        ClientRegistration::start(&mut OsRng, password.as_bytes()).map_err(|_| Error::Protocol)?;

    Ok(ClientRegistrationStart {
        request: result.message.serialize().to_vec(),
        state: result.state.serialize().to_vec(),
    })
}

/// Wynik drugiej rundy rejestracji po stronie klienta.
pub struct ClientRegistrationFinish {
    /// Do wysłania na serwer i zapisania jako rekord konta.
    pub upload: Vec<u8>,
    /// Klucz wyprowadzony z hasła, znany **tylko** klientowi.
    ///
    /// Serwer go nie widzi. Nadaje się do szyfrowania kopii zapasowych, których
    /// serwer ma nie umieć odczytać.
    pub export_key: Vec<u8>,
}

/// Runda 2 rejestracji.
pub fn client_registration_finish(
    state: &[u8],
    password: &str,
    username: &str,
    response: &[u8],
) -> Result<ClientRegistrationFinish> {
    let state = ClientRegistration::<Suite>::deserialize(state).map_err(|_| Error::MalformedMessage)?;
    let response = RegistrationResponse::deserialize(response).map_err(|_| Error::MalformedMessage)?;

    let result: ClientRegistrationFinishResult<Suite> = state
        .finish(
            &mut OsRng,
            password.as_bytes(),
            response,
            ClientRegistrationFinishParameters::new(identifiers(username), None),
        )
        .map_err(|_| Error::Protocol)?;

    Ok(ClientRegistrationFinish {
        upload: result.message.serialize().to_vec(),
        export_key: result.export_key.to_vec(),
    })
}

/// Wynik pierwszej rundy logowania po stronie klienta.
pub struct ClientLoginStart {
    pub request: Vec<u8>,
    /// Stan do zachowania między rundami. **Sekret.**
    pub state: Vec<u8>,
}

/// Runda 1 logowania.
pub fn client_login_start(password: &str) -> Result<ClientLoginStart> {
    let result: ClientLoginStartResult<Suite> =
        ClientLogin::start(&mut OsRng, password.as_bytes()).map_err(|_| Error::Protocol)?;

    Ok(ClientLoginStart {
        request: result.message.serialize().to_vec(),
        state: result.state.serialize().to_vec(),
    })
}

/// Wynik drugiej rundy logowania po stronie klienta.
pub struct ClientLoginFinish {
    /// Dowód do odesłania serwerowi.
    pub finalization: Vec<u8>,
    pub session_key: Vec<u8>,
    pub export_key: Vec<u8>,
}

/// Runda 2 logowania.
///
/// **Złe hasło wykrywa tutaj klient**, a nie serwer. Serwer nie ma czego
/// porównywać, więc nie ma stamtąd czego wyciec.
pub fn client_login_finish(
    state: &[u8],
    password: &str,
    username: &str,
    response: &[u8],
) -> Result<ClientLoginFinish> {
    let state = ClientLogin::<Suite>::deserialize(state).map_err(|_| Error::MalformedMessage)?;
    let response = CredentialResponse::deserialize(response).map_err(|_| Error::MalformedMessage)?;

    let result: ClientLoginFinishResult<Suite> = state
        .finish(
            &mut OsRng,
            password.as_bytes(),
            response,
            ClientLoginFinishParameters::new(None, identifiers(username), None),
        )
        .map_err(|_| Error::AuthenticationFailed)?;

    Ok(ClientLoginFinish {
        finalization: result.message.serialize().to_vec(),
        session_key: result.session_key.to_vec(),
        export_key: result.export_key.to_vec(),
    })
}

#[cfg(test)]
mod tests {
    use super::*;

    const HASLO: &str = "poprawne-konie-bateria-zszywka";
    const UZYTKOWNIK: &str = "alicja";

    /// Przechodzi pełną rejestrację i zwraca rekord konta.
    fn zarejestruj(key: &ServerKey, username: &str, password: &str) -> Vec<u8> {
        let start = client_registration_start(password).unwrap();
        let response = server_registration_start(key, username, &start.request).unwrap();
        let finish = client_registration_finish(&start.state, password, username, &response).unwrap();
        server_registration_finish(&finish.upload).unwrap()
    }

    /// Przechodzi logowanie i zwraca klucze sesji obu stron.
    fn zaloguj(
        key: &ServerKey,
        username: &str,
        record: Option<&[u8]>,
        password: &str,
    ) -> Result<(Vec<u8>, Vec<u8>)> {
        let start = client_login_start(password).unwrap();
        let serwer = server_login_start(key, username, record, &start.request).unwrap();
        let klient = client_login_finish(&start.state, password, username, &serwer.response)?;
        let klucz_serwera = server_login_finish(&serwer.state, username, &klient.finalization)?;

        Ok((klient.session_key, klucz_serwera))
    }

    #[test]
    fn poprawne_haslo_daje_wspolny_klucz_sesji() {
        let key = ServerKey::generate();
        let rekord = zarejestruj(&key, UZYTKOWNIK, HASLO);

        let (klient, serwer) = zaloguj(&key, UZYTKOWNIK, Some(&rekord), HASLO).unwrap();

        // Zgodność kluczy jest dowodem, że klient znał hasło — a serwer
        // nigdy go nie zobaczył.
        assert_eq!(klient, serwer);
        assert!(!klient.is_empty());
    }

    #[test]
    fn zle_haslo_nie_przechodzi() {
        let key = ServerKey::generate();
        let rekord = zarejestruj(&key, UZYTKOWNIK, HASLO);

        assert!(zaloguj(&key, UZYTKOWNIK, Some(&rekord), "ZUPELNIE-INNE-haslo").is_err());
    }

    /// Ochrona przed enumeracją kont: nieistniejąca nazwa musi przejść tę samą
    /// ścieżkę i dać odpowiedź o tym samym kształcie.
    #[test]
    fn nieistniejace_konto_daje_odpowiedz_tej_samej_dlugosci() {
        let key = ServerKey::generate();
        let rekord = zarejestruj(&key, UZYTKOWNIK, HASLO);

        let start = client_login_start(HASLO).unwrap();
        let istniejace = server_login_start(&key, UZYTKOWNIK, Some(&rekord), &start.request).unwrap();
        let nieistniejace = server_login_start(&key, "nie-ma-takiego", None, &start.request).unwrap();

        assert_eq!(
            istniejace.response.len(),
            nieistniejace.response.len(),
            "różna długość odpowiedzi zdradzałaby, które konta istnieją"
        );

        // Logowanie na nieistniejące konto musi odpaść tak samo jak złe hasło.
        assert!(zaloguj(&key, "nie-ma-takiego", None, HASLO).is_err());
    }

    /// Sedno całej konstrukcji: hasła nie ma w niczym, co idzie do serwera.
    #[test]
    fn haslo_nie_wystepuje_w_zadnym_komunikacie() {
        let key = ServerKey::generate();

        let start = client_registration_start(HASLO).unwrap();
        let response = server_registration_start(&key, UZYTKOWNIK, &start.request).unwrap();
        let finish = client_registration_finish(&start.state, HASLO, UZYTKOWNIK, &response).unwrap();
        let rekord = server_registration_finish(&finish.upload).unwrap();

        let logowanie = client_login_start(HASLO).unwrap();
        let serwer = server_login_start(&key, UZYTKOWNIK, Some(&rekord), &logowanie.request).unwrap();
        let klient =
            client_login_finish(&logowanie.state, HASLO, UZYTKOWNIK, &serwer.response).unwrap();

        for (nazwa, dane) in [
            ("żądanie rejestracji", &start.request),
            ("odpowiedź rejestracji", &response),
            ("rekord konta", &rekord),
            ("żądanie logowania", &logowanie.request),
            ("odpowiedź logowania", &serwer.response),
            ("dowód klienta", &klient.finalization),
        ] {
            assert!(
                !dane.windows(HASLO.len()).any(|okno| okno == HASLO.as_bytes()),
                "hasło znalezione w: {nazwa}"
            );
        }
    }

    #[test]
    fn sekret_serwera_przezywa_zapis_i_odczyt() {
        let key = ServerKey::generate();
        let rekord = zarejestruj(&key, UZYTKOWNIK, HASLO);

        // Worker jest bezstanowy i odtwarza sekret przy każdym starcie.
        let odtworzony = ServerKey::from_bytes(&key.to_bytes()).unwrap();

        let (klient, serwer) = zaloguj(&odtworzony, UZYTKOWNIK, Some(&rekord), HASLO).unwrap();
        assert_eq!(klient, serwer);
    }

    /// Konto zarejestrowane pod jednym sekretem serwera nie może działać pod innym.
    #[test]
    fn inny_sekret_serwera_uniewaznia_konta() {
        let stary = ServerKey::generate();
        let rekord = zarejestruj(&stary, UZYTKOWNIK, HASLO);

        let nowy = ServerKey::generate();

        assert!(zaloguj(&nowy, UZYTKOWNIK, Some(&rekord), HASLO).is_err());
    }

    #[test]
    fn klucz_eksportowy_jest_powtarzalny_i_zalezy_od_hasla() {
        let key = ServerKey::generate();

        let start = client_registration_start(HASLO).unwrap();
        let response = server_registration_start(&key, UZYTKOWNIK, &start.request).unwrap();
        let rejestracja =
            client_registration_finish(&start.state, HASLO, UZYTKOWNIK, &response).unwrap();
        let rekord = server_registration_finish(&rejestracja.upload).unwrap();

        let logowanie = client_login_start(HASLO).unwrap();
        let serwer = server_login_start(&key, UZYTKOWNIK, Some(&rekord), &logowanie.request).unwrap();
        let klient =
            client_login_finish(&logowanie.state, HASLO, UZYTKOWNIK, &serwer.response).unwrap();

        // Ten sam klucz przy rejestracji i przy każdym logowaniu — na tym opiera
        // się możliwość szyfrowania kopii, których serwer nie odczyta.
        assert_eq!(rejestracja.export_key, klient.export_key);
        assert!(!klient.export_key.is_empty());
    }

    #[test]
    fn spreparowane_komunikaty_nie_powoduja_paniki() {
        let key = ServerKey::generate();

        for smiec in [vec![], vec![0u8; 1], vec![0xFFu8; 64], vec![0xABu8; 512]] {
            let _ = server_registration_start(&key, UZYTKOWNIK, &smiec);
            let _ = server_registration_finish(&smiec);
            let _ = server_login_start(&key, UZYTKOWNIK, None, &smiec);
            let _ = server_login_finish(&smiec, UZYTKOWNIK, &smiec);
            let _ = client_registration_finish(&smiec, HASLO, UZYTKOWNIK, &smiec);
            let _ = client_login_finish(&smiec, HASLO, UZYTKOWNIK, &smiec);
            let _ = ServerKey::from_bytes(&smiec);
        }
    }
}
