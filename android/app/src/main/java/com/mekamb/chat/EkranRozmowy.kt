package com.mekamb.chat

import android.graphics.BitmapFactory
import androidx.activity.compose.rememberLauncherForActivityResult
import androidx.activity.result.contract.ActivityResultContracts
import androidx.compose.foundation.ExperimentalFoundationApi
import androidx.compose.foundation.Image
import androidx.compose.foundation.background
import androidx.compose.foundation.border
import androidx.compose.foundation.clickable
import androidx.compose.foundation.combinedClickable
import androidx.compose.foundation.interaction.MutableInteractionSource
import androidx.compose.foundation.interaction.collectIsPressedAsState
import androidx.compose.foundation.layout.Arrangement
import androidx.compose.foundation.layout.Box
import androidx.compose.foundation.layout.Column
import androidx.compose.foundation.layout.PaddingValues
import androidx.compose.foundation.layout.Row
import androidx.compose.foundation.layout.defaultMinSize
import androidx.compose.foundation.layout.fillMaxSize
import androidx.compose.foundation.layout.fillMaxWidth
import androidx.compose.foundation.layout.heightIn
import androidx.compose.foundation.layout.imePadding
import androidx.compose.foundation.layout.padding
import androidx.compose.foundation.layout.size
import androidx.compose.foundation.layout.widthIn
import androidx.compose.foundation.lazy.LazyColumn
import androidx.compose.foundation.lazy.itemsIndexed
import androidx.compose.foundation.lazy.rememberLazyListState
import androidx.compose.foundation.shape.CircleShape
import androidx.compose.foundation.shape.RoundedCornerShape
import androidx.compose.foundation.text.BasicTextField
import androidx.compose.material3.Icon
import androidx.compose.material3.MaterialTheme
import androidx.compose.material3.Text
import androidx.compose.runtime.Composable
import androidx.compose.runtime.LaunchedEffect
import androidx.compose.runtime.getValue
import androidx.compose.runtime.mutableStateOf
import androidx.compose.runtime.remember
import androidx.compose.runtime.setValue
import androidx.compose.ui.Alignment
import androidx.compose.ui.Modifier
import androidx.compose.ui.draw.alpha
import androidx.compose.ui.draw.clip
import androidx.compose.ui.geometry.CornerRadius
import androidx.compose.ui.geometry.RoundRect
import androidx.compose.ui.geometry.Size
import androidx.compose.ui.graphics.ImageBitmap
import androidx.compose.ui.graphics.Outline
import androidx.compose.ui.graphics.Path
import androidx.compose.ui.graphics.PathOperation
import androidx.compose.ui.graphics.Shape
import androidx.compose.ui.graphics.SolidColor
import androidx.compose.ui.graphics.asImageBitmap
import androidx.compose.ui.graphics.vector.ImageVector
import androidx.compose.ui.layout.ContentScale
import androidx.compose.ui.semantics.Role
import androidx.compose.ui.text.SpanStyle
import androidx.compose.ui.text.buildAnnotatedString
import androidx.compose.ui.text.font.FontWeight
import androidx.compose.ui.text.style.TextOverflow
import androidx.compose.ui.text.withStyle
import androidx.compose.ui.unit.Density
import androidx.compose.ui.unit.Dp
import androidx.compose.ui.unit.LayoutDirection
import androidx.compose.ui.unit.dp
import androidx.compose.ui.window.Dialog
import androidx.compose.ui.window.DialogProperties
import androidx.lifecycle.viewmodel.compose.viewModel
import java.text.SimpleDateFormat
import java.util.Date
import java.util.Locale
import uniffi.mekamb_ffi.DeliveryMode

