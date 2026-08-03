package com.mekamb.chat

import android.app.Application
import androidx.compose.runtime.getValue
import androidx.compose.runtime.mutableStateOf
import androidx.compose.runtime.setValue
import androidx.lifecycle.AndroidViewModel
import androidx.lifecycle.viewModelScope
import kotlinx.coroutines.launch
import uniffi.mekamb_ffi.DeliveryMode
import uniffi.mekamb_ffi.IncomingEvent
import java.util.UUID

/**
 * Stan ekranu czatu.
 *
 * Świadomie płaski i niemutowalny — Compose przerysowuje się na podstawie
 * podmiany całego obiektu, więc nie ma miejsca na częściowo zaktualizowany stan.
 */
data class StanCzatu(
    val zalogowany: Boolean = false,
    val pracuje: Boolean = false,
    val blad: String? = null,
    val groupId: ByteArray? = null,
    val rozmowca: String? = null,
    val wiadomosci: List<Wiadomosc> = emptyList(),
    /** Jak poszła ostatnia wysyłka — pokazywane użytkownikowi. */
    val trybPolaczenia: DeliveryMode? = null,
) {
    // ByteArray nie ma sensownego equals, a data class go potrzebuje.
    override fun equals(other: Any?): Boolean = this === other
    override fun hashCode(): Int = System.identityHashCode(this)
}

data class Wiadomosc(val autor: String, val tresc: String, val wlasna: Boolean)

class ChatViewModel(application: Application) : AndroidViewModel(application) {

    private val vault = Vault(application)
    private val api = Api(BuildConfig.API_URL)
    private var messenger: Messenger? = null

    var stan by mutableStateOf(StanCzatu())
        private set

    /** Loguje użytkownika i uruchamia klienta. */
    fun zaloguj(username: String, haslo: String, kod: String) {
        viewModelScope.launch {
            stan = stan.copy(pracuje = true, blad = null)

            runCatching {
                // Identyfikator urządzenia odtwarzamy z magazynu, gdy istnieje.
                // Nowy przy każdym logowaniu zostawiałby w katalogu stos
                // martwych urządzeń, do których nikt się nie dodzwoni.
                val konto = vault.loadAccount()
                    ?: Account(username, "android-${UUID.randomUUID().toString().take(8)}")
                vault.saveAccount(konto)

                val token = Auth.login(api, username, haslo, kod, konto.deviceId)

                val klient = Messenger.open(vault, api, konto, token)

                // Kolejność jest istotna: key packages mają klucz obcy do
                // urządzenia, więc katalog musi je poznać najpierw.
                klient.registerDevice()
                klient.publishKeyPackages()

                klient.startReceiving(viewModelScope, ::obsluzZdarzenie)
                klient
            }.onSuccess { klient ->
                messenger = klient
                stan = stan.copy(zalogowany = true, pracuje = false)
            }.onFailure { blad ->
                stan = stan.copy(pracuje = false, blad = blad.message ?: "logowanie nie powiodło się")
            }
        }
    }

    fun rozpocznijRozmowe(rozmowca: String) {
        val klient = messenger ?: return

        viewModelScope.launch {
            runCatching { klient.startConversation(rozmowca) }
                .onSuccess { groupId ->
                    stan = stan.copy(groupId = groupId, rozmowca = rozmowca, blad = null)
                }
                .onFailure { blad ->
                    stan = stan.copy(blad = blad.message ?: "nie udało się rozpocząć rozmowy")
                }
        }
    }

    fun wyslij(tresc: String) {
        val klient = messenger ?: return
        val groupId = stan.groupId ?: return
        val rozmowca = stan.rozmowca ?: return
        if (tresc.isBlank()) return

        viewModelScope.launch {
            runCatching { klient.sendText(groupId, tresc, rozmowca) }
                .onSuccess { sposob ->
                    stan = stan.copy(
                        wiadomosci = stan.wiadomosci + Wiadomosc("Ty", tresc, wlasna = true),
                        trybPolaczenia = sposob,
                        blad = null,
                    )
                }
                .onFailure { blad ->
                    stan = stan.copy(blad = blad.message ?: "nie udało się wysłać wiadomości")
                }
        }
    }

    private fun obsluzZdarzenie(zdarzenie: IncomingEvent) {
        stan = when (zdarzenie) {
            is IncomingEvent.Message -> stan.copy(
                wiadomosci = stan.wiadomosci + Wiadomosc(
                    autor = zdarzenie.senderUserId,
                    tresc = zdarzenie.text,
                    wlasna = false,
                ),
                // Wiadomość przyszła prosto do nas, skoro odebrał ją transport P2P.
                trybPolaczenia = DeliveryMode.DIRECT,
            )

            is IncomingEvent.JoinedConversation -> stan.copy(groupId = zdarzenie.groupId)

            // Zmiany składu grupy i propozycje nie mają odpowiednika w interfejsie,
            // dopóki nie ma widoku listy członków.
            is IncomingEvent.MembershipChanged,
            is IncomingEvent.ProposalQueued,
            -> stan
        }
    }

    override fun onCleared() {
        messenger?.close()
        super.onCleared()
    }
}
