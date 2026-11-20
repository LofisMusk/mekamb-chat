import AVFoundation
import Foundation
import Observation
@preconcurrency import WebRTC

/// Rozmowa audio/wideo — mesh, bez serwera pośredniczącego w mediach.
///
/// Odpowiednik `RozmowaAV.kt` na Androidzie; protokół musi się zgadzać co do
/// bajtu, bo iPhone rozmawia z Androidem i webem.
///
/// # Dlaczego mesh, a nie SFU
///
/// SFU odszyfrowuje media, żeby je przemiksować — czyli widzi i słyszy
/// rozmowę. Mesh znaczy, że każda para negocjuje własne połączenie DTLS-SRTP
/// i nikt trzeci nie ma czego podsłuchać. Cena to ruch rosnący z kwadratem
/// liczby uczestników, stąd limit czterech osób — ten sam co na Androidzie.
///
/// # Czemu ufamy w sygnalizacji, a czemu nie
///
/// SDP idzie tą samą drogą co reszta ruchu, więc pośrednik może je podmienić
/// i podstawić własne połączenie DTLS. Rozmowa wyglądałaby na zabezpieczoną,
/// bo szyfrowanie *by działało* — tyle że z nim. Dlatego odcisk DTLS podróżuje
/// **wewnątrz MLS**, osobno od SDP, a przed zestawieniem połączenia rdzeń
/// porównuje jedno z drugim (`verifySdpFingerprint`). Niezgodność zrywa
/// połączenie **bez pytania użytkownika**: na pytanie „połączyć mimo
/// niezgodności?" nikt nie umie odpowiedzieć, a zgoda kliknięta w pośpiechu
/// unieważnia całą tę ochronę.
///
/// # Czego to nie zmienia
///
/// Rozmowa bezpośrednia zdradza rozmówcy adres IP, a przez TURN — serwerowi.
/// Ekran rozmowy mówi to wprost.
@MainActor
@Observable
final class RozmowaAV {
    static let limitUczestnikow = 4
    private static let stunZapasowy = "stun:stun.cloudflare.com:3478"

    let groupId: Data
    let callId: Data
    let wychodzaca: Bool
    /// Czy rozmowa zaczęła się jako wideo — do wpisu w historii i układu ekranu.
    let zWideo: Bool

    private(set) var uczestnicy: [UczestnikAV] = []
    private(set) var mikrofonWlaczony = true
    private(set) var kameraWlaczona = false
    private(set) var glosnikWlaczony: Bool
    private(set) var wideoLokalne: RTCVideoTrack?
    /// Chwila pierwszego zestawienia — od niej liczy się czas rozmowy.
    /// Sekundy dzwonienia nie są rozmową.
    private(set) var polaczonoO: Date?

    /// Woła model, gdy ostatni rozmówca się rozłączył albo odrzucił.
    @ObservationIgnored var naKoniec: (() -> Void)?

    @ObservationIgnored private let messenger: Messenger
    @ObservationIgnored private let fabryka: RTCPeerConnectionFactory
    @ObservationIgnored private var audio: RTCAudioTrack?
    @ObservationIgnored private var zrodloWideo: RTCVideoSource?
    @ObservationIgnored private var kamera: RTCCameraVideoCapturer?
    @ObservationIgnored private var przednia = true
    @ObservationIgnored private var polaczenia: [String: Polaczenie] = [:]
    @ObservationIgnored private var serweryIce: [RTCIceServer] = [RTCIceServer(urlStrings: [RozmowaAV.stunZapasowy])]

    private init(messenger: Messenger, groupId: Data, callId: Data, wychodzaca: Bool, zWideo: Bool) {
        self.messenger = messenger
        self.groupId = groupId
        self.callId = callId
        self.wychodzaca = wychodzaca
        self.zWideo = zWideo
        // Wideo na głośniku, głos przy uchu — jak systemowa aplikacja Telefon.
        self.glosnikWlaczony = zWideo
        RTCInitializeSSL()
        fabryka = RTCPeerConnectionFactory(
            encoderFactory: RTCDefaultVideoEncoderFactory(),
            decoderFactory: RTCDefaultVideoDecoderFactory()
        )
    }

    // MARK: - Wejście

