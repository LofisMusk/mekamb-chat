import Foundation

/// Historia rozmów na urządzeniu.
///
/// # Czego to nie zmienia
///
/// Historia zostaje **wyłącznie tutaj**, zaszyfrowana kluczem skarbca. Serwer jej
/// nie ma i nigdy nie będzie miał — utrata wszystkich urządzeń nadal oznacza
/// utratę rozmów. To założenie z pierwszego dnia, nie niedopatrzenie.
///
/// # Format jest wspólny z webem i Androidem
///
/// Ten sam JSON co `web/src/lib/historia.ts` i `android/.../Historia.kt`, ta sama
/// wersja i te same czytane wersje. Historia wędruje między klientami (transfer
/// optyczny przy parowaniu, kopia zapasowa), a dwa klienty z tym samym numerem
/// i różnym kształtem już raz dały po przeniesieniu pustą historię. Zmiana
/// układu idzie po wszystkich stronach naraz — razem z numerem.

/// Ile wiadomości trzymamy na rozmowę — cały rekord jest szyfrowany przy każdym zapisie.
let limitWiadomosci = 500

/// Wersja formatu: 2 nazwa rozmówcy, 3 znacznik przeczytania, 4 załącznik,
/// 5 identyfikator i stan wysyłki, 6 ślad po rozmowie A/V.
let wersjaHistorii = 6

/// Wersje, które umiemy wczytać bezstratnie — różnią się wyłącznie polami
/// opcjonalnymi. Odrzucenie starszej byłoby skasowaniem historii użytkownika.
let czytaneWersjeHistorii: Set<Int> = [3, 4, 5, wersjaHistorii]

// MARK: - Model widoku

/// Załącznik: szyfrogram leży na serwerze, tutaj tylko klucz do niego.
struct Zalacznik: Equatable, Sendable {
    let blobId: String
    let klucz: Data
    let nonce: Data
    let mimeType: String
    let rozmiar: Int64
    let nazwaPliku: String?
}

/// Ślad po rozmowie A/V. Klient iOS ich jeszcze nie tworzy, ale je zachowuje.
struct ZapisRozmowyAV: Codable, Equatable, Sendable {
    var wideo: Bool = false
    var sekundy: Int64?
    var wychodzaca: Bool = false

    init(wideo: Bool = false, sekundy: Int64? = nil, wychodzaca: Bool = false) {
        self.wideo = wideo
        self.sekundy = sekundy
        self.wychodzaca = wychodzaca
    }

    init(from decoder: Decoder) throws {
        let c = try decoder.container(keyedBy: CodingKeys.self)
        wideo = try c.decodeIfPresent(Bool.self, forKey: .wideo) ?? false
        sekundy = try c.decodeIfPresent(Int64.self, forKey: .sekundy)
        wychodzaca = try c.decodeIfPresent(Bool.self, forKey: .wychodzaca) ?? false
    }
}

/// Wiadomość w postaci pokazywanej użytkownikowi.
struct Wiadomosc: Equatable, Sendable {
    /// Identyfikator z protokołu (16 bajtów). Pusty w zapisach sprzed wersji 5.
    var id: Data
    var autor: String
    var tresc: String
    var wlasna: Bool
    /// Chwila NADANIA zadeklarowana przez nadawcę — patrz `czasNadania` w modelu.
    var czas: Int64
    var zalacznik: Zalacznik? = nil
    var rozmowa: ZapisRozmowyAV? = nil
    /// Dokąd doszła własna wiadomość. Brak znaczy „wysłana".
    var stan: StanWiadomosci? = nil

    /// Klucz stabilny dla widoku — identyfikator, a dla starych zapisów treść i czas.
    var klucz: String { kluczWiadomosci(ZapisanaWiadomosc(self)) }
}

/// Rozmowa w postaci potrzebnej liście.
struct PozycjaListy: Equatable, Sendable, Identifiable {
    let groupId: Data
    let rozmowca: String
    let ostatnia: Wiadomosc?
    /// Ile wiadomości przyszło od ostatniego zajrzenia. Własne się nie liczą.
    let nieprzeczytane: Int

    var id: String { groupId.hex }
}

// MARK: - Zapis

struct ZapisanyZalacznik: Codable, Equatable, Sendable {
    let blobId: String
    /// Klucz i nonce jako listy liczb, bo tak zapisuje je web (`Array.from`).
    let key: [Int]
    let nonce: [Int]
    let mimeType: String
    let sizeBytes: Int64
    let fileName: String?
}

