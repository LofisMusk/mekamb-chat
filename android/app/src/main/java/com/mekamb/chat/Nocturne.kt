package com.mekamb.chat

import android.provider.Settings
import androidx.compose.animation.core.CubicBezierEasing
import androidx.compose.foundation.border
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
import androidx.compose.runtime.remember
import androidx.compose.runtime.staticCompositionLocalOf
import androidx.compose.ui.Modifier
import androidx.compose.ui.draw.shadow
import androidx.compose.ui.graphics.Color
import androidx.compose.ui.graphics.Shape
import androidx.compose.ui.platform.LocalContext
import androidx.compose.ui.text.TextStyle
import androidx.compose.ui.text.font.FontWeight
import androidx.compose.ui.unit.dp
import androidx.compose.ui.unit.em
import androidx.compose.ui.unit.sp

/**
 * Tokeny systemu wizualnego „Neutralny" (`docs/UI_NEUTRALNY.md`).
 *
 * # Dlaczego neutralny
 *
 * Komunikator, którego sednem jest to, czego nie widać, nie potrzebuje marki
 * krzyczącej kolorem. Kontrast bierze się z jasności, więc działa tak samo w obu
 * motywach i przy zaburzeniach widzenia barw, a kolor zostaje zarezerwowany dla
 * STANÓW — gdy pojawia się czerwień, coś naprawdę jest nie tak. Odrzucony
 * wariant „Mekamb Mobile" (systemowy błękit jako plama) trzeba było dostrajać
 * pod kontrast na każdym ekranie osobno; tu nie ma odcienia, który by tego
 * wymagał.
 *
 * Akcja główna to plama `glowny` (prawie czerń w jasnym, prawie biel w ciemnym)
 * i jest jej na ekranie najwyżej jedna. Ten sam `glowny` wypełnia dymek własnej
 * wiadomości, dlatego w wątku nie ma żadnej innej plamy poza strzałką wysyłania.
 *
 * # Dlaczego nazwa `Nocturne` została
 *
 * Wygląd się zmienił, ale ten plik dalej jest „miejscem, w którym mieszkają
 * tokeny" — tak opisuje go CLAUDE.md i tak czytają go wszystkie ekrany przez
 * `Nocturne.kolory`. Zmiana nazwy przepisałaby kilkaset wierszy bez żadnej
 * zmiany zachowania, a każdy rozjazd z dokumentacją kosztuje więcej niż
 * historyczna nazwa (ten sam przypadek co `LABEL_IROH_NODE`).
 *
 * # Dlaczego kolory są rolami, a nie stopniami rampy
 *
 * Przy dwóch motywach „600" w ciemnym jest jaśniejsze od tła, a w jasnym musi
 * być ciemniejsze — każde takie użycie wymagałoby warunku, a warunek pominięty
 * w jednym miejscu daje ciemną plamę na jasnym ekranie. Ekran pisze
 * `Nocturne.kolory.tekstDrugi` i działa w obu motywach bez ani jednego `if`.
 * Nazwy ról są dokładnie te z tabeli w specyfikacji — web ma je jako
 * `--tekst-drugi`, tu są `tekstDrugi`.
 */

