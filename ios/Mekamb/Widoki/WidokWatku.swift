import SwiftUI

/// Wątek rozmowy: nagłówek, dymki, pole pisania.
///
/// # Dlaczego układ liczy `ulozWatek`, a widok tylko rysuje
///
/// Wszystkie decyzje wątku są o sąsiedztwie (seria, ogonek, separator czasu).
/// Rozsiane po widoku sięgałyby do sąsiada w kilku miejscach i rozjechały się
/// z webem przy pierwszej zmianie — czysta funkcja w `Watek.swift` ma testy.
struct WidokWatku: View {
    @Environment(ModelAplikacji.self) private var model
    let groupId: Data

    @State private var szkic = ""
    @State private var szczegoly = false
    @FocusState private var pisze: Bool

    private var uklad: [PozycjaWatku] { ulozWatek(model.otwarta == groupId ? model.wiadomosci : []) }

    var body: some View {
        let nazwa = model.etykieta(groupId)
        ScrollViewReader { przewijanie in
            ScrollView {
                LazyVStack(spacing: 0) {
                    NaglowekSzyfrowania()
                        .padding(.top, Miary.odstep4)
                        .padding(.bottom, Miary.odstep3)

                    ForEach(uklad) { pozycja in
                        switch pozycja {
                        case let .rozdzielacz(_, czas):
                            Rozdzielacz(czas: czas)
                        case let .wiadomosc(_, wiadomosc, ciag, ogon, ostatniaWlasna):
                            if let zapis = wiadomosc.rozmowa {
                                WpisRozmowyAV(zapis: zapis)
                                    .padding(.top, Miary.odstep3)
                            } else {
                                WierszWiadomosci(wiadomosc: wiadomosc, ogon: ogon,
                                                 pokazStan: ostatniaWlasna && model.wLocie.isEmpty)
                                    .padding(.top, ciag ? 2 : Miary.odstep3)
                            }
                        }
                    }

                    ForEach(model.wLocie) { wpis in
                        DymekWLocie(wpis: wpis) { model.ponow(wpis) }
                            .padding(.top, 2)
                    }

                    Color.clear.frame(height: Miary.odstep2).id("dol")
                }
                .padding(.horizontal, Miary.odstep3)
            }
            .scrollDismissesKeyboard(.interactively)
            .defaultScrollAnchor(.bottom)
            .background(Kolory.tlo)
            .onChange(of: model.wiadomosci.count + model.wLocie.count) {
                withAnimation(Ruch.wejscie) { przewijanie.scrollTo("dol", anchor: .bottom) }
            }
            .onChange(of: pisze) { _, teraz in
                if teraz { withAnimation(Ruch.wejscie) { przewijanie.scrollTo("dol", anchor: .bottom) } }
            }
        }
        .safeAreaInset(edge: .bottom, spacing: 0) {
            PolePisania(szkic: $szkic, fokus: $pisze) {
                model.wyslij(szkic)
                szkic = ""
            }
        }
        .navigationBarTitleDisplayMode(.inline)
        .toolbar(.hidden, for: .tabBar)
        .toolbarBackground(Kolory.tlo, for: .navigationBar)
        .toolbar {
            ToolbarItem(placement: .principal) {
                Button { szczegoly = true } label: {
                    HStack(spacing: Miary.odstep2) {
                        Awatar(nazwa: nazwa, rozmiar: 28)
                        VStack(alignment: .leading, spacing: 0) {
                            Text(nazwa)
                                .font(.system(size: 15, weight: .semibold))
                                .foregroundStyle(Kolory.tekst)
                                .lineLimit(1)
                            Text(podtytul)
                                .font(Pismo.podpis)
                                .foregroundStyle(Kolory.tekstDrugi)
                                .lineLimit(1)
                        }
                    }
                }
                .buttonStyle(.plain)
                .accessibilityHint(t("Szczegóły rozmowy", "Conversation details"))
            }
            // Wideo i głos zamiast „i": szczegóły otwiera dotknięcie nazwy
            // u góry, więc osobny przycisk był drugą drogą do tego samego.
            // Grupa, nie dwa osobne elementy — pasek w iOS 26 kładzie je wtedy
            // w jednej szklanej pigułce, jak w systemowych aplikacjach.
            // Obrazy-szablony, nie `StylDuch`: nasza ramka 44 pt w środku
            // systemowego szkła robiła z przycisku owal.
            ToolbarItemGroup(placement: .topBarTrailing) {
                Button { zadzwon(wideo: true) } label: { obrazIkony(.kamera, rozmiar: 20) }
                    .accessibilityLabel(t("Rozmowa wideo", "Video call"))
                Button { zadzwon(wideo: false) } label: { obrazIkony(.sluchawka, rozmiar: 20) }
                    .accessibilityLabel(t("Rozmowa głosowa", "Voice call"))
            }
        }
        .sheet(isPresented: $szczegoly) {
            SzczegolyRozmowy(groupId: groupId)
                .presentationDetents([.medium, .large])
                .presentationDragIndicator(.visible)
                .presentationBackground(Kolory.karta)
                .presentationCornerRadius(16)
        }
        .onAppear { model.otworz(groupId) }
        .onDisappear { model.zamknijRozmowe(groupId) }
    }

