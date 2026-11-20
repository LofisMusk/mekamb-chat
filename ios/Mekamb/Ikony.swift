// PLIK GENEROWANY — nie edytuj ręcznie.
//
// Źródłem jest `design/ikony.mjs`; ten plik powstaje z `node design/generuj.mjs`.
// Poprawka wpisana tutaj zniknie przy najbliższym generowaniu, a test
// `web/src/lib/ikony.test.ts` wywali się, zanim zdąży komukolwiek pomóc.
//
// Zestaw: 51 ikon, płótno 24×24, kontur 1,8.
// Ścieżki zostają w notacji SVG i są czytane w czasie działania przez
// `SciezkaSvg` — dokładnie te same napisy co w webie i na Androidzie.

import CoreGraphics

/// Nazwy ikon. Zamknięty zbiór — literówka jest błędem kompilacji, nie pustym miejscem.
enum NazwaIkony: String, CaseIterable, Sendable {
    /// Powrót o krok. Ta sama akcja co gest i systemowe „wstecz”.
    case wstecz
    /// Wejście głębiej — wiersz, który coś otwiera.
    case naprzod
    /// Sekcja, która się rozkłada. Obrócenie o 180° znaczy „złożona”.
    case rozwin
    /// Zamknięcie panelu albo odrzucenie komunikatu.
    case zamknij
    /// Akcje, które nie mieszczą się w pasku. Nigdy jedyna droga do akcji.
    case wiecej
    /// Gałąź nawigacji: lista rozmów.
    case rozmowy
    /// Gałąź nawigacji: rozpoczęcie rozmowy z nazwy użytkownika.
    case kontakty
    /// Gałąź nawigacji: konto i klucze na tym urządzeniu.
    case konto
    /// Ustawienia. Suwaki, nie koło zębate — ustawia się tu wartości, nie mechanizm.
    case suwaki
    /// Szukanie na liście rozmów.
    case szukaj
    /// Dodanie: osoby do rozmowy, urządzenia do konta, nowej rozmowy.
    case dodaj
    /// Uczestnicy rozmowy. Liczba osób jest tu informacją o tym, kto odszyfruje wiadomość.
    case osoby
    /// Wysłanie wiadomości.
    case wyslij
    /// Załącznik. Przy polu pisania, nie nad nim — załącznik jest dodatkiem do rozmowy.
    case spinacz
    /// Zrobienie zdjęcia albo skanowanie kodu QR.
    case aparat
    /// Załącznik będący obrazem — przed pobraniem widać tylko to.
    case zdjecie
    /// Załącznik będący nagraniem.
    case film
    /// Załącznik, którego nie umiemy pokazać w rozmowie.
    case plik
    /// Pobranie załącznika na urządzenie — dopiero wtedy opuszcza on aplikację.
    case pobierz
    /// Skopiowanie kodu albo nazwy do schowka.
    case kopiuj
    /// Skasowanie nieodwracalne. Historii nie ma nigdzie indziej.
    case kosz
    /// Wiadomość w locie — wysyłka trwa. Przy próbie bezpośredniej to kilka sekund.
    case zegar
    /// Wiadomość opuściła urządzenie.
    case wyslane
    /// Wiadomość leży w skrzynce odbiorcy. Nie znaczy „przeczytana” — tego serwer nie wie.
    case dostarczone
    /// Wysyłka się nie udała. Treść nie przepada — zawiodła sieć, nie użytkownik.
    case niepowodzenie
    /// Rozmowa głosowa.
    case sluchawka
    /// Zakończenie rozmowy. Osobny kształt, nie przekreślona słuchawka — przekreślenie znaczy tu wyciszenie.
    case rozlacz
    /// Rozmowa z obrazem.
    case kamera
    /// Obraz wyłączony — rozmówca nie widzi kamery tego urządzenia.
    case kameraWylaczona
    /// Mikrofon otwarty.
    case mikrofon
    /// Mikrofon wyciszony — nic nie idzie do rozmówcy.
    case mikrofonWyciszony
    /// Dźwięk rozmowy na głośniku zamiast przy uchu.
    case glosnik
    /// Znak firmowy — ten sam co ikona aplikacji. Mówi, gdzie jesteś, i nic ponadto.
    case marka
    /// Ochrona danych: szyfrowanie end-to-end i usuwanie metadanych z plików.
    case tarcza
    /// Materiał kryptograficzny, który zostaje na urządzeniu. Serwer nie ma czego wydać ani zgubić.
    case klucz
    /// Kod bezpieczeństwa. Zgodny po obu stronach znaczy, że nikt się nie wciął.
    case odcisk
    /// Rzecz zamknięta hasłem albo passkeyem.
    case blokada
    /// Zablokowanie osoby — jej wiadomości i zaproszenia nie docierają do Ciebie.
    case blokuj
    /// Wyjście z grupy — przestajesz być jej członkiem, u wszystkich.
    case opusc
    /// Parowanie urządzenia i sekret TOTP — dane, których nie przepisuje się ręcznie.
    case kodQr
    /// Stan, z którym trzeba coś zrobić — np. magazyn, który system może skasować.
    case ostrzezenie
    /// Wyjaśnienie tego, co dzieje się z danymi. Nie wymaga reakcji.
    case info
    /// Usunięcie konta z tego urządzenia. Razem z nim znika historia.
    case wyloguj
    /// Droga wprost do urządzenia. Nie ozdoba: gdy widnieje przy rozmowie, rozmówca zna Twój adres IP.
    case bezposrednio
    /// Droga przez skrzynkę na serwerze. Serwer widzi metadane, nie treść.
    case przezSerwer
    /// Brak połączenia. Wiadomości nie przychodzą i użytkownik ma prawo wiedzieć dlaczego.
    case brakSieci
    /// Ponowienie próby po nieudanym połączeniu.
    case odswiez
    /// Powiadomienia.
    case dzwonek
    /// Motyw jasny.
    case slonce
    /// Motyw ciemny — domyślny w tym systemie.
    case ksiezyc
    /// Motyw zgodny z ustawieniem systemu.
    case ekran

