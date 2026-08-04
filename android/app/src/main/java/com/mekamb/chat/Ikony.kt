package com.mekamb.chat

import androidx.compose.ui.graphics.Color
import androidx.compose.ui.graphics.SolidColor
import androidx.compose.ui.graphics.StrokeCap
import androidx.compose.ui.graphics.StrokeJoin
import androidx.compose.ui.graphics.vector.ImageVector
import androidx.compose.ui.graphics.vector.PathParser
import androidx.compose.ui.unit.dp

/**
 * Ikony rysowane na miejscu.
 *
 * # Dlaczego nie biblioteka
 *
 * Projekt zakłada Phosphor, którego na Androida nie ma bez dołożenia pliku
 * z krojem. Zestaw Material Icons też nie jest w zależnościach, a wariant
 * `extended` waży kilka megabajtów — po tym, jak APK zeszło z 9,1 MB do 5,4,
 * dokładanie ich dla kilkunastu piktogramów byłoby cofnięciem tej pracy.
 *
 * Potrzebnych ikon jest kilkanaście i wszystkie są proste, więc są tu wprost.
 * Rysowane konturem o stałej grubości 1,8 — jak w Phosphorze w wariancie
 * `regular` — żeby siedziały obok tekstu bez dominowania.
 *
 * # Czego tu nie ma
 *
 * Ikon ozdobnych. Każda z poniższych coś znaczy: kierunek powrotu, gałąź
 * nawigacji albo drogę, którą idzie wiadomość. Piktogram bez znaczenia to
 * szum, którego ten system unika.
 */
private const val GRUBOSC = 1.8f

private fun ikona(nazwa: String, sciezka: String): ImageVector =
    ImageVector.Builder(
        name = nazwa,
        defaultWidth = 24.dp,
        defaultHeight = 24.dp,
        viewportWidth = 24f,
        viewportHeight = 24f,
    ).apply {
        // `addPath`, a nie `path {}`: ścieżki są tu zapisane jako napisy w
        // notacji SVG, więc trafiają gotowe, bez przepisywania na wywołania.
        addPath(
            pathData = PathParser().parsePathString(sciezka).toNodes(),
            stroke = SolidColor(Color.Black),
            strokeLineWidth = GRUBOSC,
            strokeLineCap = StrokeCap.Round,
            strokeLineJoin = StrokeJoin.Round,
        )
    }.build()

object Ikony {
    /** Powrót. */
    val Wstecz = ikona("wstecz", "M15 5 L8 12 L15 19")

    /** Tarcza — znak firmowy i szyfrowanie. */
    val Tarcza = ikona(
        "tarcza",
        "M12 3 L20 6 V12 C20 16.5 16.5 19.8 12 21 C7.5 19.8 4 16.5 4 12 V6 Z M9 12 L11 14 L15.5 9.5",
    )

    /** Klucz — materiał kryptograficzny zostający na urządzeniu. */
    val Klucz = ikona(
        "klucz",
        "M14.5 5.5 A4 4 0 1 1 11 12.2 L10 13.2 H8 V15.2 H6 V17.2 H3.5 V14.7 L10 8.2 A4 4 0 0 1 14.5 5.5 Z",
    )

    /** Rozmowy — gałąź nawigacji. */
    val Rozmowy = ikona("rozmowy", "M4 6 H20 V16 H10 L5.5 19.5 V16 H4 Z")

    /** Kontakty — gałąź nawigacji. */
    val Kontakty = ikona(
        "kontakty",
        "M6 4 H19 V20 H6 Z M6 8 H3.5 M6 12 H3.5 M6 16 H3.5 " +
            "M12.5 11.5 A2 2 0 1 0 12.5 7.5 A2 2 0 1 0 12.5 11.5 Z M9 16.5 C9 14.5 10.5 13.5 12.5 13.5 C14.5 13.5 16 14.5 16 16.5",
    )

    /** Konto — gałąź nawigacji. */
    val Konto = ikona(
        "konto",
        "M12 3 A9 9 0 1 0 12 21 A9 9 0 1 0 12 3 Z " +
            "M12 12 A3 3 0 1 0 12 6 A3 3 0 1 0 12 12 Z M6.5 18.5 C7.5 15.5 9.5 14.5 12 14.5 C14.5 14.5 16.5 15.5 17.5 18.5",
    )

    /**
     * Droga wprost do urządzenia.
     *
     * Ma znaczenie, nie jest ozdobą: gdy widnieje przy rozmowie, rozmówca zna
     * Twój adres IP.
     */
    val Bezposrednio = ikona("bezposrednio", "M13 3 L5 13 H11 L10 21 L19 10 H12.5 Z")

    /** Droga przez skrzynkę na serwerze. */
    val PrzezSerwer = ikona(
        "przezSerwer",
        "M7.5 18.5 A4.5 4.5 0 0 1 7.5 9.5 A6 6 0 0 1 18.5 10.2 A4.2 4.2 0 0 1 17.5 18.5 Z",
    )

    /** Brak połączenia. */
    val BrakSieci = ikona("brakSieci", "M4 4 L20 20 M7.5 18.5 A4.5 4.5 0 0 1 7.5 9.5 M12 6 A6 6 0 0 1 18.5 10.2")

    /** Kod QR — przeniesienie konta i sekret TOTP. */
    val KodQr = ikona(
        "kodQr",
        "M4 4 H9 V9 H4 Z M15 4 H20 V9 H15 Z M4 15 H9 V20 H4 Z " +
            "M15 15 H17 M19 15 H20 M15 17 V20 M17 19 H20",
    )

    /** Aparat — skanowanie kodu. */
    val Aparat = ikona(
        "aparat",
        "M3.5 7.5 H7 L8.5 5.5 H15.5 L17 7.5 H20.5 V18.5 H3.5 Z M12 16 A3.5 3.5 0 1 0 12 9 A3.5 3.5 0 1 0 12 16 Z",
    )

    /** Załącznik. */
    val Spinacz = ikona(
        "spinacz",
        "M17 8.5 L10 15.5 A2.5 2.5 0 0 0 13.5 19 L20 12.5 A5 5 0 0 0 13 5.5 L6.5 12 A7.5 7.5 0 0 0 17 22.5",
    )

    /** Rozmowa głosowa. */
    val Sluchawka = ikona(
        "sluchawka",
        "M6 3.5 L9 4.5 L10 8.5 L8 10 C9 12.5 11.5 15 14 16 L15.5 14 L19.5 15 L20.5 18 " +
            "C20.5 19.5 19 20.5 17.5 20.5 C10 20.5 3.5 14 3.5 6.5 C3.5 5 4.5 3.5 6 3.5 Z",
    )

    /** Wideo. */
    val Kamera = ikona("kamera", "M3.5 7 H14 V17 H3.5 Z M14 11 L20.5 7.5 V16.5 L14 13 Z")

    /** Dodanie osoby do rozmowy. */
    val Dodaj = ikona("dodaj", "M12 5 V19 M5 12 H19")

    /** Kod bezpieczeństwa — odcisk. */
    val Odcisk = ikona(
        "odcisk",
        "M12 4 A8 8 0 0 0 4 12 M12 4 A8 8 0 0 1 20 12 " +
            "M7.5 12 A4.5 4.5 0 0 1 16.5 12 V15 M12 12 V18 M7.5 15 V17.5",
    )

    /** Powiadomienia. */
    val Dzwonek = ikona(
        "dzwonek",
        "M6 17 V11 A6 6 0 0 1 18 11 V17 H19.5 H4.5 Z M10 20 H14",
    )
}
