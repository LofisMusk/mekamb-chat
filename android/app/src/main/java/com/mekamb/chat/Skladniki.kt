package com.mekamb.chat

import androidx.compose.foundation.BorderStroke
import androidx.compose.foundation.background
import androidx.compose.foundation.layout.Arrangement
import androidx.compose.foundation.layout.Box
import androidx.compose.foundation.layout.Column
import androidx.compose.foundation.layout.ColumnScope
import androidx.compose.foundation.layout.IntrinsicSize
import androidx.compose.foundation.layout.fillMaxHeight
import androidx.compose.foundation.layout.width
import androidx.compose.foundation.layout.Row
import androidx.compose.foundation.layout.defaultMinSize
import androidx.compose.foundation.layout.fillMaxWidth
import androidx.compose.foundation.layout.height
import androidx.compose.foundation.layout.padding
import androidx.compose.foundation.layout.size
import androidx.compose.foundation.shape.RoundedCornerShape
import androidx.compose.material3.ButtonDefaults
import androidx.compose.material3.Checkbox
import androidx.compose.material3.CheckboxDefaults
import androidx.compose.material3.Icon
import androidx.compose.material3.MaterialTheme
import androidx.compose.material3.OutlinedButton
import androidx.compose.material3.OutlinedTextField
import androidx.compose.material3.OutlinedTextFieldDefaults
import androidx.compose.material3.Switch
import androidx.compose.material3.SwitchDefaults
import androidx.compose.material3.Text
import androidx.compose.material3.TextButton
import androidx.compose.runtime.Composable
import androidx.compose.ui.Alignment
import androidx.compose.foundation.layout.PaddingValues
import androidx.compose.ui.Modifier
import androidx.compose.ui.graphics.Color
import androidx.compose.ui.graphics.vector.ImageVector
import androidx.compose.ui.text.input.KeyboardType
import androidx.compose.ui.text.input.PasswordVisualTransformation
import androidx.compose.ui.text.input.VisualTransformation
import androidx.compose.foundation.text.KeyboardOptions
import androidx.compose.foundation.border
import androidx.compose.foundation.selection.toggleable
import androidx.compose.ui.autofill.ContentType
import androidx.compose.ui.semantics.contentType
import androidx.compose.ui.semantics.semantics
import androidx.compose.ui.semantics.Role
import androidx.compose.ui.unit.dp

/**
 * Składniki interfejsu w systemie Nocturne.
 *
 * # Skąd te kształty
 *
 * Z projektu, nie z domyślnych komponentów Material 3. Najważniejsza różnica:
 * **akcja główna jest obrysowana, nie zalana kolorem**. Material domyślnie robi
 * z niej pełną plamę akcentu, a ten system używa akcentu jako linii — plama
 * łamie jego podstawową zasadę i od razu widać, że ekran jest z innej bajki.
 *
 * # Dwujęzyczność
 *
 * Etykiety mają postać „Polski · English". To decyzja z projektu: polski jest
 * pierwszy i wiodący, angielski towarzyszy głównym akcjom i nagłówkom. Nie
 * dotyczy tekstów pomocniczych — tam byłby szumem.
 */

/**
 * Akcja główna — obrys akcentu na przezroczystym tle.
 *
 * Wysokość 48 dp z projektu, powyżej minimum Androida.
 */
@Composable
fun PrzyciskGlowny(
    tekst: String,
    modifier: Modifier = Modifier,
    wlaczony: Boolean = true,
    onClick: () -> Unit,
) {
    OutlinedButton(
        onClick = onClick,
        enabled = wlaczony,
        modifier = modifier.fillMaxWidth().defaultMinSize(minHeight = Dotyk.kontrolka),
        shape = MaterialTheme.shapes.medium,
        border = BorderStroke(1.dp, if (wlaczony) Nocturne.kolory.akcent else Nocturne.kolory.liniaMocna),
        colors = ButtonDefaults.outlinedButtonColors(contentColor = Nocturne.kolory.akcentTekst),
    ) {
        Text(tekst, style = MaterialTheme.typography.labelLarge)
    }
}

/** Akcja drugorzędna — obrys neutralny. */
@Composable
fun PrzyciskDrugi(
    tekst: String,
    modifier: Modifier = Modifier,
    wlaczony: Boolean = true,
    onClick: () -> Unit,
) {
    OutlinedButton(
        onClick = onClick,
        enabled = wlaczony,
        modifier = modifier.fillMaxWidth().defaultMinSize(minHeight = Dotyk.kontrolka),
        shape = MaterialTheme.shapes.medium,
        border = BorderStroke(1.dp, Nocturne.kolory.liniaMocna),
        colors = ButtonDefaults.outlinedButtonColors(contentColor = Nocturne.kolory.tekst),
    ) {
        Text(tekst, style = MaterialTheme.typography.labelLarge)
    }
}

