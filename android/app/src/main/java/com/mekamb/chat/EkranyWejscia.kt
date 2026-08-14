package com.mekamb.chat

import androidx.compose.foundation.background
import androidx.compose.foundation.layout.Arrangement
import androidx.compose.foundation.layout.Box
import androidx.compose.foundation.layout.height
import androidx.compose.foundation.shape.RoundedCornerShape
import androidx.compose.foundation.layout.Column
import androidx.compose.foundation.layout.Row
import androidx.compose.foundation.layout.Spacer
import androidx.compose.foundation.layout.fillMaxSize
import androidx.compose.foundation.layout.fillMaxWidth
import androidx.compose.foundation.layout.size
import androidx.compose.foundation.layout.padding
import androidx.compose.material3.Icon
import androidx.compose.material3.IconButton
import androidx.compose.material3.MaterialTheme
import androidx.compose.material3.Text
import androidx.compose.runtime.Composable
import androidx.compose.runtime.getValue
import androidx.compose.runtime.mutableStateOf
import androidx.compose.runtime.remember
import androidx.compose.runtime.setValue
import androidx.compose.foundation.rememberScrollState
import androidx.compose.foundation.verticalScroll
import androidx.compose.foundation.layout.imePadding
import androidx.compose.ui.Alignment
import androidx.compose.ui.Modifier
import androidx.compose.ui.unit.dp

/**
 * Ekrany przed zalogowaniem.
 *
 * # Co się zmieniło wobec poprzedniej wersji
 *
 * Były trzy pola w jednym formularzu: nazwa, hasło i kod z authenticatora.
 * Każde niepowodzenie wyglądało wtedy tak samo, więc pomyłka w haśle wyglądała
 * jak zły kod i użytkownik przepisywał kod w kółko. Teraz są dwa kroki i złe
 * hasło odpada w pierwszym.
 *
 * Doszedł ekran powitania — wcześniej aplikacja startowała wprost na
 * logowaniu, więc zakładanie konta i przenoszenie go z innego urządzenia były
 * schowane.
 */

/**
 * Powitanie: trzy drogi wejścia.
 *
 * # Czego tu nie ma
 *
 * Podtytułu „Szyfrowanie end-to-end. Serwer nie widzi treści." ani obietnicy
 * o kluczach pod przyciskami. Były zapewnieniem, po którym nikt nie mógł
 * podjąć innej decyzji — trzy drogi wejścia są te same niezależnie od tego,
 * czy się w nie wierzy. Zdania o kluczach zostają tam, gdzie mają skutek:
 * przy zakładaniu hasła, którego nikt nie odzyska, i przy przenoszeniu konta.
 */
@Composable
fun EkranPowitania(model: ChatViewModel, modifier: Modifier = Modifier) {
    Column(
        modifier = modifier
            .fillMaxSize()
            .verticalScroll(rememberScrollState())
            .padding(horizontal = Odstep.xl),
        verticalArrangement = Arrangement.Center,
    ) {
        Row(
            horizontalArrangement = Arrangement.spacedBy(Odstep.m),
            verticalAlignment = Alignment.CenterVertically,
        ) {
            OdznakaMarki()
            Text("mekamb", style = MaterialTheme.typography.titleLarge)
        }

        Spacer(Modifier.size(Odstep.xxl))
        Column(verticalArrangement = Arrangement.spacedBy(Odstep.m)) {
            PrzyciskGlowny("Załóż konto · Create account") { model.pokaz(Ekran.REJESTRACJA) }
            PrzyciskDrugi("Mam już konto · Sign in") { model.pokaz(Ekran.LOGOWANIE) }
        }
    }
}

/**
 * Nowe konto.
 *
 * Ograniczenia są w treści etykiet, a nie ukryte do momentu odrzucenia:
 * użytkownik ma wiedzieć, ile znaków musi mieć hasło, zanim je wymyśli.
 */
