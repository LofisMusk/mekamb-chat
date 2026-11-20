import Foundation

/// Drobne przekształcenia bajtów potrzebne w całej warstwie rdzenia.
///
/// # Dlaczego tutaj, a nie rozsiane po plikach
///
/// Bo zapis szesnastkowy jest **formatem**: klucz rozmowy w historii, klucz
/// wiadomości w potwierdzeniach, identyfikator w zbieraczu. Gdyby jedno miejsce
/// pisało wielkimi literami, a drugie małymi, ta sama rozmowa miałaby dwa klucze
/// i historia rozjechałaby się bez żadnego błędu. Android ma to w jednym miejscu
/// (`Potwierdzenia.kt`), web też (`kluczRozmowy`) — tu jest odpowiednik.
extension Data {
    /// Małe litery, bez separatorów — dokładnie jak `ByteArray.hex()` i `kluczRozmowy`.
    var hex: String {
        map { String(format: "%02x", $0) }.joined()
    }

    /// Odwrotność [hex]. `nil` przy nieparzystej długości albo obcym znaku.
    init?(hex: String) {
        guard hex.count % 2 == 0 else { return nil }
        var bajty = [UInt8]()
        bajty.reserveCapacity(hex.count / 2)
        var indeks = hex.startIndex
        while indeks < hex.endIndex {
            let nastepny = hex.index(indeks, offsetBy: 2)
            guard let bajt = UInt8(hex[indeks..<nastepny], radix: 16) else { return nil }
            bajty.append(bajt)
            indeks = nastepny
        }
        self.init(bajty)
    }
}

/// Błąd do pokazania użytkownikowi — od razu w obu językach.
///
/// # Dlaczego para napisów, a nie klucz tłumaczenia
///
/// Warstwa rdzenia nie zna wybranego języka (żyje poza wątkiem głównym), a
/// interfejs nie powinien zgadywać treści z kodu błędu. Para niesie gotowe
/// zdanie; ekran wybiera połowę przez `t(pl, en)` — tak samo jak każdy inny
/// napis w aplikacji.
struct BladAplikacji: LocalizedError, Equatable {
    let pl: String
    let en: String

    init(_ pl: String, _ en: String) {
        self.pl = pl
        self.en = en
    }

    var errorDescription: String? { pl }
}

/// Teraz w milisekundach od epoki — jednostka czasu całego protokołu i historii.
func terazMs() -> Int64 {
    Int64((Date().timeIntervalSince1970 * 1000).rounded())
}
