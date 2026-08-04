//! Usuwanie metadanych z kontenerów MP4 i MOV (ISO BMFF).
//!
//! # Czego szukamy
//!
//! Nagranie z telefonu niesie współrzędne GPS w `moov/udta/©xyz` (QuickTime)
//! albo w `moov/meta`, a do tego model urządzenia i wersję oprogramowania.
//! Kamery sportowe idą dalej i zapisują **cały przebieg trasy** jako osobną
//! ścieżkę z metadanymi czasowymi — GPS co sekundę przez całe nagranie.
//!
//! # Dlaczego zamieniamy na `free`, a nie wycinamy
//!
//! To jest sedno tego modułu. MP4 trzyma w tablicach `stco` i `co64`
//! **bezwzględne offsety** do danych obrazu w `mdat`. Wycięcie czegokolwiek
//! przed `mdat` przesunęłoby wszystko, co jest za nim, a tablice offsetów
//! wskazywałyby w próżnię — plik przestałby się odtwarzać.
//!
//! Zamiast tego nadpisujemy nagłówek boksu typem `free` i zerujemy jego
//! zawartość. Rozmiar zostaje ten sam, więc **żaden offset się nie zmienia**,
//! a odtwarzacze pomijają `free` z definicji. Plik jest bajt w bajt taki sam
//! poza miejscami, gdzie były metadane.
//!
//! Koszt: plik nie chudnie. To rozsądna cena za pewność, że nagranie nadal
//! działa — zepsute wideo użytkownik zauważy od razu, a przesunięty offset
//! bywa widoczny dopiero przy przewijaniu.

use crate::error::{Error, Result};

/// Nagłówek boksu: 4 bajty rozmiaru + 4 bajty typu.
const BOX_HEADER_LEN: usize = 8;

/// Ile poziomów zagnieżdżenia przechodzimy.
///
/// Ogranicznik istnieje po to, żeby spreparowany plik z tysiącem zagnieżdżonych
/// boksów nie przepełnił stosu. Prawdziwe metadane siedzą najwyżej trzy poziomy
/// w głąb (`moov/trak/mdia`).
const MAX_DEPTH: usize = 8;

/// Boksy najwyższego poziomu, które przepuszczamy.
///
/// Lista **dozwolonych**, tak jak przy obrazach. Przy liście zakazanych każdy
/// nowy, nieznany typ boksu przechodziłby domyślnie — czyli dokładnie ten
/// przypadek, którego chcemy uniknąć.
fn top_level_dozwolony(typ: &[u8; 4]) -> bool {
    matches!(
        typ,
        b"ftyp" | b"styp"          // identyfikacja formatu
            | b"moov" | b"mdat"    // struktura i dane obrazu
            | b"moof" | b"mfra" | b"sidx" | b"ssix"  // fragmentacja
            | b"pdin" // wskazówki do pobierania progresywnego
    )
}

/// Dzieci `moov`, które przepuszczamy.
///
/// `udta` i `meta` odpadają — to właśnie tam telefon zapisuje GPS i model
/// urządzenia. `uuid` też: pod tym typem wędruje XMP i dane producenta.
fn moov_child_dozwolony(typ: &[u8; 4]) -> bool {
    matches!(typ, b"mvhd" | b"trak" | b"mvex" | b"iods")
}

/// Dzieci `trak`, które przepuszczamy.
fn trak_child_dozwolony(typ: &[u8; 4]) -> bool {
    matches!(typ, b"tkhd" | b"mdia" | b"edts" | b"tref" | b"txas")
}