/**
 * Ekran rozmowy.
 *
 * # Autor po jasności, nie po stronie
 *
 * Dymek własny to plama `glowny` (prawie czerń w jasnym, prawie biel w ciemnym),
 * dymek rozmówcy — `wglebienie`. Strona znika w chwili, gdy zdanie wypełnia
 * szerokość; jasność zostaje. Dlatego w wątku nie ma żadnej innej plamy
 * `glowny` poza strzałką wysyłania — każda inna podszywałaby się pod „to ja
 * powiedziałem". Połączenie, wideo i szczegóły w nagłówku są „duchami".
 *
 * # Droga dostarczania jest pod nazwą rozmówcy
 *
 * „Bezpośrednio" znaczy, że rozmówca zna Twój adres IP — to informacja o Tobie,
 * więc stoi tam, gdzie patrzysz, pisząc do kogoś: w podtytule nagłówka.
 */

/** Godzina wiadomości. Bez daty — dzień niesie rozdzielacz. */
private val GODZINA = SimpleDateFormat("HH:mm", Locale.getDefault())

/** Odstęp między dymkami jednej serii — seria czyta się jak jedna wypowiedź. */
private val ODSTEP_W_SERII = 2.dp

/** Odstęp między seriami. */
private val ODSTEP_MIEDZY_SERIAMI = Odstep.m

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
    val jezyk = LokalnyJezyk.current

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
     * Rozdzielacze, bloki, ogony i miejsce na stan wysyłki są decyzjami
     * o sąsiedztwie, więc mieszkają w `ulozWatek` — tam też są sprawdzone testem
     * i trzymane w zgodzie z webem.
     *
     * Musi stać TUTAJ, a nie w środku `LazyColumn`: przewijanie do najnowszej
     * wiadomości potrzebuje liczby POZYCJI, a nie liczby wiadomości. Rozdzielacz
     * też zajmuje pozycję, więc liczenie po samych wiadomościach zatrzymuje
     * listę kilka dymków przed końcem — i to tym bardziej, im dłuższa rozmowa.
     */
    val uklad = ulozWatek(stan.wiadomosci, System.currentTimeMillis(), jezyk)
    val wLocie = stan.wLocie

    // Nowa wiadomość ma być widoczna bez przewijania. Bez tego rozmowa
    // „stoi" na starej treści i wygląda, jakby nic nie przyszło.
    LaunchedEffect(uklad.size, wLocie.size) {
        val ile = uklad.size + wLocie.size
        if (ile > 0) lista.animateScrollToItem(ile - 1)
    }

    /*
     * `imePadding` na całej rozmowie, nie na samym polu pisania.
     *
     * Aplikacja rysuje od krawędzi do krawędzi, a od Androida 15 okno nie
     * zmniejsza się już samo pod klawiaturę mimo `adjustResize` w manifeście.
     * Bez tego pole pisania i przycisk wysyłania chowają się POD klawiaturą,
     * której otwarcie samo je wywołało. Odsunięcie całej kolumny, a nie samego
     * pola, zabiera ze sobą listę: inaczej ostatni dymek zostaje pod klawiaturą
     * i nie widać tego, na co się właśnie odpowiada.
     */
    Column(modifier = modifier.fillMaxSize().imePadding()) {
        PasekRozmowy(
            // Etykieta z nickami/nazwą grupy — pod spodem zostaje nazwa
            // użytkownika (tożsamość MLS).
            nazwa = stan.groupId?.let { model.etykieta(it, stan.rozmowca.orEmpty()) }
                ?: stan.rozmowca ?: t("rozmowa", "chat"),
            onWstecz = onWstecz,
            onUczestnicy = onUczestnicy,
            onRozmowa = onRozmowa,
        )

        // Klucz ostatniej WŁASNEJ wiadomości ze stanem — stan pokazujemy słowem
        // („dostarczono" / „przeczytano") tylko pod nią, jak w projekcie, a nie
        // ptaszkiem w każdym dymku.
        val kluczStanu = uklad
            .filterIsInstance<PozycjaWatku.Dymek>()
            .lastOrNull { it.wiadomosc.wlasna && it.wiadomosc.rozmowa == null && it.wiadomosc.stan != null }
            ?.klucz

        LazyColumn(
            state = lista,
            modifier = Modifier.fillMaxWidth().weight(1f),
            // Margines w `contentPadding`, a nie w `padding` listy: lista przycina
            // rysowanie do własnych granic, a ogon dymka wystaje 7 dp poza dymek.
            contentPadding = PaddingValues(horizontal = Odstep.l, vertical = Odstep.m),
        ) {
            itemsIndexed(uklad, key = { _, p -> p.klucz }) { i, pozycja ->
                when (pozycja) {
                    is PozycjaWatku.Dzien -> RozdzielaczDnia(pozycja.etykieta)
                    is PozycjaWatku.Dymek ->
                        // Ślad po rozmowie nie jest dymkiem — nikt go nie
                        // powiedział, więc nie ma strony, po której miałby stanąć.
                        pozycja.wiadomosc.rozmowa
                            ?.let { ZdarzenieRozmowy(pozycja.wiadomosc, it) }
                            ?: Babel(
                                pozycja.wiadomosc,
                                pozycja.ciag,
                                stanSlowo = if (pozycja.klucz == kluczStanu) {
                                    when (pozycja.wiadomosc.stan) {
                                        StanWiadomosci.PRZECZYTANE -> t("przeczytano", "read")
                                        StanWiadomosci.DOSTARCZONE -> t("dostarczono", "delivered")
                                        else -> t("wysłano", "sent")
                                    }
                                } else {
                                    null
                                },
                            )
                }
            }

            // Wiadomości w locie zawsze na końcu — są najświeższe z definicji.
            itemsIndexed(wLocie, key = { _, w -> "w-locie-${w.id}" }) { i, w ->
                val poWlasnej = if (i == 0) oddajeKoniec else !wLocie[i - 1].blad
                BabelWLocie(
                    w = w,
                    odstepNad = if (poWlasnej) ODSTEP_W_SERII else ODSTEP_MIEDZY_SERIAMI,
                    ogon = i == wLocie.lastIndex,
                )
            }
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

/**
 * Arkusz wyboru załącznika — od dołu, z uchwytem.
 *
 * Cztery drogi, bo prowadzą do różnych miejsc systemu: galeria zdjęć, galeria
 * nagrań, dźwięk i dowolny plik to cztery różne filtry tego samego wyboru.
 *
 * Notka o metadanych stoi tutaj, a nie po wysłaniu: obietnica pokazana po fakcie
 * nie daje już wyboru.
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

            Text(t("Załącz", "Attach"), style = MaterialTheme.typography.titleMedium)

            Row(horizontalArrangement = Arrangement.spacedBy(Odstep.s)) {
                KafelekZalacznika(t("Zdjęcie", "Photo"), Ikony.Aparat, Modifier.weight(1f)) {
                    onWybierz("image/*")
                }
                KafelekZalacznika(t("Wideo", "Video"), Ikony.Kamera, Modifier.weight(1f)) {
                    onWybierz("video/*")
                }
            }
            Row(horizontalArrangement = Arrangement.spacedBy(Odstep.s)) {
                KafelekZalacznika(t("Dźwięk", "Audio"), Ikony.Dzwonek, Modifier.weight(1f)) {
                    onWybierz("audio/*")
                }
                KafelekZalacznika(t("Plik", "File"), Ikony.Spinacz, Modifier.weight(1f)) {
                    onWybierz("*/*")
                }
            }
        }
        Row(horizontalArrangement = Arrangement.spacedBy(Odstep.s)) {
            KafelekZalacznika(t("Dźwięk", "Audio"), Ikony.Glosnik, Modifier.weight(1f)) {
                onWybierz("audio/*")
            }
            KafelekZalacznika(t("Plik", "File"), Ikony.Plik, Modifier.weight(1f)) {
                onWybierz("*/*")
            }
        }

            // Zostaje, bo mówi o tym, co robimy z PLIKIEM, zanim go wyślemy —
            // i o tym, że może się nie udać. To zmienia decyzję: przy takim
            // ostrzeżeniu zdjęcie z lokalizacją można wysłać świadomie albo
            // wcale. Zdanie o szyfrowaniu każdego pliku osobnym kluczem
            // zniknęło — było zapewnieniem, po którym nic nie zależy.
            Wskazowka(
                t(
                    "Lokalizację i dane urządzenia usuwamy PRZED wysłaniem. Gdy się nie uda, " +
                        "napiszemy to przy wiadomości.",
                    "We strip location and device data BEFORE sending. If that fails, we'll " +
                        "say so on the message.",
                ),
                Ikony.Tarcza,
            )
        }
    }
}

