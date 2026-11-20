package com.mekamb.chat

import androidx.compose.animation.AnimatedContent
import androidx.compose.animation.AnimatedVisibility
import androidx.compose.animation.SizeTransform
import androidx.compose.animation.animateColorAsState
import androidx.compose.animation.core.tween
import androidx.compose.animation.fadeIn
import androidx.compose.animation.fadeOut
import androidx.compose.animation.slideInVertically
import androidx.compose.animation.slideOutVertically
import androidx.compose.animation.togetherWith
import androidx.compose.foundation.Canvas
import androidx.compose.foundation.background
import androidx.compose.foundation.border
import androidx.compose.foundation.clickable
import androidx.compose.foundation.interaction.MutableInteractionSource
import androidx.compose.foundation.interaction.collectIsPressedAsState
import androidx.compose.foundation.layout.Arrangement
import androidx.compose.foundation.layout.Box
import androidx.compose.foundation.layout.Column
import androidx.compose.foundation.layout.ColumnScope
import androidx.compose.foundation.layout.Row
import androidx.compose.foundation.layout.RowScope
import androidx.compose.foundation.layout.defaultMinSize
import androidx.compose.foundation.layout.fillMaxWidth
import androidx.compose.foundation.layout.height
import androidx.compose.foundation.layout.navigationBarsPadding
import androidx.compose.foundation.layout.padding
import androidx.compose.foundation.layout.size
import androidx.compose.foundation.layout.width
import androidx.compose.foundation.selection.selectable
import androidx.compose.foundation.selection.toggleable
import androidx.compose.foundation.shape.CircleShape
import androidx.compose.foundation.shape.RoundedCornerShape
import androidx.compose.foundation.text.KeyboardOptions
import androidx.compose.material3.BasicAlertDialog
import androidx.compose.material3.Checkbox
import androidx.compose.material3.CheckboxDefaults
import androidx.compose.material3.ExperimentalMaterial3Api
import androidx.compose.material3.Icon
import androidx.compose.material3.LocalContentColor
import androidx.compose.material3.LocalTextStyle
import androidx.compose.material3.MaterialTheme
import androidx.compose.material3.ModalBottomSheet
import androidx.compose.material3.OutlinedTextField
import androidx.compose.material3.OutlinedTextFieldDefaults
import androidx.compose.material3.Switch
import androidx.compose.material3.SwitchDefaults
import androidx.compose.material3.Text
import androidx.compose.material3.rememberModalBottomSheetState
import androidx.compose.runtime.Composable
import androidx.compose.runtime.CompositionLocalProvider
import androidx.compose.runtime.LaunchedEffect
import androidx.compose.runtime.getValue
import androidx.compose.runtime.mutableStateOf
import androidx.compose.runtime.remember
import androidx.compose.runtime.setValue
import androidx.compose.ui.Alignment
import androidx.compose.ui.Modifier
import androidx.compose.ui.autofill.ContentType
import androidx.compose.ui.draw.alpha
import androidx.compose.ui.draw.clip
import androidx.compose.ui.geometry.Offset
import androidx.compose.ui.graphics.Color
import androidx.compose.ui.graphics.vector.ImageVector
import androidx.compose.ui.semantics.Role
import androidx.compose.ui.semantics.contentDescription
import androidx.compose.ui.semantics.contentType
import androidx.compose.ui.semantics.semantics
import androidx.compose.ui.text.TextStyle
import androidx.compose.ui.text.input.KeyboardType
import androidx.compose.ui.text.input.PasswordVisualTransformation
import androidx.compose.ui.text.input.VisualTransformation
import androidx.compose.ui.unit.dp
import kotlin.math.hypot
import kotlinx.coroutines.delay

/**
 * Składniki interfejsu w systemie „Neutralny" (`docs/UI_NEUTRALNY.md`).
 *
 * # Dlaczego własne przyciski, a nie `Button` z Material
 *
 * Material rysuje stan wciśnięcia falą (`ripple`) w kolorze wyliczonym ze
 * schematu, a ma do tego własny cień i tonację powierzchni. Specyfikacja mówi
 * co innego: wciśnięcie to zmiana tła na `wglebienie` w 150 ms, bez fali i bez
 * cienia. Owinięcie `Button` tak, żeby nie robił niczego swojego, kosztuje
 * więcej niż napisanie [PrzyciskBaza] — i odpowiada wprost wariantom z weba
 * (`default`/`outline`/`ghost`/`destructive` z shadcn).
 *
 * # Zasada
 *
 * [PrzyciskGlowny] jest plamą `glowny` i na ekranie jest go najwyżej jeden.
 * Reszta to [PrzyciskObrys] albo [PrzyciskDuch]. [PrzyciskNiszczacy] niesie
 * alarm jako tekst i obrys, nie jako plamę — czerwień ma się pojawiać rzadko,
 * żeby znaczyła „naprawdę coś jest nie tak".
 */

/**
 * Wspólna podstawa przycisków: kształt, wysokość, stan wciśnięcia.
 *
 * Nieaktywny przycisk ma połowę krycia (jak `disabled:opacity-50` na webie),
 * a nie osobny kolor — inaczej każdy wariant potrzebowałby czwartej pary barw.
 */