    private func zadzwon(wideo: Bool) {
        model.zadzwon(groupId, wideo: wideo)
    }

    private var podtytul: String {
        let osoby = model.uczestnicy(groupId).count
        if osoby > 2 { return t("\(osoby) osób", "\(osoby) people") }
        return t("szyfrowane end-to-end", "end-to-end encrypted")
    }
}

/// Informacja na początku wątku — jedno zdanie o tym, co tu jest chronione.
private struct NaglowekSzyfrowania: View {
    var body: some View {
        HStack(spacing: 6) {
            Ikona(nazwa: .blokada, rozmiar: 13)
            Text(t("Wiadomości są szyfrowane end-to-end (MLS).", "Messages are end-to-end encrypted (MLS)."))
        }
        .font(Pismo.podpis)
        .foregroundStyle(Kolory.tekstDrugi)
        .padding(.horizontal, Miary.odstep3)
        .padding(.vertical, 6)
        .background(Kolory.wglebienie, in: Capsule())
        .frame(maxWidth: .infinity)
    }
}

/// Ślad rozmowy A/V w wątku — wyśrodkowany, bo to zdarzenie, nie czyjaś wypowiedź.
///
/// Nieodebrana rozmowa przychodząca dostaje kolor alarmu: to jedyna sytuacja,
/// w której ślad wymaga od czytającego czegoś (oddzwonienia).
private struct WpisRozmowyAV: View {
    let zapis: ZapisRozmowyAV

    var body: some View {
        let nieodebrana = zapis.sekundy == nil && !zapis.wychodzaca
        HStack(spacing: 6) {
            Ikona(nazwa: zapis.wideo ? .kamera : .sluchawka, rozmiar: 14)
            Text(opis)
        }
        .font(Pismo.meta)
        .foregroundStyle(nieodebrana ? Kolory.alarm : Kolory.tekstDrugi)
        .padding(.horizontal, Miary.odstep3)
        .padding(.vertical, 6)
        .background(Kolory.wglebienie, in: Capsule())
        .frame(maxWidth: .infinity)
        .accessibilityElement(children: .combine)
    }

    private var opis: String {
        let rodzaj = zapis.wideo ? t("Rozmowa wideo", "Video call") : t("Rozmowa głosowa", "Voice call")
        guard let sekundy = zapis.sekundy else {
            return zapis.wychodzaca
                ? "\(rodzaj) · \(t("bez odpowiedzi", "no answer"))"
                : "\(rodzaj) · \(t("nieodebrana", "missed"))"
        }
        return "\(rodzaj) · \(sekundy / 60):\(String(format: "%02d", sekundy % 60))"
    }
}

/// Wyśrodkowany separator czasu („Dziś 08:42").
private struct Rozdzielacz: View {
    let czas: Int64

    var body: some View {
        Text(etykietaRozdzielacza(czas, teraz: terazMs(), jezyk: Preferencje.wspolne.jezyk))
            .font(.system(size: 12, weight: .medium))
            .foregroundStyle(Kolory.tekstDrugi)
            .frame(maxWidth: .infinity)
            .padding(.top, Miary.odstep4)
            .padding(.bottom, Miary.odstep1)
            .accessibilityAddTraits(.isHeader)
    }
}

