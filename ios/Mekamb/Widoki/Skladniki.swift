import SwiftUI

// MARK: - Przyciski

/// Akcja główna: plama `glowny`. Na ekranie najwyżej jedna taka.
///
/// W neutralnej palecie obrys nie odróżnia akcji głównej od drugorzędnej —
/// nie ma koloru, który by ją wyróżnił. Robi to jasność plamy.
struct StylGlowny: ButtonStyle {
    @Environment(\.isEnabled) private var aktywny

    func makeBody(configuration: Configuration) -> some View {
        configuration.label
            .font(Pismo.trescMocna)
            .foregroundStyle(Kolory.glownyTekst)
            .frame(maxWidth: .infinity, minHeight: 50)
            .background(Kolory.glowny, in: RoundedRectangle(cornerRadius: Miary.promienM))
            .opacity(aktywny ? (configuration.isPressed ? 0.85 : 1) : 0.4)
            .animation(Ruch.stan, value: configuration.isPressed)
    }
}

/// Akcja drugorzędna: obrys `liniaMocna`, bez tła.
struct StylObrys: ButtonStyle {
    @Environment(\.isEnabled) private var aktywny

    func makeBody(configuration: Configuration) -> some View {
        configuration.label
            .font(Pismo.trescMocna)
            .foregroundStyle(Kolory.tekst)
            .frame(maxWidth: .infinity, minHeight: 50)
            .background(configuration.isPressed ? Kolory.wglebienie : .clear, in: RoundedRectangle(cornerRadius: Miary.promienM))
            .overlay(RoundedRectangle(cornerRadius: Miary.promienM).strokeBorder(Kolory.liniaMocna))
            .opacity(aktywny ? 1 : 0.4)
            .animation(Ruch.stan, value: configuration.isPressed)
    }
}

/// „Duch": bez tła i obrysu, `wglebienie` dopiero przy wciśnięciu.
struct StylDuch: ButtonStyle {
    var niszczacy = false

    func makeBody(configuration: Configuration) -> some View {
        configuration.label
            .font(Pismo.trescMocna)
            .foregroundStyle(niszczacy ? Kolory.alarm : Kolory.tekst)
            .frame(minWidth: Miary.dotyk, minHeight: Miary.dotyk)
            .contentShape(Rectangle())
            .background(configuration.isPressed ? Kolory.wglebienie : .clear, in: RoundedRectangle(cornerRadius: Miary.promienM))
            .animation(Ruch.stan, value: configuration.isPressed)
    }
}

/// Akcja niszcząca: tekst i obrys `alarm`, nigdy plama — czerwień ma zostać sygnałem.
struct StylNiszczacy: ButtonStyle {
    func makeBody(configuration: Configuration) -> some View {
        configuration.label
            .font(Pismo.trescMocna)
            .foregroundStyle(Kolory.alarm)
            .frame(maxWidth: .infinity, minHeight: 50)
            .background(configuration.isPressed ? Kolory.alarmTlo : .clear, in: RoundedRectangle(cornerRadius: Miary.promienM))
            .overlay(RoundedRectangle(cornerRadius: Miary.promienM).strokeBorder(Kolory.alarm.opacity(0.5)))
            .animation(Ruch.stan, value: configuration.isPressed)
    }
}

// MARK: - Pole tekstowe

/// Pole na `wglebienie`; obrys `liniaMocna` pojawia się przy fokusie.
struct Pole: View {
    let tytul: String
    @Binding var tekst: String
    var haslo = false
    var klawiatura: UIKeyboardType = .default
    var zawartosc: UITextContentType?
    @FocusState private var fokus: Bool

    var body: some View {
        Group {
            if haslo {
                SecureField(tytul, text: $tekst)
            } else {
                TextField(tytul, text: $tekst)
                    .keyboardType(klawiatura)
            }
        }
        .textContentType(zawartosc)
        .textInputAutocapitalization(.never)
        .autocorrectionDisabled()
        .focused($fokus)
        .font(Pismo.tresc)
        .foregroundStyle(Kolory.tekst)
        .padding(.horizontal, Miary.odstep3)
        .frame(minHeight: 48)
        // Całe pole przyjmuje dotknięcie, nie tylko linia tekstu w środku.
        .contentShape(RoundedRectangle(cornerRadius: Miary.promienM))
        .onTapGesture { fokus = true }
        .background(Kolory.wglebienie, in: RoundedRectangle(cornerRadius: Miary.promienM))
        .overlay(
            RoundedRectangle(cornerRadius: Miary.promienM)
                .strokeBorder(fokus ? Kolory.liniaMocna : .clear, lineWidth: 1)
        )
        .animation(Ruch.stan, value: fokus)
    }
}