@Composable
private fun PrzyciskBaza(
    onClick: () -> Unit,
    wlaczony: Boolean,
    modifier: Modifier,
    tlo: Color,
    tloWcisniete: Color,
    obrys: Color?,
    tresc: Color,
    pelnaSzerokosc: Boolean,
    zawartosc: @Composable RowScope.() -> Unit,
) {
    val zrodlo = remember { MutableInteractionSource() }
    val wcisniety by zrodlo.collectIsPressedAsState()
    val kolorTla by animateColorAsState(
        if (wcisniety) tloWcisniete else tlo,
        tween(Ruch.STAN_MS, easing = Ruch.krzywa),
        label = "tlo-przycisku",
    )
    val ksztalt = RoundedCornerShape(Promien.m)

    Row(
        modifier = modifier
            .then(if (pelnaSzerokosc) Modifier.fillMaxWidth() else Modifier)
            .defaultMinSize(minHeight = Dotyk.kontrolka)
            .alpha(if (wlaczony) 1f else 0.5f)
            .clip(ksztalt)
            .background(kolorTla, ksztalt)
            .then(if (obrys != null) Modifier.border(1.dp, obrys, ksztalt) else Modifier)
            .clickable(
                interactionSource = zrodlo,
                indication = null,
                enabled = wlaczony,
                role = Role.Button,
                onClick = onClick,
            )
            .padding(horizontal = Odstep.l, vertical = 10.dp),
        horizontalArrangement = Arrangement.spacedBy(Odstep.s, Alignment.CenterHorizontally),
        verticalAlignment = Alignment.CenterVertically,
    ) {
        CompositionLocalProvider(
            LocalContentColor provides tresc,
            LocalTextStyle provides MaterialTheme.typography.labelLarge,
        ) {
            zawartosc()
        }
    }
}

/** Etykieta przycisku, opcjonalnie z ikoną przed tekstem. */
@Composable
private fun TrescPrzycisku(tekst: String, ikona: ImageVector?) {
    if (ikona != null) Icon(ikona, null, modifier = Modifier.size(16.dp))
    Text(tekst)
}

/** Akcja główna — plama `glowny`. Najwyżej jedna na ekranie. */
@Composable
fun PrzyciskGlowny(
    tekst: String,
    modifier: Modifier = Modifier,
    wlaczony: Boolean = true,
    ikona: ImageVector? = null,
    pelnaSzerokosc: Boolean = true,
    onClick: () -> Unit,
) {
    val k = Nocturne.kolory
    PrzyciskBaza(
        onClick = onClick,
        wlaczony = wlaczony,
        modifier = modifier,
        tlo = k.glowny,
        tloWcisniete = k.glowny.copy(alpha = 0.85f),
        obrys = null,
        tresc = k.glownyTekst,
        pelnaSzerokosc = pelnaSzerokosc,
    ) { TrescPrzycisku(tekst, ikona) }
}

/** Akcja drugorzędna — obrys `linia-mocna`, tekst `tekst`. */
@Composable
fun PrzyciskObrys(
    tekst: String,
    modifier: Modifier = Modifier,
    wlaczony: Boolean = true,
    ikona: ImageVector? = null,
    pelnaSzerokosc: Boolean = true,
    onClick: () -> Unit,
) {
    val k = Nocturne.kolory
    PrzyciskBaza(
        onClick = onClick,
        wlaczony = wlaczony,
        modifier = modifier,
        tlo = Color.Transparent,
        tloWcisniete = k.wglebienie,
        obrys = k.liniaMocna,
        tresc = k.tekst,
        pelnaSzerokosc = pelnaSzerokosc,
    ) { TrescPrzycisku(tekst, ikona) }
}

/** Akcja poboczna — „duch": bez tła, tło `wglebienie` dopiero pod palcem. */
@Composable
fun PrzyciskDuch(
    tekst: String,
    modifier: Modifier = Modifier,
    wlaczony: Boolean = true,
    ikona: ImageVector? = null,
    pelnaSzerokosc: Boolean = true,
    onClick: () -> Unit,
) {
    val k = Nocturne.kolory
    PrzyciskBaza(
        onClick = onClick,
        wlaczony = wlaczony,
        modifier = modifier,
        tlo = Color.Transparent,
        tloWcisniete = k.wglebienie,
        obrys = null,
        tresc = k.tekst,
        pelnaSzerokosc = pelnaSzerokosc,
    ) { TrescPrzycisku(tekst, ikona) }
}

/**
 * Akcja niszcząca — alarm jako tekst i obrys, poświata `alarm-tlo` pod palcem.
 *
 * Osobny wariant, bo usunięcie konta i opuszczenie grupy muszą wyglądać inaczej
 * niż zwykłe potwierdzenie, ale nie mogą krzyczeć plamą czerwieni na ekranie,
 * na którym nic jeszcze się nie stało.
 */
@Composable
fun PrzyciskNiszczacy(
    tekst: String,
    modifier: Modifier = Modifier,
    wlaczony: Boolean = true,
    pelnaSzerokosc: Boolean = true,
    onClick: () -> Unit,
) {
    val k = Nocturne.kolory
    PrzyciskBaza(
        onClick = onClick,
        wlaczony = wlaczony,
        modifier = modifier,
        tlo = Color.Transparent,
        tloWcisniete = k.alarmTlo,
        obrys = k.alarm.copy(alpha = 0.5f),
        tresc = k.alarm,
        pelnaSzerokosc = pelnaSzerokosc,
    ) { TrescPrzycisku(tekst, null) }
}