    /// Dzwoni do osób z rozmowy. Oferty wychodzą dopiero po pobraniu serwerów
    /// ICE: połączenie zestawione bez TURN-a nie doda go sobie później, a ktoś
    /// za restrykcyjnym NAT-em nie usłyszałby nikogo bez śladu przyczyny.
    static func zadzwon(messenger: Messenger, groupId: Data, rozmowcy: [String], zWideo: Bool) -> RozmowaAV {
        var callId = Data(count: 16)
        _ = callId.withUnsafeMutableBytes { SecRandomCopyBytes(kSecRandomDefault, 16, $0.baseAddress!) }
        let rozmowa = RozmowaAV(messenger: messenger, groupId: groupId, callId: callId, wychodzaca: true, zWideo: zWideo)
        rozmowa.przygotujMedia(zWideo: zWideo)
        Task {
            await rozmowa.pobierzSerweryIce()
            for osoba in rozmowcy.prefix(limitUczestnikow - 1) {
                rozmowa.polaczenie(osoba)?.wynegocjujPonownie()
            }
        }
        return rozmowa
    }

    /// Odbiera rozmowę: oferta, a po niej sygnały, które przyszły, zanim
    /// użytkownik zdążył nacisnąć „Odbierz" (kandydaci ICE dzwoniącego).
    static func odbierz(messenger: Messenger, groupId: Data, callId: Data, zWideo: Bool,
                       od: String, oferta: String, odcisk: String, zalegle: [SygnalAV]) -> RozmowaAV {
        let rozmowa = RozmowaAV(messenger: messenger, groupId: groupId, callId: callId, wychodzaca: false, zWideo: zWideo)
        rozmowa.przygotujMedia(zWideo: zWideo)
        Task {
            await rozmowa.pobierzSerweryIce()
            rozmowa.przyjmij(od: od, rodzaj: .offer, tresc: oferta, odcisk: odcisk)
            for sygnal in zalegle {
                rozmowa.przyjmij(od: sygnal.od, rodzaj: sygnal.rodzaj, tresc: sygnal.tresc, odcisk: sygnal.odcisk)
            }
        }
        return rozmowa
    }

    // MARK: - Media

    private func przygotujMedia(zWideo: Bool) {
        ustawSesjeAudio()
        let zrodlo = fabryka.audioSource(with: RTCMediaConstraints(mandatoryConstraints: nil, optionalConstraints: nil))
        audio = fabryka.audioTrack(with: zrodlo, trackId: "audio")
        if zWideo { _ = uruchomKamere() }
    }

    private func ustawSesjeAudio() {
        let sesja = RTCAudioSession.sharedInstance()
        sesja.lockForConfiguration()
        defer { sesja.unlockForConfiguration() }
        try? sesja.setCategory(.playAndRecord, mode: zWideo ? .videoChat : .voiceChat,
                               options: [.allowBluetoothHFP, .allowBluetoothA2DP])
        try? sesja.overrideOutputAudioPort(glosnikWlaczony ? .speaker : .none)
        try? sesja.setActive(true)
    }

    /// Uruchamia przednią kamerę. `false`, gdy jej nie ma (symulator) albo brak zgody.
    private func uruchomKamere() -> Bool {
        if wideoLokalne != nil { return true }
        guard let urzadzenie = wybierzKamere() else { return false }

        let zrodlo = fabryka.videoSource()
        let capturer = RTCCameraVideoCapturer(delegate: zrodlo)
        guard let format = najlepszyFormat(urzadzenie) else { return false }
        let fps = min(30, Int(format.videoSupportedFrameRateRanges.map(\.maxFrameRate).max() ?? 30))
        capturer.startCapture(with: urzadzenie, format: format, fps: fps)

        zrodloWideo = zrodlo
        kamera = capturer
        wideoLokalne = fabryka.videoTrack(with: zrodlo, trackId: "wideo")
        kameraWlaczona = true
        return true
    }

    private func wybierzKamere() -> AVCaptureDevice? {
        let urzadzenia = RTCCameraVideoCapturer.captureDevices()
        return urzadzenia.first { $0.position == (przednia ? .front : .back) } ?? urzadzenia.first
    }

    /// Format najbliższy 1280×720 — więcej to bateria i łącze bez widocznej różnicy na telefonie.
    private func najlepszyFormat(_ urzadzenie: AVCaptureDevice) -> AVCaptureDevice.Format? {
        RTCCameraVideoCapturer.supportedFormats(for: urzadzenie).min { a, b in
            let da = CMVideoFormatDescriptionGetDimensions(a.formatDescription)
            let db = CMVideoFormatDescriptionGetDimensions(b.formatDescription)
            return abs(Int(da.width) - 1280) + abs(Int(da.height) - 720) < abs(Int(db.width) - 1280) + abs(Int(db.height) - 720)
        }
    }