// MARK: - Awatar

/// Inicjały na `wglebienieMocne`, okrąg — bez zdjęć, bo zdjęcie profilowe byłoby
/// kolejną metadaną do rozsyłania.
struct Awatar: View {
    let nazwa: String
    var rozmiar: CGFloat = 40

    private var inicjaly: String {
        let czesci = nazwa.split(whereSeparator: { $0 == " " || $0 == "," || $0 == "." || $0 == "_" })
        let litery = czesci.prefix(2).compactMap(\.first)
        return litery.isEmpty ? "?" : String(litery).uppercased()
    }

    var body: some View {
        Text(inicjaly)
            .font(.system(size: rozmiar * 0.38, weight: .medium))
            .foregroundStyle(Kolory.tekst)
            .frame(width: rozmiar, height: rozmiar)
            .background(Kolory.wglebienieMocne, in: Circle())
            .accessibilityHidden(true)
    }
}

// MARK: - Znacznik nieprzeczytanych

/// Pigułka `glowny` z liczbą — odpowiada na „czy ktoś mi coś powiedział",
/// więc jest plamą. Liczba zmienia się `numericText`, jak NumberFlow w webie.
struct Znacznik: View {
    let liczba: Int

    var body: some View {
        Text("\(liczba)")
            .font(.system(size: 12, weight: .semibold))
            .monospacedDigit()
            .contentTransition(.numericText(value: Double(liczba)))
            .foregroundStyle(Kolory.glownyTekst)
            .padding(.horizontal, 7)
            .frame(minWidth: 20, minHeight: 20)
            .background(Kolory.glowny, in: Capsule())
            .animation(Ruch.wejscie, value: liczba)
    }
}

// MARK: - Toast

/// Powiadomienie chwilowe u góry: karta + linia + cień (w ciemnym zamiast cienia sama linia).
struct WidokToastu: View {
    let toast: Toast
    @Environment(\.colorScheme) private var schemat

    var body: some View {
        HStack(spacing: Miary.odstep2) {
            Ikona(nazwa: toast.rodzaj == .blad ? .ostrzezenie : .info, rozmiar: 18)
                .foregroundStyle(toast.rodzaj == .blad ? Kolory.alarm : Kolory.tekstDrugi)
            Text(toast.tekst)
                .font(Pismo.meta)
                .foregroundStyle(Kolory.tekst)
                .fixedSize(horizontal: false, vertical: true)
            Spacer(minLength: 0)
        }
        .padding(.horizontal, Miary.odstep4)
        .padding(.vertical, Miary.odstep3)
        .background(Kolory.karta, in: RoundedRectangle(cornerRadius: Miary.promienM))
        .overlay(RoundedRectangle(cornerRadius: Miary.promienM).strokeBorder(Kolory.linia))
        .shadow(color: schemat == .dark ? .clear : .black.opacity(0.05), radius: 1, y: 1)
        .padding(.horizontal, Miary.odstep4)
        .accessibilityElement(children: .combine)
        .accessibilityAddTraits(.isStaticText)
    }
}

/// Nakładka pokazująca toast u góry i chowająca go po kilku sekundach.
struct NakladkaToastu: ViewModifier {
    @Binding var toast: Toast?
    @Environment(\.accessibilityReduceMotion) private var ograniczRuch

    func body(content: Content) -> some View {
        content.overlay(alignment: .top) {
            if let toast {
                WidokToastu(toast: toast)
                    .padding(.top, Miary.odstep2)
                    // „Ogranicz ruch" wyłącza przesunięcie, zostawia przenikanie.
                    .transition(ograniczRuch ? .opacity : .move(edge: .top).combined(with: .opacity))
                    .onTapGesture { self.toast = nil }
                    .task(id: toast.id) {
                        try? await Task.sleep(nanoseconds: 4_000_000_000)
                        if self.toast?.id == toast.id { self.toast = nil }
                    }
            }
        }
        .animation(Ruch.wejscie, value: toast)
    }
}

extension View {
    func toast(_ toast: Binding<Toast?>) -> some View {
        modifier(NakladkaToastu(toast: toast))
    }
}

// MARK: - Tło powitania