/**
 * Przycisk-ikona jako „duch": okrąg 44×44, tło `wglebienie` pod palcem.
 *
 * Tak wyglądają akcje w nagłówkach (połączenie, wideo, szczegóły) — w wątku nic
 * poza strzałką wysyłania nie może być plamą.
 */
@Composable
fun PrzyciskIkona(
    ikona: ImageVector,
    opis: String,
    onClick: () -> Unit,
    modifier: Modifier = Modifier,
    wlaczony: Boolean = true,
    kolor: Color = Nocturne.kolory.tekst,
) {
    val zrodlo = remember { MutableInteractionSource() }
    val wcisniety by zrodlo.collectIsPressedAsState()
    val kolorTla by animateColorAsState(
        if (wcisniety) Nocturne.kolory.wglebienie else Color.Transparent,
        tween(Ruch.STAN_MS, easing = Ruch.krzywa),
        label = "tlo-ikony",
    )
    Box(
        modifier = modifier
            .size(Dotyk.ikonaWPasku)
            .clip(CircleShape)
            .background(kolorTla, CircleShape)
            .alpha(if (wlaczony) 1f else 0.4f)
            .clickable(
                interactionSource = zrodlo,
                indication = null,
                enabled = wlaczony,
                role = Role.Button,
                onClick = onClick,
            )
            .semantics { contentDescription = opis },
        contentAlignment = Alignment.Center,
    ) {
        Icon(ikona, contentDescription = null, tint = kolor, modifier = Modifier.size(22.dp))
    }
}

/**
 * Pole tekstowe z etykietą nad ramką.
 *
 * Tło `wglebienie` bez obramowania; fokus dostaje obrys w kolorze `pierscien`.
 * Ramka w spoczynku byłaby kolejną linią na ekranie pełnym linii — pole i tak
 * odróżnia się od karty jasnością.
 *
 * # Dlaczego pole hasła to nie „pole tekstowe z gwiazdkami"
 *
 * Samo [PasswordVisualTransformation] zasłania znaki, ale nie mówi systemowi, że
 * to hasło — a wtedy klawiatura stoi w trybie `Text` z autokorektą (uczy się
 * hasła do słownika i podpowiada je nad klawiaturą), a menedżer haseł nie wie,
 * że ma tu proponować zapis i wstawia login zamiast hasła. Dwie rzeczy muszą się
 * zgadzać naraz: [KeyboardType.Password] z wyłączoną autokorektą (klawiatura) i
 * [ContentType] w semantyce (autofill). Dlatego pola logowania podają
 * [typAutofill] — `Username`/`Password` przy logowaniu, `NewUsername`/`NewPassword`
 * przy rejestracji, żeby telefon zaproponował zapisanie nowego hasła.
 */
@Composable
fun Pole(
    etykieta: String,
    wartosc: String,
    onZmiana: (String) -> Unit,
    modifier: Modifier = Modifier,
    haslo: Boolean = false,
    cyfry: Boolean = false,
    podpowiedz: String? = null,
    typAutofill: ContentType? = null,
) {
    val k = Nocturne.kolory
    Column(modifier = modifier.fillMaxWidth(), verticalArrangement = Arrangement.spacedBy(6.dp)) {
        Text(etykieta, style = MaterialTheme.typography.labelMedium, color = k.tekst)

        OutlinedTextField(
            value = wartosc,
            onValueChange = onZmiana,
            singleLine = true,
            textStyle = MaterialTheme.typography.bodyLarge,
            modifier = Modifier
                .fillMaxWidth()
                .defaultMinSize(minHeight = Dotyk.kontrolka)
                .then(
                    if (typAutofill != null) Modifier.semantics { contentType = typAutofill }
                    else Modifier,
                ),
            shape = RoundedCornerShape(Promien.m),
            visualTransformation =
                if (haslo) PasswordVisualTransformation() else VisualTransformation.None,
            keyboardOptions = when {
                cyfry -> KeyboardOptions(keyboardType = KeyboardType.NumberPassword)
                // Hasło: klawiatura hasłowa BEZ autokorekty — inaczej IME uczy
                // się hasła i pokazuje je w pasku podpowiedzi.
                haslo -> KeyboardOptions(
                    keyboardType = KeyboardType.Password,
                    autoCorrectEnabled = false,
                )
                else -> KeyboardOptions.Default
            },
            placeholder = podpowiedz?.let { { Text(it, color = k.tekstTrzeci) } },
            colors = OutlinedTextFieldDefaults.colors(
                focusedTextColor = k.tekst,
                unfocusedTextColor = k.tekst,
                focusedBorderColor = k.pierscien,
                unfocusedBorderColor = Color.Transparent,
                focusedContainerColor = k.wglebienie,
                unfocusedContainerColor = k.wglebienie,
                cursorColor = k.tekst,
            ),
        )
    }
}

/**
 * Znacznik gałęzi testowej `dev`.
 *
 * Na produkcji (`main`) tego kodu nie ma. Gdy `true`, ekrany wejścia pokazują
 * [BannerTestowy] i wymagają [ZgodaTestowa] przed założeniem konta — bo ta
 * wersja CELOWO osłabia zabezpieczenia (pomija 2FA, przyjmuje dowolny kod,
 * wyłącza limity prób). Patrz README i `server/src/dev.ts`.
 */
const val WERSJA_TESTOWA = true