    private func pobierzSerweryIce() async {
        let serwery = await messenger.serweryIce()
        guard !serwery.isEmpty else { return }
        serweryIce = serwery.map { RTCIceServer(urlStrings: $0.urls, username: $0.username, credential: $0.credential) }
    }

    // MARK: - Sygnalizacja

    func przyjmij(od: String, rodzaj: CallSignalKind, tresc: String, odcisk: String) {
        switch rodzaj {
        case .offer:
            guard odciskSieZgadza(od: od, sdp: tresc, odcisk: odcisk), let polaczenie = polaczenie(od) else { return }
            polaczenie.pc.setRemoteDescription(RTCSessionDescription(type: .offer, sdp: tresc)) { [weak self] blad in
                guard blad == nil else { return }
                Task { @MainActor in
                    polaczenie.oproznijKolejkeIce()
                    polaczenie.pc.answer(for: Self.ograniczenia()) { opis, _ in
                        guard let opis else { return }
                        let sdp = opis.sdp
                        polaczenie.pc.setLocalDescription(opis) { _ in }
                        Task { @MainActor in self?.wyslij(od, .answer, sdp) }
                    }
                }
            }

        case .answer:
            guard odciskSieZgadza(od: od, sdp: tresc, odcisk: odcisk), let polaczenie = polaczenia[od] else { return }
            polaczenie.pc.setRemoteDescription(RTCSessionDescription(type: .answer, sdp: tresc)) { blad in
                guard blad == nil else { return }
                Task { @MainActor in polaczenie.oproznijKolejkeIce() }
            }

        case .iceCandidate:
            polaczenia[od]?.dodajKandydata(tresc)

        case .hangup:
            polaczenia.removeValue(forKey: od)?.zamknij()
            zglos()
            if polaczenia.isEmpty { naKoniec?() }

        case .unspecified:
            break
        }
    }

    private func odciskSieZgadza(od: String, sdp: String, odcisk: String) -> Bool {
        if (try? verifySdpFingerprint(sdp: sdp, expected: odcisk)) != nil { return true }
        if let polaczenie = polaczenia[od] {
            polaczenie.faza = .odrzucona
            polaczenie.zamknij()
        }
        zglos()
        return false
    }

    /// Połączenie z rozmówcą — istniejące albo nowe, w granicy limitu siatki.
    fileprivate func polaczenie(_ rozmowca: String) -> Polaczenie? {
        if let istniejace = polaczenia[rozmowca] { return istniejace }
        guard polaczenia.count < Self.limitUczestnikow - 1 else { return nil }

        let konfiguracja = RTCConfiguration()
        konfiguracja.iceServers = serweryIce
        konfiguracja.sdpSemantics = .unifiedPlan
        konfiguracja.continualGatheringPolicy = .gatherContinually

        let polaczenie = Polaczenie(rozmowca: rozmowca, wlasciciel: self)
        guard let pc = fabryka.peerConnection(with: konfiguracja, constraints: Self.ograniczenia(), delegate: polaczenie) else {
            return nil
        }
        polaczenie.pc = pc
        if let audio { pc.add(audio, streamIds: ["mekamb"]) }
        if let wideoLokalne { pc.add(wideoLokalne, streamIds: ["mekamb"]) }

        polaczenia[rozmowca] = polaczenie
        zglos()
        return polaczenie
    }

    fileprivate func wyslij(_ doKogo: String, _ rodzaj: CallSignalKind, _ tresc: String) {
        let odcisk = (rodzaj == .offer || rodzaj == .answer) ? ((try? ownSdpFingerprint(sdp: tresc)) ?? "") : ""
        let groupId = groupId, callId = callId, messenger = messenger
        Task {
            try? await messenger.sendCallSignal(groupId, rodzaj: rodzaj, callId: callId, tresc: tresc,
                                                odcisk: odcisk, doKogo: doKogo)
        }
    }

    fileprivate static func ograniczenia() -> RTCMediaConstraints {
        RTCMediaConstraints(mandatoryConstraints: nil, optionalConstraints: nil)
    }

    // MARK: - Sterowanie

    func przelaczMikrofon() {
        mikrofonWlaczony.toggle()
        audio?.isEnabled = mikrofonWlaczony
    }

    func przelaczKamere() {
        if wideoLokalne == nil {
            // Pierwsze włączenie w rozmowie głosowej: nowa ścieżka i renegocjacja
            // z każdym. Bez kamery albo zgody przycisk zostaje zgaszony, a nie
            // zapala się na kłamstwo.
            guard uruchomKamere(), let nowa = wideoLokalne else { return }
            for polaczenie in polaczenia.values {
                polaczenie.pc.add(nowa, streamIds: ["mekamb"])
                polaczenie.wynegocjujPonownie()
            }
            return
        }
        kameraWlaczona.toggle()
        wideoLokalne?.isEnabled = kameraWlaczona
    }

