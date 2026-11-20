import SwiftUI

/// Czytnik ścieżek SVG dla zestawu ikon.
///
/// # Dlaczego parser, a nie ścieżki przepisane na wywołania `Path`
///
/// Bo jedynym źródłem ikon jest `design/ikony.mjs` w notacji SVG, a wygenerowany
/// `Ikony.swift` niesie te same napisy znak w znak — tak jak Android podaje je
/// `PathParser`, a web wprost do `<path d=…>`. Przepisanie na `move/addLine`
/// w generatorze byłoby drugą definicją kształtu, a test porównujący napisy
/// przestałby cokolwiek pilnować.
///
/// Obsługuje polecenia M L H V C S Q T A Z w obu wielkościach liter — źródło
/// używa dziś M L H V C A Z, reszta jest po to, żeby nowa ikona nie wymagała
/// zmiany tutaj.
enum SciezkaSvg {
    static func path(_ d: String) -> Path {
        var path = Path()
        var tokeny = Tokenizer(d)
        var polecenie: Character = "M"
        var biezacy = CGPoint.zero
        var poczatek = CGPoint.zero
        var ostatniKontrolny: CGPoint?
        var poprzednie: Character = " "

        while let nastepny = tokeny.polecenieLubNil() {
            if let litera = nastepny { polecenie = litera }
            let wzgledne = polecenie.isLowercase
            let p = Character(polecenie.uppercased())
            func punkt(_ x: CGFloat, _ y: CGFloat) -> CGPoint {
                wzgledne ? CGPoint(x: biezacy.x + x, y: biezacy.y + y) : CGPoint(x: x, y: y)
            }

            switch p {
            case "M":
                guard let x = tokeny.liczba(), let y = tokeny.liczba() else { return path }
                biezacy = punkt(x, y)
                poczatek = biezacy
                path.move(to: biezacy)
                // Kolejne pary po M są niejawnymi L.
                polecenie = wzgledne ? "l" : "L"
                ostatniKontrolny = nil
            case "L":
                guard let x = tokeny.liczba(), let y = tokeny.liczba() else { return path }
                biezacy = punkt(x, y)
                path.addLine(to: biezacy)
                ostatniKontrolny = nil
            case "H":
                guard let x = tokeny.liczba() else { return path }
                biezacy = CGPoint(x: wzgledne ? biezacy.x + x : x, y: biezacy.y)
                path.addLine(to: biezacy)
                ostatniKontrolny = nil
            case "V":
                guard let y = tokeny.liczba() else { return path }
                biezacy = CGPoint(x: biezacy.x, y: wzgledne ? biezacy.y + y : y)
                path.addLine(to: biezacy)
                ostatniKontrolny = nil
            case "C":
                guard let x1 = tokeny.liczba(), let y1 = tokeny.liczba(), let x2 = tokeny.liczba(),
                      let y2 = tokeny.liczba(), let x = tokeny.liczba(), let y = tokeny.liczba() else { return path }
                let k1 = punkt(x1, y1), k2 = punkt(x2, y2), cel = punkt(x, y)
                path.addCurve(to: cel, control1: k1, control2: k2)
                ostatniKontrolny = k2
                biezacy = cel
            case "S":
                guard let x2 = tokeny.liczba(), let y2 = tokeny.liczba(), let x = tokeny.liczba(),
                      let y = tokeny.liczba() else { return path }
                let k1 = "CS".contains(poprzednie) ? odbicie(ostatniKontrolny, wokol: biezacy) : biezacy
                let k2 = punkt(x2, y2), cel = punkt(x, y)
                path.addCurve(to: cel, control1: k1, control2: k2)
                ostatniKontrolny = k2
                biezacy = cel
            case "Q":
                guard let x1 = tokeny.liczba(), let y1 = tokeny.liczba(), let x = tokeny.liczba(),
                      let y = tokeny.liczba() else { return path }
                let k = punkt(x1, y1), cel = punkt(x, y)
                path.addQuadCurve(to: cel, control: k)
                ostatniKontrolny = k
                biezacy = cel
            case "T":
                guard let x = tokeny.liczba(), let y = tokeny.liczba() else { return path }
                let k = "QT".contains(poprzednie) ? odbicie(ostatniKontrolny, wokol: biezacy) : biezacy
                let cel = punkt(x, y)
                path.addQuadCurve(to: cel, control: k)
                ostatniKontrolny = k
                biezacy = cel
            case "A":
                guard let rx = tokeny.liczba(), let ry = tokeny.liczba(), let obrot = tokeny.liczba(),
                      let duzy = tokeny.flaga(), let zgodnie = tokeny.flaga(),
                      let x = tokeny.liczba(), let y = tokeny.liczba() else { return path }
                let cel = punkt(x, y)
                dodajLuk(&path, od: biezacy, do: cel, rx: rx, ry: ry, obrotStopnie: obrot, duzy: duzy, zgodnie: zgodnie)
                biezacy = cel
                ostatniKontrolny = nil
            case "Z":
                path.closeSubpath()
                biezacy = poczatek
                ostatniKontrolny = nil
            default:
                return path
            }
            poprzednie = p
        }
        return path
    }

