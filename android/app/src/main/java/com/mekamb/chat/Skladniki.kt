package com.mekamb.chat

import androidx.compose.foundation.background
import androidx.compose.foundation.clickable
import androidx.compose.foundation.layout.Arrangement
import androidx.compose.foundation.layout.Box
import androidx.compose.foundation.layout.Column
import androidx.compose.foundation.layout.ColumnScope
import androidx.compose.foundation.layout.Row
import androidx.compose.foundation.layout.defaultMinSize
import androidx.compose.foundation.layout.fillMaxWidth
import androidx.compose.foundation.layout.height
import androidx.compose.foundation.layout.padding
import androidx.compose.foundation.layout.size
import androidx.compose.foundation.shape.CircleShape
import androidx.compose.foundation.shape.RoundedCornerShape
import androidx.compose.material3.Button
import androidx.compose.material3.ButtonDefaults
import androidx.compose.material3.Checkbox
import androidx.compose.material3.CheckboxDefaults
import androidx.compose.material3.Icon
import androidx.compose.material3.MaterialTheme
import androidx.compose.material3.OutlinedTextField
import androidx.compose.material3.OutlinedTextFieldDefaults
import androidx.compose.material3.Switch
import androidx.compose.material3.SwitchDefaults
import androidx.compose.material3.Text
import androidx.compose.material3.TextButton
import androidx.compose.runtime.Composable
import androidx.compose.ui.Alignment
import androidx.compose.ui.Modifier
import androidx.compose.ui.draw.shadow
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
 * Składniki interfejsu w odsłonie „Mekamb Mobile" (iOS).
 *
 * # Skąd te kształty
 *
 * Z projektu `Mekamb Mobile.dc.html`, nie z domyślnych komponentów Material 3.
 * Najważniejsza różnica wobec pierwotnego Nocturne: **akcja główna jest zalana
 * akcentem, nie obrysowana**. To celowe — mobil ma wyglądać jak natywny
 * komunikator iOS, gdzie przycisk główny jest pełną plamą, a przełączniki mają
 * systemową zieleń.
 *
 * # Bez dwujęzyczności w etykietach
 *
 * Etykiety są jednojęzyczne (polski wiodący). Wcześniejsza forma „Polski ·
 * English" była z pierwotnego Nocturne; projekt mobilny jej nie ma.
 */

/**
 * Akcja główna — wypełniona akcentem.
 *
 * Wysokość 48 dp z projektu, promień 12, biały tekst.
 */
@Composable
fun PrzyciskGlowny(
    tekst: String,
    modifier: Modifier = Modifier,
    wlaczony: Boolean = true,
    ikona: ImageVector? = null,
    onClick: () -> Unit,
) {
    Button(
        onClick = onClick,
        enabled = wlaczony,
        modifier = modifier.fillMaxWidth().defaultMinSize(minHeight = Dotyk.kontrolka),
        shape = MaterialTheme.shapes.medium,
        colors = ButtonDefaults.buttonColors(
            containerColor = Nocturne.kolory.akcent,
            contentColor = Color.White,
            disabledContainerColor = Nocturne.kolory.karta2,
            disabledContentColor = Nocturne.kolory.tekstTrzeci,
        ),
    ) {
        TrescPrzycisku(tekst, ikona)
    }
}

/** Akcja drugorzędna — wypełnienie neutralne, tekst akcentu. */
@Composable
fun PrzyciskDrugi(
    tekst: String,
    modifier: Modifier = Modifier,
    wlaczony: Boolean = true,
    ikona: ImageVector? = null,
    onClick: () -> Unit,
) {
    Button(
        onClick = onClick,
        enabled = wlaczony,
        modifier = modifier.fillMaxWidth().defaultMinSize(minHeight = Dotyk.kontrolka),
        shape = MaterialTheme.shapes.medium,
        colors = ButtonDefaults.buttonColors(
            containerColor = Nocturne.kolory.karta2,
            contentColor = Nocturne.kolory.akcentTekst,
            disabledContainerColor = Nocturne.kolory.karta2,
            disabledContentColor = Nocturne.kolory.tekstTrzeci,
        ),
    ) {
        TrescPrzycisku(tekst, ikona)
    }
}

