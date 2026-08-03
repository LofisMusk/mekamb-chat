use thiserror::Error;

pub type Result<T> = std::result::Result<T, Error>;

/// Błędy OPAQUE.
///
/// Warianty są zgrubne celowo. Rozróżnienie „zły podpis" od „zła wiadomość"
/// w odpowiedzi dla klienta dawałoby atakującemu oracle, więc niepowodzenie
/// uwierzytelnienia ma dokładnie jeden wariant.
#[derive(Debug, Error)]
pub enum Error {
    /// Sekret serwera jest nieprawidłowy albo uszkodzony.
    #[error("nieprawidłowy sekret serwera")]
    InvalidServerKey,

    /// Komunikat nie daje się sparsować — spodziewany przy danych z sieci.
    #[error("nieprawidłowy format komunikatu OPAQUE")]
    MalformedMessage,

    /// Operacja protokołu nie powiodła się.
    #[error("operacja OPAQUE nie powiodła się")]
    Protocol,

    /// Klient nie znał hasła albo konto nie istnieje.
    ///
    /// Jeden wariant dla obu przypadków: rozróżnienie pozwalałoby sprawdzać,
    /// które konta są zajęte.
    #[error("nieprawidłowe dane logowania")]
    AuthenticationFailed,
}
