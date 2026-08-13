package com.mekamb.chat

import android.graphics.BitmapFactory
import androidx.activity.compose.BackHandler
import androidx.activity.compose.rememberLauncherForActivityResult
import androidx.activity.result.contract.ActivityResultContracts
import androidx.compose.foundation.Image
import androidx.compose.foundation.background
import androidx.compose.foundation.clickable
import androidx.compose.foundation.layout.heightIn
import androidx.compose.foundation.layout.imePadding
import androidx.compose.ui.draw.clip
import androidx.compose.ui.graphics.ImageBitmap
import androidx.compose.ui.graphics.asImageBitmap
import androidx.compose.ui.layout.ContentScale
import androidx.lifecycle.viewmodel.compose.viewModel
import androidx.compose.foundation.layout.Arrangement
import androidx.compose.foundation.layout.Box
import androidx.compose.foundation.layout.Column
import androidx.compose.foundation.layout.Row
import androidx.compose.foundation.layout.fillMaxSize
import androidx.compose.foundation.layout.fillMaxWidth
import androidx.compose.foundation.layout.height
import androidx.compose.foundation.layout.padding
import androidx.compose.foundation.layout.size
import androidx.compose.foundation.layout.widthIn
import androidx.compose.foundation.lazy.LazyColumn
import androidx.compose.foundation.lazy.items
import androidx.compose.foundation.lazy.rememberLazyListState
import androidx.compose.foundation.shape.CircleShape
import androidx.compose.foundation.shape.RoundedCornerShape
import androidx.compose.foundation.border
import androidx.compose.ui.draw.alpha
import androidx.compose.material3.Icon
import androidx.compose.material3.IconButton
import androidx.compose.material3.MaterialTheme
import androidx.compose.material3.OutlinedTextField
import androidx.compose.material3.OutlinedTextFieldDefaults
import androidx.compose.material3.Text
import androidx.compose.runtime.Composable
import androidx.compose.runtime.LaunchedEffect
import androidx.compose.runtime.getValue
import androidx.compose.runtime.mutableStateOf
import androidx.compose.runtime.remember
import androidx.compose.runtime.setValue
import androidx.compose.ui.Alignment
import androidx.compose.ui.Modifier
import androidx.compose.ui.text.style.TextOverflow
import androidx.compose.ui.unit.dp
import java.text.SimpleDateFormat
import java.util.Date
import java.util.Locale
import uniffi.mekamb_ffi.DeliveryMode

/**
 * Ekran rozmowy.
 *
 * # Co się zmieniło
 *
 * Wiadomości były jednakowymi kartami z nazwą autora nad treścią — nie dało się
 * rzutem oka odróżnić swoich od cudzych. Teraz mają stronę, kolor i godzinę,
 * czyli to, po czym rozpoznaje się rozmowę bez czytania.
 *
 * # Droga dostarczania jest przy nazwie rozmówcy
 *
 * Nie na dole ekranu i nie w ustawieniach. „Bezpośrednio" znaczy, że rozmówca
 * zna Twój adres IP — to informacja o Tobie, więc ma być tam, gdzie patrzysz,
 * pisząc do kogoś.
 */

/** Godzina wiadomości. Bez daty — dzień rozdziela osobna etykieta. */
private val GODZINA = SimpleDateFormat("HH:mm", Locale.getDefault())

/** Inicjały do awatara. Dwie litery, bo tyle mieści się czytelnie w kółku. */
internal fun inicjaly(nazwa: String): String =
    nazwa.split(" ", ".", "-", "_")
        .filter { it.isNotBlank() }
        .take(2)
        .joinToString("") { it.first().uppercase() }
        .ifBlank { nazwa.take(1).uppercase() }

