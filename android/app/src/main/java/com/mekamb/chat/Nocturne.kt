package com.mekamb.chat

import androidx.compose.foundation.isSystemInDarkTheme
import androidx.compose.foundation.shape.RoundedCornerShape
import androidx.compose.material3.MaterialTheme
import androidx.compose.material3.Shapes
import androidx.compose.material3.Typography
import androidx.compose.material3.darkColorScheme
import androidx.compose.material3.lightColorScheme
import androidx.compose.runtime.Composable
import androidx.compose.runtime.CompositionLocalProvider
import androidx.compose.runtime.Immutable
import androidx.compose.runtime.ReadOnlyComposable
import androidx.compose.runtime.staticCompositionLocalOf
import androidx.compose.ui.graphics.Color
import androidx.compose.ui.text.TextStyle
import androidx.compose.ui.text.font.FontWeight
import androidx.compose.ui.unit.dp
import androidx.compose.ui.unit.sp

/**
 * Nocturne — system wizualny klienta.
 *
 * # Charakter
 *
 * Prawie neutralne tło i **jeden** akcent używany jako linia, nie jako
 * wypełnienie. Kontrast bierze się z rampy tonalnej, nie z nasycenia. Główne
 * akcje są obrysowane, nie zalane kolorem — to najbardziej widoczna różnica
 * wobec domyślnego Material 3, gdzie przycisk główny jest pełną plamą.
 *
 * Skala odstępów ma gęstość 0,70×, więc jest ciasna celowo.
 *
 * # Dlaczego kolory są rolami, a nie stopniami rampy
 *
 * Wcześniej ekrany sięgały wprost po `Neutral600` czy `Accent800`. Przy jednym
 * motywie to działało. Przy dwóch przestaje mieć sens, bo „600" w ciemnym jest
 * jaśniejsze od tła, a w jasnym musi być ciemniejsze — każde takie użycie
 * wymagałoby warunku, a warunek pominięty w jednym miejscu daje ciemną plamę
 * na jasnym ekranie.
 *
 * Dlatego jest [KoloryNocturne]: zestaw ról („tekst drugorzędny", „linia",
 * „dymek własnej wiadomości"), pod które motyw podstawia odcienie. Ekran pisze
 * `Nocturne.kolory.tekstDrugi` i działa w obu motywach bez ani jednego `if`.
 *
 * Te same role ma web (`web/src/styles.css`) i te same wartości. Zmiana
 * projektu jest przepisaniem tokenów po obu stronach, a nie dobieraniem
 * odcieni od nowa.
 */

/** Role kolorystyczne. Jedna instancja na motyw — patrz [CIEMNE] i [JASNE]. */
@Immutable
data class KoloryNocturne(
    /** Tło aplikacji. */
    val tlo: Color,
    /** Powierzchnia karty i dymka rozmówcy. */
    val karta: Color,
    /** Karta pod kursorem albo pod palcem. */
    val kartaPodniesiona: Color,
    /** Wgłębienie — kod bezpieczeństwa, sekret TOTP, pole tylko do odczytu. */
    val wglebienie: Color,

    val tekst: Color,
    /** Drugi plan: podpisy, metadane, opisy pod etykietą. */
    val tekstDrugi: Color,
    /** Trzeci plan: podpowiedzi w polach, godziny, jednostki. */
    val tekstTrzeci: Color,

    /** Włos rozdzielający. */
    val linia: Color,
    /** Obrys kontrolki — mocniejszy, bo musi być widoczny sam z siebie. */
    val liniaMocna: Color,

    /** Akcent jako linia. Nigdy jako wypełnienie pod akcją. */
    val akcent: Color,
    /** Akcent jako kolor tekstu — osobny, bo linia i tekst potrzebują innego kontrastu. */
    val akcentTekst: Color,
    /** Delikatna poświata akcentu: tło ostrzeżenia, awatar, trwająca rozmowa. */
    val akcentTlo: Color,

    val babelWlasny: Color,
    val babelWlasnyTekst: Color,
    /** Godzina i stan wysyłki we własnym dymku. */
    val babelWlasnyMeta: Color,

    val alarm: Color,
    val alarmTekst: Color,
    val alarmTlo: Color,

    /**
     * Zasłona pod arkuszem wysuwanym od dołu.
     *
     * Przyciemnia to, co zostaje na ekranie, zamiast to zakrywać: arkusz jest
     * kolejnym krokiem w tej samej rozmowie, a nie osobnym miejscem.
     */
    val zaslona: Color,

    /** Czy to motyw jasny. Potrzebne dla ikon paska systemowego, nie do malowania. */
    val jasny: Boolean,
)

