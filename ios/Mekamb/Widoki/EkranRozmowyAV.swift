import SwiftUI
@preconcurrency import WebRTC

/// Ekran trwającej rozmowy A/V.
///
/// # Dlaczego zawsze ciemny
///
/// Rozmowa to obraz z kamery albo duży awatar na pustym polu — jasne tło
/// przy wideo świeci w twarz i wypłukuje obraz rozmówcy, a przy rozmowie
/// głosowej przy uchu nie ma znaczenia. Systemowa aplikacja Telefon robi
/// tak samo. Wymuszamy to środowiskiem widoku, nie `preferredColorScheme`,
/// żeby nie przełączyć przy okazji całego okna.
struct EkranRozmowyAV: View {
    @Environment(ModelAplikacji.self) private var model
    let rozmowa: RozmowaAV

    private var rozmowca: UczestnikAV? { rozmowa.uczestnicy.first }
    private var wideoRozmowcy: RTCVideoTrack? {
        rozmowa.uczestnicy.first { $0.wideo != nil && $0.faza == .polaczona }?.wideo
    }

    var body: some View {
        ZStack {
            Color.black.ignoresSafeArea()

            if let wideo = wideoRozmowcy {
                WidokWideo(sciezka: wideo, wypelnij: true)
                    .ignoresSafeArea()
                // Przyciemnienie tylko pod napisami i przyciskami, żeby biały
                // tekst był czytelny na jasnym obrazie.
                LinearGradient(colors: [.black.opacity(0.55), .clear, .clear, .black.opacity(0.65)],
                               startPoint: .top, endPoint: .bottom)
                    .ignoresSafeArea()
                    .allowsHitTesting(false)
            }

            VStack(spacing: 0) {
                naglowek
                    .padding(.top, wideoRozmowcy == nil ? 96 : Miary.odstep4)
                Spacer()
                przyciski
                    .padding(.bottom, Miary.odstep5)
            }
            .padding(.horizontal, Miary.odstep4)

            if let lokalne = rozmowa.wideoLokalne, rozmowa.kameraWlaczona {
                WidokWideo(sciezka: lokalne, wypelnij: true, lustro: true)
                    .frame(width: 112, height: 160)
                    .clipShape(RoundedRectangle(cornerRadius: Miary.promienL, style: .continuous))
                    .overlay(RoundedRectangle(cornerRadius: Miary.promienL, style: .continuous)
                        .strokeBorder(.white.opacity(0.2)))
                    .frame(maxWidth: .infinity, maxHeight: .infinity, alignment: .topTrailing)
                    .padding(.top, wideoRozmowcy == nil ? Miary.odstep2 : 120)
                    .padding(.trailing, Miary.odstep4)
                    .transition(.opacity)
            }
        }
        .environment(\.colorScheme, .dark)
        .animation(Ruch.wejscie, value: rozmowa.kameraWlaczona)
        .statusBarHidden(wideoRozmowcy != nil)
    }

    // MARK: Nagłówek: kto, jak długo, jaką drogą

    private var naglowek: some View {
        let nazwa = model.nazwy.nick(rozmowca?.nazwa ?? model.etykieta(rozmowa.groupId))
        return VStack(spacing: Miary.odstep2) {
            if wideoRozmowcy == nil {
                Awatar(nazwa: nazwa, rozmiar: 112)
                    .padding(.bottom, Miary.odstep3)
            }
            Text(nazwa)
                .font(.system(size: wideoRozmowcy == nil ? 28 : 20, weight: .semibold))
                .kerning(-0.5)
                .foregroundStyle(.white)
                .lineLimit(1)
            Group {
                if let od = rozmowa.polaczonoO, rozmowca?.faza == .polaczona {
                    TimelineView(.periodic(from: od, by: 1)) { kontekst in
                        Text(czas(od: od, teraz: kontekst.date))
                            .monospacedDigit()
                    }
                } else {
                    Text(opisStanu)
                }
            }
            .font(Pismo.tresc)
            .foregroundStyle(.white.opacity(0.75))

            // Ekran mówi wprost, kto zna adres IP — to jest cena rozmowy bez
            // serwera w mediach i ma ją być widać, a nie trzeba jej szukać.
            if let rozmowca, rozmowca.faza == .polaczona {
                HStack(spacing: 6) {
                    Ikona(nazwa: rozmowca.bezposrednio ? .bezposrednio : .przezSerwer, rozmiar: 13)
                    Text(rozmowca.bezposrednio
                         ? t("bezpośrednio · rozmówca widzi Twój adres IP", "direct · the other person sees your IP address")
                         : t("przez przekaźnik · serwer widzi Twój adres IP", "via relay · the server sees your IP address"))
                }
                .font(Pismo.podpis)
                .foregroundStyle(.white.opacity(0.6))
                .padding(.top, 2)
            }
        }
        .frame(maxWidth: .infinity)
        .accessibilityElement(children: .combine)
    }