struct ZapisanaWiadomosc: Codable, Equatable, Sendable {
    var autor: String
    var tresc: String
    var wlasna: Bool
    var czas: Int64
    var zalacznik: ZapisanyZalacznik?
    var rozmowa: ZapisRozmowyAV?
    /// Identyfikator z protokołu, szesnastkowo; pusty w zapisach sprzed wersji 5.
    var id: String
    /// Surowy zapis stanu — zachowany znak w znak, żeby nie zgubić nieznanego.
    var stan: String?

    init(autor: String, tresc: String, wlasna: Bool, czas: Int64, zalacznik: ZapisanyZalacznik? = nil,
         rozmowa: ZapisRozmowyAV? = nil, id: String = "", stan: String? = nil) {
        self.autor = autor
        self.tresc = tresc
        self.wlasna = wlasna
        self.czas = czas
        self.zalacznik = zalacznik
        self.rozmowa = rozmowa
        self.id = id
        self.stan = stan
    }

    init(_ w: Wiadomosc) {
        self.init(
            autor: w.autor, tresc: w.tresc, wlasna: w.wlasna, czas: w.czas,
            zalacznik: w.zalacznik.map {
                ZapisanyZalacznik(blobId: $0.blobId, key: $0.klucz.map(Int.init), nonce: $0.nonce.map(Int.init),
                                  mimeType: $0.mimeType, sizeBytes: $0.rozmiar, fileName: $0.nazwaPliku)
            },
            rozmowa: w.rozmowa, id: w.id.hex, stan: w.stan?.zapis
        )
    }

    init(from decoder: Decoder) throws {
        let c = try decoder.container(keyedBy: CodingKeys.self)
        autor = try c.decode(String.self, forKey: .autor)
        tresc = try c.decodeIfPresent(String.self, forKey: .tresc) ?? ""
        wlasna = try c.decode(Bool.self, forKey: .wlasna)
        // Web zapisuje `Date.now()`, czyli liczbę całkowitą — ale JSON nie zna
        // typów, więc przyjmujemy też zapis z częścią ułamkową.
        if let calkowity = try? c.decode(Int64.self, forKey: .czas) {
            czas = calkowity
        } else {
            czas = Int64(try c.decode(Double.self, forKey: .czas))
        }
        zalacznik = try c.decodeIfPresent(ZapisanyZalacznik.self, forKey: .zalacznik)
        rozmowa = try c.decodeIfPresent(ZapisRozmowyAV.self, forKey: .rozmowa)
        id = try c.decodeIfPresent(String.self, forKey: .id) ?? ""
        stan = try c.decodeIfPresent(String.self, forKey: .stan)
    }

    var doModelu: Wiadomosc {
        Wiadomosc(
            id: Data(hex: id) ?? Data(), autor: autor, tresc: tresc, wlasna: wlasna, czas: czas,
            zalacznik: zalacznik.map {
                Zalacznik(blobId: $0.blobId, klucz: Data($0.key.map { UInt8(truncatingIfNeeded: $0) }),
                          nonce: Data($0.nonce.map { UInt8(truncatingIfNeeded: $0) }),
                          mimeType: $0.mimeType, rozmiar: $0.sizeBytes, nazwaPliku: $0.fileName)
            },
            rozmowa: rozmowa, stan: stan.flatMap(StanWiadomosci.init(zapis:))
        )
    }
}

struct ZapisanaRozmowa: Codable, Equatable, Sendable {
    var rozmowca: String
    var wiadomosci: [ZapisanaWiadomosc]
    /// Czas ostatniej wiadomości, którą użytkownik widział — czas, nie
    /// identyfikator, bo identyfikator traci znaczenie po wypadnięciu poza limit.
    var przeczytaneDo: Int64?

    init(rozmowca: String, wiadomosci: [ZapisanaWiadomosc] = [], przeczytaneDo: Int64? = nil) {
        self.rozmowca = rozmowca
        self.wiadomosci = wiadomosci
        self.przeczytaneDo = przeczytaneDo
    }

    init(from decoder: Decoder) throws {
        let c = try decoder.container(keyedBy: CodingKeys.self)
        rozmowca = try c.decodeIfPresent(String.self, forKey: .rozmowca) ?? ""
        wiadomosci = try c.decodeIfPresent([ZapisanaWiadomosc].self, forKey: .wiadomosci) ?? []
        przeczytaneDo = try c.decodeIfPresent(Int64.self, forKey: .przeczytaneDo)
    }
}