/// Kształt dymka: jeden promień, a ogonek to ściśnięty dolny róg po stronie autora.
///
/// Ogonek jest TYLKO na ostatnim dymku serii — ogonek na każdym dzieli serię
/// na osobne wypowiedzi.
private struct KsztaltDymka: Shape {
    let wlasny: Bool
    let ogon: Bool

    func path(in rect: CGRect) -> Path {
        let r = Miary.promienBabel
        let maly: CGFloat = ogon ? 4 : r
        return UnevenRoundedRectangle(
            topLeadingRadius: r,
            bottomLeadingRadius: wlasny ? r : maly,
            bottomTrailingRadius: wlasny ? maly : r,
            topTrailingRadius: r,
            style: .continuous
        ).path(in: rect)
    }
}

private struct WierszWiadomosci: View {
    @Environment(ModelAplikacji.self) private var model
    let wiadomosc: Wiadomosc
    let ogon: Bool
    let pokazStan: Bool

    var body: some View {
        VStack(alignment: wiadomosc.wlasna ? .trailing : .leading, spacing: 4) {
            HStack(spacing: 0) {
                if wiadomosc.wlasna { Spacer(minLength: 56) }
                Dymek(wiadomosc: wiadomosc, ogon: ogon)
                if !wiadomosc.wlasna { Spacer(minLength: 56) }
            }
            if pokazStan {
                Text(slowoStanu)
                    .font(Pismo.podpis)
                    .foregroundStyle(Kolory.tekstDrugi)
                    .padding(.trailing, 4)
                    .transition(.opacity)
            }
        }
        .frame(maxWidth: .infinity, alignment: wiadomosc.wlasna ? .trailing : .leading)
        .animation(Ruch.stan, value: wiadomosc.stan)
    }

    /// Słowo zamiast ptaszka: „dostarczono" i „przeczytano" to różnica, którą
    /// trzeba zrozumieć, a nie rozpoznać z dwóch odcieni tego samego znaczka.
    private var slowoStanu: String {
        switch wiadomosc.stan ?? .wyslane {
        case .wyslane: t("wysłano", "sent")
        case .dostarczone: t("dostarczono", "delivered")
        case .przeczytane: t("przeczytano", "read")
        }
    }
}

private struct Dymek: View {
    @Environment(ModelAplikacji.self) private var model
    let wiadomosc: Wiadomosc
    let ogon: Bool

    var body: some View {
        Group {
            if let zalacznik = wiadomosc.zalacznik {
                HStack(spacing: Miary.odstep2) {
                    Ikona(nazwa: .plik, rozmiar: 18)
                    VStack(alignment: .leading, spacing: 1) {
                        Text(zalacznik.nazwaPliku ?? wiadomosc.tresc)
                            .font(Pismo.trescMocna)
                            .lineLimit(1)
                        Text(ByteCountFormatter.string(fromByteCount: zalacznik.rozmiar, countStyle: .file))
                            .font(Pismo.podpis)
                            .opacity(0.7)
                    }
                }
            } else {
                Text(wiadomosc.tresc)
                    .font(Pismo.tresc)
                    .textSelection(.enabled)
            }
        }
        .foregroundStyle(wiadomosc.wlasna ? Kolory.babelWlasnyTekst : Kolory.tekst)
        .padding(.horizontal, 14)
        .padding(.vertical, 9)
        .background(wiadomosc.wlasna ? Kolory.babelWlasny : Kolory.babel, in: KsztaltDymka(wlasny: wiadomosc.wlasna, ogon: ogon))
        .contextMenu {
            Button { UIPasteboard.general.string = wiadomosc.tresc } label: {
                Label { Text(t("Kopiuj", "Copy")) } icon: { obrazIkony(.kopiuj) }
            }
        }
        .accessibilityLabel(opisDostepnosci)
    }

    private var opisDostepnosci: String {
        let kto = wiadomosc.wlasna ? t("Ty", "You") : model.nazwy.nick(wiadomosc.autor)
        return "\(kto): \(wiadomosc.tresc)"
    }
}