    private var opisStanu: String {
        switch rozmowca?.faza {
        case .odrzucona:
            t("Połączenie przerwane — niezgodny odcisk klucza", "Call stopped — key fingerprint mismatch")
        case .zakonczona:
            t("Rozłączono", "Disconnected")
        default:
            rozmowa.wychodzaca ? t("Dzwonię…", "Calling…") : t("Łączenie…", "Connecting…")
        }
    }

    private func czas(od: Date, teraz: Date) -> String {
        let s = max(0, Int(teraz.timeIntervalSince(od)))
        return s >= 3600
            ? String(format: "%d:%02d:%02d", s / 3600, s / 60 % 60, s % 60)
            : String(format: "%d:%02d", s / 60, s % 60)
    }

    // MARK: Przyciski

    private var przyciski: some View {
        HStack(spacing: Miary.odstep4) {
            PrzyciskRozmowy(
                ikona: rozmowa.mikrofonWlaczony ? .mikrofon : .mikrofonWyciszony,
                opis: rozmowa.mikrofonWlaczony ? t("Wycisz", "Mute") : t("Włącz mikrofon", "Unmute"),
                zaznaczony: !rozmowa.mikrofonWlaczony
            ) { rozmowa.przelaczMikrofon() }

            PrzyciskRozmowy(
                ikona: rozmowa.kameraWlaczona ? .kamera : .kameraWylaczona,
                opis: rozmowa.kameraWlaczona ? t("Wyłącz kamerę", "Turn camera off") : t("Włącz kamerę", "Turn camera on"),
                zaznaczony: rozmowa.kameraWlaczona
            ) { rozmowa.przelaczKamere() }

            if rozmowa.kameraWlaczona {
                PrzyciskRozmowy(ikona: .odswiez, opis: t("Obróć kamerę", "Flip camera"), zaznaczony: false) {
                    rozmowa.obrocKamere()
                }
                .transition(.scale.combined(with: .opacity))
            } else {
                PrzyciskRozmowy(
                    ikona: .glosnik,
                    opis: t("Głośnik", "Speaker"),
                    zaznaczony: rozmowa.glosnikWlaczony
                ) { rozmowa.przelaczGlosnik() }
                .transition(.scale.combined(with: .opacity))
            }

            Button { model.rozlacz() } label: {
                // 34, nie 26: ścieżka słuchawki zajmuje wąski pas płótna 24×24,
                // więc w zwykłym rozmiarze ginęła na środku dużego koła.
                Ikona(nazwa: .rozlacz, rozmiar: 34)
                    .foregroundStyle(.white)
                    .frame(width: 64, height: 64)
                    .background(Color(jasny: 0xDC2626, ciemny: 0xDC2626), in: Circle())
            }
            .buttonStyle(.plain)
            .accessibilityLabel(t("Rozłącz", "Hang up"))
        }
        .animation(Ruch.stan, value: rozmowa.kameraWlaczona)
    }
}

/// Okrągły przycisk sterowania rozmową. Zaznaczony = biała plama: ten sam
/// język co systemowy ekran połączenia, czytelny w półmroku i na wideo.
private struct PrzyciskRozmowy: View {
    let ikona: NazwaIkony
    let opis: String
    let zaznaczony: Bool
    let akcja: () -> Void

    var body: some View {
        Button(action: akcja) {
            Ikona(nazwa: ikona, rozmiar: 24)
                .foregroundStyle(zaznaczony ? Color.black : Color.white)
                .frame(width: 60, height: 60)
                .background(zaznaczony ? Color.white : Color.white.opacity(0.16), in: Circle())
                .contentShape(Circle())
        }
        .buttonStyle(.plain)
        .accessibilityLabel(opis)
        .accessibilityAddTraits(zaznaczony ? .isSelected : [])
    }
}

// MARK: - Rozmowa przychodząca

struct EkranPrzychodzacejRozmowy: View {
    @Environment(ModelAplikacji.self) private var model
    let dzwoni: PrzychodzacaRozmowa

