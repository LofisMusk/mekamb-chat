//! Generuje sekret serwera OPAQUE do wpisania w Workers Secrets.
//!
//! Sekret ma określoną strukturę — nie jest to zwykły losowy ciąg, więc
//! `openssl rand` się tu nie nada.
//!
//! **Zmiana tej wartości unieważnia wszystkie konta.**
fn main() {
    use base64::Engine;

    let key = mekamb_opaque::ServerKey::generate();
    println!(
        "{}",
        base64::prelude::BASE64_STANDARD.encode(key.to_bytes())
    );
}
