import SwiftUI

/// Ekrany przed zalogowaniem: powitanie, logowanie (hasło → kod), rejestracja.
struct EkranyWejscia: View {
    @Environment(ModelAplikacji.self) private var model

    var body: some View {
        ZStack {
            Kolory.tlo.ignoresSafeArea()
            TloKropki().ignoresSafeArea()
                // Kropki gasną ku dołowi, żeby nie walczyły z polami formularza.
                .mask(LinearGradient(colors: [.black, .black.opacity(0)], startPoint: .top, endPoint: .bottom))

            Group {
                switch model.ekran {
                case .powitanie: Powitanie()
                case .logowanie: Logowanie()
                case .kod: KodLogowania()
                case .rejestracja: Rejestracja()
                case let .potwierdzenie(username, sekret, uri):
                    PotwierdzenieKonta(username: username, sekret: sekret, uri: uri)
                }
            }
            .padding(.horizontal, Miary.odstep4)
            .frame(maxWidth: 480)
            .transition(.opacity)
        }
        .animation(Ruch.wejscie, value: model.ekran)
    }
}

/// Wspólny układ ekranu wejścia: tytuł, opis, treść, akcje na dole.
private struct UkladWejscia<Tresc: View>: View {
    let tytul: String
    let opis: String
    var wstecz: (() -> Void)?
    @ViewBuilder let tresc: Tresc

    /// Treść jest przyklejona do GÓRY i przewijalna, a nie wyśrodkowana
    /// odstępami: wyśrodkowany formularz skakał o pół ekranu przy każdym
    /// pojawieniu się klawiatury, więc dotknięcie trafiało w pole, które
    /// przed chwilą było gdzie indziej.
    var body: some View {
        ScrollView {
            VStack(alignment: .leading, spacing: Miary.odstep4) {
                if let wstecz {
                    Button(action: wstecz) {
                        Ikona(nazwa: .wstecz, rozmiar: 20)
                    }
                    .buttonStyle(StylDuch())
                    .accessibilityLabel(t("Wstecz", "Back"))
                    .padding(.leading, -Miary.odstep3)
                } else {
                    Color.clear.frame(height: Miary.dotyk)
                }
                naglowek
                    .padding(.top, Miary.odstep6)
                tresc
            }
            .padding(.vertical, Miary.odstep4)
        }
        .scrollDismissesKeyboard(.interactively)
        .scrollBounceBehavior(.basedOnSize)
    }

    private var naglowek: some View {
        VStack(alignment: .leading, spacing: Miary.odstep2) {
                Text(tytul)
                    .font(Pismo.powitanie)
                    .kerning(-0.56)
                    .foregroundStyle(Kolory.tekst)
                Text(opis)
                    .font(Pismo.tresc)
                    .foregroundStyle(Kolory.tekstDrugi)
                    .fixedSize(horizontal: false, vertical: true)
        }
        .padding(.bottom, Miary.odstep2)
    }
}

private struct Powitanie: View {
    @Environment(ModelAplikacji.self) private var model

    var body: some View {
        VStack(alignment: .leading, spacing: Miary.odstep4) {
            Spacer()
            HStack(spacing: Miary.odstep2) {
                Ikona(nazwa: .marka, rozmiar: 32)
                    .foregroundStyle(Kolory.tekst)
                Text("Mekamb")
                    .font(Pismo.tytul)
                    .foregroundStyle(Kolory.tekst)
            }
            Text(t("Rozmowy, których nie czyta nikt poza Wami.", "Conversations no one but you can read."))
                .font(Pismo.powitanie)
                .kerning(-0.56)
                .foregroundStyle(Kolory.tekst)
                .fixedSize(horizontal: false, vertical: true)
            Text(t(
                "Szyfrowanie end-to-end (MLS). Serwer przechowuje wyłącznie szyfrogram i nie zna Twojego hasła.",
                "End-to-end encryption (MLS). The server stores ciphertext only and never learns your password."
            ))
            .font(Pismo.tresc)
            .foregroundStyle(Kolory.tekstDrugi)
            .fixedSize(horizontal: false, vertical: true)
            Spacer()
            VStack(spacing: Miary.odstep3) {
                Button(t("Załóż konto", "Create account")) { model.ekran = .rejestracja }
                    .buttonStyle(StylGlowny())
                Button(t("Mam już konto", "I already have an account")) { model.ekran = .logowanie }
                    .buttonStyle(StylObrys())
            }
            PrzelacznikJezyka()
                .frame(maxWidth: .infinity)
                .padding(.top, Miary.odstep2)
        }
        .padding(.vertical, Miary.odstep5)
    }
}

