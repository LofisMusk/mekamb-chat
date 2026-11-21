package com.mekamb.chat

import androidx.compose.animation.animateColorAsState
import androidx.compose.animation.core.tween
import androidx.compose.foundation.background
import androidx.compose.foundation.clickable
import androidx.compose.foundation.interaction.MutableInteractionSource
import androidx.compose.foundation.interaction.collectIsPressedAsState
import androidx.compose.foundation.text.BasicTextField
import androidx.compose.ui.draw.clip
import androidx.compose.ui.graphics.Color
import androidx.compose.ui.graphics.SolidColor
import androidx.compose.ui.semantics.Role
import androidx.compose.ui.semantics.contentDescription
import androidx.compose.ui.semantics.semantics
import androidx.compose.ui.text.style.TextAlign
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
import androidx.compose.material3.SwipeToDismissBox
import androidx.compose.material3.SwipeToDismissBoxValue
import androidx.compose.material3.Text
import androidx.compose.material3.rememberSwipeToDismissBoxState
import androidx.compose.runtime.Composable
import androidx.compose.runtime.getValue
import androidx.compose.runtime.mutableStateOf
import androidx.compose.runtime.remember
import androidx.compose.runtime.setValue
import androidx.compose.ui.Alignment
import androidx.compose.ui.Modifier
import androidx.compose.ui.platform.LocalContext
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

/**
 * Gałęzie dolnej nawigacji.
 *
 * Kontaktów już tu nie ma: katalog nie ma listy do przeglądania (mówiłaby
 * każdemu, kto jest w systemie), a rozmowę zaczyna się teraz przez „Nowy czat"
 * albo „Nowa grupa". Zostają dwie: rozmowy i konto.
 */
enum class Galaz { ROZMOWY, KONTO }