    /// Ścieżka konturu na płótnie 24×24.
    var sciezka: String {
        switch self {
        case .wstecz: "M15 5 L8 12 L15 19"
        case .naprzod: "M9 5 L16 12 L9 19"
        case .rozwin: "M6 9.5 L12 15.5 L18 9.5"
        case .zamknij: "M6.5 6.5 L17.5 17.5 M17.5 6.5 L6.5 17.5"
        case .wiecej:
            "M12 5.1 A1 1 0 1 0 12 7.1 A1 1 0 1 0 12 5.1 Z" +
            " M12 11 A1 1 0 1 0 12 13 A1 1 0 1 0 12 11 Z" +
            " M12 16.9 A1 1 0 1 0 12 18.9 A1 1 0 1 0 12 16.9 Z"
        case .rozmowy: "M4 6 H20 V16 H10 L5.5 19.5 V16 H4 Z"
        case .kontakty:
            "M6 4 H19 V20 H6 Z M6 8 H3.5 M6 12 H3.5 M6 16 H3.5" +
            " M12.5 11.5 A2 2 0 1 0 12.5 7.5 A2 2 0 1 0 12.5 11.5 Z" +
            " M9 16.5 C9 14.5 10.5 13.5 12.5 13.5 C14.5 13.5 16 14.5 16 16.5"
        case .konto:
            "M12 3 A9 9 0 1 0 12 21 A9 9 0 1 0 12 3 Z M12 12 A3 3 0 1 0 12 6 A3 3 0 1 0 12 12 Z" +
            " M6.5 18.5 C7.5 15.5 9.5 14.5 12 14.5 C14.5 14.5 16.5 15.5 17.5 18.5"
        case .suwaki: "M4 7 H20 M4 12 H20 M4 17 H20 M9 5 V9 M15 10 V14 M7 15 V19"
        case .szukaj: "M10.5 4 A6.5 6.5 0 1 0 10.5 17 A6.5 6.5 0 1 0 10.5 4 M15.5 15.5 L20 20"
        case .dodaj: "M12 5 V19 M5 12 H19"
        case .osoby:
            "M9.5 11.5 A3 3 0 1 0 9.5 5.5 A3 3 0 1 0 9.5 11.5 Z" +
            " M3.5 19 C4.5 15.5 6.5 14 9.5 14 C12.5 14 14.5 15.5 15.5 19" +
            " M15.5 5.9 A3 3 0 0 1 15.5 11.1 M17 14.3 C19 15.1 20 16.6 20.5 19"
        case .wyslij: "M4 11.5 L20 4 L12.5 20 L11 13 Z M11 13 L20 4"
        case .spinacz:
            "M17 8.5 L10 15.5 A2.5 2.5 0 0 0 13.5 19 L20 12.5 A5 5 0 0 0 13 5.5 L6.5 12" +
            " A7.5 7.5 0 0 0 17 22.5"
        case .aparat:
            "M3.5 7.5 H7 L8.5 5.5 H15.5 L17 7.5 H20.5 V18.5 H3.5 Z" +
            " M12 16 A3.5 3.5 0 1 0 12 9 A3.5 3.5 0 1 0 12 16 Z"
        case .zdjecie:
            "M3.5 5.5 H20.5 V18.5 H3.5 Z M3.5 15.5 L8.5 10.5 L13 15" +
            " M12.5 15.5 L15.5 12.5 L20.5 17" +
            " M15.8 8 A1.3 1.3 0 1 0 15.8 10.6 A1.3 1.3 0 1 0 15.8 8 Z"
        case .film: "M3.5 6 H20.5 V18 H3.5 Z M8 6 V18 M16 6 V18 M3.5 12 H8 M16 12 H20.5"
        case .plik: "M6 3.5 H14 L18 7.5 V20.5 H6 Z M14 3.5 V7.5 H18"
        case .pobierz: "M12 4 V15 M7.5 10.5 L12 15 L16.5 10.5 M5 19 H19"
        case .kopiuj: "M8.5 8.5 H19.5 V19.5 H8.5 Z M15.5 8.5 V4.5 H4.5 V15.5 H8.5"
        case .kosz:
            "M4.5 7 H19.5 M9.5 7 V4.5 H14.5 V7 M6.5 7 L7.5 20 H16.5 L17.5 7 M10 10.5 V16.5" +
            " M14 10.5 V16.5"
        case .zegar: "M12 3.5 A8.5 8.5 0 1 0 12 20.5 A8.5 8.5 0 1 0 12 3.5 Z M12 7.5 V12.2 L15.5 14.2"
        case .wyslane: "M5 12.5 L9.5 17 L19 6.5"
        case .dostarczone: "M3 12.5 L7 16.5 L15 6.5 M11 15.5 L12.5 17 L21 6.5"
        case .niepowodzenie: "M12 3.5 A8.5 8.5 0 1 0 12 20.5 A8.5 8.5 0 1 0 12 3.5 Z M12 7.5 V13 M12 16.3 V16.5"
        case .sluchawka:
            "M6 3.5 L9 4.5 L10 8.5 L8 10 C9 12.5 11.5 15 14 16 L15.5 14 L19.5 15 L20.5 18" +
            " C20.5 19.5 19 20.5 17.5 20.5 C10 20.5 3.5 14 3.5 6.5 C3.5 5 4.5 3.5 6 3.5 Z"
        case .rozlacz:
            "M3.5 15 A12 12 0 0 1 20.5 15 L18 17.5 L14.6 15.3 V12.6 A9 9 0 0 0 9.4 12.6 V15.3" +
            " L6 17.5 Z"
        case .kamera: "M3.5 7 H14 V17 H3.5 Z M14 11 L20.5 7.5 V16.5 L14 13 Z"
        case .kameraWylaczona: "M3.5 7 H14 V17 H3.5 Z M14 11 L20.5 7.5 V16.5 L14 13 Z M4 4 L20 20"
        case .mikrofon:
            "M12 3.5 A2.5 2.5 0 0 1 14.5 6 V11.5 A2.5 2.5 0 0 1 9.5 11.5 V6" +
            " A2.5 2.5 0 0 1 12 3.5 Z M6.5 11 A5.5 5.5 0 0 0 17.5 11 M12 16.5 V20 M9 20 H15"
        case .mikrofonWyciszony:
            "M12 3.5 A2.5 2.5 0 0 1 14.5 6 V11.5 A2.5 2.5 0 0 1 9.5 11.5 V6" +
            " A2.5 2.5 0 0 1 12 3.5 Z M6.5 11 A5.5 5.5 0 0 0 17.5 11 M12 16.5 V20 M9 20 H15" +
            " M4 4 L20 20"
        case .glosnik:
            "M4 9.5 H7.5 L12 5.5 V18.5 L7.5 14.5 H4 Z M15 9.8 A4 4 0 0 1 15 14.2" +
            " M17.5 7 A7.5 7.5 0 0 1 17.5 17"
        case .marka:
            "M4 8.5 V4 H9 M15 4 H20 V8.5 M20 15.5 V20 H15 M9 20 H4 V15.5" +
            " M8.5 16 V8 L12 12.5 L15.5 8 V16"
        case .tarcza:
            "M12 3 L20 6 V12 C20 16.5 16.5 19.8 12 21 C7.5 19.8 4 16.5 4 12 V6 Z" +
            " M9 12 L11 14 L15.5 9.5"
        case .klucz:
            "M14.5 5.5 A4 4 0 1 1 11 12.2 L10 13.2 H8 V15.2 H6 V17.2 H3.5 V14.7 L10 8.2" +
            " A4 4 0 0 1 14.5 5.5 Z"
        case .odcisk:
            "M12 4 A8 8 0 0 0 4 12 M12 4 A8 8 0 0 1 20 12 M7.5 12 A4.5 4.5 0 0 1 16.5 12 V15" +
            " M12 12 V18 M7.5 15 V17.5"
        case .blokada: "M6.5 10.5 H17.5 V20 H6.5 Z M8.5 10.5 V7.5 A3.5 3.5 0 0 1 15.5 7.5 V10.5 M12 14 V16.5"
        case .blokuj: "M12 4 A8 8 0 1 0 12 20 A8 8 0 1 0 12 4 Z M6.35 6.35 L17.65 17.65"
        case .opusc:
            "M11 5 H5.5 A1.5 1.5 0 0 0 4 6.5 V17.5 A1.5 1.5 0 0 0 5.5 19 H11 M12.5 12 H20.5" +
            " M17.5 9 L20.5 12 L17.5 15"
        case .kodQr:
            "M4 4 H9 V9 H4 Z M15 4 H20 V9 H15 Z M4 15 H9 V20 H4 Z M15 15 H17 M19 15 H20" +
            " M15 17 V20 M17 19 H20"
        case .ostrzezenie: "M12 4 L21 19.5 H3 Z M12 9.5 V14 M12 16.8 V17"
        case .info: "M12 3.5 A8.5 8.5 0 1 0 12 20.5 A8.5 8.5 0 1 0 12 3.5 Z M12 11 V16.5 M12 7.4 V7.6"
        case .wyloguj: "M15 8 V5 H4.5 V19 H15 V16 M9.5 12 H20.5 M17.5 9 L20.5 12 L17.5 15"
        case .bezposrednio: "M13 3 L5 13 H11 L10 21 L19 10 H12.5 Z"
        case .przezSerwer: "M7.5 18.5 A4.5 4.5 0 0 1 7.5 9.5 A6 6 0 0 1 18.5 10.2 A4.2 4.2 0 0 1 17.5 18.5 Z"
        case .brakSieci:
            "M7.5 18.5 A4.5 4.5 0 0 1 7.5 9.5 A6 6 0 0 1 18.5 10.2 A4.2 4.2 0 0 1 17.5 18.5 Z" +
            " M4 4 L20 20"
        case .odswiez: "M18.4 18.4 A9 9 0 1 1 18.4 5.6 M16.4 9.6 H21 V5"
        case .dzwonek: "M6 17 V11 A6 6 0 0 1 18 11 V17 H19.5 H4.5 Z M10 20 H14"
        case .slonce:
            "M12 8 A4 4 0 1 0 12 16 A4 4 0 1 0 12 8 Z M12 3.2 V5.2 M12 18.8 V20.8 M3.2 12 H5.2" +
            " M18.8 12 H20.8 M5.8 5.8 L7.2 7.2 M16.8 16.8 L18.2 18.2 M18.2 5.8 L16.8 7.2" +
            " M7.2 16.8 L5.8 18.2"
        case .ksiezyc: "M20.2 14.6 A8.6 8.6 0 1 1 9.4 3.8 A7 7 0 0 0 20.2 14.6 Z"
        case .ekran: "M3.5 5 H20.5 V16 H3.5 Z M9 20 H15 M12 16 V20"
        }
    }
}

/// Parametry rysunku wspólne dla całego zestawu.
enum Ikony {
    /// Grubość konturu. Jedna dla całego zestawu; różne grubości czyta się jak dwa zestawy.
    static let grubosc: CGFloat = 1.8
    /// Bok płótna.
    static let plotno: CGFloat = 24
}
