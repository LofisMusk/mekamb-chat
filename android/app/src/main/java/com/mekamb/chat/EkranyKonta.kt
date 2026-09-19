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
 * Panel konta.
 */

/** Panel konta — gałąź dolnej nawigacji. */
@Composable
fun EkranKonta(
    model: ChatViewModel,
    modifier: Modifier = Modifier,
    onUczestnicy: () -> Unit,
    onUstawienia: () -> Unit,
    onZgloszenie: () -> Unit,
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
            Text(t("Ustawienia", "Settings"), style = MaterialTheme.typography.displaySmall)

            Row(
                verticalAlignment = Alignment.CenterVertically,
                horizontalArrangement = Arrangement.spacedBy(Odstep.l),
            ) {
                Awatar(konto?.username ?: "?", rozmiar = 52.dp)
                Column {
                    Text(
                        konto?.username ?: t("brak konta", "no account"),
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
                    ikona = Ikony.Odcisk,
                    tytul = t("Kody bezpieczeństwa", "Safety numbers"),
                    opis = t("Do porównania z rozmówcą poza aplikacją", "To compare with your contact outside the app"),
                    onClick = onUczestnicy,
                )
                Box(Modifier.fillMaxWidth().height(1.dp).background(Nocturne.kolory.linia))
                WierszMenu(
                    ikona = Ikony.Dzwonek,
                    tytul = t("Wygląd i powiadomienia", "Appearance and notifications"),
                    opis = t("Motyw, język, powiadomienia", "Theme, language, notifications"),
                    onClick = onUstawienia,
                )
                Box(Modifier.fillMaxWidth().height(1.dp).background(Nocturne.kolory.linia))
                WierszMenu(
                    ikona = Ikony.Ostrzezenie,
                    tytul = t("Zgłoś błąd", "Report a problem"),
                    opis = t("Napisz nam, co nie działa", "Tell us what isn't working"),
                    onClick = onZgloszenie,
                )
            }

            Karta {
                Row(
                    verticalAlignment = Alignment.CenterVertically,
                    horizontalArrangement = Arrangement.spacedBy(Odstep.m),
                ) {
                    Icon(Ikony.Klucz, null, tint = Nocturne.kolory.akcentTekst, modifier = Modifier.size(16.dp))
                    Text(t("Gdy stracisz to urządzenie", "If you lose this device"), style = MaterialTheme.typography.labelLarge)
                }
                // Zdanie zostaje, bo niesie konsekwencję, a nie zapewnienie:
                // po nim można zrobić coś inaczej — sparować drugie urządzenie
                // zawczasu, żeby konto nie zależało od jednego telefonu.
                Text(
                    t(
                        "Klucze są tylko tutaj i serwer nie odtworzy ich za Ciebie. Zanim " +
                            "zmienisz telefon, sparuj drugie urządzenie — potem nie ma z czego.",
                        "The keys are only here and the server won't recreate them for you. " +
                            "Before you switch phones, pair a second device — afterwards there's nothing to pair from.",
                    ),
                    style = MaterialTheme.typography.bodySmall,
                    color = Nocturne.kolory.tekstDrugi,
                )
            }

            PrzyciskNiszczacy(t("Usuń konto z tego urządzenia", "Delete account from this device")) { model.usunKonto() }

            Text(
                t(
                    "Historia rozmów jest tylko tutaj. Po usunięciu nie da się jej odzyskać.",
                    "Chat history is only here. Once deleted it can't be recovered.",
                ),
                style = MaterialTheme.typography.bodySmall,
                color = Nocturne.kolory.tekstTrzeci,
            )

            Spacer(Modifier.height(Odstep.l))
        }

        DolnaNawigacja(biezaca = Galaz.KONTO, onGalaz = onGalaz)
    }
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