/** Role kolorystyczne. Jedna instancja na motyw — patrz [CIEMNE] i [JASNE]. */
@Immutable
data class KoloryNocturne(
    /** Tło aplikacji. */
    val tlo: Color,
    /** Karty, panele, arkusze, popovery, toast. */
    val karta: Color,
    /** Pola tekstowe, dymek rozmówcy, tor segmentu, stan „pod palcem". */
    val wglebienie: Color,
    /** Wciśnięty stan, aktywny element listy, awatar. */
    val wglebienieMocne: Color,

    /** Tekst główny. */
    val tekst: Color,
    /** Podpisy, podgląd wiadomości, godziny — co najmniej 4,5:1. */
    val tekstDrugi: Color,
    /** Wyłącznie dekoracyjne i nieistotne (placeholder). Nie do treści. */
    val tekstTrzeci: Color,

    /** Obramowania, separatory. */
    val linia: Color,
    /** Obramowanie przycisku obrysowanego. */
    val liniaMocna: Color,
    /** Pierścień fokusu i obrys pola z fokusem. */
    val pierscien: Color,

    /**
     * Akcent jako WYPEŁNIENIE — i tylko jako wypełnienie.
     *
     * Leży pod białą treścią (akcja główna, znak firmowy, przycisk wysyłki,
     * kropka nieprzeczytanych), więc musi być ciemny w obu motywach. Na farbę
     * — ikonę, etykietę, obrys na neutralnym tle — jest [akcentTekst]; wzięcie
     * stąd koloru na ikonę daje ciemną plamę na czerni.
     */
    val akcent: Color,
    /**
     * Akcent jako FARBA na neutralnym tle: tekst, ikona, obrys kontrolki.
     *
     * Rozwiązuje się per motyw (patrz [Akcent.farba]), bo musi kontrastować z
     * tłem, a nie z białym tekstem. To NIE jest kolor wypełnienia.
     */
    val akcentTekst: Color,
    /** Delikatna poświata akcentu: tło chipów, ostrzeżeń, awatara połączenia. */
    val akcentTlo: Color,

    /** Dymek własnej wiadomości — wypełniony akcentem. */
    val babelWlasny: Color,
    /** Tekst we własnym dymku. */
    val babelWlasnyTekst: Color,
    /** Godzina i stan wysyłki we własnym dymku. */
    val babelWlasnyMeta: Color,
    /** Dymek rozmówcy — neutralna szarość. */
    val babel: Color,

    /** Kółko awatara — neutralna szarość z białą literą. */
    val awatar: Color,
    /** Biały kciuk/segment wybrany. */
    val segment: Color,

    /** Znacznik nieprzeczytanych — wypełniony akcentem. */
    val znacznik: Color,
    val znacznikTekst: Color,

    /** Przełącznik iOS w stanie włączonym — zieleń systemowa. */
    val przelacznikWl: Color,

    /** Błąd, akcja niszcząca — jako tekst albo obrys, nie plama. */
    val alarm: Color,
    /** Tło komunikatu błędu. */
    val alarmTlo: Color,
    /** „Zweryfikowano", „połączono". */
    val sukces: Color,
    /** Wersja testowa, niezweryfikowany klucz. */
    val ostrzezenie: Color,

    /**
     * Tło pod arkuszem i dialogiem.
     *
     * Przyciemnia to, co zostaje na ekranie, zamiast to zakrywać: arkusz jest
     * kolejnym krokiem w tej samej rozmowie, a nie osobnym miejscem.
     */
    val nakladka: Color,

    /** Czy to motyw jasny. Potrzebne dla ikon paska systemowego i cienia. */
    val jasny: Boolean,
) {
    /*
     * Dymki i znacznik są ALIASAMI ról, nie osobnymi tokenami.
     *
     * Specyfikacja mówi wprost: dymek własny = `glowny` + `glowny-tekst`, dymek
     * rozmówcy = `wglebienie` + `tekst`. Osobne pola dałyby się kiedyś
     * przestawić niezależnie — i wybór akcentu przemalowałby przycisk, a dymek
     * nie, choć zasada mówi, że to ta sama plama.
     */
    val babel: Color get() = wglebienie
    val babelWlasny: Color get() = glowny
    val babelWlasnyTekst: Color get() = glownyTekst
    val znacznik: Color get() = glowny
    val znacznikTekst: Color get() = glownyTekst
}

/** Motyw jasny — wartości z tabeli „Tokeny kolorów" (baza neutral). */
val JASNE = KoloryNocturne(
    tlo = Color(0xFFFFFFFF),
    karta = Color(0xFFFFFFFF),
    wglebienie = Color(0xFFF5F5F5),
    wglebienieMocne = Color(0xFFE5E5E5),
    tekst = Color(0xFF0A0A0A),
    tekstDrugi = Color(0xFF737373),
    tekstTrzeci = Color(0xFFA3A3A3),
    linia = Color(0xFFE5E5E5),
    liniaMocna = Color(0xFFD4D4D4),
    pierscien = Color(0xFFA3A3A3),
    glowny = Color(0xFF171717),
    glownyTekst = Color(0xFFFAFAFA),
    alarm = Color(0xFFDC2626),
    alarmTlo = Color(0xFFFEF2F2),
    sukces = Color(0xFF16A34A),
    ostrzezenie = Color(0xFFD97706),
    nakladka = Color(0xFF000000).copy(alpha = 0.4f),
    jasny = true,
)

