package com.mekamb.chat

import androidx.compose.foundation.isSystemInDarkTheme
import androidx.compose.foundation.shape.RoundedCornerShape
import androidx.compose.material3.MaterialTheme
import androidx.compose.material3.Shapes
import androidx.compose.material3.Typography
import androidx.compose.material3.darkColorScheme
import androidx.compose.runtime.Composable
import androidx.compose.ui.graphics.Color
import androidx.compose.ui.text.TextStyle
import androidx.compose.ui.text.font.FontWeight
import androidx.compose.ui.unit.dp
import androidx.compose.ui.unit.sp

/**
 * Nocturne — system wizualny klienta.
 *
 * # Skąd te wartości
 *
 * Z tokenów projektu „Mekamb Android UI Design", nie z oka. Każda liczba ma
 * tam swój odpowiednik; zmiana projektu ma tu być przepisaniem tokenów, a nie
 * dobieraniem odcieni od nowa.
 *
 * # Charakter
 *
 * Ciemne, prawie neutralne tło i **jeden** akcent używany jako linia, nie jako
 * wypełnienie. Kontrast bierze się z rampy tonalnej, nie z nasycenia. Główne
 * akcje są obrysowane, nie zalane kolorem — to najbardziej widoczna różnica
 * wobec domyślnego Material 3, gdzie przycisk główny jest pełną plamą.
 *
 * Skala odstępów ma gęstość 0,70×, więc jest ciasna celowo.
 */

// --- Rampa neutralna ---------------------------------------------------------
val Neutral100 = Color(0xFFF3F5FE)
val Neutral200 = Color(0xFFE4E7F5)
val Neutral300 = Color(0xFFCFD3E5)
val Neutral400 = Color(0xFFB2B6CA)
val Neutral500 = Color(0xFF9397AB)
val Neutral600 = Color(0xFF75798C)
val Neutral700 = Color(0xFF595D6C)
val Neutral800 = Color(0xFF3F424D)
val Neutral900 = Color(0xFF292B31)

// --- Rampa akcentu -----------------------------------------------------------
val Accent100 = Color(0xFFF5F4FF)
val Accent200 = Color(0xFFE7E5FE)
val Accent300 = Color(0xFFD2CEFD)
val Accent400 = Color(0xFFB5ABFC)
val Accent500 = Color(0xFF968AE0)
val Accent600 = Color(0xFF796CBF)
val Accent700 = Color(0xFF5D5294)
val Accent800 = Color(0xFF423A6A)
val Accent900 = Color(0xFF2B2741)

// --- Role --------------------------------------------------------------------
val Tlo = Color(0xFF161826)
val Powierzchnia = Color(0xFF232532)
val Tekst = Color(0xFFE9E9ED)
val Akcent = Color(0xFF9184D9)

/**
 * Linia rozdzielająca — 16% koloru tekstu.
 *
 * Wyliczona raz, bo Compose nie ma odpowiednika `color-mix()`, a wpisanie
 * gotowego odcienia rozjechałoby się przy zmianie koloru tekstu.
 */
val Linia = Tekst.copy(alpha = 0.16f)

/**
 * Zasłona pod arkuszem wysuwanym od dołu.
 *
 * Przyciemnia to, co zostaje na ekranie, zamiast to zakrywać: arkusz jest
 * kolejnym krokiem w tej samej rozmowie, a nie osobnym miejscem.
 */
val Zaslona = Neutral900.copy(alpha = 0.62f)

/** Stan, z którym trzeba coś zrobić — nie chwilowy, nie ozdobny. */
val Alarm = Color(0xFFE5484D)

/**
 * Kolor tekstu przygaszonego.
 *
 * Osobna stała, bo przygaszanie przez przezroczystość w kilkunastu miejscach
 * z różnymi wartościami daje interfejs, w którym „drugorzędny" znaczy co
 * innego na każdym ekranie.
 */
val TekstPrzygaszony = Tekst.copy(alpha = 0.62f)

