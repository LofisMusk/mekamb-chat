package com.mekamb.chat

import android.Manifest
import android.app.Activity
import android.content.Intent
import android.net.Uri
import android.os.Bundle
import androidx.activity.ComponentActivity
import androidx.activity.compose.BackHandler
import androidx.activity.compose.rememberLauncherForActivityResult
import androidx.activity.result.contract.ActivityResultContracts
import androidx.activity.compose.setContent
import androidx.activity.enableEdgeToEdge
import androidx.compose.foundation.layout.Arrangement
import androidx.compose.foundation.layout.Column
import androidx.compose.foundation.layout.fillMaxSize
import androidx.compose.foundation.layout.fillMaxWidth
import androidx.compose.foundation.layout.padding
import androidx.compose.foundation.lazy.LazyColumn
import androidx.compose.foundation.lazy.items
import androidx.compose.material3.Button
import androidx.compose.material3.Card
import androidx.compose.material3.MaterialTheme
import androidx.compose.material3.OutlinedTextField
import androidx.compose.material3.Scaffold
import androidx.compose.material3.Text
import androidx.compose.material3.TextButton
import androidx.compose.runtime.Composable
import androidx.compose.runtime.LaunchedEffect
import androidx.compose.runtime.SideEffect
import androidx.compose.runtime.getValue
import androidx.compose.runtime.mutableStateOf
import androidx.compose.runtime.remember
import androidx.compose.runtime.setValue
import androidx.compose.ui.platform.LocalView
import androidx.core.view.WindowCompat
import androidx.compose.foundation.layout.Row
import androidx.compose.foundation.layout.size
import androidx.compose.material3.Icon
import androidx.compose.ui.Alignment
import androidx.compose.foundation.rememberScrollState
import androidx.compose.foundation.verticalScroll
import androidx.compose.foundation.layout.imePadding
import androidx.compose.ui.Modifier
import androidx.compose.ui.platform.LocalContext
import androidx.compose.ui.text.input.PasswordVisualTransformation
import androidx.compose.ui.unit.dp
import androidx.lifecycle.viewmodel.compose.viewModel
import uniffi.mekamb_ffi.DeliveryMode

class MainActivity : ComponentActivity() {

    override fun onCreate(savedInstanceState: Bundle?) {
        super.onCreate(savedInstanceState)
        enableEdgeToEdge()

        setContent {
            /*
             * Wybór motywu żyje tutaj, nie w `ChatViewModel`.
             *
             * Model powstaje po zalogowaniu i jest o rozmowach; motyw działa od
             * pierwszego ekranu i po wylogowaniu ma zostać. Trzymany niżej
             * gasłby razem z sesją, czyli wracałby do domyślnego dokładnie
             * wtedy, gdy użytkownik go najmniej się spodziewa.
             */
            var wybor by remember { mutableStateOf(Motyw.wczytaj(this)) }

            MotywNocturne(wybor) {
                PasekSystemowy()

                Scaffold(
                    modifier = Modifier.fillMaxSize(),
                    containerColor = Nocturne.kolory.tlo,
                ) { wciecia ->
                    Zawartosc(
                        wyborMotywu = wybor,
                        onMotyw = {
                            wybor = it
                            Motyw.zapisz(this, it)
                        },
                        modifier = Modifier
                            .fillMaxSize()
                            .padding(wciecia)
                            .padding(Odstep.ekran),
                    )
                }
            }
        }
    }

    // Aplikacja mogła już działać, gdy użytkownik zeskanował kod.
    /*
     * Czy aplikacja jest na wierzchu — do decyzji o powiadomieniach.
     *
     * Kto ma otwartą rozmowę przed oczami, ten widzi wchodzącą wiadomość
     * i powiedzenie mu o niej drugi raz jest szumem. Rozstrzyga to
     * [UslugaNasluchu]; tu zapisujemy tylko fakt.
     *
     * `onStart`/`onStop`, a nie `onResume`/`onPause`: `onPause` przychodzi
     * także wtedy, gdy nad aplikacją stanie systemowe okienko uprawnień —
     * a wtedy użytkownik dalej patrzy na rozmowę.
     */
    override fun onStart() {
        super.onStart()
        Rdzen.naWierzchu = true
    }