/**
 * Motyw ciemny.
 *
 * Linie są półprzezroczystą bielą, a nie szarością: na kolejnych stopniach
 * grafitu (tło → karta → wgłębienie) jedna szarość raz ginie, raz świeci —
 * biel 10% wygląda tak samo na każdym z nich.
 */
val CIEMNE = KoloryNocturne(
    tlo = Color(0xFF0A0A0A),
    karta = Color(0xFF171717),
    wglebienie = Color(0xFF262626),
    wglebienieMocne = Color(0xFF404040),
    tekst = Color(0xFFFAFAFA),
    tekstDrugi = Color(0xFFA3A3A3),
    tekstTrzeci = Color(0xFF737373),
    linia = Color(0xFFFFFFFF).copy(alpha = 0.10f),
    liniaMocna = Color(0xFFFFFFFF).copy(alpha = 0.15f),
    pierscien = Color(0xFF737373),
    glowny = Color(0xFFE5E5E5),
    glownyTekst = Color(0xFF171717),
    alarm = Color(0xFFF87171),
    alarmTlo = Color(0xFF450A0A),
    sukces = Color(0xFF4ADE80),
    ostrzezenie = Color(0xFFFBBF24),
    nakladka = Color(0xFF000000).copy(alpha = 0.6f),
    jasny = false,
)

/**
 * Kolory akcentu do wyboru — ten sam zestaw co `PALETA_AKCENTOW` w webie
 * (`web/src/lib/akcent.ts`). Osiem kolorów, jedna paleta dla obu platform.
 *
 * # Dlaczego dwa odcienie, a nie jeden
 *
 * `probka` to żywy odcień — i tylko tyle: kolor kafelka w selektorze, gdzie nic
 * na nim nie leży. Pod BIAŁYM tekstem ta sama próbka jest nieczytelna: zieleń
 * `#34C759` daje 2,22:1, pomarańcz 2,20:1, malina 3,52:1, turkus 2,12:1 —
 * wszystkie poniżej progu 4,5:1 dla zwykłego tekstu. Przez długi czas telefon
 * zalewał akcje i własne dymki właśnie próbką, więc na tych czterech akcentach
 * biały tekst na przycisku i we własnym dymku był po prostu za jasny.
 *
 * Dlatego jest `wypelnienie`: ten sam odcień przyciemniony dokładnie tyle, żeby
 * biały tekst na nim czytał się bez mrużenia oczu. Wartości są przepisane 1:1 z
 * pola `fill` w webie — gdyby każda platforma dobierała je sobie sama, ta sama
 * rozmowa miałaby dwa różne kolory dymka.
 *
 * Wyjątek jest jeden i świadomy: `NIEBIESKI` to systemowy błękit iOS, ten sam w
 * obu polach. Pod białym daje 4,02:1, czyli nie dociąga do 4,5:1 — ale jest
 * domyślnym akcentem obu klientów i tym, co ludzie znają z natywnego
 * komunikatora. Przyciemnienie go jest decyzją projektową dla obu klientów
 * naraz, nie lokalną poprawką; [KontrastAkcentuTest] przypina go asercją, żeby
 * ten wyjątek był widoczny, a nie milczący.
 *
 * `tintJasny` to poświata pod chipem w motywie jasnym. W ciemnym poświatę
 * liczymy z półprzezroczystej próbki — jeden odcień w tokenach zamiast ośmiu
 * osobnych ciemnych tintów.
 */
