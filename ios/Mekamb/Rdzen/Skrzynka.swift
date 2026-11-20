import Foundation

/// Odbiór ze skrzynki na serwerze.
///
/// # Dlaczego to jest jedyna droga odbioru na iOS
///
/// Ta wersja klienta nie ma transportu UDP — jak przeglądarka, odbiera wyłącznie
/// skrzynką. To nie jest uproszczenie, które coś gubi: skrzynka i tak jest
/// jedyną drogą, którą docierają wiadomości od rozmówców z weba, i jedyną, która
/// rozchodzi się na wszystkie urządzenia odbiorcy. Android przez jakiś czas
/// deponował do skrzynki, ale z niej nie czytał — web → Android nie docierało
/// nigdy, a nadawca nie widział błędu. Tu skrzynka jest czytana od pierwszego dnia.
///
/// Odpowiednik `android/.../Skrzynka.kt` i `web/src/lib/polaczenie.ts`; progi
/// (podtrzymanie, ponowienia, liczba prób) są te same po wszystkich stronach.

/// Co ile wysyłamy podtrzymanie. Serwer odpowiada `pong`.
let pingCoSekund: UInt64 = 30

/// Ile podtrzymań bez odpowiedzi znaczy „gniazdo jest martwe".
///
/// `send` na gnieździe, którego druga strona już nie istnieje, kończy się
/// powodzeniem — ramka ląduje w buforze i tyle. Połączenie zerwane w połowie
/// (uśpiony NAT, przejście z Wi-Fi na sieć komórkową) nie zgłosi więc błędu
/// odbioru, a wznawianie wisi właśnie na nim. Dwa, nie jedno: pojedyncza
/// zgubiona odpowiedź zdarza się na słabej sieci.
let pingiBezOdpowiedzi = 2

/// Odstęp przed pierwszym ponowieniem i górna granica wzrostu.
let ponowienieMinMs: UInt64 = 1_000
let ponowienieMaxMs: UInt64 = 30_000

/// Długość prefiksu z identyfikatorem wpisu w kolejce (`server/src/inbox.ts`).
let bajtyIdentyfikatora = 8

/// Ile razy próbujemy przetworzyć kopertę, zanim uznamy ją za martwą.
///
/// Więcej niż raz, bo koperta może wyprzedzić commit, który jest jej potrzebny —
/// druga próba, już po commicie, się powiedzie. Potwierdzenie po pierwszym
/// niepowodzeniu kasowałoby takie koperty bezpowrotnie.
let probPrzedOdrzuceniem = 3

/// Ramka ze skrzynki: identyfikator wpisu w kolejce i sama koperta.
struct RamkaSkrzynki: Equatable, Sendable {
    let id: UInt64
    let koperta: Data
}

/// Rozdziela ramkę na identyfikator (8 bajtów big-endian) i kopertę.
///
/// `nil`, gdy ramka jest za krótka, żeby ten numer w niej był — takiej ramki nie
/// da się ani przetworzyć, ani potwierdzić, a wyjątek zrywałby połączenie
/// z powodu jednego uszkodzonego pakietu.
func rozdzielRamke(_ ramka: Data) -> RamkaSkrzynki? {
    guard ramka.count >= bajtyIdentyfikatora else { return nil }
    let bajty = [UInt8](ramka)
    var id: UInt64 = 0
    for bajt in bajty[0..<bajtyIdentyfikatora] {
        id = (id << 8) | UInt64(bajt)
    }
    return RamkaSkrzynki(id: id, koperta: Data(bajty[bajtyIdentyfikatora...]))
}

/// Co zrobić z kopertą po nieudanym przetworzeniu.
enum Decyzja: Equatable {
    /// Zostaw w kolejce — wróci przy następnym połączeniu.
    case ponow
    /// Potwierdź mimo niepowodzenia. Koperta jest martwa i ma zniknąć z kolejki.
    case odrzuc
}

/// Licznik nieudanych prób per koperta.
///
/// W pamięci, więc restart aplikacji zeruje próby — celowo: po restarcie mógł
/// dojść brakujący commit i koperta zasługuje na kolejne podejście.
final class LicznikProb {
    private var proby: [UInt64: Int] = [:]

    /// Bez potwierdzenia koperta wraca przy KAŻDYM połączeniu. Taka, której nie da
    /// się przetworzyć nigdy (powtórka, stara epoka, śmieci z sieci), krążyłaby
    /// bez końca — po kilku próbach uznajemy ją za martwą.
    func poNiepowodzeniu(_ id: UInt64) -> Decyzja {
        let proba = (proby[id] ?? 0) + 1
        if proba >= probPrzedOdrzuceniem {
            proby[id] = nil
            return .odrzuc
        }
        proby[id] = proba
        return .ponow
    }

