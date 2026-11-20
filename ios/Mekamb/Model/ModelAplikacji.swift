import Foundation
import Observation
import SwiftUI

/// Wiadomość, która wyszła z pola pisania, a jeszcze nie ma identyfikatora z rdzenia.
///
/// Pokazywana od razu: wcześniej przez cały czas wysyłki nie działo się nic
/// i nie było wiadomo, czy cokolwiek poszło. Nieudana zostaje z treścią — zawiodła
/// sieć, nie użytkownik — i daje się ponowić.
struct WLocie: Identifiable, Equatable {
    let id = UUID()
    let tresc: String
    let czas: Int64
    var blad = false
}

/// Powiadomienie chwilowe u góry ekranu.
struct Toast: Identifiable, Equatable {
    enum Rodzaj { case informacja, blad }
    let id = UUID()
    let tekst: String
    let rodzaj: Rodzaj
}

/// Ekrany przed zalogowaniem.
enum EkranWejscia: Equatable {
    case powitanie
    case logowanie
    case kod
    case rejestracja
    case potwierdzenie(username: String, sekret: String, uri: String)
}

/// Stan aplikacji i jej jedyny właściciel klienta.
///
/// # Dlaczego JEDEN klient
///
/// Bo `Messenger` trzyma stan MLS. Dwa klienty otwarte na tym samym skarbcu to
/// dwa ratchety przesuwane niezależnie: każdy zapis jednego cofa to, co zrobił
/// drugi, a wiadomości przestają się odszyfrowywać po obu stronach (`Rdzen.kt`
/// opisuje, jak to wyszło na Androidzie przy obrocie ekranu). Tu model żyje
/// tyle co proces i jest jedynym miejscem, które klienta tworzy.
///
/// Odpowiednik `ChatViewModel.kt` bez rozmów A/V, próśb, blokad i znikania —
/// te są poza zakresem pierwszej wersji iOS (lista w `ios/README.md`).
@MainActor
@Observable
final class ModelAplikacji {
    // MARK: Stan widoczny

    private(set) var zalogowany = false
    /// Trwa ciche wejście przez zapisaną sesję — powitanie ma nie migać.
    private(set) var uruchamianie = true
    var ekran: EkranWejscia = .powitanie
    private(set) var pracuje = false
    var toast: Toast?

    private(set) var rozmowy: [PozycjaListy] = []
    private(set) var nazwy = StanNazw()
    private(set) var stanPolaczenia: StanPolaczenia = .rozlaczone

    /// Rozmowa otwarta na ekranie i jej wiadomości.
    private(set) var otwarta: Data?
    private(set) var wiadomosci: [Wiadomosc] = []
    private(set) var wLocie: [WLocie] = []

    /// Trwająca rozmowa A/V — ekran rozmowy wisi na niej, dopóki nie zgaśnie.
    private(set) var rozmowaAV: RozmowaAV?
    /// Rozmowa, która dzwoni i czeka na „Odbierz" albo „Odrzuć".
    private(set) var przychodzaca: PrzychodzacaRozmowa?

    var konto: Konto? { skarbiec.wczytajKonto() }

    // MARK: Zależności

    @ObservationIgnored private let api: Api
    @ObservationIgnored private let skarbiec: Skarbiec
    @ObservationIgnored private let historia: Historia
    @ObservationIgnored private let magazynNazw: Nazwy
    @ObservationIgnored private var messenger: Messenger?
    @ObservationIgnored private var sesjaLogowania: Auth.SesjaLogowania?
    @ObservationIgnored private var tokenOd: Date?

    /// Sygnały, które przyszły przed odebraniem (kandydaci ICE dzwoniącego).
    ///
    /// Bez nich odebrana rozmowa miałaby ofertę, ale żadnej drogi do
    /// dzwoniącego — kandydaci przychodzą tuż po ofercie, a ekran czeka na
    /// człowieka. Limit, bo nieodebrana rozmowa przyjmowałaby ich bez końca.
    @ObservationIgnored private var oczekujaceSygnaly: [SygnalAV] = []
    @ObservationIgnored private let limitOczekujacych = 64

    /// Zbieracz potwierdzeń i jego jeden zegar — powód opóźnienia w `Potwierdzenia.swift`.
    @ObservationIgnored private var zbieracz = ZbieraczPotwierdzen()
    @ObservationIgnored private var zegarPotwierdzen: Task<Void, Never>?

    init(api: Api = Api(), skarbiec: Skarbiec = Skarbiec()) {
        self.api = api
        self.skarbiec = skarbiec
        self.historia = Historia(skarbiec: skarbiec)
        self.magazynNazw = Nazwy(skarbiec: skarbiec)
        // Konto na urządzeniu znaczy, że pytanie „załóż czy zaloguj" jest zbędne.
        if skarbiec.wczytajKonto() != nil { ekran = .logowanie }
    }

    // MARK: - Wejście