/// Usuwa metadane z pliku wideo, zostawiając obraz i dźwięk nietknięte.
///
/// Zwraca kopię, w której boksy z metadanymi zostały zamienione na `free`
/// o identycznym rozmiarze.
pub fn strip_video_metadata(bytes: &[u8]) -> Result<Vec<u8>> {
    if bytes.len() < BOX_HEADER_LEN {
        return Err(Error::InvalidInput(
            "plik jest za krótki na kontener MP4".into(),
        ));
    }

    // Pierwszy boks musi być rozpoznawalny, inaczej to nie jest MP4.
    let (_, pierwszy_typ, _) = przeczytaj_naglowek(bytes, 0, bytes.len())?;
    if &pierwszy_typ != b"ftyp" && &pierwszy_typ != b"styp" && &pierwszy_typ != b"moov" {
        return Err(Error::InvalidInput("to nie jest plik MP4 ani MOV".into()));
    }

    let mut out = bytes.to_vec();
    let koniec = out.len();
    wyczysc_poziom(&mut out, 0, koniec, Poziom::TopLevel, 0)?;

    Ok(out)
}

/// Gdzie w drzewie boksów jesteśmy — od tego zależy lista dozwolonych.
#[derive(Clone, Copy, PartialEq)]
enum Poziom {
    TopLevel,
    Moov,
    Trak,
}

fn wyczysc_poziom(
    buf: &mut [u8],
    start: usize,
    end: usize,
    poziom: Poziom,
    depth: usize,
) -> Result<()> {
    if depth > MAX_DEPTH {
        return Ok(());
    }

    let mut i = start;
    while i + BOX_HEADER_LEN <= end {
        let (rozmiar, typ, offset_zawartosci) = przeczytaj_naglowek(buf, i, end)?;
        let koniec_boksu = i + rozmiar;

        let zachowaj = match poziom {
            Poziom::TopLevel => top_level_dozwolony(&typ),
            Poziom::Moov => moov_child_dozwolony(&typ),
            Poziom::Trak => trak_child_dozwolony(&typ),
        };

        if !zachowaj {
            zamien_na_free(buf, i, koniec_boksu, offset_zawartosci);
            i = koniec_boksu;
            continue;
        }

        // Ścieżka z metadanymi czasowymi (GPS z kamer sportowych) jest
        // formalnie zwykłym `trak`, więc lista dozwolonych jej nie odsiewa.
        // Rozpoznajemy ją po typie handlera i usuwamy w całości.
        if &typ == b"trak" && sciezka_z_metadanymi(buf, offset_zawartosci, koniec_boksu) {
            zamien_na_free(buf, i, koniec_boksu, offset_zawartosci);
            i = koniec_boksu;
            continue;
        }

        match &typ {
            b"moov" => wyczysc_poziom(
                buf,
                offset_zawartosci,
                koniec_boksu,
                Poziom::Moov,
                depth + 1,
            )?,
            b"trak" => wyczysc_poziom(
                buf,
                offset_zawartosci,
                koniec_boksu,
                Poziom::Trak,
                depth + 1,
            )?,
            _ => {}
        }

        i = koniec_boksu;
    }

    Ok(())
}

/// Nadpisuje boks jako `free` i zeruje jego zawartość.
///
/// Rozmiar zostaje nietknięty — to jedyny powód, dla którego offsety w `stco`
/// pozostają prawidłowe.
fn zamien_na_free(buf: &mut [u8], start: usize, end: usize, offset_zawartosci: usize) {
    buf[start + 4..start + 8].copy_from_slice(b"free");

    // Zerujemy dane, a nie tylko przestawiamy typ: inaczej współrzędne GPS
    // dalej leżałyby w pliku, tyle że w boksie, który odtwarzacz pomija.
    // Narzędzie do odzyskiwania danych znalazłoby je bez trudu.
    for bajt in &mut buf[offset_zawartosci..end] {
        *bajt = 0;
    }
}

/// Czy ten `trak` niesie metadane zamiast obrazu lub dźwięku.
///
/// Sprawdzamy `trak/mdia/hdlr`: pole `handler_type` równe `meta` oznacza
/// ścieżkę z metadanymi czasowymi. Kamery sportowe zapisują tam pełny przebieg
/// trasy GPS, więc pominięcie tego przypadku zostawiałoby największy wyciek
/// z możliwych.
fn sciezka_z_metadanymi(buf: &[u8], start: usize, end: usize) -> bool {
    let Some(mdia) = znajdz_boks(buf, start, end, b"mdia") else {
        return false;
    };
    let Some(hdlr) = znajdz_boks(buf, mdia.0, mdia.1, b"hdlr") else {
        return false;
    };

    // Zawartość `hdlr`: wersja i flagi (4 B), pre_defined (4 B), handler_type (4 B).
    let offset_typu = hdlr.0 + 8;
    if offset_typu + 4 > hdlr.1 {
        return false;
    }

    matches!(&buf[offset_typu..offset_typu + 4], b"meta" | b"mebx")
}