struct ZapisanaHistoria: Codable, Equatable, Sendable {
    var wersja: Int = wersjaHistorii
    /// Klucz to identyfikator rozmowy szesnastkowo, małymi literami.
    var rozmowy: [String: ZapisanaRozmowa] = [:]

    init(wersja: Int = wersjaHistorii, rozmowy: [String: ZapisanaRozmowa] = [:]) {
        self.wersja = wersja
        self.rozmowy = rozmowy
    }

    init(from decoder: Decoder) throws {
        let c = try decoder.container(keyedBy: CodingKeys.self)
        wersja = try c.decodeIfPresent(Int.self, forKey: .wersja) ?? wersjaHistorii
        rozmowy = try c.decodeIfPresent([String: ZapisanaRozmowa].self, forKey: .rozmowy) ?? [:]
    }

    /// Dekoduje zapis; `nil` przy nieczytelnym albo w nieznanym układzie.
    ///
    /// Historia z układu, którego nie znamy, jest odrzucana w całości: próba
    /// odgadnięcia dałaby rozmowy poprzestawiane w czasie — gorsze niż pusty
    /// ekran, bo wygląda na prawdziwe.
    static func zBajtow(_ dane: Data) -> ZapisanaHistoria? {
        guard let zapis = try? JSONDecoder().decode(ZapisanaHistoria.self, from: dane),
              czytaneWersjeHistorii.contains(zapis.wersja)
        else { return nil }
        var biezaca = zapis
        biezaca.wersja = wersjaHistorii
        return biezaca
    }

    func doBajtow() throws -> Data {
        let koder = JSONEncoder()
        koder.outputFormatting = [.sortedKeys]
        return try koder.encode(self)
    }
}

/// Klucz tożsamości wiadomości przy scalaniu i w widoku.
///
/// `id` z rdzenia jest tym samym po obu stronach rozmowy. Zapisy sprzed wersji 5
/// go nie mają — dla nich zostaje autor, czas i treść (ten sam klucz co w Kotlinie).
func kluczWiadomosci(_ w: ZapisanaWiadomosc) -> String {
    w.id.isEmpty ? "t:\(w.autor) \(w.czas) \(w.tresc)" : "id:\(w.id)"
}

/// Scala dwa zbiory wiadomości tej samej rozmowy — suma po kluczu, nie „merge".
///
/// Kolejność po `(czas, id)`: przy równych znacznikach rozstrzygnik musi dać
/// TEN SAM wynik po obu stronach. Ślady po rozmowach A/V z obcej strony są
/// pomijane — „nieodebrana" jest faktem o tamtym urządzeniu. Przycinamy PO
/// scaleniu: dwa ogony po 500 dają więcej niż 500, a cięcie każdego z osobna
/// wyrzucałoby to, czego drugie urządzenie nigdy nie widziało.
func scalWiadomosci(nasze: [ZapisanaWiadomosc], obce: [ZapisanaWiadomosc]) -> [ZapisanaWiadomosc] {
    var kolejnosc: [String] = []
    var poKluczu: [String: ZapisanaWiadomosc] = [:]

    for w in nasze {
        let klucz = kluczWiadomosci(w)
        if poKluczu[klucz] == nil { kolejnosc.append(klucz) }
        poKluczu[klucz] = w
    }

    for w in obce where w.rozmowa == nil {
        let klucz = kluczWiadomosci(w)
        if var juz = poKluczu[klucz] {
            juz.zalacznik = juz.zalacznik ?? w.zalacznik
            // Stan idzie tylko w górę.
            let a = juz.stan.flatMap(StanWiadomosci.init(zapis:))
            let b = w.stan.flatMap(StanWiadomosci.init(zapis:))
            if let a, let b { juz.stan = a.wyzszy(b).zapis } else if juz.stan == nil { juz.stan = w.stan }
            poKluczu[klucz] = juz
        } else {
            kolejnosc.append(klucz)
            poKluczu[klucz] = w
        }
    }

    let posortowane = kolejnosc.compactMap { poKluczu[$0] }.sorted {
        $0.czas != $1.czas ? $0.czas < $1.czas : $0.id < $1.id
    }
    return Array(posortowane.suffix(limitWiadomosci))
}