    /// Próba cichej trwałej sesji przy starcie — zamiast hasła i TOTP przy każdym uruchomieniu.
    ///
    /// Ta ścieżka ZASTĘPUJE logowanie, więc robi dokładnie to samo co ono —
    /// łącznie z publikacją key packages, które są jednorazowe.
    func start() async {
        defer { uruchamianie = false }
        guard !zalogowany, let konto = skarbiec.wczytajKonto(), let refresh = skarbiec.wczytajRefreshToken() else { return }

        do {
            guard let wynik = try await api.refreshSession(deviceId: konto.deviceId, refreshToken: refresh) else { return }
            try await uruchomKlienta(konto: konto, token: wynik.token, refreshToken: wynik.refreshToken)
        } catch {
            // Brak sieci przy starcie nie jest powodem do komunikatu nad ekranem
            // logowania — użytkownik i tak widzi, co może zrobić.
        }
    }

    func zarejestruj(username: String, haslo: String) async {
        let username = username.trimmingCharacters(in: .whitespaces).lowercased()
        await pracuj(t("Nie udało się założyć konta.", "Could not create the account.")) {
            let wynik = try await Auth.zarejestruj(api: self.api, username: username, haslo: haslo)
            self.ekran = .potwierdzenie(username: username, sekret: wynik.sekretTotp, uri: wynik.otpauthUri)
        }
    }

    /// Aktywuje świeże konto pierwszym kodem — serwer od razu wydaje token.
    func potwierdzRejestracje(username: String, kod: String) async {
        await pracuj(t("Kod nie został przyjęty.", "The code was not accepted.")) {
            let konto = self.kontoDla(username)
            let wynik = try await self.api.registerConfirm(username: username, code: kod, deviceId: konto.deviceId)
            try await self.uruchomKlienta(konto: konto, token: wynik.token, refreshToken: wynik.refreshToken)
        }
    }

    /// Pierwszy krok logowania — złe hasło odpada tutaj, przed pytaniem o kod.
    func zalogujHaslem(username: String, haslo: String) async {
        let username = username.trimmingCharacters(in: .whitespaces).lowercased()
        await pracuj(t("Logowanie nie powiodło się.", "Sign-in failed.")) {
            self.sesjaLogowania = try await Auth.zalogujHaslem(api: self.api, username: username, haslo: haslo)
            self.ekran = .kod
        }
    }

    func zalogujKodem(_ kod: String) async {
        guard let sesja = sesjaLogowania else {
            ekran = .logowanie
            return
        }
        await pracuj(t("Kod nie został przyjęty.", "The code was not accepted.")) {
            let konto = self.kontoDla(sesja.username)
            let wynik = try await self.api.loginTotp(loginId: sesja.loginId, code: kod, deviceId: konto.deviceId)
            try await self.uruchomKlienta(konto: konto, token: wynik.token, refreshToken: wynik.refreshToken)
            self.sesjaLogowania = nil
        }
    }

    /// Konto dla logującej się osoby.
    ///
    /// Identyfikator urządzenia odtwarzamy, gdy to TO SAMO konto: nowy przy
    /// każdym logowaniu zostawiałby w katalogu stos martwych urządzeń i odcinał
    /// od stanu MLS zapisanego pod starym. Inna osoba na tym telefonie dostaje
    /// czysty skarbiec — ziarno i stan MLS poprzedniej należą do jej tożsamości.
    private func kontoDla(_ username: String) -> Konto {
        if let zapisane = skarbiec.wczytajKonto() {
            if zapisane.username == username { return zapisane }
            skarbiec.wyczysc()
        }
        return Konto(username: username, deviceId: "ios-" + UUID().uuidString.prefix(8).lowercased())
    }

    /// Jedno miejsce dla wszystkich dróg wejścia z tokenem.
    ///
    /// Kolejność broni inwariantów: katalog przed key packages (klucz obcy),
    /// otwarcie rozmów z dysku PRZED odbiorem (inaczej koperta bez dopasowania
    /// przepada), portfel przed pierwszą wysyłką.
    private func uruchomKlienta(konto: Konto, token: String, refreshToken: String?) async throws {
        skarbiec.zapiszKonto(konto)
        if let refreshToken { skarbiec.zapiszRefreshToken(refreshToken) }

        let klient = try Messenger.otworz(skarbiec: skarbiec, api: api, konto: konto, token: token)
        try await klient.registerDevice()
        try await klient.publishKeyPackages()
        await klient.otworzZnaneRozmowy(historia.lista().map(\.groupId))
        await klient.ustawPortfel(PortfelTokenow(magazyn: MagazynWUstawieniach()))
        await klient.uzupelnijTokeny()

        messenger = klient
        tokenOd = Date()
        nazwy = magazynNazw.wczytaj()
        rozmowy = historia.lista()
        zalogowany = true

        try await klient.startReceiving(
            naZdarzenie: { [weak self] zdarzenie in try await self?.obsluz(zdarzenie) },
            naStan: { [weak self] stan in Task { @MainActor in self?.stanPolaczenia = stan } }
        )
    }