@Composable
fun EkranListy(
    model: ChatViewModel,
    modifier: Modifier = Modifier,
    onOtworzRozmowe: (PozycjaListy) -> Unit,
    onNowaRozmowa: () -> Unit,
    onGalaz: (Galaz) -> Unit,
) {
    val stan = model.stan
    val kontekst = LocalContext.current
    // Szukanie jest zawsze widocznym polem pod tytułem, jak w projekcie —
    // a nie trybem włączanym lupą. Pusty ciąg to „nic nie filtruję".
    var szukanie by remember { mutableStateOf("") }

    /*
     * Szukanie filtruje to, co JUŻ jest na urządzeniu.
     *
     * Historia leży w skarbcu i nigdzie indziej, więc nie ma czego pytać
     * serwera — a pytanie go o cokolwiek zdradziłoby, z kim rozmawiamy.
     * Dopasowanie bez rozróżniania wielkości liter, bo nikt nie pamięta,
     * czy zapisał kogoś z dużej.
     */
    /*
     * Rozmowy dzielą się na ZAAKCEPTOWANE i PROŚBY. Prośba to rozmowa obecna
     * w historii, ale spoza zbioru zaakceptowanych (patrz `Prosby.kt`).
     * Szukanie i licznik dotyczą wyłącznie zaakceptowanych — prośba nie ma
     * prawa udawać zwykłej rozmowy.
     */
    // Rozmowy w całości z osobami zablokowanymi znikają z obu list — DM
    // z zablokowanym i grupa złożona z samych zablokowanych (patrz `Blokady.kt`).
    val niezablokowane = stan.rozmowy.filterNot { model.czyCalaZablokowana(it.groupId) }
    val zaakceptowane = niezablokowane.filter { Historia.klucz(it.groupId) in stan.zaakceptowane }
    val prosby = niezablokowane.filter { Historia.klucz(it.groupId) !in stan.zaakceptowane }

    // Etykieta z nickami/nazwą grupy — po niej też szukamy, bo to ją widać.
    val etykieta: (PozycjaListy) -> String = { model.etykieta(it.groupId, it.rozmowca) }

    val widoczne = szukanie.trim().let { fraza ->
        if (fraza.isEmpty()) zaakceptowane
        else zaakceptowane.filter { etykieta(it).contains(fraza, ignoreCase = true) }
    }

    Column(modifier = modifier.fillMaxSize()) {
        // Nagłówek: tytuł ekranu i jedyna akcja główna tego ekranu — „Nowy czat".
        Column(
            modifier = Modifier.fillMaxWidth().padding(start = Odstep.l, end = Odstep.l, top = Odstep.s, bottom = Odstep.m),
            verticalArrangement = Arrangement.spacedBy(Odstep.m),
        ) {
            Row(
                modifier = Modifier.fillMaxWidth(),
                verticalAlignment = Alignment.CenterVertically,
                horizontalArrangement = Arrangement.spacedBy(Odstep.m),
            ) {
                NaglowekEkranu(t("Rozmowy", "Chats"), Modifier.weight(1f))
                PrzyciskGlowny(
                    t("Nowy czat", "New chat"),
                    ikona = Ikony.Dodaj,
                    pelnaSzerokosc = false,
                    onClick = onNowaRozmowa,
                )
            }
            PoleSzukania(
                wartosc = szukanie,
                onZmiana = { szukanie = it },
                onWyczysc = { szukanie = "" },
            )
        }

        // Prośby ponad listą — sekcja z przyjmij/odrzuć. Widoczna tylko wtedy,
        // gdy szukanie jest puste: prośba nie należy do wyników szukania rozmów.
        if (prosby.isNotEmpty() && szukanie.isBlank()) {
            SekcjaProsb(
                prosby = prosby,
                etykieta = etykieta,
                onPrzyjmij = { model.przyjmijProsbe(it) },
                onOdrzuc = { model.odrzucProsbe(it) },
            )
        }

        Column(Modifier.weight(1f).fillMaxWidth()) {
            if (widoczne.isNotEmpty()) {
                LazyColumn(Modifier.fillMaxWidth().weight(1f, fill = false)) {
                    items(widoczne, key = { Historia.klucz(it.groupId) }) { pozycja ->
                        // Przeciągnięcie w lewo usuwa rozmowę. Tylko w lewo —
                        // gest w prawo nie ma tu żadnego znaczenia, a każdy inny
                        // kierunek dałby akcję, której nikt nie chciał.
                        val stanGestu = rememberSwipeToDismissBoxState(
                            confirmValueChange = { wartosc ->
                                if (wartosc == SwipeToDismissBoxValue.EndToStart) {
                                    model.usunRozmowe(pozycja.groupId)
                                    true
                                } else {
                                    false
                                }
                            },
                        )

                        SwipeToDismissBox(
                            state = stanGestu,
                            enableDismissFromStartToEnd = false,
                            backgroundContent = { TloUsuwania() },
                        ) {
                            WierszRozmowy(
                                nazwa = etykieta(pozycja),
                                ostatnia = pozycja.ostatnia?.let {
                                    if (it.wlasna) t("Ty: ", "You: ") + it.tresc else it.tresc
                                } ?: t("brak wiadomości", "no messages"),
                                czas = pozycja.ostatnia?.czas,
                                nieprzeczytane = pozycja.nieprzeczytane,
                                tryb = stan.trybPolaczenia,
                                onClick = { onOtworzRozmowe(pozycja) },
                            )
                        }
                    }
                }
            } else {
                // Pusto z powodu szukania to co innego niż brak rozmów. Jedna
                // wiadomość na oba stany kazałaby użytkownikowi zgadywać, czy
                // niczego nie ma, czy tylko nie znalazł.
                Pusto(
                    ikona = if (szukanie.isBlank()) Ikony.Rozmowy else Ikony.Szukaj,
                    tytul = if (szukanie.isBlank()) {
                        t("Nie masz jeszcze żadnej rozmowy.", "You don't have any chats yet.")
                    } else {
                        t("Nic nie pasuje do tej nazwy.", "Nothing matches that name.")
                    },
                    wskazowka = if (szukanie.isBlank()) {
                        t(
                            "Zacznij od kontaktu — wystarczy nazwa użytkownika.",
                            "Start with a contact — a username is enough.",
                        )
                    } else {
                        t(
                            "Szukamy tylko w rozmowach zapisanych na tym urządzeniu.",
                            "We only search chats stored on this device.",
                        )
                    },
                )
            }

            Spacer(Modifier.height(Odstep.l))
            Wskazowka(
                t(
                    "Historia jest tylko na tym urządzeniu — serwer jej nie ma.",
                    "History lives only on this device — the server doesn't have it.",
                ),
                Ikony.Klucz,
                Modifier.padding(horizontal = Odstep.l),
            )
            Spacer(Modifier.height(Odstep.l))
        }

        DolnaNawigacja(
            biezaca = Galaz.ROZMOWY,
            onGalaz = onGalaz,
            // Licznik liczy TYLKO zaakceptowane — prośba nie podbija badge'a.
            nieprzeczytane = zaakceptowane.sumOf { it.nieprzeczytane },
        )
    }
}

