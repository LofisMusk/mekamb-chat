import XCTest
@testable import Mekamb

/// Sedno: układ wątku musi zgadzać się z webem (`web/src/lib/watek.ts`) —
/// seria trzymana odstępem, ogonek tylko na ostatnim dymku serii, stan
/// doręczenia tylko pod ostatnią własną wiadomością.
final class WatekTesty: XCTestCase {
    private func w(_ tresc: String, wlasna: Bool, czas: Int64) -> Wiadomosc {
        Wiadomosc(id: Data(tresc.utf8), autor: wlasna ? "ja" : "ona", tresc: tresc, wlasna: wlasna, czas: czas)
    }

    func testOgonekTylkoNaOstatnimDymkuSerii() {
        let t0: Int64 = 1_700_000_000_000
        let uklad = ulozWatek([
            w("a", wlasna: false, czas: t0),
            w("b", wlasna: false, czas: t0 + 1000),
            w("c", wlasna: true, czas: t0 + 2000),
        ])
        let dymki = uklad.compactMap { pozycja -> (String, Bool, Bool, Bool)? in
            if case let .wiadomosc(_, m, ciag, ogon, ostatniaWlasna) = pozycja { return (m.tresc, ciag, ogon, ostatniaWlasna) }
            return nil
        }
        XCTAssertEqual(dymki.map(\.0), ["a", "b", "c"])
        XCTAssertEqual(dymki.map(\.1), [false, true, false], "b dokleja się do serii a; c zaczyna nową")
        XCTAssertEqual(dymki.map(\.2), [false, true, true], "ogonek zamyka serię, nie każdy dymek")
        XCTAssertEqual(dymki.map(\.3), [false, false, true])
    }

    func testGodzinaCiszyWstawiaRozdzielacz() {
        let t0: Int64 = 1_700_000_000_000
        let uklad = ulozWatek([
            w("a", wlasna: false, czas: t0),
            w("b", wlasna: false, czas: t0 + przerwaRozdzielaczaMs + 1),
        ])
        let rozdzielacze = uklad.filter { if case .rozdzielacz = $0 { true } else { false } }
        XCTAssertEqual(rozdzielacze.count, 2, "na początku i po godzinie ciszy")
    }
}
