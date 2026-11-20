import SwiftUI

/// Główny układ po zalogowaniu: dolny pasek Rozmowy · Ustawienia.
///
/// Aktywna ikona w kolorze `tekst`, nieaktywna `tekstDrugi`, bez kolorowej
/// pigułki — kolor jest w tym systemie zarezerwowany dla stanów.
struct EkranGlowny: View {
    var body: some View {
        TabView {
            // `ListaRozmow` trzyma własny stos — potrzebuje ścieżki, żeby po
            // założeniu rozmowy wejść prosto do wątku. Drugi stos dookoła
            // dawałby podwójny pasek nawigacji.
            ListaRozmow()
                .tabItem {
                    Label { Text(t("Rozmowy", "Chats")) } icon: { obrazIkony(.rozmowy) }
                }
            NavigationStack { EkranUstawien() }
                .tabItem {
                    Label { Text(t("Ustawienia", "Settings")) } icon: { obrazIkony(.suwaki) }
                }
        }
        .tint(Kolory.tekst)
    }
}

/// Ikona jako obraz-szablon — `tabItem` przyjmuje tylko `Image`, a zestaw jest
/// rysowany ścieżkami. Szablon, żeby kolor nadał pasek, a nie rysunek.
@MainActor
func obrazIkony(_ nazwa: NazwaIkony, rozmiar: CGFloat = 24) -> Image {
    let renderer = ImageRenderer(content: Ikona(nazwa: nazwa, rozmiar: rozmiar).foregroundStyle(.black))
    renderer.scale = 3
    guard let obraz = renderer.uiImage else { return Image(systemName: "circle") }
    return Image(uiImage: obraz.withRenderingMode(.alwaysTemplate))
}

struct ListaRozmow: View {
    @Environment(ModelAplikacji.self) private var model
    @State private var szukane = ""
    @State private var nowa = false
    @State private var sciezka: [Data] = []

    private var widoczne: [PozycjaListy] {
        let fraza = szukane.trimmingCharacters(in: .whitespaces).lowercased()
        guard !fraza.isEmpty else { return model.rozmowy }
        return model.rozmowy.filter {
            model.etykieta($0).lowercased().contains(fraza) || $0.rozmowca.lowercased().contains(fraza)
                || ($0.ostatnia?.tresc.lowercased().contains(fraza) ?? false)
        }
    }

    var body: some View {
        NavigationStack(path: $sciezka) {
            List {
                ForEach(widoczne) { pozycja in
                    NavigationLink(value: pozycja.groupId) {
                        WierszRozmowy(pozycja: pozycja)
                    }
                    .listRowBackground(Kolory.tlo)
                    .listRowSeparatorTint(Kolory.linia)
                }
                // Linia nad pierwszym wierszem dublowała krawędź pola szukania.
                .listSectionSeparator(.hidden, edges: .top)
            }
            .listStyle(.plain)
            .scrollContentBackground(.hidden)
            .background(Kolory.tlo)
            .overlay {
                if model.rozmowy.isEmpty {
                    Pustka(
                        ikona: .rozmowy,
                        tytul: t("Jeszcze bez rozmów", "No conversations yet"),
                        opis: t("Zacznij od nazwy użytkownika drugiej osoby.", "Start with the other person's username.")
                    )
                } else if widoczne.isEmpty {
                    Pustka(ikona: .szukaj, tytul: t("Nic nie pasuje", "No matches"), opis: szukane)
                }
            }
            .safeAreaInset(edge: .top, spacing: 0) {
                VStack(spacing: 0) {
                    NaglowekEkranu(tytul: t("Rozmowy", "Chats")) {
                        PrzyciskNaglowka(ikona: .dodaj, opis: t("Nowa rozmowa", "New conversation")) { nowa = true }
                            .accessibilityIdentifier("nowa-rozmowa")
                    }
                    PoleSzukania(podpowiedz: t("Szukaj rozmów", "Search chats"), tekst: $szukane)
                }
                .background(Kolory.tlo)
            }
            .scrollDismissesKeyboard(.immediately)
            // Pasek nawigacji tylko na liście — wątek wpięty w ten sam stos
            // dalej ma swój (wstecz, nazwa, szczegóły).
            .toolbar(.hidden, for: .navigationBar)
            .navigationDestination(for: Data.self) { groupId in
                WidokWatku(groupId: groupId)
            }
            .sheet(isPresented: $nowa) {
                NowaRozmowa { groupId in
                    nowa = false
                    sciezka = [groupId]
                }
                .presentationDetents([.medium, .large])
                .presentationDragIndicator(.visible)
                .presentationBackground(Kolory.karta)
                .presentationCornerRadius(16)
            }
        }
    }
}

/// Pusty stan: ikona, tytuł, jedno zdanie, co dalej.
struct Pustka: View {
    let ikona: NazwaIkony
    let tytul: String
    let opis: String

    var body: some View {
        VStack(spacing: Miary.odstep2) {
            Ikona(nazwa: ikona, rozmiar: 32)
                .foregroundStyle(Kolory.tekstDrugi)
            Text(tytul)
                .font(Pismo.naglowek)
                .foregroundStyle(Kolory.tekst)
            Text(opis)
                .font(Pismo.meta)
                .foregroundStyle(Kolory.tekstDrugi)
                .multilineTextAlignment(.center)
        }
        .padding(Miary.odstep6)
    }
}

private struct WierszRozmowy: View {
    @Environment(ModelAplikacji.self) private var model
    let pozycja: PozycjaListy

