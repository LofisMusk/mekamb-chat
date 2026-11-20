import Foundation

/// Warstwa spinająca rdzeń w Rust z siecią.
///
/// # Dlaczego aktor
///
/// Bo stan MLS jest jeden, a dotykają go dwie strony naraz: odbiór ze skrzynki
/// i to, co robi użytkownik (wysyłka, nowa rozmowa). `MekambClient` ma w środku
/// muteks, więc pojedyncze wywołanie jest bezpieczne — ale para „operacja +
/// zapis stanu" już nie: dwa wątki przeplatające `openEnvelope` z `exportState`
/// potrafią zapisać stan starszy niż wykonana operacja, a to jest klient cofnięty
/// do poprzedniej epoki, czyli koniec odszyfrowywania. Android szereguje to
/// muteksem (`mlsMutex`); tu robi to izolacja aktora — każda para
/// operacja+zapis jest synchroniczna w jego wnętrzu, więc nic jej nie przetnie.
///
/// # Stan zapisujemy po każdej zmianie
///
/// MLS przesuwa ratchet przy wysyłce i odbiorze. Pominięcie zapisu po
/// którejkolwiek operacji cofa klienta do starej epoki. Dlatego zapis jest
/// wpleciony w każdą ścieżkę tutaj, a nie zostawiony wywołującemu.
///
/// # Czego tu nie ma (jeszcze)
///
/// Transportu UDP. Klient iOS jest — jak web — osiągalny wyłącznie przez
/// skrzynkę i tylko przez nią wysyła. Rejestruje się w katalogu z pustym, ale
/// podpisanym rekordem adresowym, więc nadawcy z Androida też wybierają skrzynkę.
actor Messenger {
    let konto: Konto
    private let client: MekambClient
    private let api: Api
    private let skarbiec: Skarbiec
    private var token: String
    private var portfel: PortfelTokenow?
    private var dobieranie: Task<Void, Never>?
    private var skrzynka: PolaczenieZeSkrzynka?
    private var odbior: Task<Void, Never>?

    private init(client: MekambClient, api: Api, skarbiec: Skarbiec, konto: Konto, token: String) {
        self.client = client
        self.api = api
        self.skarbiec = skarbiec
        self.konto = konto
        self.token = token
    }

    /// Tworzy nową tożsamość urządzenia albo odtwarza zapisaną.
    static func otworz(skarbiec: Skarbiec, api: Api, konto: Konto, token: String) throws -> Messenger {
        let client: MekambClient
        if let ziarno = skarbiec.wczytajZiarno(), let stan = skarbiec.wczytajStan() {
            client = try MekambClient.restore(userId: konto.userId, deviceId: konto.deviceId, seed: ziarno, state: stan)
        } else {
            client = try MekambClient(userId: konto.userId, deviceId: konto.deviceId)
            skarbiec.zapiszZiarno(client.exportSeed())
            try skarbiec.zapiszStan(client.exportState())
        }
        return Messenger(client: client, api: api, skarbiec: skarbiec, konto: konto, token: token)
    }

    private func zapiszStan() throws {
        try skarbiec.zapiszStan(client.exportState())
    }

    /// Nowy token po odświeżeniu sesji — używany przy następnym łączeniu i żądaniu.
    func ustawToken(_ nowy: String) {
        token = nowy
    }

    func biezacyToken() -> String { token }

    /// Otwiera rozmowy zapisane na dysku.
    ///
    /// # Czemu to musiało powstać
    ///
    /// `MekambClient.restore` przywraca pełny stan MLS, ale PUSTĄ mapę otwartych
    /// rozmów — wypełniało ją wyłącznie zakładanie grupy albo przyjęcie Welcome.
    /// Bez tego zrestartowany klient ma wszystko na dysku, a mimo to każde
    /// wysłanie kończy się „nie ma takiej rozmowy w tym kliencie", a przychodzące
    /// koperty nie pasują do niczego i przepadają w ciszy. Identyfikatory znamy
    /// z własnej historii. Rozmowa bez stanu MLS zostaje do czytania i tyle.
    func otworzZnaneRozmowy(_ groupIds: [Data]) {
        for groupId in groupIds {
            // Uszkodzony wpis nie może zablokować pozostałych rozmów.
            _ = try? client.openConversation(groupId: groupId)
        }
    }

    func ustawPortfel(_ nowy: PortfelTokenow) {
        portfel = nowy
    }

    // MARK: - Katalog

    /// Zgłasza urządzenie do katalogu z pustym, PODPISANYM rekordem adresowym.
    func registerDevice() async throws {
        try await api.registerDevice(
            token: token,
            deviceId: konto.deviceId,
            mlsPublicKey: client.mlsPublicKey(),
            addrSignature: client.signAddressRecord(transportKey: "", transportAddresses: "")
        )
    }

    /// Publikuje zapas key packages.
    ///
    /// Zapis PRZED wysyłką: klucze prywatne pakietów są już w stanie, a ich
    /// utrata znaczyłaby, że nie dołączymy do grupy, do której ktoś nas właśnie
    /// zaprosił. Pakiety są jednorazowe — dlatego publikujemy je przy każdym
    /// wejściu, także przez odświeżoną sesję, a nie tylko przy logowaniu.
    func publishKeyPackages(ile: Int = 10) async throws {
        let pakiety = try (0..<ile).map { _ in try client.createKeyPackage() }
        try zapiszStan()
        try await api.publishKeyPackages(token: token, deviceId: konto.deviceId, packages: pakiety)
    }

    // MARK: - Tokeny doręczeniowe

    /// Uzupełnia zapas tokenów, jeśli zszedł poniżej progu.
    ///
    /// Cicha przy każdym niepowodzeniu: wdrożenie bez tokenów odpowiada 503 i to
    /// jest poprawny stan, nie awaria. Jedno dobieranie naraz — dwa równoległe
    /// brałyby podwójny zapas przy tym samym, uwierzytelnionym żądaniu.
    func uzupelnijTokeny() async {
        if let trwajace = dobieranie {
            await trwajace.value
            return
        }
        guard let portfel, portfel.trzebaDobrac else { return }

        let zadanie = Task { [api, token] in
            guard let kluczPubliczny = await api.kluczTokenow(),
                  portfel.przypnijKlucz(kluczPubliczny),
                  let klucz = Data(base64Encoded: kluczPubliczny)
            else { return }

            let proby = (0..<PortfelTokenow.docelowy).map { _ in tokenOslep() }
            guard let wydane = try? await api.wydajTokeny(token: token, oslepione: proby.map(\.oslepione)) else { return }

            var nowe: [TokenDoreczenia] = []
            for (i, wydany) in wydane.enumerated() where i < proby.count {
                // Token z nieudanym dowodem pomijamy: jeden zły nie może
                // kosztować pozostałych, a odsłonięcie sprawdza dowód
                // Chaum-Pedersen, że serwer użył OPUBLIKOWANEGO klucza.
                guard let gotowy = try? tokenOdslon(
                    proba: proby[i], ocenione: wydany.ocenione, wyzwanie: wydany.wyzwanie,
                    odpowiedz: wydany.odpowiedz, kluczPubliczny: klucz
                ) else { continue }
                nowe.append(TokenDoreczenia(
                    ziarno: gotowy.ziarno.base64EncodedString(),
                    odslonione: gotowy.odslonione.base64EncodedString()
                ))
            }
            portfel.doloz(nowe)
        }
        dobieranie = zadanie
        await zadanie.value
        dobieranie = nil
    }

    /// Token do jednego depozytu; przy pustym portfelu dobiera synchronicznie.
    ///
    /// Seria wysyłek (commit + welcome + echo) opróżnia portfel szybciej, niż
    /// zdąży się dobrać po wysyłce. Z `DELIVERY_TOKEN_REQUIRED` depozyt bez
    /// tokenu dostaje 401 — a tą drogą idą też commity i welcome, więc pusty
    /// portfel po cichu odcinałby urządzenia od grupy.
    private func wezTokenDoreczenia() async -> String? {
        guard let portfel else { return nil }
        if let token = portfel.wez() { return token.naglowek }
        await uzupelnijTokeny()
        return portfel.wez()?.naglowek
    }

    /// Deponuje kopertę z tokenem doręczeniowym; przy 401 dobiera i ponawia raz.
    private func zdeponuj(_ odbiorca: String, _ koperta: Data) async throws {
        do {
            try await api.deposit(userId: odbiorca, envelope: koperta, tokenDoreczenia: await wezTokenDoreczenia())
        } catch let blad as BladApi where blad.status == 401 && portfel != nil {
            await uzupelnijTokeny()
            try await api.deposit(userId: odbiorca, envelope: koperta, tokenDoreczenia: portfel?.wez()?.naglowek)
        }
    }

    // MARK: - Skład i rozmowy

    /// Skład rozmowy — nazwy użytkowników z drzewa MLS, bez powtórzeń urządzeń.
    nonisolated func uczestnicy(_ groupId: Data) throws -> [String] {
        var widziani = Set<String>()
        return try client.members(groupId: groupId)
            .map { $0.split(separator: ":", maxSplits: 1).first.map(String.init) ?? $0 }
            .filter { widziani.insert($0).inserted }
    }

    /// Kod bezpieczeństwa rozmowy — do porównania poza aplikacją.
    nonisolated func kodBezpieczenstwa(_ groupId: Data) -> String? {
        try? client.safetyNumber(groupId: groupId)
    }

    /// Odcisk tego urządzenia — do pokazania w ustawieniach.
    nonisolated func odciskUrzadzenia() -> String? {
        try? client.deviceFingerprint()
    }

    /// Pobiera po jednym key package na urządzenie.
    ///
    /// Urządzenie bez wolnego zapasu POMIJAMY zamiast przerywać całość — jeden
    /// zapomniany laptop nie może blokować rozmowy na pozostałych urządzeniach.
    private func pobierzPakiety(_ peer: String) async throws -> [Data] {
        let urzadzenia = try await api.lookupDevices(username: peer)
        guard !urzadzenia.isEmpty else {
            throw BladAplikacji(
                "Użytkownik \(peer) nie ma zarejestrowanych urządzeń.",
                "User \(peer) has no registered devices."
            )
        }
        var pakiety: [Data] = []
        for urzadzenie in urzadzenia {
            if let pakiet = try? await api.claimKeyPackage(deviceId: urzadzenie.deviceId) {
                pakiety.append(pakiet)
            }
        }
        guard !pakiety.isEmpty else {
            throw BladAplikacji(
                "Żadne urządzenie użytkownika \(peer) nie ma wolnych kluczy — niech otworzy aplikację i spróbuj ponownie.",
                "None of \(peer)'s devices has spare keys — ask them to open the app and try again."
            )
        }
        return pakiety
    }

    /// Zajmuje epokę w `GroupRelay`; rozstrzygalna odmowa porzuca commit.
    ///
    /// Przygotowany i nieporzucony commit blokuje w MLS całą rozmowę — reguła
    /// i jej historia w `Relay.swift`.
    private func zajmijEpoke(_ groupId: Data) async throws {
        let przyjety: Bool
        do {
            przyjety = try await api.zajmijEpoke(
                token: token,
                relayId: client.relayId(groupId: groupId),
                epoch: try client.epoch(groupId: groupId)
            )
        } catch let blad as BladApi {
            // Odmowa nierozstrzygalna (5xx) leci dalej nietknięta.
            guard let komunikat = Relay.odmowa(status: blad.status) else { throw blad }
            throw porzucCommit(groupId, komunikat)
        }
        if !przyjety { throw porzucCommit(groupId, Relay.wyscig) }
    }

    private func porzucCommit(_ groupId: Data, _ komunikat: BladAplikacji) -> BladAplikacji {
        // Porzucenie może się nie udać — to nie może przesłonić powodu.
        try? client.discardCommit(groupId: groupId)
        try? zapiszStan()
        return komunikat
    }

    /// Wysyła Welcome **skrzynką**, nigdy wprost — musi dotrzeć do KAŻDEGO
    /// nowo dodanego urządzenia, a skrzynka jest jedyną drogą, która się na nie
    /// rozchodzi.
    private func wyslijWelcome(_ peer: String, _ welcome: Data) async throws {
        Echa.wspolne.zapamietaj(welcome)
        try await zdeponuj(peer, welcome)
    }

    /// Zakłada rozmowę z użytkownikiem i zwraca identyfikator grupy.
    func startConversation(_ peer: String) async throws -> Data {
        let pakiety = try await pobierzPakiety(peer)

        let groupId = try client.createConversation()
        let oczekujacy = try client.addMembers(groupId: groupId, keyPackages: pakiety)
        try zapiszStan()

        try await zajmijEpoke(groupId)

        try client.confirmCommit(groupId: groupId)
        try zapiszStan()

        // Commitu przy zakładaniu nie ma komu rozesłać: w grupie jesteśmy my
        // i osoba, którą zapraszamy, a ona dostaje welcome.
        if let welcome = oczekujacy.welcome {
            try await wyslijWelcome(peer, welcome)
        }
        await uzupelnijTokeny()
        return groupId
    }

    /// Dodaje osobę do rozmowy: key packages, commit do relaya, welcome.
    func dodajCzlonka(_ groupId: Data, _ peer: String) async throws {
        let pakiety = try await pobierzPakiety(peer)
        let oczekujacy = try client.addMembers(groupId: groupId, keyPackages: pakiety)
        try zapiszStan()

        try await zajmijEpoke(groupId)
        try client.confirmCommit(groupId: groupId)
        try zapiszStan()

        // Commit rozsyłamy sami, PO zajęciu epoki: rozesłanie wcześniej wysłałoby
        // commit, który relay może odrzucić, a odbiorcy nie cofną przetworzonego.
        // Nowa osoba dostaje welcome — commitu wprowadzającego ją nie przetworzy.
        // Wyjątkiem jest własne urządzenie: wspólna skrzynka, a nasze pozostałe
        // urządzenia muszą ten commit dostać.
        Echa.wspolne.zapamietaj(oczekujacy.commit)
        let wlasneUrzadzenie = peer == konto.userId
        for osoba in try uczestnicy(groupId) where wlasneUrzadzenie || osoba != peer {
            try await zdeponuj(osoba, oczekujacy.commit)
        }

        if let welcome = oczekujacy.welcome {
            try await wyslijWelcome(peer, welcome)
        }
        await uzupelnijTokeny()
    }

    /// Domyka cudzą propozycję (najczęściej SelfRemove) commitem i rozsyła go.
    ///
    /// openmls nie pozwala wychodzącemu scalić własnego usunięcia (RFC 9420),
    /// więc robi to pozostający — bez tego liść zostaje „duchem" w drzewie.
    func domknijPropozycje(_ groupId: Data) async throws {
        let oczekujacy = try client.commitPending(groupId: groupId)
        try zapiszStan()
        try await zajmijEpoke(groupId)
        try client.confirmCommit(groupId: groupId)
        try zapiszStan()

        Echa.wspolne.zapamietaj(oczekujacy.commit)
        for osoba in try uczestnicy(groupId) {
            try await zdeponuj(osoba, oczekujacy.commit)
        }
        await uzupelnijTokeny()
    }

    // MARK: - Wysyłka

    /// Rozsyła kopertę do skrzynek WSZYSTKICH uczestników poza nami.
    ///
    /// Koperta `application` to ten sam szyfrogram dla całej grupy, ale
    /// dostarczyć trzeba go do skrzynki każdego członka z osobna. Android wysyłał
    /// kiedyś treść do jednego wskazanego rozmówcy: w grupie wiadomość docierała
    /// do jednej osoby, a nadawca nie widział żadnego błędu.
    private func rozeslij(_ groupId: Data, _ koperta: Data) async throws {
        for osoba in try uczestnicy(groupId) where osoba != konto.userId {
            try await zdeponuj(osoba, koperta)
        }
    }

    /// Wrzuca kopertę także do WŁASNEJ skrzynki — bez tego wiadomość wysłana
    /// z telefonu nie istnieje dla drugiego urządzenia tego konta.
    ///
    /// Niepowodzenie nie jest błędem: do rozmówcy wiadomość już poszła, a błąd
    /// przy dostarczonej wiadomości byłby gorszy niż chwilowy rozjazd.
    private func echoDoSiebie(_ koperta: Data) async {
        Echa.wspolne.zapamietaj(koperta)
        try? await zdeponuj(konto.userId, koperta)
    }

    /// Szyfruje i wysyła tekst. Zwraca identyfikator wiadomości Z RDZENIA —
    /// potwierdzenia drugiej strony wskazują właśnie jego; własny UUID znaczyłby
    /// ptaszek, który nigdy się nie zmieni (tak było kiedyś w webie).
    /// Wysyła sygnał rozmowy A/V (SDP, kandydat ICE, rozłączenie) do JEDNEJ osoby.
    ///
    /// Sygnał jedzie w MLS jak każda wiadomość, a odcisk DTLS osobno od SDP —
    /// odbiorca porównuje jedno z drugim (`verifySdpFingerprint`), więc
    /// podmiana SDP po drodze zrywa rozmowę zamiast ją przejąć.
    func sendCallSignal(_ groupId: Data, rodzaj: CallSignalKind, callId: Data, tresc: String,
                        odcisk: String, doKogo: String) async throws {
        let koperta = try client.sealCallSignal(
            groupId: groupId, kind: rodzaj, callId: callId, payload: tresc,
            dtlsFingerprint: odcisk, target: doKogo, sentAtMs: UInt64(max(terazMs(), 0))
        )
        // Ratchet przesunął się przy szyfrowaniu — zapis nawet gdy wysyłka zawiedzie.
        try zapiszStan()
        try await zdeponuj(doKogo, koperta)
    }

    /// Serwery ICE na rozmowę; pusta lista przy błędzie — rozmowa ma wtedy
    /// zapasowy STUN, a nie zawieść w ogóle.
    func serweryIce() async -> [Api.SerwerIce] {
        (try? await api.iceServers(token: token)) ?? []
    }

    func sendText(_ groupId: Data, _ tekst: String, czas: Int64) async throws -> Data {
        let zapakowana = try client.sealText(groupId: groupId, text: tekst, sentAtMs: UInt64(max(czas, 0)))
        // Ratchet przesunął się przy szyfrowaniu — zapis nawet gdy wysyłka zawiedzie.
        try zapiszStan()

        try await rozeslij(groupId, zapakowana.koperta)
        // Echo dopiero po rozmówcach: idąc pierwsze, przy nieudanej wysyłce
        // pokazałoby wiadomość jako błędną tutaj, a jako wysłaną na laptopie.
        await echoDoSiebie(zapakowana.koperta)
        await uzupelnijTokeny()
        return zapakowana.messageId
    }

    /// Wysyła paczkę potwierdzeń do wszystkich uczestników i echo do siebie.
    ///
    /// **Chwili** wysyłki to nie ukrywa — o to dba wołający (`losoweOpoznienie`).
    func sendReceipt(_ groupId: Data, rodzaj: ReceiptKind, identyfikatory: [Data]) async throws {
        guard !identyfikatory.isEmpty else { return }
        let koperta = try client.sendReceipt(groupId: groupId, kind: rodzaj, messageIds: identyfikatory,
                                             sentAtMs: UInt64(terazMs()))
        try zapiszStan()

        for osoba in try uczestnicy(groupId) where osoba != konto.userId {
            // Ptaszek jest wygodą, nie treścią — jedna osoba nie przerywa reszty.
            try? await zdeponuj(osoba, koperta)
        }
        // Przeczytane na telefonie ma znaczyć przeczytane także na laptopie.
        await echoDoSiebie(koperta)
    }

    /// Rozsyła współdzieloną nazwę grupy i/lub własny nick (`nil` = bez zmian).
    func sendMetadata(_ groupId: Data, nazwaGrupy: String?, mojNick: String?) async throws {
        let koperta = try client.sendMetadata(groupId: groupId, groupName: nazwaGrupy, displayName: mojNick,
                                              sentAtMs: UInt64(terazMs()))
        try zapiszStan()
        for osoba in try uczestnicy(groupId) where osoba != konto.userId {
            try? await zdeponuj(osoba, koperta)
        }
        await echoDoSiebie(koperta)
    }

    // MARK: - Odbiór

    /// Otwiera kopertę i utrwala stan MLS — jedna, nieprzerywalna operacja aktora.
    private func przetworzKoperte(_ koperta: Data) throws -> IncomingEvent {
        let zdarzenie = try client.openEnvelope(bytes: koperta)
        try zapiszStan()
        return zdarzenie
    }

    /// Uruchamia odbiór ze skrzynki.
    ///
    /// Ramki idą przez JEDNĄ kolejkę, a nie każda we własnym zadaniu, bo commity
    /// MLS muszą zostać zastosowane w kolejności nadania — serwer wysyła je po
    /// kolei i ta kolejność musi przetrwać do `openEnvelope`.
    ///
    /// `naZdarzenie` zapisuje historię i dopiero gdy wróci, ramka jest
    /// potwierdzana: potwierdzenie przed zapisem gubi wiadomość przy awarii
    /// w złym momencie, bo serwer odda ją potem już tylko innym urządzeniom.
    func startReceiving(
        naZdarzenie: @escaping @Sendable (IncomingEvent) async throws -> Void,
        naStan: @escaping @Sendable (StanPolaczenia) -> Void
    ) async throws {
        // Ponowne uruchomienie porzucałoby poprzednie gniazdo bez zamknięcia:
        // wznawiałoby się dalej i przetwarzało koperty równolegle z nowym.
        await skrzynka?.zamknij()
        odbior?.cancel()

        let (strumien, kontynuacja) = AsyncStream<(Data, PolaczenieZeSkrzynka.Potwierdz)>.makeStream()

        odbior = Task { [weak self] in
            let licznik = LicznikProb()
            for await (ramka, potwierdz) in strumien {
                guard let self else { return }
                await obsluzRamke(ramka, licznik: licznik, przetworz: { koperta in
                    // Własne echo odsiewamy przed przetwarzaniem: MLS nie pozwala
                    // przetworzyć własnej wiadomości. Pominięcie jest sukcesem,
                    // więc ramka zostaje od razu potwierdzona.
                    if Echa.wspolne.czyWlasna(koperta) { return }
                    let zdarzenie = try await self.przetworzKoperte(koperta)
                    try await naZdarzenie(zdarzenie)
                }, potwierdz: potwierdz)
            }
        }

        let polaczenie = PolaczenieZeSkrzynka(
            adres: try api.zadanieSkrzynki(userId: konto.userId),
            token: { [weak self] in await self?.biezacyToken() ?? "" },
            naRamke: { ramka, potwierdz in kontynuacja.yield((ramka, potwierdz)) },
            naStan: naStan
        )
        skrzynka = polaczenie
        await polaczenie.polacz()
    }

    /// Zamyka odbiór — przy wylogowaniu.
    func zamknij() async {
        await skrzynka?.zamknij()
        skrzynka = nil
        odbior?.cancel()
        odbior = nil
    }
}