    /// Powrót aplikacji na wierzch: odświeżenie tokenu i gniazda.
    ///
    /// Token dostępowy żyje dobę, a gniazdo skrzynki po uśpieniu aplikacji
    /// bywa martwe bez żadnego sygnału. Oba odnawiamy, zanim użytkownik zdąży
    /// zauważyć, że wiadomości „nie przychodzą".
    func naWierzchu() async {
        guard let messenger, let konto = skarbiec.wczytajKonto() else { return }
        if let tokenOd, Date().timeIntervalSince(tokenOd) > 12 * 60 * 60,
           let refresh = skarbiec.wczytajRefreshToken(),
           let wynik = try? await api.refreshSession(deviceId: konto.deviceId, refreshToken: refresh) {
            if let nowy = wynik.refreshToken { skarbiec.zapiszRefreshToken(nowy) }
            await messenger.ustawToken(wynik.token)
            self.tokenOd = Date()
        }
        try? await messenger.startReceiving(
            naZdarzenie: { [weak self] zdarzenie in try await self?.obsluz(zdarzenie) },
            naStan: { [weak self] stan in Task { @MainActor in self?.stanPolaczenia = stan } }
        )
    }

    /// Kasuje konto z tego urządzenia — nieodwracalnie: historia jest tylko tutaj.
    func wyloguj() async {
        let konto = skarbiec.wczytajKonto()
        let refresh = skarbiec.wczytajRefreshToken()

        // Zamknięcie PRZED czyszczeniem: działające gniazdo próbowałoby zapisywać
        // stan MLS do skarbca skasowanego chwilę wcześniej.
        rozmowaAV?.zakoncz()
        rozmowaAV = nil
        przychodzaca = nil
        await messenger?.zamknij()
        messenger = nil
        zegarPotwierdzen?.cancel()
        zbieracz = ZbieraczPotwierdzen()
        Echa.wspolne.zapomnijWszystko()
        skarbiec.wyczysc()

        zalogowany = false
        otwarta = nil
        wiadomosci = []
        wLocie = []
        rozmowy = []
        nazwy = StanNazw()
        ekran = .powitanie

        // Najlepszy wysiłek: lokalne czyszczenie nie może czekać na sieć.
        if let konto {
            try? await api.logout(deviceId: konto.deviceId, refreshToken: refresh)
        }
    }

    // MARK: - Rozmowy

    /// Etykieta rozmowy na liście i w nagłówku.
    func etykieta(_ pozycja: PozycjaListy) -> String {
        let surowa = pozycja.rozmowca.isEmpty ? t("Rozmowa", "Conversation") : pozycja.rozmowca
        return nazwy.etykieta(groupId: pozycja.groupId, rozmowcaSurowy: surowa)
    }

    func etykieta(_ groupId: Data) -> String {
        if let pozycja = rozmowy.first(where: { $0.groupId == groupId }) { return etykieta(pozycja) }
        return nazwy.etykieta(groupId: groupId, rozmowcaSurowy: historia.rozmowca(groupId) ?? "")
    }

    func uczestnicy(_ groupId: Data) -> [String] {
        (try? messenger?.uczestnicy(groupId)) ?? []
    }

    func kodBezpieczenstwa(_ groupId: Data) -> String? {
        messenger?.kodBezpieczenstwa(groupId)
    }

    func odciskUrzadzenia() -> String? {
        messenger?.odciskUrzadzenia()
    }

    /// Zaczyna rozmowę albo wraca do istniejącej z tą osobą. Zwraca jej identyfikator.
    func rozpocznijRozmowe(_ peerSurowy: String) async -> Data? {
        let peer = peerSurowy.trimmingCharacters(in: .whitespaces).lowercased()
        guard let messenger, !peer.isEmpty else { return nil }
        let ja = messenger.konto.userId

        guard peer != ja else {
            pokazBlad(t("To Twoja własna nazwa użytkownika.", "That's your own username."))
            return nil
        }

        if let istniejaca = Rozmowy.znajdz1na1(historia.lista(), groupId: \.groupId,
                                               czlonkowie: { try messenger.uczestnicy($0) },
                                               ja: ja, rozmowca: peer) {
            return istniejaca.groupId
        }

        var wynik: Data?
        await pracuj(t("Nie udało się rozpocząć rozmowy.", "Could not start the conversation.")) {
            let groupId = try await messenger.startConversation(peer)
            // Zapis od razu: założona i pusta rozmowa też jest rozmową, do której
            // trzeba móc wrócić z listy.
            try self.historia.zapewnij(groupId, rozmowca: peer)
            self.rozmowy = self.historia.lista()
            let nick = self.nazwy.mojNick
            if !nick.isEmpty { try? await messenger.sendMetadata(groupId, nazwaGrupy: nil, mojNick: nick) }
            wynik = groupId
        }
        return wynik
    }

