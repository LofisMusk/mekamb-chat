package com.mekamb.chat

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
import androidx.compose.ui.Alignment
import androidx.compose.ui.Modifier
import androidx.compose.ui.unit.dp
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
    odczyt: Boolean,
    onOdczyt: (Boolean) -> Unit,
    modifier: Modifier = Modifier,
    onWstecz: () -> Unit,
) {
    val stan = model.stan

    Column(modifier = modifier.fillMaxSize()) {
        PasekZPowrotem("Ustawienia", "Settings", onWstecz = onWstecz)

        Column(
            Modifier
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
                    Text("Wygląd", style = MaterialTheme.typography.labelLarge)
                }

                WyborMotywuUI(wybrany = wyborMotywu, onWybor = onMotyw)

                Text(
                    "„Systemowy\" idzie za ustawieniem telefonu i zmienia się razem z nim. " +
                        "Wybór jasnego albo ciemnego przestaje go słuchać.",
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
                    Text("Potwierdzenia odczytu", style = MaterialTheme.typography.labelLarge)
                }

                Przelacznik(
                    etykieta = "Wysyłaj potwierdzenia odczytu",
                    zaznaczony = odczyt,
                    onZmiana = onOdczyt,
                )

                Text(
                    "Potwierdzenia są szyfrowane end-to-end i wysyłane zbiorczo, po losowym " +
                        "opóźnieniu do 30 sekund — serwer nie zobaczy, co i kiedy przeczytałeś. " +
                        "Chwili wysłania samej koperty ukryć się nie da.",
                    style = MaterialTheme.typography.bodySmall,
                    color = Nocturne.kolory.tekstDrugi,
                )

                Text(
                    "Wyłączenie działa w obie strony: nie wysyłasz i nie widzisz cudzych. " +
                        "„Dostarczono\" zostaje — nie mówi nic o niczyjej uwadze.",
                    style = MaterialTheme.typography.bodySmall,
                    color = Nocturne.kolory.tekstDrugi,
                )
            }

            Karta {
                Row(
                    verticalAlignment = Alignment.CenterVertically,
                    horizontalArrangement = Arrangement.spacedBy(Odstep.m),
                ) {
                    Icon(Ikony.Dzwonek, null, tint = Nocturne.kolory.tekstTrzeci, modifier = Modifier.size(16.dp))
                    Text("Powiadomienia push", style = MaterialTheme.typography.labelLarge)
                    Text(
                        "niedostępne",
                        style = MaterialTheme.typography.labelSmall,
                        color = Nocturne.kolory.tekstTrzeci,
                    )
                }
                Text(
                    "Wymagają projektu Firebase, którego ta wersja nie ma. Gdy dojdą, ładunek " +
                        "będzie wyłącznie budzący — bez nadawcy i bez treści. Wiadomość " +
                        "odszyfrowuje się dopiero w aplikacji.",
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
                    Text("Droga dostarczania", style = MaterialTheme.typography.labelLarge)
                    Text(
                        when (stan.trybPolaczenia) {
                            DeliveryMode.DIRECT -> "bezpośrednio"
                            DeliveryMode.MAILBOX -> "przez serwer"
                            null -> "brak połączenia"
                        },
                        style = MaterialTheme.typography.labelSmall,
                        color = Nocturne.kolory.tekstDrugi,
                    )
                }
                Text(
                    "Nie da się jej wybrać — klient zawsze najpierw próbuje wprost, a na " +
                        "skrzynkę spada dopiero, gdy nie przebije NAT-u.",
                    style = MaterialTheme.typography.bodySmall,
                    color = Nocturne.kolory.tekstDrugi,
                )
                Text(
                    "Bezpośrednio: media idą wprost, więc rozmówca zna Twój adres IP. " +
                        "Przez serwer: adres widzi serwer, treści nie widzi nikt.",
                    style = MaterialTheme.typography.bodySmall,
                    color = Nocturne.kolory.tekstDrugi,
                )
            }

            Ostrzezenie(
                "Wersja bez audytu. Nie używaj tam, gdzie ujawnienie treści miałoby poważne " +
                    "konsekwencje.",
            )

            Text(
                "mekamb-chat · ${BuildConfig.VERSION_NAME} · rdzeń Rust przez UniFFI",
                style = MaterialTheme.typography.labelSmall,
                color = Nocturne.kolory.tekstTrzeci,
            )
        }
    }
}
