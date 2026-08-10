package com.mekamb.chat

import androidx.compose.foundation.background
import androidx.compose.foundation.border
import androidx.compose.foundation.clickable
import androidx.compose.foundation.layout.Arrangement
import androidx.compose.foundation.layout.Box
import androidx.compose.foundation.layout.Column
import androidx.compose.foundation.layout.Row
import androidx.compose.foundation.layout.fillMaxSize
import androidx.compose.foundation.layout.fillMaxWidth
import androidx.compose.foundation.layout.padding
import androidx.compose.foundation.layout.size
import androidx.compose.foundation.lazy.grid.GridCells
import androidx.compose.foundation.lazy.grid.LazyVerticalGrid
import androidx.compose.foundation.lazy.grid.items
import androidx.compose.foundation.shape.CircleShape
import androidx.compose.foundation.shape.RoundedCornerShape
import androidx.compose.material3.Icon
import androidx.compose.material3.MaterialTheme
import androidx.compose.material3.Text
import androidx.compose.runtime.Composable
import androidx.compose.ui.Alignment
import androidx.compose.ui.Modifier
import androidx.compose.ui.graphics.Color
import androidx.compose.ui.graphics.vector.ImageVector
import androidx.compose.ui.text.style.TextAlign
import androidx.compose.ui.unit.dp

/**
 * Rozmowa audio/wideo.
 *
 * # Co ten ekran mówi o prywatności
 *
 * Droga połączenia stoi przy **każdym** rozmówcy z osobna, bo w rozmowie mesh
 * każda para negocjuje ją oddzielnie: z jedną osobą można być połączonym
 * wprost, a z drugą przez przekaźnik. Uśrednienie tego do jednej etykiety na
 * górze ekranu byłoby nieprawdą wobec połowy uczestników.
 *
 * „Bezpośrednio" znaczy, że rozmówca zna Twój adres IP. „Przez przekaźnik" —
 * że zna go serwer TURN. Zdanie o tym zostaje na dole ekranu na stałe, a nie
 * chowa się w ustawieniach: dotyczy każdej rozmowy, nie konfiguracji.
 */
@Composable
fun EkranRozmowyAV(
    model: ChatViewModel,
    modifier: Modifier = Modifier,
    onZakoncz: () -> Unit,
) {
    val stan = model.stan

    Column(
        modifier = modifier.fillMaxSize().background(Neutral900),
        verticalArrangement = Arrangement.SpaceBetween,
    ) {
        Row(
            modifier = Modifier.fillMaxWidth().padding(Odstep.l),
            verticalAlignment = Alignment.CenterVertically,
            horizontalArrangement = Arrangement.SpaceBetween,
        ) {
            Column {
                Text(
                    text = stan.rozmowca ?: "rozmowa",
                    style = MaterialTheme.typography.titleMedium,
                )
                Text(
                    text = "mesh · ${stan.rozmowaAV.size} rozmówców",
                    style = MaterialTheme.typography.labelSmall,
                    color = Neutral500,
                )
            }

            // Znacznik pojawia się dopiero, gdy KTOŚ jest naprawdę połączony.
            // „Zweryfikowany" pokazany w trakcie łączenia byłby obietnicą
            // złożoną przed sprawdzeniem.
            if (stan.rozmowaAV.any { it.faza == FazaPolaczenia.POLACZONA }) {
                Row(
                    modifier = Modifier
                        .border(1.dp, Akcent, RoundedCornerShape(6.dp))
                        .padding(horizontal = Odstep.s, vertical = Odstep.xs),
                    verticalAlignment = Alignment.CenterVertically,
                    horizontalArrangement = Arrangement.spacedBy(Odstep.xs),
                ) {
                    Icon(
                        Ikony.Tarcza,
                        contentDescription = null,
                        tint = Accent300,
                        modifier = Modifier.size(12.dp),
                    )
                    Text(
                        "DTLS zweryfikowany",
                        style = MaterialTheme.typography.labelSmall,
                        color = Accent300,
                    )
                }
            }
        }

        LazyVerticalGrid(
            columns = GridCells.Fixed(2),
            modifier = Modifier.fillMaxWidth().weight(1f).padding(horizontal = Odstep.m),
            horizontalArrangement = Arrangement.spacedBy(Odstep.s),
            verticalArrangement = Arrangement.spacedBy(Odstep.s),
        ) {
            items(stan.rozmowaAV) { uczestnik -> KafelekUczestnika(uczestnik) }
        }

        Row(
            modifier = Modifier.fillMaxWidth().padding(Odstep.l),
            horizontalArrangement = Arrangement.spacedBy(Odstep.m, Alignment.CenterHorizontally),
        ) {
            PrzyciskRozmowy(
                ikona = Ikony.Sluchawka,
                opis = if (model.mikrofonWlaczony) "Wycisz" else "Włącz mikrofon",
                wlaczony = model.mikrofonWlaczony,
                onClick = { model.przelaczMikrofon() },
            )
            PrzyciskRozmowy(
                ikona = Ikony.Kamera,
                opis = if (model.kameraWlaczona) "Wyłącz obraz" else "Włącz obraz",
                wlaczony = model.kameraWlaczona,
                onClick = { model.przelaczKamere() },
            )
            PrzyciskRozmowy(
                ikona = Ikony.Wstecz,
                opis = "Zakończ",
                wlaczony = true,
                alarmowy = true,
                onClick = onZakoncz,
            )
        }

        Text(
            text = "\u201EBezpośrednio\u201D znaczy, że rozmówca zna Twój adres IP. " +
                "\u201EPrzez przekaźnik\u201D — że zna go serwer TURN.",
            style = MaterialTheme.typography.labelSmall,
            color = Neutral600,
            textAlign = TextAlign.Center,
            modifier = Modifier.fillMaxWidth().padding(horizontal = Odstep.xl, vertical = Odstep.l),
        )
    }
}