/**
 * Stan pusty: ikona w kółku, zdanie i wskazówka — wyśrodkowane.
 *
 * Tak samo jak `Pusto` na webie: pusta lista ma mówić, co to znaczy, a nie
 * wyglądać jak lista, która się jeszcze nie wczytała.
 */
@Composable
private fun Pusto(ikona: ImageVector, tytul: String, wskazowka: String) {
    Column(
        modifier = Modifier.fillMaxWidth().padding(horizontal = Odstep.xl, vertical = Odstep.xxl),
        horizontalAlignment = Alignment.CenterHorizontally,
        verticalArrangement = Arrangement.spacedBy(Odstep.s),
    ) {
        Box(
            Modifier.size(48.dp).background(Nocturne.kolory.wglebienie, CircleShape),
            contentAlignment = Alignment.Center,
        ) {
            Icon(ikona, contentDescription = null, tint = Nocturne.kolory.tekstDrugi, modifier = Modifier.size(22.dp))
        }
        Text(tytul, style = MaterialTheme.typography.titleSmall, textAlign = TextAlign.Center)
        Text(
            wskazowka,
            style = MaterialTheme.typography.bodySmall,
            color = Nocturne.kolory.tekstDrugi,
            textAlign = TextAlign.Center,
        )
    }
}

/**
 * Pole szukania na liście — zawsze widoczne (cmdk na webie, tu pole u góry).
 *
 * Tło `wglebienie`, bez ramki — na liście szukanie jest jej częścią, a nie
 * osobnym formularzem. Krzyżyk pojawia się dopiero, gdy jest co czyścić.
 */
@Composable
private fun PoleSzukania(wartosc: String, onZmiana: (String) -> Unit, onWyczysc: () -> Unit) {
    val k = Nocturne.kolory
    Row(
        modifier = Modifier
            .fillMaxWidth()
            .defaultMinSize(minHeight = 40.dp)
            .background(k.wglebienie, RoundedCornerShape(Promien.m))
            .padding(start = Odstep.m),
        verticalAlignment = Alignment.CenterVertically,
        horizontalArrangement = Arrangement.spacedBy(Odstep.s),
    ) {
        Icon(Ikony.Szukaj, contentDescription = null, tint = k.tekstDrugi, modifier = Modifier.size(16.dp))
        BasicTextField(
            value = wartosc,
            onValueChange = onZmiana,
            singleLine = true,
            textStyle = MaterialTheme.typography.bodyLarge.copy(color = k.tekst),
            cursorBrush = SolidColor(k.tekst),
            modifier = Modifier.weight(1f).padding(vertical = 10.dp),
            decorationBox = { pole ->
                if (wartosc.isEmpty()) {
                    Text(t("Szukaj rozmów", "Search chats"), style = MaterialTheme.typography.bodyLarge, color = k.tekstTrzeci)
                }
                pole()
            },
        )
        if (wartosc.isNotEmpty()) {
            PrzyciskIkona(Ikony.Zamknij, t("Wyczyść", "Clear"), onWyczysc, kolor = k.tekstDrugi)
        }
    }
}