/// Szuka boksu danego typu wśród bezpośrednich dzieci. Zwraca zakres zawartości.
fn znajdz_boks(buf: &[u8], start: usize, end: usize, szukany: &[u8; 4]) -> Option<(usize, usize)> {
    let mut i = start;
    while i + BOX_HEADER_LEN <= end {
        let (rozmiar, typ, offset_zawartosci) = przeczytaj_naglowek(buf, i, end).ok()?;
        if &typ == szukany {
            return Some((offset_zawartosci, i + rozmiar));
        }
        i += rozmiar;
    }
    None
}

/// Czyta nagłówek boksu: zwraca (rozmiar całkowity, typ, offset zawartości).
///
/// Dane wejściowe są wrogie z założenia, więc każda niespójność kończy się
/// błędem, nigdy paniką ani zapętleniem.
fn przeczytaj_naglowek(buf: &[u8], i: usize, end: usize) -> Result<(usize, [u8; 4], usize)> {
    if i + BOX_HEADER_LEN > end {
        return Err(Error::InvalidInput("obcięty nagłówek boksu".into()));
    }

    let deklarowany = u32::from_be_bytes([buf[i], buf[i + 1], buf[i + 2], buf[i + 3]]) as usize;
    let typ: [u8; 4] = [buf[i + 4], buf[i + 5], buf[i + 6], buf[i + 7]];

    let (rozmiar, offset_zawartosci) = match deklarowany {
        // 0 oznacza „do końca danych" — dozwolone tylko dla ostatniego boksu.
        0 => (end - i, i + BOX_HEADER_LEN),

        // 1 oznacza rozmiar 64-bitowy zapisany zaraz za typem.
        1 => {
            if i + 16 > end {
                return Err(Error::InvalidInput("obcięty rozmiar 64-bitowy".into()));
            }
            let duzy = u64::from_be_bytes([
                buf[i + 8],
                buf[i + 9],
                buf[i + 10],
                buf[i + 11],
                buf[i + 12],
                buf[i + 13],
                buf[i + 14],
                buf[i + 15],
            ]);
            let rozmiar = usize::try_from(duzy)
                .map_err(|_| Error::InvalidInput("rozmiar boksu poza zakresem".into()))?;
            (rozmiar, i + 16)
        }

        // Rozmiar mniejszy od nagłówka zapętliłby przechodzenie pliku.
        n if n < BOX_HEADER_LEN => {
            return Err(Error::InvalidInput("rozmiar boksu poniżej minimum".into()));
        }

        n => (n, i + BOX_HEADER_LEN),
    };

    if i + rozmiar > end || offset_zawartosci > i + rozmiar {
        return Err(Error::InvalidInput(
            "boks wykracza poza swój kontener".into(),
        ));
    }

    Ok((rozmiar, typ, offset_zawartosci))
}

#[cfg(test)]
mod tests {
    use super::*;

    /// Buduje boks: [rozmiar][typ][zawartość].
    fn boks(typ: &[u8; 4], zawartosc: &[u8]) -> Vec<u8> {
        let rozmiar = (BOX_HEADER_LEN + zawartosc.len()) as u32;
        let mut b = rozmiar.to_be_bytes().to_vec();
        b.extend_from_slice(typ);
        b.extend_from_slice(zawartosc);
        b
    }

