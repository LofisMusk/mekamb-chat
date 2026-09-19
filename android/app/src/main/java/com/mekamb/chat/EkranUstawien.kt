package com.mekamb.chat

import android.net.Uri
import androidx.activity.compose.rememberLauncherForActivityResult
import androidx.activity.result.contract.ActivityResultContracts
import androidx.compose.foundation.layout.Arrangement
import androidx.compose.foundation.layout.Column
import androidx.compose.foundation.layout.Row
import androidx.compose.foundation.layout.defaultMinSize
import androidx.compose.foundation.layout.fillMaxSize
import androidx.compose.foundation.layout.fillMaxWidth
import androidx.compose.foundation.layout.padding
import androidx.compose.foundation.layout.size
import androidx.compose.foundation.rememberScrollState
import androidx.compose.foundation.verticalScroll
import androidx.compose.material3.AlertDialog
import androidx.compose.material3.Icon
import androidx.compose.material3.MaterialTheme
import androidx.compose.material3.Text
import androidx.compose.material3.TextButton
import androidx.compose.runtime.Composable
import androidx.compose.runtime.getValue
import androidx.compose.runtime.mutableStateOf
import androidx.compose.runtime.remember
import androidx.compose.runtime.rememberCoroutineScope
import androidx.compose.runtime.setValue
import androidx.compose.ui.Alignment
import androidx.compose.ui.Modifier
import androidx.compose.ui.platform.LocalContext
import androidx.compose.ui.unit.dp
import kotlinx.coroutines.Dispatchers
import kotlinx.coroutines.launch
import kotlinx.coroutines.withContext
import uniffi.mekamb_ffi.DeliveryMode

/**
 * Powiadomienia i połączenie.
 *
 * # Dlaczego nie ma tu przełączników
 *
 * Projekt przewiduje dwa: push wł./wył. i wybór drogi dostarczania. Żaden nie
 * ma jeszcze pod sobą działania:
 *
 * - **push** wymaga `google-services.json` z projektu Firebase, którego nie ma;
 * - **droga dostarczania** nie jest wyborem użytkownika, tylko wynikiem — klient
 *   zawsze najpierw próbuje wprost, a na skrzynkę spada dopiero, gdy nie
 *   przebije NAT-u. Przełącznik sugerowałby kontrolę, której nie ma.
 *
 * Przełącznik, który nic nie robi, jest gorszy niż jego brak: użytkownik ustawia
 * go i wierzy, że coś się zmieniło. Ekran mówi więc, jak jest, i wprost pisze,
 * czego brakuje.
 */
