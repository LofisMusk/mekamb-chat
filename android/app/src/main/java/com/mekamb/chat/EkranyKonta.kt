package com.mekamb.chat

import androidx.compose.foundation.background
import androidx.compose.foundation.clickable
import androidx.compose.foundation.layout.Arrangement
import androidx.compose.foundation.layout.Box
import androidx.compose.foundation.layout.Column
import androidx.compose.foundation.layout.Row
import androidx.compose.foundation.layout.Spacer
import androidx.compose.foundation.layout.defaultMinSize
import androidx.compose.foundation.layout.fillMaxSize
import androidx.compose.foundation.layout.fillMaxWidth
import androidx.compose.foundation.layout.height
import androidx.compose.foundation.layout.padding
import androidx.compose.foundation.layout.size
import androidx.compose.foundation.rememberScrollState
import androidx.compose.foundation.shape.RoundedCornerShape
import androidx.compose.foundation.verticalScroll
import androidx.compose.material3.Icon
import androidx.compose.material3.MaterialTheme
import androidx.compose.material3.Text
import androidx.compose.runtime.Composable
import androidx.compose.runtime.LaunchedEffect
import androidx.compose.runtime.getValue
import androidx.compose.runtime.mutableIntStateOf
import androidx.compose.runtime.mutableStateOf
import androidx.compose.runtime.remember
import androidx.compose.runtime.setValue
import androidx.compose.ui.Alignment
import androidx.compose.ui.Modifier
import androidx.compose.ui.graphics.vector.ImageVector
import androidx.compose.ui.unit.dp
import kotlinx.coroutines.delay

/**
 * Panel konta i przenoszenie go na inne urządzenie.
 *
 * # Dlaczego przeniesienie dostaje cały ekran
 *
 * Bo jest tam ostrzeżenie, które musi zostać przeczytane: kto zobaczy kod,
 * przejmuje konto. Schowane w arkuszu albo w wierszu listy przeszłoby
 * niezauważone, a skutek jest nieodwracalny.
 */

