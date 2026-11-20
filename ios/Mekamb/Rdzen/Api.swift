import Foundation

/// Odmowa serwera z kodem odpowiedzi.
///
/// Kod zostaje przy błędzie, bo od niego zależy decyzja, a nie tylko komunikat:
/// 401 przy nadaniu znaczy „dobierz tokeny i ponów", 409 przy relayu — „porzuć
/// commit" (patrz `Relay.swift`).
struct BladApi: LocalizedError {
    let status: Int
    let komunikat: String

    var errorDescription: String? { komunikat }
}

/// Klient HTTP backendu.
///
/// # Czego ten klient NIE robi
///
/// Nie przesyła treści. Do serwera trafiają wyłącznie koperty — nieprzezroczyste
/// bajty zaszyfrowane MLS — oraz metadane potrzebne do routingu. Klucze nie
/// opuszczają urządzenia w żadnym wywołaniu z tego pliku. Odpowiednik
/// `android/.../Api.kt`; nazwy pól JSON są te same znak w znak.
///
/// # Dlaczego bez magazynu ciasteczek
///
/// Serwer oddaje token trwałej sesji jako httpOnly cookie `refresh` — tak broni
/// się przed XSS w przeglądarce. Tu przeglądarki nie ma, a systemowy magazyn
/// ciasteczek trzymałby token poza Keychainem, w pliku, którego nie kontrolujemy.
/// Wyciągamy więc wartość z `Set-Cookie` sami i chowamy ją w skarbcu, a do
/// `/auth/refresh` dokładamy ręcznie — dokładnie jak Android.
final class Api: Sendable {
    let adres: String
    private let sesja: URLSession

    init(adres: String = Konfiguracja.adresApi) {
        self.adres = adres

        let konfiguracja = URLSessionConfiguration.ephemeral
        konfiguracja.httpCookieStorage = nil
        konfiguracja.httpShouldSetCookies = false
        konfiguracja.httpCookieAcceptPolicy = .never
        konfiguracja.timeoutIntervalForRequest = 30
        konfiguracja.urlCache = nil
        self.sesja = URLSession(configuration: konfiguracja)
    }

    struct WynikLogowania: Sendable {
        let token: String
        let refreshToken: String?
    }

    struct WynikRejestracji: Sendable {
        let sekretTotp: String
        let otpauthUri: String
    }

    // MARK: - Uwierzytelnianie

    /// Runda 1 rejestracji: zwraca odpowiedź serwera OPAQUE.
    func registerStart(username: String, request: Data) async throws -> Data {
        let odpowiedz = try await postJson("/auth/register/start", [
            "username": username,
            "registrationRequest": request.base64EncodedString(),
        ])
        return try bajty(odpowiedz, "registrationResponse")
    }

    /// Runda 2 rejestracji: zakłada konto (nieaktywne) i zwraca sekret TOTP.
    func registerFinish(username: String, upload: Data) async throws -> WynikRejestracji {
        let odpowiedz = try await postJson("/auth/register/finish", [
            "username": username,
            "registrationRecord": upload.base64EncodedString(),
        ])
        return WynikRejestracji(
            sekretTotp: try tekst(odpowiedz, "totpSecret"),
            otpauthUri: try tekst(odpowiedz, "otpauthUri")
        )
    }

    /// Aktywuje konto pierwszym kodem i od razu odbiera token — jak `/auth/login/totp`.
    ///
    /// `deviceId` jest konieczny: bez niego serwer nie wie, do którego urządzenia
    /// przypiąć trwałą sesję, i ciasteczko `refresh` nie wraca.
    func registerConfirm(username: String, code: String, deviceId: String) async throws -> WynikLogowania {
        let (odpowiedz, ciasteczka) = try await postJsonZNaglowkami("/auth/register/confirm", [
            "username": username,
            "code": code,
            "deviceId": deviceId,
        ])
        return WynikLogowania(token: try tekst(odpowiedz, "token"), refreshToken: Self.refreshZCiasteczek(ciasteczka))
    }

    /// Runda 1 logowania. Zwraca identyfikator sesji i odpowiedź OPAQUE (KE2).
    func loginStart(username: String, request: Data) async throws -> (loginId: String, ke2: Data) {
        let odpowiedz = try await postJson("/auth/login/start", [
            "username": username,
            "ke1": request.base64EncodedString(),
        ])
        return (try tekst(odpowiedz, "loginId"), try bajty(odpowiedz, "ke2"))
    }

    /// Runda 2 logowania: dowód klienta (KE3).
    func loginFinish(loginId: String, username: String, finalization: Data) async throws {
        _ = try await postJson("/auth/login/finish", [
            "loginId": loginId,
            "username": username,
            "ke3": finalization.base64EncodedString(),
        ])
    }

