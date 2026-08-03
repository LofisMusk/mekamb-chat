//! Typ błędu rdzenia.
//!
//! Błędy są celowo zgrubne: warstwa UI nie powinna rozróżniać wariantów
//! kryptograficznych, bo szczegółowy komunikat o tym, *dlaczego* deszyfrowanie
//! się nie powiodło, jest wyciekiem informacji (oracle).

use thiserror::Error;

/// Wynik operacji rdzenia.
pub type Result<T> = std::result::Result<T, Error>;

#[derive(Debug, Error)]
pub enum Error {
    /// Ziarno urządzenia ma nieprawidłową długość.
    #[error("nieprawidłowa długość ziarna: oczekiwano {expected} bajtów, otrzymano {got}")]
    InvalidSeedLength { expected: usize, got: usize },

    /// Dane wejściowe nie spełniają wymagań (rozmiar, długość klucza itp.).
    #[error("nieprawidłowe dane wejściowe: {0}")]
    InvalidInput(String),

    /// Identyfikator użytkownika lub urządzenia nie spełnia wymagań formatu.
    #[error("nieprawidłowy identyfikator: {0}")]
    InvalidIdentity(String),

    /// Operacja na grupie MLS nie powiodła się.
    #[error("błąd grupy MLS: {0}")]
    Group(String),

    /// Nie udało się odszyfrować lub zweryfikować wiadomości.
    ///
    /// Świadomie bez szczegółów — patrz uwaga na górze modułu.
    #[error("nie udało się przetworzyć wiadomości przychodzącej")]
    MessageRejected,

    /// Ładunek aplikacyjny nie jest poprawnym `ChatMessage`.
    #[error("nieprawidłowy format ładunku: {0}")]
    Framing(String),

    /// Błąd warstwy trwałego magazynu.
    #[error("błąd magazynu: {0}")]
    Storage(String),
}