    var body: some View {
        let nazwa = model.etykieta(pozycja)
        HStack(spacing: Miary.odstep3) {
            Awatar(nazwa: nazwa, rozmiar: 44)
            VStack(alignment: .leading, spacing: 2) {
                HStack(alignment: .firstTextBaseline) {
                    Text(nazwa)
                        .font(pozycja.nieprzeczytane > 0 ? Pismo.trescMocna : Pismo.tresc)
                        .foregroundStyle(Kolory.tekst)
                        .lineLimit(1)
                    Spacer(minLength: Miary.odstep2)
                    if let ostatnia = pozycja.ostatnia {
                        Text(godzinaNaLiscie(ostatnia.czas))
                            .font(Pismo.podpis)
                            .foregroundStyle(Kolory.tekstDrugi)
                    }
                }
                HStack {
                    Text(podglad)
                        .font(Pismo.meta)
                        .foregroundStyle(Kolory.tekstDrugi)
                        .lineLimit(1)
                    Spacer(minLength: Miary.odstep2)
                    if pozycja.nieprzeczytane > 0 {
                        Znacznik(liczba: pozycja.nieprzeczytane)
                    }
                }
            }
        }
        .padding(.vertical, 6)
        .accessibilityElement(children: .combine)
    }

    private var podglad: String {
        guard let ostatnia = pozycja.ostatnia else { return t("Nowa rozmowa", "New conversation") }
        let tresc = ostatnia.zalacznik != nil ? "📎 " + ostatnia.tresc : ostatnia.tresc
        return ostatnia.wlasna ? t("Ty: ", "You: ") + tresc : tresc
    }

    private func godzinaNaLiscie(_ czas: Int64) -> String {
        let data = Date(timeIntervalSince1970: Double(czas) / 1000)
        let locale = Preferencje.wspolne.jezyk.locale
        if Calendar.current.isDateInToday(data) {
            return data.formatted(.dateTime.hour(.twoDigits(amPM: .omitted)).minute(.twoDigits).locale(locale))
        }
        return data.formatted(.dateTime.day().month(.abbreviated).locale(locale))
    }
}

/// Arkusz: nowa rozmowa jeden na jeden albo grupa.
private struct NowaRozmowa: View {
    @Environment(ModelAplikacji.self) private var model
    let otworz: (Data) -> Void

    private enum Rodzaj: Hashable { case rozmowa, grupa }
    @State private var rodzaj = Rodzaj.rozmowa
    @State private var username = ""
    @State private var nazwaGrupy = ""
    @State private var osoby = ""

    var body: some View {
        VStack(alignment: .leading, spacing: Miary.odstep4) {
            Text(t("Nowa rozmowa", "New conversation"))
                .font(Pismo.tytul)
                .kerning(-0.44)
                .foregroundStyle(Kolory.tekst)
                .padding(.top, Miary.odstep5)

            Picker("", selection: $rodzaj) {
                Text(t("Jedna osoba", "One person")).tag(Rodzaj.rozmowa)
                Text(t("Grupa", "Group")).tag(Rodzaj.grupa)
            }
            .pickerStyle(.segmented)

            if rodzaj == .rozmowa {
                Pole(tytul: t("Nazwa użytkownika", "Username"), tekst: $username)
                    .accessibilityIdentifier("pole-rozmowca")
                Button {
                    Task {
                        if let groupId = await model.rozpocznijRozmowe(username) { otworz(groupId) }
                    }
                } label: {
                    if model.pracuje { ProgressView().tint(Kolory.glownyTekst) } else { Text(t("Rozpocznij", "Start")) }
                }
                .buttonStyle(StylGlowny())
                .disabled(username.trimmingCharacters(in: .whitespaces).isEmpty || model.pracuje)
            } else {
                Pole(tytul: t("Nazwa grupy (opcjonalnie)", "Group name (optional)"), tekst: $nazwaGrupy)
                Pole(tytul: t("Osoby, po przecinku", "People, comma-separated"), tekst: $osoby)
                Button {
                    let lista = osoby.split(separator: ",").map(String.init)
                    Task {
                        if let groupId = await model.utworzGrupe(osoby: lista, nazwa: nazwaGrupy) { otworz(groupId) }
                    }
                } label: {
                    if model.pracuje { ProgressView().tint(Kolory.glownyTekst) } else { Text(t("Utwórz grupę", "Create group")) }
                }
                .buttonStyle(StylGlowny())
                .disabled(osoby.trimmingCharacters(in: .whitespaces).isEmpty || model.pracuje)
            }

            Text(t(
                "Rozmowa powstaje jako grupa MLS. Serwer nadaje tylko kolejność zmian składu — nie zna ani składu, ani treści.",
                "The conversation is an MLS group. The server only orders membership changes — it learns neither members nor content."
            ))
            .font(Pismo.podpis)
            .foregroundStyle(Kolory.tekstDrugi)
            .fixedSize(horizontal: false, vertical: true)
            Spacer()
        }
        .padding(.horizontal, Miary.odstep4)
        .toast(Binding(get: { model.toast }, set: { model.toast = $0 }))
    }
}

// MARK: - Podglądy

#Preview("Rozmowy") {
    EkranGlowny()
        .environment(ModelAplikacji.podglad())
}

#Preview("Rozmowy — jasny") {
    EkranGlowny()
        .environment(ModelAplikacji.podglad())
        .preferredColorScheme(.light)
}

#Preview("Rozmowy — pusto") {
    EkranGlowny()
        .environment(ModelAplikacji.podglad(puste: true))
}

#Preview("Nowa rozmowa") {
    NowaRozmowa { _ in }
        .environment(ModelAplikacji.podglad())
        .background(Kolory.karta)
}
