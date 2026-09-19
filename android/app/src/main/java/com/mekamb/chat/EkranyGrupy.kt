package com.mekamb.chat

import androidx.compose.foundation.background
import androidx.compose.foundation.border
import androidx.compose.foundation.clickable
import androidx.compose.foundation.horizontalScroll
import androidx.compose.foundation.layout.Arrangement
import androidx.compose.foundation.layout.Column
import androidx.compose.foundation.layout.Row
import androidx.compose.foundation.layout.Spacer
import androidx.compose.foundation.layout.defaultMinSize
import androidx.compose.foundation.layout.fillMaxSize
import androidx.compose.foundation.layout.fillMaxWidth
import androidx.compose.foundation.layout.imePadding
import androidx.compose.foundation.layout.padding
import androidx.compose.foundation.layout.size
import androidx.compose.foundation.layout.width
import androidx.compose.foundation.layout.widthIn
import androidx.compose.foundation.rememberScrollState
import androidx.compose.foundation.shape.RoundedCornerShape
import androidx.compose.foundation.verticalScroll
import androidx.compose.material3.AlertDialog
import androidx.compose.material3.Icon
import androidx.compose.material3.IconButton
import androidx.compose.material3.MaterialTheme
import androidx.compose.material3.Text
import androidx.compose.material3.TextButton
import androidx.compose.runtime.Composable
import androidx.compose.runtime.getValue
import androidx.compose.runtime.mutableStateListOf
import androidx.compose.runtime.mutableStateOf
import androidx.compose.runtime.remember
import androidx.compose.runtime.setValue
import androidx.compose.ui.Alignment
import androidx.compose.ui.Modifier
import androidx.compose.ui.text.style.TextAlign
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

/**
 * Nowa rozmowa: nowy czat jeden-na-jeden albo droga do nowej grupy.
 *
 * Katalog nie ma listy kontaktów do przeglądania i to jest decyzja, nie brak:
 * lista wszystkich użytkowników mówiłaby każdemu, kto jest w systemie. Rozmowę
 * zaczyna się od nazwy, którą już się zna.
 */
@Composable
fun EkranNowaRozmowa(
    model: ChatViewModel,
    modifier: Modifier = Modifier,
    onWstecz: () -> Unit,
    onGrupa: () -> Unit,
) {
    var nazwa by remember { mutableStateOf("") }
    val stan = model.stan

    Column(modifier = modifier.fillMaxSize()) {
        PasekZPowrotem(t("Nowa rozmowa", "New chat"), onWstecz = onWstecz)

        Column(
            Modifier
                .weight(1f)
                .fillMaxWidth()
                .verticalScroll(rememberScrollState())
                .imePadding()
                .padding(horizontal = Odstep.l),
            verticalArrangement = Arrangement.spacedBy(Odstep.l),
        ) {
            Pole("Nazwa użytkownika · Username", nazwa, { nazwa = it })

            PrzyciskGlowny(
                if (stan.pracuje) "Zaczynam…" else "Nowy czat · Start chat",
                wlaczony = !stan.pracuje && nazwa.isNotBlank(),
            ) {
                model.rozpocznijRozmowe(nazwa.trim())
            }

            // Grupa to osobna droga: zaczyna się od wyboru kilku osób, nie
            // jednej nazwy.
            PrzyciskDrugi("Nowa grupa · New group", wlaczony = !stan.pracuje) { onGrupa() }

            Wskazowka(
                "Katalog przechowuje tylko nazwy, urządzenia i key packages. " +
                    "Kto z kim rozmawia — nie.",
                Ikony.Klucz,
            )
        }
    }
}

/**
 * Nowa grupa: wielokrotny wybór osób z kontaktów plus dodanie po nazwie.
 *
 * # Skąd biorą się kontakty
 *
 * To uczestnicy Twoich ZAAKCEPTOWANYCH rozmów (patrz `ChatViewModel.kontakty`).
 * Kogoś spoza tej listy dodaje się po nazwie użytkownika — katalog nie ma
 * listy do przeglądania.
 *
 * Grupę zakłada pierwsza osoba (`startConversation`), reszta dochodzi kolejnymi
 * `addMember` — inwariant „wszystkie urządzenia jednym commitem" zostaje
 * nietknięty. Nazwa grupy idzie współdzieloną metadaną w chwili utworzenia.
 */
