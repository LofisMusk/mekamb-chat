import Foundation

/// Konfiguracja wybierana przy budowaniu.
///
/// # Dlaczego adres serwera jest w Info.plist, a nie w kodzie
///
/// Bo zmienia się między buildami, a nie między wersjami kodu: Debug mówi do
/// `wrangler dev` na localhost (symulator widzi sieć hosta), wydanie — do
/// serwera podanego w workflow. Android robi to samo przez `-PapiUrl`
/// i `BuildConfig.API_URL`, web przez `VITE_API_URL`. Tu ustawienie builda
/// `MEKAMB_ADRES_API` trafia do Info.plist pod kluczem `MekambAdresApi`.
enum Konfiguracja {
    /// Adres backendu bez końcowego ukośnika.
    static let adresApi: String = {
        let zPlisty = Bundle.main.object(forInfoDictionaryKey: "MekambAdresApi") as? String
        let adres = (zPlisty?.isEmpty == false ? zPlisty : nil) ?? "http://localhost:8787"
        return adres.hasSuffix("/") ? String(adres.dropLast()) : adres
    }()
}
