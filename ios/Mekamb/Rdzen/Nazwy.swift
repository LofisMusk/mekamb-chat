import Foundation

/// Współdzielone nazwy: nazwy grup i nicki rozmówców.
///
/// # To jest warstwa WYŚWIETLANIA
///
/// Tożsamością w MLS i adresem skrzynki zostaje nazwa użytkownika. Nick tylko
/// zmienia to, co widać na liście i w wątku. Nazwy jadą zaszyfrowane jak każda
/// wiadomość (`sendMetadata`), więc serwer nie wie, jak ktoś nazwał grupę ani
/// siebie — i dlatego leżą w skarbcu, a nie w jawnych ustawieniach.
/// Ten sam kształt co `Nazwy.kt` (wersja 1).
struct StanNazw: Codable, Equatable, Sendable {
    var wersja: Int = 1
    /// Klucz rozmowy (hex) → nazwa grupy.
    var grupy: [String: String] = [:]
    /// Nazwa użytkownika → nick.
    var nicki: [String: String] = [:]
    var mojNick: String = ""

    init() {}

    init(from decoder: Decoder) throws {
        let c = try decoder.container(keyedBy: CodingKeys.self)
        wersja = try c.decodeIfPresent(Int.self, forKey: .wersja) ?? 1
        grupy = try c.decodeIfPresent([String: String].self, forKey: .grupy) ?? [:]
        nicki = try c.decodeIfPresent([String: String].self, forKey: .nicki) ?? [:]
        mojNick = try c.decodeIfPresent(String.self, forKey: .mojNick) ?? ""
    }

    /// Etykieta rozmowy: nazwa grupy, a bez niej skład z nickami w miejsce nazw.
    func etykieta(groupId: Data, rozmowcaSurowy: String) -> String {
        if let nazwa = grupy[groupId.hex], !nazwa.isEmpty { return nazwa }
        return rozmowcaSurowy
            .split(separator: ",")
            .map { $0.trimmingCharacters(in: .whitespaces) }
            .map { nick($0) }
            .joined(separator: ", ")
    }

    func nick(_ username: String) -> String {
        if let nick = nicki[username], !nick.isEmpty { return nick }
        return username
    }
}

final class Nazwy: @unchecked Sendable {
    private let skarbiec: Skarbiec
    private let zamek = NSLock()

    init(skarbiec: Skarbiec) {
        self.skarbiec = skarbiec
    }

    func wczytaj() -> StanNazw {
        zamek.lock()
        defer { zamek.unlock() }
        return wczytajBezZamka()
    }

    private func wczytajBezZamka() -> StanNazw {
        guard let surowe = skarbiec.wczytajNazwy(),
              let stan = try? JSONDecoder().decode(StanNazw.self, from: surowe),
              stan.wersja == 1
        else { return StanNazw() }
        return stan
    }

    /// Pusta albo `nil` usuwa wpis — „wyczyścił nazwę", nie „ma pustą nazwę".
    @discardableResult
    func zmien(_ zmiana: (inout StanNazw) -> Void) -> StanNazw {
        zamek.lock()
        defer { zamek.unlock() }
        var stan = wczytajBezZamka()
        zmiana(&stan)
        if let dane = try? JSONEncoder().encode(stan) {
            try? skarbiec.zapiszNazwy(dane)
        }
        return stan
    }
}