/** Akcja poboczna — bez obrysu. */
@Composable
fun PrzyciskCichy(
    tekst: String,
    modifier: Modifier = Modifier,
    wlaczony: Boolean = true,
    onClick: () -> Unit,
) {
    TextButton(
        onClick = onClick,
        enabled = wlaczony,
        modifier = modifier.fillMaxWidth().defaultMinSize(minHeight = Dotyk.ikonaWPasku),
    ) {
        Text(tekst, style = MaterialTheme.typography.labelLarge, color = Nocturne.kolory.tekstDrugi)
    }
}

/**
 * Akcja niszcząca — obrys w kolorze błędu.
 *
 * Osobny wariant, bo usunięcie konta i rozłączenie rozmowy muszą wyglądać
 * inaczej niż zwykłe potwierdzenie. Kolor jest jedynym, jaki wolno tu wypełnić
 * — i nadal go nie wypełniamy.
 */
@Composable
fun PrzyciskNiszczacy(
    tekst: String,
    modifier: Modifier = Modifier,
    wlaczony: Boolean = true,
    onClick: () -> Unit,
) {
    OutlinedButton(
        onClick = onClick,
        enabled = wlaczony,
        modifier = modifier.fillMaxWidth().defaultMinSize(minHeight = Dotyk.kontrolka),
        shape = MaterialTheme.shapes.medium,
        border = BorderStroke(1.dp, MaterialTheme.colorScheme.error),
        colors = ButtonDefaults.outlinedButtonColors(contentColor = MaterialTheme.colorScheme.error),
    ) {
        Text(tekst, style = MaterialTheme.typography.labelLarge)
    }
}

/**
 * Pole tekstowe z etykietą nad ramką.
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
    Column(modifier = modifier.fillMaxWidth(), verticalArrangement = Arrangement.spacedBy(Odstep.s)) {
        Text(etykieta, style = MaterialTheme.typography.labelMedium, color = Nocturne.kolory.tekstDrugi)

        OutlinedTextField(
            value = wartosc,
            onValueChange = onZmiana,
            singleLine = true,
            modifier = Modifier
                .fillMaxWidth()
                .defaultMinSize(minHeight = Dotyk.kontrolka)
                .then(
                    if (typAutofill != null) Modifier.semantics { contentType = typAutofill }
                    else Modifier,
                ),
            shape = MaterialTheme.shapes.medium,
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
            placeholder = podpowiedz?.let { { Text(it, color = Nocturne.kolory.tekstTrzeci) } },
            colors = OutlinedTextFieldDefaults.colors(
                focusedBorderColor = Nocturne.kolory.akcent,
                unfocusedBorderColor = Nocturne.kolory.linia,
                focusedContainerColor = Nocturne.kolory.karta,
                unfocusedContainerColor = Nocturne.kolory.karta,
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
 * Kolor `alarmTlo` + `alarm` — ten sam stłumiony alarm, którym Nocturne oznacza
 * rzeczy nieodwracalne (patrz tło usuwania na liście). Ma być nie do przeoczenia
 * na ekranie wejścia, ale nie krzyczeć nasyconą czerwienią.
 */