@Composable
fun EkranRozmowy(
    model: ChatViewModel,
    modifier: Modifier = Modifier,
    onWstecz: () -> Unit,
    onUczestnicy: () -> Unit,
    onRozmowa: (wideo: Boolean) -> Unit,
) {
    var tresc by remember { mutableStateOf("") }
    var arkuszZalacznikow by remember { mutableStateOf(false) }
    val stan = model.stan
    val lista = rememberLazyListState()

    // Wybór pliku oddajemy systemowi. Aplikacja nie prosi o dostęp do galerii
    // ani do pamięci — dostaje adres jednego dokumentu, który użytkownik sam
    // wskazał, i nic poza nim. Uprawnienie, o które się nie prosi, nie może
    // zostać nadużyte.
    val wybierz = rememberLauncherForActivityResult(ActivityResultContracts.GetContent()) { uri ->
        arkuszZalacznikow = false
        uri?.let(model::wyslijZalacznik)
    }

    /*
     * Układ liczony raz, nad listą.
     *
     * Rozdzielacze dni i sklejanie w bloki są decyzjami o sąsiedztwie, więc
     * mieszkają w `ulozWatek` — tam też są sprawdzone testem i trzymane
     * w zgodzie z webem.
     *
     * Musi stać TUTAJ, a nie w środku `LazyColumn`: przewijanie do najnowszej
     * wiadomości potrzebuje liczby POZYCJI, a nie liczby wiadomości. Rozdzielacz
     * dnia też zajmuje pozycję, więc liczenie po samych wiadomościach zatrzymuje
     * listę kilka dymków przed końcem — i to tym bardziej, im dłuższa rozmowa.
     */
    val uklad = ulozWatek(stan.wiadomosci, System.currentTimeMillis())

    // Nowa wiadomość ma być widoczna bez przewijania. Bez tego rozmowa
    // „stoi" na starej treści i wygląda, jakby nic nie przyszło.
    LaunchedEffect(uklad.size, stan.wLocie.size) {
        val ile = uklad.size + stan.wLocie.size
        if (ile > 0) lista.animateScrollToItem(ile - 1)
    }

    // Arkusz zamyka się systemowym „wstecz" wcześniej niż rozmowa — inaczej
    // pierwsze cofnięcie zabierałoby cały ekran zamiast schować to, co na nim
    // przed chwilą wyskoczyło.
    BackHandler(enabled = arkuszZalacznikow) { arkuszZalacznikow = false }

    Box(modifier.fillMaxSize()) {
    /*
     * `imePadding` na całej rozmowie, nie na samym polu pisania.
     *
     * Aplikacja rysuje od krawędzi do krawędzi, a od Androida 15 okno nie
     * zmniejsza się już samo pod klawiaturę mimo `adjustResize` w manifeście.
     * Bez tego pole pisania i przycisk wysyłania chowają się POD klawiaturą,
     * której otwarcie samo je wywołało — czyli nie da się wysłać wiadomości,
     * którą właśnie się pisze. Odsunięcie całej kolumny, a nie samego pola,
     * zabiera ze sobą listę: inaczej ostatni dymek zostaje pod klawiaturą
     * i nie widać tego, na co się właśnie odpowiada.
     */
    Column(modifier = Modifier.fillMaxSize().imePadding()) {
        PasekRozmowy(
            nazwa = stan.rozmowca ?: "rozmowa",
            tryb = stan.trybPolaczenia,
            onWstecz = onWstecz,
            onUczestnicy = onUczestnicy,
            onRozmowa = onRozmowa,
        )

        LazyColumn(
            state = lista,
            modifier = Modifier.fillMaxWidth().weight(1f).padding(horizontal = Odstep.l),
            verticalArrangement = Arrangement.spacedBy(Odstep.m),
            contentPadding = androidx.compose.foundation.layout.PaddingValues(vertical = Odstep.l),
        ) {
            items(uklad, key = { it.klucz }) { pozycja ->
                when (pozycja) {
                    is PozycjaWatku.Dzien -> RozdzielaczDnia(pozycja.etykieta)
                    is PozycjaWatku.Dymek -> Babel(pozycja.wiadomosc, pozycja.ciag)
                }
            }

            // Wiadomości w locie zawsze na końcu — są najświeższe z definicji.
            items(stan.wLocie) { w -> BabelWLocie(w) }
        }

        PoleWysylki(
            tresc = tresc,
            onZmiana = { tresc = it },
            wlaczone = !stan.pracuje,
            onWyslij = { model.wyslij(tresc) { tresc = "" } },
            onZalacz = { arkuszZalacznikow = true },
        )
    }

        if (arkuszZalacznikow) {
            ArkuszZalacznikow(
                onZamknij = { arkuszZalacznikow = false },
                onWybierz = { typ -> wybierz.launch(typ) },
            )
        }
    }
}