@Composable
private fun KafelekUczestnika(uczestnik: UczestnikRozmowy) {
    Box(
        modifier = Modifier
            .fillMaxWidth()
            .size(160.dp)
            .background(Tlo, RoundedCornerShape(12.dp))
            .border(1.dp, Linia, RoundedCornerShape(12.dp)),
    ) {
        Awatar(uczestnik.nazwa, rozmiar = 56.dp, modifier = Modifier.align(Alignment.Center))

        Row(
            modifier = Modifier
                .align(Alignment.BottomStart)
                .fillMaxWidth()
                .padding(Odstep.s),
            verticalAlignment = Alignment.CenterVertically,
            horizontalArrangement = Arrangement.SpaceBetween,
        ) {
            Text(uczestnik.nazwa, style = MaterialTheme.typography.labelSmall)

            Text(
                text = when (uczestnik.faza) {
                    FazaPolaczenia.LACZENIE -> "łączę…"
                    FazaPolaczenia.POLACZONA ->
                        if (uczestnik.bezposrednio) "bezpośrednio" else "przez przekaźnik"
                    FazaPolaczenia.ZAKONCZONA -> "rozłączony"
                    // Niezgodny odcisk DTLS. Mówimy wprost, bo to jedyny stan
                    // na tym ekranie, który znaczy „ktoś próbował podsłuchać".
                    FazaPolaczenia.ODRZUCONA -> "odcisk się nie zgadza"
                },
                style = MaterialTheme.typography.labelSmall,
                color = if (uczestnik.faza == FazaPolaczenia.ODRZUCONA) Alarm else Neutral500,
            )
        }
    }
}

@Composable
private fun PrzyciskRozmowy(
    ikona: ImageVector,
    opis: String,
    wlaczony: Boolean,
    alarmowy: Boolean = false,
    onClick: () -> Unit,
) {
    val obrys = when {
        alarmowy -> Accent400
        wlaczony -> Linia
        else -> Neutral700
    }

    Box(
        modifier = Modifier
            .size(56.dp)
            .border(1.dp, obrys, CircleShape)
            .background(if (alarmowy) Accent800.copy(alpha = 0.4f) else Color.Transparent, CircleShape)
            .clickable(onClick = onClick),
        contentAlignment = Alignment.Center,
    ) {
        Icon(
            ikona,
            contentDescription = opis,
            tint = if (alarmowy) Accent300 else if (wlaczony) Tekst else Neutral600,
            modifier = Modifier.size(22.dp),
        )
    }
}

/**
 * Pytanie o odebranie rozmowy.
 *
 * Osobny ekran, a nie pasek nad rozmową: odebranie włącza mikrofon, więc jest
 * decyzją, a nie drobiazgiem do kliknięcia po drodze.
 */
@Composable
fun EkranPrzychodzacejRozmowy(
    od: String,
    modifier: Modifier = Modifier,
    onOdbierz: (wideo: Boolean) -> Unit,
    onOdrzuc: () -> Unit,
) {
    Column(
        modifier = modifier.fillMaxSize().padding(Odstep.xl),
        verticalArrangement = Arrangement.Center,
        horizontalAlignment = Alignment.CenterHorizontally,
    ) {
        Awatar(od, rozmiar = 72.dp)

        Text(
            od,
            style = MaterialTheme.typography.titleLarge,
            modifier = Modifier.padding(top = Odstep.l),
        )
        Text(
            "dzwoni · incoming call",
            style = MaterialTheme.typography.bodyMedium,
            color = TekstPrzygaszony,
        )

        Column(
            modifier = Modifier.fillMaxWidth().padding(top = Odstep.xxl),
            verticalArrangement = Arrangement.spacedBy(Odstep.m),
        ) {
            PrzyciskGlowny("Odbierz z obrazem · Video") { onOdbierz(true) }
            PrzyciskDrugi("Odbierz głosowo · Voice") { onOdbierz(false) }
            PrzyciskCichy("Odrzuć") { onOdrzuc() }
        }
    }
}
