import Foundation

/// Uwierzytelnianie: OPAQUE z rdzenia i drugi składnik TOTP.
///
/// # Hasło nie opuszcza tego urządzenia
///
/// OPAQUE wykonuje kosztowną część obliczeń tutaj i wysyła na serwer wyłącznie
/// ślepe wartości. Serwer nie widzi hasła ani przy rejestracji, ani przy
/// logowaniu, więc nie ma czego z niego wyciec.
///
/// # Ten sam kod co na serwerze i na Androidzie
///
/// Kryptografia pochodzi z `mekamb-opaque` (Rust, RFC 9807) przez UniFFI —
/// serwer używa tego samego kodu w WebAssembly. Własna implementacja w Swifcie
/// byłaby powtórką usterki, którą projekt już raz przeszedł: serwer mówił
/// draftem 07, klient RFC 9807, i logowanie nie przechodziło nigdy.
enum Auth {
    /// Sesja między krokiem hasła a krokiem kodu.
    struct SesjaLogowania: Sendable {
        let loginId: String
        let username: String
    }

    /// Zakłada konto. Nieaktywne aż do potwierdzenia pierwszym kodem TOTP.
    static func zarejestruj(api: Api, username: String, haslo: String) async throws -> Api.WynikRejestracji {
        let start = try opaqueRegisterStart(password: haslo)
        let odpowiedz = try await api.registerStart(username: username, request: start.request)
        let koniec = try opaqueRegisterFinish(state: start.state, password: haslo, username: username, response: odpowiedz)

        // `exportKey` jest kluczem wyprowadzonym z hasła, nieznanym serwerowi.
        // Na razie go nie używamy i świadomie nigdzie nie wysyłamy.
        return try await api.registerFinish(username: username, upload: koniec.upload)
    }

    /// Pierwszy krok logowania: hasło.
    ///
    /// Osobno od kodu, bo przy jednym wywołaniu każde niepowodzenie wyglądało
    /// tak samo i użytkownik z literówką w haśle przepisywał kod w kółko.
    static func zalogujHaslem(api: Api, username: String, haslo: String) async throws -> SesjaLogowania {
        let start = try opaqueLoginStart(password: haslo)
        let (loginId, ke2) = try await api.loginStart(username: username, request: start.request)

        let koniec: OpaqueLoginFinish
        do {
            koniec = try opaqueLoginFinish(state: start.state, password: haslo, username: username, response: ke2)
        } catch {
            // Złe hasło i nieistniejące konto dają ten sam komunikat — serwer
            // celowo nie pozwala ich odróżnić, więc klient też nie może.
            throw BladAplikacji(
                "Nieprawidłowa nazwa użytkownika lub hasło.",
                "Wrong username or password."
            )
        }

        try await api.loginFinish(loginId: loginId, username: username, finalization: koniec.finalization)
        return SesjaLogowania(loginId: loginId, username: username)
    }
}
