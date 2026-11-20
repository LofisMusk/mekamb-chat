import CryptoKit
import Foundation
import Security

/// Konto zalogowane na tym urządzeniu.
///
/// # Dlaczego `userId` to nazwa użytkownika, a nie UUID z serwera
///
/// Bo skrzynka jest adresowana NAZWĄ: ten sam napis jest nazwą Durable Object
/// `UserInbox`, tożsamością MLS (`members()` zwraca `user_id:device_id`) i tym,
/// pod czym zapraszający zostawia welcome — zapraszający nie zna nic poza nazwą.
/// Logowanie passkeyem w webie zapisało kiedyś UUID i przeglądarka słuchała pod
/// UUID, a zaproszenia szły pod nazwę: nic nigdy się nie odszyfrowało, a nadawca
/// nie zobaczył żadnego błędu. Android ma to samo w `Vault.kt` (`userId get() = username`).
struct Konto: Equatable, Sendable {
    let username: String
    let deviceId: String

    var userId: String { username }
}

/// Trwały magazyn tożsamości, stanu MLS i historii.
///
/// # Co tu leży i czym jest chronione
///
/// Ziarno urządzenia, zrzut stanu MLS i historia — wszystkie zawierają klucze
/// prywatne albo treść rozmów. Odpowiednik `Vault.kt`:
///
/// - **Keychain** trzyma rzeczy małe i najcenniejsze: ziarno tożsamości, token
///   trwałej sesji i 256-bitowy klucz magazynu. Wpisy są
///   `AfterFirstUnlockThisDeviceOnly` — nie wędrują do kopii iCloud ani na inny
///   telefon, a mimo to są czytelne w tle po pierwszym odblokowaniu (klient musi
///   odbierać wiadomości bez użytkownika przy ekranie — ten sam wybór co
///   `setUserAuthenticationRequired(false)` na Androidzie).
/// - **Pliki** w Application Support trzymają rzeczy duże (stan MLS rośnie
///   z liczbą grup, historia z liczbą wiadomości), zaszyfrowane AES-GCM kluczem
///   magazynu z Keychaina. Keychain nie jest przeznaczony na megabajty, a sam
///   plik z ochroną systemu nie przetrwałby skopiowania z kopii zapasowej.
///
/// Skopiowanie plików aplikacji na inne urządzenie daje więc bezużyteczny
/// szyfrogram — klucz został w Keychainie tamtego telefonu.
///
/// Czego to nie chroni: odblokowanej aplikacji na przejętym urządzeniu.
final class Skarbiec: @unchecked Sendable {
    private let usluga: String
    private let katalog: URL
    private let ustawienia: UserDefaults
    /// Szereguje dostęp do plików — zapis stanu MLS i historii idą z różnych miejsc.
    private let zamek = NSLock()

    init(usluga: String = "com.mekamb.chat.skarbiec", katalog: URL? = nil, ustawienia: UserDefaults = .standard) {
        self.usluga = usluga
        self.ustawienia = ustawienia
        self.katalog = katalog ?? FileManager.default
            .urls(for: .applicationSupportDirectory, in: .userDomainMask)[0]
            .appendingPathComponent("Mekamb", isDirectory: true)
        try? FileManager.default.createDirectory(at: self.katalog, withIntermediateDirectories: true)
        // Kopia iCloud nie ma czego szukać w szyfrogramie bez klucza.
        var wartosci = URLResourceValues()
        wartosci.isExcludedFromBackup = true
        var kopia = self.katalog
        try? kopia.setResourceValues(wartosci)
    }

    // MARK: - Konto (jawne — nazwa i identyfikator urządzenia nie są sekretem)

    func zapiszKonto(_ konto: Konto) {
        ustawienia.set(konto.username, forKey: "mekamb.konto.uzytkownik")
        ustawienia.set(konto.deviceId, forKey: "mekamb.konto.urzadzenie")
    }

    func wczytajKonto() -> Konto? {
        guard let username = ustawienia.string(forKey: "mekamb.konto.uzytkownik"),
              let deviceId = ustawienia.string(forKey: "mekamb.konto.urzadzenie")
        else { return nil }
        return Konto(username: username, deviceId: deviceId)
    }

    // MARK: - Keychain

    func zapiszZiarno(_ ziarno: Data) { zapiszWKeychain("ziarno", ziarno) }
    func wczytajZiarno() -> Data? { czytajZKeychain("ziarno") }

    func zapiszRefreshToken(_ token: String) { zapiszWKeychain("token-odswiezajacy", Data(token.utf8)) }
    func wczytajRefreshToken() -> String? { czytajZKeychain("token-odswiezajacy").map { String(decoding: $0, as: UTF8.self) } }