@Composable
fun EkranUstawien(
    model: ChatViewModel,
    wyborMotywu: WyborMotywu,
    onMotyw: (WyborMotywu) -> Unit,
    akcent: Akcent,
    onAkcent: (Akcent) -> Unit,
    jezyk: Jezyk,
    onJezyk: (Jezyk) -> Unit,
    odczyt: Boolean,
    onOdczyt: (Boolean) -> Unit,
    modifier: Modifier = Modifier,
    onWstecz: () -> Unit,
) {
    val stan = model.stan

    Column(modifier = modifier.fillMaxSize()) {
        PasekZPowrotem(t("Ustawienia", "Settings"), onWstecz = onWstecz)

        // `weight(1f)` jawnie: bez niego kolumna przewijana bierze wysokość
        // z treści i na niskim ekranie ostatnia karta ląduje poza nim, a przy
        // paskach systemowych rysowanych pod treścią nie widać, że coś zostało.
        Column(
            Modifier
                .weight(1f)
                .fillMaxWidth()
                .verticalScroll(rememberScrollState())
                .padding(horizontal = Odstep.l),
            verticalArrangement = Arrangement.spacedBy(Odstep.l),
        ) {
            Karta {
                Row(
                    verticalAlignment = Alignment.CenterVertically,
                    horizontalArrangement = Arrangement.spacedBy(Odstep.m),
                ) {
                    Icon(
                        imageVector = if (Nocturne.kolory.jasny) Ikony.Slonce else Ikony.Ksiezyc,
                        contentDescription = null,
                        tint = Nocturne.kolory.akcent,
                        modifier = Modifier.size(16.dp),
                    )
                    Text(t("Wygląd", "Appearance"), style = MaterialTheme.typography.labelLarge)
                }

                WyborMotywuUI(wybrany = wyborMotywu, onWybor = onMotyw)

                Text(
                    t(
                        "„Systemowy\" idzie za ustawieniem telefonu i zmienia się razem z nim. " +
                            "Wybór jasnego albo ciemnego przestaje go słuchać.",
                        "\"System\" follows your phone setting and changes with it. " +
                            "Picking light or dark stops following it.",
                    ),
                    style = MaterialTheme.typography.bodySmall,
                    color = Nocturne.kolory.tekstDrugi,
                )

                Text(
                    t("Język", "Language"),
                    style = MaterialTheme.typography.labelMedium,
                    color = Nocturne.kolory.tekstDrugi,
                )
                KontrolkaSegmentowa(
                    opcje = Jezyk.entries,
                    wybrana = jezyk,
                    etykieta = { it.etykieta },
                    onWybor = onJezyk,
                )

                Text(
                    t("Kolor akcentu", "Accent colour"),
                    style = MaterialTheme.typography.labelMedium,
                    color = Nocturne.kolory.tekstDrugi,
                )
                WyborAkcentu(wybrany = akcent, onWybor = onAkcent)
            }

            /*
             * Nazwa wyświetlana (nick) — WARSTWA WYŚWIETLANIA.
             *
             * To, jak widzą Cię inni. Rozsyłamy ją współdzieloną metadaną do
             * wszystkich zaakceptowanych rozmów; tożsamością w MLS i adresem
             * skrzynki zostaje nazwa użytkownika (patrz `Nazwy.kt`). Do próśb
             * nie wysyłamy nic — nie ogłaszamy się komuś, z kim jeszcze nie
             * zgodziliśmy się rozmawiać.
             */
            Karta {
                Row(
                    verticalAlignment = Alignment.CenterVertically,
                    horizontalArrangement = Arrangement.spacedBy(Odstep.m),
                ) {
                    Icon(Ikony.Konto, null, tint = Nocturne.kolory.akcentTekst, modifier = Modifier.size(16.dp))
                    Text(t("Nazwa wyświetlana", "Display name"), style = MaterialTheme.typography.labelLarge)
                }

                var nick by remember(stan.mojNick) { mutableStateOf(stan.mojNick) }
                val zmienione = nick.trim() != stan.mojNick.trim()

                Pole(t("Nazwa wyświetlana", "Display name"), nick, { nick = it })
                PrzyciskDrugi(t("Zapisz", "Save"), wlaczony = zmienione) { model.zmienMojNick(nick.trim()) }

                Text(
                    t(
                        "Widzą ją Twoi rozmówcy zamiast nazwy użytkownika. Zostawiona pusta " +
                            "wraca do nazwy użytkownika.",
                        "Your contacts see this instead of your username. Left empty, it " +
                            "falls back to your username.",
                    ),
                    style = MaterialTheme.typography.bodySmall,
                    color = Nocturne.kolory.tekstDrugi,
                )
            }

            /*
              Potwierdzenia odczytu w ustawieniach, nie w rozmowie.

              To decyzja o tym, ile o sobie mówisz — dotyczy każdej rozmowy
              naraz, więc miejscem są ustawienia, a nie pojedynczy wątek.
            */
            Karta {
                Row(
                    verticalAlignment = Alignment.CenterVertically,
                    horizontalArrangement = Arrangement.spacedBy(Odstep.m),
                ) {
                    Icon(
                        Ikony.Dostarczone,
                        contentDescription = null,
                        tint = Nocturne.kolory.akcent,
                        modifier = Modifier.size(16.dp),
                    )
                    Text(t("Potwierdzenia odczytu", "Read receipts"), style = MaterialTheme.typography.labelLarge)
                }

                Przelacznik(
                    etykieta = t("Wysyłaj potwierdzenia odczytu", "Send read receipts"),
                    zaznaczony = odczyt,
                    onZmiana = onOdczyt,
                )

                /*
                 * Zostaje jedno zdanie: to, które zmienia decyzję.
                 *
                 * Opóźnienie, zbiorcza wysyłka i „chwila wysłania koperty"
                 * opisywały, JAK to zrobiliśmy — a pod przełącznikiem stoi
                 * pytanie, czy go zostawić włączonym. Na to odpowiada
                 * wyłącznie wzajemność. Słowo „koperta" znaczy zresztą coś
                 * tylko dla nas.
                 */
                Text(
                    t(
                        "Kiedy je wyłączysz, przestaniesz też widzieć cudze.",
                        "Turn them off and you stop seeing other people's too.",
                    ),
                    style = MaterialTheme.typography.bodySmall,
                    color = Nocturne.kolory.tekstDrugi,
                )
            }

            /*
              Zablokowani — jedyne miejsce, z którego da się ich odblokować.

              Blokada ukrywa rozmowę z tą osobą, więc panelu uczestników już się
              nie otworzy: gdyby odblokowanie było tylko tam, blokada byłaby
              pułapką bez wyjścia. Karta pojawia się dopiero, gdy jest kogo pokazać.
            */
            if (stan.zablokowani.isNotEmpty()) {
                Karta {
                    Row(
                        verticalAlignment = Alignment.CenterVertically,
                        horizontalArrangement = Arrangement.spacedBy(Odstep.m),
                    ) {
                        Icon(
                            Ikony.Blokuj,
                            contentDescription = null,
                            tint = Nocturne.kolory.akcent,
                            modifier = Modifier.size(16.dp),
                        )
                        Text(t("Zablokowani", "Blocked"), style = MaterialTheme.typography.labelLarge)
                    }

                    Text(
                        t(
                            "Nie dostajesz od nich wiadomości ani zaproszeń. Odblokowanie " +
                                "przywraca rozmowy i wszystko, co przyszło w międzyczasie.",
                            "You get no messages or invites from them. Unblocking restores " +
                                "the chats and everything that arrived meanwhile.",
                        ),
                        style = MaterialTheme.typography.bodySmall,
                        color = Nocturne.kolory.tekstDrugi,
                    )

                    stan.zablokowani.sorted().forEach { osoba ->
                        Row(
                            modifier = Modifier
                                .fillMaxWidth()
                                .defaultMinSize(minHeight = Dotyk.kontrolka),
                            verticalAlignment = Alignment.CenterVertically,
                            horizontalArrangement = Arrangement.spacedBy(Odstep.m),
                        ) {
                            Text(
                                model.nick(osoba),
                                style = MaterialTheme.typography.bodyLarge,
                                modifier = Modifier.weight(1f),
                            )
                            TextButton(onClick = { model.odblokuj(osoba) }) { Text(t("Odblokuj", "Unblock")) }
                        }
                    }
                }
            }

            KopiaZapasowa(model)

            Karta {
                Row(
                    verticalAlignment = Alignment.CenterVertically,
                    horizontalArrangement = Arrangement.spacedBy(Odstep.m),
                ) {
                    Icon(Ikony.Dzwonek, null, tint = Nocturne.kolory.tekstTrzeci, modifier = Modifier.size(16.dp))
                    Text(t("Powiadomienia push", "Push notifications"), style = MaterialTheme.typography.labelLarge)
                    Text(
                        t("niedostępne", "unavailable"),
                        style = MaterialTheme.typography.labelSmall,
                        color = Nocturne.kolory.tekstTrzeci,
                    )
                }
                // Sama informacja, że push nie działa — bo ona zmienia
                // zachowanie: o nowej wiadomości dowiesz się dopiero po
                // otwarciu aplikacji. Obietnice o przyszłym kształcie ładunku
                // nie zmieniają dziś niczyjej decyzji.
                Text(
                    t(
                        "Ta wersja ich nie ma. O nowej wiadomości dowiesz się dopiero po otwarciu " +
                            "aplikacji.",
                        "This build doesn't have them. You'll learn about a new message only " +
                            "after opening the app.",
                    ),
                    style = MaterialTheme.typography.bodySmall,
                    color = Nocturne.kolory.tekstDrugi,
                )
            }

            Karta {
                Row(
                    verticalAlignment = Alignment.CenterVertically,
                    horizontalArrangement = Arrangement.spacedBy(Odstep.m),
                ) {
                    Icon(
                        imageVector = when (stan.trybPolaczenia) {
                            DeliveryMode.DIRECT -> Ikony.Bezposrednio
                            DeliveryMode.MAILBOX -> Ikony.PrzezSerwer
                            null -> Ikony.BrakSieci
                        },
                        contentDescription = null,
                        tint = if (stan.trybPolaczenia == null) Nocturne.kolory.tekstTrzeci else Nocturne.kolory.akcent,
                        modifier = Modifier.size(16.dp),
                    )
                    Text(t("Droga dostarczania", "Delivery path"), style = MaterialTheme.typography.labelLarge)
                    Text(
                        when (stan.trybPolaczenia) {
                            DeliveryMode.DIRECT -> t("bezpośrednio", "direct")
                            DeliveryMode.MAILBOX -> t("przez serwer", "via server")
                            null -> t("brak połączenia", "no connection")
                        },
                        style = MaterialTheme.typography.labelSmall,
                        color = Nocturne.kolory.tekstDrugi,
                    )
                }
                Text(
                    t(
                        "Nie da się jej wybrać — klient zawsze najpierw próbuje wprost, a na " +
                            "skrzynkę spada dopiero, gdy nie przebije NAT-u.",
                        "You can't pick it — the client always tries direct first and falls " +
                            "back to the mailbox only when it can't punch through NAT.",
                    ),
                    style = MaterialTheme.typography.bodySmall,
                    color = Nocturne.kolory.tekstDrugi,
                )
                Text(
                    t(
                        "Bezpośrednio: media idą wprost, więc rozmówca zna Twój adres IP. " +
                            "Przez serwer: adres zna serwer.",
                        "Direct: media goes straight through, so your contact sees your IP. " +
                            "Via server: the server sees it.",
                    ),
                    style = MaterialTheme.typography.bodySmall,
                    color = Nocturne.kolory.tekstDrugi,
                )
            }

            Ostrzezenie(
                t(
                    "Wersja bez audytu. Nie używaj tam, gdzie ujawnienie treści miałoby poważne " +
                        "konsekwencje.",
                    "Unaudited build. Don't use it where disclosure of content would have " +
                        "serious consequences.",
                ),
            )

            Text(
                "mekamb ${BuildConfig.VERSION_NAME}",
                style = MaterialTheme.typography.labelSmall,
                color = Nocturne.kolory.tekstTrzeci,
            )
        }
    }
}