@Composable
private fun KafelekZalacznika(
    etykieta: String,
    ikona: ImageVector,
    modifier: Modifier = Modifier,
    onClick: () -> Unit,
) {
    val zrodlo = remember { MutableInteractionSource() }
    val wcisniety by zrodlo.collectIsPressedAsState()
    val ksztalt = RoundedCornerShape(Promien.m)
    Column(
        modifier = modifier
            .clip(ksztalt)
            .background(if (wcisniety) Nocturne.kolory.wglebienie else Nocturne.kolory.karta, ksztalt)
            .border(1.dp, Nocturne.kolory.linia, ksztalt)
            .clickable(interactionSource = zrodlo, indication = null, role = Role.Button, onClick = onClick)
            .padding(vertical = Odstep.l),
        horizontalAlignment = Alignment.CenterHorizontally,
        verticalArrangement = Arrangement.spacedBy(Odstep.s),
    ) {
        Icon(ikona, contentDescription = null, tint = Nocturne.kolory.tekst, modifier = Modifier.size(22.dp))
        Text(etykieta, style = MaterialTheme.typography.bodyMedium)
    }
}

/**
 * Nagłówek wątku: awatar + nazwa + podtytuł, po prawej trzy „duchy".
 *
 * Dotknięcie nazwy i ikona szczegółów prowadzą w to samo miejsce (uczestnicy
 * i kod bezpieczeństwa) — nazwa, bo tak się tego szuka, ikona, bo nazwa nie
 * wygląda na przycisk.
 */