/**
 * Ostrzeżenie o wersji testowej.
 *
 * Rola `ostrzezenie` (bursztyn), nie `alarm`: wersja testowa nie jest błędem,
 * tylko stanem, o którym trzeba wiedzieć. Bursztyn niesie ikona i obrys; treść
 * zostaje w `tekst`, bo bursztyn na bieli nie ma kontrastu na zdanie.
 */
@Composable
fun BannerTestowy(modifier: Modifier = Modifier) {
    val k = Nocturne.kolory
    val ksztalt = RoundedCornerShape(Promien.m)
    Row(
        modifier = modifier
            .fillMaxWidth()
            .background(k.karta, ksztalt)
            .border(1.dp, k.ostrzezenie.copy(alpha = 0.5f), ksztalt)
            .padding(Odstep.m),
        horizontalArrangement = Arrangement.spacedBy(Odstep.s),
        verticalAlignment = Alignment.Top,
    ) {
        Icon(
            Ikony.Ostrzezenie,
            contentDescription = null,
            tint = k.ostrzezenie,
            modifier = Modifier.size(18.dp),
        )
        Column(verticalArrangement = Arrangement.spacedBy(2.dp)) {
            Text(
                t("Wersja testowa", "Test build"),
                style = MaterialTheme.typography.titleSmall,
                color = k.tekst,
            )
            Text(
                t(
                    "Ta wersja celowo osłabia zabezpieczenia (m.in. pomija 2FA) na potrzeby " +
                        "testów. Nie nadaje się do użytku osobistego — nie prowadź na niej " +
                        "prywatnych rozmów.",
                    "This build deliberately weakens security (it skips 2FA, among other " +
                        "things) for testing. It's not for personal use — don't hold private " +
                        "conversations on it.",
                ),
                style = MaterialTheme.typography.bodySmall,
                color = k.tekstDrugi,
            )
        }
    }
}

/**
 * Zgoda na korzystanie z wersji testowej — brama przed założeniem konta.
 *
 * Cały wiersz jest klikalny (`toggleable`), a `Checkbox` sam nie obsługuje
 * kliknięcia (`onCheckedChange = null`), żeby stan czytnika ekranu nie dublował
 * się z wierszem. Bez zaznaczenia ekran rejestracji nie pozwala iść dalej.
 */
@Composable
fun ZgodaTestowa(zaznaczone: Boolean, onZmiana: (Boolean) -> Unit, modifier: Modifier = Modifier) {
    val k = Nocturne.kolory
    Row(
        modifier = modifier
            .fillMaxWidth()
            .toggleable(value = zaznaczone, role = Role.Checkbox, onValueChange = onZmiana)
            .padding(vertical = Odstep.xs),
        horizontalArrangement = Arrangement.spacedBy(Odstep.s),
        verticalAlignment = Alignment.CenterVertically,
    ) {
        Checkbox(
            checked = zaznaczone,
            onCheckedChange = null,
            colors = CheckboxDefaults.colors(
                checkedColor = k.glowny,
                checkmarkColor = k.glownyTekst,
                uncheckedColor = k.liniaMocna,
            ),
        )
        Text(
            t(
                "Rozumiem, że to wersja testowa i nie nadaje się do prywatnych rozmów.",
                "I understand this is a test build and not fit for private conversations.",
            ),
            style = MaterialTheme.typography.bodySmall,
            color = k.tekstDrugi,
        )
    }
}

/**
 * Znak firmowy: kwadrat `glowny` ze znakiem z ikony aplikacji.
 *
 * To nie jest akcja, więc nie konkuruje z przyciskiem głównym — ale jest jedyną
 * plamą na powitaniu poza nim, dlatego stoi małe i z dala od przycisków.
 */
@Composable
fun OdznakaMarki(modifier: Modifier = Modifier) {
    Box(
        modifier = modifier
            .size(40.dp)
            .background(Nocturne.kolory.glowny, RoundedCornerShape(Promien.m)),
        contentAlignment = Alignment.Center,
    ) {
        Icon(
            imageVector = Ikony.Marka,
            contentDescription = null,
            tint = Nocturne.kolory.glownyTekst,
            modifier = Modifier.size(20.dp),
        )
    }
}

/** Nagłówek ekranu — 22, 600, odstęp −0,02em. */
@Composable
fun NaglowekEkranu(tytul: String, modifier: Modifier = Modifier) {
    Text(tytul, style = MaterialTheme.typography.headlineMedium, modifier = modifier)
}

/**
 * Wskazówka: ikona i przygaszony tekst.
 *
 * Używana do zdań, które tłumaczą, co się dzieje z kluczami i danymi. Mają być
 * czytelne, ale nie mają konkurować z akcją.
 */
@Composable
fun Wskazowka(tekst: String, ikona: ImageVector, modifier: Modifier = Modifier) {
    Row(
        modifier = modifier.fillMaxWidth(),
        horizontalArrangement = Arrangement.spacedBy(Odstep.s),
        verticalAlignment = Alignment.Top,
    ) {
        Icon(
            ikona,
            contentDescription = null,
            tint = Nocturne.kolory.tekstDrugi,
            modifier = Modifier.padding(top = 2.dp).size(14.dp),
        )
        Text(tekst, style = MaterialTheme.typography.bodySmall, color = Nocturne.kolory.tekstDrugi)
    }
}