    /// Runda 3: drugi składnik. Dopiero tutaj powstaje token dostępowy.
    func loginTotp(loginId: String, code: String, deviceId: String) async throws -> WynikLogowania {
        let (odpowiedz, ciasteczka) = try await postJsonZNaglowkami("/auth/login/totp", [
            "loginId": loginId,
            "code": code,
            "deviceId": deviceId,
        ])
        return WynikLogowania(token: try tekst(odpowiedz, "token"), refreshToken: Self.refreshZCiasteczek(ciasteczka))
    }

    /// Wymienia trwałą sesję na nowy token dostępowy.
    ///
    /// `nil` zamiast wyjątku przy 401: wygasła albo odwołana sesja jest częstym,
    /// oczekiwanym stanem — wtedy po prostu pokazujemy ekran logowania.
    func refreshSession(deviceId: String, refreshToken: String) async throws -> WynikLogowania? {
        do {
            let (odpowiedz, ciasteczka) = try await postJsonZNaglowkami(
                "/auth/refresh",
                ["deviceId": deviceId],
                refreshToken: refreshToken
            )
            // Token jest rotowany przy każdym użyciu; gdyby serwer kiedyś nie
            // przysłał nowego, zostajemy przy starym zamiast go gubić.
            return WynikLogowania(
                token: try tekst(odpowiedz, "token"),
                refreshToken: Self.refreshZCiasteczek(ciasteczka) ?? refreshToken
            )
        } catch let blad as BladApi where blad.status == 401 {
            return nil
        }
    }

    /// Kasuje trwałą sesję po stronie serwera — przy jawnym wylogowaniu.
    func logout(deviceId: String, refreshToken: String?) async throws {
        _ = try await postJsonZNaglowkami("/auth/logout", ["deviceId": deviceId], refreshToken: refreshToken)
    }

    // MARK: - Katalog i key packages

    /// Rejestruje urządzenie w katalogu.
    ///
    /// iOS w tej wersji jest — jak przeglądarka — osiągalny WYŁĄCZNIE przez
    /// skrzynkę, więc rekord adresowy jest pusty. Ale podpisany: „brak adresu"
    /// jest wtedy oświadczeniem tego urządzenia, a nie milczeniem, które serwer
    /// mógłby wypełnić po swojemu (patrz `registerDevice` w `web/src/lib/messenger.ts`).
    func registerDevice(token: String, deviceId: String, mlsPublicKey: Data, addrSignature: Data) async throws {
        _ = try await postJson("/devices", [
            "deviceId": deviceId,
            "mlsPublicKey": mlsPublicKey.base64EncodedString(),
            "addrSignature": addrSignature.base64EncodedString(),
            "displayName": "iPhone",
        ], token: token)
    }

    /// Publikuje zapas key packages, żeby dało się nas dodać do grupy offline.
    func publishKeyPackages(token: String, deviceId: String, packages: [Data]) async throws {
        _ = try await postJson(
            "/key-packages/\(sciezka(deviceId))",
            ["keyPackages": packages.map { $0.base64EncodedString() }],
            token: token
        )
    }

    struct Urzadzenie: Sendable {
        let deviceId: String
    }

    /// Wyszukuje urządzenia użytkownika.
    ///
    /// Klient iOS nie korzysta jeszcze z drogi bezpośredniej, więc z rekordu
    /// bierze tylko identyfikator — adresów nie czyta wcale, a zatem nie musi
    /// ich też weryfikować (`verifyPeerAddress`). Gdy dojdzie transport UDP,
    /// adres bez sprawdzonego podpisu ma znaczyć „tylko skrzynka".
    func lookupDevices(username: String) async throws -> [Urzadzenie] {
        let odpowiedz = try await get("/directory/\(sciezka(username))")
        let lista = odpowiedz["devices"] as? [[String: Any]] ?? []
        return lista.compactMap { ($0["deviceId"] as? String).map(Urzadzenie.init(deviceId:)) }
    }

    /// Pobiera jednorazowy key package urządzenia.
    func claimKeyPackage(deviceId: String) async throws -> Data {
        let odpowiedz = try await postJson("/key-packages/\(sciezka(deviceId))/claim", [:])
        return try bajty(odpowiedz, "keyPackage")
    }

