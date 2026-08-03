//! Pełny przebieg rozmowy przez rdzeń, bez żadnej infrastruktury.
//!
//! Te testy odgrywają rolę serwera „na sucho": bajty zwrócone przez jedną
//! stronę są ręcznie podawane drugiej. Jeśli przechodzą, znaczy że warstwa
//! kryptograficzna jest kompletna i sieć jest już tylko transportem.

use mekamb_core::framing::ChatMessage;
use mekamb_core::group::{Conversation, Incoming, Provider};
use mekamb_core::identity::DeviceIdentity;

/// Zestaw jednej strony rozmowy: tożsamość plus jej własny magazyn.
///
/// Osobny `Provider` na uczestnika to nie detal testowy — odzwierciedla fakt,
/// że stan MLS jest lokalny dla urządzenia i nigdzie się nie współdzieli.
struct Uczestnik {
    tozsamosc: DeviceIdentity,
    provider: Provider,
}

impl Uczestnik {
    fn nowy(user_id: &str, device_id: &str) -> Self {
        Self {
            tozsamosc: DeviceIdentity::generate(user_id, device_id).unwrap(),
            provider: Provider::default(),
        }
    }
}

/// Zakłada rozmowę i wprowadza do niej drugą osobę.
///
/// Odwzorowuje przepływ z planu: inicjator przygotowuje commit, wysyła go do
/// `GroupRelay`, a scala dopiero po potwierdzeniu.
fn zaloz_rozmowe(inicjator: &Uczestnik, zapraszany: &Uczestnik) -> (Conversation, Conversation) {
    let key_package =
        Conversation::create_key_package(&zapraszany.provider, &zapraszany.tozsamosc).unwrap();

    let mut rozmowa_inicjatora =
        Conversation::create(&inicjator.provider, &inicjator.tozsamosc).unwrap();

    let oczekujacy = rozmowa_inicjatora
        .stage_add_member(
            &inicjator.provider,
            &inicjator.tozsamosc,
            key_package.key_package(),
        )
        .unwrap();

    // Tu w produkcji czekamy na potwierdzenie kolejności z GroupRelay.
    rozmowa_inicjatora
        .confirm_pending_commit(&inicjator.provider)
        .unwrap();

    let rozmowa_zapraszanego =
        Conversation::join_from_welcome(&zapraszany.provider, oczekujacy.welcome.as_ref().unwrap())
            .unwrap();

    (rozmowa_inicjatora, rozmowa_zapraszanego)
}

#[test]
fn alice_i_bob_wymieniaja_wiadomosci() {
    let alice = Uczestnik::nowy("alice", "telefon");
    let bob = Uczestnik::nowy("bob", "laptop");

    let (mut u_alice, mut u_boba) = zaloz_rozmowe(&alice, &bob);

    // Obie strony muszą widzieć tę samą grupę i tę samą epokę, inaczej dalsza
    // wymiana i tak by się rozjechała.
    assert_eq!(u_alice.group_id(), u_boba.group_id());
    assert_eq!(u_alice.epoch(), u_boba.epoch());
    assert_eq!(u_alice.members().len(), 2);

    let wyslana = ChatMessage::text("cześć Bob, zażółć gęślą jaźń", 1_700_000_000_000);
    let szyfrogram = u_alice
        .send(&alice.provider, &alice.tozsamosc, &wyslana)
        .unwrap();

    let odebrane = u_boba.receive(&bob.provider, &szyfrogram).unwrap();

    let Incoming::Message {
        sender_user_id,
        sender_device_id,
        message,
    } = odebrane
    else {
        panic!("oczekiwano wiadomości aplikacyjnej");
    };

    assert_eq!(sender_user_id, "alice");
    assert_eq!(sender_device_id, "telefon");
    assert_eq!(message.as_text(), Some("cześć Bob, zażółć gęślą jaźń"));
    assert_eq!(message.message_id, wyslana.message_id);

    // Odpowiedź w drugą stronę — ratchet musi działać obustronnie.
    let odpowiedz = ChatMessage::text("cześć Alice", 1_700_000_001_000);
    let szyfrogram = u_boba
        .send(&bob.provider, &bob.tozsamosc, &odpowiedz)
        .unwrap();

    let Incoming::Message {
        sender_user_id,
        message,
        ..
    } = u_alice.receive(&alice.provider, &szyfrogram).unwrap()
    else {
        panic!("oczekiwano wiadomości aplikacyjnej");
    };
    assert_eq!(sender_user_id, "bob");
    assert_eq!(message.as_text(), Some("cześć Alice"));
}