    /// Nagranie z telefonu: GPS w `moov/udta`, obraz w `mdat`.
    fn nagranie_z_gps() -> Vec<u8> {
        let udta = boks(b"udta", b"\xa9xyz+52.2297+021.0122/\xa9mak Apple iPhone");
        let mvhd = boks(b"mvhd", &[0u8; 100]);
        let trak = boks(b"trak", &boks(b"tkhd", &[0u8; 84]));

        let mut wnetrze_moov = mvhd;
        wnetrze_moov.extend_from_slice(&trak);
        wnetrze_moov.extend_from_slice(&udta);

        let mut plik = boks(b"ftyp", b"isom\0\0\x02\0isomiso2avc1mp41");
        plik.extend_from_slice(&boks(b"moov", &wnetrze_moov));
        plik.extend_from_slice(&boks(b"mdat", b"UDAWANE-KLATKI-WIDEO"));
        plik
    }

    fn zawiera(stog: &[u8], igla: &[u8]) -> bool {
        stog.windows(igla.len()).any(|okno| okno == igla)
    }

    #[test]
    fn gps_z_udta_znika() {
        let oryginal = nagranie_z_gps();
        assert!(
            zawiera(&oryginal, b"+52.2297+021.0122"),
            "test bez sensu bez GPS-u"
        );

        let oczyszczony = strip_video_metadata(&oryginal).unwrap();

        assert!(
            !zawiera(&oczyszczony, b"+52.2297+021.0122"),
            "współrzędne przetrwały"
        );
        assert!(
            !zawiera(&oczyszczony, b"Apple iPhone"),
            "model urządzenia przetrwał"
        );
    }

    /// Sedno: rozmiar pliku i offsety muszą zostać nietknięte.
    #[test]
    fn rozmiar_pliku_i_offset_mdat_nie_zmieniaja_sie() {
        let oryginal = nagranie_z_gps();
        let oczyszczony = strip_video_metadata(&oryginal).unwrap();

        assert_eq!(
            oczyszczony.len(),
            oryginal.len(),
            "zmiana rozmiaru przesunęłaby offsety w stco i zepsuła odtwarzanie"
        );

        let pozycja = |plik: &[u8]| {
            plik.windows(4)
                .position(|okno| okno == b"mdat")
                .expect("brak mdat")
        };
        assert_eq!(
            pozycja(&oczyszczony),
            pozycja(&oryginal),
            "mdat się przesunął"
        );
    }

    #[test]
    fn obraz_i_struktura_przezywaja_czyszczenie() {
        let oczyszczony = strip_video_metadata(&nagranie_z_gps()).unwrap();

        assert!(
            zawiera(&oczyszczony, b"UDAWANE-KLATKI-WIDEO"),
            "utracono dane obrazu"
        );
        assert!(zawiera(&oczyszczony, b"ftyp"), "utracono nagłówek formatu");
        assert!(zawiera(&oczyszczony, b"moov"), "utracono strukturę");
        assert!(zawiera(&oczyszczony, b"mvhd"), "utracono nagłówek filmu");
        assert!(zawiera(&oczyszczony, b"tkhd"), "utracono nagłówek ścieżki");
    }

    /// Nie wystarczy przestawić typ boksu — dane trzeba wyzerować, bo inaczej
    /// leżą dalej w pliku i odzyskuje je pierwsze lepsze narzędzie.
    #[test]
    fn zawartosc_usunietego_boksu_jest_wyzerowana() {
        let oczyszczony = strip_video_metadata(&nagranie_z_gps()).unwrap();

        let pozycja = oczyszczony
            .windows(4)
            .position(|okno| okno == b"free")
            .expect("brak boksu free");

        // Za nagłówkiem `free` muszą być same zera.
        let po_naglowku = pozycja + 4;
        assert!(
            oczyszczony[po_naglowku..po_naglowku + 16]
                .iter()
                .all(|&b| b == 0),
            "zawartość usuniętego boksu nie została wyzerowana"
        );
    }

    #[test]
    fn boks_uuid_z_xmp_znika() {
        let mut plik = boks(b"ftyp", b"isom");
        plik.extend_from_slice(&boks(b"uuid", b"XMP-Z-LOKALIZACJA-51.1079N"));
        plik.extend_from_slice(&boks(b"mdat", b"KLATKI"));

        let oczyszczony = strip_video_metadata(&plik).unwrap();

        assert!(!zawiera(&oczyszczony, b"51.1079N"), "XMP w uuid przetrwał");
        assert!(zawiera(&oczyszczony, b"KLATKI"), "utracono obraz");
    }