    func poSukcesie(_ id: UInt64) {
        proby[id] = nil
    }
}

/// Przetwarza jedną ramkę i decyduje o potwierdzeniu.
///
/// # Tu jest cała ostrożność tego modułu
///
/// Potwierdzenie oznacza kopertę jako przeczytaną przez TO urządzenie, a po tym
/// serwer jej już nie odda. Dlatego pada **dopiero** po tym, jak `przetworz` się
/// powiodło — czyli gdy stan MLS i historia są już na dysku. Potwierdzenie
/// wcześniej gubi wiadomość bezpowrotnie: urządzenie po restarcie nie potrafi
/// jej odtworzyć.
///
/// Potwierdzenia są o JEDNEJ kopercie, nie znakiem wodnym: koperta odłożona do
/// ponowienia zostaje dziurą, a późniejsza, przetworzona, jest potwierdzana od
/// razu. Serwer trzyma zbiór przeczytanych identyfikatorów per urządzenie.
func obsluzRamke(
    _ ramka: Data,
    licznik: LicznikProb,
    przetworz: (Data) async throws -> Void,
    potwierdz: (UInt64) -> Void
) async {
    guard let rozdzielona = rozdzielRamke(ramka) else { return }

    do {
        try await przetworz(rozdzielona.koperta)
        potwierdz(rozdzielona.id)
        licznik.poSukcesie(rozdzielona.id)
    } catch is CancellationError {
        // Anulowanie zadania NIE jest błędem koperty. Liczone jako niepowodzenie
        // po kilku zamknięciach aplikacji potwierdziłoby — czyli skasowało —
        // kopertę zdrową, tylko nieprzetworzoną do końca.
    } catch {
        // Nieudane przetworzenie jest sytuacją spodziewaną: powtórka, stara
        // epoka, spreparowane dane. Nie jest błędem do pokazania użytkownikowi.
        if licznik.poNiepowodzeniu(rozdzielona.id) == .odrzuc {
            potwierdz(rozdzielona.id)
        }
    }
}

/// Stan połączenia ze skrzynką — do pokazania użytkownikowi.
enum StanPolaczenia: Sendable {
    case laczenie, polaczone, rozlaczone
}

