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
fun EkranUstawien(model: ChatViewModel, modifier: Modifier = Modifier, onWstecz: () -> Unit) {
    val stan = model.stan

    Column(modifier = modifier.fillMaxSize()) {
        PasekZPowrotem("Powiadomienia i połączenie", "Notifications & transport", onWstecz = onWstecz)

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
                    Icon(Ikony.Dzwonek, null, tint = Neutral600, modifier = Modifier.size(16.dp))
                    Text("Powiadomienia push", style = MaterialTheme.typography.labelLarge)
                    Text(
                        "niedostępne",
                        style = MaterialTheme.typography.labelSmall,
                        color = Neutral600,
                    )
                }
                Text(
                    "Wymagają projektu Firebase, którego ta wersja nie ma. Gdy dojdą, ładunek " +
                        "będzie wyłącznie budzący — bez nadawcy i bez treści. Wiadomość " +
                        "odszyfrowuje się dopiero w aplikacji.",
                    style = MaterialTheme.typography.bodySmall,
                    color = Neutral500,
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
                        tint = if (stan.trybPolaczenia == null) Neutral600 else Akcent,
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
                        color = Neutral500,
                    )
                }
                Text(
                    "Nie da się jej wybrać — klient zawsze najpierw próbuje wprost, a na " +
                        "skrzynkę spada dopiero, gdy nie przebije NAT-u.",
                    style = MaterialTheme.typography.bodySmall,
                    color = Neutral500,
                )
                Text(
                    "Bezpośrednio: media idą wprost, więc rozmówca zna Twój adres IP. " +
                        "Przez serwer: adres widzi serwer, treści nie widzi nikt.",
                    style = MaterialTheme.typography.bodySmall,
                    color = Neutral500,
                )
            }

            Ostrzezenie(
                "Wersja bez audytu. Nie używaj tam, gdzie ujawnienie treści miałoby poważne " +
                    "konsekwencje.",
            )

            Text(
                "mekamb-chat · ${BuildConfig.VERSION_NAME} · rdzeń Rust przez UniFFI",
                style = MaterialTheme.typography.labelSmall,
                color = Neutral600,
            )
        }
    }
}
