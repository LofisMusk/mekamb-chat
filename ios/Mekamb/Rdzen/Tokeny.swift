import Foundation

/// Token doręczeniowy gotowy do jednego nadania.
///
/// # Po co to jest
///
/// Zostawienie koperty w cudzej skrzynce jest nieuwierzytelnione, bo serwer nie
/// ma się dowiadywać, kto do kogo pisze. Token dowodzi „mam prawo nadać", nie
/// mówiąc „jestem tym kontem" — serwer podpisał go na wartości oślepionej, więc
/// przy realizacji nie wie, komu go wydał. Kryptografia oślepiania jest w rdzeniu
/// (`opaque/src/tokeny.rs`) — tu jest wyłącznie portfel.
struct TokenDoreczenia: Codable, Equatable, Sendable {
    let ziarno: String
    let odslonione: String

    /// Postać nagłówka `X-Delivery-Token`: dwa pola rozdzielone kropką, tak jak czyta je serwer.
    var naglowek: String { "\(ziarno).\(odslonione)" }
}

/// Magazyn portfela — za protokołem, żeby reguły dało się sprawdzić bez UserDefaults.
protocol MagazynTokenow: AnyObject, Sendable {
    func odczytaj(_ klucz: String) -> String?
    func zapisz(_ klucz: String, _ wartosc: String)
}

/// Magazyn w `UserDefaults`.
///
/// # Dlaczego nie w Keychainie
///
/// Bo token nie jest sekretem tożsamości: jego utrata nie odsłania niczego,
/// a przejęcie nie daje dostępu do konta. Kosztuje jedno pobranie zapasu. Ten
/// sam wybór co `MagazynWPreferencjach` na Androidzie.
final class MagazynWUstawieniach: MagazynTokenow, @unchecked Sendable {
    private let ustawienia: UserDefaults

    init(ustawienia: UserDefaults = .standard) {
        self.ustawienia = ustawienia
    }

    func odczytaj(_ klucz: String) -> String? { ustawienia.string(forKey: "mekamb.tokeny.\(klucz)") }
    func zapisz(_ klucz: String, _ wartosc: String) { ustawienia.set(wartosc, forKey: "mekamb.tokeny.\(klucz)") }
}

/// Portfel tokenów doręczeniowych.
///
/// # Dlaczego zapas, a nie token na żądanie
///
/// Bo pójście po token jest żądaniem **uwierzytelnionym**. Branie jednego przed
/// każdą wiadomością dałoby serwerowi ciąg „konto A poprosiło o token, sekundę
/// później ktoś nadał do skrzynki B" — dokładnie to powiązanie, które schemat
/// usuwa. Reguły i progi są te same co w `Tokeny.kt` i `web/src/lib/tokeny.ts`.
final class PortfelTokenow: @unchecked Sendable {
    /// Ile bierzemy naraz. Serwer i tak nie wyda więcej na jedno żądanie.
    static let docelowy = 50

    /// Poniżej tego progu dobieramy — zapas ma się kończyć przed, a nie w trakcie.
    static let progDobrania = 10

    private let magazyn: MagazynTokenow
    private let zamek = NSLock()

    init(magazyn: MagazynTokenow) {
        self.magazyn = magazyn
    }

    private func wczytaj() -> [TokenDoreczenia] {
        guard let surowe = magazyn.odczytaj("zapas"), let dane = surowe.data(using: .utf8) else { return [] }
        // Uszkodzony zapis znaczy pusty zapas — token jest wygodą, nie danymi.
        return (try? JSONDecoder().decode([TokenDoreczenia].self, from: dane)) ?? []
    }

    private func zapisz(_ tokeny: [TokenDoreczenia]) {
        guard let dane = try? JSONEncoder().encode(tokeny) else { return }
        magazyn.zapisz("zapas", String(decoding: dane, as: UTF8.self))
    }

    /// Ile tokenów zostało.
    var ile: Int {
        zamek.lock()
        defer { zamek.unlock() }
        return wczytaj().count
    }

    /// Czy warto już dobrać zapas.
    var trzebaDobrac: Bool { ile <= Self.progDobrania }

    /// Wyjmuje jeden token. Każdy idzie dokładnie raz — serwer odrzuca powtórkę.
    ///
    /// `nil` znaczy pusty zapas: wołający nadaje wtedy BEZ tokenu. Dopóki serwer
    /// ich nie wymusza, brak zapasu nie może blokować wysyłania.
    func wez() -> TokenDoreczenia? {
        zamek.lock()
        defer { zamek.unlock() }
        var zapas = wczytaj()
        guard !zapas.isEmpty else { return nil }
        let token = zapas.removeFirst()
        zapisz(zapas)
        return token
    }

    /// Dokłada świeżo wydane tokeny.
    func doloz(_ nowe: [TokenDoreczenia]) {
        guard !nowe.isEmpty else { return }
        zamek.lock()
        defer { zamek.unlock() }
        zapisz(wczytaj() + nowe)
    }

    /// Przypina klucz wydawania przy pierwszym pobraniu.
    ///
    /// Serwer wydający różnym osobom tokeny różnymi kluczami ZNAKUJE je. Dowód
    /// Chaum-Pedersen w `tokenOdslon` wykrywa użycie innego klucza niż podany,
    /// ale nie to, że sam podany klucz jest podstawiony pod nas. Przypięcie
    /// zamienia atak niewidoczny w taki, który wymaga zmiany klucza wszystkim
    /// naraz. `false` znaczy „klucz się zmienił" — wtedy nie bierzemy tokenów.
    func przypnijKlucz(_ kluczPubliczny: String) -> Bool {
        zamek.lock()
        defer { zamek.unlock() }
        guard let przypiety = magazyn.odczytaj("klucz") else {
            magazyn.zapisz("klucz", kluczPubliczny)
            return true
        }
        return przypiety == kluczPubliczny
    }
}