/// Mały przełącznik PL/EN — dostępny przed zalogowaniem, bo inaczej osoba
/// nieznająca polskiego nie miałaby jak dotrzeć do ustawień.
struct PrzelacznikJezyka: View {
    @Bindable private var preferencje = Preferencje.wspolne

    var body: some View {
        Picker(t("Język", "Language"), selection: $preferencje.jezyk) {
            ForEach(Jezyk.allCases, id: \.self) { Text($0.etykieta).tag($0) }
        }
        .pickerStyle(.segmented)
        .frame(width: 120)
    }
}

private struct Logowanie: View {
    @Environment(ModelAplikacji.self) private var model
    @State private var username = ""
    @State private var haslo = ""

    var body: some View {
        UkladWejscia(
            tytul: t("Zaloguj się", "Sign in"),
            opis: t("Hasło nie opuszcza tego telefonu — serwer dostaje tylko dowód OPAQUE.",
                    "Your password never leaves this phone — the server only receives an OPAQUE proof."),
            wstecz: { model.ekran = .powitanie }
        ) {
            VStack(spacing: Miary.odstep3) {
                Pole(tytul: t("Nazwa użytkownika", "Username"), tekst: $username, zawartosc: .username)
                Pole(tytul: t("Hasło", "Password"), tekst: $haslo, haslo: true, zawartosc: .password)
                Button {
                    Task { await model.zalogujHaslem(username: username, haslo: haslo) }
                } label: {
                    if model.pracuje { ProgressView().tint(Kolory.glownyTekst) } else { Text(t("Dalej", "Continue")) }
                }
                .buttonStyle(StylGlowny())
                .disabled(username.isEmpty || haslo.isEmpty || model.pracuje)
            }
        }
        .onAppear { if username.isEmpty { username = model.konto?.username ?? "" } }
    }
}

private struct KodLogowania: View {
    @Environment(ModelAplikacji.self) private var model
    @State private var kod = ""

    var body: some View {
        UkladWejscia(
            tytul: t("Kod z aplikacji", "Authenticator code"),
            opis: t("Wpisz sześć cyfr z aplikacji uwierzytelniającej.",
                    "Enter the six digits from your authenticator app."),
            wstecz: { model.ekran = .logowanie }
        ) {
            VStack(spacing: Miary.odstep3) {
                Pole(tytul: "000000", tekst: $kod, klawiatura: .numberPad, zawartosc: .oneTimeCode)
                Button {
                    Task { await model.zalogujKodem(kod) }
                } label: {
                    if model.pracuje { ProgressView().tint(Kolory.glownyTekst) } else { Text(t("Zaloguj", "Sign in")) }
                }
                .buttonStyle(StylGlowny())
                .disabled(kod.count < 6 || model.pracuje)
            }
        }
    }
}

private struct Rejestracja: View {
    @Environment(ModelAplikacji.self) private var model
    @State private var username = ""
    @State private var haslo = ""
    @State private var powtorzone = ""

    private var niezgodne: Bool { !powtorzone.isEmpty && haslo != powtorzone }

    var body: some View {
        UkladWejscia(
            tytul: t("Nowe konto", "New account"),
            opis: t("Nazwa użytkownika jest Twoim adresem — po niej inni mogą zacząć z Tobą rozmowę.",
                    "Your username is your address — others start conversations with you by it."),
            wstecz: { model.ekran = .powitanie }
        ) {
            VStack(alignment: .leading, spacing: Miary.odstep3) {
                Pole(tytul: t("Nazwa użytkownika", "Username"), tekst: $username, zawartosc: .username)
                Pole(tytul: t("Hasło", "Password"), tekst: $haslo, haslo: true, zawartosc: .newPassword)
                Pole(tytul: t("Powtórz hasło", "Repeat password"), tekst: $powtorzone, haslo: true, zawartosc: .newPassword)
                if niezgodne {
                    Text(t("Hasła się różnią.", "Passwords don't match."))
                        .font(Pismo.podpis)
                        .foregroundStyle(Kolory.alarm)
                }
                Button {
                    Task { await model.zarejestruj(username: username, haslo: haslo) }
                } label: {
                    if model.pracuje { ProgressView().tint(Kolory.glownyTekst) } else { Text(t("Załóż konto", "Create account")) }
                }
                .buttonStyle(StylGlowny())
                .disabled(username.isEmpty || haslo.count < 8 || haslo != powtorzone || model.pracuje)
                Text(t("Co najmniej 8 znaków.", "At least 8 characters."))
                    .font(Pismo.podpis)
                    .foregroundStyle(Kolory.tekstDrugi)
            }
        }
    }
}

