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
 * Nocturne — system wizualny klienta, w odsłonie „Mekamb Mobile".
 *
 * # Charakter
 *
 * Ten wariant idzie za projektem `Mekamb Mobile.dc.html` z kanwy: język iOS.
 * Tło jasne albo czarne, karty na jasnoszarym wgłębieniu, a **akcent jest tu
 * plamą, nie linią** — akcje główne są zalane kolorem, dymek własnej wiadomości
 * też. To świadome odejście od pierwotnego Nocturne (obrys zamiast plamy): mobil
 * ma wyglądać jak natywny komunikator, a nie jak konsola.
 *
 * # Dlaczego kolory są rolami, a nie stopniami rampy
 *
 * Przy dwóch motywach „600" w ciemnym jest jaśniejsze od tła, a w jasnym musi
 * być ciemniejsze — każde takie użycie wymagałoby warunku, a warunek pominięty
 * w jednym miejscu daje ciemną plamę na jasnym ekranie. Dlatego jest
 * [KoloryNocturne]: zestaw ról, pod które motyw podstawia odcienie. Ekran pisze
 * `Nocturne.kolory.tekstDrugi` i działa w obu motywach bez ani jednego `if`.
 *
 * # Akcent jest wyborem użytkownika
 *
 * Projekt daje ośem kolorów akcentu ([Akcent]). Wybór podstawia się pod role
 * `akcent`, `akcentTekst`, `akcentTlo`, `babelWlasny` i `znacznik` przy składaniu
 * motywu — patrz [MotywNocturne] — więc jedna decyzja przemalowuje cały interfejs.
 *
 * Te same role ma web (`web/src/styles.css`). Zmiana projektu jest przepisaniem
 * tokenów po obu stronach, a nie dobieraniem odcieni od nowa.
 */