enum class Akcent(val probka: Color, val wypelnienie: Color, private val tintJasny: Color) {
    NIEBIESKI(Color(0xFF007AFF), Color(0xFF007AFF), Color(0xFFE8F1FF)),
    ZIELONY(Color(0xFF34C759), Color(0xFF19702F), Color(0xFFDCF1E2)),
    POMARANCZOWY(Color(0xFFFF9500), Color(0xFFB35900), Color(0xFFFFF1E0)),
    MALINOWY(Color(0xFFFF375F), Color(0xFFD6274F), Color(0xFFFFE9ED)),
    FIOLETOWY(Color(0xFFAF52DE), Color(0xFF9A3FC7), Color(0xFFF6EAFC)),
    INDYGO(Color(0xFF5856D6), Color(0xFF5856D6), Color(0xFFECECFB)),
    TURKUSOWY(Color(0xFF00C7BE), Color(0xFF0A7A73), Color(0xFFE0F6F5)),
    GRAFITOWY(Color(0xFF8E8E93), Color(0xFF5E5E63), Color(0xFFEEEEF0));

    /** Poświata akcentu (tło chipa) dla danego motywu. */
    fun tlo(jasny: Boolean): Color = if (jasny) tintJasny else probka.copy(alpha = 0.22f)

    /**
     * Akcent jako farba na neutralnym tle: tekst, ikona, obrys.
     *
     * Odwrotnie niż [wypelnienie], które musi być ciemne zawsze (bo leży pod
     * białym tekstem), farba musi kontrastować z TŁEM — a tło zmienia się z
     * motywem. Na jasnym potrzebny jest odcień ciemny, na czarnym żywy: żywa
     * zieleń na białej karcie to 1,99:1, a ta sama przyciemniona na czerni
     * 3,40:1. Jeden odcień w obu motywach przegrywa w którymś z nich, więc ta
     * rola rozwiązuje się per motyw — tak samo jak każda inna rola w
     * [KoloryNocturne].
     */
    fun farba(jasny: Boolean): Color = if (jasny) wypelnienie else probka
}

/**
 * Kolory bieżącego motywu.
 *
 * `staticCompositionLocalOf`, a nie `compositionLocalOf`: motyw zmienia się
 * kilka razy w życiu aplikacji, więc śledzenie odczytów byłoby płaceniem za
 * coś, z czego nie korzystamy. Zmiana przerysowuje całą gałąź — i o to chodzi.
 */
val LokalneKolory = staticCompositionLocalOf { JASNE }

/**
 * Czy użytkownik wyłączył animacje w systemie („Usuń animacje").
 *
 * Specyfikacja: ograniczony ruch wyłącza przesunięcia, zostawia przenikanie.
 */
val LokalnyOgraniczonyRuch = staticCompositionLocalOf { false }

/** Skrót do ról kolorystycznych: `Nocturne.kolory.tekstDrugi`. */
object Nocturne {
    val kolory: KoloryNocturne
        @Composable @ReadOnlyComposable get() = LokalneKolory.current

    val ograniczonyRuch: Boolean
        @Composable @ReadOnlyComposable get() = LokalnyOgraniczonyRuch.current
}

/**
 * Ruch: 150 ms dla stanów, 250 ms dla wejść, krzywa z Vaul.
 *
 * Ta sama krzywa co na webie (`cubic-bezier(0.32, 0.72, 0, 1)`): szybki start
 * i długie wyhamowanie — arkusz i toast „dojeżdżają", zamiast odbijać.
 */
object Ruch {
    const val STAN_MS = 150
    const val WEJSCIE_MS = 250
    val krzywa = CubicBezierEasing(0.32f, 0.72f, 0f, 1f)
}

/**
 * Skala typograficzna: 12 · 13 · 15 · 17 · 22 · 28, wagi 400/500/600.
 *
 * Systemowy krój (Roboto) — specyfikacja nie każe Androidowi wozić własnego
 * fontu. Tytuły 600 z odstępem −0,02em, jak na webie.
 */
