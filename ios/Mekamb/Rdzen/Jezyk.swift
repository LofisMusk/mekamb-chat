import Foundation
import Observation

/// Język interfejsu.
///
/// # Dlaczego przełącznik, a nie napis dwujęzyczny
///
/// Web ma przełącznik PL/EN (`web/src/lib/jezyk.ts`), Android też (`Jezyk.kt`):
/// jedna etykieta, którą przełącznik zamienia. Ekrany nie trzymają słowników —
/// wołają `t(pl, en)`, które oddaje właściwą połowę. Para stoi w miejscu użycia,
/// więc nie ma klucza, który mógłby wskazać nieistniejące tłumaczenie.
enum Jezyk: String, CaseIterable, Sendable {
    case pl
    case en

    var etykieta: String { rawValue.uppercased() }

    var locale: Locale { Locale(identifier: self == .pl ? "pl_PL" : "en_US") }
}

/// Motyw: zapisujemy WYBÓR, nie jego wynik.
///
/// `auto` jest rozstrzygane przy rysowaniu. Zapisanie rozstrzygniętej wartości
/// zostawiłoby aplikację jasną na zawsze komuś, czyj telefon wieczorem przeszedł
/// w ciemny — a ten ktoś prosił o „jak system", nie o „jasny".
enum Motyw: String, CaseIterable, Sendable {
    case auto
    case jasny
    case ciemny
}

/// Preferencje urządzenia: język, motyw, potwierdzenia odczytu.
///
/// `@Observable`, bo `t(pl, en)` czyta `jezyk` w trakcie rysowania widoku —
/// SwiftUI śledzi ten odczyt i przerysowuje wszystko, co go dotknęło, gdy
/// przełącznik zmieni język. Bez przebudowywania drzewa na siłę (`.id`), które
/// gubiłoby stos nawigacji.
@MainActor
@Observable
final class Preferencje {
    static let wspolne = Preferencje()

    @ObservationIgnored private let ustawienia: UserDefaults

    var jezyk: Jezyk {
        didSet {
            ustawienia.set(jezyk.rawValue, forKey: "mekamb.jezyk")
            JezykBiezacy.ustaw(jezyk)
        }
    }

    var motyw: Motyw {
        didSet { ustawienia.set(motyw.rawValue, forKey: "mekamb.motyw") }
    }

    /// Czy wysyłamy potwierdzenia odczytu.
    ///
    /// Ustawienie nie jedzie na serwer: sam fakt, czy ktoś je wysyła, jest
    /// metadaną o nim. **Wyłączenie działa w obie strony** — nie wysyłamy i nie
    /// pokazujemy cudzych; pokazywanie cudzych odczytów komuś, kto własnych nie
    /// oddaje, byłoby jednostronną wymianą (tak samo `PotwierdzeniaOdczytu` na Androidzie).
    var potwierdzeniaOdczytu: Bool {
        didSet { ustawienia.set(potwierdzeniaOdczytu, forKey: "mekamb.potwierdzenia-odczytu") }
    }

    init(ustawienia: UserDefaults = .standard) {
        self.ustawienia = ustawienia
        let domyslny: Jezyk = Locale.preferredLanguages.first?.hasPrefix("pl") == false ? .en : .pl
        let jezyk = Jezyk(rawValue: ustawienia.string(forKey: "mekamb.jezyk") ?? "") ?? domyslny
        self.jezyk = jezyk
        self.motyw = Motyw(rawValue: ustawienia.string(forKey: "mekamb.motyw") ?? "") ?? .auto
        self.potwierdzeniaOdczytu = ustawienia.object(forKey: "mekamb.potwierdzenia-odczytu") as? Bool ?? true
        JezykBiezacy.ustaw(jezyk)
    }
}

/// Bieżący język dla kodu poza wątkiem głównym (formatowanie dat w modelu).
enum JezykBiezacy {
    nonisolated(unsafe) private static var wartosc: Jezyk = .pl
    private static let zamek = NSLock()

    static func ustaw(_ jezyk: Jezyk) {
        zamek.lock()
        wartosc = jezyk
        zamek.unlock()
    }

    static var biezacy: Jezyk {
        zamek.lock()
        defer { zamek.unlock() }
        return wartosc
    }
}

/// Wybiera połowę pary językowej według bieżącego wyboru — śledzone przez SwiftUI.
@MainActor
func t(_ pl: String, _ en: String) -> String {
    Preferencje.wspolne.jezyk == .pl ? pl : en
}

/// Wariant z jawnym językiem — dla miejsc, które nie są widokiem.
func t(_ jezyk: Jezyk, _ pl: String, _ en: String) -> String {
    jezyk == .pl ? pl : en
}

extension BladAplikacji {
    @MainActor var tekst: String { t(pl, en) }
}
