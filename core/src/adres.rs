//! Podpisany rekord adresowy urządzenia.
//!
//! # Po co to istnieje
//!
//! Katalog na serwerze (`GET /directory/:username`) wydaje klucz transportowy
//! i adresy urządzenia, a klient wysyła pod nie kopertę wprost, z pominięciem
//! skrzynki. Serwer jest więc w pozycji, w której może podstawić **własny**
//! adres i przejąć całą bezpośrednią drogę doręczania.
//!
//! Treści to nie odsłania — koperta jest zaszyfrowana w MLS. Odsłania coś
//! innego, i to jest gorsze, niż wygląda: dostarczenie pod podstawiony adres
//! **udaje się**, więc zapasowa droga przez skrzynkę nie włącza się wcale.
//! Wiadomość znika bez błędu po obu stronach, a podstawiający dowiaduje się,
//! kto do kogo pisze i kiedy — czyli dokładnie tego, czego cały ten projekt
//! nie chce oddawać.
//!
//! Kolumna `addr_signature` istniała w bazie od początku, a komentarze
//! w serwerze mówiły, że „klient musi zweryfikować podpis". Nikt go nie składał
//! i nikt nie sprawdzał; ochrona istniała wyłącznie w komentarzu.
//!
//! # Czym to jest podpisane i dlaczego akurat tym
//!
//! Kluczem podpisu MLS urządzenia — tym samym, którym urządzenie jest liściem
//! w drzewie grupy. To nie jest wygoda, tylko jedyny wybór, który cokolwiek
//! daje: **weryfikować wolno wyłącznie kluczem z drzewa MLS**, a nie tym, który
//! przyszedł razem z rekordem. Serwer wydający i rekord, i klucz do jego
//! sprawdzenia podpisałby sobie dowolny adres sam.
//!
//! Klucz z drzewa daje [`crate::group::Conversation::participants`] — ta sama
//! droga, którą liczony jest safety number, i z tego samego powodu.
//!
//! # Dlaczego pola są prefiksowane długością
//!
//! Bo sklejenie ich bez tego jest wieloznaczne. `("ala", "bob")` i
//! `("alab", "ob")` dają ten sam ciąg bajtów, więc jeden podpis pasowałby do
//! dwóch różnych rekordów — a granice pól to tutaj granica między
//! „adres Alicji" a „adres Boba". Prefiks czterobajtowy usuwa całą tę klasę.
//!
//! Etykieta na początku oddziela te podpisy od wszystkiego innego, co tym
//! kluczem podpisuje MLS. Bez niej podpis wyjęty z jednego kontekstu mógłby
//! zostać wstawiony w drugi.

use ed25519_dalek::{Signature, Signer, Verifier, VerifyingKey};

use crate::identity::DeviceIdentity;

/// Etykieta oddzielająca te podpisy od innych zastosowań tego samego klucza.
const ETYKIETA: &[u8] = b"mekamb-chat/v1/rekord-adresu";

/// Składa kanoniczne bajty rekordu.
///
/// Każde pole poprzedzone swoją długością (u32 big-endian) — patrz nagłówek
/// modułu, sekcja o wieloznaczności sklejania.
fn kanoniczne_bajty(
    user_id: &str,
    device_id: &str,
    transport_key: &str,
    transport_addresses: &str,
) -> Vec<u8> {
    let mut out = Vec::with_capacity(ETYKIETA.len() + 64);
    out.extend_from_slice(ETYKIETA);

    for pole in [user_id, device_id, transport_key, transport_addresses] {
        out.extend_from_slice(&(pole.len() as u32).to_be_bytes());
        out.extend_from_slice(pole.as_bytes());
    }

    out
}

/// Podpisuje rekord adresowy tego urządzenia.
///
/// `user_id` i `device_id` bierzemy z tożsamości, a nie od wołającego: podpis
/// ma wiązać adres z **tym** urządzeniem, więc nie może być parametrem.
pub fn podpisz_adres(
    tozsamosc: &DeviceIdentity,
    transport_key: &str,
    transport_addresses: &str,
) -> Vec<u8> {
    let signing_key = tozsamosc.ed25519_signing_key();

    let wiadomosc = kanoniczne_bajty(
        tozsamosc.user_id(),
        tozsamosc.device_id(),
        transport_key,
        transport_addresses,
    );

    signing_key.sign(&wiadomosc).to_bytes().to_vec()
}

