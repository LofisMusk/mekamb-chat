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
    /** Wszystkie rozmowy z dysku, od najświeższej. */
    val rozmowy: List<PozycjaListy> = emptyList(),
    /** Kod przeniesienia, gdy ekran przenoszenia jest otwarty. */
    val kodPrzeniesienia: Przeniesienie.Kod? = null,
    /** Skład rozmowy z drzewa MLS — nie własna lista w interfejsie. */
    val uczestnicy: List<String> = emptyList(),
    /** Kod bezpieczeństwa bieżącej rozmowy. */
    val kodBezpieczenstwa: String? = null,
    /**
     * Wiadomości w locie — pokazane od razu, jeszcze przed potwierdzeniem.
     *
     * Osobno od historii, a nie polem stanu w niej: wiadomość, której wysyłka
     * nie dobiegła końca przed zamknięciem aplikacji, ma nieznany los. Zapisana
     * wyglądałaby na wysłaną, a tego nie wiemy — więc nie zapisujemy jej wcale.
     */
    val wLocie: List<WLocie> = emptyList(),
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

/** Wiadomość czekająca na potwierdzenie wysyłki. */
data class WLocie(val id: String, val tresc: String, val blad: Boolean = false)

data class Wiadomosc(
    val autor: String,
    val tresc: String,
    val wlasna: Boolean,
    /** Czas lokalny odebrania albo wysłania — do pokazania godziny. */
    val czas: Long = System.currentTimeMillis(),
)

class ChatViewModel(application: Application) : AndroidViewModel(application) {

    private val vault = Vault(application)
    private val historia = Historia(vault)
    private val api = Api(BuildConfig.API_URL)
    private var messenger: Messenger? = null

    var stan by mutableStateOf(
        // Konto na urządzeniu znaczy, że powitanie jest zbędne — pytanie
        // „załóż czy zaloguj" ma sens tylko przy pierwszym uruchomieniu.
        if (vault.loadAccount() != null) StanCzatu(ekran = Ekran.LOGOWANIE) else StanCzatu(),
    )
        private set

    /**
     * Próba cichej trwałej sesji przy starcie — zamiast wymuszać hasło i TOTP
     * przy każdym uruchomieniu aplikacji.
     *
     * Ekran logowania jest już ustawiony w `stan` powyżej i zostaje widoczny,
     * dopóki to się nie powiedzie — nie ma osobnego ekranu ładowania, tak samo
     * jak wcześniej ekran logowania widniał od razu przy starcie. Gdy trwałej
     * sesji nie ma albo wygasła, `refreshSession` zwraca `null` i użytkownik
     * po prostu loguje się jak dotychczas.
     *
     * Ta ścieżka ZASTĘPUJE logowanie, więc robi dokładnie to samo co ono —
     * łącznie z publikacją key packages. Są JEDNORAZOWE: pominięcie tego kroku
     * sprawia, że zapas wyczerpuje się po kilku rozmowach i nikt nie może już
     * nas dodać do grupy. Wcześniej ratowało nas to, że każde uruchomienie
     * aplikacji wymuszało pełne logowanie.
     */
    init {
        val konto = vault.loadAccount()
        val tokenOdswiezajacy = vault.loadRefreshToken()

        if (konto != null && tokenOdswiezajacy != null) {
            viewModelScope.launch {
                val wynik = runCatching { api.refreshSession(konto.deviceId, tokenOdswiezajacy) }
                    .getOrNull() ?: return@launch

                wynik.refreshToken?.let(vault::saveRefreshToken)

                val klient = runCatching {
                    val otwarty = Messenger.open(vault, api, konto, wynik.token)

                    // Kolejność jest istotna: key packages mają klucz obcy do
                    // urządzenia, więc katalog musi je poznać najpierw.
                    otwarty.registerDevice()
                    otwarty.publishKeyPackages()
                    otwarty
                }.getOrNull() ?: return@launch

                klient.startReceiving(viewModelScope, ::obsluzZdarzenie)
                messenger = klient
                stan = stan.copy(zalogowany = true, rozmowy = historia.lista())
            }
        }
    }

    /** Chowa komunikat błędu. Ma znikać, gdy użytkownik go przeczyta. */
    /**
     * Otwiera rozmowę z listy.
     *
     * Wiadomości idą z dysku, bo w pamięci są tylko te z bieżącej sesji.
     */
    fun otworzRozmowe(pozycja: PozycjaListy) {
        stan = stan.copy(
            groupId = pozycja.groupId,
            rozmowca = pozycja.rozmowca,
            wiadomosci = historia.wczytaj(pozycja.groupId),
            blad = null,
        )
    }

    /** Konto z magazynu — do pokazania w panelu. */
    val konto: Account? get() = vault.loadAccount()

