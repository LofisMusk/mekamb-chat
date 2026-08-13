package com.mekamb.chat

import android.os.Build
import androidx.compose.foundation.layout.Arrangement
import androidx.compose.foundation.layout.Column
import androidx.compose.foundation.layout.Row
import androidx.compose.foundation.layout.fillMaxSize
import androidx.compose.foundation.layout.fillMaxWidth
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
 * Zgłoszenie błędu — trafia jako issue do repozytorium projektu.
 *
 * # Dlaczego pierwsze, co widać, to ostrzeżenie
 *
 * Bo issue na GitHubie jest **publiczne**. To jedyne miejsce w tej aplikacji,
 * w którym cokolwiek od użytkownika wychodzi na otwartą stronę internetową —
 * i dzieje się to za jego własnym kliknięciem, w chwili, gdy jest zirytowany
 * usterką i najmniej skłonny czytać cokolwiek.
 *
 * Napisanie tego dopiero w potwierdzeniu byłoby napisaniem po fakcie:
 * ostrzeżenie ma wartość wyłącznie wtedy, gdy stoi PRZED polem, w które się
 * pisze. Serwer i tak nie przepuści niczego poza dwoma polami z tego ekranu
 * (`server/src/zgloszenia.ts`), ale przed wklejeniem czegoś we własną treść
 * nie zabezpieczy nikogo — to decyzja piszącego, a decyzję trzeba oprzeć na
 * wiedzy.
 *
 * # Dlaczego pole „urządzenie" jest wypełnione, a mimo to widoczne
 *
 * Bo modelu telefonu i wersji Androida nikt nie chce przepisywać z ustawień,
 * a bez nich połowa zgłoszeń jest nie do odtworzenia. Skoro jednak i to pójdzie
 * na publiczną stronę, użytkownik ma prawo zobaczyć co dokładnie — i wyczyścić
 * je, jeśli mu się nie podoba. Pole edytowalne jest tu jedyną uczciwą formą
 * zgody.
 */
@Composable
fun EkranZgloszenia(
    model: ChatViewModel,
    modifier: Modifier = Modifier,
    onWstecz: () -> Unit,
) {
    var opis by remember { mutableStateOf("") }

    /*
     * Model, wersja Androida i wersja aplikacji — nic, co wskazuje na osobę.
     *
     * Nie ma tu identyfikatora urządzenia ani nazwy użytkownika, mimo że oba
     * leżą pod ręką: pomogłyby nam, a kosztowałyby użytkownika anonimowość
     * na publicznej stronie. Do odtworzenia usterki wystarczy sprzęt.
     */
    var kontekst by remember {
        mutableStateOf(
            "${Build.MANUFACTURER} ${Build.MODEL}, Android ${Build.VERSION.RELEASE}, " +
                "mekamb ${BuildConfig.VERSION_NAME}",
        )
    }

    var wysylam by remember { mutableStateOf(false) }
    var wynik by remember { mutableStateOf<String?>(null) }

    Column(modifier = modifier.fillMaxSize()) {
        NaglowekEkranu("Zgłoś błąd", "Report a bug")

        Column(
            modifier = Modifier.fillMaxSize().verticalScroll(rememberScrollState()),
            verticalArrangement = Arrangement.spacedBy(Odstep.l),
        ) {
            Karta {
                Row(
                    verticalAlignment = Alignment.CenterVertically,
                    horizontalArrangement = Arrangement.spacedBy(Odstep.m),
                ) {
                    Icon(
                        Ikony.Ostrzezenie,
                        contentDescription = null,
                        tint = Nocturne.kolory.akcent,
                        modifier = Modifier.size(16.dp),
                    )
                    Text("Zgłoszenie jest publiczne", style = MaterialTheme.typography.labelLarge)
                }

                Text(
                    "Trafia na stronę projektu, gdzie każdy może je przeczytać. Nie wysyłamy " +
                        "Twojej nazwy ani niczego z rozmów — ale nie wpisuj tu rzeczy, " +
                        "których nie chcesz pokazać.",
                    style = MaterialTheme.typography.bodySmall,
                    color = Nocturne.kolory.tekstDrugi,
                )
            }

            Karta {
                Pole(
                    etykieta = "Co się stało?",
                    wartosc = opis,
                    onZmiana = { opis = it },
                    podpowiedz = "Np. aplikacja gaśnie, kiedy odbieram połączenie.",
                )

                Pole(
                    etykieta = "Telefon i wersja",
                    wartosc = kontekst,
                    onZmiana = { kontekst = it },
                )

                wynik?.let { komunikat ->
                    Text(
                        komunikat,
                        style = MaterialTheme.typography.bodySmall,
                        color = Nocturne.kolory.tekstDrugi,
                        modifier = Modifier.padding(top = Odstep.s),
                    )
                }

                PrzyciskGlowny(
                    tekst = if (wysylam) "Wysyłam…" else "Wyślij",
                    wlaczony = opis.isNotBlank() && !wysylam,
                    onClick = {
                        wysylam = true
                        wynik = null

                        model.zglosBlad(opis.trim(), kontekst.trim()) { komunikat ->
                            wysylam = false
                            wynik = komunikat

                            // Treść czyścimy dopiero po UDANEJ wysyłce. Przy
                            // nieudanej zawiodła sieć, nie użytkownik, a kazanie
                            // mu pisać wszystko od nowa byłoby karą za cudzą
                            // usterkę.
                            if (komunikat.startsWith("Wysłane")) opis = ""
                        }
                    },
                )
            }

            PrzyciskDrugi(tekst = "Wróć", onClick = onWstecz)
        }
    }
}