/**
 * Arkusz wyboru załącznika.
 *
 * Cztery drogi, bo prowadzą do różnych miejsc systemu: galeria zdjęć, galeria
 * nagrań i dowolny plik to trzy różne filtry tego samego wyboru.
 *
 * Notka o szyfrowaniu i metadanych stoi tutaj, a nie po wysłaniu: obietnica
 * pokazana po fakcie nie daje już wyboru.
 */
@Composable
private fun ArkuszZalacznikow(onZamknij: () -> Unit, onWybierz: (String) -> Unit) {
    Box(
        Modifier
            .fillMaxSize()
            .background(Nocturne.kolory.zaslona)
            .clickable(onClick = onZamknij),
        contentAlignment = Alignment.BottomCenter,
    ) {
        Column(
            modifier = Modifier
                .fillMaxWidth()
                .background(Nocturne.kolory.karta, RoundedCornerShape(14.dp, 14.dp, 0.dp, 0.dp))
                // Kliknięcie w sam arkusz nie może go zamykać — zamyka je
                // dopiero kliknięcie w zasłonę obok.
                .clickable(enabled = false) {}
                .padding(Odstep.l),
            verticalArrangement = Arrangement.spacedBy(Odstep.m),
        ) {
            Box(
                Modifier
                    .align(Alignment.CenterHorizontally)
                    .size(width = 36.dp, height = 4.dp)
                    .background(Nocturne.kolory.liniaMocna, RoundedCornerShape(2.dp)),
            )

            Text("Załącz · Attach", style = MaterialTheme.typography.titleMedium)

            Row(horizontalArrangement = Arrangement.spacedBy(Odstep.s)) {
                KafelekZalacznika("Zdjęcie", Ikony.Aparat, Modifier.weight(1f)) {
                    onWybierz("image/*")
                }
                KafelekZalacznika("Wideo", Ikony.Kamera, Modifier.weight(1f)) {
                    onWybierz("video/*")
                }
            }
            Row(horizontalArrangement = Arrangement.spacedBy(Odstep.s)) {
                KafelekZalacznika("Dźwięk", Ikony.Dzwonek, Modifier.weight(1f)) {
                    onWybierz("audio/*")
                }
                KafelekZalacznika("Plik", Ikony.Spinacz, Modifier.weight(1f)) {
                    onWybierz("*/*")
                }
            }

            // Zostaje, bo mówi o tym, co robimy z PLIKIEM, zanim go wyślemy —
            // i o tym, że może się nie udać. To zmienia decyzję: przy takim
            // ostrzeżeniu zdjęcie z lokalizacją można wysłać świadomie albo
            // wcale. Zdanie o szyfrowaniu każdego pliku osobnym kluczem
            // zniknęło — było zapewnieniem, po którym nic nie zależy.
            Wskazowka(
                "Lokalizację i dane urządzenia usuwamy PRZED wysłaniem. Gdy się nie uda, " +
                    "napiszemy to przy wiadomości.",
                Ikony.Tarcza,
            )
        }
    }
}

@Composable
private fun KafelekZalacznika(
    etykieta: String,
    ikona: androidx.compose.ui.graphics.vector.ImageVector,
    modifier: Modifier = Modifier,
    onClick: () -> Unit,
) {
    Column(
        modifier = modifier
            .border(1.dp, Nocturne.kolory.linia, RoundedCornerShape(10.dp))
            .clickable(onClick = onClick)
            .padding(vertical = Odstep.l),
        horizontalAlignment = Alignment.CenterHorizontally,
        verticalArrangement = Arrangement.spacedBy(Odstep.xs),
    ) {
        Icon(ikona, contentDescription = null, tint = Nocturne.kolory.tekst, modifier = Modifier.size(24.dp))
        Text(etykieta, style = MaterialTheme.typography.bodyMedium)
    }
}