@Composable
fun EkranRejestracji(model: ChatViewModel, modifier: Modifier = Modifier) {
    var username by remember { mutableStateOf("") }
    var haslo by remember { mutableStateOf("") }
    val stan = model.stan

    Column(
        modifier = modifier
            .fillMaxSize()
            .verticalScroll(rememberScrollState())
            .imePadding(),
    ) {
        PasekZPowrotem("Nowe konto", "New account") { model.pokaz(Ekran.POWITANIE) }

        Column(
            modifier = Modifier.padding(horizontal = Odstep.xl),
            verticalArrangement = Arrangement.spacedBy(Odstep.l),
        ) {
            Pole("Nazwa użytkownika · Username", username, { username = it })
            Pole("Hasło · Password", haslo, { haslo = it }, haslo = true)
            SilaHasla(haslo)
        }

        Spacer(Modifier.size(Odstep.l))
        Column(modifier = Modifier.padding(horizontal = Odstep.xl)) {
        Wskazowka(
            "Hasło nie opuszcza tego urządzenia (OPAQUE). Serwer nigdy go nie zobaczy — " +
                "ale też nie pomoże Ci go odzyskać.",
            Ikony.Klucz,
        )

        Spacer(Modifier.size(Odstep.l))
        PrzyciskGlowny(
            if (stan.pracuje) "Zakładam…" else "Załóż konto · Create account",
            wlaczony = !stan.pracuje && username.length >= 3 && haslo.length >= MINIMUM_HASLA,
        ) {
            model.zarejestruj(username.trim(), haslo)
        }

        Spacer(Modifier.size(Odstep.s))
        PrzyciskCichy("Mam już konto") { model.pokaz(Ekran.LOGOWANIE) }
        }
    }
}

/**
 * Wskaźnik długości hasła.
 *
 * Trzy odcinki i liczba znaków, a nie ocena „słabe / mocne": jedyny warunek,
 * który naprawdę sprawdzamy, to dwanaście znaków, więc udawanie, że mierzymy
 * coś więcej, byłoby wprowadzaniem w błąd. Widać, ile brakuje, zanim przycisk
 * odmówi.
 */
@Composable
private fun SilaHasla(haslo: String) {
    val wypelnione = when {
        haslo.length >= MINIMUM_HASLA -> 3
        haslo.length >= MINIMUM_HASLA * 2 / 3 -> 2
        haslo.isNotEmpty() -> 1
        else -> 0
    }

    Row(
        verticalAlignment = Alignment.CenterVertically,
        horizontalArrangement = Arrangement.spacedBy(Odstep.s),
    ) {
        repeat(3) { i ->
            Box(
                Modifier
                    .weight(1f)
                    .height(3.dp)
                    .background(
                        if (i < wypelnione) Nocturne.kolory.akcent else Nocturne.kolory.linia,
                        RoundedCornerShape(2.dp),
                    ),
            )
        }

        Text(
            text = if (haslo.length >= MINIMUM_HASLA) {
                "wystarczy"
            } else {
                "min. $MINIMUM_HASLA znaków"
            },
            style = MaterialTheme.typography.labelSmall,
            color = if (haslo.length >= MINIMUM_HASLA) Nocturne.kolory.akcentTekst else Nocturne.kolory.tekstDrugi,
        )
    }
}

/** Minimalna długość hasła — ta sama, na którą patrzy przycisk „Załóż konto". */
private const val MINIMUM_HASLA = 12