/// Delikatny wzór kropek w kolorze `linia` (Magic UI *Dot Pattern*).
///
/// Jedyna ozdoba w systemie: bez gradientów i animowanych obramowań, które
/// łamałyby neutralność. `Canvas`, bo tysiąc kropek jako widoków to tysiąc węzłów.
struct TloKropki: View {
    var odstep: CGFloat = 16
    var promien: CGFloat = 1

    var body: some View {
        Canvas { kontekst, rozmiar in
            var y: CGFloat = odstep / 2
            while y < rozmiar.height {
                var x: CGFloat = odstep / 2
                while x < rozmiar.width {
                    kontekst.fill(
                        Path(ellipseIn: CGRect(x: x - promien, y: y - promien, width: promien * 2, height: promien * 2)),
                        with: .color(Kolory.liniaMocna)
                    )
                    x += odstep
                }
                y += odstep
            }
        }
        .accessibilityHidden(true)
        .allowsHitTesting(false)
    }
}

// MARK: - Nagłówek ekranu

/// Nagłówek ekranu głównego: duży tytuł i akcje W JEDNYM rzędzie, na samej górze.
///
/// # Dlaczego nie systemowy duży tytuł
///
/// `navigationTitle` w trybie dużym kładzie tytuł w osobnym rzędzie POD paskiem
/// z przyciskami — ekran tracił prawie 100 punktów, zanim pokazał pierwszą
/// rozmowę, a „+" wisiał samotnie nad tytułem. Własny rząd trzyma tytuł
/// i akcje razem i wygląda tak samo jak nagłówek kolumny na webie.
struct NaglowekEkranu<Akcje: View>: View {
    let tytul: String
    @ViewBuilder var akcje: Akcje

    var body: some View {
        HStack(alignment: .center, spacing: Miary.odstep2) {
            Text(tytul)
                .font(.system(size: 32, weight: .bold))
                .kerning(-0.64)
                .foregroundStyle(Kolory.tekst)
                .lineLimit(1)
                .accessibilityAddTraits(.isHeader)
            Spacer(minLength: Miary.odstep2)
            akcje
        }
        .frame(minHeight: Miary.dotyk)
        .padding(.horizontal, Miary.odstep4)
        .padding(.top, Miary.odstep2)
        .padding(.bottom, Miary.odstep3)
    }
}

extension NaglowekEkranu where Akcje == EmptyView {
    init(tytul: String) {
        self.init(tytul: tytul) { EmptyView() }
    }
}

/// Okrągły przycisk akcji w nagłówku: `wglebienie` + obrys `linia`, 44×44.
struct PrzyciskNaglowka: View {
    let ikona: NazwaIkony
    let opis: String
    let akcja: () -> Void

    var body: some View {
        Button(action: akcja) {
            Ikona(nazwa: ikona, rozmiar: 20)
                .foregroundStyle(Kolory.tekst)
                .frame(width: Miary.dotyk, height: Miary.dotyk)
                .background(Kolory.wglebienie, in: Circle())
                .overlay(Circle().strokeBorder(Kolory.linia))
                .contentShape(Circle())
        }
        .buttonStyle(.plain)
        .accessibilityLabel(opis)
    }
}

/// Pole szukania nad listą — pigułka `wglebienie` z lupą i czyszczeniem.
struct PoleSzukania: View {
    let podpowiedz: String
    @Binding var tekst: String
    @FocusState private var fokus: Bool

    var body: some View {
        HStack(spacing: Miary.odstep2) {
            Ikona(nazwa: .szukaj, rozmiar: 18)
                .foregroundStyle(Kolory.tekstDrugi)
            TextField(podpowiedz, text: $tekst)
                .font(Pismo.tresc)
                .foregroundStyle(Kolory.tekst)
                .textInputAutocapitalization(.never)
                .autocorrectionDisabled()
                .submitLabel(.search)
                .focused($fokus)
            if !tekst.isEmpty {
                Button {
                    tekst = ""
                } label: {
                    Ikona(nazwa: .zamknij, rozmiar: 16)
                        .foregroundStyle(Kolory.tekstDrugi)
                        .frame(width: 28, height: 28)
                        .contentShape(Rectangle())
                }
                .buttonStyle(.plain)
                .accessibilityLabel(t("Wyczyść", "Clear"))
            }
        }
        .padding(.horizontal, Miary.odstep3)
        .frame(height: 40)
        .background(Kolory.wglebienie, in: Capsule())
        .contentShape(Capsule())
        .onTapGesture { fokus = true }
        .padding(.horizontal, Miary.odstep4)
        .padding(.bottom, Miary.odstep2)
    }
}

