import SwiftUI

/// Ustawienia: konto, wygląd, prywatność, wylogowanie.
///
/// # Dlaczego karty na `tlo`, a nie systemowa `Form`
///
/// `Form` w stylu grupowanym kładzie białe karty na szarym tle — w neutralnej
/// palecie to dwie powierzchnie, które różnią się o jeden stopień, i ekran
/// zaczyna wyglądać jak inna aplikacja niż lista rozmów obok. Karty z obrysem
/// `linia` na tym samym `tlo` są tym, co rysuje web i Android.
struct EkranUstawien: View {
    @Environment(ModelAplikacji.self) private var model
    @Bindable private var preferencje = Preferencje.wspolne
    @State private var nick = ""
    @State private var pytajOWylogowanie = false

    var body: some View {
        ScrollView {
            VStack(spacing: 0) {
                if let konto = model.konto {
                    KartaKonta(konto: konto, nick: model.nazwy.mojNick)
                        .padding(.top, Miary.odstep2)
                }

                NaglowekSekcji(tekst: t("Profil", "Profile"))
                Karta {
                    VStack(alignment: .leading, spacing: Miary.odstep2) {
                        Text(t("Nick widoczny dla rozmówców", "Nickname shown to others"))
                            .font(Pismo.meta)
                            .foregroundStyle(Kolory.tekstDrugi)
                        HStack(spacing: Miary.odstep2) {
                            Pole(tytul: model.konto?.username ?? "", tekst: $nick)
                            Button(t("Zapisz", "Save")) {
                                Task {
                                    await model.ustawMojNick(nick)
                                    model.pokazInformacje(t("Nick zapisany.", "Nickname saved."))
                                }
                            }
                            .buttonStyle(StylObrys())
                            .frame(width: 96)
                            .disabled(nick == model.nazwy.mojNick)
                        }
                        Text(t(
                            "Nick jedzie do rozmówców zaszyfrowany, jak każda wiadomość. Serwer go nie zna.",
                            "Your nickname travels encrypted, like any message. The server never sees it."
                        ))
                        .font(Pismo.podpis)
                        .foregroundStyle(Kolory.tekstDrugi)
                        .fixedSize(horizontal: false, vertical: true)
                    }
                    .padding(Miary.odstep4)
                }

                NaglowekSekcji(tekst: t("Wygląd", "Appearance"))
                Karta {
                    WierszWyboru(ikona: preferencje.motyw == .ciemny ? .ksiezyc : .slonce, tytul: t("Motyw", "Theme")) {
                        Picker(t("Motyw", "Theme"), selection: $preferencje.motyw) {
                            Text(t("Auto", "Auto")).tag(Motyw.auto)
                            Text(t("Jasny", "Light")).tag(Motyw.jasny)
                            Text(t("Ciemny", "Dark")).tag(Motyw.ciemny)
                        }
                        .pickerStyle(.segmented)
                        .frame(width: 190)
                    }
                    Separator(wciecie: 52)
                    WierszWyboru(ikona: .rozmowy, tytul: t("Język", "Language")) {
                        PrzelacznikJezyka()
                    }
                }

                NaglowekSekcji(tekst: t("Prywatność", "Privacy"))
                Karta {
                    VStack(alignment: .leading, spacing: Miary.odstep1) {
                        Toggle(isOn: $preferencje.potwierdzeniaOdczytu) {
                            HStack(spacing: Miary.odstep3) {
                                Ikona(nazwa: .dostarczone, rozmiar: 20).foregroundStyle(Kolory.tekstDrugi)
                                Text(t("Potwierdzenia odczytu", "Read receipts"))
                                    .font(Pismo.tresc)
                                    .foregroundStyle(Kolory.tekst)
                            }
                        }
                        .tint(Kolory.glowny)
                        Text(t(
                            "Wyłączone działa w obie strony: nie wysyłasz swoich i nie widzisz cudzych.",
                            "Off works both ways: you don't send yours and don't see others'."
                        ))
                        .font(Pismo.podpis)
                        .foregroundStyle(Kolory.tekstDrugi)
                        .padding(.leading, 32)
                        .fixedSize(horizontal: false, vertical: true)
                    }
                    .padding(Miary.odstep4)
                }

                if let odcisk = model.odciskUrzadzenia() {
                    NaglowekSekcji(tekst: t("To urządzenie", "This device"))
                    Karta {
                        VStack(alignment: .leading, spacing: Miary.odstep2) {
                            HStack(spacing: Miary.odstep3) {
                                Ikona(nazwa: .odcisk, rozmiar: 20).foregroundStyle(Kolory.tekstDrugi)
                                Text(t("Odcisk klucza", "Key fingerprint"))
                                    .font(Pismo.tresc)
                                    .foregroundStyle(Kolory.tekst)
                            }
                            Text(odcisk)
                                .font(.system(size: 13, design: .monospaced))
                                .foregroundStyle(Kolory.tekstDrugi)
                                .textSelection(.enabled)
                                .fixedSize(horizontal: false, vertical: true)
                        }
                        .padding(Miary.odstep4)
                    }
                }

                NaglowekSekcji(tekst: t("Serwer", "Server"))
                Karta {
                    HStack(spacing: Miary.odstep3) {
                        Ikona(nazwa: .przezSerwer, rozmiar: 20).foregroundStyle(Kolory.tekstDrugi)
                        Text(Konfiguracja.adresApi)
                            .font(Pismo.meta)
                            .foregroundStyle(Kolory.tekst)
                            .lineLimit(1)
                            .truncationMode(.middle)
                    }
                    .padding(Miary.odstep4)
                }

                Button {
                    pytajOWylogowanie = true
                } label: {
                    Label { Text(t("Wyloguj z tego urządzenia", "Sign out of this device")) } icon: {
                        Ikona(nazwa: .wyloguj, rozmiar: 18)
                    }
                }
                .buttonStyle(StylNiszczacy())
                .padding(.horizontal, Miary.odstep4)
                .padding(.top, Miary.odstep6)

                Text("Mekamb \(wersja)")
                    .font(Pismo.podpis)
                    .foregroundStyle(Kolory.tekstTrzeci)
                    .padding(.top, Miary.odstep4)
                    .padding(.bottom, Miary.odstep6)
            }
        }
        .background(Kolory.tlo)
        // Ten sam nagłówek co na liście rozmów — tytuł na samej górze, bez
        // pustego rzędu systemowego paska nad nim.
        .safeAreaInset(edge: .top, spacing: 0) {
            NaglowekEkranu(tytul: t("Ustawienia", "Settings"))
                .background(Kolory.tlo)
        }
        .toolbar(.hidden, for: .navigationBar)
        .onAppear { nick = model.nazwy.mojNick }
        .confirmationDialog(
            t("Wylogować się?", "Sign out?"),
            isPresented: $pytajOWylogowanie,
            titleVisibility: .visible
        ) {
            Button(t("Wyloguj i usuń dane", "Sign out and erase data"), role: .destructive) {
                Task { await model.wyloguj() }
            }
        } message: {
            Text(t(
                "Historia rozmów jest tylko na tym urządzeniu — po wylogowaniu zniknie bezpowrotnie.",
                "Chat history lives only on this device — signing out erases it for good."
            ))
        }
    }