/// Trwałe połączenie ze skrzynką: podtrzymywane i wznawiane po zerwaniu.
///
/// Bez podtrzymania bezczynne gniazdo jest zrywane po drodze, a bez wznawiania
/// nic go już nie przywraca. Odstęp między ponowieniami rośnie, żeby telefon bez
/// sieci nie próbował co sekundę; jest ograniczony z góry, bo po odzyskaniu
/// zasięgu wiadomości mają przyjść od razu, a nie po kilku minutach.
actor PolaczenieZeSkrzynka {
    typealias Potwierdz = @Sendable (UInt64) -> Void

    private let adres: URL
    /// Token pobierany przy KAŻDYM łączeniu — wygasa po dobie, a wznowienie ze
    /// starym kończyłoby się 401 w nieskończoność.
    private let token: @Sendable () async -> String
    private let naRamke: @Sendable (Data, @escaping Potwierdz) -> Void
    private let naStan: @Sendable (StanPolaczenia) -> Void
    private let sesja: URLSession

    private var zadanie: URLSessionWebSocketTask?
    /// Numer bieżącego połączenia. Zdarzenia starszych są ignorowane — inaczej
    /// zerwanie poprzedniego gniazda planowałoby ponowienie obok działającego.
    private var pokolenie = 0
    private var bezOdpowiedzi = 0
    private var odstepMs = ponowienieMinMs
    private var otwarte = false
    private var zamkniete = false
    private var podtrzymanie: Task<Void, Never>?
    private var ponowienie: Task<Void, Never>?

    init(
        adres: URL,
        token: @escaping @Sendable () async -> String,
        naRamke: @escaping @Sendable (Data, @escaping Potwierdz) -> Void,
        naStan: @escaping @Sendable (StanPolaczenia) -> Void
    ) {
        self.adres = adres
        self.token = token
        self.naRamke = naRamke
        self.naStan = naStan
        // Bez limitu bezczynności: gniazdo skrzynki z założenia milczy między
        // wiadomościami, a o jego życiu rozstrzyga podtrzymanie, nie zegar.
        let konfiguracja = URLSessionConfiguration.default
        konfiguracja.timeoutIntervalForRequest = 60 * 60 * 24
        self.sesja = URLSession(configuration: konfiguracja)
    }

    func polacz() async {
        guard !zamkniete else { return }
        pokolenie += 1
        let moje = pokolenie
        otwarte = false
        bezOdpowiedzi = 0
        naStan(.laczenie)

        let biezacyToken = await token()
        guard !zamkniete, moje == pokolenie else { return }

        let nowe = sesja.webSocketTask(with: adres, protocols: [biezacyToken])
        nowe.maximumMessageSize = 16 * 1024 * 1024
        zadanie = nowe
        nowe.resume()

        // Pierwszy ping od razu: pierwsza odpowiedź (pong albo zaległa koperta)
        // jest dla nas sygnałem, że uzgodnienie się udało.
        nowe.send(.string("ping")) { _ in }

        Task { await self.odbieraj(nowe, pokolenie: moje) }
        uruchomPodtrzymanie(nowe, pokolenie: moje)
    }

    /// Zamyka na stałe. Po tym nie ma już ponowień.
    func zamknij() {
        zamkniete = true
        podtrzymanie?.cancel()
        ponowienie?.cancel()
        zadanie?.cancel(with: .normalClosure, reason: nil)
        zadanie = nil
        sesja.invalidateAndCancel()
    }

    private func odbieraj(_ gniazdo: URLSessionWebSocketTask, pokolenie moje: Int) async {
        while true {
            let wiadomosc: URLSessionWebSocketTask.Message
            do {
                wiadomosc = try await gniazdo.receive()
            } catch {
                rozlaczono(pokolenie: moje)
                return
            }
            guard moje == pokolenie else { return }

            // Cokolwiek przyszło, przyszło od żywej drugiej strony.
            bezOdpowiedzi = 0
            if !otwarte {
                otwarte = true
                // Zerowanie odstępu dopiero po UDANYM połączeniu: zerowane przy
                // próbie dawałoby najkrótszy odstęp akurat wtedy, gdy serwer
                // odrzuca od razu — czyli gdy czekanie jest najbardziej potrzebne.
                odstepMs = ponowienieMinMs
                naStan(.polaczone)
            }

            switch wiadomosc {
            case .data(let ramka):
                // Potwierdzamy przez gniazdo, KTÓRE ramkę przyniosło. Wspólna
                // referencja trafiałaby po wznowieniu w gniazdo już zamknięte,
                // a koperta zostawałaby w kolejce na zawsze.
                naRamke(ramka) { id in
                    gniazdo.send(.string("ack:\(id)")) { _ in }
                }
            case .string:
                // Tekst z serwera to wyłącznie `pong` — koperty idą binarnie.
                break
            @unknown default:
                break
            }
        }
    }

    private func uruchomPodtrzymanie(_ gniazdo: URLSessionWebSocketTask, pokolenie moje: Int) {
        podtrzymanie?.cancel()
        podtrzymanie = Task { [weak self] in
            while !Task.isCancelled {
                try? await Task.sleep(nanoseconds: pingCoSekund * 1_000_000_000)
                guard !Task.isCancelled, let self else { return }
                await self.tyknij(gniazdo, pokolenie: moje)
            }
        }
    }

    private func tyknij(_ gniazdo: URLSessionWebSocketTask, pokolenie moje: Int) {
        guard moje == pokolenie else { return }
        if bezOdpowiedzi >= pingiBezOdpowiedzi {
            // Milczenie po kilku podtrzymaniach znaczy martwe gniazdo, choć nikt
            // nas o tym nie powiadomił. Zamykamy sami — błąd odbioru wznowi.
            podtrzymanie?.cancel()
            gniazdo.cancel(with: .goingAway, reason: nil)
        } else {
            bezOdpowiedzi += 1
            gniazdo.send(.string("ping")) { _ in }
        }
    }

    private func rozlaczono(pokolenie moje: Int) {
        guard moje == pokolenie, !zamkniete else { return }
        podtrzymanie?.cancel()
        naStan(.rozlaczone)
        guard ponowienie == nil else { return }

        let czekaj = odstepMs
        odstepMs = min(odstepMs * 2, ponowienieMaxMs)
        ponowienie = Task { [weak self] in
            try? await Task.sleep(nanoseconds: czekaj * 1_000_000)
            guard let self, !Task.isCancelled else { return }
            await self.ponow()
        }
    }

    private func ponow() async {
        ponowienie = nil
        await polacz()
    }
}