/// Wiadomość jeszcze bez potwierdzenia z rdzenia — pokazana od razu, przygaszona.
private struct DymekWLocie: View {
    let wpis: WLocie
    let ponow: () -> Void

    var body: some View {
        VStack(alignment: .trailing, spacing: 4) {
            HStack(spacing: 0) {
                Spacer(minLength: 56)
                Text(wpis.tresc)
                    .font(Pismo.tresc)
                    .foregroundStyle(Kolory.babelWlasnyTekst)
                    .padding(.horizontal, 14)
                    .padding(.vertical, 9)
                    .background(Kolory.babelWlasny, in: KsztaltDymka(wlasny: true, ogon: true))
                    .opacity(wpis.blad ? 1 : 0.6)
            }
            if wpis.blad {
                Button(action: ponow) {
                    HStack(spacing: 4) {
                        Ikona(nazwa: .niepowodzenie, rozmiar: 13)
                        Text(t("nie wysłano — dotknij, by ponowić", "not sent — tap to retry"))
                    }
                    .font(Pismo.podpis)
                    .foregroundStyle(Kolory.alarm)
                }
                .buttonStyle(.plain)
            } else {
                Text(t("wysyłanie…", "sending…"))
                    .font(Pismo.podpis)
                    .foregroundStyle(Kolory.tekstDrugi)
            }
        }
        .frame(maxWidth: .infinity, alignment: .trailing)
    }
}

/// Listwa pisania: pole na `wglebienie` i strzałka — jedyna plama `glowny` w wątku,
/// w kolorze dymka, który za chwilę stworzy.
private struct PolePisania: View {
    @Binding var szkic: String
    var fokus: FocusState<Bool>.Binding
    let wyslij: () -> Void

    private var pusty: Bool { szkic.trimmingCharacters(in: .whitespacesAndNewlines).isEmpty }

    var body: some View {
        HStack(alignment: .bottom, spacing: Miary.odstep2) {
            TextField(t("Wiadomość", "Message"), text: $szkic, axis: .vertical)
                .font(Pismo.tresc)
                .foregroundStyle(Kolory.tekst)
                .lineLimit(1...6)
                .focused(fokus)
                .padding(.horizontal, 14)
                .padding(.vertical, 9)
                .frame(minHeight: 38)
                .background(Kolory.wglebienie, in: RoundedRectangle(cornerRadius: 20, style: .continuous))
                .accessibilityIdentifier("pole-wiadomosci")

            Button(action: wyslij) {
                Ikona(nazwa: .wyslij, rozmiar: 18)
                    .foregroundStyle(pusty ? Kolory.tekstTrzeci : Kolory.glownyTekst)
                    .frame(width: 38, height: 38)
                    .background(pusty ? Kolory.wglebienie : Kolory.glowny, in: Circle())
            }
            .buttonStyle(.plain)
            .disabled(pusty)
            .animation(Ruch.stan, value: pusty)
            .accessibilityLabel(t("Wyślij", "Send"))
            .accessibilityIdentifier("wyslij")
        }
        .padding(.horizontal, Miary.odstep3)
        .padding(.vertical, Miary.odstep2)
        .background {
            Kolory.tlo
                .overlay(alignment: .top) { Kolory.linia.frame(height: 0.5) }
                .ignoresSafeArea(edges: .bottom)
        }
    }
}

/// Arkusz szczegółów: skład rozmowy i kod bezpieczeństwa.
struct SzczegolyRozmowy: View {
    @Environment(ModelAplikacji.self) private var model
    let groupId: Data
    @State private var skopiowano = false