@Composable
fun EkranNowaGrupa(
    model: ChatViewModel,
    modifier: Modifier = Modifier,
    onWstecz: () -> Unit,
) {
    val stan = model.stan
    val kontakty = remember(stan.rozmowy, stan.zaakceptowane) { model.kontakty() }

    var nazwaGrupy by remember { mutableStateOf("") }
    var dopisany by remember { mutableStateOf("") }
    // Wybrane osoby: kontakty zaznaczone plus dopisani po nazwie.
    val wybrani = remember { mutableStateListOf<String>() }

    Column(modifier = modifier.fillMaxSize()) {
        PasekZPowrotem(t("Nowa grupa", "New group"), onWstecz = onWstecz)

        Column(
            Modifier
                .weight(1f)
                .fillMaxWidth()
                .verticalScroll(rememberScrollState())
                .imePadding()
                .padding(horizontal = Odstep.l),
            verticalArrangement = Arrangement.spacedBy(Odstep.l),
        ) {
            Pole("Nazwa grupy · Group name", nazwaGrupy, { nazwaGrupy = it })

            if (kontakty.isNotEmpty()) {
                Text(
                    "Wybierz z kontaktów",
                    style = MaterialTheme.typography.labelMedium,
                    color = Nocturne.kolory.tekstDrugi,
                )
                kontakty.forEach { osoba ->
                    val zaznaczony = osoba in wybrani
                    Row(
                        modifier = Modifier
                            .fillMaxWidth()
                            .defaultMinSize(minHeight = Dotyk.kontrolka)
                            .clickable {
                                if (zaznaczony) wybrani.remove(osoba) else wybrani.add(osoba)
                            },
                        verticalAlignment = Alignment.CenterVertically,
                        horizontalArrangement = Arrangement.spacedBy(Odstep.l),
                    ) {
                        Awatar(model.nick(osoba), rozmiar = 40.dp)
                        Text(model.nick(osoba), style = MaterialTheme.typography.bodyLarge, modifier = Modifier.weight(1f))
                        Icon(
                            imageVector = if (zaznaczony) Ikony.Wyslane else Ikony.Dodaj,
                            contentDescription = if (zaznaczony) "Wybrany" else "Dodaj",
                            tint = if (zaznaczony) Nocturne.kolory.akcentTekst else Nocturne.kolory.tekstTrzeci,
                            modifier = Modifier.size(20.dp),
                        )
                    }
                }
            }

            // Dodanie po nazwie — dla kogoś, z kim jeszcze nie rozmawiasz.
            Text(
                "Dodaj po nazwie",
                style = MaterialTheme.typography.labelMedium,
                color = Nocturne.kolory.tekstDrugi,
            )
            Row(
                verticalAlignment = Alignment.Bottom,
                horizontalArrangement = Arrangement.spacedBy(Odstep.m),
            ) {
                Pole(
                    "Nazwa użytkownika · Username",
                    dopisany,
                    { dopisany = it },
                    modifier = Modifier.weight(1f),
                )
                PrzyciskDrugi(
                    "Dodaj",
                    modifier = Modifier.widthIn(min = 96.dp),
                    wlaczony = dopisany.isNotBlank(),
                ) {
                    val nazwa = dopisany.trim()
                    if (nazwa.isNotEmpty() && nazwa !in wybrani) wybrani.add(nazwa)
                    dopisany = ""
                }
            }

            if (wybrani.isNotEmpty()) {
                Text(
                    "W grupie · ${wybrani.size}",
                    style = MaterialTheme.typography.labelMedium,
                    color = Nocturne.kolory.tekstDrugi,
                )
                wybrani.forEach { osoba ->
                    Row(
                        modifier = Modifier
                            .fillMaxWidth()
                            .defaultMinSize(minHeight = Dotyk.kontrolka),
                        verticalAlignment = Alignment.CenterVertically,
                        horizontalArrangement = Arrangement.spacedBy(Odstep.l),
                    ) {
                        Awatar(model.nick(osoba), rozmiar = 32.dp)
                        Text(model.nick(osoba), style = MaterialTheme.typography.bodyMedium, modifier = Modifier.weight(1f))
                        Icon(
                            Ikony.Zamknij,
                            contentDescription = "Usuń z grupy",
                            tint = Nocturne.kolory.tekstTrzeci,
                            modifier = Modifier
                                .size(18.dp)
                                .clickable { wybrani.remove(osoba) },
                        )
                    }
                }
            }

            PrzyciskGlowny(
                if (stan.pracuje) "Tworzę…" else "Utwórz grupę · Create group",
                wlaczony = !stan.pracuje && wybrani.isNotEmpty(),
            ) {
                model.utworzGrupe(wybrani.toList(), nazwaGrupy.trim())
            }

            Wskazowka(
                "Każdy dołączy ze wszystkimi swoimi urządzeniami. Wcześniejszych wiadomości " +
                    "nie da się nowym osobom pokazać — i jest to zamierzone.",
                Ikony.Klucz,
            )
        }
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
    var pytajOOpuszczenie by remember { mutableStateOf(false) }
    val stan = model.stan
    val uczestnicy = stan.uczestnicy
    val kod = stan.kodBezpieczenstwa
    val grupa = uczestnicy.size > 2
    val groupId = stan.groupId
    val mojeId = model.mojeId

    Column(modifier = modifier.fillMaxSize()) {
        PasekZPowrotem(
            if (grupa) t("Grupa · ${uczestnicy.size} osób", "Group · ${uczestnicy.size} people")
            else t("Rozmowa prywatna", "Private chat"),
            onWstecz = onWstecz,
        )

        Column(
            Modifier
                .weight(1f)
                .fillMaxWidth()
                .verticalScroll(rememberScrollState())
                .imePadding()
                .padding(horizontal = Odstep.l),
            verticalArrangement = Arrangement.spacedBy(Odstep.l),
        ) {
            /*
             * Nazwa grupy — edytowalna i WSPÓŁDZIELONA (metadana MLS), nie
             * lokalna etykieta. Tylko dla grup: rozmowa prywatna nazywa się
             * rozmówcą, nie da się jej „przemianować". Puste pole kasuje nazwę
             * i wraca do sklejanych nicków uczestników.
             */
            if (grupa && groupId != null) {
                EdytorNazwyGrupy(
                    nazwa = stan.nazwyGrup[Historia.klucz(groupId)].orEmpty(),
                    onZapisz = { model.zmienNazweGrupy(groupId, it) },
                )
            }

            uczestnicy.forEach { osoba ->
                val jaTo = osoba == mojeId
                val zablokowana = osoba in stan.zablokowani
                Row(
                    modifier = Modifier
                        .fillMaxWidth()
                        .defaultMinSize(minHeight = Dotyk.kontrolka),
                    verticalAlignment = Alignment.CenterVertically,
                    horizontalArrangement = Arrangement.spacedBy(Odstep.l),
                ) {
                    // Nick tylko przy renderze — pod spodem zostaje nazwa
                    // użytkownika (tożsamość MLS).
                    Awatar(model.nick(osoba), rozmiar = 40.dp)
                    Text(
                        model.nick(osoba),
                        style = MaterialTheme.typography.bodyLarge,
                        modifier = Modifier.weight(1f),
                    )

                    if (jaTo) {
                        Text(
                            "Ty",
                            style = MaterialTheme.typography.labelMedium,
                            color = Nocturne.kolory.tekstDrugi,
                        )
                    } else {
                        // Blokada per osoba — decyzja o TEJ osobie, po jej nazwie
                        // użytkownika (tożsamości MLS), nie po nicku.
                        IconButton(
                            onClick = {
                                if (zablokowana) model.odblokuj(osoba) else model.zablokuj(osoba)
                            },
                        ) {
                            Icon(
                                Ikony.Blokuj,
                                contentDescription = if (zablokowana) "Odblokuj" else "Zablokuj",
                                tint = if (zablokowana) MaterialTheme.colorScheme.error
                                else Nocturne.kolory.tekstTrzeci,
                                modifier = Modifier.size(18.dp),
                            )
                        }
                    }
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

            // Znikanie wiadomości — retencja lokalna tej rozmowy, domyślnie
            // wyłączona (patrz `Znikanie.kt`).
            if (groupId != null) {
                SekcjaZnikania(
                    sekundy = stan.znikanie[Historia.klucz(groupId)],
                    onZmien = { model.zmienZnikanie(groupId, it) },
                )
            }

            if (kod != null) {
                Karta {
                    Row(
                        verticalAlignment = Alignment.CenterVertically,
                        horizontalArrangement = Arrangement.spacedBy(Odstep.m),
                    ) {
                        Icon(Ikony.Odcisk, null, tint = Nocturne.kolory.akcentTekst, modifier = Modifier.size(16.dp))
                        Text("Kod bezpieczeństwa", style = MaterialTheme.typography.labelLarge)
                    }

                    // Cyfry w dwóch wierszach po sześć grup — tak da się je
                    // przeczytać przez telefon bez gubienia miejsca.
                    Text(
                        kod.split(" ").chunked(6).joinToString("\n") { it.joinToString(" ") },
                        style = MaterialTheme.typography.bodyLarge,
                        color = Nocturne.kolory.akcentTekst,
                        modifier = Modifier
                            .fillMaxWidth()
                            .background(Nocturne.kolory.wglebienie, MaterialTheme.shapes.small)
                            .padding(Odstep.m),
                    )

                    Text(
                        "Porównaj innym kanałem — na żywo albo telefonicznie. Porównanie " +
                            "przez tę aplikację nic nie daje: to właśnie ten kanał sprawdzamy.",
                        style = MaterialTheme.typography.bodySmall,
                        color = Nocturne.kolory.tekstDrugi,
                    )
                }

                Wskazowka(
                    "Kod zmienia się przy każdej zmianie składu i przy dołączeniu urządzenia — " +
                        "wtedy trzeba porównać go ponownie.",
                    Ikony.Odcisk,
                )
            }

            // Opuszczenie grupy — NAPRAWDĘ wychodzimy z MLS. Tylko dla grup:
            // z rozmowy prywatnej „wychodzi się" przez usunięcie albo blokadę.
            if (grupa && groupId != null) {
                PrzyciskNiszczacy("Opuść grupę · Leave group") { pytajOOpuszczenie = true }
            }
        }
    }

    if (pytajOOpuszczenie && groupId != null) {
        AlertDialog(
            onDismissRequest = { pytajOOpuszczenie = false },
            title = { Text("Opuścić tę grupę?") },
            text = {
                Text(
                    "Wyjdziesz z grupy u wszystkich — przestaniesz dostawać jej wiadomości. " +
                        "Żeby wrócić, ktoś będzie musiał zaprosić Cię ponownie.",
                )
            },
            confirmButton = {
                TextButton(onClick = {
                    pytajOOpuszczenie = false
                    model.opuscGrupe(groupId)
                    onWstecz()
                }) {
                    Text("Opuść", color = MaterialTheme.colorScheme.error)
                }
            },
            dismissButton = {
                TextButton(onClick = { pytajOOpuszczenie = false }) { Text("Anuluj") }
            },
        )
    }
}

/**
 * Sekcja znikania wiadomości.
 *
 * # Co to znaczy i czego nie znaczy
 *
 * Retencja LOKALNA: po wybranym czasie wiadomości znikają z tego urządzenia.
 * Nie kasuje ich rozmówcy — historia żyje u każdego osobno i nie ma jej gdzie
 * indziej skasować. Mówimy to wprost, bo „znikające wiadomości" łatwo pomylić
 * z obietnicą, której ta wersja nie składa. Domyślnie wyłączone.
 */
@Composable
private fun SekcjaZnikania(sekundy: Long?, onZmien: (Long?) -> Unit) {
    var wlasny by remember { mutableStateOf(false) }
    var ile by remember { mutableStateOf("1") }
    // Domyślna jednostka: godziny (środkowa pozycja listy).
    var jednostka by remember { mutableStateOf(JEDNOSTKI_ZNIKANIA[1].mnoznik) }

    Karta {
        Row(
            verticalAlignment = Alignment.CenterVertically,
            horizontalArrangement = Arrangement.spacedBy(Odstep.m),
        ) {
            Icon(Ikony.Zegar, null, tint = Nocturne.kolory.akcentTekst, modifier = Modifier.size(16.dp))
            Text("Znikające wiadomości", style = MaterialTheme.typography.labelLarge)
        }

        Text(
            if (sekundy != null) "Wiadomości znikają z tego urządzenia po: ${opisZnikania(sekundy)}."
            else "Wyłączone — wiadomości zostają, dopóki ich nie usuniesz.",
            style = MaterialTheme.typography.bodySmall,
            color = Nocturne.kolory.tekstDrugi,
        )

        Row(
            modifier = Modifier
                .fillMaxWidth()
                .horizontalScroll(rememberScrollState()),
            horizontalArrangement = Arrangement.spacedBy(Odstep.s),
        ) {
            PRESETY_ZNIKANIA.forEach { preset ->
                Chip(preset.etykieta, aktywny = sekundy == preset.sekundy) {
                    onZmien(preset.sekundy)
                }
            }
            Chip("Własny…", aktywny = wlasny) { wlasny = !wlasny }
            if (sekundy != null) Chip("Wyłącz", niszczacy = true) { onZmien(null) }
        }

        if (wlasny) {
            Row(
                verticalAlignment = Alignment.CenterVertically,
                horizontalArrangement = Arrangement.spacedBy(Odstep.s),
            ) {
                Pole("Ile", ile, { ile = it.filter { z -> z.isDigit() } }, cyfry = true, modifier = Modifier.width(84.dp))
                JEDNOSTKI_ZNIKANIA.forEach { j ->
                    Chip(j.etykieta, aktywny = jednostka == j.mnoznik) { jednostka = j.mnoznik }
                }
            }
            PrzyciskGlowny("Ustaw", wlaczony = (ile.toLongOrNull() ?: 0) > 0) {
                val liczba = ile.toLongOrNull() ?: return@PrzyciskGlowny
                onZmien(liczba * jednostka)
                wlasny = false
            }
        }
    }
}

/**
 * „Chip" wyboru — obrysowany, akcent jako linia (reguła Nocturne).
 *
 * Zaznaczony chip niesie linię akcentu, nie plamę; „Wyłącz" niesie alarm, też
 * jako linię.
 */
@Composable
private fun Chip(
    tekst: String,
    aktywny: Boolean = false,
    niszczacy: Boolean = false,
    onClick: () -> Unit,
) {
    val kolor = when {
        niszczacy -> MaterialTheme.colorScheme.error
        aktywny -> Nocturne.kolory.akcentTekst
        else -> Nocturne.kolory.liniaMocna
    }
    val tekstKolor = when {
        niszczacy -> MaterialTheme.colorScheme.error
        aktywny -> Nocturne.kolory.akcentTekst
        else -> Nocturne.kolory.tekstDrugi
    }
    Text(
        tekst,
        style = MaterialTheme.typography.labelLarge,
        color = tekstKolor,
        textAlign = TextAlign.Center,
        modifier = Modifier
            .border(1.dp, kolor, RoundedCornerShape(999.dp))
            .clickable(onClick = onClick)
            .padding(horizontal = Odstep.m, vertical = Odstep.s),
    )
}

/**
 * Edytor nazwy grupy w widoku uczestników.
 *
 * Zapis dopiero na przycisk, nie po każdym znaku — zmiana rozsyła metadaną do
 * całej grupy, więc nie ma jej wysyłać przy każdym naciśnięciu. Puste pole
 * zapisane wprost kasuje nazwę (wraca sklejanie nicków uczestników).
 */
@Composable
private fun EdytorNazwyGrupy(nazwa: String, onZapisz: (String) -> Unit) {
    // `remember(nazwa)` przeładowuje pole, gdy nazwa zmieni się z zewnątrz
    // (np. cudzą metadaną) — bez tego edytor zostałby przy starej wartości.
    var pole by remember(nazwa) { mutableStateOf(nazwa) }
    val zmienione = pole.trim() != nazwa.trim()

    Row(
        modifier = Modifier.fillMaxWidth(),
        verticalAlignment = Alignment.Bottom,
        horizontalArrangement = Arrangement.spacedBy(Odstep.m),
    ) {
        Pole("Nazwa grupy · Group name", pole, { pole = it }, modifier = Modifier.weight(1f))
        IconButton(
            onClick = { if (zmienione) onZapisz(pole.trim()) },
            enabled = zmienione,
            modifier = Modifier.size(Dotyk.kontrolka),
        ) {
            Icon(
                Ikony.Wyslane,
                contentDescription = "Zapisz nazwę grupy",
                tint = if (zmienione) Nocturne.kolory.akcentTekst else Nocturne.kolory.tekstTrzeci,
                modifier = Modifier.size(20.dp),
            )
        }
    }
}
