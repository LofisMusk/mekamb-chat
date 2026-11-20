import Foundation

/// Rozstrzyganie, która rozmowa jest „tą z tą osobą".
///
/// # Czemu to musiało powstać
///
/// Rozpoczęcie rozmowy zawsze zakładało nową grupę MLS, więc wpisanie tej samej
/// nazwy drugi raz dawało drugą rozmowę z tą samą osobą — lista puchła od
/// duplikatów, a historia rozjeżdżała się między nimi.
///
/// # Reguła
///
/// Rozmowa jest tą samą rozmową, gdy jej **skład** to dokładnie my i ten
/// rozmówca. Skład z drzewa MLS, nie z zapisanej nazwy: nazwa jest etykietą,
/// skład jest faktem. Grupa trzyosobowa nazwana imieniem jednej osoby nie jest
/// DM-em. Ta sama reguła co `Rozmowy.kt` i `web/src/lib/rozmowy.ts`.
enum Rozmowy {
    /// Nazwa rozmowy — kto w niej jest poza nami. Skład zna każdy sposób
    /// powstania rozmowy, bo grupa nie istnieje bez składu.
    static func nazwa(czlonkowie: [String], ja: String) -> String {
        var widziani = Set<String>()
        return czlonkowie
            .filter { $0 != ja && widziani.insert($0).inserted }
            .joined(separator: ", ")
    }

    /// Istniejąca rozmowa jeden na jeden z podaną osobą.
    ///
    /// Błąd przy jednej grupie (brak stanu MLS na świeżo sparowanym urządzeniu)
    /// nie może przerwać szukania — ta grupa po prostu nie pasuje.
    static func znajdz1na1<T>(
        _ rozmowy: [T],
        groupId: (T) -> Data,
        czlonkowie: (Data) throws -> [String],
        ja: String,
        rozmowca: String
    ) -> T? {
        guard rozmowca != ja else { return nil }
        return rozmowy.first { rozmowa in
            guard let sklad = try? Set(czlonkowie(groupId(rozmowa))) else { return false }
            return sklad.count == 2 && sklad.contains(ja) && sklad.contains(rozmowca)
        }
    }
}