/**
 * Motyw ciemny — domyślny.
 *
 * Wartości identyczne z `:root` w `web/src/styles.css`.
 */
val CIEMNE = KoloryNocturne(
    tlo = Color(0xFF161826),
    karta = Color(0xFF232532),
    kartaPodniesiona = Color(0xFF2A2C3B),
    wglebienie = Color(0xFF1C1E2B),
    tekst = Color(0xFFE9E9ED),
    tekstDrugi = Color(0xFF9397AB),
    tekstTrzeci = Color(0xFF75798C),
    linia = Color(0xFFE9E9ED).copy(alpha = 0.14f),
    liniaMocna = Color(0xFFE9E9ED).copy(alpha = 0.26f),
    akcent = Color(0xFF9184D9),
    akcentTekst = Color(0xFFD2CEFD),
    akcentTlo = Color(0xFF2B2741),
    babelWlasny = Color(0xFF423A6A),
    babelWlasnyTekst = Color(0xFFF1F0FF),
    babelWlasnyMeta = Color(0xFFB5ABFC),
    alarm = Color(0xFFF2B8B5),
    alarmTekst = Color(0xFFF9DEDC),
    alarmTlo = Color(0xFF4A2330),
    zaslona = Color(0xFF000000).copy(alpha = 0.62f),
    jasny = false,
)

/**
 * Motyw jasny.
 *
 * Nie jest odwróceniem ciemnego. Akcent musi być **ciemniejszy** niż w motywie
 * ciemnym, bo linia w kolorze `#9184D9` na białym tle ma kontrast poniżej 3:1
 * i przestaje być widoczna jako obrys akcji — czyli znika jedyny sygnał, po
 * którym w tym systemie poznaje się akcję główną.
 */
val JASNE = KoloryNocturne(
    tlo = Color(0xFFF1F1F7),
    karta = Color(0xFFFFFFFF),
    kartaPodniesiona = Color(0xFFF6F6FB),
    wglebienie = Color(0xFFECECF4),
    tekst = Color(0xFF1A1B26),
    tekstDrugi = Color(0xFF5C5F73),
    tekstTrzeci = Color(0xFF7E8296),
    linia = Color(0xFF1A1B26).copy(alpha = 0.13f),
    liniaMocna = Color(0xFF1A1B26).copy(alpha = 0.26f),
    akcent = Color(0xFF5B4FA8),
    akcentTekst = Color(0xFF463D86),
    akcentTlo = Color(0xFFEDEBFA),
    babelWlasny = Color(0xFFE7E4FB),
    babelWlasnyTekst = Color(0xFF241F52),
    babelWlasnyMeta = Color(0xFF5B4FA8),
    alarm = Color(0xFFB3261E),
    alarmTekst = Color(0xFF601410),
    alarmTlo = Color(0xFFFDECEA),
    zaslona = Color(0xFF1A1B26).copy(alpha = 0.38f),
    jasny = true,
)

/**
 * Kolory bieżącego motywu.
 *
 * `staticCompositionLocalOf`, a nie `compositionLocalOf`: motyw zmienia się
 * kilka razy w życiu aplikacji, więc śledzenie odczytów byłoby płaceniem za
 * coś, z czego nie korzystamy. Zmiana przerysowuje całą gałąź — i o to chodzi.
 */