    // MARK: - Pliki szyfrowane

    /// Zrzut stanu MLS. Wołane po KAŻDEJ operacji przesuwającej ratchet.
    func zapiszStan(_ stan: Data) throws { try zapiszPlik("stan-mls", stan) }
    func wczytajStan() -> Data? { czytajPlik("stan-mls") }

    /// Historia rozmów — chroniona jak klucze, bo treść jest równie wrażliwa.
    func zapiszHistorie(_ historia: Data) throws { try zapiszPlik("historia", historia) }
    func wczytajHistorie() -> Data? { czytajPlik("historia") }

    /// Współdzielone nazwy grup i nicki — mówią, jak ktoś nazwał grupę i siebie.
    func zapiszNazwy(_ nazwy: Data) throws { try zapiszPlik("nazwy", nazwy) }
    func wczytajNazwy() -> Data? { czytajPlik("nazwy") }

    /// Kasuje wszystko, łącznie z kluczem magazynu.
    ///
    /// Po tym kroku historia jest nie do odzyskania — serwer jej nie ma.
    func wyczysc() {
        zamek.lock()
        defer { zamek.unlock() }
        for nazwa in ["ziarno", "token-odswiezajacy", "klucz-magazynu"] {
            SecItemDelete(zapytanie(nazwa) as CFDictionary)
        }
        try? FileManager.default.removeItem(at: katalog)
        try? FileManager.default.createDirectory(at: katalog, withIntermediateDirectories: true)
        ustawienia.removeObject(forKey: "mekamb.konto.uzytkownik")
        ustawienia.removeObject(forKey: "mekamb.konto.urzadzenie")
    }

    private func zapiszPlik(_ nazwa: String, _ dane: Data) throws {
        zamek.lock()
        defer { zamek.unlock() }
        let zapieczetowane = try AES.GCM.seal(dane, using: kluczMagazynu())
        guard let polaczone = zapieczetowane.combined else {
            throw BladAplikacji("Nie udało się zaszyfrować danych.", "Could not encrypt data.")
        }
        // `.atomic`: przerwany zapis nie może zostawić połowy stanu MLS — to byłby
        // klient cofnięty do nieistniejącej epoki, czyli koniec odszyfrowywania.
        try polaczone.write(
            to: katalog.appendingPathComponent(nazwa + ".bin"),
            options: [.atomic, .completeFileProtectionUntilFirstUserAuthentication]
        )
    }

    private func czytajPlik(_ nazwa: String) -> Data? {
        zamek.lock()
        defer { zamek.unlock() }
        guard let surowe = try? Data(contentsOf: katalog.appendingPathComponent(nazwa + ".bin")),
              let pudelko = try? AES.GCM.SealedBox(combined: surowe),
              let klucz = try? kluczMagazynu()
        else { return nil }
        return try? AES.GCM.open(pudelko, using: klucz)
    }

    /// Klucz magazynu z Keychaina, tworzony przy pierwszym użyciu.
    private func kluczMagazynu() throws -> SymmetricKey {
        if let istniejacy = czytajZKeychain("klucz-magazynu"), istniejacy.count == 32 {
            return SymmetricKey(data: istniejacy)
        }
        let nowy = SymmetricKey(size: .bits256)
        let bajty = nowy.withUnsafeBytes { Data($0) }
        guard zapiszWKeychain("klucz-magazynu", bajty) else {
            throw BladAplikacji("Brak dostępu do pęku kluczy.", "Keychain is not available.")
        }
        return nowy
    }

    private func zapytanie(_ nazwa: String) -> [String: Any] {
        [
            kSecClass as String: kSecClassGenericPassword,
            kSecAttrService as String: usluga,
            kSecAttrAccount as String: nazwa,
        ]
    }

    @discardableResult
    private func zapiszWKeychain(_ nazwa: String, _ dane: Data) -> Bool {
        SecItemDelete(zapytanie(nazwa) as CFDictionary)
        var atrybuty = zapytanie(nazwa)
        atrybuty[kSecValueData as String] = dane
        atrybuty[kSecAttrAccessible as String] = kSecAttrAccessibleAfterFirstUnlockThisDeviceOnly
        return SecItemAdd(atrybuty as CFDictionary, nil) == errSecSuccess
    }

    private func czytajZKeychain(_ nazwa: String) -> Data? {
        var zapytanie = zapytanie(nazwa)
        zapytanie[kSecReturnData as String] = true
        zapytanie[kSecMatchLimit as String] = kSecMatchLimitOne
        var wynik: AnyObject?
        guard SecItemCopyMatching(zapytanie as CFDictionary, &wynik) == errSecSuccess else { return nil }
        return wynik as? Data
    }
}