/** Etykieta przycisku, opcjonalnie z ikoną przed tekstem — jak w projekcie. */
@Composable
private fun TrescPrzycisku(tekst: String, ikona: ImageVector?) {
    if (ikona != null) {
        Row(
            horizontalArrangement = Arrangement.spacedBy(Odstep.m),
            verticalAlignment = Alignment.CenterVertically,
        ) {
            Icon(ikona, null, modifier = Modifier.size(16.dp))
            Text(tekst, style = MaterialTheme.typography.labelLarge)
        }
    } else {
        Text(tekst, style = MaterialTheme.typography.labelLarge)
    }
}

/** Akcja poboczna — bez tła. */
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
 * Akcja niszcząca — stłumione czerwone tło, czerwony tekst.
 *
 * Osobny wariant, bo usunięcie konta i rozłączenie muszą wyglądać inaczej niż
 * zwykłe potwierdzenie. Wypełnienie jest tu delikatną poświatą alarmu, a nie
 * pełną czerwienią — ta zostaje na krytyczne potwierdzenia w dialogu.
 */
@Composable
fun PrzyciskNiszczacy(
    tekst: String,
    modifier: Modifier = Modifier,
    wlaczony: Boolean = true,
    onClick: () -> Unit,
) {
    Button(
        onClick = onClick,
        enabled = wlaczony,
        modifier = modifier.fillMaxWidth().defaultMinSize(minHeight = Dotyk.kontrolka),
        shape = MaterialTheme.shapes.medium,
        colors = ButtonDefaults.buttonColors(
            containerColor = Nocturne.kolory.alarmTlo,
            contentColor = Nocturne.kolory.alarm,
            disabledContainerColor = Nocturne.kolory.karta2,
            disabledContentColor = Nocturne.kolory.tekstTrzeci,
        ),
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
            shape = RoundedCornerShape(10.dp),
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
                focusedContainerColor = Nocturne.kolory.karta2,
                unfocusedContainerColor = Nocturne.kolory.karta2,
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

/** Znak firmowy: wypełnione kółko akcentu z białym znakiem z ikony aplikacji. */
@Composable
fun OdznakaMarki(modifier: Modifier = Modifier) {
    Box(
        modifier = modifier
            .size(38.dp)
            .background(Nocturne.kolory.akcent, CircleShape),
        contentAlignment = Alignment.Center,
    ) {
        Icon(
            imageVector = Ikony.Marka,
            contentDescription = null,
            tint = Color.White,
            modifier = Modifier.size(18.dp),
        )
    }
}

/**
 * Nagłówek ekranu — jedna linia w wybranym języku.
 *
 * Wcześniej niósł podtytuł po angielsku pod polskim tytułem; z przełącznikiem
 * PL/EN (patrz [Jezyk]) napis dwujęzyczny nie ma już sensu — jest jeden tytuł,
 * a język wybiera przełącznik. Projekt „Mekamb Mobile" też ma nagłówki jednoliniowe.
 */
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
 * Poświata akcentu jako tło i tekst akcentu — chip w duchu iOS.
 */
@Composable
fun Ostrzezenie(tekst: String, modifier: Modifier = Modifier) {
    Row(
        modifier = modifier
            .fillMaxWidth()
            .background(Nocturne.kolory.akcentTlo, MaterialTheme.shapes.medium)
            .padding(Odstep.l),
        horizontalArrangement = Arrangement.spacedBy(Odstep.m),
        verticalAlignment = Alignment.Top,
    ) {
        Icon(
            Ikony.Info,
            contentDescription = null,
            tint = Nocturne.kolory.akcentTekst,
            modifier = Modifier.size(16.dp),
        )
        Text(
            tekst,
            style = MaterialTheme.typography.bodySmall,
            color = Nocturne.kolory.akcentTekst,
            modifier = Modifier.weight(1f),
        )
    }
}

/** Karta treści — biała powierzchnia z subtelnym obrysem, promień 14. */
@Composable
fun Karta(modifier: Modifier = Modifier, zawartosc: @Composable ColumnScope.() -> Unit) {
    Column(
        modifier = modifier
            .fillMaxWidth()
            .background(Nocturne.kolory.karta, MaterialTheme.shapes.large)
            .border(1.dp, Nocturne.kolory.linia, MaterialTheme.shapes.large)
            .padding(Odstep.l),
        verticalArrangement = Arrangement.spacedBy(Odstep.m),
        content = zawartosc,
    )
}

/**
 * Pasek segmentowy iOS — kilka stanów w jednym torze.
 *
 * Tor jest szarą wnęką (`karta2`); wybrany segment to biała plama z cieniem
 * (`segment`), nieaktywne są przezroczyste. Ta sama kontrolka obsługuje wybór
 * motywu i inne przełączenia „jeden z kilku".
 */
@Composable
fun <T> KontrolkaSegmentowa(
    opcje: List<T>,
    wybrana: T,
    etykieta: (T) -> String,
    onWybor: (T) -> Unit,
    modifier: Modifier = Modifier,
) {
    Row(
        modifier = modifier
            .fillMaxWidth()
            .background(Nocturne.kolory.karta2, RoundedCornerShape(9.dp))
            .padding(2.dp),
        horizontalArrangement = Arrangement.spacedBy(2.dp),
    ) {
        for (opcja in opcje) {
            val aktywna = opcja == wybrana
            val ksztalt = RoundedCornerShape(7.dp)
            Box(
                modifier = Modifier
                    .weight(1f)
                    .height(32.dp)
                    .then(
                        if (aktywna) {
                            Modifier
                                .shadow(1.dp, ksztalt)
                                .background(Nocturne.kolory.segment, ksztalt)
                        } else {
                            Modifier
                        },
                    )
                    .clickable { onWybor(opcja) },
                contentAlignment = Alignment.Center,
            ) {
                Text(
                    etykieta(opcja),
                    style = MaterialTheme.typography.labelMedium,
                    color = if (aktywna) Nocturne.kolory.tekst else Nocturne.kolory.tekstDrugi,
                )
            }
        }
    }
}

/**
 * Wybór motywu — trzy stany w pasku segmentowym.
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
        opcje = WyborMotywu.entries,
        wybrana = wybrany,
        etykieta = { it.etykieta },
        onWybor = onWybor,
        modifier = modifier,
    )
}

/**
 * Wybór koloru akcentu — rządek kółek.
 *
 * Wybrany dostaje pierścień (obwódka w kolorze tła + cienki ring tekstu),
 * dokładnie jak w projekcie. Osiem próbek mieści się w jednym rzędzie na
 * szerokości telefonu, więc nie trzeba zawijania.
 */
@Composable
fun WyborAkcentu(
    wybrany: Akcent,
    onWybor: (Akcent) -> Unit,
    modifier: Modifier = Modifier,
) {
    Row(
        modifier = modifier.fillMaxWidth(),
        horizontalArrangement = Arrangement.spacedBy(Odstep.m),
    ) {
        for (akcent in Akcent.entries) {
            val wybrane = akcent == wybrany
            Box(
                modifier = Modifier
                    .weight(1f)
                    .size(30.dp)
                    .then(
                        if (wybrane) {
                            Modifier
                                .border(2.5.dp, Nocturne.kolory.tekst, CircleShape)
                                .padding(4.dp)
                        } else {
                            Modifier
                        },
                    )
                    .background(akcent.probka, CircleShape)
                    .clickable { onWybor(akcent) },
            )
        }
    }
}

/**
 * Przełącznik iOS z etykietą.
 *
 * Tor zalewa się systemową zielenią, gdy włączony — inaczej niż w pierwotnym
 * Nocturne, gdzie akcent był linią. To odsłona mobilna, więc idzie za iOS.
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
                checkedThumbColor = Color.White,
                checkedTrackColor = Nocturne.kolory.przelacznikWl,
                checkedBorderColor = Color.Transparent,
                uncheckedThumbColor = Color.White,
                uncheckedTrackColor = Nocturne.kolory.karta2,
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