/**
 * Ostrzeżenie, które musi zostać przeczytane.
 *
 * Tło `wglebienie` i ikona w roli `ostrzezenie` — kolor niesie ikona, zdanie
 * zostaje w `tekst`, żeby dało się je przeczytać w obu motywach.
 */
@Composable
fun Ostrzezenie(tekst: String, modifier: Modifier = Modifier) {
    Row(
        modifier = modifier
            .fillMaxWidth()
            .background(Nocturne.kolory.wglebienie, RoundedCornerShape(Promien.m))
            .padding(Odstep.m),
        horizontalArrangement = Arrangement.spacedBy(Odstep.s),
        verticalAlignment = Alignment.Top,
    ) {
        Icon(
            Ikony.Ostrzezenie,
            contentDescription = null,
            tint = Nocturne.kolory.ostrzezenie,
            modifier = Modifier.size(16.dp),
        )
        Text(
            tekst,
            style = MaterialTheme.typography.bodySmall,
            color = Nocturne.kolory.tekst,
            modifier = Modifier.weight(1f),
        )
    }
}

/** Karta treści — `karta` z obrysem `linia`, promień 10. */
@Composable
fun Karta(modifier: Modifier = Modifier, zawartosc: @Composable ColumnScope.() -> Unit) {
    val ksztalt = RoundedCornerShape(Promien.m)
    Column(
        modifier = modifier
            .fillMaxWidth()
            .background(Nocturne.kolory.karta, ksztalt)
            .border(1.dp, Nocturne.kolory.linia, ksztalt)
            .padding(Odstep.l),
        verticalArrangement = Arrangement.spacedBy(Odstep.m),
        content = zawartosc,
    )
}

/** Nagłówek karty: ikona w `tekst-drugi` i tytuł 15/600. */
@Composable
fun NaglowekKarty(tytul: String, ikona: ImageVector, modifier: Modifier = Modifier, dopisek: String? = null) {
    Row(
        modifier = modifier,
        verticalAlignment = Alignment.CenterVertically,
        horizontalArrangement = Arrangement.spacedBy(Odstep.s),
    ) {
        Icon(ikona, contentDescription = null, tint = Nocturne.kolory.tekstDrugi, modifier = Modifier.size(16.dp))
        Text(tytul, style = MaterialTheme.typography.titleSmall)
        if (dopisek != null) {
            Text(dopisek, style = MaterialTheme.typography.labelSmall, color = Nocturne.kolory.tekstDrugi)
        }
    }
}

/** Włos rozdzielający w roli `linia`. */
@Composable
fun Linia(modifier: Modifier = Modifier) {
    Box(modifier.fillMaxWidth().height(1.dp).background(Nocturne.kolory.linia))
}

/**
 * Segment — kilka stanów w jednym torze (`ToggleGroup` na webie).
 *
 * Tor jest `wglebienie`; wybrany segment to `karta` uniesiona cieniem w jasnym
 * i `wglebienie-mocne` w ciemnym, gdzie cienia nie widać.
 */
@Composable
fun <T> KontrolkaSegmentowa(
    opcje: List<T>,
    wybrana: T,
    etykieta: @Composable (T) -> String,
    onWybor: (T) -> Unit,
    modifier: Modifier = Modifier,
    szerokoscSegmentu: androidx.compose.ui.unit.Dp? = null,
) {
    val k = Nocturne.kolory
    Row(
        modifier = modifier
            .then(if (szerokoscSegmentu == null) Modifier.fillMaxWidth() else Modifier)
            .background(k.wglebienie, RoundedCornerShape(Promien.m))
            .padding(3.dp),
        horizontalArrangement = Arrangement.spacedBy(2.dp),
    ) {
        for (opcja in opcje) {
            val aktywna = opcja == wybrana
            val ksztalt = RoundedCornerShape(7.dp)
            val tlo by animateColorAsState(
                when {
                    !aktywna -> Color.Transparent
                    k.jasny -> k.karta
                    else -> k.wglebienieMocne
                },
                tween(Ruch.STAN_MS, easing = Ruch.krzywa),
                label = "segment",
            )
            Box(
                modifier = Modifier
                    .then(if (szerokoscSegmentu == null) Modifier.weight(1f) else Modifier.width(szerokoscSegmentu))
                    .height(34.dp)
                    .then(if (aktywna && k.jasny) Modifier.unoszaca(ksztalt) else Modifier)
                    .background(tlo, ksztalt)
                    .clip(ksztalt)
                    .selectable(selected = aktywna, role = Role.Tab) { onWybor(opcja) },
                contentAlignment = Alignment.Center,
            ) {
                Text(
                    etykieta(opcja),
                    style = MaterialTheme.typography.labelMedium,
                    color = if (aktywna) k.tekst else k.tekstDrugi,
                )
            }
        }
    }
}

/**
 * Wybór motywu — trzy stany w segmencie.
 *
 * „Systemowy" musi być osobnym, widocznym stanem, a nie domyślnym zachowaniem:
 * bez niego telefon przełączony wieczorem na ciemny zostawiłby aplikację jasną.
 */
@Composable
fun WyborMotywuUI(
    wybrany: WyborMotywu,
    onWybor: (WyborMotywu) -> Unit,
    modifier: Modifier = Modifier,
) {
    KontrolkaSegmentowa(
        opcje = listOf(WyborMotywu.ZA_SYSTEMEM, WyborMotywu.JASNY, WyborMotywu.CIEMNY),
        wybrana = wybrany,
        etykieta = {
            when (it) {
                WyborMotywu.ZA_SYSTEMEM -> t("Systemowy", "System")
                WyborMotywu.JASNY -> t("Jasny", "Light")
                WyborMotywu.CIEMNY -> t("Ciemny", "Dark")
            }
        },
        onWybor = onWybor,
        modifier = modifier,
    )
}

