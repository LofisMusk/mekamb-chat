//! Safety number — kod do porównania poza aplikacją.
//!
//! # Po co, skoro wiadomości są szyfrowane
//!
//! Szyfrowanie chroni przed podsłuchem. **Nie chroni przed serwerem, który
//! podstawi cudze urządzenie do rozmowy.** Serwer wydaje key packages i rekordy
//! katalogowe; gdyby wydał własne zamiast prawdziwych, wiadomości byłyby
//! szyfrowane poprawnie — tylko do niego.
//!
//! Safety number zamyka tę dziurę. Jest liczony **wyłącznie z kluczy tożsamości
//! uczestników**, więc podmiana któregokolwiek zmienia wynik. Dwie osoby, które
//! porównają go innym kanałem — na żywo, telefonicznie, przez wideo — wiedzą,
//! że rozmawiają ze sobą, a nie z kimś w środku.
//!
//! `docs/THREAT_MODEL.md` nazywa to funkcją nieopcjonalną i tak należy ją
//! traktować: bez porównania kodu E2EE broni przed podsłuchem, ale nie przed
//! podstawieniem.
//!
//! # Dlaczego to jest celowo powolne
//!
//! Kod ma 60 cyfr, czyli około 200 bitów. To mniej niż klucz, więc atak polega
//! na szukaniu **innej** pary kluczy dającej ten sam kod. Powtórzone haszowanie
//! podnosi koszt takiego poszukiwania o tyle, ile wynosi liczba iteracji —
//! przy jednorazowym wyliczeniu na urządzeniu to kilka milisekund, przy ataku
//! mnoży się przez liczbę prób.
//!
//! Tak samo działa Signal i z tego samego powodu.

use sha2::{Digest, Sha512};

use crate::error::{Error, Result};

/// Etykieta wersji. Zmiana konstrukcji wymaga nowej — inaczej kody policzone
/// starą i nową metodą wyglądałyby tak samo wiarygodnie.
const DOMAIN: &[u8] = b"mekamb-chat/v1/safety-number";

/// Liczba iteracji haszowania.
const ITERATIONS: u32 = 5200;

/// Liczba grup cyfr w wyniku.
const GROUPS: usize = 12;

/// Cyfr w grupie.
const DIGITS_PER_GROUP: u32 = 5;

/// Uczestnik rozmowy w postaci istotnej dla safety number.
#[derive(Debug, Clone, PartialEq, Eq, PartialOrd, Ord)]
pub struct Participant {
    /// `user_id:device_id` z credentiala MLS.
    pub identity: String,
    /// Klucz publiczny podpisu MLS.
    pub signature_key: Vec<u8>,
}

/// Liczy safety number rozmowy.
///
/// Kolejność uczestników **nie ma znaczenia** — lista jest sortowana przed
/// haszowaniem. Bez tego dwie osoby w tej samej rozmowie widziałyby różne kody
/// i porównanie nigdy by się nie udało.
///
/// Wynik to 60 cyfr w 12 grupach po 5, rozdzielonych spacjami.
pub fn safety_number(participants: &[Participant]) -> Result<String> {
    if participants.is_empty() {
        return Err(Error::InvalidInput(
            "safety number wymaga co najmniej jednego uczestnika".into(),
        ));
    }

    let mut posortowani = participants.to_vec();
    posortowani.sort();
    posortowani.dedup();

    let mut hasher = Sha512::new();
    hasher.update(DOMAIN);

    for uczestnik in &posortowani {
        // Długości przed danymi: bez nich („ala", "bc") i („alab", "c") dałyby
        // ten sam skrót, co pozwalałoby spreparować inny skład o tym samym kodzie.
        hasher.update((uczestnik.identity.len() as u64).to_be_bytes());
        hasher.update(uczestnik.identity.as_bytes());
        hasher.update((uczestnik.signature_key.len() as u64).to_be_bytes());
        hasher.update(&uczestnik.signature_key);
    }

    let mut digest = hasher.finalize();

    // Powtórzone haszowanie z domieszką danych wejściowych. Sam SHA-512 w pętli
    // dałoby się policzyć równolegle po odgadnięciu stanu pośredniego;
    // domieszka wymusza przejście całego łańcucha.
    for _ in 0..ITERATIONS {
        let mut hasher = Sha512::new();
        hasher.update(digest);
        hasher.update(DOMAIN);
        digest = hasher.finalize();
    }

    Ok(sformatuj(&digest))
}

/// Zamienia skrót na czytelne grupy cyfr.
fn sformatuj(digest: &[u8]) -> String {
    let modulo = 10u64.pow(DIGITS_PER_GROUP);

    let grupy: Vec<String> = (0..GROUPS)
        .map(|i| {
            let start = i * 5;
            let porcja = &digest[start..start + 5];

            let wartosc = porcja.iter().fold(0u64, |acc, &b| (acc << 8) | u64::from(b));

            format!("{:0width$}", wartosc % modulo, width = DIGITS_PER_GROUP as usize)
        })
        .collect();

    grupy.join(" ")
}