    var body: some View {
        let nazwa = model.nazwy.nick(dzwoni.od)
        ZStack {
            Color.black.ignoresSafeArea()
            TloKropki()
                .ignoresSafeArea()
                .opacity(0.6)
                .mask(LinearGradient(colors: [.black, .clear], startPoint: .top, endPoint: .bottom))

            VStack(spacing: Miary.odstep2) {
                Awatar(nazwa: nazwa, rozmiar: 112)
                    .padding(.top, 96)
                    .padding(.bottom, Miary.odstep3)
                Text(nazwa)
                    .font(.system(size: 28, weight: .semibold))
                    .kerning(-0.5)
                    .foregroundStyle(.white)
                Text(dzwoni.zWideo
                     ? t("Rozmowa wideo przychodząca", "Incoming video call")
                     : t("Rozmowa głosowa przychodząca", "Incoming voice call"))
                    .font(Pismo.tresc)
                    .foregroundStyle(.white.opacity(0.75))
                HStack(spacing: 6) {
                    Ikona(nazwa: .blokada, rozmiar: 13)
                    Text(t("szyfrowane end-to-end", "end-to-end encrypted"))
                }
                .font(Pismo.podpis)
                .foregroundStyle(.white.opacity(0.55))

                Spacer()

                HStack(alignment: .top) {
                    PrzyciskDecyzji(ikona: .rozlacz, podpis: t("Odrzuć", "Decline"),
                                    kolor: Color(jasny: 0xDC2626, ciemny: 0xDC2626)) { model.odrzuc() }
                    Spacer()
                    if dzwoni.zWideo {
                        PrzyciskDecyzji(ikona: .sluchawka, podpis: t("Tylko głos", "Audio only"),
                                        kolor: .white.opacity(0.16)) { model.odbierz(wideo: false) }
                        Spacer()
                    }
                    PrzyciskDecyzji(ikona: dzwoni.zWideo ? .kamera : .sluchawka, podpis: t("Odbierz", "Accept"),
                                    kolor: Color(jasny: 0x16A34A, ciemny: 0x16A34A)) { model.odbierz(wideo: dzwoni.zWideo) }
                }
                .padding(.horizontal, Miary.odstep5)
                .padding(.bottom, Miary.odstep6)
            }
            .padding(.horizontal, Miary.odstep4)
        }
        .environment(\.colorScheme, .dark)
    }
}

/// Duży okrągły przycisk z podpisem — odbierz/odrzuć.
///
/// Zielone i czerwone wypełnienie to jedyne miejsce w aplikacji, gdzie kolor
/// jest plamą pod akcją. Tu konwencja jest silniejsza niż system: „zielone
/// odbiera, czerwone odrzuca" każdy rozpoznaje bez czytania, w pośpiechu.
private struct PrzyciskDecyzji: View {
    let ikona: NazwaIkony
    let podpis: String
    let kolor: Color
    let akcja: () -> Void

    var body: some View {
        VStack(spacing: Miary.odstep2) {
            Button(action: akcja) {
                Ikona(nazwa: ikona, rozmiar: 28)
                    .foregroundStyle(.white)
                    .frame(width: 72, height: 72)
                    .background(kolor, in: Circle())
            }
            .buttonStyle(.plain)
            Text(podpis)
                .font(Pismo.meta)
                .foregroundStyle(.white.opacity(0.85))
        }
        .accessibilityElement(children: .combine)
        .accessibilityAddTraits(.isButton)
    }
}

// MARK: - Obraz wideo

/// Ścieżka wideo WebRTC narysowana Metalem.
///
/// Renderer przepinamy przy zmianie ścieżki i zdejmujemy przy znikaniu
/// widoku — ścieżka trzymająca martwy renderer rysowałaby w zwolniony widok.
struct WidokWideo: UIViewRepresentable {
    let sciezka: RTCVideoTrack
    var wypelnij = false
    var lustro = false

    func makeCoordinator() -> Koordynator { Koordynator() }

    func makeUIView(context: Context) -> RTCMTLVideoView {
        let widok = RTCMTLVideoView()
        widok.videoContentMode = wypelnij ? .scaleAspectFill : .scaleAspectFit
        widok.clipsToBounds = true
        // Własny podgląd jak w lustrze — inaczej ruch ręki w prawo idzie na
        // ekranie w lewo i każdy sięga nie w tę stronę.
        if lustro { widok.transform = CGAffineTransform(scaleX: -1, y: 1) }
        sciezka.add(widok)
        context.coordinator.sciezka = sciezka
        return widok
    }

    func updateUIView(_ widok: RTCMTLVideoView, context: Context) {
        guard context.coordinator.sciezka !== sciezka else { return }
        context.coordinator.sciezka?.remove(widok)
        sciezka.add(widok)
        context.coordinator.sciezka = sciezka
    }

    static func dismantleUIView(_ widok: RTCMTLVideoView, coordinator: Koordynator) {
        coordinator.sciezka?.remove(widok)
        coordinator.sciezka = nil
    }

    final class Koordynator {
        var sciezka: RTCVideoTrack?
    }
}