/// Najważniejszy test w tym pliku: dowód, że treść faktycznie nie leci jawnie.
#[test]
fn tresc_nie_wystepuje_w_bajtach_sieciowych() {
    let alice = Uczestnik::nowy("alice", "telefon");
    let bob = Uczestnik::nowy("bob", "laptop");
    let (mut u_alice, _) = zaloz_rozmowe(&alice, &bob);

    const SEKRET: &str = "NUMER-KARTY-4111111111111111";
    let szyfrogram = u_alice
        .send(
            &alice.provider,
            &alice.tozsamosc,
            &ChatMessage::text(SEKRET, 0),
        )
        .unwrap();

    assert!(
        !szyfrogram
            .windows(SEKRET.len())
            .any(|okno| okno == SEKRET.as_bytes()),
        "treść wiadomości znaleziona w bajtach wychodzących"
    );

    // Identyfikator nadawcy też nie może być czytelny — inaczej obserwator ruchu
    // odczytywałby graf społeczny wprost z pakietów.
    assert!(
        !szyfrogram.windows(5).any(|okno| okno == b"alice"),
        "identyfikator nadawcy znaleziony w bajtach wychodzących"
    );
}

#[test]
fn osoba_spoza_grupy_nie_odszyfruje_wiadomosci() {
    let alice = Uczestnik::nowy("alice", "telefon");
    let bob = Uczestnik::nowy("bob", "laptop");
    let mallory = Uczestnik::nowy("mallory", "serwer");

    let (mut u_alice, _) = zaloz_rozmowe(&alice, &bob);

    // Mallory zakłada własną rozmowę o tym samym identyfikatorze grupy —
    // sama znajomość group_id nie może wystarczyć do odczytu.
    let mut u_mallory =
        Conversation::create_with_id(&mallory.provider, &mallory.tozsamosc, u_alice.group_id())
            .unwrap();

    let szyfrogram = u_alice
        .send(
            &alice.provider,
            &alice.tozsamosc,
            &ChatMessage::text("tajne", 0),
        )
        .unwrap();

    assert!(
        u_mallory.receive(&mallory.provider, &szyfrogram).is_err(),
        "osoba spoza grupy odszyfrowała wiadomość"
    );
}

#[test]
fn zmodyfikowany_szyfrogram_jest_odrzucany() {
    let alice = Uczestnik::nowy("alice", "telefon");
    let bob = Uczestnik::nowy("bob", "laptop");
    let (mut u_alice, mut u_boba) = zaloz_rozmowe(&alice, &bob);

    let szyfrogram = u_alice
        .send(
            &alice.provider,
            &alice.tozsamosc,
            &ChatMessage::text("oryginał", 0),
        )
        .unwrap();

    // Przestawienie pojedynczego bitu w ładunku musi unieważnić całość.
    let mut zepsuty = szyfrogram.clone();
    let ostatni = zepsuty.len() - 1;
    zepsuty[ostatni] ^= 0x01;

    assert!(
        u_boba.receive(&bob.provider, &zepsuty).is_err(),
        "zmodyfikowany szyfrogram został przyjęty"
    );
}

#[test]
fn smieci_z_sieci_nie_powoduja_paniki() {
    let alice = Uczestnik::nowy("alice", "telefon");
    let bob = Uczestnik::nowy("bob", "laptop");
    let (_, mut u_boba) = zaloz_rozmowe(&alice, &bob);

    for smieci in [
        vec![],
        vec![0x00],
        vec![0xFF; 128],
        b"to zupelnie nie jest MLS".to_vec(),
    ] {
        assert!(u_boba.receive(&bob.provider, &smieci).is_err());
    }
}

#[test]
fn trzecia_osoba_dolacza_do_grupy() {
    let alice = Uczestnik::nowy("alice", "telefon");
    let bob = Uczestnik::nowy("bob", "laptop");
    let czarek = Uczestnik::nowy("czarek", "tablet");

    let (mut u_alice, mut u_boba) = zaloz_rozmowe(&alice, &bob);
    let epoka_przed = u_alice.epoch();

    let key_package =
        Conversation::create_key_package(&czarek.provider, &czarek.tozsamosc).unwrap();

    let oczekujacy = u_alice
        .stage_add_member(&alice.provider, &alice.tozsamosc, key_package.key_package())
        .unwrap();

    u_alice.confirm_pending_commit(&alice.provider).unwrap();

    // Bob dowiaduje się o zmianie z commitu rozesłanego przez relay.
    assert!(matches!(
        u_boba.receive(&bob.provider, &oczekujacy.commit).unwrap(),
        Incoming::MembershipChanged
    ));

    let mut u_czarka =
        Conversation::join_from_welcome(&czarek.provider, oczekujacy.welcome.as_ref().unwrap())
            .unwrap();

    // Wszyscy troje muszą wylądować w tej samej, nowej epoce.
    assert_eq!(u_alice.epoch(), epoka_przed + 1);
    assert_eq!(u_boba.epoch(), u_alice.epoch());
    assert_eq!(u_czarka.epoch(), u_alice.epoch());
    assert_eq!(u_alice.members().len(), 3);

    // I faktycznie się nawzajem słyszą.
    let szyfrogram = u_czarka
        .send(
            &czarek.provider,
            &czarek.tozsamosc,
            &ChatMessage::text("dzień dobry wszystkim", 0),
        )
        .unwrap();

    for (rozmowa, uczestnik) in [(&mut u_alice, &alice), (&mut u_boba, &bob)] {
        let Incoming::Message {
            sender_user_id,
            message,
            ..
        } = rozmowa.receive(&uczestnik.provider, &szyfrogram).unwrap()
        else {
            panic!("oczekiwano wiadomości aplikacyjnej");
        };
        assert_eq!(sender_user_id, "czarek");
        assert_eq!(message.as_text(), Some("dzień dobry wszystkim"));
    }
}