@Composable
private fun PasekRozmowy(
    nazwa: String,
    onWstecz: () -> Unit,
    onUczestnicy: () -> Unit,
    onRozmowa: (Boolean) -> Unit,
) {
    // Nagłówek jak w projekcie: wstecz po lewej, wyśrodkowany awatar + nazwa
    // (dotknięcie otwiera kod bezpieczeństwa), połączenie i wideo po prawej.
    // Droga dostarczania zeszła z nagłówka — jest przy ikonie na liście i w
    // ustawieniach; tu zabierała miejsce nazwie i nie była akcją.
    Column {
        Row(
            modifier = Modifier
                .fillMaxWidth()
                .background(Nocturne.kolory.pasek)
                .padding(horizontal = Odstep.s, vertical = Odstep.s),
            verticalAlignment = Alignment.CenterVertically,
        ) {
            IconButton(onClick = onWstecz, modifier = Modifier.size(Dotyk.ikonaWPasku)) {
                Icon(Ikony.Wstecz, contentDescription = t("Wróć", "Back"), tint = Nocturne.kolory.akcentTekst)
            }

            Row(
                modifier = Modifier
                    .weight(1f)
                    .clickable(onClick = onUczestnicy)
                    .padding(horizontal = Odstep.s),
                verticalAlignment = Alignment.CenterVertically,
                horizontalArrangement = Arrangement.spacedBy(Odstep.s, Alignment.CenterHorizontally),
            ) {
                Awatar(nazwa, rozmiar = 30.dp)
                Text(
                    nazwa,
                    style = MaterialTheme.typography.titleMedium,
                    maxLines = 1,
                    overflow = TextOverflow.Ellipsis,
                )
            }

            IconButton(onClick = { onRozmowa(false) }, modifier = Modifier.size(Dotyk.ikonaWPasku)) {
                Icon(Ikony.Sluchawka, contentDescription = t("Zadzwoń", "Call"), tint = Nocturne.kolory.akcentTekst)
            }
            IconButton(onClick = { onRozmowa(true) }, modifier = Modifier.size(Dotyk.ikonaWPasku)) {
                Icon(Ikony.Kamera, contentDescription = t("Wideo", "Video"), tint = Nocturne.kolory.akcentTekst)
            }
        }

        Linia()
    }
}