    private static func odbicie(_ punkt: CGPoint?, wokol srodek: CGPoint) -> CGPoint {
        guard let punkt else { return srodek }
        return CGPoint(x: 2 * srodek.x - punkt.x, y: 2 * srodek.y - punkt.y)
    }

    /// Łuk eliptyczny SVG zamieniony na krzywe Béziera (SVG 1.1, dodatek F.6).
    private static func dodajLuk(_ path: inout Path, od p0: CGPoint, do p1: CGPoint, rx rxWe: CGFloat, ry ryWe: CGFloat,
                                 obrotStopnie: CGFloat, duzy: Bool, zgodnie: Bool) {
        if p0 == p1 { return }
        var rx = abs(rxWe), ry = abs(ryWe)
        if rx == 0 || ry == 0 {
            path.addLine(to: p1)
            return
        }
        let phi = obrotStopnie * .pi / 180
        let cosPhi = cos(phi), sinPhi = sin(phi)
        let dx = (p0.x - p1.x) / 2, dy = (p0.y - p1.y) / 2
        let x1p = cosPhi * dx + sinPhi * dy
        let y1p = -sinPhi * dx + cosPhi * dy

        let lambda = (x1p * x1p) / (rx * rx) + (y1p * y1p) / (ry * ry)
        if lambda > 1 {
            rx *= sqrt(lambda)
            ry *= sqrt(lambda)
        }

        let licznik = rx * rx * ry * ry - rx * rx * y1p * y1p - ry * ry * x1p * x1p
        let mianownik = rx * rx * y1p * y1p + ry * ry * x1p * x1p
        var wsp = sqrt(max(0, licznik / mianownik))
        if duzy == zgodnie { wsp = -wsp }
        let cxp = wsp * rx * y1p / ry
        let cyp = -wsp * ry * x1p / rx
        let cx = cosPhi * cxp - sinPhi * cyp + (p0.x + p1.x) / 2
        let cy = sinPhi * cxp + cosPhi * cyp + (p0.y + p1.y) / 2

        func kat(_ ux: CGFloat, _ uy: CGFloat, _ vx: CGFloat, _ vy: CGFloat) -> CGFloat {
            let znak: CGFloat = (ux * vy - uy * vx) < 0 ? -1 : 1
            let iloczyn = (ux * vx + uy * vy) / (sqrt(ux * ux + uy * uy) * sqrt(vx * vx + vy * vy))
            return znak * acos(min(1, max(-1, iloczyn)))
        }
        let theta1 = kat(1, 0, (x1p - cxp) / rx, (y1p - cyp) / ry)
        var delta = kat((x1p - cxp) / rx, (y1p - cyp) / ry, (-x1p - cxp) / rx, (-y1p - cyp) / ry)
        if !zgodnie && delta > 0 { delta -= 2 * .pi }
        if zgodnie && delta < 0 { delta += 2 * .pi }

        let odcinki = Int(ceil(abs(delta) / (.pi / 2)))
        let krok = delta / CGFloat(odcinki)
        let k = 4.0 / 3.0 * tan(krok / 4)
        var t = theta1
        for _ in 0..<odcinki {
            let cos1 = cos(t), sin1 = sin(t), cos2 = cos(t + krok), sin2 = sin(t + krok)
            func naElipsie(_ x: CGFloat, _ y: CGFloat) -> CGPoint {
                CGPoint(x: cx + rx * x * cosPhi - ry * y * sinPhi, y: cy + rx * x * sinPhi + ry * y * cosPhi)
            }
            let k1 = naElipsie(cos1 - k * sin1, sin1 + k * cos1)
            let k2 = naElipsie(cos2 + k * sin2, sin2 - k * cos2)
            let koniec = naElipsie(cos2, sin2)
            path.addCurve(to: koniec, control1: k1, control2: k2)
            t += krok
        }
    }

