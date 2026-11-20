import Foundation

/// Co zrobić z przygotowanym commitem, gdy relay go nie przyjął.
///
/// # Czemu to musiało powstać
///
/// Commit przygotowany i **nieporzucony** blokuje w MLS całą rozmowę: kolejna
/// zmiana składu i zwykłe wysłanie wiadomości kończą się „pending commit
/// exists". Klient, który przy odmowie relaya tylko pokaże błąd, zostawia
/// rozmowę zepsutą do restartu — tak wyglądała usterka #18.
///
/// # Reguła
///
/// Odmowa, o której wiemy, że relay epoki NIE zajął, kończy się porzuceniem
/// commitu. Odpowiedź nierozstrzygalna (5xx, brak sieci) nie zmienia niczego.
/// Ta sama reguła co w `Relay.kt` i `web/src/lib/relay.ts` — rozjazd znaczyłby,
/// że ta sama odmowa zostawia różne stany na urządzeniach jednego konta.
enum Relay {
    /// Przegrany wyścig o epokę — przychodzi jako 409 albo 200 z `accepted: false`.
    static let wyscig = BladAplikacji(
        "Ktoś zmienił skład tej rozmowy w tej samej chwili. Spróbuj jeszcze raz.",
        "Someone changed this conversation's members at the same moment. Try again."
    )

    /// Rozstrzyga odmowę po kodzie odpowiedzi.
    ///
    /// Zwrócony błąd znaczy: **epoka na pewno nie została zajęta**, więc commit
    /// ma zostać porzucony. `nil` znaczy „nie wiadomo" — wtedy stanu MLS nie
    /// ruszamy, bo porzucenie byłoby zgadywaniem.
    static func odmowa(status: Int) -> BladAplikacji? {
        switch status {
        case 409:
            return wyscig
        case 401, 403:
            return BladAplikacji(
                "Sesja wygasła. Zaloguj się ponownie i powtórz tę zmianę.",
                "Your session expired. Sign in again and repeat this change."
            )
        case 400..<500:
            return BladAplikacji(
                "Serwer nie przyjął zmiany składu rozmowy — najpewniej działa w starszej wersji niż ta aplikacja.",
                "The server rejected the membership change — it most likely runs an older version than this app."
            )
        default:
            return nil
        }
    }
}
