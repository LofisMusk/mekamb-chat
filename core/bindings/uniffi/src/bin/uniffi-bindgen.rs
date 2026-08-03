//! Generator wiązań Kotlina.
//!
//! UniFFI czyta metadane wprost ze zbudowanej biblioteki, więc nie ma osobnego
//! pliku UDL, który mógłby rozjechać się z kodem Rusta.
fn main() {
    uniffi::uniffi_bindgen_main()
}