@Composable
private fun PasekRozmowy(
    nazwa: String,
    tryb: DeliveryMode?,
    onWstecz: () -> Unit,
    onUczestnicy: () -> Unit,
    onRozmowa: (Boolean) -> Unit,
) {
    Column {
        Row(
            modifier = Modifier.fillMaxWidth().padding(horizontal = Odstep.s, vertical = Odstep.s),
            verticalAlignment = Alignment.CenterVertically,
            horizontalArrangement = Arrangement.spacedBy(Odstep.s),
        ) {
            IconButton(onClick = onWstecz, modifier = Modifier.size(Dotyk.ikonaWPasku)) {
                Icon(Ikony.Wstecz, contentDescription = "Wróć", tint = Nocturne.kolory.tekst)
            }

            Awatar(nazwa, rozmiar = 36.dp)

            Column(Modifier.weight(1f)) {
                Text(
                    nazwa,
                    style = MaterialTheme.typography.titleMedium,
                    maxLines = 1,
                    overflow = TextOverflow.Ellipsis,
                )
                Row(
                    verticalAlignment = Alignment.CenterVertically,
                    horizontalArrangement = Arrangement.spacedBy(Odstep.xs),
                ) {
                    Icon(
                        imageVector = when (tryb) {
                            DeliveryMode.DIRECT -> Ikony.Bezposrednio
                            DeliveryMode.MAILBOX -> Ikony.PrzezSerwer
                            null -> Ikony.BrakSieci
                        },
                        contentDescription = null,
                        tint = Nocturne.kolory.tekstDrugi,
                        modifier = Modifier.size(12.dp),
                    )
                    Text(
                        text = when (tryb) {
                            DeliveryMode.DIRECT -> "bezpośrednio — zna Twój adres IP"
                            DeliveryMode.MAILBOX -> "przez serwer"
                            null -> "brak połączenia"
                        },
                        style = MaterialTheme.typography.labelSmall,
                        color = Nocturne.kolory.tekstDrugi,
                    )
                }
            }

            IconButton(onClick = { onRozmowa(false) }, modifier = Modifier.size(Dotyk.ikonaWPasku)) {
                Icon(Ikony.Sluchawka, contentDescription = "Zadzwoń", tint = Nocturne.kolory.tekst)
            }
            IconButton(onClick = { onRozmowa(true) }, modifier = Modifier.size(Dotyk.ikonaWPasku)) {
                Icon(Ikony.Kamera, contentDescription = "Wideo", tint = Nocturne.kolory.tekst)
            }
            IconButton(onClick = onUczestnicy, modifier = Modifier.size(Dotyk.ikonaWPasku)) {
                Icon(Ikony.Odcisk, contentDescription = "Uczestnicy", tint = Nocturne.kolory.tekst)
            }
        }

        Box(Modifier.fillMaxWidth().size(1.dp).background(Nocturne.kolory.linia))
    }
}

/**
 * Bąbelek wiadomości.
 *
 * Własne po prawej, cudze po lewej, róg przy własnej stronie ścięty — układ,
 * który czyta się bez etykiet. Szerokość ograniczona do 78%, żeby strona
 * pozostała widoczna także przy długiej treści.
 */
