package com.mekamb.chat

import android.content.Intent
import android.net.Uri
import android.os.Bundle
import androidx.activity.ComponentActivity
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
import androidx.compose.runtime.getValue
import androidx.compose.runtime.mutableStateOf
import androidx.compose.runtime.remember
import androidx.compose.runtime.setValue
import androidx.compose.foundation.layout.Row
import androidx.compose.foundation.layout.size
import androidx.compose.material3.Icon
import androidx.compose.ui.Alignment
import androidx.compose.ui.Modifier
import androidx.compose.ui.platform.LocalContext
import androidx.compose.ui.text.input.PasswordVisualTransformation
import androidx.compose.ui.unit.dp
import androidx.lifecycle.viewmodel.compose.viewModel
import uniffi.mekamb_ffi.DeliveryMode

class MainActivity : ComponentActivity() {

    /**
     * Kod przeniesienia, z którym aplikację otwarto.
     *
     * Trafia tu, gdy użytkownik zeskanuje kod QR aparatem systemowym. Trzymany
     * jako stan, bo intencja może przyjść też do już działającej aplikacji.
     */
    private var kodZIntencji by mutableStateOf<String?>(null)

    override fun onCreate(savedInstanceState: Bundle?) {
        super.onCreate(savedInstanceState)
        enableEdgeToEdge()
        kodZIntencji = kodPrzeniesienia(intent)

        setContent {
            MotywNocturne {
                Scaffold(modifier = Modifier.fillMaxSize()) { wciecia ->
                    Zawartosc(
                        kodZIntencji = kodZIntencji,
                        onKodZuzyty = { kodZIntencji = null },
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
    override fun onNewIntent(intent: Intent) {
        super.onNewIntent(intent)
        kodPrzeniesienia(intent)?.let { kodZIntencji = it }
    }

    private fun kodPrzeniesienia(intent: Intent?): String? {
        if (intent?.action != Intent.ACTION_VIEW) return null
        val dane: Uri = intent.data ?: return null
        return dane.toString().takeIf(Przeniesienie::czyKodPrzeniesienia)
    }
}

@Composable
private fun Zawartosc(
    kodZIntencji: String?,
    onKodZuzyty: () -> Unit,
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

    // Nowa rozmowa — własna albo przychodząca — otwiera się od razu.
    LaunchedEffect(stan.groupId) {
        if (stan.groupId != null) {
            nowaRozmowa = false
            wRozmowie = true
        }
    }

    // Kod zeskanowany aparatem otwiera od razu ekran odbioru. Robimy to tylko
    // przed zalogowaniem: odebranie konta na zalogowanym urządzeniu podmieniłoby
    // skarbiec pod działającym klientem.
    LaunchedEffect(kodZIntencji, stan.zalogowany) {
        if (kodZIntencji != null && !stan.zalogowany) {
            model.pokaz(Ekran.ODBIOR)
        }
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
                    tint = if (stan.trybPolaczenia == null) Neutral600 else Akcent,
                    modifier = Modifier.size(16.dp),
                )
                Text(
                    text = when (stan.trybPolaczenia) {
                        DeliveryMode.DIRECT -> "bezpośrednio — rozmówca zna Twój adres IP"
                        DeliveryMode.MAILBOX -> "przez serwer"
                        null -> "brak połączenia"
                    },
                    style = MaterialTheme.typography.labelSmall,
                    color = TekstPrzygaszony,
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
            // Po zalogowaniu ekranem startowym jest lista, a nie od razu
            // formularz „z kim rozmawiasz". Wybór rozmówcy zszedł pod
            // „Nowa rozmowa", bo dotyczy pierwszego kontaktu, a nie każdego
            // wejścia do aplikacji.
            stan.zalogowany && stan.groupId != null && wRozmowie ->
                EkranRozmowy(
                    model = model,
                    onWstecz = { wRozmowie = false },
                    onUczestnicy = {},
                    onRozmowa = {},
                )

            stan.zalogowany && nowaRozmowa -> FormularzRozmowy(model)

            stan.zalogowany ->
                EkranListy(
                    model = model,
                    onOtworzRozmowe = { pozycja ->
                        model.otworzRozmowe(pozycja)
                        wRozmowie = true
                    },
                    onNowaRozmowa = { nowaRozmowa = true },
                    onGalaz = { galaz = it },
                )
            stan.ekran == Ekran.REJESTRACJA -> FormularzRejestracji(model)
            stan.ekran == Ekran.POTWIERDZENIE -> PotwierdzenieTotp(model)
            stan.ekran == Ekran.ODBIOR -> OdbiorKonta(model, kodZIntencji, onKodZuzyty)
            stan.ekran == Ekran.LOGOWANIE -> EkranLogowania(model)
            stan.ekran == Ekran.KOD_LOGOWANIA -> EkranKoduLogowania(model)
            else -> EkranPowitania(model)
        }
    }
}

@Composable
private fun FormularzRejestracji(model: ChatViewModel) {
    var username by remember { mutableStateOf("") }
    var haslo by remember { mutableStateOf("") }

    Column(verticalArrangement = Arrangement.spacedBy(8.dp)) {
        Text("Nowe konto", style = MaterialTheme.typography.titleMedium)

        OutlinedTextField(
            value = username,
            onValueChange = { username = it },
            label = { Text("Nazwa użytkownika") },
            modifier = Modifier.fillMaxWidth(),
        )
        OutlinedTextField(
            value = haslo,
            onValueChange = { haslo = it },
            label = { Text("Hasło (min. 12 znaków)") },
            visualTransformation = PasswordVisualTransformation(),
            modifier = Modifier.fillMaxWidth(),
        )

        Text(
            "Hasło nie opuszcza tego urządzenia. Serwer nigdy go nie zobaczy — " +
                "ale też nie pomoże Ci go odzyskać.",
            style = MaterialTheme.typography.bodySmall,
        )

        Button(
            onClick = { model.zarejestruj(username, haslo) },
            enabled = !stanZajety(model) && username.length >= 3 && haslo.length >= 12,
            modifier = Modifier.fillMaxWidth(),
        ) {
            Text(if (stanZajety(model)) "Zakładam…" else "Załóż konto")
        }
        TextButton(
            onClick = { model.pokaz(Ekran.LOGOWANIE) },
            modifier = Modifier.fillMaxWidth(),
        ) {
            Text("Mam już konto")
        }
    }
}

/**
 * Drugi składnik przy zakładaniu konta.
 *
 * Na telefonie nie ma po co pokazywać kodu QR: authenticator jest na tym samym
 * urządzeniu, więc odnośnik `otpauth://` wpisuje wszystko sam. Sekret do
 * przepisania zostaje jako droga awaryjna — dla tych, którzy trzymają
 * authenticator gdzie indziej.
 */
@Composable
private fun PotwierdzenieTotp(model: ChatViewModel) {
    val kontekst = LocalContext.current
    var kod by remember { mutableStateOf("") }
    val stan = model.stan

    Column(verticalArrangement = Arrangement.spacedBy(8.dp)) {
        Text("Drugi składnik", style = MaterialTheme.typography.titleMedium)

        stan.otpauthUri?.let { uri ->
            Button(
                onClick = {
                    runCatching {
                        kontekst.startActivity(Intent(Intent.ACTION_VIEW, Uri.parse(uri)))
                    }
                },
                modifier = Modifier.fillMaxWidth(),
            ) {
                Text("Dodaj w aplikacji authenticator")
            }
        }

        stan.sekretTotp?.let { sekret ->
            Text("Albo wpisz ten sekret ręcznie:", style = MaterialTheme.typography.bodySmall)
            Card(Modifier.fillMaxWidth()) {
                Text(sekret, Modifier.padding(12.dp), style = MaterialTheme.typography.bodyMedium)
            }
        }

        OutlinedTextField(
            value = kod,
            onValueChange = { kod = it },
            label = { Text("Kod z authenticatora") },
            modifier = Modifier.fillMaxWidth(),
        )

        Button(
            onClick = { model.potwierdzRejestracje(kod) },
            enabled = !stanZajety(model) && kod.isNotBlank(),
            modifier = Modifier.fillMaxWidth(),
        ) {
            Text(if (stanZajety(model)) "Potwierdzam…" else "Potwierdź")
        }
    }
}

/**
 * Odbiór konta przeniesionego z innego urządzenia.
 *
 * Kod zeskanowany aparatem systemowym trafia tu sam — Android otwiera
 * aplikację odnośnikiem `mekamb://transfer`. Pole tekstowe zostaje dla tych,
 * którzy wolą przepisać, i na wypadek gdyby aparat nie rozpoznał kodu.
 */
@Composable
private fun OdbiorKonta(model: ChatViewModel, kodZIntencji: String?, onKodZuzyty: () -> Unit) {
    var kod by remember(kodZIntencji) { mutableStateOf(kodZIntencji.orEmpty()) }

    Column(verticalArrangement = Arrangement.spacedBy(8.dp)) {
        Text("Odbierz konto", style = MaterialTheme.typography.titleMedium)
        Text(
            "Na starym urządzeniu wybierz „Przenieś na inne urządzenie" +
                "\u201d i zeskanuj kod aparatem albo przepisz go poniżej.",
            style = MaterialTheme.typography.bodySmall,
        )

        OutlinedTextField(
            value = kod,
            onValueChange = { kod = it },
            label = { Text("Kod przeniesienia") },
            placeholder = { Text("mekamb://transfer?…") },
            modifier = Modifier.fillMaxWidth(),
        )

        Button(
            onClick = {
                model.odbierzKonto(kod)
                onKodZuzyty()
            },
            enabled = !stanZajety(model) && kod.isNotBlank(),
            modifier = Modifier.fillMaxWidth(),
        ) {
            Text(if (stanZajety(model)) "Odbieram…" else "Odbierz konto")
        }

        Text(
            "Kod działa raz i wygasa po kwadransie. Po odebraniu przestań " +
                "używać starego urządzenia — dwa urządzenia z tym samym kontem " +
                "rozsypią szyfrowanie rozmowy.",
            style = MaterialTheme.typography.bodySmall,
        )

        TextButton(
            onClick = { model.pokaz(Ekran.LOGOWANIE) },
            modifier = Modifier.fillMaxWidth(),
        ) {
            Text("Wróć")
        }
    }
}

@Composable
private fun FormularzRozmowy(model: ChatViewModel) {
    var rozmowca by remember { mutableStateOf("") }

    Column(verticalArrangement = Arrangement.spacedBy(8.dp)) {
        OutlinedTextField(
            value = rozmowca,
            onValueChange = { rozmowca = it },
            label = { Text("Z kim rozmawiasz") },
            modifier = Modifier.fillMaxWidth(),
        )
        Button(
            onClick = { model.rozpocznijRozmowe(rozmowca) },
            modifier = Modifier.fillMaxWidth(),
        ) {
            Text("Rozpocznij rozmowę")
        }
    }
}

@Composable
private fun Rozmowa(model: ChatViewModel) {
    var tresc by remember { mutableStateOf("") }

    Column(verticalArrangement = Arrangement.spacedBy(8.dp)) {
        LazyColumn(
            modifier = Modifier.fillMaxWidth().weight(1f, fill = false),
            verticalArrangement = Arrangement.spacedBy(6.dp),
        ) {
            items(model.stan.wiadomosci) { wiadomosc ->
                Card(Modifier.fillMaxWidth()) {
                    Column(Modifier.padding(10.dp)) {
                        Text(wiadomosc.autor, style = MaterialTheme.typography.labelSmall)
                        Text(wiadomosc.tresc)
                    }
                }
            }
        }

        OutlinedTextField(
            value = tresc,
            onValueChange = { tresc = it },
            label = { Text("Napisz wiadomość") },
            modifier = Modifier.fillMaxWidth(),
        )
        Button(
            onClick = {
                model.wyslij(tresc)
                tresc = ""
            },
            modifier = Modifier.fillMaxWidth(),
        ) {
            Text("Wyślij")
        }
    }
}

private fun stanZajety(model: ChatViewModel) = model.stan.pracuje
