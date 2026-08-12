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
import androidx.compose.foundation.border
import androidx.compose.foundation.layout.offset
import androidx.compose.foundation.shape.CircleShape
import androidx.compose.foundation.shape.RoundedCornerShape
import androidx.compose.material3.Icon
import androidx.compose.material3.IconButton
import androidx.compose.material3.MaterialTheme
import androidx.compose.material3.Text
import androidx.compose.runtime.Composable
import androidx.compose.runtime.getValue
import androidx.compose.runtime.mutableStateOf
import androidx.compose.runtime.remember
import androidx.compose.runtime.setValue
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
    onUstawienia: () -> Unit,
) {
    val stan = model.stan
    var szukanie by remember { mutableStateOf<String?>(null) }

    /*
     * Szukanie filtruje to, co JUŻ jest na urządzeniu.
     *
     * Historia leży w skarbcu i nigdzie indziej, więc nie ma czego pytać
     * serwera — a pytanie go o cokolwiek zdradziłoby, z kim rozmawiamy.
     * Dopasowanie bez rozróżniania wielkości liter, bo nikt nie pamięta,
     * czy zapisał kogoś z dużej.
     */
    val widoczne = szukanie?.trim().orEmpty().let { fraza ->
        if (fraza.isEmpty()) stan.rozmowy
        else stan.rozmowy.filter { it.rozmowca.contains(fraza, ignoreCase = true) }
    }

    Column(modifier = modifier.fillMaxSize()) {
        Row(
            modifier = Modifier.fillMaxWidth().padding(horizontal = Odstep.l, vertical = Odstep.m),
            verticalAlignment = Alignment.CenterVertically,
        ) {
            if (szukanie == null) {
                Column(Modifier.weight(1f)) {
                    Text("Rozmowy", style = MaterialTheme.typography.titleLarge)
                    Text(
                        "Conversations",
                        style = MaterialTheme.typography.labelSmall,
                        color = Nocturne.kolory.tekstDrugi,
                    )
                }
                IconButton(
                    onClick = { szukanie = "" },
                    modifier = Modifier.size(Dotyk.ikonaWPasku),
                ) {
                    Icon(Ikony.Szukaj, contentDescription = "Szukaj", tint = Nocturne.kolory.tekst)
                }
                IconButton(onClick = onUstawienia, modifier = Modifier.size(Dotyk.ikonaWPasku)) {
                    Icon(Ikony.Suwaki, contentDescription = "Ustawienia", tint = Nocturne.kolory.tekst)
                }
            } else {
                Pole(
                    etykieta = "Szukaj w rozmowach · Search",
                    wartosc = szukanie.orEmpty(),
                    onZmiana = { szukanie = it },
                    modifier = Modifier.weight(1f),
                )
                IconButton(
                    onClick = { szukanie = null },
                    modifier = Modifier.size(Dotyk.ikonaWPasku),
                ) {
                    Icon(Ikony.Wstecz, contentDescription = "Zamknij szukanie", tint = Nocturne.kolory.tekst)
                }
            }
        }

        Column(Modifier.weight(1f).fillMaxWidth()) {
            if (widoczne.isNotEmpty()) {
                LazyColumn(Modifier.fillMaxWidth()) {
                    items(widoczne, key = { Historia.klucz(it.groupId) }) { pozycja ->
                        WierszRozmowy(
                            nazwa = pozycja.rozmowca,
                            ostatnia = pozycja.ostatnia?.let {
                                if (it.wlasna) "Ty: ${it.tresc}" else it.tresc
                            } ?: "brak wiadomości",
                            czas = pozycja.ostatnia?.czas,
                            nieprzeczytane = pozycja.nieprzeczytane,
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
                    // Pusto z powodu szukania to co innego niż brak rozmów.
                    // Jedna wiadomość na oba stany kazałaby użytkownikowi
                    // zgadywać, czy niczego nie ma, czy tylko nie znalazł.
                    Text(
                        if (szukanie.isNullOrBlank()) {
                            "Nie masz jeszcze żadnej rozmowy."
                        } else {
                            "Nic nie pasuje do tej nazwy."
                        },
                        style = MaterialTheme.typography.bodyMedium,
                        color = Nocturne.kolory.tekstDrugi,
                    )
                    Text(
                        if (szukanie.isNullOrBlank()) {
                            "Zacznij od kontaktu — wystarczy nazwa użytkownika."
                        } else {
                            "Szukamy tylko w rozmowach zapisanych na tym urządzeniu."
                        },
                        style = MaterialTheme.typography.bodySmall,
                        color = Nocturne.kolory.tekstTrzeci,
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

        DolnaNawigacja(
            biezaca = Galaz.ROZMOWY,
            onGalaz = onGalaz,
            nieprzeczytane = stan.rozmowy.sumOf { it.nieprzeczytane },
        )
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
    nieprzeczytane: Int,
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
                    tint = Nocturne.kolory.tekstTrzeci,
                    modifier = Modifier.size(13.dp),
                )
            }
            Text(
                ostatnia,
                style = MaterialTheme.typography.bodySmall,
                color = Nocturne.kolory.tekstDrugi,
                maxLines = 1,
                overflow = TextOverflow.Ellipsis,
            )
        }

        Column(horizontalAlignment = Alignment.End, verticalArrangement = Arrangement.spacedBy(3.dp)) {
            czas?.let {
                Text(
                    GODZINA_LISTY.format(java.util.Date(it)),
                    style = MaterialTheme.typography.labelSmall,
                    color = Nocturne.kolory.tekstTrzeci,
                )
            }
            if (nieprzeczytane > 0) Znacznik(nieprzeczytane)
        }
    }
}

/**
 * Znacznik nieprzeczytanych.
 *
 * Obrys akcentu, nie wypełnione kółko: w tym systemie akcent jest linią.
 * Liczba, a nie kropka — „trzy" i „trzydzieści" to inna decyzja o tym, czy
 * zaglądać teraz.
 */
@Composable
private fun Znacznik(ile: Int) {
    Text(
        ile.toString(),
        style = MaterialTheme.typography.labelSmall,
        color = Nocturne.kolory.akcentTekst,
        modifier = Modifier
            .border(1.dp, Nocturne.kolory.akcent, RoundedCornerShape(4.dp))
            .padding(horizontal = Odstep.s, vertical = 1.dp),
    )
}

/** Godzina ostatniej wiadomości na liście. */
private val GODZINA_LISTY =
    java.text.SimpleDateFormat("HH:mm", java.util.Locale.getDefault())

/** Dolny pasek: Rozmowy · Kontakty · Konto. */
@Composable
fun DolnaNawigacja(
    biezaca: Galaz,
    onGalaz: (Galaz) -> Unit,
    modifier: Modifier = Modifier,
    nieprzeczytane: Int = 0,
) {
    Column(modifier) {
        Box(Modifier.fillMaxWidth().height(1.dp).background(Nocturne.kolory.linia))

        Row(Modifier.fillMaxWidth().background(Nocturne.kolory.tlo)) {
            Zakladka(
                "Rozmowy",
                Ikony.Rozmowy,
                biezaca == Galaz.ROZMOWY,
                Modifier.weight(1f),
                nieprzeczytane = nieprzeczytane,
            ) {
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
    nieprzeczytane: Int = 0,
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
        Box(contentAlignment = Alignment.TopEnd) {
            Icon(
                ikona,
                contentDescription = etykieta,
                tint = if (aktywna) Nocturne.kolory.akcent else Nocturne.kolory.tekstTrzeci,
                modifier = Modifier.size(22.dp),
            )
            if (nieprzeczytane > 0) {
                Box(
                    Modifier
                        .offset(x = 6.dp, y = (-3).dp)
                        .size(7.dp)
                        .background(Nocturne.kolory.akcent, CircleShape),
                )
            }
        }
        Text(
            etykieta,
            style = MaterialTheme.typography.labelSmall,
            color = if (aktywna) Nocturne.kolory.akcent else Nocturne.kolory.tekstTrzeci,
        )
    }
}
