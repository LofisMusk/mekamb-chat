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
import androidx.compose.foundation.lazy.LazyColumn
import androidx.compose.foundation.lazy.items
import androidx.compose.material3.Icon
import androidx.compose.material3.MaterialTheme
import androidx.compose.material3.Text
import androidx.compose.runtime.Composable
import androidx.compose.ui.Alignment
import androidx.compose.ui.Modifier
import androidx.compose.ui.graphics.vector.ImageVector
import androidx.compose.ui.text.style.TextOverflow
import androidx.compose.ui.unit.dp
import uniffi.mekamb_ffi.DeliveryMode

/**
 * Lista rozmów — ekran startowy po zalogowaniu.
 *
 * # Skąd bierze się lista
 *
 * Z historii zapisanej na urządzeniu ([`Historia`]). Rozmowy są uporządkowane
 * od najświeższej — lista ma pokazywać to, do czego wraca się najczęściej,
 * a nie porządek alfabetyczny.
 *
 * Serwer o tej liście nic nie wie i nie ma jak jej odtworzyć. Stan pusty mówi
 * to wprost, zamiast zostawiać wrażenie, że coś się nie wczytało.
 */

/** Gałęzie dolnej nawigacji. */
enum class Galaz { ROZMOWY, KONTAKTY, KONTO }

@Composable
fun EkranListy(
    model: ChatViewModel,
    modifier: Modifier = Modifier,
    onOtworzRozmowe: (PozycjaListy) -> Unit,
    onNowaRozmowa: () -> Unit,
    onGalaz: (Galaz) -> Unit,
) {
    val stan = model.stan

    Column(modifier = modifier.fillMaxSize()) {
        Row(
            modifier = Modifier.fillMaxWidth().padding(horizontal = Odstep.l, vertical = Odstep.m),
            verticalAlignment = Alignment.CenterVertically,
        ) {
            Column(Modifier.weight(1f)) {
                Text("Rozmowy", style = MaterialTheme.typography.titleLarge)
                Text("Conversations", style = MaterialTheme.typography.labelSmall, color = Neutral500)
            }
        }

        Column(Modifier.weight(1f).fillMaxWidth()) {
            if (stan.rozmowy.isNotEmpty()) {
                LazyColumn(Modifier.fillMaxWidth()) {
                    items(stan.rozmowy, key = { Historia.klucz(it.groupId) }) { pozycja ->
                        WierszRozmowy(
                            nazwa = pozycja.rozmowca,
                            ostatnia = pozycja.ostatnia?.let {
                                if (it.wlasna) "Ty: ${it.tresc}" else it.tresc
                            } ?: "brak wiadomości",
                            czas = pozycja.ostatnia?.czas,
                            tryb = stan.trybPolaczenia,
                            onClick = { onOtworzRozmowe(pozycja) },
                        )
                    }
                }
            } else {
                Column(
                    modifier = Modifier.fillMaxWidth().padding(Odstep.xl),
                    verticalArrangement = Arrangement.spacedBy(Odstep.m),
                ) {
                    Text(
                        "Nie masz jeszcze żadnej rozmowy.",
                        style = MaterialTheme.typography.bodyMedium,
                        color = TekstPrzygaszony,
                    )
                    Text(
                        "Zacznij od kontaktu — wystarczy nazwa użytkownika.",
                        style = MaterialTheme.typography.bodySmall,
                        color = Neutral600,
                    )
                }
            }

            Spacer(Modifier.height(Odstep.l))
            Wskazowka(
                "Historia jest tylko na tym urządzeniu — serwer jej nie ma.",
                Ikony.Klucz,
                Modifier.padding(horizontal = Odstep.l),
            )
        }

        Box(Modifier.fillMaxWidth().padding(horizontal = Odstep.l, vertical = Odstep.m)) {
            PrzyciskGlowny("Nowa rozmowa · New chat", onClick = onNowaRozmowa)
        }

        DolnaNawigacja(biezaca = Galaz.ROZMOWY, onGalaz = onGalaz)
    }
}