    func obrocKamere() {
        guard let kamera, wideoLokalne != nil else { return }
        przednia.toggle()
        guard let urzadzenie = wybierzKamere(), let format = najlepszyFormat(urzadzenie) else { return }
        // `startCapture` na działającym przechwytywaniu przepina urządzenie
        // w miejscu — WebRTC szereguje to na własnej kolejce sesji aparatu.
        kamera.startCapture(with: urzadzenie, format: format, fps: 30)
    }

    func przelaczGlosnik() {
        glosnikWlaczony.toggle()
        let sesja = RTCAudioSession.sharedInstance()
        sesja.lockForConfiguration()
        try? sesja.overrideOutputAudioPort(glosnikWlaczony ? .speaker : .none)
        sesja.unlockForConfiguration()
    }

    /// Kończy rozmowę: rozłączenie do każdego i zwolnienie mediów.
    func zakoncz() {
        for osoba in polaczenia.keys { wyslij(osoba, .hangup, "") }
        for polaczenie in polaczenia.values { polaczenie.zamknij() }
        polaczenia.removeAll()
        kamera?.stopCapture()
        kamera = nil
        wideoLokalne = nil
        audio = nil
        let sesja = RTCAudioSession.sharedInstance()
        sesja.lockForConfiguration()
        try? sesja.setActive(false)
        sesja.unlockForConfiguration()
        zglos()
    }

    fileprivate func zglos() {
        uczestnicy = polaczenia.values
            .map { UczestnikAV(nazwa: $0.rozmowca, faza: $0.faza, bezposrednio: $0.bezposrednio, wideo: $0.wideoZdalne) }
            .sorted { $0.nazwa < $1.nazwa }
        if polaczonoO == nil, uczestnicy.contains(where: { $0.faza == .polaczona }) {
            polaczonoO = Date()
        }
    }
}

// MARK: - Połączenie z jednym rozmówcą

@MainActor
private final class Polaczenie: NSObject, RTCPeerConnectionDelegate {
    let rozmowca: String
    weak var wlasciciel: RozmowaAV?
    var pc: RTCPeerConnection!
    var faza: FazaAV = .laczenie
    var bezposrednio = false
    var wideoZdalne: RTCVideoTrack?
    /// Kandydaci, którzy przyszli przed opisem zdalnym — WebRTC odrzuciłby ich.
    private var kolejkaIce: [RTCIceCandidate] = []

    init(rozmowca: String, wlasciciel: RozmowaAV) {
        self.rozmowca = rozmowca
        self.wlasciciel = wlasciciel
    }

    /// Nowa oferta — tylko w stanie stabilnym, inaczej dwie strony
    /// przepychałyby się ofertami naraz.
    func wynegocjujPonownie() {
        guard pc.signalingState == .stable else { return }
        pc.offer(for: RozmowaAV.ograniczenia()) { [weak self] opis, _ in
            guard let opis else { return }
            let sdp = opis.sdp
            Task { @MainActor in
                guard let self else { return }
                self.pc.setLocalDescription(opis) { _ in }
                self.wlasciciel?.wyslij(self.rozmowca, .offer, sdp)
            }
        }
    }

    func dodajKandydata(_ json: String) {
        guard let kandydat = kandydatZJson(json) else { return }
        if pc.remoteDescription != nil {
            pc.add(kandydat) { _ in }
        } else {
            kolejkaIce.append(kandydat)
        }
    }

    func oproznijKolejkeIce() {
        for kandydat in kolejkaIce { pc.add(kandydat) { _ in } }
        kolejkaIce.removeAll()
    }

    func zamknij() {
        pc?.close()
        if faza != .odrzucona { faza = .zakonczona }
    }

    /// Czy para kandydatów idzie wprost, czy przez przekaźnik TURN — ekran o tym mówi.
    private func ustalDroge() {
        pc.statistics { [weak self] raport in
            let statystyki = raport.statistics
            let para = statystyki.values.first { $0.type == "candidate-pair" && ($0.values["state"] as? String) == "succeeded" }
            guard let idLokalnego = para?.values["localCandidateId"] as? String else { return }
            let typ = statystyki[idLokalnego]?.values["candidateType"] as? String
            let wprost = typ != nil && typ != "relay"
            Task { @MainActor in
                self?.bezposrednio = wprost
                self?.wlasciciel?.zglos()
            }
        }
    }