    /// Zakłada grupę z kilku osób i nadaje jej nazwę.
    ///
    /// Pierwsza osoba zakłada rozmowę, reszta dochodzi kolejnymi commitami —
    /// każdy dokłada WSZYSTKIE urządzenia danej osoby naraz.
    func utworzGrupe(osoby surowe: [String], nazwa: String) async -> Data? {
        let osoby = surowe.map { $0.trimmingCharacters(in: .whitespaces).lowercased() }.filter { !$0.isEmpty }
        guard let messenger, let pierwsza = osoby.first else { return nil }

        var wynik: Data?
        await pracuj(t("Nie udało się utworzyć grupy.", "Could not create the group.")) {
            let groupId = try await messenger.startConversation(pierwsza)
            try self.historia.zapewnij(groupId, rozmowca: pierwsza)
            for osoba in osoby.dropFirst() {
                try await messenger.dodajCzlonka(groupId, osoba)
            }
            let ja = messenger.konto.userId
            try self.historia.ustawRozmowce(groupId, rozmowca: Rozmowy.nazwa(czlonkowie: try messenger.uczestnicy(groupId), ja: ja))
            let nazwaGrupy = nazwa.trimmingCharacters(in: .whitespaces)
            if !nazwaGrupy.isEmpty {
                self.nazwy = self.magazynNazw.zmien { $0.grupy[groupId.hex] = nazwaGrupy }
            }
            let nick = self.nazwy.mojNick
            if !nazwaGrupy.isEmpty || !nick.isEmpty {
                try? await messenger.sendMetadata(groupId, nazwaGrupy: nazwaGrupy.isEmpty ? nil : nazwaGrupy,
                                                  mojNick: nick.isEmpty ? nil : nick)
            }
            self.rozmowy = self.historia.lista()
            wynik = groupId
        }
        return wynik
    }

    /// Ustawia własny nick i rozsyła go do wszystkich rozmów.
    func ustawMojNick(_ nowy: String) async {
        let nick = nowy.trimmingCharacters(in: .whitespaces)
        nazwy = magazynNazw.zmien { $0.mojNick = nick }
        guard let messenger else { return }
        for rozmowa in rozmowy {
            try? await messenger.sendMetadata(rozmowa.groupId, nazwaGrupy: nil, mojNick: nick)
        }
    }

    /// Otwiera rozmowę na ekranie i potwierdza odczyt tego, co w niej widać.
    func otworz(_ groupId: Data) {
        otwarta = groupId
        wiadomosci = historia.wczytaj(groupId)
        wLocie = []
        oznaczPrzeczytane()
    }

    func zamknijRozmowe(_ groupId: Data) {
        guard otwarta == groupId else { return }
        otwarta = nil
        wiadomosci = []
        wLocie = []
    }

    /// „Przeczytane" ma znaczyć „widziałeś", a nie „dostałeś" — dlatego warunkiem
    /// jest OTWARTA rozmowa, a nie samo dotarcie wiadomości.
    private func oznaczPrzeczytane() {
        guard let groupId = otwarta else { return }
        if let ostatnia = wiadomosci.last {
            try? historia.oznaczPrzeczytane(groupId, doChwili: ostatnia.czas)
        }
        rozmowy = historia.lista()

        guard Preferencje.wspolne.potwierdzeniaOdczytu else { return }
        for wiadomosc in wiadomosci where !wiadomosc.wlasna && !wiadomosc.id.isEmpty && wiadomosc.rozmowa == nil {
            zakolejkujPotwierdzenie(groupId, .read, wiadomosc.id)
        }
    }

    /// Wysyła tekst do otwartej rozmowy.
    func wyslij(_ surowa: String) {
        let tresc = surowa.trimmingCharacters(in: .whitespacesAndNewlines)
        guard !tresc.isEmpty, let groupId = otwarta else { return }
        let wLocieWpis = WLocie(tresc: tresc, czas: terazMs())
        wLocie.append(wLocieWpis)
        Task { await wyslijWLocie(wLocieWpis, groupId: groupId) }
    }

    /// Ponawia nieudaną wiadomość z tą samą treścią.
    func ponow(_ wpis: WLocie) {
        guard let groupId = otwarta else { return }
        wLocie.removeAll { $0.id == wpis.id }
        let nowy = WLocie(tresc: wpis.tresc, czas: terazMs())
        wLocie.append(nowy)
        Task { await wyslijWLocie(nowy, groupId: groupId) }
    }

    private func wyslijWLocie(_ wpis: WLocie, groupId: Data) async {
        guard let messenger else { return }
        do {
            let czas = terazMs()
            let messageId = try await messenger.sendText(groupId, wpis.tresc, czas: czas)
            // Identyfikator Z RDZENIA — po nim wrócą potwierdzenia.
            let wiadomosc = Wiadomosc(id: messageId, autor: messenger.konto.userId, tresc: wpis.tresc,
                                      wlasna: true, czas: czas, stan: .wyslane)
            try historia.dopisz(groupId, rozmowca: historia.rozmowca(groupId) ?? "", wiadomosc)
            wLocie.removeAll { $0.id == wpis.id }
            odswiez(groupId)
        } catch {
            if let i = wLocie.firstIndex(where: { $0.id == wpis.id }) { wLocie[i].blad = true }
            pokazBlad(opis(error, t("Nie udało się wysłać wiadomości.", "Could not send the message.")))
        }
    }

    // MARK: - Zdarzenia z sieci