    /// Kamery sportowe zapisują przebieg trasy jako osobną ścieżkę z metadanymi
    /// czasowymi. To największy możliwy wyciek — GPS co sekundę przez całe
    /// nagranie — a formalnie jest to zwykły `trak`.
    #[test]
    fn sciezka_z_metadanymi_czasowymi_znika() {
        let hdlr_meta = boks(b"hdlr", b"\0\0\0\0\0\0\0\0meta\0\0\0\0GPS");
        let mdia_meta = boks(b"mdia", &hdlr_meta);
        let trak_meta = boks(b"trak", &[boks(b"tkhd", &[0u8; 84]), mdia_meta].concat());

        let hdlr_wideo = boks(b"hdlr", b"\0\0\0\0\0\0\0\0vide\0\0\0\0obraz");
        let mdia_wideo = boks(b"mdia", &hdlr_wideo);
        let trak_wideo = boks(b"trak", &[boks(b"tkhd", &[0u8; 84]), mdia_wideo].concat());

        let moov = boks(
            b"moov",
            &[boks(b"mvhd", &[0u8; 100]), trak_wideo, trak_meta].concat(),
        );

        let mut plik = boks(b"ftyp", b"isom");
        plik.extend_from_slice(&moov);
        plik.extend_from_slice(&boks(b"mdat", b"KLATKI"));

        let oczyszczony = strip_video_metadata(&plik).unwrap();

        assert!(
            !zawiera(&oczyszczony, b"GPS"),
            "ścieżka z metadanymi przetrwała"
        );
        // Ścieżka obrazu musi zostać — inaczej nie ma czego odtwarzać.
        assert!(zawiera(&oczyszczony, b"vide"), "usunięto ścieżkę obrazu");
        assert!(zawiera(&oczyszczony, b"obraz"), "usunięto ścieżkę obrazu");
    }

    #[test]
    fn czyszczenie_jest_idempotentne() {
        let raz = strip_video_metadata(&nagranie_z_gps()).unwrap();
        let dwa = strip_video_metadata(&raz).unwrap();
        assert_eq!(raz, dwa);
    }

    #[test]
    fn plik_ktory_nie_jest_mp4_jest_odrzucany() {
        assert!(strip_video_metadata(b"to zwykly tekst, nie wideo").is_err());
        assert!(strip_video_metadata(&[0xFF, 0xD8, 0xFF, 0xE0, 0, 0, 0, 0]).is_err());
    }

    /// Spreparowane pliki nie mogą wywrócić klienta ani go zapętlić.
    #[test]
    fn uszkodzone_pliki_nie_powoduja_paniki_ani_zapetlenia() {
        let przypadki: Vec<Vec<u8>> = vec![
            vec![],
            vec![0; 4],
            boks(b"ftyp", b"isom"),
            // Rozmiar 0 w środku pliku.
            [
                boks(b"ftyp", b"isom"),
                vec![0, 0, 0, 0, b'm', b'o', b'o', b'v'],
            ]
            .concat(),
            // Rozmiar poniżej nagłówka — zapętliłby naiwny parser.
            [
                boks(b"ftyp", b"isom"),
                vec![0, 0, 0, 3, b'm', b'o', b'o', b'v'],
            ]
            .concat(),
            // Rozmiar większy niż plik.
            [
                boks(b"ftyp", b"isom"),
                vec![0xFF, 0xFF, 0xFF, 0xFF, b'm', b'o', b'o', b'v'],
            ]
            .concat(),
            // Zapowiedziany rozmiar 64-bitowy bez danych.
            [
                boks(b"ftyp", b"isom"),
                vec![0, 0, 0, 1, b'm', b'o', b'o', b'v'],
            ]
            .concat(),
            // Głęboko zagnieżdżone moov.
            (0..40).fold(boks(b"ftyp", b"isom"), |acc, _| boks(b"moov", &acc)),
        ];

        for dane in przypadki {
            let _ = strip_video_metadata(&dane);
        }
    }
}
