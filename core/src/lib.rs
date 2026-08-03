//! Rdzeń kryptograficzny i transportowy komunikatora **mekamb-chat**.
//!
//! Cała kryptografia projektu żyje tutaj, w jednym egzemplarzu. Klient
//! androidowy sięga po ten kod przez UniFFI, klient webowy przez WebAssembly.
//! Interfejs użytkownika jest natywny na obu platformach, ale warstwa
//! bezpieczeństwa — nie: implementowanie MLS osobno w Kotlinie i TypeScripcie
//! oznaczałoby dwie rozjeżdżające się implementacje w najwrażliwszym miejscu
//! systemu.
//!
//! # Mapa modułów
//!
//! - [`identity`] — ziarno urządzenia i wyprowadzanie z niego rozdzielnych kluczy
//! - [`group`] — rozmowy oparte na MLS (DM to grupa dwuosobowa)
//! - [`framing`] — ładunek aplikacyjny przenoszony wewnątrz MLS
//! - [`error`] — wspólny typ błędu
//!
//! # Czego rdzeń świadomie NIE robi
//!
//! Nie zna serwera, nie wykonuje żądań sieciowych i nie decyduje o polityce
//! zaufania. Dostaje bajty i zwraca bajty. Dzięki temu daje się przetestować
//! bez żadnej infrastruktury — testy poniżej przepuszczają pełny handshake
//! między dwiema tożsamościami w jednym procesie.

pub mod error;
pub mod framing;
pub mod group;
pub mod identity;

pub use error::{Error, Result};
pub use framing::ChatMessage;
pub use group::{CIPHERSUITE, Conversation, Incoming, PendingCommit, Provider};
pub use identity::{DeviceIdentity, DeviceSeed};

/// Wersja protokołu obsługiwana przez tę wersję rdzenia.
pub const PROTOCOL_VERSION: u32 = framing::PAYLOAD_VERSION;
