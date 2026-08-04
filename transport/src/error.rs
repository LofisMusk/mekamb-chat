use thiserror::Error;

pub type Result<T> = std::result::Result<T, Error>;

/// Błędy warstwy transportowej.
///
/// Osobny typ od `mekamb_core::Error`, bo to inna kategoria zdarzeń: awaria
/// sieci nie mówi nic o poprawności kryptografii i odwrotnie. Wspólny typ
/// kusiłby do obsługiwania obu tak samo.
#[derive(Debug, Error)]
pub enum Error {
    /// Nie udało się osiągnąć rozmówcy bezpośrednio.
    ///
    /// **To nie jest awaria.** Odbiorca ma pełne prawo być offline albo siedzieć
    /// za NAT-em, przez który nie da się przebić. Wywołujący ma wtedy sięgnąć
    /// po skrzynkę.
    #[error("nie udało się osiągnąć rozmówcy bezpośrednio")]
    PeerUnreachable,

    /// Błąd sieci, gniazda albo handshake'u.
    #[error("błąd transportu: {0}")]
    Transport(String),

    /// Błąd pochodzący z rdzenia — najczęściej nieprawidłowa koperta.
    #[error(transparent)]
    Core(#[from] mekamb_core::Error),
}