/** Role kolorystyczne. Jedna instancja na motyw — patrz [CIEMNE] i [JASNE]. */
@Immutable
data class KoloryNocturne(
    /** Tło aplikacji. */
    val tlo: Color,
    /** Powierzchnia karty. */
    val karta: Color,
    /** Drugorzędna powierzchnia: przyciski drugorzędne, tor segmentu, tło dymka. */
    val karta2: Color,
    /** Pasek nagłówka i dolna nawigacja. */
    val pasek: Color,
    /** Tło pola tekstowego. */
    val pole: Color,
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
 * Motyw jasny — domyślny.
 *
 * Wartości iOS z projektu: białe tło, jasnoszare wgłębienia, systemowy błękit.
 */
val JASNE = KoloryNocturne(
    tlo = Color(0xFFFFFFFF),
    karta = Color(0xFFFFFFFF),
    karta2 = Color(0xFFF2F2F7),
    pasek = Color(0xFFF7F7F8),
    pole = Color(0xFFFFFFFF),
    kartaPodniesiona = Color(0xFFF2F2F7),
    wglebienie = Color(0xFFF2F2F7),
    tekst = Color(0xFF000000),
    tekstDrugi = Color(0xFF6C6C70),
    tekstTrzeci = Color(0xFF8E8E93),
    linia = Color(0xFF3C3C43).copy(alpha = 0.16f),
    liniaMocna = Color(0xFF3C3C43).copy(alpha = 0.29f),
    akcent = Color(0xFF007AFF),
    akcentTekst = Color(0xFF007AFF),
    akcentTlo = Color(0xFFE8F1FF),
    babelWlasny = Color(0xFF007AFF),
    babelWlasnyTekst = Color(0xFFFFFFFF),
    babelWlasnyMeta = Color(0xFFFFFFFF).copy(alpha = 0.78f),
    babel = Color(0xFFE9E9EB),
    awatar = Color(0xFFB9BAC1),
    segment = Color(0xFFFFFFFF),
    znacznik = Color(0xFF007AFF),
    znacznikTekst = Color(0xFFFFFFFF),
    przelacznikWl = Color(0xFF34C759),
    alarm = Color(0xFFFF3B30),
    alarmTekst = Color(0xFFFF3B30),
    alarmTlo = Color(0xFFFFECEB),
    zaslona = Color(0xFF000000).copy(alpha = 0.4f),
    jasny = true,
)

/**
 * Motyw ciemny.
 *
 * Czysta czerń tła pod OLED; karty i paski na kolejnych stopniach grafitu,
 * jaśniejszy błękit `#0A84FF` dla kontrastu. Wartości iOS z projektu.
 */
val CIEMNE = KoloryNocturne(
    tlo = Color(0xFF000000),
    karta = Color(0xFF1C1C1E),
    karta2 = Color(0xFF2C2C2E),
    pasek = Color(0xFF101012),
    pole = Color(0xFF1C1C1E),
    kartaPodniesiona = Color(0xFF2C2C2E),
    wglebienie = Color(0xFF2C2C2E),
    tekst = Color(0xFFFFFFFF),
    tekstDrugi = Color(0xFFA1A1A6),
    tekstTrzeci = Color(0xFF8E8E93),
    linia = Color(0xFFFFFFFF).copy(alpha = 0.14f),
    liniaMocna = Color(0xFFFFFFFF).copy(alpha = 0.26f),
    akcent = Color(0xFF0A84FF),
    akcentTekst = Color(0xFF0A84FF),
    akcentTlo = Color(0xFF12233A),
    babelWlasny = Color(0xFF0A84FF),
    babelWlasnyTekst = Color(0xFFFFFFFF),
    babelWlasnyMeta = Color(0xFFFFFFFF).copy(alpha = 0.78f),
    babel = Color(0xFF26262A),
    awatar = Color(0xFF545458),
    segment = Color(0xFF5A5A5E),
    znacznik = Color(0xFF0A84FF),
    znacznikTekst = Color(0xFFFFFFFF),
    przelacznikWl = Color(0xFF34C759),
    alarm = Color(0xFFFF453A),
    alarmTekst = Color(0xFFFF453A),
    alarmTlo = Color(0xFF3A1A18),
    zaslona = Color(0xFF000000).copy(alpha = 0.72f),
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

/** Skrót do ról kolorystycznych: `Nocturne.kolory.tekstDrugi`. */
object Nocturne {
    val kolory: KoloryNocturne
        @Composable @ReadOnlyComposable get() = LokalneKolory.current
}

/**
 * Skala typograficzna, w duchu SF Pro.
 *
 * Nagłówki ekranów (lista rozmów, ustawienia) są duże i pogrubione — [displaySmall].
 * Reszta zostaje w wagach średnich; hierarchię niesie rozmiar i odstęp.
 */
private val Typografia = Typography(
    displaySmall = TextStyle(fontSize = 32.sp, lineHeight = 37.sp, fontWeight = FontWeight.Bold, letterSpacing = (-0.6).sp),
    headlineMedium = TextStyle(fontSize = 26.sp, lineHeight = 32.sp, fontWeight = FontWeight.Medium, letterSpacing = (-0.3).sp),
    headlineSmall = TextStyle(fontSize = 21.sp, lineHeight = 28.sp, fontWeight = FontWeight.Medium),
    titleLarge = TextStyle(fontSize = 18.sp, lineHeight = 24.sp, fontWeight = FontWeight.Medium),
    titleMedium = TextStyle(fontSize = 16.sp, lineHeight = 22.sp, fontWeight = FontWeight.SemiBold),
    titleSmall = TextStyle(fontSize = 15.sp, lineHeight = 20.sp, fontWeight = FontWeight.SemiBold),
    bodyLarge = TextStyle(fontSize = 16.sp, lineHeight = 22.sp),
    bodyMedium = TextStyle(fontSize = 14.sp, lineHeight = 20.sp),
    bodySmall = TextStyle(fontSize = 13.sp, lineHeight = 18.sp),
    labelLarge = TextStyle(fontSize = 14.sp, lineHeight = 18.sp, fontWeight = FontWeight.Medium),
    labelMedium = TextStyle(fontSize = 12.sp, lineHeight = 16.sp, fontWeight = FontWeight.Medium),
    labelSmall = TextStyle(fontSize = 11.sp, lineHeight = 15.sp, letterSpacing = 0.4.sp),
)

/** Promienie z tokenów iOS: pola 10, przyciski 12, karty 14. */
private val Ksztalty = Shapes(
    extraSmall = RoundedCornerShape(8.dp),
    small = RoundedCornerShape(8.dp),
    medium = RoundedCornerShape(12.dp),
    large = RoundedCornerShape(14.dp),
    extraLarge = RoundedCornerShape(18.dp),
)

/**
 * Skala odstępów.
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

/** Promień dymka wiadomości — jeden dla wszystkich rogów (iOS). */
val PROMIEN_BABLA = 18.dp

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
        onErrorContainer = k.alarm,
        scrim = k.zaslona,
    )
} else {
    darkColorScheme(
        primary = k.akcent,
        onPrimary = Color.White,
        primaryContainer = k.akcentTlo,
        onPrimaryContainer = k.akcentTekst,
        secondary = k.akcentTekst,
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
        onErrorContainer = k.alarm,
        scrim = k.zaslona,
    )
}

/**
 * Motyw aplikacji.
 *
 * `wybor` to decyzja użytkownika, nie wynik — [WyborMotywu.ZA_SYSTEMEM]
 * rozwiązuje się przy każdym złożeniu, więc przełączenie telefonu na ciemny
 * działa od razu, bez restartu aplikacji.
 *
 * `akcent` podstawia się pod role akcentu przez [KoloryNocturne.copy] — jedna
 * decyzja przemalowuje przyciski, dymki, znaczniki i chipy w obu motywach.
 */
@Composable
fun MotywNocturne(
    wybor: WyborMotywu = WyborMotywu.JASNY,
    akcent: Akcent = Akcent.NIEBIESKI,
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

    CompositionLocalProvider(LokalneKolory provides kolory) {
        MaterialTheme(
            colorScheme = schemat(kolory),
            typography = Typografia,
            shapes = Ksztalty,
            content = content,
        )
    }
}