/** Panel konta — gałąź dolnej nawigacji. */
@Composable
fun EkranKonta(
    model: ChatViewModel,
    modifier: Modifier = Modifier,
    onPrzeniesienie: () -> Unit,
    onUczestnicy: () -> Unit,
    onUstawienia: () -> Unit,
    onGalaz: (Galaz) -> Unit,
) {
    val konto = model.konto

    Column(modifier = modifier.fillMaxSize()) {
        Column(
            Modifier
                .weight(1f)
                .fillMaxWidth()
                .verticalScroll(rememberScrollState())
                .padding(horizontal = Odstep.l),
            verticalArrangement = Arrangement.spacedBy(Odstep.l),
        ) {
            Column {
                Text("Konto", style = MaterialTheme.typography.titleLarge)
                Text("Account", style = MaterialTheme.typography.labelSmall, color = Nocturne.kolory.tekstDrugi)
            }

            Row(
                verticalAlignment = Alignment.CenterVertically,
                horizontalArrangement = Arrangement.spacedBy(Odstep.l),
            ) {
                Awatar(konto?.username ?: "?", rozmiar = 52.dp)
                Column {
                    Text(
                        konto?.username ?: "brak konta",
                        style = MaterialTheme.typography.titleMedium,
                    )
                    Text(
                        konto?.deviceId ?: "",
                        style = MaterialTheme.typography.labelSmall,
                        color = Nocturne.kolory.tekstDrugi,
                    )
                }
            }

            // Znaczników „OPAQUE + TOTP" i „MLS · RFC 9420" tu nie ma i to jest
            // decyzja: nazwy protokołów pod awatarem nie zmieniają niczyjego
            // zachowania, a udają informację. To, co robi różnicę — że hasła
            // nikt nie odzyska i że historia jest tylko tutaj — stoi niżej,
            // przy akcjach, których dotyczy.

            Karta {
                WierszMenu(
                    ikona = Ikony.KodQr,
                    tytul = "Przenieś na inne urządzenie",
                    opis = "Kod QR, ważny 15 minut",
                    onClick = onPrzeniesienie,
                )
                Box(Modifier.fillMaxWidth().height(1.dp).background(Nocturne.kolory.linia))
                WierszMenu(
                    ikona = Ikony.Odcisk,
                    tytul = "Kody bezpieczeństwa",
                    opis = "Safety numbers — do porównania poza aplikacją",
                    onClick = onUczestnicy,
                )
                Box(Modifier.fillMaxWidth().height(1.dp).background(Nocturne.kolory.linia))
                WierszMenu(
                    ikona = Ikony.Dzwonek,
                    tytul = "Powiadomienia i połączenie",
                    opis = "Notifications & transport",
                    onClick = onUstawienia,
                )
            }

            Karta {
                Row(
                    verticalAlignment = Alignment.CenterVertically,
                    horizontalArrangement = Arrangement.spacedBy(Odstep.m),
                ) {
                    Icon(Ikony.Klucz, null, tint = Nocturne.kolory.akcent, modifier = Modifier.size(16.dp))
                    Text("Gdy stracisz to urządzenie", style = MaterialTheme.typography.labelLarge)
                }
                // Zdanie zostaje, bo niesie konsekwencję, a nie zapewnienie:
                // po nim można zrobić coś inaczej — przenieść konto zawczasu.
                Text(
                    "Klucze są tylko tutaj i serwer nie odtworzy ich za Ciebie. Zanim " +
                        "zmienisz telefon, przenieś konto — potem nie ma z czego.",
                    style = MaterialTheme.typography.bodySmall,
                    color = Nocturne.kolory.tekstDrugi,
                )
            }

            PrzyciskNiszczacy("Usuń konto z tego urządzenia") { model.usunKonto() }

            Text(
                "Historia rozmów jest tylko tutaj. Po usunięciu nie da się jej odzyskać.",
                style = MaterialTheme.typography.bodySmall,
                color = Nocturne.kolory.tekstTrzeci,
            )

            Spacer(Modifier.height(Odstep.l))
        }

        DolnaNawigacja(biezaca = Galaz.KONTO, onGalaz = onGalaz)
    }
}

/**
 * Ekran przeniesienia konta.
 *
 * # To jest przeniesienie, nie sklonowanie
 *
 * Dwa urządzenia z tą samą tożsamością MLS dzielą liść w drzewie grupy; gdy oba
 * zaczną wysyłać, ratchet się rozjedzie i obie strony przestaną się
 * rozszyfrowywać. Nie da się tego wykryć po fakcie ani naprawić, więc ekran
 * kończy się skasowaniem konta ze źródła, a nie sugestią.
 */
