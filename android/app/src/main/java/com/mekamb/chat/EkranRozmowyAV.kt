package com.mekamb.chat

import android.Manifest
import android.content.pm.PackageManager
import androidx.activity.compose.rememberLauncherForActivityResult
import androidx.activity.result.contract.ActivityResultContracts
import androidx.compose.foundation.background
import androidx.compose.foundation.border
import androidx.compose.foundation.clickable
import androidx.compose.foundation.layout.Arrangement
import androidx.compose.foundation.layout.Box
import androidx.compose.foundation.layout.Column
import androidx.compose.foundation.layout.Row
import androidx.compose.foundation.layout.Spacer
import androidx.compose.foundation.layout.fillMaxHeight
import androidx.compose.foundation.layout.fillMaxSize
import androidx.compose.foundation.layout.fillMaxWidth
import androidx.compose.foundation.layout.padding
import androidx.compose.foundation.layout.size
import androidx.compose.foundation.shape.CircleShape
import androidx.compose.foundation.shape.RoundedCornerShape
import androidx.compose.material3.Icon
import androidx.compose.material3.MaterialTheme
import androidx.compose.material3.Text
import androidx.compose.runtime.Composable
import androidx.compose.runtime.DisposableEffect
import androidx.compose.runtime.key
import androidx.compose.runtime.remember
import androidx.compose.ui.Alignment
import androidx.compose.ui.Modifier
import androidx.compose.ui.draw.clip
import androidx.compose.ui.graphics.vector.ImageVector
import androidx.compose.ui.platform.LocalContext
import androidx.compose.ui.text.style.TextAlign
import androidx.compose.ui.text.style.TextOverflow
import androidx.compose.ui.unit.dp
import androidx.compose.ui.viewinterop.AndroidView
import androidx.core.content.ContextCompat
import org.webrtc.EglBase
import org.webrtc.RendererCommon
import org.webrtc.SurfaceViewRenderer
import org.webrtc.VideoTrack

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
 *
 * # Dlaczego siatka nie jest listą leniwą
 *
 * Uczestników jest najwyżej czterech ([RozmowaAV.LIMIT_UCZESTNIKOW]), a każdy
 * kafelek trzyma powierzchnię OpenGL wpiętą w ścieżkę WebRTC. Lista leniwa
 * usuwałaby i odtwarzała te powierzchnie przy przewijaniu, czyli gasiłaby
 * obraz na ułamek sekundy bez żadnego powodu — nie ma tu czego przewijać.
 * Zwykłe rzędy z `weight` dają w zamian kafelki, które wypełniają ekran przy
 * każdej liczbie osób.
 */
@Composable
fun EkranRozmowyAV(
    model: ChatViewModel,
    modifier: Modifier = Modifier,
    onZakoncz: () -> Unit,
) {
    val stan = model.stan
    val kontekst = LocalContext.current
    val kontekstGl = model.kontekstGlRozmowy()

    /*
     * Kamera włączona w trakcie rozmowy głosowej wymaga zgody, o którą nikt
     * dotąd nie poprosił: przy dzwonieniu „bez obrazu" pytamy wyłącznie
     * o mikrofon. Bez tego przycisk po cichu nic nie robił — kamera nie ruszała,
     * a użytkownik nie dostawał ani obrazu, ani wyjaśnienia.
     */
    val zgodaNaAparat = rememberLauncherForActivityResult(
        ActivityResultContracts.RequestPermission(),
    ) { przyznana -> if (przyznana) model.przelaczKamere() }

    fun przelaczObraz() {
        val mamyZgode = ContextCompat.checkSelfPermission(kontekst, Manifest.permission.CAMERA) ==
            PackageManager.PERMISSION_GRANTED

        // O zgodę pytamy tylko przy WŁĄCZANIU obrazu. Gaszenie własnej kamery
        // nie potrzebuje niczyjego pozwolenia.
        if (mamyZgode || stan.kameraWlaczona) model.przelaczKamere()
        else zgodaNaAparat.launch(Manifest.permission.CAMERA)
    }

    Column(
        modifier = modifier.fillMaxSize().background(Nocturne.kolory.wglebienie),
        verticalArrangement = Arrangement.SpaceBetween,
    ) {
        Column(modifier = Modifier.fillMaxWidth().padding(Odstep.l)) {
            Text(
                text = stan.rozmowca ?: "rozmowa",
                style = MaterialTheme.typography.titleMedium,
                maxLines = 1,
                overflow = TextOverflow.Ellipsis,
            )
            Text(
                text = "mesh · ${stan.rozmowaAV.size} rozmówców",
                style = MaterialTheme.typography.labelSmall,
                color = Nocturne.kolory.tekstDrugi,
            )
        }

        SiatkaKafelkow(
            wlasne = stan.wideoLokalne.takeIf { stan.kameraWlaczona },
            uczestnicy = stan.rozmowaAV,
            kontekstGl = kontekstGl,
            modifier = Modifier.fillMaxWidth().weight(1f).padding(horizontal = Odstep.m),
        )

        Row(
            modifier = Modifier.fillMaxWidth().padding(Odstep.l),
            horizontalArrangement = Arrangement.spacedBy(Odstep.m, Alignment.CenterHorizontally),
        ) {
            PrzyciskRozmowy(
                ikona = if (stan.mikrofonWlaczony) Ikony.Mikrofon else Ikony.MikrofonWyciszony,
                opis = if (stan.mikrofonWlaczony) "Wycisz" else "Włącz mikrofon",
                wlaczony = stan.mikrofonWlaczony,
                onClick = { model.przelaczMikrofon() },
            )
            PrzyciskRozmowy(
                ikona = if (stan.kameraWlaczona) Ikony.Kamera else Ikony.KameraWylaczona,
                opis = if (stan.kameraWlaczona) "Wyłącz obraz" else "Włącz obraz",
                wlaczony = stan.kameraWlaczona,
                onClick = { przelaczObraz() },
            )
            PrzyciskRozmowy(
                ikona = Ikony.Rozlacz,
                opis = "Zakończ",
                wlaczony = true,
                alarmowy = true,
                onClick = onZakoncz,
            )
        }

        Text(
            text = "„Bezpośrednio” znaczy, że rozmówca zna Twój adres IP. " +
                "„Przez przekaźnik” — że zna go serwer TURN.",
            style = MaterialTheme.typography.labelSmall,
            color = Nocturne.kolory.tekstTrzeci,
            textAlign = TextAlign.Center,
            modifier = Modifier.fillMaxWidth().padding(horizontal = Odstep.xl, vertical = Odstep.l),
        )
    }
}