    var body: some View {
        let nazwa = model.etykieta(groupId)
        let uczestnicy = model.uczestnicy(groupId)
        ScrollView {
            VStack(spacing: 0) {
                VStack(spacing: Miary.odstep2) {
                    Awatar(nazwa: nazwa, rozmiar: 64)
                    Text(nazwa)
                        .font(Pismo.tytul)
                        .kerning(-0.44)
                        .foregroundStyle(Kolory.tekst)
                        .multilineTextAlignment(.center)
                    Text(t("\(uczestnicy.count) uczestników", "\(uczestnicy.count) participants"))
                        .font(Pismo.meta)
                        .foregroundStyle(Kolory.tekstDrugi)
                        .contentTransition(.numericText(value: Double(uczestnicy.count)))
                }
                .padding(.top, Miary.odstep6)
                .padding(.horizontal, Miary.odstep4)

                NaglowekSekcji(tekst: t("Uczestnicy", "Participants"))
                Karta {
                    ForEach(Array(uczestnicy.enumerated()), id: \.element) { i, osoba in
                        if i > 0 { Separator() }
                        HStack(spacing: Miary.odstep3) {
                            Awatar(nazwa: model.nazwy.nick(osoba), rozmiar: 32)
                            VStack(alignment: .leading, spacing: 0) {
                                Text(model.nazwy.nick(osoba))
                                    .font(Pismo.tresc)
                                    .foregroundStyle(Kolory.tekst)
                                if model.nazwy.nick(osoba) != osoba {
                                    Text("@" + osoba)
                                        .font(Pismo.podpis)
                                        .foregroundStyle(Kolory.tekstDrugi)
                                }
                            }
                            Spacer()
                            if osoba == model.konto?.userId {
                                Text(t("Ty", "You"))
                                    .font(Pismo.podpis)
                                    .foregroundStyle(Kolory.tekstDrugi)
                            }
                        }
                        .padding(.horizontal, Miary.odstep4)
                        .padding(.vertical, 10)
                    }
                }

                if let kod = model.kodBezpieczenstwa(groupId) {
                    NaglowekSekcji(tekst: t("Kod bezpieczeństwa", "Safety number"))
                    Karta {
                        VStack(alignment: .leading, spacing: Miary.odstep3) {
                            Text(kod)
                                .font(Pismo.kod)
                                .foregroundStyle(Kolory.tekst)
                                .textSelection(.enabled)
                                .fixedSize(horizontal: false, vertical: true)
                            Text(t(
                                "Porównajcie ten kod na obu urządzeniach — osobiście albo innym kanałem. Ten sam kod znaczy, że nikt nie stoi pośrodku.",
                                "Compare this code on both devices — in person or over another channel. The same code means no one is in the middle."
                            ))
                            .font(Pismo.podpis)
                            .foregroundStyle(Kolory.tekstDrugi)
                            .fixedSize(horizontal: false, vertical: true)
                            Button {
                                UIPasteboard.general.string = kod
                                skopiowano = true
                            } label: {
                                Label {
                                    Text(skopiowano ? t("Skopiowano", "Copied") : t("Kopiuj kod", "Copy code"))
                                } icon: { Ikona(nazwa: .kopiuj, rozmiar: 16) }
                            }
                            .buttonStyle(StylObrys())
                        }
                        .padding(Miary.odstep4)
                    }
                }
            }
            .padding(.bottom, Miary.odstep6)
        }
    }
}

/// Cienka linia między wierszami karty, wcięta pod tekst.
struct Separator: View {
    var wciecie: CGFloat = Miary.odstep4

    var body: some View {
        Kolory.linia
            .frame(height: 0.5)
            .padding(.leading, wciecie)
    }
}

// MARK: - Podglądy

#Preview("Wątek") {
    NavigationStack {
        WidokWatku(groupId: ModelAplikacji.Przyklad.rozmowaZMarkiem)
    }
    .environment(ModelAplikacji.podglad())
}

#Preview("Wątek — jasny") {
    NavigationStack {
        WidokWatku(groupId: ModelAplikacji.Przyklad.rozmowaZMarkiem)
    }
    .environment(ModelAplikacji.podglad())
    .preferredColorScheme(.light)
}

#Preview("Wątek — grupa") {
    NavigationStack {
        WidokWatku(groupId: ModelAplikacji.Przyklad.grupa)
    }
    .environment(ModelAplikacji.podglad())
}

#Preview("Szczegóły rozmowy") {
    SzczegolyRozmowy(groupId: ModelAplikacji.Przyklad.rozmowaZMarkiem)
        .environment(ModelAplikacji.podglad())
        .background(Kolory.karta)
}
