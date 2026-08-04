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
/** Który ekran pokazujemy, dopóki nie ma zalogowanego klienta. */
enum class Ekran {
    /** Ekran startowy: trzy drogi wejścia. */
    POWITANIE,
    LOGOWANIE,
    /** Drugi krok logowania — kod z authenticatora. */
    KOD_LOGOWANIA,
    REJESTRACJA,
    POTWIERDZENIE,
    ODBIOR,
}

data class StanCzatu(
    val ekran: Ekran = Ekran.POWITANIE,
    val zalogowany: Boolean = false,
    val pracuje: Boolean = false,
    val blad: String? = null,
    val groupId: ByteArray? = null,
    val rozmowca: String? = null,
    val wiadomosci: List<Wiadomosc> = emptyList(),
    /** Jak poszła ostatnia wysyłka — pokazywane użytkownikowi. */
    val trybPolaczenia: DeliveryMode? = null,
    /** Sekret TOTP do wpisania w authenticatorze. Tylko przy rejestracji. */
    val sekretTotp: String? = null,
    /** Odnośnik `otpauth://` otwierający authenticator na tym telefonie. */
    val otpauthUri: String? = null,
    /** Nazwa, na którą właśnie zakładamy konto — potrzebna przy potwierdzeniu. */
    val zakladaneKonto: String? = null,
    /** Komunikat powodzenia, np. po odebraniu konta. */
    val informacja: String? = null,
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

    /** Przełącza ekran, czyszcząc komunikaty z poprzedniego. */
    /** Chowa komunikat błędu. Ma znikać, gdy użytkownik go przeczyta. */
    fun wyczyscBlad() {
        stan = stan.copy(blad = null)
    }

    fun pokaz(ekran: Ekran) {
        stan = stan.copy(ekran = ekran, blad = null, informacja = null)
    }

    /**
     * Zakłada konto.
     *
     * Konto powstaje nieaktywne — do użycia trzeba jeszcze potwierdzić je
     * kodem z authenticatora. Bez tego kroku ktoś, kto zgadnie hasło, miałby
     * konto bez drugiego składnika.
     */
    fun zarejestruj(username: String, haslo: String) {
        viewModelScope.launch {
            stan = stan.copy(pracuje = true, blad = null, informacja = null)

            runCatching { Auth.register(api, username, haslo) }
                .onSuccess { wynik ->
                    stan = stan.copy(
                        ekran = Ekran.POTWIERDZENIE,
                        pracuje = false,
                        sekretTotp = wynik.totpSecret,
                        otpauthUri = wynik.otpauthUri,
                        zakladaneKonto = username,
                    )
                }
                .onFailure { blad ->
                    stan = stan.copy(
                        pracuje = false,
                        blad = blad.message ?: "nie udało się założyć konta",
                    )
                }
        }
    }

    /** Aktywuje świeżo założone konto pierwszym kodem z authenticatora. */
    fun potwierdzRejestracje(kod: String) {
        val username = stan.zakladaneKonto ?: return

        viewModelScope.launch {
            stan = stan.copy(pracuje = true, blad = null)

            runCatching { Auth.confirmRegistration(api, username, kod) }
                .onSuccess {
                    stan = stan.copy(
                        ekran = Ekran.LOGOWANIE,
                        pracuje = false,
                        sekretTotp = null,
                        otpauthUri = null,
                        // Ten kod jest już zużyty — serwer odrzuca powtórzenia,
                        // więc do logowania trzeba poczekać na następny.
                        informacja = "Konto gotowe. Poczekaj na kolejny kod " +
                            "z authenticatora — ten został już zużyty.",
                    )
                }
                .onFailure { blad ->
                    stan = stan.copy(
                        pracuje = false,
                        blad = blad.message ?: "nie udało się potwierdzić konta",
                    )
                }
        }
    }

    /**
     * Odbiera konto przeniesione z innego urządzenia.
     *
     * Po tym kroku trzeba się jeszcze zalogować: przeniesiony jest skarbiec,
     * a nie sesja. Token dostępowy żyje krócej niż tożsamość i celowo nie
     * wchodzi do zrzutu — inaczej przechwycony kod dawałby od razu dostęp
     * do serwera.
     */
    fun odbierzKonto(kod: String) {
        viewModelScope.launch {
            stan = stan.copy(pracuje = true, blad = null, informacja = null)

            runCatching { Przeniesienie.odbierz(vault, BuildConfig.API_URL, kod) }
                .onSuccess { konto ->
                    stan = stan.copy(
                        ekran = Ekran.LOGOWANIE,
                        pracuje = false,
                        informacja = "Konto ${konto.username} odebrane. " +
                            "Zaloguj się i przestań używać starego urządzenia.",
                    )
                }
                .onFailure { blad ->
                    stan = stan.copy(
                        pracuje = false,
                        blad = blad.message ?: "nie udało się odebrać konta",
                    )
                }
        }
    }

    /** Loguje użytkownika i uruchamia klienta. */
    /**
     * Sesja między krokiem hasła a krokiem kodu.
     *
     * W modelu, nie w stanie ekranu: to materiał uwierzytelniający, a stan
     * ekranu bywa logowany i zrzucany przy diagnostyce.
     */
    private var sesjaLogowania: SesjaLogowania? = null

    /** Pierwszy krok logowania. Złe hasło odpada tutaj, przed pytaniem o kod. */
    fun zalogujHaslem(username: String, haslo: String) {
        viewModelScope.launch {
            stan = stan.copy(pracuje = true, blad = null)

            runCatching { Auth.loginPassword(api, username, haslo) }
                .onSuccess { sesja ->
                    sesjaLogowania = sesja
                    stan = stan.copy(pracuje = false, ekran = Ekran.KOD_LOGOWANIA)
                }
                .onFailure { blad ->
                    stan = stan.copy(
                        pracuje = false,
                        blad = blad.message ?: "logowanie nie powiodło się",
                    )
                }
        }
    }

    /** Drugi krok logowania. */
    fun zalogujKodem(kod: String) {
        val sesja = sesjaLogowania ?: return
        viewModelScope.launch {
            stan = stan.copy(pracuje = true, blad = null)

            runCatching {
                // Identyfikator urządzenia odtwarzamy z magazynu, gdy istnieje.
                // Nowy przy każdym logowaniu zostawiałby w katalogu stos
                // martwych urządzeń, do których nikt się nie dodzwoni.
                // Po przeniesieniu w magazynie leży już konto ze źródła —
                // wraz z jego identyfikatorem urządzenia i stanem MLS. Nadanie
                // tu nowego identyfikatora unieważniłoby przeniesiony stan.
                val konto = vault.loadAccount()
                    ?: Account(sesja.username, "android-${UUID.randomUUID().toString().take(8)}")
                vault.saveAccount(konto)

                val token = Auth.loginCode(api, sesja, kod, konto.deviceId)

                val klient = Messenger.open(vault, api, konto, token)

                // Kolejność jest istotna: key packages mają klucz obcy do
                // urządzenia, więc katalog musi je poznać najpierw.
                klient.registerDevice()
                klient.publishKeyPackages()

                klient.startReceiving(viewModelScope, ::obsluzZdarzenie)
                klient
            }.onSuccess { klient ->
                messenger = klient
                sesjaLogowania = null
                stan = stan.copy(zalogowany = true, pracuje = false)
            }.onFailure { blad ->
                // Sesja zostaje: kod mógł być po prostu przepisany z pomyłką
                // albo zdążył wygasnąć, a przepisywanie hasła od nowa byłoby
                // karą za literówkę.
                stan = stan.copy(pracuje = false, blad = blad.message ?: "kod nie został przyjęty")
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