    override fun onStop() {
        Rdzen.naWierzchu = false
        super.onStop()
    }
}

/**
 * Ikony paska systemowego pod motyw.
 *
 * Rysujemy od krawędzi do krawędzi (`enableEdgeToEdge`), więc pasek stanu
 * pokazuje NASZE tło. Bez tego w motywie jasnym zostają na nim białe ikony
 * na białym tle — godzina i zasięg znikają, a wygląda to jak usterka systemu,
 * nie aplikacji.
 */
@Composable
private fun PasekSystemowy() {
    val jasny = Nocturne.kolory.jasny
    val widok = LocalView.current

    if (widok.isInEditMode) return

    SideEffect {
        val okno = (widok.context as Activity).window
        WindowCompat.getInsetsController(okno, widok).run {
            isAppearanceLightStatusBars = jasny
            isAppearanceLightNavigationBars = jasny
        }
    }
}

@Composable
private fun Zawartosc(
    wyborMotywu: WyborMotywu,
    onMotyw: (WyborMotywu) -> Unit,
    modifier: Modifier = Modifier,
) {
    val model: ChatViewModel = viewModel()
    val stan = model.stan

    // Gałąź dolnej nawigacji i to, czy pokazujemy wybór rozmówcy. Stan
    // wyłącznie widoku — model nie musi o nim wiedzieć.
    var galaz by remember { mutableStateOf(Galaz.ROZMOWY) }
    var nowaRozmowa by remember { mutableStateOf(false) }

    // Czy pokazujemy rozmowę, czy listę. To stan WIDOKU, nie modelu: wyjście
    // z rozmowy przez skasowanie `groupId` odcięłoby drogę powrotną, bo bez
    // niego nie da się do rozmowy wrócić.
    var wRozmowie by remember { mutableStateOf(false) }

    // Wideo albo sam głos — o co poprosimy system, zanim zaczniemy rozmowę.
    var rozmowaZWideo by remember { mutableStateOf(false) }
    var odbieramy by remember { mutableStateOf(false) }
    val kontekst = LocalContext.current

    /*
     * Uprawnienia bierzemy dopiero przy dzwonieniu.
     *
     * Prośba przy starcie aplikacji jest prośbą, której użytkownik nie umie
     * powiązać z niczym konkretnym — a uprawnienie nadane na ślepo jest gorsze
     * niż odmowa. Odmowa też nie jest awarią: rozmowa się po prostu nie zaczyna.
     */
    val uprawnienia = rememberLauncherForActivityResult(
        ActivityResultContracts.RequestMultiplePermissions(),
    ) { wynik ->
        val mikrofon = wynik[Manifest.permission.RECORD_AUDIO] ?: false
        if (!mikrofon) return@rememberLauncherForActivityResult

        val zObrazem = rozmowaZWideo && (wynik[Manifest.permission.CAMERA] ?: false)
        if (odbieramy) model.odbierzRozmowe(kontekst, zObrazem)
        else model.zadzwon(kontekst, zObrazem)
    }

    fun zacznijRozmowe(zWideo: Boolean, odbior: Boolean) {
        rozmowaZWideo = zWideo
        odbieramy = odbior

        val potrzebne = buildList {
            add(Manifest.permission.RECORD_AUDIO)
            if (zWideo) add(Manifest.permission.CAMERA)
        }
        uprawnienia.launch(potrzebne.toTypedArray())
    }
    var wUczestnikach by remember { mutableStateOf(false) }
    var wZgloszeniu by remember { mutableStateOf(false) }
    var wUstawieniach by remember { mutableStateOf(false) }

    // Ustawienie prywatności żyje tak samo długo jak motyw — poza modelem,
    // który powstaje dopiero po zalogowaniu i gaśnie razem z sesją.
    var odczytPotwierdzen by remember { mutableStateOf(PotwierdzeniaOdczytu.wlaczone(kontekst)) }

    // Otwarta rozmowa jest przeczytana. Warunkiem jest widok na ekranie,
    // nie samo dotarcie wiadomości.
    LaunchedEffect(stan.groupId, wRozmowie, stan.wiadomosci.size) {
        if (wRozmowie && stan.groupId != null) model.oznaczPrzeczytane()
    }

    /*
     * Która rozmowa jest na ekranie — i sprzątanie jej powiadomień.
     *
     * Otwarcie wątku jest zobaczeniem tego, o czym powiadomienie mówiło, więc
     * musi je zgasić. Zostawione wisiałoby jako informacja o wiadomości, którą
     * użytkownik właśnie czyta.
     */
    LaunchedEffect(stan.groupId, wRozmowie) {
        val otwarta = stan.groupId?.takeIf { wRozmowie }
        Rdzen.otwartaGrupa = otwarta
        if (otwarta != null) Powiadomienia.schowajWiadomosci(kontekst, otwarta)
    }

    // Baner dzwoniącej rozmowy gaśnie, gdy nie ma już czego banerować —
    // po odebraniu, odrzuceniu albo rozłączeniu się dzwoniącego.
    LaunchedEffect(stan.przychodzacaRozmowa) {
        if (stan.przychodzacaRozmowa == null) Powiadomienia.schowajRozmowe(kontekst)
    }

    // Nowa rozmowa — własna albo przychodząca — otwiera się od razu.
    LaunchedEffect(stan.groupId) {
        if (stan.groupId != null) {
            nowaRozmowa = false
            wRozmowie = true
            // Rozmowa zaczęta z Kontaktów ma otworzyć rozmowę, a nie zostawić
            // użytkownika w gałęzi, z której wyszedł.
            galaz = Galaz.ROZMOWY
        }
    }

    /*
     * Systemowe „wstecz".
     *
     * Bez tego przycisk i gest krawędziowy zamykały aplikację z każdego
     * ekranu — także z rozmowy, do której użytkownik przed chwilą wszedł
     * z listy. Ekrany mają już strzałki, ale to Android decyduje, co robi
     * jego własny gest, i musi robić dokładnie to samo.
     *
     * Kolejność odpowiada kolejności ekranów w `when` niżej: obsługujemy ten
     * ekran, który jest na wierzchu. `enabled = false` oznacza „nie mamy dokąd
     * wrócić" — wtedy back wychodzi z aplikacji, tak jak wypada na ekranie
     * startowym.
     */
    // Rozmowy nie kończy przypadkowy gest wstecz — kończy ją przycisk.
    // „Wstecz" podczas rozmowy nie robi nic, zamiast rozłączyć bez pytania.
    BackHandler(enabled = stan.rozmowaAV.isNotEmpty()) {}

    BackHandler(enabled = stan.przychodzacaRozmowa != null) { model.odrzucRozmowe() }

    BackHandler(enabled = wZgloszeniu) { wZgloszeniu = false }
    BackHandler(enabled = !wZgloszeniu && wUstawieniach) { wUstawieniach = false }
    BackHandler(enabled = !wUstawieniach && wUczestnikach) {
        wUczestnikach = false
    }

    val wGlebi = wUstawieniach || wUczestnikach || wZgloszeniu

    // Rozmowa wraca do listy — nie do gałęzi, z której ją otwarto.
    BackHandler(enabled = !wGlebi && stan.zalogowany && wRozmowie) {
        wRozmowie = false
        galaz = Galaz.ROZMOWY
    }

    BackHandler(enabled = !wGlebi && stan.zalogowany && !wRozmowie && nowaRozmowa) {
        nowaRozmowa = false
    }

    BackHandler(
        enabled = !wGlebi && stan.zalogowany && !wRozmowie && !nowaRozmowa &&
            galaz != Galaz.ROZMOWY,
    ) {
        galaz = Galaz.ROZMOWY
    }

    // Przed zalogowaniem wracamy do powitania, bo ono prowadzi do wszystkich
    // trzech dróg wejścia. Wyjątek to drugi krok logowania: on wraca do
    // pierwszego, żeby dało się poprawić nazwę albo hasło.
    BackHandler(enabled = !stan.zalogowany && stan.ekran == Ekran.KOD_LOGOWANIA) {
        model.pokaz(Ekran.LOGOWANIE)
    }
    BackHandler(
        enabled = !stan.zalogowany && stan.ekran in
            setOf(Ekran.REJESTRACJA, Ekran.LOGOWANIE, Ekran.POTWIERDZENIE),
    ) {
        // Z potwierdzenia wychodzi się z konsekwencją: konto już istnieje, ale
        // bez kodu jest bezużyteczne, a jego nazwy nie da się zająć drugi raz.
        // Ekran mówi o tym wprost, zamiast po cichu cofnąć.
        if (stan.ekran == Ekran.POTWIERDZENIE) model.ostrzezONiepotwierdzonymKoncie()
        model.pokaz(Ekran.POWITANIE)
    }

    Column(modifier = modifier, verticalArrangement = Arrangement.spacedBy(Odstep.l)) {
        // Znak i droga dostarczania dopiero po zalogowaniu. Ekrany wejścia mają
        // własne nagłówki, a tryb połączenia nic tam jeszcze nie znaczy.
        if (stan.zalogowany) {
            Row(
                verticalAlignment = Alignment.CenterVertically,
                horizontalArrangement = Arrangement.spacedBy(Odstep.s),
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
                Text(
                    text = when (stan.trybPolaczenia) {
                        DeliveryMode.DIRECT -> "bezpośrednio — rozmówca zna Twój adres IP"
                        DeliveryMode.MAILBOX -> "przez serwer"
                        null -> "brak połączenia"
                    },
                    style = MaterialTheme.typography.labelSmall,
                    color = Nocturne.kolory.tekstDrugi,
                )
            }
        }

        stan.blad?.let { komunikat ->
            PasekBledu(komunikat, onZamknij = { model.wyczyscBlad() })
        }

        stan.informacja?.let { komunikat ->
            Karta { Text(komunikat, style = MaterialTheme.typography.bodySmall) }
        }

        when {
            // Rozmowa A/V przykrywa wszystko: gdy trwa, jest jedyną rzeczą,
            // którą użytkownik chce widzieć.
            stan.zalogowany && stan.rozmowaAV.isNotEmpty() ->
                EkranRozmowyAV(model, onZakoncz = { model.zakonczRozmowe() })

            stan.zalogowany && stan.przychodzacaRozmowa != null ->
                EkranPrzychodzacejRozmowy(
                    od = stan.przychodzacaRozmowa!!.od,
                    onOdbierz = { zWideo -> zacznijRozmowe(zWideo, odbior = true) },
                    onOdrzuc = { model.odrzucRozmowe() },
                )

            // Po zalogowaniu ekranem startowym jest lista, a nie od razu
            // formularz „z kim rozmawiasz". Wybór rozmówcy zszedł pod
            // „Nowa rozmowa", bo dotyczy pierwszego kontaktu, a nie każdego
            // wejścia do aplikacji.
            stan.zalogowany && wZgloszeniu ->
                EkranZgloszenia(model, onWstecz = { wZgloszeniu = false })

            stan.zalogowany && wUstawieniach ->
                EkranUstawien(
                    model,
                    wyborMotywu = wyborMotywu,
                    onMotyw = onMotyw,
                    odczyt = odczytPotwierdzen,
                    onOdczyt = {
                        odczytPotwierdzen = it
                        PotwierdzeniaOdczytu.ustaw(kontekst, it)
                    },
                    onWstecz = { wUstawieniach = false },
                )

            stan.zalogowany && wUczestnikach ->
                EkranUczestnikow(model, onWstecz = { wUczestnikach = false })

            stan.zalogowany && galaz == Galaz.KONTAKTY ->
                EkranKontaktow(model, onGalaz = { galaz = it })

            stan.zalogowany && galaz == Galaz.KONTO ->
                EkranKonta(
                    model = model,
                    onUczestnicy = {
                        model.odswiezUczestnikow()
                        wUczestnikach = true
                    },
                    onUstawienia = { wUstawieniach = true },
                    onZgloszenie = { wZgloszeniu = true },
                    onGalaz = { galaz = it },
                )

            stan.zalogowany && stan.groupId != null && wRozmowie ->
                EkranRozmowy(
                    model = model,
                    onWstecz = { wRozmowie = false },
                    onUczestnicy = {
                        model.odswiezUczestnikow()
                        wUczestnikach = true
                    },
                    onRozmowa = { zWideo -> zacznijRozmowe(zWideo, odbior = false) },
                )

            stan.zalogowany && nowaRozmowa -> EkranKontaktow(model, onGalaz = { galaz = it })

            stan.zalogowany ->
                EkranListy(
                    model = model,
                    onOtworzRozmowe = { pozycja ->
                        model.otworzRozmowe(pozycja)
                        wRozmowie = true
                    },
                    onNowaRozmowa = { nowaRozmowa = true },
                    onGalaz = { galaz = it },
                    onUstawienia = { wUstawieniach = true },
                )
            stan.ekran == Ekran.REJESTRACJA -> EkranRejestracji(model)
            stan.ekran == Ekran.POTWIERDZENIE -> PotwierdzenieTotp(model)
            stan.ekran == Ekran.LOGOWANIE -> EkranLogowania(model)
            stan.ekran == Ekran.KOD_LOGOWANIA -> EkranKoduLogowania(model)
            else -> EkranPowitania(model)
        }
    }
}