    /// Zajmuje kolejną epokę grupy w `GroupRelay`.
    ///
    /// Do serwera idzie sam numer epoki pod osobno wyprowadzonym `relayId` —
    /// ani commit, ani skład grupy, ani identyfikator rozmowy. Odmowy nie
    /// tłumaczymy tutaj: rozstrzyga je jedna reguła w `Relay`.
    func zajmijEpoke(token: String, relayId: String, epoch: UInt64) async throws -> Bool {
        let odpowiedz = try await postJson("/groups/\(sciezka(relayId))/commit", ["epoch": epoch], token: token)
        // Brak pola traktujemy jak zgodę — taki kształt ma przyjęte zajęcie epoki.
        return odpowiedz["accepted"] as? Bool ?? true
    }

    /// Zostawia kopertę w skrzynce odbiorcy.
    ///
    /// **Bez tokenu konta i to jest decyzja**: serwer nie ma się dowiadywać, kto
    /// do kogo pisze. Prawo do nadania potwierdza token DORĘCZENIOWY, wydany na
    /// wartość oślepioną — nie do powiązania z kontem (`Tokeny.swift`).
    func deposit(userId: String, envelope: Data, tokenDoreczenia: String?) async throws {
        var zadanie = URLRequest(url: try url("/inbox/\(sciezka(userId))"))
        zadanie.httpMethod = "POST"
        zadanie.setValue("application/octet-stream", forHTTPHeaderField: "Content-Type")
        if let tokenDoreczenia {
            zadanie.setValue(tokenDoreczenia, forHTTPHeaderField: "X-Delivery-Token")
        }
        zadanie.httpBody = envelope

        let (dane, odpowiedz) = try await sesja.data(for: zadanie)
        let kod = (odpowiedz as? HTTPURLResponse)?.statusCode ?? 0
        guard (200..<300).contains(kod) else {
            throw BladApi(status: kod, komunikat: Self.blad(dane, kod))
        }
    }

    // MARK: - Tokeny doręczeniowe

    /// Klucz publiczny wydawania tokenów. Ten sam dla wszystkich — inaczej znakuje.
    ///
    /// `nil` przy każdym niepowodzeniu: wdrożenie bez tokenów odpowiada 503 i to
    /// jest poprawny stan, nie awaria.
    func kluczTokenow() async -> String? {
        try? await get("/tokens/key")["publicKey"] as? String
    }

    /// Prosi o tokeny na oślepione wartości.
    ///
    /// To jedyne miejsce, w którym serwer wie, komu wydaje — i właśnie dlatego
    /// nie widzi tu, co wydaje.
    func wydajTokeny(token: String, oslepione: [Data]) async throws -> [(ocenione: Data, wyzwanie: Data, odpowiedz: Data)] {
        let odpowiedz = try await postJson(
            "/tokens/issue",
            ["blinded": oslepione.map { $0.base64EncodedString() }],
            token: token
        )
        let lista = odpowiedz["tokens"] as? [[String: Any]] ?? []
        return try lista.map { wpis in
            (try bajty(wpis, "evaluated"), try bajty(wpis, "challenge"), try bajty(wpis, "response"))
        }
    }

    // MARK: - Skrzynka

    /// Żądanie otwarcia gniazda skrzynki.
    ///
    /// Token idzie podprotokołem (`Sec-WebSocket-Protocol`), tak samo jak
    /// w przeglądarce, która nie potrafi dodać `Authorization` do WebSocketu —
    /// serwer czyta jedno miejsce, nie dwa. Bez tokenu serwer odmawia.
    func zadanieSkrzynki(userId: String) throws -> URL {
        var tekst = try url("/inbox/\(sciezka(userId))/connect").absoluteString
        if tekst.hasPrefix("https://") {
            tekst = "wss://" + tekst.dropFirst("https://".count)
        } else if tekst.hasPrefix("http://") {
            tekst = "ws://" + tekst.dropFirst("http://".count)
        }
        guard let adres = URL(string: tekst) else {
            throw BladApi(status: 0, komunikat: "nieprawidłowy adres skrzynki")
        }
        return adres
    }

    // MARK: - Pomocnicze

    private func url(_ sciezka: String) throws -> URL {
        guard let url = URL(string: adres + sciezka) else {
            throw BladApi(status: 0, komunikat: "nieprawidłowy adres: \(sciezka)")
        }
        return url
    }

    /// Fragment ścieżki zakodowany — nazwa użytkownika trafia wprost do adresu.
    private func sciezka(_ tekst: String) -> String {
        tekst.addingPercentEncoding(withAllowedCharacters: .urlPathAllowed.subtracting(CharacterSet(charactersIn: "/"))) ?? tekst
    }

    /// Serwer ICE dla rozmów A/V.
    struct SerwerIce: Sendable {
        let urls: [String]
        let username: String?
        let credential: String?
    }