/** Pierwszy krok logowania: nazwa i hasło. */
@Composable
fun EkranLogowania(model: ChatViewModel, modifier: Modifier = Modifier) {
    var username by remember { mutableStateOf("") }
    var haslo by remember { mutableStateOf("") }

    // Przewijanie i odsunięcie od klawiatury: przy otwartej klawiaturze dwa
    // pola i przycisk „Dalej" nie mieszczą się na niskim ekranie, a przycisk,
    // którego nie da się dosięgnąć, zatrzymuje logowanie na dobre.
    Column(
        modifier = modifier
            .fillMaxSize()
            .verticalScroll(rememberScrollState())
            .imePadding()
            .padding(horizontal = Odstep.xl),
        verticalArrangement = Arrangement.Center,
    ) {
        OdznakaMarki()
        Spacer(Modifier.size(Odstep.m))
        NaglowekEkranu("Logowanie", "Sign in to mekamb")

        Spacer(Modifier.size(Odstep.xl))
        Column(verticalArrangement = Arrangement.spacedBy(Odstep.l)) {
            Pole("Nazwa użytkownika · Username", username, { username = it })
            Pole("Hasło · Password", haslo, { haslo = it }, haslo = true)
        }

        Spacer(Modifier.size(Odstep.xl))
        PrzyciskGlowny(
            if (model.stan.pracuje) "Sprawdzam…" else "Dalej · Continue",
            wlaczony = !model.stan.pracuje && username.isNotBlank() && haslo.isNotBlank(),
        ) {
            model.zalogujHaslem(username.trim(), haslo)
        }

        // Droga powrotna do powitania — bez niej ten ekran był ślepą uliczką.
        //
        // Aplikacja startuje wprost na logowaniu, gdy w skarbcu leży konto
        // (patrz `ChatViewModel`), a logowanie nie miało żadnego wyjścia:
        // konta nie dało się już założyć ani na tym urządzeniu odzyskać
        // inaczej niż przez odinstalowanie aplikacji. Powitanie prowadzi do
        // wszystkich trzech dróg wejścia, więc wystarczy do niego wrócić.
        Spacer(Modifier.size(Odstep.s))
        PrzyciskCichy("Nie mam jeszcze konta · Create account") { model.pokaz(Ekran.POWITANIE) }
    }
}

/** Drugi krok logowania: kod z authenticatora. */
@Composable
fun EkranKoduLogowania(model: ChatViewModel, modifier: Modifier = Modifier) {
    var kod by remember { mutableStateOf("") }

    Column(modifier = modifier.fillMaxSize()) {
        PasekZPowrotem("Kod z authenticatora", "Authenticator code") {
            model.pokaz(Ekran.LOGOWANIE)
        }

        Column(
            modifier = Modifier
                .verticalScroll(rememberScrollState())
                .imePadding()
                .padding(horizontal = Odstep.xl),
            verticalArrangement = Arrangement.spacedBy(Odstep.l),
        ) {
            Pole("Sześć cyfr · Six digits", kod, { kod = it.filter(Char::isDigit).take(6) }, cyfry = true)

            Text(
                "Kod odświeża się co 30 s. Sekret jest tylko w Twojej aplikacji authenticator.",
                style = MaterialTheme.typography.bodySmall,
                color = Nocturne.kolory.tekstDrugi,
            )

            PrzyciskGlowny(
                if (model.stan.pracuje) "Loguję…" else "Zaloguj · Sign in",
                wlaczony = !model.stan.pracuje && kod.length == 6,
            ) {
                model.zalogujKodem(kod)
            }
        }
    }
}

/**
 * Pasek z powrotem i dwujęzycznym tytułem.
 *
 * Wysokość celu dotyku 44 dp z projektu — powyżej minimum Androida.
 */
@Composable
fun PasekZPowrotem(
    tytul: String,
    podtytul: String,
    modifier: Modifier = Modifier,
    onWstecz: () -> Unit,
) {
    Row(
        modifier = modifier.fillMaxWidth().padding(vertical = Odstep.m),
        verticalAlignment = Alignment.CenterVertically,
        horizontalArrangement = Arrangement.spacedBy(Odstep.xs),
    ) {
        IconButton(onClick = onWstecz, modifier = Modifier.size(Dotyk.ikonaWPasku)) {
            Icon(Ikony.Wstecz, contentDescription = "Wróć", tint = Nocturne.kolory.tekst)
        }
        Column {
            Text(tytul, style = MaterialTheme.typography.titleMedium)
            Text(podtytul, style = MaterialTheme.typography.labelSmall, color = Nocturne.kolory.tekstDrugi)
        }
    }
}