@Composable
fun EkranPrzeniesienia(model: ChatViewModel, modifier: Modifier = Modifier, onWstecz: () -> Unit) {
    val kod = model.stan.kodPrzeniesienia
    var zostalo by remember(kod) { mutableIntStateOf(kod?.wygasaZaSekund ?: 0) }

    // Odliczanie jest tu istotne, nie ozdobne: kod przestaje działać bez
    // ostrzeżenia, a użytkownik stoi wtedy z dwoma telefonami w rękach.
    LaunchedEffect(kod) {
        while (zostalo > 0) {
            delay(1000)
            zostalo -= 1
        }
    }

    LaunchedEffect(Unit) {
        if (kod == null) model.przygotujPrzeniesienie()
    }

    Column(modifier = modifier.fillMaxSize()) {
        PasekZPowrotem("Przenieś konto", "Move to another device", onWstecz = onWstecz)

        Column(
            Modifier
                .weight(1f)
                .verticalScroll(rememberScrollState())
                .padding(horizontal = Odstep.l),
            verticalArrangement = Arrangement.spacedBy(Odstep.l),
        ) {
            if (kod == null) {
                Text(
                    if (model.stan.pracuje) "Przygotowuję…" else "Nie udało się przygotować kodu.",
                    style = MaterialTheme.typography.bodyMedium,
                    color = Nocturne.kolory.tekstDrugi,
                )
            } else if (zostalo <= 0) {
                Ostrzezenie("Kod wygasł. Wróć i zacznij od nowa.")
            } else {
                Text(
                    "Zeskanuj ten kod na nowym urządzeniu.",
                    style = MaterialTheme.typography.bodyMedium,
                    color = Nocturne.kolory.tekstDrugi,
                )

                KodQr(
                    tresc = kod.tresc,
                    opis = "Kod QR do przeniesienia konta",
                    modifier = Modifier.align(Alignment.CenterHorizontally),
                )

                Row(
                    Modifier.align(Alignment.CenterHorizontally),
                    horizontalArrangement = Arrangement.spacedBy(Odstep.s),
                ) {
                    Znacznik("%d:%02d".format(zostalo / 60, zostalo % 60), akcent = true)
                    Znacznik("jednorazowy")
                }

                Ostrzezenie(
                    "Kto zobaczy ten kod, przejmuje konto. Nie fotografuj go i nie wysyłaj — " +
                        "pokaż wprost z ekranu na ekran.",
                )

                Karta {
                    Text(
                        "Nowe urządzenie nie ma aparatu?",
                        style = MaterialTheme.typography.labelMedium,
                        color = Nocturne.kolory.tekstDrugi,
                    )
                    Text(
                        kod.tresc,
                        style = MaterialTheme.typography.bodySmall,
                        color = Nocturne.kolory.tekstDrugi,
                    )
                }
            }

            Text(
                "Przenoszona jest tożsamość, możliwość kontynuowania rozmów oraz zapisana " +
                    "historia. Kod działa raz i wygasa po kwadransie.",
                style = MaterialTheme.typography.bodySmall,
                color = Nocturne.kolory.tekstDrugi,
            )

            PrzyciskNiszczacy("Odebrane — usuń konto z tego telefonu") { model.usunKonto() }

            Text(
                "Trzeba to zrobić. Dwa urządzenia z tym samym kontem rozsypią szyfrowanie " +
                    "rozmowy i żadna ze stron nie odczyta już wiadomości.",
                style = MaterialTheme.typography.bodySmall,
                color = Nocturne.kolory.tekstTrzeci,
            )

            Spacer(Modifier.height(Odstep.l))
        }
    }
}

/** Mały znacznik — etykieta z obrysem. */
@Composable
private fun Znacznik(tekst: String, akcent: Boolean = false) {
    Text(
        tekst,
        style = MaterialTheme.typography.labelSmall,
        color = if (akcent) Nocturne.kolory.akcentTekst else Nocturne.kolory.tekstDrugi,
        modifier = Modifier
            .background(
                if (akcent) Nocturne.kolory.akcentTlo else Nocturne.kolory.wglebienie,
                RoundedCornerShape(4.dp),
            )
            .padding(horizontal = Odstep.m, vertical = Odstep.xs),
    )
}

/** Wiersz menu: ikona, tytuł, opis. */
@Composable
private fun WierszMenu(
    ikona: ImageVector,
    tytul: String,
    opis: String,
    onClick: () -> Unit,
) {
    Row(
        modifier = Modifier
            .fillMaxWidth()
            .defaultMinSize(minHeight = Dotyk.kontrolka)
            .clickable(onClick = onClick)
            .padding(vertical = Odstep.s),
        verticalAlignment = Alignment.CenterVertically,
        horizontalArrangement = Arrangement.spacedBy(Odstep.l),
    ) {
        Icon(ikona, null, tint = Nocturne.kolory.akcent, modifier = Modifier.size(20.dp))
        Column(Modifier.weight(1f)) {
            Text(tytul, style = MaterialTheme.typography.bodyLarge)
            Text(opis, style = MaterialTheme.typography.labelSmall, color = Nocturne.kolory.tekstDrugi)
        }
    }
}