    /// Czy to przyszło z DRUGIEGO NASZEGO urządzenia (credential MLS, nie pole z sieci).
    private func czyOdNas(_ nadawca: String) -> Bool {
        nadawca == messenger?.konto.userId
    }

    /// Kiedy wiadomość NADANO, a nie kiedy dotarła.
    ///
    /// To samo pole znaczyło kiedyś na dwóch platformach dwie różne rzeczy; po
    /// scaleniu historii wątek układał się na każdym urządzeniu inaczej. Zero
    /// znaczy „nadawca nic nie podał" — wtedy chwila odbioru, bo wiadomość
    /// z 1970 roku byłaby gorszym kłamstwem niż zaokrąglenie.
    private func czasNadania(_ sentAtMs: UInt64) -> Int64 {
        sentAtMs > 0 ? Int64(clamping: sentAtMs) : terazMs()
    }

    /// Obsługuje odebrane zdarzenie i ZAPISUJE jego skutek, zanim wróci.
    ///
    /// Powrót z tej funkcji jest dla skrzynki sygnałem do potwierdzenia ramki,
    /// więc wszystko, co ma przetrwać restart, musi być na dysku przed `return`.
    /// Wiadomość trafia do SWOJEJ rozmowy po `groupId`, nie do otwartej na ekranie.
    func obsluz(_ zdarzenie: IncomingEvent) async throws {
        switch zdarzenie {
        case let .message(groupId, nadawca, _, tekst, sentAtMs, messageId):
            let wlasna = czyOdNas(nadawca)
            let wiadomosc = Wiadomosc(id: messageId, autor: nadawca, tresc: tekst, wlasna: wlasna,
                                      czas: czasNadania(sentAtMs), stan: wlasna ? .wyslane : nil)
            try przyjmij(wiadomosc, groupId: groupId, nadawca: nadawca)

        case let .attachment(groupId, nadawca, _, blobId, klucz, nonce, mime, rozmiar, nazwaPliku, sentAtMs, messageId):
            // Załączniki pokazujemy na razie jako wpis z nazwą pliku — klucz
            // zostaje w historii, więc pobranie dojdzie bez utraty czegokolwiek.
            let wlasna = czyOdNas(nadawca)
            let wiadomosc = Wiadomosc(
                id: messageId, autor: nadawca, tresc: nazwaPliku ?? mime, wlasna: wlasna, czas: czasNadania(sentAtMs),
                zalacznik: Zalacznik(blobId: blobId, klucz: klucz, nonce: nonce, mimeType: mime,
                                     rozmiar: Int64(clamping: rozmiar), nazwaPliku: nazwaPliku),
                stan: wlasna ? .wyslane : nil
            )
            try przyjmij(wiadomosc, groupId: groupId, nadawca: nadawca)

        case let .receipt(groupId, nadawca, _, rodzaj, identyfikatory):
            if czyOdNas(nadawca) {
                // Odczyt z drugiego naszego urządzenia: przeczytane na laptopie
                // ma znaczyć przeczytane także tutaj.
                guard rodzaj == .read else { return }
                let szukane = Set(identyfikatory.map(\.hex))
                if let doChwili = historia.wczytaj(groupId).filter({ szukane.contains($0.id.hex) }).map(\.czas).max() {
                    try historia.oznaczPrzeczytane(groupId, doChwili: doChwili)
                }
            } else {
                // Cudzych odczytów nie pokazujemy, gdy własnych nie oddajemy.
                if rodzaj == .read && !Preferencje.wspolne.potwierdzeniaOdczytu { return }
                try historia.nanieStan(groupId, identyfikatory: identyfikatory,
                                       nowy: rodzaj == .read ? .przeczytane : .dostarczone)
            }
            odswiez(groupId)

        case let .joinedConversation(groupId):
            // Wiersz musi powstać nawet pusty: lista rośnie z historii, a Welcome
            // nie niesie wiadomości. Nazwa ze składu MLS — zna każdy sposób
            // powstania rozmowy.
            let ja = messenger?.konto.userId ?? ""
            let nazwa = Rozmowy.nazwa(czlonkowie: uczestnicy(groupId), ja: ja)
            try historia.zapewnij(groupId, rozmowca: nazwa)
            rozmowy = historia.lista()

        case let .metadata(groupId, nadawca, _, nazwaGrupy, nick):
            // `nil` = nadawca nie zmieniał pola, `""` = wyczyścił.
            nazwy = magazynNazw.zmien { stan in
                if let nazwaGrupy {
                    stan.grupy[groupId.hex] = nazwaGrupy.isEmpty ? nil : nazwaGrupy.trimmingCharacters(in: .whitespaces)
                }
                if let nick {
                    let czysty = nick.trimmingCharacters(in: .whitespaces)
                    if self.czyOdNas(nadawca) {
                        stan.mojNick = czysty
                    } else {
                        stan.nicki[nadawca] = czysty.isEmpty ? nil : czysty
                    }
                }
            }

        case .membershipChanged:
            // Skład mógł się zmienić — nazwy grup bez własnej nazwy idą za składem.
            rozmowy = historia.lista()

        case let .proposalQueued(groupId):
            // Cudze wyjście z grupy domykamy commitem u siebie. Osobnym zadaniem:
            // ramka z propozycją jest już przetworzona i ma zostać potwierdzona.
            if let messenger {
                Task { try? await messenger.domknijPropozycje(groupId) }
            }

        case let .callSignal(groupId, nadawca, _, rodzaj, callId, tresc, odcisk, adresat, _):
            obsluzSygnalRozmowy(groupId: groupId, od: nadawca, rodzaj: rodzaj, callId: callId,
                                tresc: tresc, odcisk: odcisk, adresat: adresat)
        }
    }