/// Aktywacja konta pierwszym kodem TOTP.
///
/// Konto bez potwierdzenia nie daje się zalogować, a nazwa zostaje zajęta —
/// dlatego sekret pokazujemy wprost i z kopiowaniem, a nie tylko jako link.
private struct PotwierdzenieKonta: View {
    @Environment(ModelAplikacji.self) private var model
    let username: String
    let sekret: String
    let uri: String
    @State private var kod = ""

    var body: some View {
        UkladWejscia(
            tytul: t("Drugi składnik", "Second factor"),
            opis: t("Dodaj ten sekret do aplikacji uwierzytelniającej i wpisz pierwszy kod.",
                    "Add this secret to your authenticator app and enter the first code.")
        ) {
            VStack(alignment: .leading, spacing: Miary.odstep3) {
                HStack {
                    // Bloki po cztery znaki: 32 znaki ciurkiem zawijały się
                    // w przypadkowym miejscu i trudno je było przepisać.
                    Text(sekret.blokami(4))
                        .font(Pismo.kod)
                        .foregroundStyle(Kolory.tekst)
                        .textSelection(.enabled)
                        .accessibilityIdentifier("sekret-totp")
                    Spacer()
                    Button {
                        UIPasteboard.general.string = sekret
                        model.pokazInformacje(t("Skopiowano sekret.", "Secret copied."))
                    } label: {
                        Ikona(nazwa: .kopiuj, rozmiar: 18)
                    }
                    .buttonStyle(StylDuch())
                    .accessibilityLabel(t("Kopiuj sekret", "Copy secret"))
                }
                .padding(.horizontal, Miary.odstep3)
                .background(Kolory.wglebienie, in: RoundedRectangle(cornerRadius: Miary.promienM))

                if let link = URL(string: uri) {
                    Link(t("Otwórz w aplikacji uwierzytelniającej", "Open in authenticator app"), destination: link)
                        .font(Pismo.meta)
                        .foregroundStyle(Kolory.tekst)
                        .underline()
                }

                Pole(tytul: "000000", tekst: $kod, klawiatura: .numberPad, zawartosc: .oneTimeCode)
                Button {
                    Task { await model.potwierdzRejestracje(username: username, kod: kod) }
                } label: {
                    if model.pracuje { ProgressView().tint(Kolory.glownyTekst) } else { Text(t("Aktywuj konto", "Activate account")) }
                }
                .buttonStyle(StylGlowny())
                .disabled(kod.count < 6 || model.pracuje)
            }
        }
    }
}

extension String {
    /// „ABCDEFGH" → „ABCD EFGH" — do przepisywania kodów z ekranu.
    func blokami(_ dlugosc: Int) -> String {
        stride(from: 0, to: count, by: dlugosc).map { poczatek in
            let od = index(startIndex, offsetBy: poczatek)
            let doo = index(od, offsetBy: dlugosc, limitedBy: endIndex) ?? endIndex
            return String(self[od..<doo])
        }.joined(separator: " ")
    }
}

// MARK: - Podglądy

#Preview("Powitanie") {
    EkranyWejscia()
        .environment(ModelAplikacji.podglad(zalogowany: false, ekran: .powitanie))
}

#Preview("Powitanie — jasny") {
    EkranyWejscia()
        .environment(ModelAplikacji.podglad(zalogowany: false, ekran: .powitanie))
        .preferredColorScheme(.light)
}

#Preview("Logowanie") {
    EkranyWejscia()
        .environment(ModelAplikacji.podglad(zalogowany: false, ekran: .logowanie))
}

#Preview("Kod TOTP") {
    EkranyWejscia()
        .environment(ModelAplikacji.podglad(zalogowany: false, ekran: .kod))
}

#Preview("Rejestracja") {
    EkranyWejscia()
        .environment(ModelAplikacji.podglad(zalogowany: false, ekran: .rejestracja))
}

#Preview("Aktywacja konta") {
    EkranyWejscia()
        .environment(ModelAplikacji.podglad(
            zalogowany: false,
            ekran: .potwierdzenie(username: "ola", sekret: "HMPZVBZLGZACBYYTMAGVO7RUBR5WM5PN",
                                  uri: "otpauth://totp/Mekamb:ola?secret=HMPZVBZLGZACBYYTMAGVO7RUBR5WM5PN")
        ))
}