// MARK: - Sekcje ustawień

/// Nagłówek sekcji: mały, `tekstDrugi` — porządkuje, nie krzyczy.
struct NaglowekSekcji: View {
    let tekst: String

    var body: some View {
        Text(tekst)
            .font(.system(size: 13, weight: .medium))
            .foregroundStyle(Kolory.tekstDrugi)
            .frame(maxWidth: .infinity, alignment: .leading)
            .padding(.horizontal, Miary.odstep4)
            .padding(.top, Miary.odstep5)
            .padding(.bottom, Miary.odstep2)
            .accessibilityAddTraits(.isHeader)
    }
}

/// Karta grupująca wiersze: tło `karta`, obrys `linia`.
struct Karta<Tresc: View>: View {
    @ViewBuilder let tresc: Tresc

    var body: some View {
        VStack(spacing: 0) { tresc }
            .background(Kolory.karta, in: RoundedRectangle(cornerRadius: Miary.promienM))
            .overlay(RoundedRectangle(cornerRadius: Miary.promienM).strokeBorder(Kolory.linia))
            .padding(.horizontal, Miary.odstep4)
    }
}

// MARK: - Podglądy

/// Katalog składników na jednym płótnie — do strojenia tokenów i stylów
/// bez przeklikiwania się przez aplikację.
private struct KatalogSkladnikow: View {
    @State private var tekst = ""
    @State private var haslo = "sekret123"

    var body: some View {
        ScrollView {
            VStack(alignment: .leading, spacing: Miary.odstep4) {
                NaglowekSekcji(tekst: "Przyciski")
                VStack(spacing: Miary.odstep3) {
                    Button("Główny") {}.buttonStyle(StylGlowny())
                    Button("Obrysowany") {}.buttonStyle(StylObrys())
                    Button("Niszczący") {}.buttonStyle(StylNiszczacy())
                    Button("Wyłączony") {}.buttonStyle(StylGlowny()).disabled(true)
                    HStack {
                        Button {} label: { Ikona(nazwa: .dodaj, rozmiar: 20) }.buttonStyle(StylDuch())
                        Button {} label: { Ikona(nazwa: .info, rozmiar: 20) }.buttonStyle(StylDuch())
                        Button("Usuń") {}.buttonStyle(StylDuch(niszczacy: true))
                    }
                }
                .padding(.horizontal, Miary.odstep4)

                NaglowekSekcji(tekst: "Pola")
                VStack(spacing: Miary.odstep3) {
                    Pole(tytul: "Nazwa użytkownika", tekst: $tekst)
                    Pole(tytul: "Hasło", tekst: $haslo, haslo: true)
                }
                .padding(.horizontal, Miary.odstep4)

                NaglowekSekcji(tekst: "Awatary i znaczniki")
                HStack(spacing: Miary.odstep3) {
                    Awatar(nazwa: "Ola", rozmiar: 28)
                    Awatar(nazwa: "Marek Nowak")
                    Awatar(nazwa: "Zespół projektowy", rozmiar: 56)
                    Znacznik(liczba: 3)
                    Znacznik(liczba: 128)
                }
                .padding(.horizontal, Miary.odstep4)

                NaglowekSekcji(tekst: "Toasty")
                VStack(spacing: Miary.odstep2) {
                    WidokToastu(toast: Toast(tekst: "Nick zapisany.", rodzaj: .informacja))
                    WidokToastu(toast: Toast(tekst: "Brak połączenia z serwerem.", rodzaj: .blad))
                }

                NaglowekSekcji(tekst: "Karta")
                Karta {
                    Text("Treść karty")
                        .font(Pismo.tresc)
                        .foregroundStyle(Kolory.tekst)
                        .frame(maxWidth: .infinity, alignment: .leading)
                        .padding(Miary.odstep4)
                }

                NaglowekSekcji(tekst: "Tło powitania")
                TloKropki()
                    .frame(height: 120)
                    .padding(.horizontal, Miary.odstep4)
            }
            .padding(.bottom, Miary.odstep6)
        }
        .background(Kolory.tlo)
    }
}

#Preview("Składniki — ciemny") {
    KatalogSkladnikow()
        .preferredColorScheme(.dark)
}

#Preview("Składniki — jasny") {
    KatalogSkladnikow()
        .preferredColorScheme(.light)
}