// MARK: - Magazyn

/// Historia w skarbcu.
///
/// Cała historia leży w JEDNYM zaszyfrowanym rekordzie, więc każda zmiana to
/// odczyt-zmiana-zapis. Dwie takie operacje naraz czytałyby ten sam stan, a ta,
/// która zapisze druga, cofnęłaby pierwszą — tak znikał znacznik odczytu
/// w webie i na Androidzie. Dlatego wszystko idzie pod jednym zamkiem.
final class Historia: @unchecked Sendable {
    private let skarbiec: Skarbiec
    private let zamek = NSRecursiveLock()

    init(skarbiec: Skarbiec) {
        self.skarbiec = skarbiec
    }

    static func klucz(_ groupId: Data) -> String { groupId.hex }

    private func wczytajWszystko() -> ZapisanaHistoria {
        guard let surowe = skarbiec.wczytajHistorie() else { return ZapisanaHistoria() }
        return ZapisanaHistoria.zBajtow(surowe) ?? ZapisanaHistoria()
    }

    private func zapiszWszystko(_ zapis: ZapisanaHistoria) throws {
        try skarbiec.zapiszHistorie(try zapis.doBajtow())
    }

    private func zmien<T>(_ zmiana: (inout ZapisanaHistoria) throws -> T) throws -> T {
        zamek.lock()
        defer { zamek.unlock() }
        var zapis = wczytajWszystko()
        let wynik = try zmiana(&zapis)
        try zapiszWszystko(zapis)
        return wynik
    }

    /// Wiadomości jednej rozmowy.
    func wczytaj(_ groupId: Data) -> [Wiadomosc] {
        zamek.lock()
        defer { zamek.unlock() }
        return wczytajWszystko().rozmowy[Self.klucz(groupId)]?.wiadomosci.map(\.doModelu) ?? []
    }

    /// Z kim była ta rozmowa.
    func rozmowca(_ groupId: Data) -> String? {
        zamek.lock()
        defer { zamek.unlock() }
        return wczytajWszystko().rozmowy[Self.klucz(groupId)]?.rozmowca
    }

    /// Zakłada pusty wiersz rozmowy, jeśli go nie ma — Welcome nie niesie wiadomości.
    func zapewnij(_ groupId: Data, rozmowca: String) throws {
        try zmien { zapis in
            let klucz = Self.klucz(groupId)
            if zapis.rozmowy[klucz] == nil {
                zapis.rozmowy[klucz] = ZapisanaRozmowa(rozmowca: rozmowca)
            }
        }
    }

    /// Ustawia nazwę rozmówcy, nie ruszając wiadomości.
    func ustawRozmowce(_ groupId: Data, rozmowca: String) throws {
        try zmien { zapis in
            let klucz = Self.klucz(groupId)
            zapis.rozmowy[klucz, default: ZapisanaRozmowa(rozmowca: rozmowca)].rozmowca = rozmowca
        }
    }

    /// Dopisuje wiadomość — atomowo i z odsiewem powtórek po identyfikatorze
    /// (ta sama koperta potrafi dojść dwa razy przy zerwanym połączeniu).
    ///
    /// `true`, gdy wiadomość faktycznie doszła.
    @discardableResult
    func dopisz(_ groupId: Data, rozmowca: String, _ wiadomosc: Wiadomosc) throws -> Bool {
        try zmien { zapis in
            let klucz = Self.klucz(groupId)
            var rozmowa = zapis.rozmowy[klucz] ?? ZapisanaRozmowa(rozmowca: rozmowca)
            let nowa = ZapisanaWiadomosc(wiadomosc)
            if !nowa.id.isEmpty, rozmowa.wiadomosci.contains(where: { $0.id == nowa.id }) { return false }
            if rozmowa.rozmowca.isEmpty { rozmowa.rozmowca = rozmowca }
            rozmowa.wiadomosci.append(nowa)
            // Wiadomość ze skrzynki potrafi przyjść po nowszej (zaległości po
            // ponownym połączeniu) — wątek układamy po chwili nadania.
            rozmowa.wiadomosci.sort { $0.czas != $1.czas ? $0.czas < $1.czas : $0.id < $1.id }
            rozmowa.wiadomosci = Array(rozmowa.wiadomosci.suffix(limitWiadomosci))
            zapis.rozmowy[klucz] = rozmowa
            return true
        }
    }