@Composable
fun BannerTestowy(modifier: Modifier = Modifier) {
    Row(
        modifier = modifier
            .fillMaxWidth()
            .background(Nocturne.kolory.alarmTlo, MaterialTheme.shapes.medium)
            .border(1.dp, Nocturne.kolory.alarm.copy(alpha = 0.45f), MaterialTheme.shapes.medium)
            .padding(Odstep.m),
        horizontalArrangement = Arrangement.spacedBy(Odstep.s),
        verticalAlignment = Alignment.Top,
    ) {
        Icon(
            Ikony.Ostrzezenie,
            contentDescription = null,
            tint = Nocturne.kolory.alarm,
            modifier = Modifier.size(20.dp),
        )
        Column(verticalArrangement = Arrangement.spacedBy(Odstep.xs)) {
            Text(
                "Wersja testowa · Test build",
                style = MaterialTheme.typography.labelLarge,
                color = Nocturne.kolory.alarm,
            )
            Text(
                "Ta wersja celowo osłabia zabezpieczenia (m.in. pomija 2FA) na potrzeby " +
                    "testów. Nie nadaje się do użytku osobistego — nie prowadź na niej " +
                    "prywatnych rozmów.",
                style = MaterialTheme.typography.bodySmall,
                color = Nocturne.kolory.tekst,
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
            colors = CheckboxDefaults.colors(checkedColor = Nocturne.kolory.alarm),
        )
        Text(
            "Rozumiem, że to wersja testowa i nie nadaje się do prywatnych rozmów.",
            style = MaterialTheme.typography.bodySmall,
            color = Nocturne.kolory.tekstDrugi,
        )
    }
}

/** Znak firmowy: obrys akcentu z ikoną tarczy. */
@Composable
fun OdznakaMarki(modifier: Modifier = Modifier) {
    Box(
        modifier = modifier
            .size(34.dp)
            .border(1.dp, Nocturne.kolory.akcent, RoundedCornerShape(8.dp)),
        contentAlignment = Alignment.Center,
    ) {
        Icon(
            imageVector = Ikony.Tarcza,
            contentDescription = null,
            tint = Nocturne.kolory.akcent,
            modifier = Modifier.size(18.dp),
        )
    }
}

/**
 * Nagłówek ekranu: tytuł po polsku i drugorzędna linia po angielsku.
 */
@Composable
fun NaglowekEkranu(tytul: String, podtytul: String, modifier: Modifier = Modifier) {
    Column(modifier = modifier, verticalArrangement = Arrangement.spacedBy(Odstep.xs)) {
        Text(tytul, style = MaterialTheme.typography.headlineMedium)
        Text(podtytul, style = MaterialTheme.typography.labelSmall, color = Nocturne.kolory.tekstDrugi)
    }
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
        horizontalArrangement = Arrangement.spacedBy(Odstep.m),
        verticalAlignment = Alignment.Top,
    ) {
        Icon(ikona, contentDescription = null, tint = Nocturne.kolory.tekstTrzeci, modifier = Modifier.size(14.dp))
        Text(tekst, style = MaterialTheme.typography.bodySmall, color = Nocturne.kolory.tekstDrugi)
    }
}

/**
 * Ostrzeżenie, które musi zostać przeczytane.
 *
 * Wyróżnione linią akcentu z boku, nie plamą koloru — plama w tym systemie jest
 * zarezerwowana i i tak nie zwiększa szansy, że ktoś to przeczyta.
 */
@Composable
fun Ostrzezenie(tekst: String, modifier: Modifier = Modifier) {
    Row(
        modifier = modifier
            .fillMaxWidth()
            .height(IntrinsicSize.Min)
            .background(Nocturne.kolory.akcentTlo, MaterialTheme.shapes.medium),
        horizontalArrangement = Arrangement.spacedBy(Odstep.l),
    ) {
        // Linia akcentu z boku zamiast plamy koloru. Plama jest w tym systemie
        // zarezerwowana i tak czy inaczej nie zwiększa szansy na przeczytanie.
        Box(
            Modifier
                .width(2.dp)
                .fillMaxHeight()
                .background(Nocturne.kolory.akcent),
        )
        Text(
            tekst,
            style = MaterialTheme.typography.bodySmall,
            color = Nocturne.kolory.akcentTekst,
            modifier = Modifier.padding(vertical = Odstep.l, horizontal = 0.dp).weight(1f),
        )
    }
}

/** Karta treści — powierzchnia z subtelnym obrysem. */
@Composable
fun Karta(modifier: Modifier = Modifier, zawartosc: @Composable ColumnScope.() -> Unit) {
    Column(
        modifier = modifier
            .fillMaxWidth()
            .background(Nocturne.kolory.karta, MaterialTheme.shapes.medium)
            .border(1.dp, Nocturne.kolory.linia, MaterialTheme.shapes.medium)
            .padding(Odstep.l),
        verticalArrangement = Arrangement.spacedBy(Odstep.m),
        content = zawartosc,
    )
}

/**
 * Wybór motywu — trzy stany w jednym pasku.
 *
 * Nie przełącznik dwustanowy: „jasny / ciemny" bez trzeciej opcji znaczy, że
 * wybór raz podjęty przestaje słuchać systemu, więc telefon przełączony
 * wieczorem na ciemny zostawia aplikację jasną. „Systemowy" musi być osobnym,
 * widocznym stanem, a nie domyślnym zachowaniem, o którym nikt nie wie.
 *
 * Zaznaczenie niesie obrys akcentu, nie wypełnienie — jak każdy inny stan
 * wybrany w tym systemie.
 */