/**
 * Siatka kafelków — własny pierwszy, potem rozmówcy.
 *
 * Liczba kolumn wynika z liczby kafelków, a nie jest stała. Sztywne dwie
 * kolumny przy jednym rozmówcy zostawiały pół ekranu pustki obok jedynego
 * obrazu, na jaki ktoś w ogóle patrzy.
 */
@Composable
private fun SiatkaKafelkow(
    wlasne: VideoTrack?,
    uczestnicy: List<UczestnikRozmowy>,
    kontekstGl: EglBase.Context?,
    modifier: Modifier = Modifier,
) {
    val kafelki = uczestnicy.size + 1

    // Jeden kafelek — cała wysokość. Dwa — jeden nad drugim, bo telefon jest
    // wysoki i wąski, a dwa obok siebie dałyby dwa paski wielkości znaczka.
    // Trzy i cztery mieszczą się dopiero w siatce 2×2.
    val kolumny = if (kafelki <= 2) 1 else 2

    // Własny kafelek jest pierwszy — patrzy się na niego, żeby sprawdzić, co
    // widzi druga strona, więc nie może być schowany za rozmówcami.
    val wszystkie = listOf(OpisKafelka(nazwa = "Ty", podpis = null, wideo = wlasne, lustro = true)) +
        uczestnicy.map { uczestnik ->
            OpisKafelka(
                nazwa = uczestnik.nazwa,
                podpis = opisFazy(uczestnik),
                wideo = uczestnik.wideo,
                lustro = false,
                alarm = uczestnik.faza == FazaPolaczenia.ODRZUCONA,
            )
        }

    Column(modifier, verticalArrangement = Arrangement.spacedBy(Odstep.s)) {
        wszystkie.chunked(kolumny).forEach { rzad ->
            Row(
                modifier = Modifier.fillMaxWidth().weight(1f),
                horizontalArrangement = Arrangement.spacedBy(Odstep.s),
            ) {
                rzad.forEach { opis ->
                    Kafelek(
                        opis = opis,
                        kontekstGl = kontekstGl,
                        modifier = Modifier.weight(1f).fillMaxHeight(),
                    )
                }

                // Niepełny ostatni rząd: kafelek zostaje swojej szerokości,
                // zamiast rozciągać się na całą i wyglądać jak inny układ.
                if (rzad.size < kolumny) {
                    Spacer(Modifier.weight((kolumny - rzad.size).toFloat()))
                }
            }
        }
    }
}

/** Co narysować w jednym kafelku. */
private data class OpisKafelka(
    val nazwa: String,
    val podpis: String?,
    val wideo: VideoTrack?,
    val lustro: Boolean,
    val alarm: Boolean = false,
)

/** Etykieta drogi połączenia — zdanie o tym, kto zna Twój adres IP. */
private fun opisFazy(uczestnik: UczestnikRozmowy): String = when (uczestnik.faza) {
    FazaPolaczenia.LACZENIE -> "łączę…"
    FazaPolaczenia.POLACZONA -> if (uczestnik.bezposrednio) "bezpośrednio" else "przez przekaźnik"
    FazaPolaczenia.ZAKONCZONA -> "rozłączony"
    // Niezgodny odcisk DTLS. Mówimy wprost, bo to jedyny stan na tym ekranie,
    // który znaczy „ktoś próbował podsłuchać".
    FazaPolaczenia.ODRZUCONA -> "odcisk się nie zgadza"
}