/**
 * Ślad po rozmowie A/V — na środku wątku, jak rozdzielacz.
 *
 * Ikona jest DOKŁADNIE ta, którą się w rozmowę weszło: słuchawka przy głosowej,
 * kamera przy wideo. Inny piktogram w podsumowaniu niż na przycisku kazałby się
 * domyślać, że mowa o tym samym.
 *
 * Nieodebrana świeci alarmem, bo jest jedyną, z którą trzeba coś zrobić —
 * oddzwonić. Odbyta jest wyłącznie zapisem w kronice.
 */
@Composable
private fun ZdarzenieRozmowy(wiadomosc: Wiadomosc, rozmowa: ZapisRozmowy, pierwszy: Boolean) {
    val odbyta = rozmowa.sekundy != null

    val opis = when {
        odbyta -> {
            val s = rozmowa.sekundy ?: 0L
            val rodzaj = if (rozmowa.wideo) t("Rozmowa wideo", "Video call") else t("Rozmowa głosowa", "Voice call")
            "%s · %d:%02d".format(rodzaj, s / 60, s % 60)
        }
        rozmowa.wychodzaca -> t("Nikt nie odebrał", "No answer")
        else -> if (rozmowa.wideo) t("Nieodebrana rozmowa wideo", "Missed video call") else t("Nieodebrana rozmowa głosowa", "Missed voice call")
    }

    val kolor = if (odbyta) Nocturne.kolory.tekstDrugi else Nocturne.kolory.alarm

    Row(
        modifier = Modifier
            .fillMaxWidth()
            .padding(top = if (pierwszy) 0.dp else ODSTEP_MIEDZY_SERIAMI),
        horizontalArrangement = Arrangement.Center,
        verticalAlignment = Alignment.CenterVertically,
    ) {
        Row(
            modifier = Modifier
                .border(
                    1.dp,
                    if (odbyta) Nocturne.kolory.linia else Nocturne.kolory.alarm.copy(alpha = 0.4f),
                    RoundedCornerShape(Promien.pigulka),
                )
                .padding(horizontal = Odstep.m, vertical = 6.dp),
            horizontalArrangement = Arrangement.spacedBy(Odstep.s),
            verticalAlignment = Alignment.CenterVertically,
        ) {
            Icon(
                if (rozmowa.wideo) Ikony.Kamera else Ikony.Sluchawka,
                contentDescription = null,
                tint = kolor,
                modifier = Modifier.size(14.dp),
            )
            Text(opis, style = MaterialTheme.typography.labelSmall, color = kolor)
            Text(
                GODZINA.format(Date(wiadomosc.czas)),
                style = MaterialTheme.typography.labelSmall,
                color = Nocturne.kolory.tekstDrugi,
            )
        }
    }
}