/** Nazwa wariantu akcentu — dla czytnika ekranu i podpisu pod próbkami. */
@Composable
fun nazwaAkcentu(akcent: Akcent): String = when (akcent) {
    Akcent.NEUTRALNY -> t("Neutralny", "Neutral")
    Akcent.NIEBIESKI -> t("Niebieski", "Blue")
    Akcent.ZIELONY -> t("Zielony", "Green")
    Akcent.POMARANCZOWY -> t("Pomarańczowy", "Orange")
    Akcent.MALINOWY -> t("Malinowy", "Raspberry")
    Akcent.FIOLETOWY -> t("Fioletowy", "Purple")
    Akcent.INDYGO -> t("Indygo", "Indigo")
    Akcent.TURKUSOWY -> t("Turkusowy", "Teal")
    Akcent.GRAFITOWY -> t("Grafitowy", "Graphite")
}

/**
 * Wybór akcentu — rządek kółek, „Neutralny" pierwszy.
 *
 * Próbka neutralnego to `glowny` z BAZOWEGO motywu, a nie z bieżących kolorów:
 * przy wybranym kolorze `Nocturne.kolory.glowny` jest już tym kolorem, więc
 * neutralna próbka udawałaby wtedy wybraną.
 */
@Composable
fun WyborAkcentu(
    wybrany: Akcent,
    onWybor: (Akcent) -> Unit,
    modifier: Modifier = Modifier,
) {
    val k = Nocturne.kolory
    val neutralny = if (k.jasny) JASNE.glowny else CIEMNE.glowny
    Row(
        modifier = modifier.fillMaxWidth(),
        horizontalArrangement = Arrangement.SpaceBetween,
    ) {
        for (akcent in Akcent.entries) {
            val wybrane = akcent == wybrany
            val nazwa = nazwaAkcentu(akcent)
            Box(
                modifier = Modifier
                    .size(32.dp)
                    .clip(CircleShape)
                    .selectable(selected = wybrane, role = Role.RadioButton) { onWybor(akcent) }
                    .semantics { contentDescription = nazwa }
                    .then(if (wybrane) Modifier.border(2.dp, k.tekst, CircleShape) else Modifier)
                    .padding(if (wybrane) 4.dp else 2.dp)
                    .background(akcent.probka ?: neutralny, CircleShape)
                    .then(
                        // Neutralny w ciemnym to prawie biel — bez obrysu na
                        // jasnym tle karty (i odwrotnie) zlewałby się z kartą.
                        if (akcent == Akcent.NEUTRALNY) Modifier.border(1.dp, k.liniaMocna, CircleShape)
                        else Modifier,
                    ),
            )
        }
    }
}

/**
 * Przełącznik z etykietą.
 *
 * Włączony tor to `glowny` — stan „włączone" jest tu tym samym, co akcja
 * główna: jasność, nie kolor. Systemowa zieleń z poprzedniej odsłony mówiła
 * „sukces", a włączony przełącznik niczego nie zweryfikował.
 */
@Composable
fun Przelacznik(
    etykieta: String,
    zaznaczony: Boolean,
    onZmiana: (Boolean) -> Unit,
    modifier: Modifier = Modifier,
) {
    val k = Nocturne.kolory
    Row(
        modifier = modifier
            .fillMaxWidth()
            .defaultMinSize(minHeight = Dotyk.kontrolka)
            .toggleable(value = zaznaczony, role = Role.Switch, onValueChange = onZmiana),
        verticalAlignment = Alignment.CenterVertically,
        horizontalArrangement = Arrangement.spacedBy(Odstep.m),
    ) {
        Text(
            etykieta,
            style = MaterialTheme.typography.bodyMedium,
            color = k.tekst,
            modifier = Modifier.weight(1f),
        )

        Switch(
            checked = zaznaczony,
            // Sam wiersz jest klikalny (`toggleable`), więc przełącznik nie
            // obsługuje kliknięć osobno — inaczej czytnik ekranu ogłaszałby
            // dwa niezależne elementy o tym samym znaczeniu.
            onCheckedChange = null,
            colors = SwitchDefaults.colors(
                checkedThumbColor = k.glownyTekst,
                checkedTrackColor = k.glowny,
                checkedBorderColor = Color.Transparent,
                uncheckedThumbColor = if (k.jasny) k.karta else k.tekstDrugi,
                uncheckedTrackColor = k.wglebienieMocne,
                uncheckedBorderColor = Color.Transparent,
            ),
        )
    }
}

/**
 * Licznik, który przewija cyfry zamiast je podmieniać (NumberFlow na webie).
 *
 * Nowa liczba wjeżdża od dołu, gdy rośnie, i od góry, gdy maleje — kierunek
 * mówi, co się stało, zanim się ją przeczyta. Przy ograniczonym ruchu zostaje
 * samo przenikanie.
 */