private val SchematCiemny = darkColorScheme(
    primary = Akcent,
    onPrimary = Accent900,
    primaryContainer = Accent800,
    onPrimaryContainer = Accent200,

    secondary = Accent400,
    onSecondary = Accent900,

    background = Tlo,
    onBackground = Tekst,
    surface = Powierzchnia,
    onSurface = Tekst,
    surfaceVariant = Neutral900,
    onSurfaceVariant = Neutral400,

    outline = Neutral700,
    outlineVariant = Neutral800,

    // Błąd w rampie systemu: dość jasny, żeby czytać go na ciemnym tle.
    // Domyślny Material daje tu odcień, który na tym tle ledwo widać.
    error = Color(0xFFF2B8B5),
    onError = Color(0xFF601410),
    errorContainer = Color(0xFF8C1D18),
    onErrorContainer = Color(0xFFF9DEDC),
)

/**
 * Skala typograficzna.
 *
 * Inter jest tu deklarowany przez `FontFamily.Default`: Roboto na Androidzie
 * ma bardzo zbliżone proporcje, a dołożenie pliku z krojem podniosłoby APK
 * o kilkaset kilobajtów — akurat po tym, jak zeszliśmy z 9,1 MB do 5,4.
 * Kroju nie ustawiamy więc wcale, zamiast udawać, że jest.
 *
 * Nagłówki mają wagę 500 i nie wolno ich pogrubiać wyżej — hierarchię niesie
 * tu rozmiar i odstęp, nie grubość.
 */
private val Typografia = Typography(
    displaySmall = TextStyle(fontSize = 34.sp, lineHeight = 40.sp, fontWeight = FontWeight.Medium, letterSpacing = (-0.5).sp),
    headlineMedium = TextStyle(fontSize = 26.sp, lineHeight = 32.sp, fontWeight = FontWeight.Medium, letterSpacing = (-0.3).sp),
    headlineSmall = TextStyle(fontSize = 21.sp, lineHeight = 28.sp, fontWeight = FontWeight.Medium),
    titleLarge = TextStyle(fontSize = 18.sp, lineHeight = 24.sp, fontWeight = FontWeight.Medium),
    titleMedium = TextStyle(fontSize = 16.sp, lineHeight = 22.sp, fontWeight = FontWeight.Medium),
    bodyLarge = TextStyle(fontSize = 16.sp, lineHeight = 24.sp),
    bodyMedium = TextStyle(fontSize = 14.sp, lineHeight = 20.sp),
    bodySmall = TextStyle(fontSize = 13.sp, lineHeight = 18.sp),
    labelLarge = TextStyle(fontSize = 14.sp, lineHeight = 18.sp, fontWeight = FontWeight.Medium),
    labelMedium = TextStyle(fontSize = 12.sp, lineHeight = 16.sp, fontWeight = FontWeight.Medium),
    labelSmall = TextStyle(fontSize = 11.sp, lineHeight = 15.sp, letterSpacing = 0.4.sp),
)

/** Promienie z tokenów: 4, 8 i 14. */
private val Ksztalty = Shapes(
    extraSmall = RoundedCornerShape(4.dp),
    small = RoundedCornerShape(4.dp),
    medium = RoundedCornerShape(8.dp),
    large = RoundedCornerShape(14.dp),
    extraLarge = RoundedCornerShape(14.dp),
)

/**
 * Skala odstępów, gęstość 0,70×.
 *
 * Wartości z tokenów zaokrąglone do pełnych dp — ułamkowe `dp` w Compose są
 * dopuszczalne, ale dają niespójne krawędzie przy różnych gęstościach ekranu.
 */
object Odstep {
    val xs = 3.dp
    val s = 6.dp
    val m = 8.dp
    val l = 11.dp
    val xl = 17.dp
    val xxl = 22.dp

    /** Margines treści od krawędzi ekranu. */
    val ekran = 17.dp
}

/**
 * Minimalne cele dotyku z projektu — powyżej minimum Androida (48 dp).
 */
object Dotyk {
    val wierszRozmowy = 64.dp
    val kontrolka = 48.dp
    val ikonaWPasku = 44.dp
}

/**
 * Motyw aplikacji.
 *
 * Zawsze ciemny: system jest ciemny z założenia, a wariant jasny nie istnieje
 * w projekcie. `isSystemInDarkTheme()` jest tu odczytany tylko po to, żeby
 * jawnie odnotować tę decyzję zamiast zostawiać wrażenie przeoczenia.
 */
@Composable
fun MotywNocturne(content: @Composable () -> Unit) {
    @Suppress("UNUSED_EXPRESSION")
    isSystemInDarkTheme()

    MaterialTheme(
        colorScheme = SchematCiemny,
        typography = Typografia,
        shapes = Ksztalty,
        content = content,
    )
}