    // MARK: - Rozmowy A/V

    /// Dzwoni do pozostałych osób z rozmowy. Skład z drzewa MLS, nie z etykiety
    /// na liście: dzwonimy do tych, którzy naprawdę są w grupie.
    func zadzwon(_ groupId: Data, wideo: Bool) {
        guard let messenger, rozmowaAV == nil else { return }
        let ja = messenger.konto.userId
        let rozmowcy = uczestnicy(groupId).filter { $0 != ja }
        guard !rozmowcy.isEmpty else {
            pokazBlad(t("W tej rozmowie nie ma jeszcze nikogo, do kogo można zadzwonić.",
                        "There's no one in this conversation to call yet."))
            return
        }
        uruchom(RozmowaAV.zadzwon(messenger: messenger, groupId: groupId, rozmowcy: rozmowcy, zWideo: wideo))
    }

    func odbierz(wideo: Bool) {
        guard let messenger, let dzwoni = przychodzaca else { return }
        let zalegle = oczekujaceSygnaly
        oczekujaceSygnaly = []
        przychodzaca = nil
        uruchom(RozmowaAV.odbierz(messenger: messenger, groupId: dzwoni.groupId, callId: dzwoni.callId, zWideo: wideo,
                                  od: dzwoni.od, oferta: dzwoni.oferta, odcisk: dzwoni.odcisk, zalegle: zalegle))
    }

    /// Odrzucenie to rozłączenie wysłane dzwoniącemu — inaczej dzwoniłby w próżnię.
    func odrzuc() {
        guard let dzwoni = przychodzaca else { return }
        przychodzaca = nil
        oczekujaceSygnaly = []
        if let messenger {
            Task { try? await messenger.sendCallSignal(dzwoni.groupId, rodzaj: .hangup, callId: dzwoni.callId,
                                                       tresc: "", odcisk: "", doKogo: dzwoni.od) }
        }
        zapiszSladRozmowy(groupId: dzwoni.groupId, wideo: dzwoni.zWideo, sekundy: nil, wychodzaca: false,
                          rozmowca: dzwoni.od)
    }

    func rozlacz() {
        guard let rozmowa = rozmowaAV else { return }
        rozmowaAV = nil
        rozmowa.zakoncz()
        let sekundy = rozmowa.polaczonoO.map { Int64(Date().timeIntervalSince($0)) }
        zapiszSladRozmowy(groupId: rozmowa.groupId, wideo: rozmowa.zWideo || rozmowa.kameraWlaczona,
                          sekundy: sekundy, wychodzaca: rozmowa.wychodzaca,
                          rozmowca: rozmowa.uczestnicy.first?.nazwa ?? "")
    }

    private func uruchom(_ rozmowa: RozmowaAV) {
        // Ostatni rozmówca odłożył słuchawkę — rozmowa gaśnie także tutaj,
        // zamiast zostawić ekran z samym sobą.
        rozmowa.naKoniec = { [weak self] in self?.rozlacz() }
        rozmowaAV = rozmowa
    }

    /// Ślad rozmowy w wątku. Wpis jest LOKALNY — jak na Androidzie i w webie:
    /// to, że ktoś do kogoś dzwonił, nie jest wiadomością do rozsyłania.
    private func zapiszSladRozmowy(groupId: Data, wideo: Bool, sekundy: Int64?, wychodzaca: Bool, rozmowca: String) {
        let wpis = Wiadomosc(id: Data(), autor: wychodzaca ? (messenger?.konto.userId ?? "") : rozmowca, tresc: "",
                             wlasna: wychodzaca, czas: terazMs(),
                             rozmowa: ZapisRozmowyAV(wideo: wideo, sekundy: sekundy, wychodzaca: wychodzaca))
        _ = try? historia.dopisz(groupId, rozmowca: historia.rozmowca(groupId) ?? rozmowca, wpis)
        odswiez(groupId)
    }