@Composable
fun Licznik(
    ile: Int,
    modifier: Modifier = Modifier,
    styl: TextStyle = MaterialTheme.typography.labelSmall,
    kolor: Color = Nocturne.kolory.tekst,
) {
    val ograniczony = Nocturne.ograniczonyRuch
    AnimatedContent(
        targetState = ile,
        modifier = modifier,
        transitionSpec = {
            val czas = tween<Float>(Ruch.WEJSCIE_MS, easing = Ruch.krzywa)
            if (ograniczony) {
                fadeIn(czas) togetherWith fadeOut(czas)
            } else {
                val wGore = targetState > initialState
                val przesuniecie = tween<androidx.compose.ui.unit.IntOffset>(Ruch.WEJSCIE_MS, easing = Ruch.krzywa)
                (slideInVertically(przesuniecie) { if (wGore) it else -it } + fadeIn(czas)) togetherWith
                    (slideOutVertically(przesuniecie) { if (wGore) -it else it } + fadeOut(czas)) using
                    SizeTransform(clip = true)
            }
        },
        label = "licznik",
    ) { wartosc ->
        Text(wartosc.toString(), style = styl, color = kolor)
    }
}

/** Rodzaj komunikatu chwilowego — decyduje wyłącznie o ikonie i jej kolorze. */
enum class RodzajToastu { INFORMACJA, BLAD }

/**
 * Toast — karta u góry ekranu (Sonner na webie), nie Material `Snackbar`.
 *
 * # Dlaczego u góry
 *
 * Na dole telefonu stoi pole pisania i dolna nawigacja — snackbar zasłaniałby
 * dokładnie to, czego się w tej chwili używa. Góra jest pusta w każdej chwili,
 * w której coś może pójść nie tak.
 *
 * Kolor niesie tylko ikona (alarm przy błędzie); treść zostaje w `tekst`, bo
 * zdanie o błędzie ma się dać przeczytać, a nie rozpoznać po barwie.
 */
@Composable
fun Toast(
    tekst: String,
    rodzaj: RodzajToastu,
    onZamknij: () -> Unit,
    modifier: Modifier = Modifier,
) {
    val k = Nocturne.kolory
    val ksztalt = RoundedCornerShape(Promien.m)
    Row(
        modifier = modifier
            .fillMaxWidth()
            .unoszaca(ksztalt)
            .background(k.karta, ksztalt)
            .clip(ksztalt)
            .clickable(onClick = onZamknij)
            .padding(start = Odstep.m, end = Odstep.xs, top = Odstep.xs, bottom = Odstep.xs),
        horizontalArrangement = Arrangement.spacedBy(Odstep.s),
        verticalAlignment = Alignment.CenterVertically,
    ) {
        Icon(
            if (rodzaj == RodzajToastu.BLAD) Ikony.Niepowodzenie else Ikony.Info,
            contentDescription = null,
            tint = if (rodzaj == RodzajToastu.BLAD) k.alarm else k.tekstDrugi,
            modifier = Modifier.size(18.dp),
        )
        Text(
            tekst,
            style = MaterialTheme.typography.bodySmall,
            color = k.tekst,
            modifier = Modifier.weight(1f).padding(vertical = Odstep.s),
        )
        PrzyciskIkona(Ikony.Zamknij, t("Zamknij", "Close"), onZamknij, kolor = k.tekstDrugi)
    }
}

/**
 * Miejsce na toast: wjazd z góry, samoczynne zniknięcie.
 *
 * Toast żyje dłużej niż komunikat w modelu — gdy model wyczyści błąd, karta ma
 * jeszcze wyjechać, a do tego potrzebuje treści. Stąd [ostatni]: ostatni
 * niepusty komunikat, trzymany na czas animacji wyjścia.
 *
 * Czas na ekranie rośnie z długością zdania (4–10 s): krótkie „Zapisano" nie
 * musi wisieć, a dwuzdaniowy błąd rejestracji trzeba zdążyć przeczytać.
 */
@Composable
fun MiejsceToastu(
    komunikat: String?,
    rodzaj: RodzajToastu,
    onZamknij: () -> Unit,
    modifier: Modifier = Modifier,
) {
    var ostatni by remember { mutableStateOf(komunikat) }
    if (komunikat != null) ostatni = komunikat

    LaunchedEffect(komunikat) {
        if (komunikat != null) {
            delay((4_000L + komunikat.length * 50L).coerceAtMost(10_000L))
            onZamknij()
        }
    }

    val ograniczony = Nocturne.ograniczonyRuch
    val wejscie = tween<Float>(Ruch.WEJSCIE_MS, easing = Ruch.krzywa)
    val wyjscie = tween<Float>(Ruch.STAN_MS, easing = Ruch.krzywa)
    AnimatedVisibility(
        visible = komunikat != null,
        modifier = modifier,
        enter = if (ograniczony) {
            fadeIn(wejscie)
        } else {
            slideInVertically(tween(Ruch.WEJSCIE_MS, easing = Ruch.krzywa)) { -it } + fadeIn(wejscie)
        },
        exit = if (ograniczony) {
            fadeOut(wyjscie)
        } else {
            slideOutVertically(tween(Ruch.STAN_MS, easing = Ruch.krzywa)) { -it } + fadeOut(wyjscie)
        },
    ) {
        ostatni?.let { Toast(it, rodzaj, onZamknij) }
    }
}

/**
 * Arkusz od dołu z uchwytem (Vaul na webie).
 *
 * Tło `karta`, górne rogi 16, pod spodem `nakladka`. W ciemnym obrys `linia`
 * zamiast cienia — tak jak każda unosząca się powierzchnia.
 */