    // MARK: RTCPeerConnectionDelegate — woła wątek sygnalizacji WebRTC

    nonisolated func peerConnection(_ peerConnection: RTCPeerConnection, didGenerate candidate: RTCIceCandidate) {
        let json = kandydatDoJson(candidate)
        Task { @MainActor in self.wlasciciel?.wyslij(self.rozmowca, .iceCandidate, json) }
    }

    nonisolated func peerConnection(_ peerConnection: RTCPeerConnection, didChange newState: RTCPeerConnectionState) {
        let nowa: FazaAV
        switch newState {
        case .connected: nowa = .polaczona
        case .failed, .closed: nowa = .zakonczona
        default: nowa = .laczenie
        }
        Task { @MainActor in
            if self.faza != .odrzucona { self.faza = nowa }
            if nowa == .polaczona { self.ustalDroge() }
            self.wlasciciel?.zglos()
        }
    }

    nonisolated func peerConnection(_ peerConnection: RTCPeerConnection, didAdd rtpReceiver: RTCRtpReceiver,
                                    streams mediaStreams: [RTCMediaStream]) {
        guard let sciezka = rtpReceiver.track as? RTCVideoTrack else { return }
        nonisolated(unsafe) let wideo = sciezka
        Task { @MainActor in
            self.wideoZdalne = wideo
            self.wlasciciel?.zglos()
        }
    }

    nonisolated func peerConnection(_ peerConnection: RTCPeerConnection, didChange stateChanged: RTCSignalingState) {}
    nonisolated func peerConnection(_ peerConnection: RTCPeerConnection, didAdd stream: RTCMediaStream) {}
    nonisolated func peerConnection(_ peerConnection: RTCPeerConnection, didRemove stream: RTCMediaStream) {}
    nonisolated func peerConnectionShouldNegotiate(_ peerConnection: RTCPeerConnection) {}
    nonisolated func peerConnection(_ peerConnection: RTCPeerConnection, didChange newState: RTCIceConnectionState) {}
    nonisolated func peerConnection(_ peerConnection: RTCPeerConnection, didChange newState: RTCIceGatheringState) {}
    nonisolated func peerConnection(_ peerConnection: RTCPeerConnection, didRemove candidates: [RTCIceCandidate]) {}
    nonisolated func peerConnection(_ peerConnection: RTCPeerConnection, didOpen dataChannel: RTCDataChannel) {}
}

// MARK: - Typy

enum FazaAV: Sendable { case laczenie, polaczona, zakonczona, odrzucona }

struct UczestnikAV: Identifiable {
    let nazwa: String
    let faza: FazaAV
    let bezposrednio: Bool
    let wideo: RTCVideoTrack?
    var id: String { nazwa }
}

/// Sygnał, który przyszedł, zanim rozmowa powstała — czeka na „Odbierz".
struct SygnalAV: Sendable {
    let od: String
    let rodzaj: CallSignalKind
    let tresc: String
    let odcisk: String
}

/// Rozmowa, która dzwoni i czeka na decyzję.
struct PrzychodzacaRozmowa: Equatable, Sendable {
    let od: String
    let groupId: Data
    let callId: Data
    let oferta: String
    let odcisk: String
    /// Oferta niesie sekcję wideo — wtedy ekran proponuje „Odbierz z wideo".
    var zWideo: Bool { oferta.contains("m=video") }
}

// MARK: - Kandydat ICE jako JSON
//
// Kształt `{candidate, sdpMid, sdpMLineIndex}` — ten sam co `KandydatJson`
// na Androidzie i `RTCIceCandidateInit` w przeglądarce.

nonisolated func kandydatDoJson(_ k: RTCIceCandidate) -> String {
    var obiekt: [String: Any] = ["candidate": k.sdp, "sdpMLineIndex": Int(k.sdpMLineIndex)]
    if let mid = k.sdpMid { obiekt["sdpMid"] = mid }
    guard let dane = try? JSONSerialization.data(withJSONObject: obiekt) else { return "{}" }
    return String(decoding: dane, as: UTF8.self)
}

nonisolated func kandydatZJson(_ json: String) -> RTCIceCandidate? {
    guard let obiekt = (try? JSONSerialization.jsonObject(with: Data(json.utf8))) as? [String: Any],
          let sdp = obiekt["candidate"] as? String else { return nil }
    return RTCIceCandidate(sdp: sdp, sdpMLineIndex: Int32(obiekt["sdpMLineIndex"] as? Int ?? 0),
                           sdpMid: obiekt["sdpMid"] as? String)
}