private val Typografia = Typography(
    // 28 — tytuł powitania.
    displaySmall = TextStyle(fontSize = 28.sp, lineHeight = 34.sp, fontWeight = FontWeight.SemiBold, letterSpacing = (-0.02).em),
    // 22 — tytuł ekranu („Rozmowy", „Ustawienia").
    headlineMedium = TextStyle(fontSize = 22.sp, lineHeight = 28.sp, fontWeight = FontWeight.SemiBold, letterSpacing = (-0.02).em),
    headlineSmall = TextStyle(fontSize = 22.sp, lineHeight = 28.sp, fontWeight = FontWeight.SemiBold, letterSpacing = (-0.02).em),
    // 17 — nagłówek sekcji i nawigacji.
    titleLarge = TextStyle(fontSize = 17.sp, lineHeight = 22.sp, fontWeight = FontWeight.SemiBold),
    titleMedium = TextStyle(fontSize = 17.sp, lineHeight = 22.sp, fontWeight = FontWeight.SemiBold),
    // 15 — nazwa na liście, tytuł karty.
    titleSmall = TextStyle(fontSize = 15.sp, lineHeight = 20.sp, fontWeight = FontWeight.SemiBold),
    // 15 — treść: dymek, lista, pola.
    bodyLarge = TextStyle(fontSize = 15.sp, lineHeight = 21.sp),
    bodyMedium = TextStyle(fontSize = 15.sp, lineHeight = 20.sp),
    // 13 — meta: opisy pod etykietą, podgląd.
    bodySmall = TextStyle(fontSize = 13.sp, lineHeight = 18.sp),
    // Etykiety przycisków.
    labelLarge = TextStyle(fontSize = 15.sp, lineHeight = 20.sp, fontWeight = FontWeight.Medium),
    labelMedium = TextStyle(fontSize = 13.sp, lineHeight = 18.sp, fontWeight = FontWeight.Medium),
    // 12 — podpis.
    labelSmall = TextStyle(fontSize = 12.sp, lineHeight = 16.sp),
)

/** Promienie: s 6, m 10 (przyciski, pola, karty), l 14 (dialogi), arkusz 16. */
object Promien {
    val s = 6.dp
    val m = 10.dp
    val l = 14.dp
    val arkusz = 16.dp
    val babel = 18.dp
    val pigulka = 999.dp
}

private val Ksztalty = Shapes(
    extraSmall = RoundedCornerShape(Promien.s),
    small = RoundedCornerShape(Promien.s),
    medium = RoundedCornerShape(Promien.m),
    large = RoundedCornerShape(Promien.l),
    extraLarge = RoundedCornerShape(Promien.arkusz),
)

/** Skala odstępów 4 — 4, 8, 12, 16, 24, 32. */
object Odstep {
    val xs = 4.dp
    val s = 8.dp
    val m = 12.dp
    val l = 16.dp
    val xl = 24.dp
    val xxl = 32.dp

    /** Margines treści od krawędzi ekranu telefonu. */
    val ekran = 16.dp
}

/** Cele dotyku — nigdy poniżej 44. */
object Dotyk {
    val wierszRozmowy = 64.dp
    val kontrolka = 44.dp
    val ikonaWPasku = 44.dp
}

/** Promień dymka wiadomości — jeden dla wszystkich dymków. */
val PROMIEN_BABLA = Promien.babel

/**
 * Powierzchnia unosząca się nad treścią: popover, menu, toast.
 *
 * W jasnym obrys `linia` i delikatny cień; w ciemnym sam obrys — cień na prawie
 * czarnym tle jest niewidoczny, a jego miejsce zajmuje linia.
 */
@Composable
fun Modifier.unoszaca(ksztalt: Shape): Modifier {
    val k = Nocturne.kolory
    val zCieniem = if (k.jasny) {
        this.shadow(
            elevation = 6.dp,
            shape = ksztalt,
            ambientColor = Color.Black.copy(alpha = 0.05f),
            spotColor = Color.Black.copy(alpha = 0.10f),
        )
    } else {
        this
    }
    return zCieniem.border(1.dp, k.linia, ksztalt)
}

/**
 * Schemat Material 3 wyprowadzony z ról.
 *
 * Material jest tu tylko podkładem: bierze go garść komponentów, których nie
 * przepisujemy (pole tekstowe, arkusz, wskaźnik postępu). Wszystkie kontenery
 * `surfaceContainer*` wskazują na `karta`, bo inaczej Material podmienia je na
 * własne, lekko zabarwione odcienie — i arkusz od dołu ma inny kolor niż karta
 * obok niego.
 */