@OptIn(ExperimentalMaterial3Api::class)
@Composable
fun Arkusz(
    onZamknij: () -> Unit,
    tytul: String? = null,
    zawartosc: @Composable ColumnScope.() -> Unit,
) {
    val k = Nocturne.kolory
    val stan = rememberModalBottomSheetState(skipPartiallyExpanded = true)
    val ksztalt = RoundedCornerShape(topStart = Promien.arkusz, topEnd = Promien.arkusz)
    ModalBottomSheet(
        onDismissRequest = onZamknij,
        sheetState = stan,
        modifier = if (k.jasny) Modifier else Modifier.border(1.dp, k.linia, ksztalt),
        shape = ksztalt,
        containerColor = k.karta,
        contentColor = k.tekst,
        scrimColor = k.nakladka,
        tonalElevation = 0.dp,
        dragHandle = {
            Box(
                Modifier
                    .padding(top = Odstep.s, bottom = Odstep.xs)
                    .size(width = 36.dp, height = 4.dp)
                    .background(k.wglebienieMocne, RoundedCornerShape(Promien.pigulka)),
            )
        },
    ) {
        Column(
            modifier = Modifier
                .fillMaxWidth()
                .navigationBarsPadding()
                .padding(start = Odstep.l, end = Odstep.l, top = Odstep.s, bottom = Odstep.xl),
            verticalArrangement = Arrangement.spacedBy(Odstep.m),
        ) {
            if (tytul != null) Text(tytul, style = MaterialTheme.typography.titleMedium)
            zawartosc()
        }
    }
}

/**
 * Dialog potwierdzenia (Radix `AlertDialog` na webie).
 *
 * Przyciski po prawej, obok siebie: „Anuluj" obrysowany, potwierdzenie jako
 * akcja główna albo niszcząca. Pełnej szerokości przyciski w dialogu
 * wyglądałyby jak dwa równorzędne wyjścia, a jedno z nich jest ucieczką.
 */
@OptIn(ExperimentalMaterial3Api::class)
@Composable
fun DialogPotwierdzenia(
    tytul: String,
    potwierdz: String,
    onPotwierdz: () -> Unit,
    onAnuluj: () -> Unit,
    niszczacy: Boolean = false,
    wlaczony: Boolean = true,
    tresc: @Composable ColumnScope.() -> Unit,
) {
    val k = Nocturne.kolory
    val ksztalt = RoundedCornerShape(Promien.l)
    BasicAlertDialog(onDismissRequest = onAnuluj) {
        Column(
            modifier = Modifier
                .fillMaxWidth()
                .unoszaca(ksztalt)
                .background(k.karta, ksztalt)
                .padding(Odstep.xl),
            verticalArrangement = Arrangement.spacedBy(Odstep.m),
        ) {
            Text(tytul, style = MaterialTheme.typography.titleMedium, color = k.tekst)
            CompositionLocalProvider(
                LocalContentColor provides k.tekstDrugi,
                LocalTextStyle provides MaterialTheme.typography.bodyMedium,
            ) {
                tresc()
            }
            Row(
                modifier = Modifier.fillMaxWidth().padding(top = Odstep.s),
                horizontalArrangement = Arrangement.spacedBy(Odstep.s, Alignment.End),
            ) {
                PrzyciskObrys(t("Anuluj", "Cancel"), pelnaSzerokosc = false, onClick = onAnuluj)
                if (niszczacy) {
                    PrzyciskNiszczacy(potwierdz, wlaczony = wlaczony, pelnaSzerokosc = false, onClick = onPotwierdz)
                } else {
                    PrzyciskGlowny(potwierdz, wlaczony = wlaczony, pelnaSzerokosc = false, onClick = onPotwierdz)
                }
            }
        }
    }
}

/**
 * Tło powitania: delikatny wzór kropek (Magic UI *Dot Pattern*).
 *
 * Kropki w `linia`, gasnące ku brzegom — mają dać ekranowi fakturę, nie temat.
 * Gradientów, neonów i ruchu tu nie ma: łamałyby neutralność.
 */
@Composable
fun TloKropek(modifier: Modifier = Modifier) {
    val kolor = Nocturne.kolory.linia
    val jasny = Nocturne.kolory.jasny
    Canvas(modifier) {
        val krok = 20.dp.toPx()
        val promien = 1.dp.toPx()
        val srodek = Offset(size.width / 2f, size.height * 0.4f)
        val zasieg = hypot(size.width, size.height) * 0.55f
        // W jasnym `linia` (#E5E5E5) jest blada sama z siebie; w ciemnym biel
        // 10% potrzebuje odrobiny więcej, żeby kropki w ogóle były widać.
        val mnoznik = if (jasny) 1f else 1.6f
        var y = krok / 2f
        while (y < size.height) {
            var x = krok / 2f
            while (x < size.width) {
                val odleglosc = hypot(x - srodek.x, y - srodek.y)
                val krycie = (1f - odleglosc / zasieg).coerceIn(0f, 1f)
                if (krycie > 0f) {
                    drawCircle(
                        color = kolor.copy(alpha = (kolor.alpha * krycie * mnoznik).coerceAtMost(1f)),
                        radius = promien,
                        center = Offset(x, y),
                    )
                }
                x += krok
            }
            y += krok
        }
    }
}