/**
 * Kafelek jednej osoby: obraz albo awatar, zawsze podpisany.
 *
 * Awatar leży POD podglądem, a nie zamiast niego, więc pojawienie się obrazu
 * niczego nie przebudowuje — kafelek nie mruga przy włączaniu i wyłączaniu
 * kamery, bo jego układ się nie zmienia.
 */
@Composable
private fun Kafelek(
    opis: OpisKafelka,
    kontekstGl: EglBase.Context?,
    modifier: Modifier = Modifier,
) {
    Box(
        modifier = modifier
            .clip(RoundedCornerShape(12.dp))
            .background(Nocturne.kolory.wglebienie)
            .border(1.dp, Nocturne.kolory.linia, RoundedCornerShape(12.dp)),
    ) {
        Awatar(opis.nazwa, rozmiar = 56.dp, modifier = Modifier.align(Alignment.Center))

        if (opis.wideo != null && kontekstGl != null) {
            PodgladWideo(
                sciezka = opis.wideo,
                kontekstGl = kontekstGl,
                lustro = opis.lustro,
                modifier = Modifier.fillMaxSize(),
            )
        }

        Row(
            modifier = Modifier
                .align(Alignment.BottomStart)
                .fillMaxWidth()
                .padding(Odstep.s),
            verticalAlignment = Alignment.CenterVertically,
            horizontalArrangement = Arrangement.SpaceBetween,
        ) {
            Text(
                opis.nazwa,
                style = MaterialTheme.typography.labelSmall,
                maxLines = 1,
                overflow = TextOverflow.Ellipsis,
                modifier = Modifier.weight(1f, fill = false),
            )

            opis.podpis?.let {
                Text(
                    it,
                    style = MaterialTheme.typography.labelSmall,
                    color = if (opis.alarm) Nocturne.kolory.alarm else Nocturne.kolory.tekstDrugi,
                )
            }
        }
    }
}

/**
 * Obraz z jednej ścieżki WebRTC.
 *
 * # Dlaczego zwalnianie jest tu tak wyeksponowane
 *
 * `SurfaceViewRenderer` trzyma powierzchnię OpenGL i jest wpięty w ścieżkę jako
 * odbiornik klatek. Obrót ekranu składa ten widok od nowa, więc bez odpięcia
 * na każdej starej powierzchni zostaje żywy sink: pamięć rośnie, a podgląd
 * zamarza na ostatniej klatce, bo dekoder rysuje do widoku, którego już nie ma
 * na ekranie.
 *
 * `runCatching` przy sprzątaniu nie jest zamiataniem błędu pod dywan.
 * Zakończenie rozmowy zwalnia ścieżki i kontekst OpenGL, a Compose sprząta
 * dopiero przy następnej klatce — więc odpinamy się od czegoś, co legalnie może
 * już nie istnieć. To jedyny przypadek, w którym wyjątek stąd nic nie znaczy.
 */
@Composable
private fun PodgladWideo(
    sciezka: VideoTrack,
    kontekstGl: EglBase.Context,
    lustro: Boolean,
    modifier: Modifier = Modifier,
) {
    val kontekst = LocalContext.current

    // Zmiana ścieżki znaczy nową powierzchnię — `key` gwarantuje, że stara
    // przejdzie przez `onDispose`, zamiast zostać podmieniona w locie.
    key(sciezka) {
        val podglad = remember { SurfaceViewRenderer(kontekst) }

        DisposableEffect(podglad) {
            podglad.init(kontekstGl, null)
            podglad.setScalingType(RendererCommon.ScalingType.SCALE_ASPECT_FILL)
            podglad.setEnableHardwareScaler(true)
            // Podgląd własnej kamery MUSI być lustrzany. Bez tego ruch w lewo
            // widać po prawej i człowiek odruchowo poprawia się w złą stronę —
            // tak wygląda każdy podgląd własnej kamery, jaki ktokolwiek widział.
            podglad.setMirror(lustro)
            sciezka.addSink(podglad)

            onDispose {
                runCatching { sciezka.removeSink(podglad) }
                runCatching { podglad.release() }
            }
        }

        AndroidView(factory = { podglad }, modifier = modifier)
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
        alarmowy -> Nocturne.kolory.alarm
        wlaczony -> Nocturne.kolory.akcent
        else -> Nocturne.kolory.liniaMocna
    }

    // 56 dp, wyraźnie powyżej minimum: w rozmowie trafia się w te przyciski
    // nie patrząc, z telefonem przy uchu.
    Box(
        modifier = Modifier
            .size(56.dp)
            .clip(CircleShape)
            .border(1.dp, obrys, CircleShape)
            .clickable(onClick = onClick),
        contentAlignment = Alignment.Center,
    ) {
        Icon(
            ikona,
            contentDescription = opis,
            tint = when {
                alarmowy -> Nocturne.kolory.alarm
                wlaczony -> Nocturne.kolory.akcentTekst
                else -> Nocturne.kolory.tekstTrzeci
            },
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
            color = Nocturne.kolory.tekstDrugi,
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
