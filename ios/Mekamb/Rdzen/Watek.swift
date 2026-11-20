import Foundation

/// Układ wątku: rozdzielacze czasu i serie dymków.
///
/// # Dlaczego to jest czystą funkcją, a nie warunkiem w widoku
///
/// Bo wszystkie decyzje są o SĄSIEDZTWIE — „czy poprzednia była tego samego
/// dnia", „czy pisała ją ta sama osoba", „czy następna zamyka serię". Warunek
/// rozsypany po `LazyVStack` sięga do sąsiada w kilku miejscach i przy pierwszej
/// zmianie sortowania zaczyna kłamać w jednym z nich.
///
/// # Dlaczego reguły są przepisane z weba
///
/// `docs/UI_NEUTRALNY.md` mówi wprost: anatomia dymków bez zmian względem weba.
/// Progi i reguły są więc te z `web/src/lib/watek.ts`: seria trzymana odstępem,
/// ogonek tylko na ostatnim dymku serii, separator czasu przy zmianie dnia i po
/// godzinie ciszy, stan doręczenia słowem pod ostatnią własną wiadomością.

/// Ile czasu między wiadomościami tej samej osoby zrywa serię.
let przerwaSeriiMs: Int64 = 5 * 60 * 1000

/// Po takiej ciszy separator czasu pojawia się także w środku dnia.
let przerwaRozdzielaczaMs: Int64 = 60 * 60 * 1000

enum PozycjaWatku: Equatable, Identifiable {
    case rozdzielacz(klucz: String, czas: Int64)
    case wiadomosc(klucz: String, wiadomosc: Wiadomosc, ciag: Bool, ogon: Bool, ostatniaWlasna: Bool)

    var id: String {
        switch self {
        case .rozdzielacz(let klucz, _), .wiadomosc(let klucz, _, _, _, _): klucz
        }
    }
}

/// Dzień w strefie urządzenia — klucz porównań, nie napis do pokazania.
private func dzien(_ czas: Int64, _ kalendarz: Calendar) -> DateComponents {
    kalendarz.dateComponents([.year, .month, .day], from: Date(timeIntervalSince1970: Double(czas) / 1000))
}

/// Etykieta separatora: „Dziś 08:42", „Wczoraj 21:10", „3 marca 14:05".
///
/// Słowem, nie datą, gdy to dziś albo wczoraj — przy rozmowie sprzed godziny
/// data odpowiada na pytanie, którego nikt nie zadał. Rok dopiero wtedy, gdy
/// wiadomość jest z innego roku.
func etykietaRozdzielacza(_ czas: Int64, teraz: Int64, jezyk: Jezyk, kalendarz: Calendar = .current) -> String {
    let data = Date(timeIntervalSince1970: Double(czas) / 1000)
    let godzina = data.formatted(.dateTime.hour(.twoDigits(amPM: .omitted)).minute(.twoDigits).locale(jezyk.locale))

    let kiedy = dzien(czas, kalendarz)
    if kiedy == dzien(teraz, kalendarz) {
        return "\(t(jezyk, "Dziś", "Today")) \(godzina)"
    }
    if kiedy == dzien(teraz - 24 * 60 * 60 * 1000, kalendarz) {
        return "\(t(jezyk, "Wczoraj", "Yesterday")) \(godzina)"
    }
    let tenSamRok = kiedy.year == dzien(teraz, kalendarz).year
    let styl: Date.FormatStyle = tenSamRok
        ? .dateTime.day().month(.wide).locale(jezyk.locale)
        : .dateTime.day().month(.wide).year().locale(jezyk.locale)
    return "\(data.formatted(styl)) \(godzina)"
}

/// Układa wątek.
///
/// Serię zrywa: separator, zmiana strony, zmiana autora, ślad po rozmowie A/V
/// i przerwa dłuższa niż `przerwaSeriiMs` — bez ostatniego dwie wiadomości
/// wysłane rano i wieczorem skleiłyby się w jedną serię.
func ulozWatek(_ wiadomosci: [Wiadomosc], kalendarz: Calendar = .current) -> [PozycjaWatku] {
    var uklad: [PozycjaWatku] = []
    var poprzednia: Wiadomosc?
    var ciagi: [Bool] = []
    var klucze = Set<String>()

    for wiadomosc in wiadomosci {
        let nowyDzien = poprzednia.map { dzien($0.czas, kalendarz) != dzien(wiadomosc.czas, kalendarz) } ?? true
        let cisza = poprzednia.map { wiadomosc.czas - $0.czas >= przerwaRozdzielaczaMs } ?? false

        if nowyDzien || cisza {
            uklad.append(.rozdzielacz(klucz: "rozdzielacz-\(wiadomosc.czas)-\(uklad.count)", czas: wiadomosc.czas))
            ciagi.append(false)
        }

        let ciag = !nowyDzien && !cisza && poprzednia.map {
            $0.rozmowa == nil && wiadomosc.rozmowa == nil &&
                $0.wlasna == wiadomosc.wlasna && $0.autor == wiadomosc.autor &&
                wiadomosc.czas - $0.czas < przerwaSeriiMs
        } == true

        // Klucz z identyfikatora; dwa identyczne stare zapisy (bez id) dostają
        // przyrostek, żeby widok nie złożył dwóch dymków pod jednym kluczem.
        var klucz = wiadomosc.klucz
        if klucze.contains(klucz) { klucz += "#\(uklad.count)" }
        klucze.insert(klucz)

        uklad.append(.wiadomosc(klucz: klucz, wiadomosc: wiadomosc, ciag: ciag, ogon: true, ostatniaWlasna: false))
        ciagi.append(ciag)
        poprzednia = wiadomosc
    }

    // Drugi przebieg od końca: ogon ma dymek, po którym seria się kończy,
    // a słowo o doręczeniu — wyłącznie ostatnia własna wiadomość.
    var znalezionaWlasna = false
    for i in uklad.indices.reversed() {
        guard case let .wiadomosc(klucz, wiadomosc, ciag, _, _) = uklad[i] else { continue }
        let nastepnaCiagnie = i + 1 < uklad.count && ciagi[i + 1]
        var ostatniaWlasna = false
        if !znalezionaWlasna && wiadomosc.wlasna && wiadomosc.rozmowa == nil {
            ostatniaWlasna = true
            znalezionaWlasna = true
        }
        uklad[i] = .wiadomosc(klucz: klucz, wiadomosc: wiadomosc, ciag: ciag, ogon: !nastepnaCiagnie, ostatniaWlasna: ostatniaWlasna)
    }

    return uklad
}