/// Sprawdza rekord adresowy kluczem podpisu z **drzewa MLS**.
///
/// `signature_key` musi pochodzić z [`crate::group::Conversation::participants`].
/// Podanie tu klucza z odpowiedzi katalogu nie daje żadnej ochrony: serwer
/// wydałby wtedy oba i podpisał sobie dowolny adres.
///
/// Zwraca `false` przy każdej niezgodności — złym kluczu, zmienionym polu,
/// uszkodzonym podpisie. Nie rozróżniamy powodów, bo wołający i tak ma zrobić
/// jedno: nie użyć tego adresu.
pub fn sprawdz_adres(
    signature_key: &[u8],
    user_id: &str,
    device_id: &str,
    transport_key: &str,
    transport_addresses: &str,
    podpis: &[u8],
) -> bool {
    let Ok(klucz) = <[u8; 32]>::try_from(signature_key) else {
        return false;
    };
    let Ok(verifying_key) = VerifyingKey::from_bytes(&klucz) else {
        return false;
    };
    let Ok(podpis) = <[u8; 64]>::try_from(podpis) else {
        return false;
    };

    let wiadomosc = kanoniczne_bajty(user_id, device_id, transport_key, transport_addresses);

    verifying_key
        .verify(&wiadomosc, &Signature::from_bytes(&podpis))
        .is_ok()
}

#[cfg(test)]
mod testy {
    use super::*;
    use crate::identity::{DeviceIdentity, DeviceSeed};

    const KLUCZ: &str = "klucz-transportowy";
    const ADRESY: &str = "192.0.2.1:4000,198.51.100.7:4000";

    fn tozsamosc(user: &str, device: &str) -> DeviceIdentity {
        DeviceIdentity::new(user, device, DeviceSeed::generate()).expect("poprawna tożsamość")
    }

    fn klucz_publiczny(tozsamosc: &DeviceIdentity) -> Vec<u8> {
        tozsamosc.signature_keypair().public().to_vec()
    }

    #[test]
    fn wlasny_podpis_przechodzi() {
        let alicja = tozsamosc("alicja", "telefon");
        let podpis = podpisz_adres(&alicja, KLUCZ, ADRESY);

        assert!(sprawdz_adres(
            &klucz_publiczny(&alicja),
            "alicja",
            "telefon",
            KLUCZ,
            ADRESY,
            &podpis
        ));
    }

    /// Sedno: podstawienie adresu przez serwer ma się nie udać.
    #[test]
    fn podmieniony_adres_odpada() {
        let alicja = tozsamosc("alicja", "telefon");
        let podpis = podpisz_adres(&alicja, KLUCZ, ADRESY);

        assert!(!sprawdz_adres(
            &klucz_publiczny(&alicja),
            "alicja",
            "telefon",
            KLUCZ,
            "203.0.113.9:6666",
            &podpis
        ));
    }

    #[test]
    fn podmieniony_klucz_transportowy_odpada() {
        let alicja = tozsamosc("alicja", "telefon");
        let podpis = podpisz_adres(&alicja, KLUCZ, ADRESY);

        assert!(!sprawdz_adres(
            &klucz_publiczny(&alicja),
            "alicja",
            "telefon",
            "klucz-napastnika",
            ADRESY,
            &podpis
        ));
    }

    /// Podpis jednego urządzenia nie może uwierzytelnić drugiego — inaczej
    /// wystarczyłoby przepisać cudzy wiersz pod swój `device_id`.
    #[test]
    fn podpis_nie_przenosi_sie_na_inne_urzadzenie() {
        let alicja = tozsamosc("alicja", "telefon");
        let podpis = podpisz_adres(&alicja, KLUCZ, ADRESY);

        assert!(!sprawdz_adres(
            &klucz_publiczny(&alicja),
            "alicja",
            "laptop",
            KLUCZ,
            ADRESY,
            &podpis
        ));
    }