@Composable
private fun Babel(wiadomosc: Wiadomosc, ciag: Boolean) {
    val wlasna = wiadomosc.wlasna

    /*
     * Sąsiadujące wiadomości tej samej strony sklejają się w blok.
     *
     * Każdy dymek z pełnym promieniem u góry daje listę osobnych kartek;
     * ścięcie górnego rogu po stronie nadawcy mówi „to dalej ta sama osoba"
     * bez żadnej etykiety.
     */
    val gora = if (ciag) 4.dp else 14.dp
    val ksztalt = if (wlasna) {
        RoundedCornerShape(14.dp, gora, 4.dp, 14.dp)
    } else {
        RoundedCornerShape(gora, 14.dp, 14.dp, 4.dp)
    }

    Row(
        modifier = Modifier.fillMaxWidth(),
        horizontalArrangement = if (wlasna) Arrangement.End else Arrangement.Start,
    ) {
        Column(
            modifier = Modifier
                .widthIn(max = 300.dp)
                .background(
                    color = if (wlasna) Nocturne.kolory.babelWlasny else Nocturne.kolory.karta,
                    shape = ksztalt,
                )
                .padding(horizontal = Odstep.l, vertical = Odstep.m),
            verticalArrangement = Arrangement.spacedBy(Odstep.xs),
        ) {
            // Autor tylko na początku bloku i tylko przy cudzych — przy własnych
            // mówi to strona dymka, a powtórzony przy każdej wiadomości jest szumem.
            if (!wlasna && !ciag) {
                Text(
                    wiadomosc.autor,
                    style = MaterialTheme.typography.labelSmall,
                    color = Nocturne.kolory.babelWlasnyMeta,
                )
            }

            wiadomosc.zalacznik?.let { zalacznik ->
                PodgladZalacznika(zalacznik, wlasna)
            }

            Text(
                wiadomosc.tresc,
                style = MaterialTheme.typography.bodyLarge,
                color = if (wlasna) Nocturne.kolory.babelWlasnyTekst else Nocturne.kolory.tekst,
            )

            Row(
                modifier = Modifier.align(Alignment.End),
                horizontalArrangement = Arrangement.spacedBy(Odstep.xs),
                verticalAlignment = Alignment.CenterVertically,
            ) {
                Text(
                    GODZINA.format(Date(wiadomosc.czas)),
                    style = MaterialTheme.typography.labelSmall,
                    color = if (wlasna) Nocturne.kolory.babelWlasnyMeta else Nocturne.kolory.tekstTrzeci,
                )

                /*
                 * Ptaszek tylko przy własnych: mówi, dokąd doszła wiadomość.
                 * Przy cudzych nie znaczyłby nic — te już tu są.
                 *
                 * „Przeczytane" różni się od „dostarczone" KOLOREM, nie
                 * kształtem: ten sam podwójny ptaszek w dwóch odcieniach czyta
                 * się jednym spojrzeniem, dwa różne kształty trzeba by za
                 * każdym razem rozpoznawać.
                 */
                if (wlasna) {
                    val stan = wiadomosc.stan ?: StanWiadomosci.WYSLANE

                    Icon(
                        imageVector = if (stan == StanWiadomosci.WYSLANE) {
                            Ikony.Wyslane
                        } else {
                            Ikony.Dostarczone
                        },
                        contentDescription = when (stan) {
                            StanWiadomosci.WYSLANE -> "wysłano"
                            StanWiadomosci.DOSTARCZONE -> "dostarczono"
                            StanWiadomosci.PRZECZYTANE -> "przeczytano"
                        },
                        tint = if (stan == StanWiadomosci.PRZECZYTANE) {
                            Nocturne.kolory.akcentTekst
                        } else {
                            Nocturne.kolory.babelWlasnyMeta
                        },
                        modifier = Modifier.size(13.dp),
                    )
                }
            }
        }
    }
}

/**
 * Rozdzielacz dni — data w linii, nie nad wiadomością.
 *
 * Linia po obu stronach zamiast plamy tła: data nie jest wiadomością i nie ma
 * wyglądać jak dymek wysłany przez nikogo.
 */
@Composable
private fun RozdzielaczDnia(etykieta: String) {
    Row(
        modifier = Modifier.fillMaxWidth().padding(vertical = Odstep.s),
        verticalAlignment = Alignment.CenterVertically,
        horizontalArrangement = Arrangement.spacedBy(Odstep.l),
    ) {
        Box(Modifier.weight(1f).height(1.dp).background(Nocturne.kolory.linia))
        Text(
            etykieta,
            style = MaterialTheme.typography.labelSmall,
            color = Nocturne.kolory.tekstTrzeci,
        )
        Box(Modifier.weight(1f).height(1.dp).background(Nocturne.kolory.linia))
    }
}

