package com.mekamb.chat

import androidx.compose.foundation.background
import androidx.compose.foundation.clickable
import androidx.compose.foundation.layout.Arrangement
import androidx.compose.foundation.layout.Column
import androidx.compose.foundation.layout.Row
import androidx.compose.foundation.layout.defaultMinSize
import androidx.compose.foundation.layout.fillMaxSize
import androidx.compose.foundation.layout.fillMaxWidth
import androidx.compose.foundation.layout.imePadding
import androidx.compose.foundation.layout.padding
import androidx.compose.foundation.layout.size
import androidx.compose.foundation.rememberScrollState
import androidx.compose.foundation.verticalScroll
import androidx.compose.material3.Icon
import androidx.compose.material3.MaterialTheme
import androidx.compose.material3.Text
import androidx.compose.runtime.Composable
import androidx.compose.runtime.getValue
import androidx.compose.runtime.mutableStateOf
import androidx.compose.runtime.remember
import androidx.compose.runtime.setValue
import androidx.compose.ui.Alignment
import androidx.compose.ui.Modifier
import androidx.compose.ui.unit.dp

/**
 * Kontakty i skład rozmowy.
 *
 * # Skąd bierze się skład
 *
 * Z **drzewa MLS**, nie z własnej listy w interfejsie. To jedyne miejsce, które
 * wie, kto naprawdę jest w rozmowie po wszystkich commitach — własna lista
 * rozjechałaby się przy pierwszej zmianie zrobionej przez kogoś innego.
 */

/** Kontakty — gałąź nawigacji. Katalog nie ma listy, więc zaczyna się od nazwy. */
@Composable
fun EkranKontaktow(
    model: ChatViewModel,
    modifier: Modifier = Modifier,
    onGalaz: (Galaz) -> Unit,
) {
    var nazwa by remember { mutableStateOf("") }
    val stan = model.stan

    Column(modifier = modifier.fillMaxSize()) {
        Column(
            Modifier
                .weight(1f)
                .fillMaxWidth()
                .verticalScroll(rememberScrollState())
                .imePadding()
                .padding(horizontal = Odstep.l),
            verticalArrangement = Arrangement.spacedBy(Odstep.l),
        ) {
            Column {
                Text("Kontakty", style = MaterialTheme.typography.titleLarge)
                Text("Directory", style = MaterialTheme.typography.labelSmall, color = Neutral500)
            }

            Pole("Nazwa użytkownika · Username", nazwa, { nazwa = it })

            PrzyciskGlowny(
                if (stan.pracuje) "Zaczynam…" else "Rozpocznij rozmowę · Start chat",
                wlaczony = !stan.pracuje && nazwa.isNotBlank(),
            ) {
                model.rozpocznijRozmowe(nazwa.trim())
            }

            // Katalog nie ma listy kontaktów do przeglądania i to jest decyzja,
            // nie brak: lista wszystkich użytkowników mówiłaby każdemu, kto jest
            // w systemie. Rozmowę zaczyna się od nazwy, którą już się zna.
            Wskazowka(
                "Katalog przechowuje tylko nazwy, urządzenia i key packages. " +
                    "Kto z kim rozmawia — nie.",
                Ikony.Klucz,
            )
        }

        DolnaNawigacja(biezaca = Galaz.KONTAKTY, onGalaz = onGalaz)
    }
}

/**
 * Uczestnicy rozmowy i kod bezpieczeństwa.
 *
 * # Po co pokazujemy kod
 *
 * Szyfrowanie chroni przed podsłuchem, ale nie przed serwerem, który podstawi
 * cudze urządzenie — wiadomości byłyby wtedy szyfrowane poprawnie, tylko do
 * niego. Kod liczy się wyłącznie z kluczy uczestników, więc podmiana
 * któregokolwiek go zmienia.
 *
 * Porównanie musi odbyć się **innym kanałem** niż ta aplikacja. Porównanie
 * przez sam komunikator nie ma sensu: to dokładnie ten kanał, któremu nie ufamy.
 */
@Composable
fun EkranUczestnikow(model: ChatViewModel, modifier: Modifier = Modifier, onWstecz: () -> Unit) {
    var nowy by remember { mutableStateOf("") }
    val stan = model.stan
    val uczestnicy = stan.uczestnicy
    val kod = stan.kodBezpieczenstwa

    Column(modifier = modifier.fillMaxSize()) {
        PasekZPowrotem(
            if (uczestnicy.size > 2) "Grupa · ${uczestnicy.size} osób" else "Rozmowa prywatna",
            "Members from the MLS tree",
            onWstecz = onWstecz,
        )

        Column(
            Modifier
                .verticalScroll(rememberScrollState())
                .imePadding()
                .padding(horizontal = Odstep.l),
            verticalArrangement = Arrangement.spacedBy(Odstep.l),
        ) {
            uczestnicy.forEach { osoba ->
                Row(
                    modifier = Modifier
                        .fillMaxWidth()
                        .defaultMinSize(minHeight = Dotyk.kontrolka),
                    verticalAlignment = Alignment.CenterVertically,
                    horizontalArrangement = Arrangement.spacedBy(Odstep.l),
                ) {
                    Awatar(osoba, rozmiar = 40.dp)
                    Text(osoba, style = MaterialTheme.typography.bodyLarge)
                }
            }

            Pole("Dodaj osobę · Add member", nowy, { nowy = it })
            PrzyciskDrugi(
                if (stan.pracuje) "Dodaję…" else "Dodaj",
                wlaczony = !stan.pracuje && nowy.isNotBlank(),
            ) {
                model.dodajCzlonka(nowy.trim())
                nowy = ""
            }

            Wskazowka(
                "Nowa osoba zobaczy wiadomości od momentu dołączenia. Wcześniejszych nie da " +
                    "się jej pokazać — i jest to zamierzone.",
                Ikony.Klucz,
            )

            if (kod != null) {
                Karta {
                    Row(
                        verticalAlignment = Alignment.CenterVertically,
                        horizontalArrangement = Arrangement.spacedBy(Odstep.m),
                    ) {
                        Icon(Ikony.Odcisk, null, tint = Akcent, modifier = Modifier.size(16.dp))
                        Text("Kod bezpieczeństwa", style = MaterialTheme.typography.labelLarge)
                    }

                    // Cyfry w dwóch wierszach po sześć grup — tak da się je
                    // przeczytać przez telefon bez gubienia miejsca.
                    Text(
                        kod.split(" ").chunked(6).joinToString("\n") { it.joinToString(" ") },
                        style = MaterialTheme.typography.bodyLarge,
                        color = Accent200,
                        modifier = Modifier
                            .fillMaxWidth()
                            .background(Neutral900, MaterialTheme.shapes.small)
                            .padding(Odstep.m),
                    )

                    Text(
                        "Porównaj innym kanałem — na żywo albo telefonicznie. Porównanie " +
                            "przez tę aplikację nic nie daje: to właśnie ten kanał sprawdzamy.",
                        style = MaterialTheme.typography.bodySmall,
                        color = Neutral500,
                    )
                }

                Wskazowka(
                    "Kod zmienia się przy każdej zmianie składu i przy dołączeniu urządzenia — " +
                        "wtedy trzeba porównać go ponownie.",
                    Ikony.Odcisk,
                )
            }
        }
    }
}