    #[test]
    fn podpis_nie_przenosi_sie_na_inne_konto() {
        let alicja = tozsamosc("alicja", "telefon");
        let podpis = podpisz_adres(&alicja, KLUCZ, ADRESY);

        assert!(!sprawdz_adres(
            &klucz_publiczny(&alicja),
            "bob",
            "telefon",
            KLUCZ,
            ADRESY,
            &podpis
        ));
    }

    /// Klucz z katalogu zamiast z drzewa MLS: napastnik podpisuje SWOIM kluczem
    /// i dokłada swój klucz publiczny. Weryfikacja kluczem z drzewa to odrzuca —
    /// i to jest cały powód, dla którego klucz musi pochodzić z drzewa.
    #[test]
    fn cudzy_klucz_nie_uwierzytelnia_rekordu() {
        let alicja = tozsamosc("alicja", "telefon");
        let napastnik = tozsamosc("alicja", "telefon");

        let podrobiony = podpisz_adres(&napastnik, "klucz-napastnika", "203.0.113.9:6666");

        assert!(!sprawdz_adres(
            &klucz_publiczny(&alicja),
            "alicja",
            "telefon",
            "klucz-napastnika",
            "203.0.113.9:6666",
            &podrobiony
        ));
    }

    /// Granice pól muszą być jednoznaczne. Bez prefiksu długości
    /// `("ala", "bob")` i `("alab", "ob")` dają ten sam ciąg bajtów.
    #[test]
    fn przesuniecie_granicy_pol_daje_inna_wiadomosc() {
        assert_ne!(
            kanoniczne_bajty("ala", "bob", KLUCZ, ADRESY),
            kanoniczne_bajty("alab", "ob", KLUCZ, ADRESY)
        );
        assert_ne!(
            kanoniczne_bajty("alicja", "telefon", "ab", "cd"),
            kanoniczne_bajty("alicja", "telefon", "abc", "d")
        );
    }

    #[test]
    fn etykieta_oddziela_kontekst() {
        let bajty = kanoniczne_bajty("alicja", "telefon", KLUCZ, ADRESY);
        assert!(bajty.starts_with(ETYKIETA));
    }

    #[test]
    fn smiec_zamiast_podpisu_odpada() {
        let alicja = tozsamosc("alicja", "telefon");

        for podpis in [vec![], vec![0u8; 63], vec![0u8; 64], vec![7u8; 65]] {
            assert!(!sprawdz_adres(
                &klucz_publiczny(&alicja),
                "alicja",
                "telefon",
                KLUCZ,
                ADRESY,
                &podpis
            ));
        }
    }

    #[test]
    fn smiec_zamiast_klucza_odpada() {
        let alicja = tozsamosc("alicja", "telefon");
        let podpis = podpisz_adres(&alicja, KLUCZ, ADRESY);

        for klucz in [vec![], vec![0u8; 31], vec![0u8; 33]] {
            assert!(!sprawdz_adres(
                &klucz, "alicja", "telefon", KLUCZ, ADRESY, &podpis
            ));
        }
    }

    /// Urządzenie bez własnego adresu (przeglądarka) też ma się dać podpisać:
    /// pusty rekord jest poprawnym rekordem, a nie brakiem danych.
    #[test]
    fn pusty_rekord_przechodzi() {
        let alicja = tozsamosc("alicja", "przegladarka");
        let podpis = podpisz_adres(&alicja, "", "");

        assert!(sprawdz_adres(
            &klucz_publiczny(&alicja),
            "alicja",
            "przegladarka",
            "",
            "",
            &podpis
        ));
    }

    /// Ten sam rekord z tego samego ziarna daje ten sam podpis — Ed25519 jest
    /// deterministyczne, więc odświeżenie wpisu nie generuje ruchu bez potrzeby.
    #[test]
    fn podpis_jest_deterministyczny() {
        let seed = DeviceSeed::generate();
        let bajty = *seed.expose_secret_bytes();

        let a = DeviceIdentity::new("alicja", "telefon", DeviceSeed::from_bytes(&bajty).unwrap())
            .unwrap();
        let b = DeviceIdentity::new("alicja", "telefon", DeviceSeed::from_bytes(&bajty).unwrap())
            .unwrap();

        assert_eq!(
            podpisz_adres(&a, KLUCZ, ADRESY),
            podpisz_adres(&b, KLUCZ, ADRESY)
        );
    }
}