/**
 * Podgląd załącznika w dymku.
 *
 * # Zdjęcia odszyfrowują się same
 *
 * Zdjęcie w rozmowie ma być zdjęciem, a nie zadaniem do wykonania. Klikanie
 * „pobierz" przy każdym z nich zamieniałoby rozmowę w listę plików.
 * Deszyfrowanie dzieje się lokalnie, więc jedynym kosztem jest pobranie
 * szyfrogramu — które i tak nastąpiłoby po kliknięciu.
 *
 * Pozostałe typy zostają opisem: dokumentu nie ma jak pokazać w dymku,
 * a udawanie podglądu byłoby gorsze niż jego brak.
 */
@Composable
private fun PodgladZalacznika(zalacznik: Zalacznik, wlasna: Boolean) {
    val model: ChatViewModel = viewModel()
    val obraz = zalacznik.mimeType.startsWith("image/")
    var bitmapa by remember(zalacznik.blobId) { mutableStateOf<ImageBitmap?>(null) }
    var nieudane by remember(zalacznik.blobId) { mutableStateOf(false) }

    LaunchedEffect(zalacznik.blobId) {
        if (!obraz) return@LaunchedEffect

        val bajty = model.pobierzZalacznik(zalacznik)
        if (bajty == null) {
            nieudane = true
            return@LaunchedEffect
        }

        bitmapa = runCatching {
            BitmapFactory.decodeByteArray(bajty, 0, bajty.size)?.asImageBitmap()
        }.getOrNull()
        if (bitmapa == null) nieudane = true
    }

    when {
        bitmapa != null -> Image(
            bitmap = bitmapa!!,
            contentDescription = zalacznik.nazwaPliku ?: "zdjęcie",
            contentScale = ContentScale.Crop,
            modifier = Modifier
                .widthIn(max = 260.dp)
                .heightIn(max = 320.dp)
                .clip(RoundedCornerShape(8.dp)),
        )

        else -> Row(
            modifier = Modifier
                .background(Nocturne.kolory.tlo, RoundedCornerShape(8.dp))
                .padding(Odstep.m),
            verticalAlignment = Alignment.CenterVertically,
            horizontalArrangement = Arrangement.spacedBy(Odstep.s),
        ) {
            Icon(
                imageVector = Ikony.Spinacz,
                contentDescription = null,
                tint = if (wlasna) Nocturne.kolory.akcentTekst else Nocturne.kolory.tekstDrugi,
                modifier = Modifier.size(18.dp),
            )
            Text(
                text = when {
                    nieudane -> "nie udało się pobrać — spróbuj później"
                    obraz -> "odszyfrowuję…"
                    else -> "${opisTypu(zalacznik.mimeType)} · ${rozmiarTekstem(zalacznik.rozmiar)}"
                },
                style = MaterialTheme.typography.labelSmall,
                color = if (wlasna) Nocturne.kolory.akcentTekst else Nocturne.kolory.tekstDrugi,
            )
        }
    }
}

/** Rozmiar pliku w postaci, którą da się przeczytać bez liczenia zer. */
internal fun rozmiarTekstem(bajty: Long): String = when {
    bajty >= 1024 * 1024 -> "%.1f MB".format(bajty / 1024.0 / 1024.0)
    bajty >= 1024 -> "${bajty / 1024} kB"
    else -> "$bajty B"
}

/**
 * Bąbelek wiadomości czekającej na potwierdzenie.
 *
 * Przygaszony, dopóki nie ma potwierdzenia — widać, że jest, i widać, że
 * jeszcze nie doszła. Nieudana dostaje obrys w kolorze błędu, bo to stan,
 * z którym trzeba coś zrobić, a nie chwilowy.
 */