    /**
     * Przygotowuje przeniesienie konta.
     *
     * Klucz zostaje w kodzie, serwer dostaje wyłącznie szyfrogram.
     */
    fun przygotujPrzeniesienie() {
        val klient = messenger ?: return
        viewModelScope.launch {
            stan = stan.copy(pracuje = true, blad = null)

            runCatching { Przeniesienie.przygotuj(vault, BuildConfig.API_URL, klient.token) }
                .onSuccess { kod ->
                    stan = stan.copy(pracuje = false, kodPrzeniesienia = kod)
                }
                .onFailure { blad ->
                    stan = stan.copy(
                        pracuje = false,
                        blad = blad.message ?: "nie udało się przygotować przeniesienia",
                    )
                }
        }
    }

    /**
     * Kasuje konto z tego urządzenia.
     *
     * Nieodwracalne: historia jest tylko tutaj, a serwer nie ma czego wydać.
     * Przeładowanie stanu do początkowego zamiast restartu procesu — użytkownik
     * ma zobaczyć powitanie, a nie zniknięcie aplikacji.
     */
    fun usunKonto() {
        val konto = vault.loadAccount()
        val tokenOdswiezajacy = vault.loadRefreshToken()

        messenger = null
        sesjaLogowania = null
        vault.wipe()
        stan = StanCzatu()

        // Najlepszy wysiłek: użytkownik prosił o skasowanie danych NA TYM
        // urządzeniu, więc lokalne czyszczenie powyżej nie może czekać na sieć
        // ani zależeć od jej dostępności.
        if (konto != null) {
            viewModelScope.launch {
                runCatching { api.logout(konto.deviceId, tokenOdswiezajacy) }
            }
        }
    }

    /**
     * Odświeża skład i kod bezpieczeństwa z drzewa MLS.
     *
     * Czytane na żądanie, a nie trzymane na bieżąco: skład zmienia się rzadko,
     * a odczyt wymaga wejścia w stan MLS pod blokadą.
     */
    fun odswiezUczestnikow() {
        val klient = messenger ?: return
        val groupId = stan.groupId ?: return

        stan = stan.copy(
            uczestnicy = klient.uczestnicy(groupId),
            kodBezpieczenstwa = klient.kodBezpieczenstwa(groupId),
        )
    }

    /** Dodaje osobę do bieżącej rozmowy. */
    fun dodajCzlonka(nazwa: String) {
        val klient = messenger ?: return
        val groupId = stan.groupId ?: return

        viewModelScope.launch {
            stan = stan.copy(pracuje = true, blad = null)

            runCatching { klient.dodajCzlonka(groupId, nazwa) }
                .onSuccess {
                    stan = stan.copy(
                        pracuje = false,
                        uczestnicy = klient.uczestnicy(groupId),
                        // Skład się zmienił, więc kod bezpieczeństwa też —
                        // trzeba go porównać na nowo.
                        kodBezpieczenstwa = klient.kodBezpieczenstwa(groupId),
                    )
                }
                .onFailure { blad ->
                    stan = stan.copy(
                        pracuje = false,
                        blad = blad.message ?: "nie udało się dodać osoby",
                    )
                }
        }
    }

    /**
     * Oznacza bieżącą rozmowę jako przeczytaną.
     *
     * Wołane, gdy rozmowa jest OTWARTA na ekranie, nie gdy wiadomość dociera:
     * licznik ma mówić „nie widziałeś tego", a nie „nie dostałeś tego".
     */
    fun oznaczPrzeczytane() {
        val groupId = stan.groupId ?: return
        val najnowsza = stan.wiadomosci.maxOfOrNull { it.czas } ?: return

        runCatching {
            historia.oznaczPrzeczytane(groupId, najnowsza)
            stan = stan.copy(rozmowy = historia.lista())
        }
    }

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
        // Ciche `return` przy braku nazwy dawało ekran, na którym przycisk nic
        // nie robi i nic nie tłumaczy — najgorszy rodzaj usterki, bo nie da się
        // jej ani zgłosić, ani obejść.
        val username = stan.zakladaneKonto
        if (username == null) {
            stan = stan.copy(
                blad = "zgubiliśmy nazwę zakładanego konta — zacznij rejestrację od nowa",
            )
            return
        }

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

                val wynik = Auth.loginCode(api, sesja, kod, konto.deviceId)
                wynik.refreshToken?.let(vault::saveRefreshToken)

                val klient = Messenger.open(vault, api, konto, wynik.token)

                // Kolejność jest istotna: key packages mają klucz obcy do
                // urządzenia, więc katalog musi je poznać najpierw.
                klient.registerDevice()
                klient.publishKeyPackages()