private enum class TrybKopii { EKSPORT, IMPORT }

/**
 * Eksport i import rozmów do zaszyfrowanego pliku ZIP.
 *
 * # Dlaczego hasło, a nie zwykły plik
 *
 * Historia w telefonie jest zaszyfrowana kluczem z Keystore, który nie opuszcza
 * urządzenia. Plik ma dać się otworzyć gdzie indziej, więc chroni go jedyny
 * sekret, który zna człowiek: hasło. Zrzucenie jawnej historii do pliku oddałoby
 * treść rozmów każdemu, kto go przeczyta — cała ochrona pliku to Argon2id
 * i AES-256-GCM w rdzeniu (`core/src/kopia.rs`).
 *
 * # Dlaczego hasło pytamy w innej chwili przy eksporcie i imporcie
 *
 * Eksport: najpierw hasło, potem wybór, gdzie zapisać — hasło szyfruje to, co
 * zaraz powstanie. Import: najpierw plik, bo trzeba go mieć, żeby było co
 * odszyfrować, a dopiero potem hasło do niego. Kolejność idzie za tym, co jest
 * po co.
 */
@Composable
private fun KopiaZapasowa(model: ChatViewModel) {
    val kontekst = LocalContext.current
    val zakres = rememberCoroutineScope()
    // Język odczytany raz — komunikaty powstają w lambdach launchera i korutyny,
    // gdzie nie ma już kontekstu Compose, więc `t(pl, en)` tam nie zadziała.
    val jezyk = LokalnyJezyk.current

    var dialog by remember { mutableStateOf<TrybKopii?>(null) }
    var haslo by remember { mutableStateOf("") }
    var zipDoImportu by remember { mutableStateOf<Uri?>(null) }
    var komunikat by remember { mutableStateOf<String?>(null) }
    var pracuje by remember { mutableStateOf(false) }

    // Zapis do wybranego pliku — SAF sam pyta, gdzie i pod jaką nazwą. Hasło
    // jest już w stanie z dialogu, który poprzedził ten wybór.
    val zapisz = rememberLauncherForActivityResult(
        ActivityResultContracts.CreateDocument("application/zip"),
    ) { uri ->
        val cel = uri ?: run { haslo = ""; return@rememberLauncherForActivityResult }
        val h = haslo
        haslo = ""
        zakres.launch {
            pracuje = true
            komunikat = null
            val zip = model.eksportujRozmowy(h)
            if (zip != null) {
                val zapisano = runCatching {
                    withContext(Dispatchers.IO) {
                        kontekst.contentResolver.openOutputStream(cel)?.use { it.write(zip) }
                            ?: error("brak dostępu do pliku")
                    }
                }.isSuccess
                komunikat =
                    if (zapisano) t(jezyk, "Wyeksportowano rozmowy do pliku.", "Chats exported to the file.") else t(jezyk, "Nie udało się zapisać pliku.", "Couldn't save the file.")
            }
            pracuje = false
        }
    }

    // Wybór pliku do wczytania — najpierw plik, potem (w dialogu) hasło do niego.
    val wczytaj = rememberLauncherForActivityResult(
        ActivityResultContracts.OpenDocument(),
    ) { uri ->
        if (uri != null) {
            zipDoImportu = uri
            dialog = TrybKopii.IMPORT
        }
    }

    Karta {
        Row(
            verticalAlignment = Alignment.CenterVertically,
            horizontalArrangement = Arrangement.spacedBy(Odstep.m),
        ) {
            Icon(Ikony.Klucz, null, tint = Nocturne.kolory.akcentTekst, modifier = Modifier.size(16.dp))
            Text(t("Kopia rozmów", "Chat backup"), style = MaterialTheme.typography.labelLarge)
        }

        Text(
            t(
                "Wyeksportuj rozmowy do pliku ZIP chronionego hasłem albo wczytaj je z takiego " +
                    "pliku. Import dokłada rozmowy do istniejących, nie kasuje ich.",
                "Export your chats to a password-protected ZIP file, or load them back from " +
                    "one. Import adds chats to the existing ones, it doesn't erase them.",
            ),
            style = MaterialTheme.typography.bodySmall,
            color = Nocturne.kolory.tekstDrugi,
        )

        PrzyciskDrugi(t("Eksportuj rozmowy", "Export chats"), wlaczony = !pracuje) {
            komunikat = null
            dialog = TrybKopii.EKSPORT
        }
        PrzyciskDrugi(t("Importuj rozmowy", "Import chats"), wlaczony = !pracuje) {
            komunikat = null
            wczytaj.launch(arrayOf("application/zip", "application/octet-stream", "*/*"))
        }

        komunikat?.let {
            Text(it, style = MaterialTheme.typography.bodySmall, color = Nocturne.kolory.tekstDrugi)
        }

        Wskazowka(
            t(
                "Plik chroni wyłącznie hasło. Zapomnianego hasła nie da się obejść — kopia " +
                    "zostaje wtedy nie do otwarcia.",
                "Only the password protects the file. A forgotten password can't be worked " +
                    "around — the backup then stays unopenable.",
            ),
            Ikony.Klucz,
        )
    }

    dialog?.let { tryb ->
        DialogHaslaKopii(
            tryb = tryb,
            haslo = haslo,
            onHaslo = { haslo = it },
            onAnuluj = {
                dialog = null
                haslo = ""
                zipDoImportu = null
            },
            onZatwierdz = {
                dialog = null
                when (tryb) {
                    TrybKopii.EKSPORT -> zapisz.launch("rozmowy-mekamb.zip")
                    TrybKopii.IMPORT -> {
                        val zrodlo = zipDoImportu
                        val h = haslo
                        haslo = ""
                        zipDoImportu = null
                        if (zrodlo != null) {
                            zakres.launch {
                                pracuje = true
                                komunikat = null
                                val bajty = runCatching {
                                    withContext(Dispatchers.IO) {
                                        kontekst.contentResolver.openInputStream(zrodlo)
                                            ?.use { it.readBytes() }
                                    }
                                }.getOrNull()

                                if (bajty == null) {
                                    komunikat = t(jezyk, "Nie udało się odczytać pliku.", "Couldn't read the file.")
                                } else {
                                    val wynik = model.importujRozmowy(h, bajty)
                                    if (wynik != null) {
                                        komunikat = t(
                                            jezyk,
                                            "Zaimportowano: ${wynik.rozmow} rozmów, ${wynik.wiadomosci} nowych wiadomości.",
                                            "Imported: ${wynik.rozmow} chats, ${wynik.wiadomosci} new messages.",
                                        )
                                    }
                                    // Gdy `wynik` jest null, model ustawił już błąd w stanie.
                                }
                                pracuje = false
                            }
                        }
                    }
                }
            },
        )
    }
}