@Composable
private fun Babel(wiadomosc: Wiadomosc, ciag: Boolean, stanSlowo: String? = null) {
    val wlasna = wiadomosc.wlasna

        val zOgonem = Path().apply { op(dymek, wypelnienie, PathOperation.Union) }
        return Outline.Generic(Path().apply { op(zOgonem, wyciecie, PathOperation.Difference) })
    }
}

    Column(
        modifier = Modifier.fillMaxWidth(),
        horizontalAlignment = if (wlasna) Alignment.End else Alignment.Start,
        verticalArrangement = Arrangement.spacedBy(Odstep.xs),
    ) {
        Column(
            modifier = Modifier
                .widthIn(max = 300.dp)
                .background(
                    color = if (wlasna) k.babelWlasny else k.babel,
                    shape = KsztaltDymka(wlasna, ogon),
                )
                .clip(RoundedCornerShape(PROMIEN_BABLA))
                // Bez fali: dotknięcie dymka niczego nie robi, więc nie może
                // wyglądać, jakby coś zrobiło. Przytrzymanie odsłania godzinę.
                .combinedClickable(
                    interactionSource = remember { MutableInteractionSource() },
                    indication = null,
                    onClick = {},
                    onLongClick = { pokazGodzine = !pokazGodzine },
                )
                .padding(horizontal = Odstep.m, vertical = Odstep.s),
            verticalArrangement = Arrangement.spacedBy(Odstep.xs),
        ) {
            // Autor tylko na początku bloku i tylko przy cudzych — przy własnych
            // mówi to jasność dymka, a powtórzony przy każdej wiadomości jest szumem.
            if (!wlasna && !ciag) {
                Text(
                    autor,
                    style = MaterialTheme.typography.labelSmall.copy(fontWeight = FontWeight.SemiBold),
                    color = k.tekstDrugi,
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

            // Godzina zostaje w dymku (świadoma różnica Androida wobec webu,
            // gdzie zegar zszedł na rozdzielacz). Stan dostawy nie jest już
            // ptaszkiem obok niej — jest słowem pod ostatnią własną wiadomością.
            Text(
                GODZINA.format(Date(wiadomosc.czas)),
                modifier = Modifier.align(Alignment.End),
                style = MaterialTheme.typography.labelSmall,
                color = if (wlasna) Nocturne.kolory.babelWlasnyMeta else Nocturne.kolory.tekstTrzeci,
            )
        }

        /*
         * Stan dostawy słowem, jak w projekcie: „dostarczono" i „przeczytano" to
         * różnica, którą trzeba zrozumieć, a nie odcień ptaszka do rozpoznania.
         * Tylko pod ostatnią własną wiadomością — [stanSlowo] jest tam niepuste.
         */
        if (stanSlowo != null) {
            Text(
                stanSlowo,
                modifier = Modifier.padding(horizontal = Odstep.xs),
                style = MaterialTheme.typography.labelSmall,
                color = Nocturne.kolory.tekstTrzeci,
            )
        }

        val podpis = listOfNotNull(
            GODZINA.format(Date(wiadomosc.czas)).takeIf { pokazGodzine },
            stanSlowo,
        ).joinToString(" · ")
        if (podpis.isNotEmpty()) {
            Text(
                podpis,
                modifier = Modifier.padding(top = Odstep.xs, start = Odstep.xs, end = Odstep.xs),
                style = MaterialTheme.typography.labelSmall,
                color = k.tekstDrugi,
            )
        }
    }
}

/**
 * Rozdzielacz: wyśrodkowane „**Dziś** 08:42".
 *
 * Dzień wytłuszczony, godzina zwykła — jedno zdanie, nie dwie etykiety. Bez
 * linii po bokach i bez plamy: rozdzielacz nie jest wiadomością i nie ma
 * wyglądać jak dymek wysłany przez nikogo.
 */
@Composable
private fun Rozdzielacz(etykieta: String, czas: Long, pierwszy: Boolean) {
    Text(
        buildAnnotatedString {
            withStyle(SpanStyle(fontWeight = FontWeight.SemiBold)) { append(etykieta) }
            append(" ")
            append(GODZINA.format(Date(czas)))
        },
        modifier = Modifier
            .fillMaxWidth()
            .padding(top = if (pierwszy) Odstep.xs else Odstep.xl, bottom = Odstep.xs),
        style = MaterialTheme.typography.labelSmall,
        color = Nocturne.kolory.tekstDrugi,
        textAlign = androidx.compose.ui.text.style.TextAlign.Center,
    )
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
    var naPelnym by remember(zalacznik.blobId) { mutableStateOf(false) }

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
            contentDescription = zalacznik.nazwaPliku ?: t("zdjęcie", "photo"),
            contentScale = ContentScale.Crop,
            modifier = Modifier
                .widthIn(max = 260.dp)
                .heightIn(max = 320.dp)
                .clip(RoundedCornerShape(12.dp))
                // Kliknięcie powiększa zdjęcie na pełny ekran.
                .clickable { naPelnym = true },
        )

        else -> Row(
            modifier = Modifier
                .background(
                    if (wlasna) Nocturne.kolory.glownyTekst.copy(alpha = 0.14f) else Nocturne.kolory.tlo,
                    RoundedCornerShape(Promien.s),
                )
                .padding(Odstep.s),
            verticalAlignment = Alignment.CenterVertically,
            horizontalArrangement = Arrangement.spacedBy(Odstep.s),
        ) {
            Icon(
                imageVector = Ikony.Spinacz,
                contentDescription = null,
                tint = if (wlasna) Nocturne.kolory.glownyTekst else Nocturne.kolory.tekstDrugi,
                modifier = Modifier.size(18.dp),
            )
            Text(
                text = when {
                    nieudane -> t("nie udało się pobrać — spróbuj później", "couldn't download — try later")
                    obraz -> t("odszyfrowuję…", "decrypting…")
                    else -> "${opisTypu(zalacznik.mimeType)} · ${rozmiarTekstem(zalacznik.rozmiar)}"
                },
                style = MaterialTheme.typography.labelSmall,
                color = if (wlasna) Nocturne.kolory.glownyTekst else Nocturne.kolory.tekstDrugi,
            )
        }
    }

    /*
     * Zdjęcie na pełny ekran.
     *
     * Bitmapa jest już odszyfrowana w pamięci — nie pobieramy jej drugi raz.
     * `usePlatformDefaultWidth = false` zabiera dialogowi domyślną szerokość, więc
     * wypełnia ekran; przygaszone tło i dopasowanie bez przycinania (`Fit`), a
     * dotknięcie w dowolnym miejscu zamyka. Systemowe „wstecz" robi to samo
     * (`onDismissRequest`).
     */
    val doPokazania = bitmapa
    if (naPelnym && doPokazania != null) {
        Dialog(
            onDismissRequest = { naPelnym = false },
            properties = DialogProperties(usePlatformDefaultWidth = false),
        ) {
            Box(
                modifier = Modifier
                    .fillMaxSize()
                    .background(androidx.compose.ui.graphics.Color(0xD1000000))
                    .clickable { naPelnym = false },
                contentAlignment = Alignment.Center,
            ) {
                Image(
                    bitmap = doPokazania,
                    contentDescription = zalacznik.nazwaPliku ?: t("zdjęcie", "photo"),
                    contentScale = ContentScale.Fit,
                    modifier = Modifier.fillMaxSize().padding(Odstep.m),
                )
            }
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
 * Dymek wiadomości czekającej na potwierdzenie wysłania.
 *
 * Przygaszony, dopóki nie wyszła — widać, że jest, i widać, że jeszcze nie
 * doszła. Słowo pod nim stoi przy KAŻDYM takim dymku, nie tylko przy ostatnim:
 * „wysyłam" i „nie wysłano" to stany, przy których milczenie znaczyłoby „doszło".
 * Nieudana dostaje obrys alarmu, bo to stan, z którym trzeba coś zrobić.
 */
@Composable
private fun BabelWLocie(w: WLocie, odstepNad: Dp, ogon: Boolean) {
    val k = Nocturne.kolory
    val ksztalt = KsztaltDymka(wlasna = true, ogon = ogon)
    Column(
        modifier = Modifier.fillMaxWidth().padding(top = odstepNad),
        horizontalAlignment = Alignment.End,
    ) {
        Box(
            modifier = Modifier
                .widthIn(max = 300.dp)
                .alpha(if (w.blad) 1f else 0.6f)
                .background(k.babelWlasny, ksztalt)
                .then(if (w.blad) Modifier.border(1.dp, k.alarm, RoundedCornerShape(PROMIEN_BABLA)) else Modifier)
                .padding(horizontal = Odstep.m, vertical = Odstep.s),
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
                    if (w.blad) t("nie wysłano", "not sent") else t("wysyłam…", "sending…"),
                    style = MaterialTheme.typography.labelSmall,
                    color = if (w.blad) Nocturne.kolory.alarm else Nocturne.kolory.babelWlasnyMeta,
                )
            }
        }
        Text(
            if (w.blad) t("Nie wysłano", "Not sent") else t("Wysyłam…", "Sending…"),
            modifier = Modifier.padding(top = Odstep.xs, start = Odstep.xs, end = Odstep.xs),
            style = MaterialTheme.typography.labelSmall,
            color = if (w.blad) k.alarm else k.tekstDrugi,
        )
    }
}