    private func obsluzSygnalRozmowy(groupId: Data, od: String, rodzaj: CallSignalKind, callId: Data,
                                     tresc: String, odcisk: String, adresat: String) {
        // Sygnał do kogoś innego w siatce albo z naszego drugiego urządzenia —
        // nie nasza para, nie nasza sprawa.
        let ja = messenger?.konto.userId ?? ""
        guard od != ja, adresat.isEmpty || adresat == ja else { return }

        if let biezaca = rozmowaAV {
            // Druga rozmowa w trakcie trwającej: odpowiadamy „zajęte"
            // rozłączeniem, zamiast mieszać jej sygnały z bieżącą.
            guard biezaca.callId == callId else {
                if rodzaj == .offer, let messenger {
                    Task { try? await messenger.sendCallSignal(groupId, rodzaj: .hangup, callId: callId,
                                                               tresc: "", odcisk: "", doKogo: od) }
                }
                return
            }
            biezaca.przyjmij(od: od, rodzaj: rodzaj, tresc: tresc, odcisk: odcisk)
            return
        }

        switch rodzaj {
        case .offer:
            oczekujaceSygnaly = []
            przychodzaca = PrzychodzacaRozmowa(od: od, groupId: groupId, callId: callId, oferta: tresc, odcisk: odcisk)
        case .hangup:
            // Dzwoniący się rozmyślił, zanim ktokolwiek odebrał.
            if let dzwoni = przychodzaca, dzwoni.callId == callId {
                przychodzaca = nil
                oczekujaceSygnaly = []
                zapiszSladRozmowy(groupId: groupId, wideo: dzwoni.zWideo, sekundy: nil, wychodzaca: false, rozmowca: od)
            }
        default:
            if przychodzaca?.callId == callId, oczekujaceSygnaly.count < limitOczekujacych {
                oczekujaceSygnaly.append(SygnalAV(od: od, rodzaj: rodzaj, tresc: tresc, odcisk: odcisk))
            }
        }
    }

    /// Zapisuje przychodzącą wiadomość i potwierdza jej dostarczenie.
    private func przyjmij(_ wiadomosc: Wiadomosc, groupId: Data, nadawca: String) throws {
        let ja = messenger?.konto.userId ?? ""
        let nazwa = historia.rozmowca(groupId) ?? Rozmowy.nazwa(czlonkowie: uczestnicy(groupId), ja: ja)
        let nowa = try historia.dopisz(groupId, rozmowca: nazwa, wiadomosc)

        // Za własną wiadomość z drugiego urządzenia nie potwierdzamy: rozmówca
        // dostałby „dostarczono" na coś, czego nie wysłał.
        if nowa && !wiadomosc.wlasna && !wiadomosc.id.isEmpty {
            zakolejkujPotwierdzenie(groupId, .delivered, wiadomosc.id)
        }

        odswiez(groupId)
        if otwarta == groupId {
            oznaczPrzeczytane()
        }
    }

    private func odswiez(_ groupId: Data) {
        if otwarta == groupId {
            wiadomosci = historia.wczytaj(groupId)
        }
        rozmowy = historia.lista()
    }

    // MARK: - Potwierdzenia

    /// Dokłada potwierdzenie i pilnuje, żeby wysyłka była zaplanowana.
    ///
    /// Jeden zegar na wszystko, co się nazbiera. Nowy przy każdym potwierdzeniu
    /// przesuwałby wysyłkę w nieskończoność przy żywej rozmowie — i wysłałby ją
    /// dokładnie wtedy, gdy rozmowa ucichła, czyli w najbardziej wymownym momencie.
    private func zakolejkujPotwierdzenie(_ groupId: Data, _ rodzaj: ReceiptKind, _ id: Data) {
        zbieracz.dodaj(groupId: groupId, rodzaj: rodzaj, identyfikator: id)
        guard zegarPotwierdzen == nil else { return }

        let opoznienie = losoweOpoznienie()
        zegarPotwierdzen = Task { [weak self] in
            try? await Task.sleep(nanoseconds: opoznienie * 1_000_000)
            await self?.wyslijPotwierdzenia()
        }
    }

    private func wyslijPotwierdzenia() async {
        zegarPotwierdzen = nil
        guard let messenger else { return }
        for paczka in zbieracz.zabierz() {
            // Nieudane potwierdzenie przepada: ptaszek jest wygodą, a ponawianie
            // w kółko dokładałoby kopert do ruchu, który ten mechanizm ogranicza.
            try? await messenger.sendReceipt(paczka.groupId, rodzaj: paczka.rodzaj, identyfikatory: paczka.identyfikatory)
        }
    }

    // MARK: - Pomocnicze

    func pokazBlad(_ tekst: String) {
        toast = Toast(tekst: tekst, rodzaj: .blad)
    }

    func pokazInformacje(_ tekst: String) {
        toast = Toast(tekst: tekst, rodzaj: .informacja)
    }

    private func opis(_ blad: Error, _ domyslny: String) -> String {
        if let blad = blad as? BladAplikacji { return blad.tekst }
        if let blad = blad as? BladApi { return blad.komunikat }
        if let blad = blad as? MekambError { return "\(domyslny) (\(blad))" }
        if (blad as NSError).domain == NSURLErrorDomain {
            return t("Brak połączenia z serwerem.", "Cannot reach the server.")
        }
        return domyslny
    }

    private func pracuj(_ domyslnyBlad: String, _ praca: () async throws -> Void) async {
        pracuje = true
        defer { pracuje = false }
        do {
            try await praca()
        } catch {
            pokazBlad(opis(error, domyslnyBlad))
        }
    }
}

