import SwiftUI
import UIKit

/// Tokeny systemu „Neutralny" — role, nie stopnie skali.
///
/// # Dlaczego role
///
/// Z dwoma motywami stopień skali nie ma stałego znaczenia: „600" jest jaśniejsze
/// od tła w ciemnym i musi być ciemniejsze w jasnym, więc każde użycie
/// wymagałoby warunku, a jeden przeoczony warunek to ciemna plama na jasnym
/// ekranie. Reguła zapisana raz — `tekstDrugi`, `linia`, `babelWlasny` — działa
/// w obu motywach.
///
/// Wartości są przepisane z tabeli w `docs/UI_NEUTRALNY.md`, która jest dla
/// wyglądu normatywna. Zmiana wyglądu to zmiana tej tabeli i tokenów na trzech
/// platformach naraz, nie dobieranie odcieni na jednej.
///
/// Kolory są dynamiczne (`UIColor` z dostawcą), więc rozstrzyga je motyw
/// widoku — także ten wymuszony przez `.preferredColorScheme` z ustawień.
enum Kolory {
    static let tlo = Color(jasny: 0xFFFFFF, ciemny: 0x0A0A0A)
    static let karta = Color(jasny: 0xFFFFFF, ciemny: 0x171717)
    static let wglebienie = Color(jasny: 0xF5F5F5, ciemny: 0x262626)
    static let wglebienieMocne = Color(jasny: 0xE5E5E5, ciemny: 0x404040)
    static let tekst = Color(jasny: 0x0A0A0A, ciemny: 0xFAFAFA)
    static let tekstDrugi = Color(jasny: 0x737373, ciemny: 0xA3A3A3)
    static let tekstTrzeci = Color(jasny: 0xA3A3A3, ciemny: 0x737373)
    static let linia = Color(jasny: 0xE5E5E5, alfaJasny: 1, ciemny: 0xFFFFFF, alfaCiemny: 0.10)
    static let liniaMocna = Color(jasny: 0xD4D4D4, alfaJasny: 1, ciemny: 0xFFFFFF, alfaCiemny: 0.15)
    static let pierscien = Color(jasny: 0xA3A3A3, ciemny: 0x737373)
    static let glowny = Color(jasny: 0x171717, ciemny: 0xE5E5E5)
    static let glownyTekst = Color(jasny: 0xFAFAFA, ciemny: 0x171717)
    static let alarm = Color(jasny: 0xDC2626, ciemny: 0xF87171)
    static let alarmTlo = Color(jasny: 0xFEF2F2, ciemny: 0x450A0A)
    static let sukces = Color(jasny: 0x16A34A, ciemny: 0x4ADE80)
    static let ostrzezenie = Color(jasny: 0xD97706, ciemny: 0xFBBF24)
    static let nakladka = Color(jasny: 0x000000, alfaJasny: 0.40, ciemny: 0x000000, alfaCiemny: 0.60)

    /// Dymek rozmówcy: `wglebienie` + `tekst`. Własny: `glowny` + `glownyTekst`.
    /// Autor jest rozpoznawalny po jasności, nie po stronie — dlatego w wątku
    /// nie ma żadnej innej plamy `glowny` poza strzałką wysyłania.
    static let babel = wglebienie
    static let babelWlasny = glowny
    static let babelWlasnyTekst = glownyTekst
}

/// Kształt i odstępy (`docs/UI_NEUTRALNY.md`, „Kształt i odstępy").
enum Miary {
    static let promienS: CGFloat = 6
    static let promienM: CGFloat = 10
    static let promienL: CGFloat = 14
    static let promienBabel: CGFloat = 18
    static let odstep1: CGFloat = 4
    static let odstep2: CGFloat = 8
    static let odstep3: CGFloat = 12
    static let odstep4: CGFloat = 16
    static let odstep5: CGFloat = 24
    static let odstep6: CGFloat = 32
    /// Najmniejszy cel dotyku.
    static let dotyk: CGFloat = 44
}

/// Skala pisma: 12 podpis · 13 meta · 15 treść · 17 nagłówek · 22 tytuł · 28 powitanie.
enum Pismo {
    static let podpis = Font.system(size: 12)
    static let meta = Font.system(size: 13)
    static let tresc = Font.system(size: 15)
    static let trescMocna = Font.system(size: 15, weight: .medium)
    static let naglowek = Font.system(size: 17, weight: .semibold)
    static let tytul = Font.system(size: 22, weight: .semibold)
    static let powitanie = Font.system(size: 28, weight: .semibold)
    /// Kody bezpieczeństwa i odciski — SF Mono, żeby cyfry stały w kolumnach.
    static let kod = Font.system(size: 15, design: .monospaced)
}

/// Ruch: 150 ms dla stanów, 250 ms dla wejść, krzywa jak w Vaul.
enum Ruch {
    static let stan = Animation.timingCurve(0.32, 0.72, 0, 1, duration: 0.15)
    static let wejscie = Animation.timingCurve(0.32, 0.72, 0, 1, duration: 0.25)
}

extension Color {
    /// Kolor rozstrzygany przez motyw widoku.
    init(jasny: UInt32, alfaJasny: Double = 1, ciemny: UInt32, alfaCiemny: Double = 1) {
        self.init(uiColor: UIColor { cechy in
            cechy.userInterfaceStyle == .dark
                ? UIColor(rgb: ciemny, alfa: alfaCiemny)
                : UIColor(rgb: jasny, alfa: alfaJasny)
        })
    }
}

extension UIColor {
    convenience init(rgb: UInt32, alfa: Double = 1) {
        self.init(
            red: CGFloat((rgb >> 16) & 0xFF) / 255,
            green: CGFloat((rgb >> 8) & 0xFF) / 255,
            blue: CGFloat(rgb & 0xFF) / 255,
            alpha: alfa
        )
    }
}