    /// Serwery STUN/TURN na jedną rozmowę.
    ///
    /// TURN dostaje krótkożyjące poświadczenia od Workera, więc nie da się ich
    /// trzymać w aplikacji — pobieramy je przed każdą rozmową.
    func iceServers(token: String) async throws -> [SerwerIce] {
        var zadanie = URLRequest(url: try url("/calls/ice-servers"))
        zadanie.setValue("Bearer \(token)", forHTTPHeaderField: "Authorization")
        let (dane, odpowiedz) = try await sesja.data(for: zadanie)
        let obiekt = try Self.rozbierz(dane, odpowiedz)
        let wpisy = obiekt["iceServers"] as? [[String: Any]] ?? []
        return wpisy.compactMap { wpis in
            // `urls` bywa napisem albo listą — oba kształty są w specyfikacji WebRTC.
            let urls = (wpis["urls"] as? [String]) ?? (wpis["urls"] as? String).map { [$0] } ?? []
            guard !urls.isEmpty else { return nil }
            return SerwerIce(urls: urls, username: wpis["username"] as? String, credential: wpis["credential"] as? String)
        }
    }

    private func get(_ sciezka: String) async throws -> [String: Any] {
        let (dane, odpowiedz) = try await sesja.data(from: try url(sciezka))
        return try Self.rozbierz(dane, odpowiedz)
    }

    private func postJson(_ sciezka: String, _ cialo: [String: Any], token: String? = nil) async throws -> [String: Any] {
        try await postJsonZNaglowkami(sciezka, cialo, token: token).0
    }

    /// Jak `postJson`, ale oddaje też `Set-Cookie` — potrzebne wyłącznie przy trwałej sesji.
    private func postJsonZNaglowkami(
        _ sciezka: String,
        _ cialo: [String: Any],
        token: String? = nil,
        refreshToken: String? = nil
    ) async throws -> ([String: Any], String?) {
        var zadanie = URLRequest(url: try url(sciezka))
        zadanie.httpMethod = "POST"
        zadanie.setValue("application/json", forHTTPHeaderField: "Content-Type")
        if let token { zadanie.setValue("Bearer \(token)", forHTTPHeaderField: "Authorization") }
        if let refreshToken { zadanie.setValue("refresh=\(refreshToken)", forHTTPHeaderField: "Cookie") }
        zadanie.httpBody = try JSONSerialization.data(withJSONObject: cialo)

        let (dane, odpowiedz) = try await sesja.data(for: zadanie)
        let ciasteczka = (odpowiedz as? HTTPURLResponse)?.value(forHTTPHeaderField: "Set-Cookie")
        return (try Self.rozbierz(dane, odpowiedz), ciasteczka)
    }

    private static func rozbierz(_ dane: Data, _ odpowiedz: URLResponse) throws -> [String: Any] {
        let kod = (odpowiedz as? HTTPURLResponse)?.statusCode ?? 0
        guard (200..<300).contains(kod) else {
            throw BladApi(status: kod, komunikat: blad(dane, kod))
        }
        if dane.isEmpty { return [:] }
        return (try? JSONSerialization.jsonObject(with: dane)) as? [String: Any] ?? [:]
    }

    private static func blad(_ dane: Data, _ kod: Int) -> String {
        let obiekt = (try? JSONSerialization.jsonObject(with: dane)) as? [String: Any]
        return obiekt?["error"] as? String ?? "żądanie nie powiodło się (\(kod))"
    }

    /// Wartość ciasteczka `refresh` bez atrybutów.
    ///
    /// `HTTPURLResponse` skleja kilka nagłówków `Set-Cookie` przecinkami, więc
    /// szukamy nazwy w całym ciągu i ucinamy na pierwszym `;` albo `,`.
    static func refreshZCiasteczek(_ naglowek: String?) -> String? {
        guard let naglowek, let poczatek = naglowek.range(of: "refresh=") else { return nil }
        let reszta = naglowek[poczatek.upperBound...]
        let wartosc = reszta.prefix { $0 != ";" && $0 != "," && !$0.isWhitespace }
        return wartosc.isEmpty ? nil : String(wartosc)
    }

    private func tekst(_ obiekt: [String: Any], _ pole: String) throws -> String {
        guard let wartosc = obiekt[pole] as? String else {
            throw BladApi(status: 0, komunikat: "odpowiedź serwera bez pola \(pole)")
        }
        return wartosc
    }

    private func bajty(_ obiekt: [String: Any], _ pole: String) throws -> Data {
        guard let wartosc = Data(base64Encoded: try tekst(obiekt, pole)) else {
            throw BladApi(status: 0, komunikat: "pole \(pole) nie jest base64")
        }
        return wartosc
    }
}