/**
 * Pytanie o hasło do kopii — osobne dla eksportu i importu.
 *
 * Eksport pyta o hasło do NADANIA plikowi, import o hasło, którym plik już
 * zaszyfrowano. Przycisk jest nieaktywny przy pustym haśle: pusta kopia to nie
 * kopia, tylko jawny zrzut, a rdzeń i tak by go odrzucił.
 */
@Composable
private fun DialogHaslaKopii(
    tryb: TrybKopii,
    haslo: String,
    onHaslo: (String) -> Unit,
    onAnuluj: () -> Unit,
    onZatwierdz: () -> Unit,
) {
    AlertDialog(
        onDismissRequest = onAnuluj,
        title = {
            Text(if (tryb == TrybKopii.EKSPORT) t("Hasło do kopii", "Backup password") else t("Hasło pliku", "File password"))
        },
        text = {
            Column(verticalArrangement = Arrangement.spacedBy(Odstep.m)) {
                Text(
                    if (tryb == TrybKopii.EKSPORT) {
                        t(
                            "Ustaw hasło, którym zaszyfrujemy plik. Bez niego kopii nikt nie otworzy — " +
                                "łącznie z Tobą, jeśli je zapomnisz.",
                            "Set a password we'll encrypt the file with. Without it no one opens " +
                                "the backup — including you, if you forget it.",
                        )
                    } else {
                        t(
                            "Podaj hasło, którym ten plik zaszyfrowano przy eksporcie.",
                            "Enter the password this file was encrypted with on export.",
                        )
                    },
                    style = MaterialTheme.typography.bodySmall,
                    color = Nocturne.kolory.tekstDrugi,
                )
                Pole(t("Hasło", "Password"), haslo, onHaslo, haslo = true)
            }
        },
        confirmButton = {
            TextButton(onClick = onZatwierdz, enabled = haslo.isNotEmpty()) {
                Text(if (tryb == TrybKopii.EKSPORT) t("Eksportuj", "Export") else t("Importuj", "Import"))
            }
        },
        dismissButton = {
            TextButton(onClick = onAnuluj) { Text(t("Anuluj", "Cancel")) }
        },
    )
}