@Composable
private fun PotwierdzenieTotp(model: ChatViewModel) {
    val kontekst = LocalContext.current
    var kod by remember { mutableStateOf("") }
    val stan = model.stan

    // Przewijanie i odsunięcie od klawiatury nie są kosmetyką: ekran ma kod QR,
    // sekret i dwa przyciski, więc przy otwartej klawiaturze „Potwierdź" ląduje
    // POD nią i nie da się go dosięgnąć. Bez tego rejestracji nie da się
    // dokończyć — sprawdzone na emulatorze, zanim to naprawiłem.
    Column(
        modifier = Modifier
            .fillMaxWidth()
            .verticalScroll(rememberScrollState())
            .imePadding(),
        verticalArrangement = Arrangement.spacedBy(Odstep.l),
    ) {
        NaglowekEkranu("Drugi składnik", "Second factor")

        // Trzy drogi obok siebie, bo żadna nie działa wszędzie: kod QR wymaga
        // drugiego urządzenia, odnośnik działa tylko na tym samym telefonie,
        // a przepisanie sekretu działa zawsze i jest ostatnią deską ratunku.
        stan.otpauthUri?.let { uri ->
            Text(
                "Zeskanuj aplikacją authenticator:",
                style = MaterialTheme.typography.bodyMedium,
                color = Nocturne.kolory.tekstDrugi,
            )
            KodQr(
                tresc = uri,
                opis = "Kod QR do dodania konta w aplikacji authenticator",
                modifier = Modifier.align(Alignment.CenterHorizontally),
            )

            PrzyciskDrugi("Otwórz w aplikacji na tym telefonie") {
                runCatching {
                    kontekst.startActivity(Intent(Intent.ACTION_VIEW, Uri.parse(uri)))
                }
            }
        }

        stan.sekretTotp?.let { sekret ->
            Text(
                "Albo wpisz ten sekret ręcznie:",
                style = MaterialTheme.typography.labelMedium,
                color = Nocturne.kolory.tekstDrugi,
            )
            Karta { Text(sekret, style = MaterialTheme.typography.bodyMedium) }
        }

        Pole("Kod z authenticatora · Code", kod, { kod = it.filter(Char::isDigit).take(6) }, cyfry = true)

        PrzyciskGlowny(
            if (stanZajety(model)) "Potwierdzam…" else "Potwierdź · Confirm",
            wlaczony = !stanZajety(model) && kod.length == 6,
        ) {
            model.potwierdzRejestracje(kod)
        }
    }
}

private fun stanZajety(model: ChatViewModel) = model.stan.pracuje