/**
 * Wiersz rozmowy.
 *
 * Wysokość 64 dp — trafia się w niego kciukiem w ruchu. Pod palcem tło
 * `wglebienie` w 150 ms, bez fali. Droga dostarczania jest ikoną przy nazwie:
 * „bezpośrednio" znaczy, że rozmówca zna Twój adres IP.
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
    val k = Nocturne.kolory
    val zrodlo = remember { MutableInteractionSource() }
    val wcisniety by zrodlo.collectIsPressedAsState()
    val tlo by animateColorAsState(
        if (wcisniety) k.wglebienie else k.tlo,
        tween(Ruch.STAN_MS, easing = Ruch.krzywa),
        label = "tlo-wiersza",
    )
    Row(
        modifier = Modifier
            .fillMaxWidth()
            // Nieprzezroczyste tło: wiersz jedzie NAD tłem usuwania, które ma
            // się pokazać dopiero w odsłoniętym pasku, a nie przeświecać przez
            // treść.
            .background(tlo)
            .defaultMinSize(minHeight = Dotyk.wierszRozmowy)
            .clickable(interactionSource = zrodlo, indication = null, role = Role.Button, onClick = onClick)
            .padding(horizontal = Odstep.l, vertical = Odstep.s),
        verticalAlignment = Alignment.CenterVertically,
        horizontalArrangement = Arrangement.spacedBy(Odstep.m),
    ) {
        Awatar(nazwa, rozmiar = 44.dp)

        Column(Modifier.weight(1f), verticalArrangement = Arrangement.spacedBy(2.dp)) {
            Row(
                verticalAlignment = Alignment.CenterVertically,
                horizontalArrangement = Arrangement.spacedBy(6.dp),
            ) {
                Text(
                    nazwa,
                    style = MaterialTheme.typography.titleSmall,
                    maxLines = 1,
                    overflow = TextOverflow.Ellipsis,
                    modifier = Modifier.weight(1f, fill = false),
                )
                Icon(
                    imageVector = when (tryb) {
                        DeliveryMode.DIRECT -> Ikony.Bezposrednio
                        DeliveryMode.MAILBOX -> Ikony.PrzezSerwer
                        null -> Ikony.BrakSieci
                    },
                    contentDescription = null,
                    tint = k.tekstDrugi,
                    modifier = Modifier.size(13.dp),
                )
            }
            Text(
                ostatnia,
                style = MaterialTheme.typography.bodyMedium,
                color = if (nieprzeczytane > 0) k.tekst else k.tekstDrugi,
                maxLines = 1,
                overflow = TextOverflow.Ellipsis,
            )
        }

        Column(horizontalAlignment = Alignment.End, verticalArrangement = Arrangement.spacedBy(6.dp)) {
            czas?.let {
                Text(
                    GODZINA_LISTY.format(java.util.Date(it)),
                    style = MaterialTheme.typography.labelSmall,
                    color = k.tekstDrugi,
                )
            }
            if (nieprzeczytane > 0) Znacznik(nieprzeczytane)
        }
    }
}

/**
 * Tło odsłaniane przy przeciąganiu wiersza w lewo.
 *
 * `alarm-tlo` i alarm jako ikona z podpisem — czerwień jako poświata, nie
 * plama. Ikona i podpis stoją przy prawej krawędzi, bo stamtąd wychodzi gest.
 */
@Composable
private fun TloUsuwania() {
    Box(
        Modifier
            .fillMaxSize()
            .background(Nocturne.kolory.alarmTlo)
            .padding(horizontal = Odstep.l),
        contentAlignment = Alignment.CenterEnd,
    ) {
        Row(
            verticalAlignment = Alignment.CenterVertically,
            horizontalArrangement = Arrangement.spacedBy(Odstep.s),
        ) {
            Icon(
                Ikony.Kosz,
                contentDescription = null,
                tint = Nocturne.kolory.alarm,
                modifier = Modifier.size(20.dp),
            )
            Text(t("Usuń", "Delete"), style = MaterialTheme.typography.labelMedium, color = Nocturne.kolory.alarm)
        }
    }
}

