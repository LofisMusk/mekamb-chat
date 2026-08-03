package com.mekamb.chat

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
import androidx.compose.material3.darkColorScheme
import androidx.compose.runtime.Composable
import androidx.compose.runtime.getValue
import androidx.compose.runtime.mutableStateOf
import androidx.compose.runtime.remember
import androidx.compose.runtime.setValue
import androidx.compose.ui.Modifier
import androidx.compose.ui.unit.dp
import androidx.lifecycle.viewmodel.compose.viewModel
import uniffi.mekamb_ffi.DeliveryMode

class MainActivity : ComponentActivity() {
    override fun onCreate(savedInstanceState: Bundle?) {
        super.onCreate(savedInstanceState)
        enableEdgeToEdge()

        setContent {
            MaterialTheme(colorScheme = darkColorScheme()) {
                Scaffold(modifier = Modifier.fillMaxSize()) { wciecia ->
                    Ekran(
                        modifier = Modifier
                            .fillMaxSize()
                            .padding(wciecia)
                            .padding(16.dp),
                    )
                }
            }
        }
    }
}

@Composable
private fun Ekran(modifier: Modifier = Modifier) {
    val model: ChatViewModel = viewModel()
    val stan = model.stan

    Column(modifier = modifier, verticalArrangement = Arrangement.spacedBy(12.dp)) {
        Text("mekamb-chat", style = MaterialTheme.typography.headlineSmall)

        // Tryb połączenia jest widoczny cały czas. Użytkownik ma prawo wiedzieć,
        // czy rozmowa omija infrastrukturę, czy idzie przez serwer.
        Text(
            text = when (stan.trybPolaczenia) {
                DeliveryMode.DIRECT -> "połączenie bezpośrednie"
                DeliveryMode.MAILBOX -> "przez serwer"
                null -> "brak połączenia"
            },
            style = MaterialTheme.typography.labelSmall,
        )

        stan.blad?.let { komunikat ->
            Card(Modifier.fillMaxWidth()) {
                Text(komunikat, Modifier.padding(12.dp), color = MaterialTheme.colorScheme.error)
            }
        }

        when {
            !stan.zalogowany -> FormularzLogowania(model)
            stan.groupId == null -> FormularzRozmowy(model)
            else -> Rozmowa(model)
        }
    }
}

@Composable
private fun FormularzLogowania(model: ChatViewModel) {
    var username by remember { mutableStateOf("") }
    var haslo by remember { mutableStateOf("") }
    var kod by remember { mutableStateOf("") }

    Column(verticalArrangement = Arrangement.spacedBy(8.dp)) {
        Text("Logowanie", style = MaterialTheme.typography.titleMedium)

        OutlinedTextField(
            value = username,
            onValueChange = { username = it },
            label = { Text("Nazwa użytkownika") },
            modifier = Modifier.fillMaxWidth(),
        )
        OutlinedTextField(
            value = haslo,
            onValueChange = { haslo = it },
            label = { Text("Hasło") },
            modifier = Modifier.fillMaxWidth(),
        )
        OutlinedTextField(
            value = kod,
            onValueChange = { kod = it },
            label = { Text("Kod z authenticatora") },
            modifier = Modifier.fillMaxWidth(),
        )

        Text(
            "Hasło nie opuszcza tego urządzenia. Serwer nigdy go nie zobaczy.",
            style = MaterialTheme.typography.bodySmall,
        )

        Button(
            onClick = { model.zaloguj(username, haslo, kod) },
            enabled = !stanZajety(model),
            modifier = Modifier.fillMaxWidth(),
        ) {
            Text(if (stanZajety(model)) "Loguję…" else "Zaloguj")
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
