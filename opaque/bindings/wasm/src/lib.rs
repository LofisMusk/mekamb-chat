//! Serwerowa strona OPAQUE dla Cloudflare Workers.
//!
//! # Dlaczego serwer w WebAssembly
//!
//! Serwer i klienty muszą używać **tej samej** implementacji OPAQUE — dwie
//! niezależne implementacje tego samego protokołu nie są zgodne na poziomie
//! bajtów. Uzasadnienie w `opaque/src/lib.rs`.
//!
//! Workers zabrania kompilowania WebAssembly w runtime, ale pozwala
//! zaimportować moduł skompilowany wcześniej przez bundler. Instancję trzeba
//! utworzyć ręcznie — robi to `glue.js` po stronie serwera.
//!
//! # Tu jest tylko strona serwera
//!
//! Funkcje klienta mieszkają w `core/bindings/wasm`, razem z MLS — przeglądarka
//! ładuje wtedy jeden moduł zamiast dwóch. Worker nie potrzebuje kodu klienta
//! i nie ma powodu, żeby go wozić.

use wasm_bindgen::prelude::*;

#[wasm_bindgen(start)]
pub fn start() {
    console_error_panic_hook::set_once();
}

/// Losuje nowy sekret serwera. Wołane raz, przy zakładaniu wdrożenia.
///
/// **Zmiana tej wartości unieważnia wszystkie konta.**
#[wasm_bindgen(js_name = generateServerKey)]
pub fn generate_server_key() -> Vec<u8> {
    mekamb_opaque::ServerKey::generate().to_bytes()
}

/// Krok 1 rejestracji.
#[wasm_bindgen(js_name = registrationStart)]
pub fn registration_start(
    server_key: &[u8],
    username: &str,
    request: &[u8],
) -> Result<Vec<u8>, JsError> {
    let key = mekamb_opaque::ServerKey::from_bytes(server_key).map_err(to_js)?;
    mekamb_opaque::server_registration_start(&key, username, request).map_err(to_js)
}

/// Krok 2 rejestracji: zwraca rekord konta do zapisania w bazie.
#[wasm_bindgen(js_name = registrationFinish)]
pub fn registration_finish(upload: &[u8]) -> Result<Vec<u8>, JsError> {
    mekamb_opaque::server_registration_finish(upload).map_err(to_js)
}

/// Wynik pierwszej rundy logowania.
#[wasm_bindgen(getter_with_clone)]
pub struct LoginStart {
    /// Do odesłania klientowi.
    pub response: Vec<u8>,
    /// Stan między rundami. **Sekret** — trzymać po stronie serwera.
    pub state: Vec<u8>,
}

/// Runda 1 logowania.
///
/// `record` jest `None` dla nieistniejącego konta. Biblioteka produkuje wtedy
/// odpowiedź nieodróżnialną od prawdziwej — bez tego dałoby się sprawdzać,
/// które nazwy są zajęte.
#[wasm_bindgen(js_name = loginStart)]
pub fn login_start(
    server_key: &[u8],
    username: &str,
    record: Option<Vec<u8>>,
    request: &[u8],
) -> Result<LoginStart, JsError> {
    let key = mekamb_opaque::ServerKey::from_bytes(server_key).map_err(to_js)?;

    let wynik =
        mekamb_opaque::server_login_start(&key, username, record.as_deref(), request).map_err(to_js)?;

    Ok(LoginStart { response: wynik.response, state: wynik.state })
}

/// Runda 2 logowania: weryfikuje dowód klienta i zwraca klucz sesji.
#[wasm_bindgen(js_name = loginFinish)]
pub fn login_finish(state: &[u8], username: &str, finalization: &[u8]) -> Result<Vec<u8>, JsError> {
    mekamb_opaque::server_login_finish(state, username, finalization).map_err(to_js)
}

/// Błędy przechodzą bez szczegółów kryptograficznych.
fn to_js(error: mekamb_opaque::Error) -> JsError {
    JsError::new(&error.to_string())
}

// ---------------------------------------------------------------------------
// Strona klienta — wyłącznie dla testów serwera
//
// Produkcyjny klient webowy używa tych funkcji z `core/bindings/wasm`, razem
// z MLS. Tutaj są po to, żeby testy serwera mogły przejść PEŁNĄ rundę
// protokołu prawdziwym klientem, a nie atrapą. Test na atrapie sprawdzałby
// nasze wyobrażenie o protokole, a nie sam protokół.
// ---------------------------------------------------------------------------

#[wasm_bindgen(getter_with_clone)]
pub struct ClientStart {
    pub request: Vec<u8>,
    pub state: Vec<u8>,
}

#[wasm_bindgen(js_name = clientRegisterStart)]
pub fn client_register_start(password: &str) -> Result<ClientStart, JsError> {
    let w = mekamb_opaque::client_registration_start(password).map_err(to_js)?;
    Ok(ClientStart { request: w.request, state: w.state })
}

#[wasm_bindgen(js_name = clientRegisterFinish)]
pub fn client_register_finish(
    state: &[u8],
    password: &str,
    username: &str,
    response: &[u8],
) -> Result<Vec<u8>, JsError> {
    mekamb_opaque::client_registration_finish(state, password, username, response)
        .map(|w| w.upload)
        .map_err(to_js)
}

#[wasm_bindgen(js_name = clientLoginStart)]
pub fn client_login_start(password: &str) -> Result<ClientStart, JsError> {
    let w = mekamb_opaque::client_login_start(password).map_err(to_js)?;
    Ok(ClientStart { request: w.request, state: w.state })
}

#[wasm_bindgen(js_name = clientLoginFinish)]
pub fn client_login_finish(
    state: &[u8],
    password: &str,
    username: &str,
    response: &[u8],
) -> Result<Vec<u8>, JsError> {
    mekamb_opaque::client_login_finish(state, password, username, response)
        .map(|w| w.finalization)
        .map_err(to_js)
}