/// Krótki odcisk pojedynczego urządzenia.
///
/// Używany przy linkowaniu nowego urządzenia: kod z ekranu jednego urządzenia
/// porównuje się z tym, co pokazuje drugie. Kanał wizualny jest tu jedynym
/// zaufanym — serwer pośredniczy w przekazaniu key package, więc nie może być
/// podstawą zaufania do niego samego.
pub fn device_fingerprint(signature_key: &[u8]) -> Result<String> {
    if signature_key.is_empty() {
        return Err(Error::InvalidInput("pusty klucz urządzenia".into()));
    }

    safety_number(&[Participant {
        identity: String::new(),
        signature_key: signature_key.to_vec(),
    }])
    // Odcisk urządzenia jest krótszy niż safety number rozmowy: służy do
    // przepisania z ekranu na ekran, a nie do porównania przez telefon.
    .map(|pelny| pelny.split(' ').take(4).collect::<Vec<_>>().join(" "))
}

#[cfg(test)]
mod tests {
    use super::*;

    fn uczestnik(identity: &str, klucz: &[u8]) -> Participant {
        Participant { identity: identity.into(), signature_key: klucz.to_vec() }
    }

    fn alicja() -> Participant {
        uczestnik("alicja:telefon", &[1u8; 32])
    }

    fn bartek() -> Participant {
        uczestnik("bartek:laptop", &[2u8; 32])
    }

    #[test]
    fn ma_format_dwunastu_grup_po_piec_cyfr() {
        let kod = safety_number(&[alicja(), bartek()]).unwrap();
        let grupy: Vec<&str> = kod.split(' ').collect();

        assert_eq!(grupy.len(), GROUPS);
        for grupa in grupy {
            assert_eq!(grupa.len(), DIGITS_PER_GROUP as usize);
            assert!(grupa.chars().all(|c| c.is_ascii_digit()));
        }
    }

    /// Sedno: obie strony muszą zobaczyć ten sam kod, niezależnie od tego,
    /// w jakiej kolejności ich klient wylistował członków grupy.
    #[test]
    fn kolejnosc_uczestnikow_nie_ma_znaczenia() {
        assert_eq!(
            safety_number(&[alicja(), bartek()]).unwrap(),
            safety_number(&[bartek(), alicja()]).unwrap(),
        );
    }

    /// Właściwość, dla której to w ogóle istnieje: podmiana klucza przez serwer
    /// musi zmienić kod.
    #[test]
    fn podmiana_klucza_zmienia_kod() {
        let oryginal = safety_number(&[alicja(), bartek()]).unwrap();

        // Serwer podstawia własne urządzenie pod nazwą Bartka.
        let podmieniony =
            safety_number(&[alicja(), uczestnik("bartek:laptop", &[99u8; 32])]).unwrap();

        assert_ne!(oryginal, podmieniony, "podmiana klucza nie zmieniła kodu");
    }

    #[test]
    fn zmiana_skladu_grupy_zmienia_kod() {
        let dwie_osoby = safety_number(&[alicja(), bartek()]).unwrap();
        let trzy_osoby =
            safety_number(&[alicja(), bartek(), uczestnik("czarek:tablet", &[3u8; 32])]).unwrap();

        assert_ne!(dwie_osoby, trzy_osoby);
    }

    /// Bez prefiksów długości dałoby się przesunąć granicę między nazwą
    /// a kluczem i spreparować inny skład o tym samym kodzie.
    #[test]
    fn granica_miedzy_polami_jest_jednoznaczna() {
        let a = safety_number(&[uczestnik("ab", &[0xCD, 0xEF])]).unwrap();
        let b = safety_number(&[uczestnik("abc", &[0xDE, 0xF0])]).unwrap();

        assert_ne!(a, b);
    }

    #[test]
    fn ten_sam_sklad_daje_powtarzalny_kod() {
        assert_eq!(
            safety_number(&[alicja(), bartek()]).unwrap(),
            safety_number(&[alicja(), bartek()]).unwrap(),
        );
    }

    /// Duplikat na liście nie może zmieniać wyniku — klient może zwrócić
    /// tę samą osobę dwa razy, jeśli ma dwa urządzenia o tym samym kluczu.
    #[test]
    fn duplikaty_sa_pomijane() {
        assert_eq!(
            safety_number(&[alicja(), bartek()]).unwrap(),
            safety_number(&[alicja(), bartek(), bartek()]).unwrap(),
        );
    }

    #[test]
    fn odcisk_urzadzenia_jest_krotszy_i_zalezy_od_klucza() {
        let odcisk = device_fingerprint(&[7u8; 32]).unwrap();

        assert_eq!(odcisk.split(' ').count(), 4);
        assert_ne!(odcisk, device_fingerprint(&[8u8; 32]).unwrap());
    }

    #[test]
    fn puste_wejscie_jest_odrzucane() {
        assert!(safety_number(&[]).is_err());
        assert!(device_fingerprint(&[]).is_err());
    }
}