    /// Rozbiór ciągu na polecenia i liczby.
    private struct Tokenizer {
        private let znaki: [Character]
        private var i = 0

        init(_ d: String) { znaki = Array(d) }

        private mutating func pominSeparatory() {
            while i < znaki.count, znaki[i] == " " || znaki[i] == "," || znaki[i].isNewline { i += 1 }
        }

        /// `.some(litera)` przy nowym poleceniu, `.some(nil)` gdy dalej idą liczby
        /// poprzedniego (powtórzenie niejawne), `nil` na końcu ciągu.
        mutating func polecenieLubNil() -> Character?? {
            pominSeparatory()
            guard i < znaki.count else { return nil }
            if znaki[i].isLetter {
                defer { i += 1 }
                return .some(znaki[i])
            }
            return .some(nil)
        }

        mutating func liczba() -> CGFloat? {
            pominSeparatory()
            let start = i
            if i < znaki.count, znaki[i] == "-" || znaki[i] == "+" { i += 1 }
            var kropka = false
            while i < znaki.count {
                let z = znaki[i]
                if z.isNumber { i += 1 } else if z == ".", !kropka { kropka = true; i += 1 } else { break }
            }
            if i < znaki.count, znaki[i] == "e" || znaki[i] == "E" {
                i += 1
                if i < znaki.count, znaki[i] == "-" || znaki[i] == "+" { i += 1 }
                while i < znaki.count, znaki[i].isNumber { i += 1 }
            }
            guard i > start, let wartosc = Double(String(znaki[start..<i])) else { return nil }
            return CGFloat(wartosc)
        }

        /// Flagi łuku bywają sklejone („011") — czytamy jedną cyfrę.
        mutating func flaga() -> Bool? {
            pominSeparatory()
            guard i < znaki.count, znaki[i] == "0" || znaki[i] == "1" else { return nil }
            defer { i += 1 }
            return znaki[i] == "1"
        }
    }
}

/// Ikona konturowa z zestawu — kolor bierze z otoczenia (`foregroundStyle`).
///
/// Kontur 1,8 na płótnie 24×24, zakończenia i złączenia zaokrąglone, nigdy
/// wypełniona: w tym systemie kolor niesie stan, a nie sama ikona.
struct Ikona: View {
    let nazwa: NazwaIkony
    var rozmiar: CGFloat = 18

    var body: some View {
        KsztaltIkony(sciezka: nazwa.sciezka)
            .stroke(style: StrokeStyle(lineWidth: Ikony.grubosc * rozmiar / Ikony.plotno, lineCap: .round, lineJoin: .round))
            .frame(width: rozmiar, height: rozmiar)
            .accessibilityHidden(true)
    }
}

/// Ścieżka ikony przeskalowana z płótna 24×24 do ramki.
struct KsztaltIkony: Shape {
    let sciezka: String

    func path(in prostokat: CGRect) -> Path {
        let skala = min(prostokat.width, prostokat.height) / Ikony.plotno
        return SciezkaSvg.path(sciezka)
            .applying(CGAffineTransform(scaleX: skala, y: skala))
            .offsetBy(dx: prostokat.minX, dy: prostokat.minY)
    }
}
