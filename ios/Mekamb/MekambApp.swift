import SwiftUI

/// Punkt wejścia aplikacji iOS.
///
/// # Dlaczego model powstaje tutaj, a nie w widoku
///
/// `ModelAplikacji` jest jedynym właścicielem klienta MLS (powód w jego
/// komentarzu). `@State` w `App` żyje tyle co proces — widok mógłby zostać
/// odtworzony przy zmianie motywu albo języka i otworzyć drugi klient na tym
/// samym skarbcu.
@main
struct MekambApp: App {
    @State private var model = MekambApp.nowyModel()
    @Bindable private var preferencje = Preferencje.wspolne
    @Environment(\.scenePhase) private var faza

    var body: some Scene {
        WindowGroup {
            Korzen()
                .environment(model)
                // Zapisany jest WYBÓR, nie jego wynik: `auto` rozstrzyga system
                // przy każdym renderze, więc wieczorne przejście telefonu
                // w ciemny motyw działa bez restartu aplikacji.
                .preferredColorScheme(preferencje.motyw.schemat)
                // Zmiana języka przebudowuje drzewo — napisy `t()` są liczone
                // przy renderze, a nie obserwowane.
                .id(preferencje.jezyk)
                .task { if !MekambApp.trybPodgladu { await model.start() } }
                .onChange(of: faza) { _, nowa in
                    if nowa == .active { Task { await model.naWierzchu() } }
                }
        }
    }
}

extension MekambApp {
    /// `-MekambPodglad` w argumentach uruchomienia (tylko Debug) startuje
    /// aplikację na danych z `ModelAplikacji.podglad()` — tych samych, które
    /// widać na płótnie Xcode. Do zrzutów ekranu i strojenia wyglądu w pełnym
    /// symulatorze bez zakładania kont i lokalnego serwera.
    static var trybPodgladu: Bool {
        #if DEBUG
        ProcessInfo.processInfo.arguments.contains("-MekambPodglad")
        #else
        false
        #endif
    }

    @MainActor
    static func nowyModel() -> ModelAplikacji {
        #if DEBUG
        if trybPodgladu { return .podglad() }
        #endif
        return ModelAplikacji()
    }
}

private struct Korzen: View {
    @Environment(ModelAplikacji.self) private var model

    var body: some View {
        @Bindable var model = model
        ZStack {
            Kolory.tlo.ignoresSafeArea()
            if model.uruchamianie {
                // Cicha próba sesji trwa ułamek sekundy — pusty ekran zamiast
                // mignięcia powitaniem, które za chwilę i tak zniknie.
                Ikona(nazwa: .marka, rozmiar: 40)
                    .foregroundStyle(Kolory.tekstTrzeci)
            } else if model.zalogowany {
                EkranGlowny()
                    .transition(.opacity)
            } else {
                EkranyWejscia()
                    .transition(.opacity)
            }
        }
        .animation(Ruch.wejscie, value: model.zalogowany)
        .animation(Ruch.wejscie, value: model.uruchamianie)
        .toast($model.toast)
        // Rozmowa przykrywa wszystko, łącznie z otwartymi arkuszami — dzwoni
        // się z wątku, a odbiera z dowolnego ekranu. JEDNA zasłona na oba
        // stany: dwie osobne przy „Odbierz" jednocześnie by się zamykały
        // i otwierały, a SwiftUI nie pokazuje drugiej, póki pierwsza znika.
        .fullScreenCover(isPresented: Binding(
            get: { model.rozmowaAV != nil || model.przychodzaca != nil },
            set: { if !$0 { model.rozlacz() } }
        )) {
            Group {
                if let rozmowa = model.rozmowaAV {
                    EkranRozmowyAV(rozmowa: rozmowa)
                } else if let dzwoni = model.przychodzaca {
                    EkranPrzychodzacejRozmowy(dzwoni: dzwoni)
                }
            }
            .environment(model)
        }
    }
}

extension Motyw {
    /// `nil` znaczy „za systemem" — dokładnie to, o co prosi `auto`.
    var schemat: ColorScheme? {
        switch self {
        case .auto: nil
        case .jasny: .light
        case .ciemny: .dark
        }
    }
}

// MARK: - Podglądy

#Preview("Aplikacja — zalogowany") {
    Korzen()
        .environment(ModelAplikacji.podglad())
}

#Preview("Aplikacja — powitanie") {
    Korzen()
        .environment(ModelAplikacji.podglad(zalogowany: false))
}