/// Ścieżka, którą wymusza `GroupRelay`: commit odrzucony (ktoś był pierwszy)
/// musi dać się porzucić, a rozmowa ma działać dalej w niezmienionej epoce.
#[test]
fn porzucony_commit_nie_psuje_rozmowy() {
    let alice = Uczestnik::nowy("alice", "telefon");
    let bob = Uczestnik::nowy("bob", "laptop");
    let czarek = Uczestnik::nowy("czarek", "tablet");

    let (mut u_alice, mut u_boba) = zaloz_rozmowe(&alice, &bob);
    let epoka_przed = u_alice.epoch();

    let key_package =
        Conversation::create_key_package(&czarek.provider, &czarek.tozsamosc).unwrap();
    u_alice
        .stage_add_member(&alice.provider, &alice.tozsamosc, key_package.key_package())
        .unwrap();

    // Relay odrzuca commit — porzucamy go zamiast scalać.
    u_alice.discard_pending_commit(&alice.provider).unwrap();

    assert_eq!(u_alice.epoch(), epoka_przed, "epoka nie mogła się zmienić");
    assert_eq!(u_alice.members().len(), 2);

    // Rozmowa działa dalej.
    let szyfrogram = u_alice
        .send(
            &alice.provider,
            &alice.tozsamosc,
            &ChatMessage::text("nadal działa", 0),
        )
        .unwrap();
    assert!(matches!(
        u_boba.receive(&bob.provider, &szyfrogram).unwrap(),
        Incoming::Message { .. }
    ));
}

/// Wielokrotne wysyłki muszą dawać różne szyfrogramy — inaczej ratchet stoi
/// w miejscu i obserwator rozpoznaje powtórzenia.
#[test]
fn ta_sama_tresc_daje_rozne_szyfrogramy() {
    let alice = Uczestnik::nowy("alice", "telefon");
    let bob = Uczestnik::nowy("bob", "laptop");
    let (mut u_alice, _) = zaloz_rozmowe(&alice, &bob);

    let pierwszy = u_alice
        .send(
            &alice.provider,
            &alice.tozsamosc,
            &ChatMessage::text("to samo", 0),
        )
        .unwrap();
    let drugi = u_alice
        .send(
            &alice.provider,
            &alice.tozsamosc,
            &ChatMessage::text("to samo", 0),
        )
        .unwrap();

    assert_ne!(pierwszy, drugi);
}

/// Bez tego przeglądarka gubiłaby rozmowę przy każdym odświeżeniu strony,
/// a telefon przy każdym ubiciu procesu.
#[test]
fn rozmowa_przezywa_zrzut_i_odtworzenie_stanu() {
    let alice = Uczestnik::nowy("alice", "telefon");
    let bob = Uczestnik::nowy("bob", "laptop");
    let (mut u_alice, mut u_boba) = zaloz_rozmowe(&alice, &bob);

    // Alice wysyła wiadomość przed „zamknięciem aplikacji".
    let przed = u_alice
        .send(
            &alice.provider,
            &alice.tozsamosc,
            &ChatMessage::text("przed restartem", 0),
        )
        .unwrap();
    assert!(matches!(
        u_boba.receive(&bob.provider, &przed).unwrap(),
        Incoming::Message { .. }
    ));

    // Zrzut stanu, jak przy zapisie do IndexedDB.
    let zrzut = alice.provider.export_state_containing_private_keys();
    assert!(!zrzut.is_empty(), "zrzut stanu nie może być pusty");

    // „Uruchomienie aplikacji od nowa": świeży provider z odtworzonego stanu.
    let provider_po_restarcie = Provider::import_state(&zrzut).unwrap();
    assert_eq!(provider_po_restarcie.entry_count(), alice.provider.entry_count());

    // Rozmowa musi dać się prowadzić dalej — w obie strony.
    let odpowiedz_boba = u_boba
        .send(
            &bob.provider,
            &bob.tozsamosc,
            &ChatMessage::text("po restarcie", 0),
        )
        .unwrap();

    let Incoming::Message { message, .. } = u_alice
        .receive(&provider_po_restarcie, &odpowiedz_boba)
        .unwrap()
    else {
        panic!("oczekiwano wiadomości aplikacyjnej");
    };
    assert_eq!(message.as_text(), Some("po restarcie"));
}