    private var wersja: String {
        Bundle.main.object(forInfoDictionaryKey: "CFBundleShortVersionString") as? String ?? ""
    }
}

private struct KartaKonta: View {
    let konto: Konto
    let nick: String

    var body: some View {
        HStack(spacing: Miary.odstep3) {
            Awatar(nazwa: nick.isEmpty ? konto.username : nick, rozmiar: 56)
            VStack(alignment: .leading, spacing: 2) {
                Text(nick.isEmpty ? konto.username : nick)
                    .font(Pismo.naglowek)
                    .foregroundStyle(Kolory.tekst)
                Text("@\(konto.username)")
                    .font(Pismo.meta)
                    .foregroundStyle(Kolory.tekstDrugi)
                Text(konto.deviceId)
                    .font(.system(size: 12, design: .monospaced))
                    .foregroundStyle(Kolory.tekstTrzeci)
            }
            Spacer()
        }
        .padding(Miary.odstep4)
        .background(Kolory.karta, in: RoundedRectangle(cornerRadius: Miary.promienL))
        .overlay(RoundedRectangle(cornerRadius: Miary.promienL).strokeBorder(Kolory.linia))
        .padding(.horizontal, Miary.odstep4)
    }
}

/// Wiersz karty: ikona, tytuł, kontrolka po prawej.
private struct WierszWyboru<Kontrolka: View>: View {
    let ikona: NazwaIkony
    let tytul: String
    @ViewBuilder let kontrolka: Kontrolka

    var body: some View {
        HStack(spacing: Miary.odstep3) {
            Ikona(nazwa: ikona, rozmiar: 20).foregroundStyle(Kolory.tekstDrugi)
            Text(tytul)
                .font(Pismo.tresc)
                .foregroundStyle(Kolory.tekst)
            Spacer(minLength: Miary.odstep2)
            kontrolka
        }
        .padding(.horizontal, Miary.odstep4)
        .frame(minHeight: 56)
    }
}

// MARK: - Podglądy

#Preview("Ustawienia") {
    NavigationStack { EkranUstawien() }
        .environment(ModelAplikacji.podglad())
}

#Preview("Ustawienia — jasny") {
    NavigationStack { EkranUstawien() }
        .environment(ModelAplikacji.podglad())
        .preferredColorScheme(.light)
}
