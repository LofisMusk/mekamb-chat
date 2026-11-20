import Foundation

/// Zbieranie i opóźnianie potwierdzeń.
///
/// # Dlaczego to nie leci od razu
///
/// Potwierdzenie jest zaszyfrowane kanałem MLS, więc serwer nie wie, CO to jest.
/// Ale wie, KIEDY poszło — a potwierdzenie odczytu wysłane natychmiast jest
/// czytelne z samego ruchu: „urządzenie B nadało kopertę cztery sekundy po
/// wiadomości od A". Dlatego zbieramy je i wysyłamy paczką po **losowym**
/// opóźnieniu. Losowym, nie stałym: stałe przesuwa korelację, zamiast ją zrywać.
///
/// Granice są te same co w `Potwierdzenia.kt` i `web/src/lib/potwierdzenia.ts` —
/// rozjazd znaczyłby, że jedna platforma ujawnia więcej niż druga przy tej
/// samej obietnicy w interfejsie.

/// Dolna i górna granica opóźnienia. Górna z decyzji: do 30 sekund.
let minOpoznienieMs: UInt64 = 3_000
let maxOpoznienieMs: UInt64 = 30_000

/// Losuje opóźnienie z przedziału [min, max). Generator jako parametr — dla testu.
func losoweOpoznienie<G: RandomNumberGenerator>(los: inout G) -> UInt64 {
    UInt64.random(in: minOpoznienieMs..<maxOpoznienieMs, using: &los)
}

func losoweOpoznienie() -> UInt64 {
    var systemowy = SystemRandomNumberGenerator()
    return losoweOpoznienie(los: &systemowy)
}

/// Stan wysyłki własnej wiadomości. Rośnie tylko w jedną stronę.
///
/// # Zapis w historii
///
/// Wartości zapisujemy małymi literami — tak, jak typ `StanWiadomosci` w webie
/// (`"wyslane" | "dostarczone" | "przeczytane"`). Android (kotlinx bez
/// `@SerialName`) zapisuje te same stany WIELKIMI literami, więc odczyt przyjmuje
/// oba zapisy: historia przeniesiona z dowolnego klienta ma zachować ptaszki.
enum StanWiadomosci: Int, Comparable, Sendable {
    case wyslane = 0
    case dostarczone = 1
    case przeczytane = 2

    static func < (a: Self, b: Self) -> Bool { a.rawValue < b.rawValue }

    /// Wyższy z dwóch — spóźniona paczka „dostarczone" nie cofa „przeczytane".
    func wyzszy(_ inny: StanWiadomosci) -> StanWiadomosci { max(self, inny) }

    var zapis: String {
        switch self {
        case .wyslane: "wyslane"
        case .dostarczone: "dostarczone"
        case .przeczytane: "przeczytane"
        }
    }

    /// `nil` dla stanów, które nie są faktem o doręczeniu (web zna jeszcze
    /// „w-locie" i „nieudana" — to stan ekranu, nie wiadomości).
    init?(zapis: String) {
        switch zapis.lowercased() {
        case "wyslane": self = .wyslane
        case "dostarczone": self = .dostarczone
        case "przeczytane": self = .przeczytane
        default: return nil
        }
    }
}

/// Paczka gotowa do wysłania: jedna rozmowa, jeden rodzaj, wiele wiadomości.
struct PaczkaPotwierdzen: Equatable, Sendable {
    let groupId: Data
    let rodzaj: ReceiptKind
    let identyfikatory: [Data]
}

/// Zbieracz potwierdzeń.
///
/// Czysty: nic nie wysyła i nie zna czasu. Trzyma, co się nazbierało, i oddaje
/// to na żądanie — dzięki temu reguły dają się sprawdzić bez zegara i sieci.
struct ZbieraczPotwierdzen {
    /// Klucz rozmowy → rodzaj → identyfikatory (hex), w kolejności dodania.
    private var oczekujace: [(klucz: String, groupId: Data, przeczytane: [String], dostarczone: [String])] = []

    private mutating func indeks(_ groupId: Data) -> Int {
        let klucz = groupId.hex
        if let i = oczekujace.firstIndex(where: { $0.klucz == klucz }) { return i }
        oczekujace.append((klucz, groupId, [], []))
        return oczekujace.count - 1
    }

    /// Dokłada potwierdzenie.
    ///
    /// `read` pochłania `delivered` dla tej samej wiadomości: odczyt mówi
    /// wszystko, co dostarczenie, a każda koperta to sygnał w ruchu.
    mutating func dodaj(groupId: Data, rodzaj: ReceiptKind, identyfikator: Data) {
        let i = indeks(groupId)
        let id = identyfikator.hex

        switch rodzaj {
        case .read:
            oczekujace[i].dostarczone.removeAll { $0 == id }
            if !oczekujace[i].przeczytane.contains(id) { oczekujace[i].przeczytane.append(id) }
        case .delivered:
            // Dostarczenie po odczycie nie wnosi nic.
            if oczekujace[i].przeczytane.contains(id) { return }
            if !oczekujace[i].dostarczone.contains(id) { oczekujace[i].dostarczone.append(id) }
        }
    }

    var pusty: Bool {
        oczekujace.allSatisfy { $0.przeczytane.isEmpty && $0.dostarczone.isEmpty }
    }

    /// Zabiera wszystko i czyści zbieracz — zabranie, nie odczyt: nieudana
    /// wysyłka nie może zostawić potwierdzeń wysyłanych w kółko.
    mutating func zabierz() -> [PaczkaPotwierdzen] {
        var paczki: [PaczkaPotwierdzen] = []
        for rozmowa in oczekujace {
            if !rozmowa.dostarczone.isEmpty {
                paczki.append(PaczkaPotwierdzen(groupId: rozmowa.groupId, rodzaj: .delivered,
                                                identyfikatory: rozmowa.dostarczone.compactMap { Data(hex: $0) }))
            }
            if !rozmowa.przeczytane.isEmpty {
                paczki.append(PaczkaPotwierdzen(groupId: rozmowa.groupId, rodzaj: .read,
                                                identyfikatory: rozmowa.przeczytane.compactMap { Data(hex: $0) }))
            }
        }
        oczekujace.removeAll()
        return paczki
    }
}