// MARK: - Podglądy Xcode

#if DEBUG
extension ModelAplikacji {
    /// Model z przykładowymi rozmowami dla płótna podglądów (`#Preview`).
    ///
    /// # Dlaczego dane idą przez prawdziwą `Historia`, a nie wprost do pól
    ///
    /// Bo widoki same czytają historię — wątek woła `otworz`, które ładuje
    /// wiadomości z dysku i nadpisałoby wszystko, co wpisano w pole ręcznie.
    /// Przez `Historia` podgląd przechodzi tą samą drogą co aplikacja, więc
    /// pokazuje też liczniki nieprzeczytanych i stany doręczenia tak, jak
    /// policzy je kod produkcyjny.
    ///
    /// Skarbiec dostaje osobną usługę Keychaina i świeży katalog tymczasowy:
    /// podgląd nie może dotknąć konta ani historii prawdziwej instalacji, a każde
    /// odświeżenie płótna startuje od tych samych danych.
    static func podglad(zalogowany: Bool = true, ekran: EkranWejscia = .powitanie, puste: Bool = false) -> ModelAplikacji {
        let katalog = FileManager.default.temporaryDirectory
            .appendingPathComponent("mekamb-podglad-\(UUID().uuidString)", isDirectory: true)
        let skarbiec = Skarbiec(
            usluga: "com.mekamb.chat.podglad",
            katalog: katalog,
            ustawienia: UserDefaults(suiteName: "mekamb.podglad") ?? .standard
        )
        skarbiec.zapiszKonto(Konto(username: "ola", deviceId: "ios-podglad"))

        let model = ModelAplikacji(api: Api(), skarbiec: skarbiec)
        model.uruchamianie = false
        model.zalogowany = zalogowany
        model.ekran = ekran
        if !puste { model.wypelnijPrzykladami() }
        return model
    }

    /// Identyfikatory rozmów z podglądu — do otwierania wątku w `#Preview`.
    enum Przyklad {
        static let rozmowaZMarkiem = Data(repeating: 1, count: 16)
        static let grupa = Data(repeating: 2, count: 16)
        static let rozmowaZKasia = Data(repeating: 3, count: 16)
    }

    private func wypelnijPrzykladami() {
        let teraz = terazMs()
        let minuta: Int64 = 60_000
        let dzien: Int64 = 24 * 60 * minuta
        var licznik: UInt8 = 0

        func w(_ autor: String, _ tresc: String, _ minutTemu: Int64, stan: StanWiadomosci? = nil) -> Wiadomosc {
            licznik &+= 1
            let wlasna = autor == "ola"
            return Wiadomosc(id: Data(repeating: licznik, count: 16), autor: autor, tresc: tresc, wlasna: wlasna,
                             czas: teraz - minutTemu * minuta, stan: wlasna ? (stan ?? .wyslane) : nil)
        }

        let marek = Przyklad.rozmowaZMarkiem
        let watek: [Wiadomosc] = [
            w("marek", "Hej, masz chwilę wieczorem?", dzien / minuta + 40),
            w("ola", "Jasne, po 19 jestem wolna", dzien / minuta + 35, stan: .przeczytane),
            w("marek", "Super 👍", 95),
            w("marek", "Przesyłam szkic projektu, rzuć okiem jak znajdziesz czas", 94),
            w("marek", "Zwłaszcza ekran rozmowy — dymki są teraz neutralne", 93),
            w("ola", "Wygląda dużo czyściej niż poprzednio", 12, stan: .przeczytane),
            w("ola", "Jedno pytanie: czy kod bezpieczeństwa zostaje w szczegółach?", 11, stan: .dostarczone),
        ]
        for wiadomosc in watek { _ = try? historia.dopisz(marek, rozmowca: "marek", wiadomosc) }
        try? historia.oznaczPrzeczytane(marek, doChwili: teraz)

        let grupa = Przyklad.grupa
        try? historia.zapewnij(grupa, rozmowca: "kasia, marek, tomek")
        _ = try? historia.dopisz(grupa, rozmowca: "kasia, marek, tomek", w("tomek", "Spotkanie przesunięte na czwartek", 30))
        _ = try? historia.dopisz(grupa, rozmowca: "kasia, marek, tomek", w("kasia", "Pasuje mi", 25))
        _ = try? historia.dopisz(grupa, rozmowca: "kasia, marek, tomek", w("tomek", "To widzimy się o 10", 5))

        let kasia = Przyklad.rozmowaZKasia
        _ = try? historia.dopisz(kasia, rozmowca: "kasia", w("ola", "Dzięki za wczoraj!", 3 * dzien / minuta, stan: .przeczytane))
        try? historia.oznaczPrzeczytane(kasia, doChwili: teraz)

        nazwy = magazynNazw.zmien { stan in
            stan.grupy[grupa.hex] = "Zespół projektowy"
            stan.nicki["marek"] = "Marek Nowak"
        }
        rozmowy = historia.lista()
    }
}
#endif