    /// Podnosi stan własnych wiadomości o podanych identyfikatorach.
    ///
    /// `true`, gdy cokolwiek się zmieniło. Stan nigdy nie spada.
    @discardableResult
    func nanieStan(_ groupId: Data, identyfikatory: [Data], nowy: StanWiadomosci) throws -> Bool {
        let szukane = Set(identyfikatory.map(\.hex))
        return try zmien { zapis in
            let klucz = Self.klucz(groupId)
            guard var rozmowa = zapis.rozmowy[klucz] else { return false }
            var zmieniono = false
            for i in rozmowa.wiadomosci.indices where rozmowa.wiadomosci[i].wlasna && szukane.contains(rozmowa.wiadomosci[i].id) {
                let byl = rozmowa.wiadomosci[i].stan.flatMap(StanWiadomosci.init(zapis:)) ?? .wyslane
                let bedzie = byl.wyzszy(nowy)
                if bedzie != byl || rozmowa.wiadomosci[i].stan == nil {
                    rozmowa.wiadomosci[i].stan = bedzie.zapis
                    zmieniono = true
                }
            }
            zapis.rozmowy[klucz] = rozmowa
            return zmieniono
        }
    }

    /// Oznacza rozmowę jako przeczytaną do podanej chwili. Znacznik nie cofa się.
    func oznaczPrzeczytane(_ groupId: Data, doChwili: Int64) throws {
        try zmien { zapis in
            let klucz = Self.klucz(groupId)
            guard var rozmowa = zapis.rozmowy[klucz], (rozmowa.przeczytaneDo ?? 0) < doChwili else { return }
            rozmowa.przeczytaneDo = doChwili
            zapis.rozmowy[klucz] = rozmowa
        }
    }

    /// Usuwa rozmowę z TEGO urządzenia. Grupa MLS i inne urządzenia zostają.
    func usun(_ groupId: Data) throws {
        try zmien { $0.rozmowy[Self.klucz(groupId)] = nil }
    }

    /// Wciąga historię z innego klienta — odpowiednik `scal` w `Historia.kt`.
    ///
    /// `nil`, gdy zrzut jest nieczytelny — „nic nie doszło" i „nie dało się
    /// odczytać" to dla użytkownika różne komunikaty.
    func scal(_ surowe: Data) throws -> (rozmow: Int, wiadomosci: Int)? {
        guard let obca = ZapisanaHistoria.zBajtow(surowe) else { return nil }
        return try zmien { zapis in
            var rozmow = 0
            var wiadomosci = 0
            for (klucz, przychodzaca) in obca.rozmowy {
                let nasza = zapis.rozmowy[klucz]
                let przed = nasza?.wiadomosci.count ?? 0
                let razem = scalWiadomosci(nasze: nasza?.wiadomosci ?? [], obce: przychodzaca.wiadomosci)
                if nasza == nil { rozmow += 1 }
                wiadomosci += max(razem.count - przed, 0)
                let przeczytane = max(nasza?.przeczytaneDo ?? 0, przychodzaca.przeczytaneDo ?? 0)
                zapis.rozmowy[klucz] = ZapisanaRozmowa(
                    rozmowca: (nasza?.rozmowca).flatMap { $0.isEmpty ? nil : $0 } ?? przychodzaca.rozmowca,
                    wiadomosci: razem,
                    przeczytaneDo: przeczytane > 0 ? przeczytane : nil
                )
            }
            return (rozmow, wiadomosci)
        }
    }

    /// Wszystkie rozmowy, od najświeższej — lista ma pokazywać to, do czego się wraca.
    func lista() -> [PozycjaListy] {
        zamek.lock()
        defer { zamek.unlock() }
        return wczytajWszystko().rozmowy.compactMap { klucz, rozmowa -> PozycjaListy? in
            guard let groupId = Data(hex: klucz) else { return nil }
            let doChwili = rozmowa.przeczytaneDo ?? 0
            return PozycjaListy(
                groupId: groupId,
                rozmowca: rozmowa.rozmowca,
                ostatnia: rozmowa.wiadomosci.last?.doModelu,
                nieprzeczytane: rozmowa.wiadomosci.filter { !$0.wlasna && $0.czas > doChwili }.count
            )
        }
        .sorted { ($0.ostatnia?.czas ?? 0) > ($1.ostatnia?.czas ?? 0) }
    }
}