@Composable
fun WyborMotywuUI(
    wybrany: WyborMotywu,
    onWybor: (WyborMotywu) -> Unit,
    modifier: Modifier = Modifier,
) {
    Row(
        modifier = modifier
            .fillMaxWidth()
            .border(1.dp, Nocturne.kolory.linia, MaterialTheme.shapes.medium)
            .padding(2.dp),
        horizontalArrangement = Arrangement.spacedBy(2.dp),
    ) {
        for (motyw in WyborMotywu.entries) {
            val aktywny = motyw == wybrany

            OutlinedButton(
                onClick = { onWybor(motyw) },
                modifier = Modifier.weight(1f).height(36.dp),
                shape = MaterialTheme.shapes.small,
                contentPadding = PaddingValues(horizontal = Odstep.s),
                border = BorderStroke(1.dp, if (aktywny) Nocturne.kolory.akcent else Color.Transparent),
                colors = ButtonDefaults.outlinedButtonColors(
                    contentColor = if (aktywny) Nocturne.kolory.akcentTekst else Nocturne.kolory.tekstDrugi,
                ),
            ) {
                Icon(
                    imageVector = when (motyw) {
                        WyborMotywu.CIEMNY -> Ikony.Ksiezyc
                        WyborMotywu.JASNY -> Ikony.Slonce
                        WyborMotywu.ZA_SYSTEMEM -> Ikony.Ekran
                    },
                    contentDescription = null,
                    modifier = Modifier.size(15.dp),
                )
                Text(
                    motyw.etykieta,
                    style = MaterialTheme.typography.labelSmall,
                    modifier = Modifier.padding(start = Odstep.s),
                )
            }
        }
    }
}

/**
 * Przełącznik z etykietą.
 *
 * `Switch` Material 3, ale bez wypełnionego toru w kolorze akcentu — w tym
 * systemie akcent jest linią. Włączony stan niesie kolor kciuka i obrys,
 * a nie plama na całej szerokości kontrolki.
 */
@Composable
fun Przelacznik(
    etykieta: String,
    zaznaczony: Boolean,
    onZmiana: (Boolean) -> Unit,
    modifier: Modifier = Modifier,
) {
    Row(
        modifier = modifier
            .fillMaxWidth()
            .defaultMinSize(minHeight = Dotyk.kontrolka)
            .toggleable(value = zaznaczony, role = Role.Switch, onValueChange = onZmiana),
        verticalAlignment = Alignment.CenterVertically,
        horizontalArrangement = Arrangement.spacedBy(Odstep.l),
    ) {
        Text(
            etykieta,
            style = MaterialTheme.typography.bodyMedium,
            color = Nocturne.kolory.tekst,
            modifier = Modifier.weight(1f),
        )

        Switch(
            checked = zaznaczony,
            // Sam wiersz jest klikalny (`toggleable`), więc przełącznik nie
            // obsługuje kliknięć osobno — inaczej czytnik ekranu ogłaszałby
            // dwa niezależne elementy o tym samym znaczeniu.
            onCheckedChange = null,
            colors = SwitchDefaults.colors(
                checkedThumbColor = Nocturne.kolory.akcent,
                checkedTrackColor = Nocturne.kolory.akcentTlo,
                checkedBorderColor = Nocturne.kolory.akcent,
                uncheckedThumbColor = Nocturne.kolory.tekstDrugi,
                uncheckedTrackColor = Color.Transparent,
                uncheckedBorderColor = Nocturne.kolory.liniaMocna,
            ),
        )
    }
}

/** Pasek błędu. Znika po dotknięciu — komunikat nie ma zostawać na zawsze. */
@Composable
fun PasekBledu(tekst: String, onZamknij: () -> Unit, modifier: Modifier = Modifier) {
    Row(
        modifier = modifier
            .fillMaxWidth()
            .background(MaterialTheme.colorScheme.errorContainer, MaterialTheme.shapes.medium)
            .padding(Odstep.l),
        horizontalArrangement = Arrangement.spacedBy(Odstep.m),
        verticalAlignment = Alignment.CenterVertically,
    ) {
        Text(
            tekst,
            style = MaterialTheme.typography.bodySmall,
            color = MaterialTheme.colorScheme.onErrorContainer,
            modifier = Modifier.weight(1f),
        )
        TextButton(onClick = onZamknij) {
            Text("×", color = MaterialTheme.colorScheme.onErrorContainer)
        }
    }
}
