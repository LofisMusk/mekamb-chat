import CryptoKit
import Foundation

/// Rozpoznawanie własnych kopert wracających z własnej skrzynki.
///
/// # Dlaczego to musi istnieć
///
/// Żeby drugie urządzenie zobaczyło wiadomość wysłaną z tego, koperta trafia
/// także do **własnej** skrzynki — skrzynka jest adresowana nazwą użytkownika,
/// nie urządzeniem. Wraca więc do nadawcy, a MLS z założenia nie pozwala
/// przetworzyć własnej wiadomości. Bez rozpoznania echa koperta wpadłaby
/// w ponawianie i wisiała w kolejce przez trzy połączenia.
///
/// # Dlaczego skrót, a nie identyfikator wiadomości
///
/// `messageId` siedzi wewnątrz szyfrogramu. Skrót bajtów koperty rozpoznaje ją
/// bez zaglądania do środka. Odpowiednik `Echa.kt` i `web/src/lib/echa.ts`.
final class Echa: @unchecked Sendable {
    static let wspolne = Echa()

    /// Jak długo pamiętamy kopertę — echo nadane tuż przed utratą sieci wraca
    /// dopiero przy następnym połączeniu.
    private let zycieMs: Int64 = 10 * 60 * 1000

    /// Górna granica — przekroczenie wyrzuca najstarsze, a najgorsze, co się
    /// wtedy dzieje, to powrót do zachowania sprzed tego pliku.
    private let limit = 512

    private var znane: [(skrot: String, czas: Int64)] = []
    private let zamek = NSLock()

    private func skrot(_ koperta: Data) -> String {
        Data(SHA256.hash(data: koperta)).hex
    }

    private func posprzataj(teraz: Int64) {
        znane.removeAll { $0.czas < teraz - zycieMs }
        if znane.count > limit {
            znane.removeFirst(znane.count - limit)
        }
    }

    /// Zapamiętuje kopertę, którą sami nadajemy.
    func zapamietaj(_ koperta: Data, teraz: Int64 = terazMs()) {
        let s = skrot(koperta)
        zamek.lock()
        defer { zamek.unlock() }
        znane.removeAll { $0.skrot == s }
        znane.append((s, teraz))
        posprzataj(teraz: teraz)
    }

    /// Czy to nasze echo. Rozpoznaną kopertę zapominamy — wraca raz na urządzenie.
    func czyWlasna(_ koperta: Data) -> Bool {
        let s = skrot(koperta)
        zamek.lock()
        defer { zamek.unlock() }
        guard let indeks = znane.firstIndex(where: { $0.skrot == s }) else { return false }
        znane.remove(at: indeks)
        return true
    }

    /// Przy wylogowaniu i w testach.
    func zapomnijWszystko() {
        zamek.lock()
        defer { zamek.unlock() }
        znane.removeAll()
    }
}