/**
 * Znacznik nieprzeczytanych — pigułka `glowny`.
 *
 * Wypełniony, bo odpowiada na pytanie „czy ktoś coś do mnie powiedział", a nie
 * jest przyciskiem. Liczba, a nie kropka — „trzy" i „trzydzieści" to inna
 * decyzja o tym, czy zaglądać teraz — i liczba przewija się, gdy rośnie.
 */
@Composable
private fun Znacznik(ile: Int) {
    Box(
        modifier = Modifier
            .defaultMinSize(minWidth = 20.dp, minHeight = 20.dp)
            .background(Nocturne.kolory.znacznik, RoundedCornerShape(Promien.pigulka))
            .padding(horizontal = 6.dp),
        contentAlignment = Alignment.Center,
    ) {
        Licznik(
            ile,
            styl = MaterialTheme.typography.labelSmall.copy(fontWeight = androidx.compose.ui.text.font.FontWeight.SemiBold),
            kolor = Nocturne.kolory.znacznikTekst,
        )
    }
}

/** Godzina ostatniej wiadomości na liście. */
private val GODZINA_LISTY =
    java.text.SimpleDateFormat("HH:mm", java.util.Locale.getDefault())

/**
 * Sekcja próśb ponad listą rozmów.
 *
 * # Po co osobna sekcja
 *
 * Rozmowa od kogoś spoza kontaktów nie wpada między prawdziwe — czeka tu na
 * przyjęcie albo odrzucenie. Przyjęcie robi z nadawcy kontakt; odrzucenie
 * opuszcza grupę (`leave_conversation`) i kasuje ją lokalnie (patrz
 * `ChatViewModel.odrzucProsbe`). Anty-flood: prośba nie dzwoni i nie podbija
 * licznika, dopóki nie zostanie przyjęta.
 */
@Composable
private fun SekcjaProsb(
    prosby: List<PozycjaListy>,
    etykieta: (PozycjaListy) -> String,
    onPrzyjmij: (PozycjaListy) -> Unit,
    onOdrzuc: (PozycjaListy) -> Unit,
) {
    Column(
        Modifier
            .fillMaxWidth()
            .padding(start = Odstep.l, end = Odstep.l, bottom = Odstep.m),
        verticalArrangement = Arrangement.spacedBy(Odstep.s),
    ) {
        Row(
            verticalAlignment = Alignment.CenterVertically,
            horizontalArrangement = Arrangement.spacedBy(6.dp),
        ) {
            Icon(Ikony.Osoby, null, tint = Nocturne.kolory.tekstDrugi, modifier = Modifier.size(14.dp))
            Text(t("Prośby", "Requests"), style = MaterialTheme.typography.labelMedium)
            Licznik(prosby.size, kolor = Nocturne.kolory.tekstDrugi)
        }

        prosby.forEach { pozycja ->
            Row(
                modifier = Modifier
                    .fillMaxWidth()
                    .background(Nocturne.kolory.karta, RoundedCornerShape(Promien.m))
                    .border(1.dp, Nocturne.kolory.linia, RoundedCornerShape(Promien.m))
                    .padding(start = Odstep.m, end = Odstep.xs, top = Odstep.xs, bottom = Odstep.xs),
                verticalAlignment = Alignment.CenterVertically,
                horizontalArrangement = Arrangement.spacedBy(Odstep.s),
            ) {
                Awatar(etykieta(pozycja), rozmiar = 36.dp)
                Column(Modifier.weight(1f)) {
                    Text(
                        etykieta(pozycja),
                        style = MaterialTheme.typography.titleSmall,
                        maxLines = 1,
                        overflow = TextOverflow.Ellipsis,
                    )
                    Text(
                        t("Chce zacząć rozmowę", "Wants to start a chat"),
                        style = MaterialTheme.typography.labelSmall,
                        color = Nocturne.kolory.tekstDrugi,
                    )
                }

                // Odrzuć: duch w kolorze alarmu. Przyjmij: duch w kolorze tekstu.
                // Żadne nie jest plamą — prośba nie jest akcją główną listy.
                PrzyciskIkona(
                    Ikony.Zamknij,
                    t("Odrzuć prośbę", "Reject request"),
                    { onOdrzuc(pozycja) },
                    kolor = Nocturne.kolory.alarm,
                )
                PrzyciskIkona(
                    Ikony.Wyslane,
                    t("Przyjmij prośbę", "Accept request"),
                    { onPrzyjmij(pozycja) },
                )
            }
        }
    }
}