                klient.startReceiving(viewModelScope, ::obsluzZdarzenie)
                klient
            }.onSuccess { klient ->
                messenger = klient
                sesjaLogowania = null
                stan = stan.copy(
                    zalogowany = true,
                    pracuje = false,
                    // Rozmowy z poprzednich uruchomień. Bez tego lista byłaby
                    // pusta mimo zapisanej historii.
                    rozmowy = historia.lista(),
                )
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
                    stan = stan.copy(
                        groupId = groupId,
                        rozmowca = rozmowca,
                        // Rozmowa mogła już istnieć z poprzedniego uruchomienia.
                        wiadomosci = historia.wczytaj(groupId),
                        blad = null,
                    )

                    // Zapis od razu, jeszcze przed pierwszą wiadomością.
                    // Bez tego rozmowa nie pojawiłaby się na liście, dopóki
                    // ktoś czegoś nie napisze — a założona i pusta też jest
                    // rozmową, do której trzeba móc wrócić.
                    zapiszHistorie()
                }
                .onFailure { blad ->
                    stan = stan.copy(blad = blad.message ?: "nie udało się rozpocząć rozmowy")
                }
        }
    }

    /**
     * Wysyła wiadomość.
     *
     * `onWyslane` woła się dopiero po powodzeniu. Pole tekstowe czyszczone od
     * razu po dotknięciu przycisku gubiło treść za każdym razem, gdy wysyłka
     * się nie udała — a wtedy trzeba ją napisać od nowa, mimo że to sieć
     * zawiodła, nie użytkownik.
     */
    fun wyslij(tresc: String, onWyslane: () -> Unit = {}) {
        if (tresc.isBlank()) return

        val klient = messenger
        val groupId = stan.groupId
        val rozmowca = stan.rozmowca
        if (klient == null || groupId == null || rozmowca == null) {
            stan = stan.copy(blad = "rozmowa nie jest gotowa — wróć na listę i wejdź ponownie")
            return
        }

        // Wiadomość pojawia się natychmiast ze znacznikiem „wysyłam".
        // Wcześniej przez cały czas wysyłki — a przy nieudanej próbie
        // bezpośredniej to kilka sekund — nie działo się nic i nie było
        // wiadomo, czy cokolwiek poszło.
        val id = UUID.randomUUID().toString()
        stan = stan.copy(wLocie = stan.wLocie + WLocie(id, tresc))
        onWyslane()

        viewModelScope.launch {
            runCatching { klient.sendText(groupId, tresc, rozmowca) }
                .onSuccess { sposob ->
                    stan = stan.copy(
                        wiadomosci = stan.wiadomosci + Wiadomosc("Ty", tresc, wlasna = true),
                        wLocie = stan.wLocie.filterNot { it.id == id },
                        trybPolaczenia = sposob,
                        blad = null,
                    )
                    zapiszHistorie()
                }
                .onFailure { blad ->
                    // Zostaje w locie, oznaczona jako nieudana. Treść nie
                    // przepada: zawiodła sieć, nie użytkownik.
                    stan = stan.copy(
                        wLocie = stan.wLocie.map { if (it.id == id) it.copy(blad = true) else it },
                        blad = blad.message ?: "nie udało się wysłać wiadomości",
                    )
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

            is IncomingEvent.JoinedConversation -> stan.copy(
                groupId = zdarzenie.groupId,
                // Dołączenie do rozmowy przez welcome: historia mogła już tu
                // być, jeśli to nie pierwsze uruchomienie.
                wiadomosci = historia.wczytaj(zdarzenie.groupId),
            )

            // Zmiany składu grupy i propozycje nie mają odpowiednika w interfejsie,
            // dopóki nie ma widoku listy członków.
            is IncomingEvent.MembershipChanged,
            is IncomingEvent.ProposalQueued,
            -> stan
        }

        zapiszHistorie()
    }

    /**
     * Utrwala rozmowę po każdej zmianie.
     *
     * Zapisujemy całość, bo wszystkie rozmowy leżą w jednym zaszyfrowanym
     * rekordzie — dopisanie jednej wiadomości i tak wymaga odczytania oraz
     * przepisania go w całości.
     *
     * Niepowodzenie zapisu nie może wywrócić odbioru: wiadomość jest już
     * odszyfrowana i pokazana, a utrata jej kopii na dysku jest mniejszą
     * szkodą niż zerwanie pętli odbierającej.
     */
    private fun zapiszHistorie() {
        val groupId = stan.groupId ?: return
        val rozmowca = stan.rozmowca ?: historia.rozmowca(groupId) ?: return
        runCatching {
            historia.zapisz(groupId, rozmowca, stan.wiadomosci)
            // Lista czyta z dysku, więc odświeżamy ją po zapisie, a nie przed.
            stan = stan.copy(rozmowy = historia.lista())
        }
    }

    override fun onCleared() {
        messenger?.close()
        super.onCleared()
    }
}