/**
 * Wiersz rozmowy.
 *
 * Wysokość 64 dp z projektu — powyżej minimum Androida, bo trafia się w niego
 * kciukiem w ruchu. Droga dostarczania jest ikoną przy nazwie: „bezpośrednio"
 * znaczy, że rozmówca zna Twój adres IP.
 */
@Composable
private fun WierszRozmowy(
    nazwa: String,
    ostatnia: String,
    czas: Long?,
    tryb: DeliveryMode?,
    onClick: () -> Unit,
) {
    Row(
        modifier = Modifier
            .fillMaxWidth()
            .defaultMinSize(minHeight = Dotyk.wierszRozmowy)
            .clickable(onClick = onClick)
            .padding(horizontal = Odstep.l, vertical = Odstep.m),
        verticalAlignment = Alignment.CenterVertically,
        horizontalArrangement = Arrangement.spacedBy(Odstep.l),
    ) {
        Awatar(nazwa, rozmiar = 44.dp)

        Column(Modifier.weight(1f), verticalArrangement = Arrangement.spacedBy(2.dp)) {
            Row(
                verticalAlignment = Alignment.CenterVertically,
                horizontalArrangement = Arrangement.spacedBy(Odstep.s),
            ) {
                Text(
                    nazwa,
                    style = MaterialTheme.typography.titleMedium,
                    maxLines = 1,
                    overflow = TextOverflow.Ellipsis,
                )
                Icon(
                    imageVector = when (tryb) {
                        DeliveryMode.DIRECT -> Ikony.Bezposrednio
                        DeliveryMode.MAILBOX -> Ikony.PrzezSerwer
                        null -> Ikony.BrakSieci
                    },
                    contentDescription = null,
                    tint = Neutral600,
                    modifier = Modifier.size(13.dp),
                )
            }
            Text(
                ostatnia,
                style = MaterialTheme.typography.bodySmall,
                color = Neutral500,
                maxLines = 1,
                overflow = TextOverflow.Ellipsis,
            )
        }

        czas?.let {
            Text(
                GODZINA_LISTY.format(java.util.Date(it)),
                style = MaterialTheme.typography.labelSmall,
                color = Neutral600,
            )
        }
    }
}

/** Godzina ostatniej wiadomości na liście. */
private val GODZINA_LISTY =
    java.text.SimpleDateFormat("HH:mm", java.util.Locale.getDefault())

/** Dolny pasek: Rozmowy · Kontakty · Konto. */
@Composable
fun DolnaNawigacja(biezaca: Galaz, onGalaz: (Galaz) -> Unit, modifier: Modifier = Modifier) {
    Column(modifier) {
        Box(Modifier.fillMaxWidth().height(1.dp).background(Linia))

        Row(Modifier.fillMaxWidth().background(Tlo)) {
            Zakladka("Rozmowy", Ikony.Rozmowy, biezaca == Galaz.ROZMOWY, Modifier.weight(1f)) {
                onGalaz(Galaz.ROZMOWY)
            }
            Zakladka("Kontakty", Ikony.Kontakty, biezaca == Galaz.KONTAKTY, Modifier.weight(1f)) {
                onGalaz(Galaz.KONTAKTY)
            }
            Zakladka("Konto", Ikony.Konto, biezaca == Galaz.KONTO, Modifier.weight(1f)) {
                onGalaz(Galaz.KONTO)
            }
        }
    }
}

@Composable
private fun Zakladka(
    etykieta: String,
    ikona: ImageVector,
    aktywna: Boolean,
    modifier: Modifier = Modifier,
    onClick: () -> Unit,
) {
    Column(
        modifier = modifier
            .defaultMinSize(minHeight = 60.dp)
            .clickable(onClick = onClick)
            .padding(vertical = Odstep.m),
        horizontalAlignment = Alignment.CenterHorizontally,
        verticalArrangement = Arrangement.spacedBy(3.dp),
    ) {
        Icon(
            ikona,
            contentDescription = etykieta,
            tint = if (aktywna) Akcent else Neutral600,
            modifier = Modifier.size(22.dp),
        )
        Text(
            etykieta,
            style = MaterialTheme.typography.labelSmall,
            color = if (aktywna) Akcent else Neutral600,
        )
    }
}