@Composable
private fun BabelWLocie(w: WLocie) {
    Row(modifier = Modifier.fillMaxWidth(), horizontalArrangement = Arrangement.End) {
        Column(
            modifier = Modifier
                .widthIn(max = 300.dp)
                .alpha(if (w.blad) 1f else 0.6f)
                .background(Nocturne.kolory.babelWlasny, RoundedCornerShape(14.dp, 14.dp, 4.dp, 14.dp))
                .then(
                    if (w.blad) {
                        Modifier.border(
                            1.dp,
                            MaterialTheme.colorScheme.error,
                            RoundedCornerShape(14.dp, 14.dp, 4.dp, 14.dp),
                        )
                    } else {
                        Modifier
                    },
                )
                .padding(horizontal = Odstep.l, vertical = Odstep.m),
            verticalArrangement = Arrangement.spacedBy(Odstep.xs),
        ) {
            Text(w.tresc, style = MaterialTheme.typography.bodyLarge, color = Nocturne.kolory.babelWlasnyTekst)

            Row(
                modifier = Modifier.align(Alignment.End),
                horizontalArrangement = Arrangement.spacedBy(Odstep.xs),
                verticalAlignment = Alignment.CenterVertically,
            ) {
                Icon(
                    imageVector = if (w.blad) Ikony.Niepowodzenie else Ikony.Zegar,
                    contentDescription = null,
                    tint = if (w.blad) Nocturne.kolory.alarm else Nocturne.kolory.babelWlasnyMeta,
                    modifier = Modifier.size(13.dp),
                )
                Text(
                    if (w.blad) "nie wysłano" else "wysyłam…",
                    style = MaterialTheme.typography.labelSmall,
                    color = if (w.blad) Nocturne.kolory.alarm else Nocturne.kolory.babelWlasnyMeta,
                )
            }
        }
    }
}

/** Awatar z inicjałami. Zdjęć nie ma i nie będzie — nie ma ich gdzie trzymać. */
@Composable
internal fun Awatar(
    nazwa: String,
    rozmiar: androidx.compose.ui.unit.Dp,
    modifier: Modifier = Modifier,
) {
    Box(
        modifier = modifier.size(rozmiar).background(Nocturne.kolory.babelWlasny, CircleShape),
        contentAlignment = Alignment.Center,
    ) {
        Text(
            inicjaly(nazwa),
            style = MaterialTheme.typography.labelMedium,
            color = Nocturne.kolory.babelWlasnyTekst,
        )
    }
}

@Composable
private fun PoleWysylki(
    tresc: String,
    onZmiana: (String) -> Unit,
    wlaczone: Boolean,
    onWyslij: () -> Unit,
    onZalacz: () -> Unit,
) {
    Column {
        Box(Modifier.fillMaxWidth().size(1.dp).background(Nocturne.kolory.linia))

        Row(
            modifier = Modifier.fillMaxWidth().padding(Odstep.m),
            verticalAlignment = Alignment.CenterVertically,
            horizontalArrangement = Arrangement.spacedBy(Odstep.s),
        ) {
            IconButton(onClick = onZalacz, modifier = Modifier.size(Dotyk.ikonaWPasku)) {
                Icon(Ikony.Spinacz, contentDescription = "Załącz", tint = Nocturne.kolory.tekst)
            }

            OutlinedTextField(
                value = tresc,
                onValueChange = onZmiana,
                modifier = Modifier.weight(1f),
                placeholder = { Text("Napisz wiadomość · Message", color = Nocturne.kolory.tekstTrzeci) },
                shape = RoundedCornerShape(14.dp),
                maxLines = 4,
                colors = OutlinedTextFieldDefaults.colors(
                    focusedBorderColor = Nocturne.kolory.akcent,
                    unfocusedBorderColor = Nocturne.kolory.linia,
                    focusedContainerColor = Nocturne.kolory.karta,
                    unfocusedContainerColor = Nocturne.kolory.karta,
                ),
            )

            IconButton(
                onClick = onWyslij,
                enabled = wlaczone && tresc.isNotBlank(),
                modifier = Modifier.size(Dotyk.ikonaWPasku),
            ) {
                Icon(
                    Ikony.Wyslij,
                    contentDescription = "Wyślij",
                    tint = if (tresc.isNotBlank()) Nocturne.kolory.akcent else Nocturne.kolory.liniaMocna,
                )
            }
        }
    }
}