private fun schemat(k: KoloryNocturne) = if (k.jasny) {
    lightColorScheme(
        primary = k.glowny,
        onPrimary = k.glownyTekst,
        primaryContainer = k.wglebienieMocne,
        onPrimaryContainer = k.tekst,
        secondary = k.glowny,
        onSecondary = k.glownyTekst,
        secondaryContainer = k.wglebienieMocne,
        onSecondaryContainer = k.tekst,
        background = k.tlo,
        onBackground = k.tekst,
        surface = k.karta,
        onSurface = k.tekst,
        surfaceVariant = k.wglebienie,
        onSurfaceVariant = k.tekstDrugi,
        surfaceTint = Color.Transparent,
        surfaceContainerLowest = k.karta,
        surfaceContainerLow = k.karta,
        surfaceContainer = k.karta,
        surfaceContainerHigh = k.karta,
        surfaceContainerHighest = k.wglebienie,
        outline = k.liniaMocna,
        outlineVariant = k.linia,
        error = k.alarm,
        onError = Color.White,
        errorContainer = k.alarmTlo,
        onErrorContainer = k.alarm,
        scrim = k.nakladka,
    )
} else {
    darkColorScheme(
        primary = k.glowny,
        onPrimary = k.glownyTekst,
        primaryContainer = k.wglebienieMocne,
        onPrimaryContainer = k.tekst,
        secondary = k.glowny,
        onSecondary = k.glownyTekst,
        secondaryContainer = k.wglebienieMocne,
        onSecondaryContainer = k.tekst,
        background = k.tlo,
        onBackground = k.tekst,
        surface = k.karta,
        onSurface = k.tekst,
        surfaceVariant = k.wglebienie,
        onSurfaceVariant = k.tekstDrugi,
        surfaceTint = Color.Transparent,
        surfaceContainerLowest = k.karta,
        surfaceContainerLow = k.karta,
        surfaceContainer = k.karta,
        surfaceContainerHigh = k.karta,
        surfaceContainerHighest = k.wglebienie,
        outline = k.liniaMocna,
        outlineVariant = k.linia,
        error = k.alarm,
        onError = Color(0xFF171717),
        errorContainer = k.alarmTlo,
        onErrorContainer = k.alarm,
        scrim = k.nakladka,
    )
}

/**
 * Motyw aplikacji.
 *
 * `wybor` to decyzja użytkownika, nie wynik — [WyborMotywu.ZA_SYSTEMEM]
 * rozwiązuje się przy każdym złożeniu, więc przełączenie telefonu na ciemny
 * działa od razu, bez restartu aplikacji. Tak samo [Akcent.NEUTRALNY]: zapisany
 * jest wybór „neutralny", a odcień `glowny` bierze się z motywu dopiero tutaj.
 */
@Composable
fun MotywNocturne(
    wybor: WyborMotywu = WyborMotywu.JASNY,
    akcent: Akcent = Akcent.NEUTRALNY,
    content: @Composable () -> Unit,
) {
    val jasny = when (wybor) {
        WyborMotywu.JASNY -> true
        WyborMotywu.CIEMNY -> false
        WyborMotywu.ZA_SYSTEMEM -> !isSystemInDarkTheme()
    }

    val bazowe = if (jasny) JASNE else CIEMNE
    val kolory = bazowe.copy(
        akcent = akcent.wypelnienie,
        akcentTekst = akcent.farba(jasny),
        akcentTlo = akcent.tlo(jasny),
        babelWlasny = akcent.wypelnienie,
        znacznik = akcent.wypelnienie,
    )

    CompositionLocalProvider(
        LokalneKolory provides kolory,
        LokalnyOgraniczonyRuch provides ograniczonyRuch,
    ) {
        MaterialTheme(
            colorScheme = schemat(kolory),
            typography = Typografia,
            shapes = Ksztalty,
            content = content,
        )
    }
}