val LokalneKolory = staticCompositionLocalOf { CIEMNE }

/** Skrót do ról kolorystycznych: `Nocturne.kolory.tekstDrugi`. */
object Nocturne {
    val kolory: KoloryNocturne
        @Composable @ReadOnlyComposable get() = LokalneKolory.current
}

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

/** Minimalne cele dotyku z projektu — powyżej minimum Androida (48 dp). */
object Dotyk {
    val wierszRozmowy = 64.dp
    val kontrolka = 48.dp
    val ikonaWPasku = 44.dp
}

/**
 * Schemat Material 3 wyprowadzony z ról.
 *
 * Material jest tu tylko podkładem: bierze go garść komponentów, których nie
 * przepisujemy (pole tekstowe, wskaźnik postępu). Wszystko, co rysujemy sami,
 * czyta `Nocturne.kolory` — dzięki temu nie ma dwóch źródeł prawdy o tym, co
 * znaczy „powierzchnia".
 */
private fun schemat(k: KoloryNocturne) = if (k.jasny) {
    lightColorScheme(
        primary = k.akcent,
        onPrimary = Color.White,
        primaryContainer = k.akcentTlo,
        onPrimaryContainer = k.akcentTekst,
        secondary = k.akcent,
        onSecondary = Color.White,
        background = k.tlo,
        onBackground = k.tekst,
        surface = k.karta,
        onSurface = k.tekst,
        surfaceVariant = k.wglebienie,
        onSurfaceVariant = k.tekstDrugi,
        outline = k.liniaMocna,
        outlineVariant = k.linia,
        error = k.alarm,
        onError = Color.White,
        errorContainer = k.alarmTlo,
        onErrorContainer = k.alarmTekst,
        scrim = k.zaslona,
    )
} else {
    darkColorScheme(
        primary = k.akcent,
        onPrimary = k.akcentTlo,
        primaryContainer = k.akcentTlo,
        onPrimaryContainer = k.akcentTekst,
        secondary = k.akcentTekst,
        onSecondary = k.akcentTlo,
        background = k.tlo,
        onBackground = k.tekst,
        surface = k.karta,
        onSurface = k.tekst,
        surfaceVariant = k.wglebienie,
        onSurfaceVariant = k.tekstDrugi,
        outline = k.liniaMocna,
        outlineVariant = k.linia,
        // Błąd w rampie systemu: dość jasny, żeby czytać go na ciemnym tle.
        // Domyślny Material daje tu odcień, który na tym tle ledwo widać.
        error = k.alarm,
        onError = Color(0xFF601410),
        errorContainer = k.alarmTlo,
        onErrorContainer = k.alarmTekst,
        scrim = k.zaslona,
    )
}

/**
 * Motyw aplikacji.
 *
 * `wybor` to decyzja użytkownika, nie wynik — [WyborMotywu.ZA_SYSTEMEM]
 * rozwiązuje się przy każdym złożeniu, więc przełączenie telefonu na ciemny
 * działa od razu, bez restartu aplikacji. Zapisanie wyliczonego wyniku
 * zostawiłoby aplikację jasną do końca świata, bo w chwili zapisu system był
 * jeszcze jasny.
 */
@Composable
fun MotywNocturne(wybor: WyborMotywu = WyborMotywu.CIEMNY, content: @Composable () -> Unit) {
    val jasny = when (wybor) {
        WyborMotywu.JASNY -> true
        WyborMotywu.CIEMNY -> false
        WyborMotywu.ZA_SYSTEMEM -> !isSystemInDarkTheme()
    }

    val kolory = if (jasny) JASNE else CIEMNE

    CompositionLocalProvider(LokalneKolory provides kolory) {
        MaterialTheme(
            colorScheme = schemat(kolory),
            typography = Typografia,
            shapes = Ksztalty,
            content = content,
        )
    }
}