/**
 * Dolny pasek: Rozmowy · Ustawienia.
 *
 * Aktywna gałąź to `tekst`, nieaktywna `tekst-drugi` — bez kolorowej pigułki
 * pod ikoną (Material `NavigationBar` ją rysuje). Pigułka wyglądałaby jak
 * przycisk wciśnięty na stałe, a o tym, gdzie jesteś, mówi już jasność.
 */
@Composable
fun DolnaNawigacja(
    biezaca: Galaz,
    onGalaz: (Galaz) -> Unit,
    modifier: Modifier = Modifier,
    nieprzeczytane: Int = 0,
) {
    Column(modifier.background(Nocturne.kolory.tlo)) {
        Linia()

        Row(Modifier.fillMaxWidth()) {
            Zakladka(
                t("Rozmowy", "Chats"),
                Ikony.Rozmowy,
                biezaca == Galaz.ROZMOWY,
                Modifier.weight(1f),
                nieprzeczytane = nieprzeczytane,
            ) {
                onGalaz(Galaz.ROZMOWY)
            }
            Zakladka(t("Ustawienia", "Settings"), Ikony.Suwaki, biezaca == Galaz.KONTO, Modifier.weight(1f)) {
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
    val k = Nocturne.kolory
    val kolor by animateColorAsState(
        if (aktywna) k.tekst else k.tekstDrugi,
        tween(Ruch.STAN_MS, easing = Ruch.krzywa),
        label = "zakladka",
    )
    Column(
        modifier = modifier
            .defaultMinSize(minHeight = 56.dp)
            .clickable(
                interactionSource = remember { MutableInteractionSource() },
                indication = null,
                role = Role.Tab,
                onClick = onClick,
            )
            .semantics { contentDescription = etykieta }
            .padding(top = Odstep.s, bottom = 6.dp),
        horizontalAlignment = Alignment.CenterHorizontally,
        verticalArrangement = Arrangement.spacedBy(2.dp),
    ) {
        Box(contentAlignment = Alignment.TopEnd) {
            Icon(ikona, contentDescription = null, tint = kolor, modifier = Modifier.size(22.dp))
            if (nieprzeczytane > 0) {
                Box(
                    Modifier
                        .offset(x = 10.dp, y = (-4).dp)
                        .defaultMinSize(minWidth = 16.dp, minHeight = 16.dp)
                        .background(k.znacznik, RoundedCornerShape(Promien.pigulka))
                        .border(1.5.dp, k.tlo, RoundedCornerShape(Promien.pigulka))
                        .padding(horizontal = 4.dp),
                    contentAlignment = Alignment.Center,
                ) {
                    Licznik(
                        nieprzeczytane,
                        styl = MaterialTheme.typography.labelSmall.copy(fontSize = androidx.compose.ui.unit.TextUnit(10f, androidx.compose.ui.unit.TextUnitType.Sp)),
                        kolor = k.znacznikTekst,
                    )
                }
            }
        }
        Text(
            etykieta,
            style = MaterialTheme.typography.labelSmall.copy(
                fontWeight = if (aktywna) androidx.compose.ui.text.font.FontWeight.Medium else androidx.compose.ui.text.font.FontWeight.Normal,
            ),
            color = kolor,
        )
    }
}