/**
 * Awatar z inicjałami na `wglebienie-mocne`.
 *
 * Zdjęć nie ma i nie będzie — nie ma ich gdzie trzymać.
 */
@Composable
internal fun Awatar(
    nazwa: String,
    rozmiar: Dp,
    modifier: Modifier = Modifier,
) {
    Box(
        modifier = modifier.size(rozmiar).background(Nocturne.kolory.wglebienieMocne, CircleShape),
        contentAlignment = Alignment.Center,
    ) {
        Text(
            inicjaly(nazwa),
            style = if (rozmiar >= 44.dp) MaterialTheme.typography.labelLarge else MaterialTheme.typography.labelMedium,
            color = Nocturne.kolory.tekst,
        )
    }
}

/**
 * Pole pisania: `wglebienie`, promień 20, bez obramowania; obok strzałka.
 *
 * Strzałka wysyłania to okrąg `glowny` 36×36 — jedyna plama w wątku, w kolorze
 * dymka, który zaraz stworzy. Dopóki nie ma czego wysłać, jest przygaszona,
 * a nie znika: znikająca strzałka przesuwałaby pole pod palcem przy pierwszej
 * literze.
 */
@Composable
private fun PoleWysylki(
    tresc: String,
    onZmiana: (String) -> Unit,
    wlaczone: Boolean,
    onWyslij: () -> Unit,
    onZalacz: () -> Unit,
) {
    val k = Nocturne.kolory
    Column(Modifier.background(k.tlo)) {
        Linia()

        Row(
            modifier = Modifier.fillMaxWidth().padding(horizontal = Odstep.xs, vertical = Odstep.s),
            verticalAlignment = Alignment.Bottom,
            horizontalArrangement = Arrangement.spacedBy(Odstep.xs),
        ) {
            IconButton(onClick = onZalacz, modifier = Modifier.size(Dotyk.ikonaWPasku)) {
                Icon(Ikony.Spinacz, contentDescription = t("Załącz", "Attach"), tint = Nocturne.kolory.tekstDrugi)
            }

            BasicTextField(
                value = tresc,
                onValueChange = onZmiana,
                modifier = Modifier.weight(1f),
                placeholder = { Text(t("Napisz wiadomość", "Message"), color = Nocturne.kolory.tekstTrzeci) },
                shape = RoundedCornerShape(18.dp),
                maxLines = 4,
                colors = OutlinedTextFieldDefaults.colors(
                    focusedBorderColor = Nocturne.kolory.akcentTekst,
                    unfocusedBorderColor = Nocturne.kolory.linia,
                    focusedContainerColor = Nocturne.kolory.pole,
                    unfocusedContainerColor = Nocturne.kolory.pole,
                ),
            )

            val aktywny = wlaczone && tresc.isNotBlank()
            Box(
                modifier = Modifier.size(Dotyk.ikonaWPasku),
                contentAlignment = Alignment.Center,
            ) {
                Box(
                    modifier = Modifier
                        .size(36.dp)
                        .alpha(if (aktywny) 1f else 0.35f)
                        .clip(CircleShape)
                        .background(k.glowny, CircleShape)
                        .clickable(enabled = aktywny, role = Role.Button, onClick = onWyslij),
                    contentAlignment = Alignment.Center,
                ) {
                    Icon(
                        Ikony.Wyslij,
                        contentDescription = t("Wyślij", "Send"),
                        tint = if (aktywny) androidx.compose.ui.graphics.Color.White else Nocturne.kolory.tekstTrzeci,
                        modifier = Modifier.size(18.dp),
                    )
                }
            }
        }
    }
}
