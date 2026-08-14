package com.mekamb.chat

import android.app.Application
import android.content.Context
import android.net.Uri
import android.provider.OpenableColumns
import androidx.compose.runtime.getValue
import androidx.compose.runtime.mutableStateOf
import androidx.compose.runtime.setValue
import androidx.lifecycle.AndroidViewModel
import androidx.lifecycle.viewModelScope
import kotlinx.coroutines.launch
import uniffi.mekamb_ffi.CallSignalKind
import uniffi.mekamb_ffi.DeliveryMode
import uniffi.mekamb_ffi.IncomingEvent
import uniffi.mekamb_ffi.ReceiptKind
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
    /** Uczestnicy trwającej rozmowy A/V. Pusta lista znaczy: nie dzwonimy. */
    val rozmowaAV: List<UczestnikRozmowy> = emptyList(),
    /** Czy w trwającej rozmowie nadajemy obraz. */
    val rozmowaZWideo: Boolean = false,
    /*
     * Stan mikrofonu, kamery i własnego obrazu SĄ w stanie ekranu, a nie
     * czytane z `RozmowaAV` przez `get()`.
     *
     * Compose obserwuje `stan`, a nie pole w obiekcie rozmowy — więc dopóki
     * to było zwykłym getterem, wyciszenie mikrofonu zmieniało wszystko poza
     * wyglądem przycisku, który je zgłosił. Przycisk przerysowywał się dopiero
     * przy najbliższej zmianie czegoś innego, czyli pozornie losowo.
     */
    val mikrofonWlaczony: Boolean = true,
    val kameraWlaczona: Boolean = false,
    /** Własny obraz z kamery — do podglądu we własnym kafelku. */
    val wideoLokalne: org.webrtc.VideoTrack? = null,
    /** Kto dzwoni i do której rozmowy — zanim odbierzemy. */
    val przychodzacaRozmowa: PrzychodzacaRozmowa? = null,
) {
    // ByteArray nie ma sensownego equals, a data class go potrzebuje.
    override fun equals(other: Any?): Boolean = this === other
    override fun hashCode(): Int = System.identityHashCode(this)
}

/** Rozmowa A/V, na którą jeszcze nie odpowiedzieliśmy. */
data class PrzychodzacaRozmowa(
    val od: String,
    val groupId: ByteArray,
    val callId: ByteArray,
    /** Pierwszy sygnał — oferta, którą trzeba przetworzyć zaraz po odebraniu. */
    val oferta: String,
    val odcisk: String,
) {
    override fun equals(other: Any?): Boolean = this === other
    override fun hashCode(): Int = System.identityHashCode(this)
}

/** Wiadomość czekająca na potwierdzenie wysyłki. */
data class WLocie(val id: String, val tresc: String, val blad: Boolean = false)

/** Nazwa dla pliku, którego nadawca nie nazwał — sam typ wystarczy za opis. */
internal fun opisTypu(mimeType: String): String = when {
    mimeType.startsWith("image/") -> "zdjęcie"
    mimeType.startsWith("video/") -> "nagranie"
    mimeType.startsWith("audio/") -> "dźwięk"
    else -> "plik"
}

/**
 * Ślad po rozmowie audio/wideo w wątku.
 *
 * # Dlaczego zapis LOKALNY, a nie wiadomość MLS
 *
 * „Nieodebrana" jest faktem o TYM urządzeniu, nie o rozmowie. Dzwoniący widzi
 * „nikt nie odebrał", odbierający „nie odebrałeś", a trzecie urządzenie tej
 * samej osoby nie widzi nic, bo nic się przy nim nie wydarzyło. Uzgadnianie
 * tego kanałem MLS znaczyłoby uzgadnianie czegoś, co z każdej strony wygląda
 * inaczej i z żadnej nie jest nieprawdą.
 *
 * Kształt musi zgadzać się z `ZapisRozmowy` w `web/src/lib/historia.ts` —
 * zrzut przeniesienia konta przechodzi między klientami.
 */
data class ZapisRozmowy(
    /** Czy szła z obrazem. Decyduje o ikonie — tej samej co przy dzwonieniu. */
    val wideo: Boolean,
    /**
     * Ile trwała, w sekundach. `null` znaczy, że nie doszła do skutku.
     *
     * Zero i `null` to nie to samo: zero byłoby rozmową odebraną i natychmiast
     * przerwaną, a `null` — taką, której nikt nie odebrał.
     */
    val sekundy: Long? = null,
    /** Czy to my dzwoniliśmy. Rozstrzyga między „nikt nie odebrał" a „nieodebrana". */
    val wychodzaca: Boolean,
)

data class Wiadomosc(
    val autor: String,
    val tresc: String,
    val wlasna: Boolean,
    /** Czas lokalny odebrania albo wysłania — do pokazania godziny. */
    val czas: Long = System.currentTimeMillis(),
    /**
     * Załącznik, jeśli wiadomość go niesie.
     *
     * Trzymamy wyłącznie klucz i adres szyfrogramu — sam plik pobieramy
     * dopiero przy pokazaniu. Zapisanie go w historii podwoiłoby rekord,
     * który przy każdym zapisie szyfrujemy w całości.
     */
    val zalacznik: Zalacznik? = null,

    /** Obecne, gdy wpis jest śladem po rozmowie, a nie wiadomością. */
    val rozmowa: ZapisRozmowy? = null,

    /**
     * Identyfikator z protokołu — 16 bajtów.
     *
     * Potwierdzenia wskazują wiadomości właśnie po nim. Pusty przy wiadomościach
     * z zapisów sprzed wersji 5 formatu historii; takiej wiadomości żadne
     * potwierdzenie już nie dosięgnie i to jest w porządku.
     */
    val id: ByteArray = ByteArray(0),

    /**
     * Dokąd doszła własna wiadomość.
     *
     * `null` znaczy „wysłana" — tak wygląda wiadomość, na którą potwierdzenie
     * jeszcze nie wróciło, i tak wyglądają wszystkie zapisy sprzed wersji 5.
     * Przy cudzych wiadomościach pole nie ma sensu i zostaje puste.
     */
    val stan: StanWiadomosci? = null,
) {
    // `ByteArray` porównuje się przez referencję, a `data class` bierze je do
    // wygenerowanej równości — bez tego dwie kopie tej samej wiadomości nigdy
    // nie byłyby równe, a Compose przerysowywałby listę przy każdym złożeniu.
    override fun equals(other: Any?): Boolean {
        if (this === other) return true
        if (other !is Wiadomosc) return false
        return autor == other.autor &&
            tresc == other.tresc &&
            wlasna == other.wlasna &&
            czas == other.czas &&
            zalacznik == other.zalacznik &&
            id.contentEquals(other.id) &&
            stan == other.stan
    }

    override fun hashCode(): Int {
        var wynik = autor.hashCode()
        wynik = 31 * wynik + tresc.hashCode()
        wynik = 31 * wynik + czas.hashCode()
        wynik = 31 * wynik + id.contentHashCode()
        wynik = 31 * wynik + (stan?.hashCode() ?: 0)
        return wynik
    }
}

class ChatViewModel(application: Application) : AndroidViewModel(application) {

    private val vault = Vault(application)
    private val historia = Historia(vault)
    private val api = Api(BuildConfig.API_URL)

    /**
     * Klient — z [Rdzen], nie własny.
     *
     * Model widoku go UŻYWA, ale nie jest jego właścicielem: `Messenger` trzyma
     * stan MLS, a ten musi przeżyć zamknięcie ekranu. Własne pole znaczyło, że
     * przy każdym obrocie telefonu powstawał drugi klient na tym samym skarbcu —
     * czyli dwa ratchety przesuwane niezależnie, z których każdy cofa pracę
     * drugiego. Tu jest już tylko skrót do jednego wspólnego.
     */
    private val messenger: Messenger?
        get() = Rdzen.messenger

    /**
     * Zbieracz potwierdzeń i jego zegar.
     *
     * Potwierdzenia nie lecą od razu: serwer nie zobaczy, CO jest w kopercie,
     * ale zobaczy, KIEDY poszła. Powód opóźnienia i losowości siedzi
     * w `Potwierdzenia.kt`.
     */
    private val zbieracz = ZbieraczPotwierdzen()
    private var zegarPotwierdzen: kotlinx.coroutines.Job? = null

    /** Dokłada potwierdzenie i pilnuje, żeby wysyłka była zaplanowana. */
    private fun zakolejkujPotwierdzenie(
        groupId: ByteArray,
        rodzaj: ReceiptKind,
        messageId: ByteArray,
    ) {
        zbieracz.dodaj(groupId, rodzaj, messageId)

        // Jeden zegar na wszystko, co się nazbiera. Nowy przy każdym
        // potwierdzeniu przesuwałby wysyłkę w nieskończoność przy żywej
        // rozmowie — i wysyłałby ją dokładnie wtedy, gdy rozmowa ucichła,
        // czyli w najbardziej wymownym momencie.
        if (zegarPotwierdzen?.isActive == true) return

        /*
         * Odliczanie w zakresie PROCESU, nie ekranu.
         *
         * Tu ginęły potwierdzenia. Zegar czeka losowo od 3 do 30 sekund — a to
         * jest mnóstwo czasu na to, żeby ktoś odłożył telefon albo obrócił
         * ekran. `viewModelScope` gasł wtedy razem z modelem i anulował
         * korutynę PRZED wysłaniem, więc potwierdzenie nie wychodziło nigdy.
         * Druga strona zostawała z jednym ptaszkiem („wysłano") na zawsze,
         * mimo że wiadomość dawno doszła i została przeczytana — dokładnie to,
         * co było widać w aplikacji.
         *
         * Powtórka nie przyjdzie: potwierdzenie wysyła się raz. Anulowane
         * znaczy więc utracone, a nie opóźnione.
         */
        zegarPotwierdzen = Rdzen.zakres.launch {
            kotlinx.coroutines.delay(losoweOpoznienie())

            val klient = messenger ?: return@launch
            for (paczka in zbieracz.zabierz()) {
                val odbiorca = klient.uczestnicy(paczka.groupId)
                    .firstOrNull { it != klient.account.userId }
                    ?: continue

                // Nieudane potwierdzenie przepada i to jest w porządku: ptaszek
                // jest wygodą, a nie treścią. Ponawianie w kółko dokładałoby
                // kopert do ruchu, czyli tego, co ten mechanizm ma ograniczać.
                runCatching {
                    klient.sendReceipt(paczka.groupId, paczka.rodzaj, paczka.identyfikatory, odbiorca)
                }
            }
        }
    }

    /**
     * Potwierdza odczyt wszystkiego, co widać w otwartej rozmowie.
     *
     * Warunkiem jest OTWARTA rozmowa, nie samo dotarcie wiadomości:
     * „przeczytane" ma znaczyć „widziałeś", a nie „dostałeś" — inaczej byłoby
     * drugim potwierdzeniem dostarczenia.
     */
    private fun potwierdzOdczyt() {
        if (!PotwierdzeniaOdczytu.wlaczone(getApplication())) return
        val groupId = stan.groupId ?: return

        for (wiadomosc in stan.wiadomosci) {
            if (wiadomosc.wlasna || wiadomosc.id.isEmpty()) continue
            zakolejkujPotwierdzenie(groupId, ReceiptKind.READ, wiadomosc.id)
        }
    }

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
    /**
     * Odpięcie słuchacza zdarzeń z [Rdzen].
     *
     * Musi zostać wywołane w `onCleared`: słuchacz trzyma referencję do tego
     * modelu, a [Rdzen] żyje tak długo jak proces. Nieodpięty zostawiałby po
     * każdym obrocie ekranu kolejny martwy model rysujący donikąd — i każdy
     * z nich dalej dostawałby wszystkie koperty.
     */
    private var odepnijSluchacza: (() -> Unit)? = null

    init {
        /*
         * Zdarzenia idą przez [Rdzen], bo mają dwóch odbiorców o różnym czasie
         * życia: ten model (rysuje) i usługę (powiadamia). Marszałek na wątek
         * główny jest konieczny — koperty przetwarzane są na `Dispatchers.IO`,
         * a `stan` to stan Compose'a.
         */
        odepnijSluchacza = Rdzen.sluchaj { zdarzenie, tryb ->
            viewModelScope.launch { obsluzZdarzenie(zdarzenie, tryb) }
        }

        /*
         * Klient mógł przeżyć ten ekran.
         *
         * Odkąd trzyma go [Rdzen], obrót telefonu albo powrót do aplikacji
         * zostawionej w tle zastaje gotowe, działające połączenie. Logowanie od
         * nowa byłoby wtedy nie tylko zbędne — otworzyłoby drugi stan MLS na
         * tym samym skarbcu.
         */
        val konto = vault.loadAccount()
        val tokenOdswiezajacy = vault.loadRefreshToken()

        if (Rdzen.messenger != null) {
            stan = stan.copy(zalogowany = true, rozmowy = historia.lista())
        } else if (konto != null && tokenOdswiezajacy != null) {
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

                // Rozmowy z dysku MUSZĄ zostać otwarte, zanim cokolwiek
                // przyjdzie: rdzeń po odtworzeniu ma pełny stan, ale pustą listę
                // otwartych rozmów, a koperta bez dopasowania przepada.
                val zapisane = historia.lista()
                klient.otworzZnaneRozmowy(zapisane.map { it.groupId })
                klient.ustawPortfel(PortfelTokenow(MagazynWPreferencjach(getApplication())))
                runCatching { klient.uzupelnijTokeny() }

                Rdzen.podepnij(getApplication(), klient)
                stan = stan.copy(zalogowany = true, rozmowy = zapisane)
            }
        }
    }

    /**
     * Wysyła zgłoszenie błędu.
     *
     * Wynik wraca komunikatem, a nie milczeniem: zgłoszenie idzie na publiczną
     * stronę projektu, więc użytkownik ma prawo wiedzieć, czy naprawdę tam
     * trafiło — i pod jakim numerem, gdyby chciał zajrzeć.
     *
     * Poza opisem i kontekstem nie wychodzi stąd nic; co i dlaczego, mówi
     * `server/src/zgloszenia.ts`.
     */
    fun zglosBlad(opis: String, kontekst: String, onWynik: (String) -> Unit) {
        val klient = messenger ?: return

        viewModelScope.launch {
            runCatching { api.zglosBlad(klient.token, opis, kontekst) }
                .onSuccess { numer ->
                    onWynik(
                        if (numer != null) "Wysłane — zgłoszenie nr $numer. Dziękujemy."
                        else "Wysłane. Dziękujemy.",
                    )
                }
                .onFailure { blad ->
                    onWynik(blad.message ?: "Nie udało się wysłać zgłoszenia.")
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
            // Skład grupy ma pierwszeństwo przed zapisaną nazwą: rozmowy
            // zapisane wcześniej mogą jej w ogóle nie mieć.
            rozmowca = nazwaZeSkladu(pozycja.groupId) ?: pozycja.rozmowca,
            wiadomosci = historia.wczytaj(pozycja.groupId),
            blad = null,
        )

        // Otwarcie rozmowy JEST przeczytaniem jej — potwierdzenia lecą stąd,
        // a nie z odbioru koperty.
        potwierdzOdczyt()
    }

    /**
     * Nazwa rozmowy z drzewa MLS — kto w niej jest poza nami.
     *
     * `null`, gdy stanu tej grupy nie ma (np. po przeniesieniu konta) albo
     * zostaliśmy w niej sami. Wywołujący zostaje wtedy przy nazwie zapisanej
     * na dysku: stara jest lepsza niż żadna.
     */
    private fun nazwaZeSkladu(groupId: ByteArray): String? {
        val klient = messenger ?: return null
        val ja = vault.loadAccount()?.userId.orEmpty()

        val nazwa = runCatching { Rozmowy.nazwa(klient.uczestnicy(groupId), ja) }.getOrNull()
        return nazwa?.takeIf { it.isNotEmpty() }
    }

    /** Ostrzega, że konto zostało założone, ale nie potwierdzone kodem. */
    fun ostrzezONiepotwierdzonymKoncie() {
        stan = stan.copy(
            blad = "Konto zostało założone, ale niepotwierdzone — bez kodu z authenticatora " +
                "nie da się na nie zalogować, a jego nazwa pozostaje zajęta.",
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

        // Zamknięcie PRZED wyzerowaniem referencji. Samo `= null` zostawiało
        // działający transport, a od czasu wpięcia skrzynki także otwarte
        // gniazdo, które wznawiałoby się w nieskończoność i próbowało zapisywać
        // stan MLS do skarbca skasowanego przed chwilą poniżej.
        Rdzen.odepnij(getApplication())
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
     * Wychodzi z sesji na ekran odbioru przeniesienia.
     *
     * # Dlaczego to zamyka sesję, zamiast po prostu pokazać ekran
     *
     * Odebranie zrzutu PODMIENIA skarbiec — ziarno tożsamości, stan MLS
     * i historię. Zrobienie tego pod działającym klientem znaczyłoby, że
     * `Messenger` dopisuje stan MLS starego konta do skarbca nowego, a otwarte
     * gniazdo skrzynki nadal nasłuchuje na starej nazwie. Dlatego sesja gaśnie
     * najpierw, a dopiero potem pokazujemy ekran.
     *
     * Konto na dysku ZOSTAJE: rezygnacja z przeniesienia kończy się zwykłym
     * logowaniem, a nie utratą urządzenia. Kasuje je dopiero samo odebranie.
     */
    fun przejdzDoOdbioru() {
        Rdzen.odepnij(getApplication())
        sesjaLogowania = null
        stan = StanCzatu(ekran = Ekran.ODBIOR)
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

                // Rozmowy z dysku MUSZĄ zostać otwarte, zanim cokolwiek
                // przyjdzie: rdzeń po odtworzeniu ma pełny stan, ale pustą listę
                // otwartych rozmów, a koperta bez dopasowania przepada.
                klient.otworzZnaneRozmowy(historia.lista().map { it.groupId })
                klient.ustawPortfel(PortfelTokenow(MagazynWPreferencjach(getApplication())))
                runCatching { klient.uzupelnijTokeny() }

                Rdzen.podepnij(getApplication(), klient)
                klient
            }.onSuccess { _ ->
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

        // Rozmowa z tą osobą mogła już powstać. Bez tego sprawdzenia każde
        // „rozpocznij rozmowę" zakładało nową grupę MLS, więc lista puchła od
        // duplikatów, a historia rozjeżdżała się między nimi — patrz
        // `Rozmowy.kt`, gdzie ta sama reguła jest opisana i przetestowana.
        val istniejaca = Rozmowy.znajdz1na1(
            rozmowy = historia.lista(),
            groupId = { it.groupId },
            czlonkowie = klient::uczestnicy,
            ja = vault.loadAccount()?.userId.orEmpty(),
            rozmowca = rozmowca,
        )

        if (istniejaca != null) {
            otworzRozmowe(istniejaca)
            return
        }

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
                .onSuccess { wyslana ->
                    // Identyfikator Z RDZENIA, nie własny UUID: potwierdzenia
                    // drugiej strony wskazują wiadomości właśnie po nim, więc
                    // zapisanie własnego znaczyłoby ptaszek, który nigdy się
                    // nie zmieni.
                    stan = stan.copy(
                        wiadomosci = stan.wiadomosci + Wiadomosc(
                            autor = "Ty",
                            tresc = tresc,
                            wlasna = true,
                            id = wyslana.messageId,
                        ),
                        wLocie = stan.wLocie.filterNot { it.id == id },
                        trybPolaczenia = wyslana.sposob,
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

    /**
     * Obsługuje odebrane zdarzenie.
     *
     * `tryb` mówi, KTÓRĄ drogą koperta przyszła — wprost od urządzenia czy ze
     * skrzynki. Wcześniej było tu wpisane `DIRECT` na sztywno, bo istniała
     * tylko jedna droga; dziś taki wpis kłamałby przy każdej wiadomości od
     * rozmówcy z przeglądarki, a interfejs pokazuje na tej podstawie, czy
     * rozmowa jest bezpośrednia.
     */
    /**
     * Czy to przyszło z DRUGIEGO NASZEGO urządzenia.
     *
     * Odkąd wysyłamy także do własnej skrzynki, telefon dostaje to, co
     * napisaliśmy na laptopie. Bez tego sprawdzenia wiadomość stanęłaby po
     * lewej stronie, podpisana naszym własnym identyfikatorem, jak wypowiedź
     * obcej osoby.
     *
     * Rozstrzyga `senderUserId` z credentiala MLS — jedyne wiarygodne źródło,
     * bo pola spoza kanału MLS można podmienić po drodze.
     */
    private fun czyOdNas(senderUserId: String): Boolean =
        messenger?.account?.userId == senderUserId

    /**
     * Kiedy wiadomość została NADANA, a nie kiedy do nas dotarła.
     *
     * # Dlaczego to się zmieniło
     *
     * `Wiadomosc.czas` domyślał się chwili odbioru, a klient webowy zapisywał
     * `sentAtMs` — czyli to samo pole znaczyło na dwóch platformach dwie różne
     * rzeczy. Dopóki historia nie opuszczała urządzenia, nikt tego nie widział.
     * Po scaleniu dwóch urządzeń wątek ułożyłby się na każdym inaczej, a przy
     * odbiorze ze skrzynki po trzech dniach offline wiadomość sprzed trzech dni
     * wskoczyłaby na koniec listy z dzisiejszą godziną.
     *
     * # Czemu ufamy nadawcy
     *
     * Bo to jest jego twierdzenie i tak jest opisane w `proto/chat.proto` —
     * ale to samo twierdzenie widzi rozmówca i drugie nasze urządzenie, więc
     * wszyscy układają wątek tak samo. Bezsensowny znacznik psuje kolejność
     * u wszystkich naraz, a nie tworzy rozjazdu między nimi.
     *
     * Zero znaczy „nadawca nic nie podał" — wtedy zostaje chwila odbioru, bo
     * wiadomość z 1970 roku byłaby gorszym kłamstwem niż zaokrąglenie.
     */
    private fun czasNadania(sentAtMs: ULong): Long {
        val podany = sentAtMs.toLong()
        return if (podany > 0) podany else System.currentTimeMillis()
    }

    private fun obsluzZdarzenie(zdarzenie: IncomingEvent, tryb: DeliveryMode) {
        stan = when (zdarzenie) {
            /*
             * Wiadomość trafia do SWOJEJ rozmowy, nie do tej otwartej na ekranie.
             *
             * Wcześniej zdarzenie nie niosło identyfikatora grupy, więc klient
             * dopisywał każdą przychodzącą wiadomość do rozmowy akurat
             * widocznej — i tam ją zapisywał. Wiadomość od jednej osoby lądowała
             * w historii drugiej, bez śladu, że coś poszło nie tak.
             */
            is IncomingEvent.Message -> {
                val wlasna = czyOdNas(zdarzenie.senderUserId)
                val wiadomosc = Wiadomosc(
                    autor = if (wlasna) "Ty" else zdarzenie.senderUserId,
                    tresc = zdarzenie.text,
                    wlasna = wlasna,
                    czas = czasNadania(zdarzenie.sentAtMs),
                    id = zdarzenie.messageId,
                )

                // Dostarczenie potwierdzamy przy ODBIORZE, nie przy pokazaniu.
                // „Dostarczono" jest twierdzeniem o kopercie, nie o uwadze
                // odbiorcy — i tak nie dokłada osobnego zdarzenia w czasie,
                // bo koperta właśnie przyszła.
                //
                // Za własną wiadomość z drugiego urządzenia nie potwierdzamy:
                // rozmówca dostałby „dostarczono" na wiadomość, której nie
                // wysłał — bezużyteczny ruch zdradzający, ile mamy urządzeń.
                if (!wlasna) {
                    zakolejkujPotwierdzenie(
                        zdarzenie.groupId,
                        ReceiptKind.DELIVERED,
                        zdarzenie.messageId,
                    )
                }

                if (stan.groupId?.contentEquals(zdarzenie.groupId) == true) {
                    stan.copy(
                        wiadomosci = stan.wiadomosci + wiadomosc,
                        trybPolaczenia = tryb,
                    )
                } else {
                    // Rozmowa spoza ekranu: dopisujemy prosto na dysk i
                    // odświeżamy listę, żeby licznik nieprzeczytanych urósł.
                    dopiszDoRozmowy(zdarzenie.groupId, wiadomosc)
                    stan.copy(rozmowy = historia.lista(), trybPolaczenia = tryb)
                }
            }

            is IncomingEvent.Attachment -> {
                val wlasna = czyOdNas(zdarzenie.senderUserId)
                val wiadomosc = Wiadomosc(
                    autor = if (wlasna) "Ty" else zdarzenie.senderUserId,
                    tresc = zdarzenie.fileName ?: opisTypu(zdarzenie.mimeType),
                    wlasna = wlasna,
                    czas = czasNadania(zdarzenie.sentAtMs),
                    zalacznik = Zalacznik(
                        blobId = zdarzenie.blobId,
                        klucz = zdarzenie.decryptionKey,
                        nonce = zdarzenie.nonce,
                        mimeType = zdarzenie.mimeType,
                        rozmiar = zdarzenie.sizeBytes.toLong(),
                        nazwaPliku = zdarzenie.fileName,
                    ),
                    id = zdarzenie.messageId,
                )

                if (!wlasna) {
                    zakolejkujPotwierdzenie(
                        zdarzenie.groupId,
                        ReceiptKind.DELIVERED,
                        zdarzenie.messageId,
                    )
                }

                if (stan.groupId?.contentEquals(zdarzenie.groupId) == true) {
                    stan.copy(wiadomosci = stan.wiadomosci + wiadomosc, trybPolaczenia = tryb)
                } else {
                    dopiszDoRozmowy(zdarzenie.groupId, wiadomosc)
                    stan.copy(rozmowy = historia.lista(), trybPolaczenia = tryb)
                }
            }

            /*
             * Potwierdzenie nie jest wiadomością do pokazania — zmienia stan
             * dymków, które już są na ekranie albo leżą na dysku.
             *
             * Cudze potwierdzenia odczytu ignorujemy, gdy własnych nie wysyłamy:
             * jednostronna wymiana byłaby korzystaniem z czegoś, czego się nie
             * oddaje. Dostarczenie zostaje — nie mówi nic o niczyjej uwadze.
             */
            is IncomingEvent.Receipt -> {
                val czytamy = PotwierdzeniaOdczytu.wlaczone(getApplication())

                if (czyOdNas(zdarzenie.senderUserId)) {
                    // Potwierdzenie od nas samych nie mówi nic o rozmówcy, za to
                    // mówi wszystko o drugim naszym urządzeniu: przeczytane na
                    // laptopie ma znaczyć przeczytane również tutaj.
                    if (zdarzenie.kind == ReceiptKind.READ) {
                        przenieRoznacznikOdczytu(zdarzenie.groupId, zdarzenie.messageIds)
                        stan.copy(rozmowy = historia.lista())
                    } else {
                        stan
                    }
                } else if (zdarzenie.kind == ReceiptKind.READ && !czytamy) {
                    stan
                } else {
                    val nowy = if (zdarzenie.kind == ReceiptKind.READ) {
                        StanWiadomosci.PRZECZYTANE
                    } else {
                        StanWiadomosci.DOSTARCZONE
                    }

                    nanieStan(zdarzenie.groupId, zdarzenie.messageIds, nowy)
                }
            }

            is IncomingEvent.CallSignal -> obsluzSygnalRozmowy(zdarzenie, tryb)

            is IncomingEvent.JoinedConversation -> stan.copy(
                groupId = zdarzenie.groupId,
                // Nazwa ze SKŁADU grupy, nie ze stanu ekranu.
                //
                // Rozmowę założył ktoś inny, więc nie przeszła przez żadne
                // miejsce, w którym użytkownik podaje nazwę. Zostawała nazwa
                // poprzednio otwartej rozmowy — czyli wiadomości od jednej
                // osoby podpisywały się drugą — albo nie było jej wcale
                // i lista pokazywała wiersz bez imienia.
                rozmowca = nazwaZeSkladu(zdarzenie.groupId) ?: stan.rozmowca,
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

    // -----------------------------------------------------------------------
    // Rozmowy A/V
    // -----------------------------------------------------------------------

    private var rozmowa: RozmowaAV? = null

    /**
     * Sygnały, które przyszły w trakcie dzwonienia — zanim było co nimi karmić.
     *
     * Powód i skutek jego braku opisane są przy [obsluzSygnalRozmowy]; tu tylko
     * to, dlaczego kolejka jest ograniczona. Sygnalizacja przychodzi z sieci,
     * a rozmowa, której nikt nie odbiera, przyjmowałaby kandydatów tak długo,
     * jak długo ktoś je nadaje. Kilkadziesiąt wystarcza z zapasem na normalne
     * zestawienie połączenia; powyżej to już nie jest dzwonienie.
     */
    private val oczekujaceSygnaly = mutableListOf<IncomingEvent.CallSignal>()

    private companion object {
        const val LIMIT_OCZEKUJACYCH = 64
    }

    /**
     * Zaczyna rozmowę z uczestnikami bieżącej grupy.
     *
     * Skład bierzemy z drzewa MLS, nie z nazwy rozmowy: dzwonimy do osób,
     * które naprawdę są w grupie, a nie do etykiety na liście.
     */
    fun zadzwon(kontekst: Context, zWideo: Boolean) {
        val klient = messenger ?: return
        rozmowaWychodzaca = true
        rozmowaOd = System.currentTimeMillis()
        val groupId = stan.groupId ?: return
        val ja = vault.loadAccount()?.userId.orEmpty()

        val rozmowcy = runCatching { klient.uczestnicy(groupId) }.getOrDefault(emptyList())
            .filter { it != ja }
        if (rozmowcy.isEmpty()) return

        /*
         * Zestawienie rozmowy MOŻE się nie udać i nie może przy tym zabić
         * aplikacji.
         *
         * `RozmowaAV` w konstruktorze ładuje bibliotekę natywną WebRTC, tworzy
         * kontekst OpenGL i sięga po mikrofon. Każda z tych rzeczy potrafi
         * odmówić: telefon bez sprzętowego kodera, mikrofon zajęty przez inną
         * aplikację, odebrane w międzyczasie uprawnienie. Wyjątek leciał stąd
         * prosto przez wywołanie z Compose'a i wywracał proces — czyli
         * „dzwonienie crashuje aplikację". Nieudane dzwonienie ma być
         * komunikatem, a nie zniknięciem aplikacji z ekranu.
         */
        runCatching {
            RozmowaAV.zadzwon(
                kontekst = kontekst,
                messenger = klient,
                groupId = groupId,
                rozmowcy = rozmowcy,
                zWideo = zWideo,
                zakres = viewModelScope,
                onZmiana = ::przyjmijStanRozmowy,
            )
        }.onSuccess { nowa ->
            rozmowa = nowa
            stan = stan.copy(rozmowaZWideo = zWideo, przychodzacaRozmowa = null)
        }.onFailure { blad ->
            rozmowa = null
            stan = stan.copy(
                rozmowaAV = emptyList(),
                przychodzacaRozmowa = null,
                blad = "Nie udało się rozpocząć rozmowy: ${blad.message ?: "brak dostępu do mikrofonu"}",
            )
        }
    }

    /**
     * Przenosi migawkę rozmowy do stanu ekranu.
     *
     * Jedno miejsce dla obu dróg wejścia w rozmowę — inaczej dzwoniący
     * i odbierający mieliby dwie kopie tej samej reguły, a różnica między nimi
     * ujawniałaby się tylko po jednej stronie połączenia.
     */
    private fun przyjmijStanRozmowy(migawka: StanRozmowyAV) {
        stan = stan.copy(
            rozmowaAV = migawka.uczestnicy,
            mikrofonWlaczony = migawka.mikrofonWlaczony,
            kameraWlaczona = migawka.kameraWlaczona,
            wideoLokalne = migawka.wideoLokalne,
        )
    }

    /** Odbiera dzwoniącą rozmowę. */
    fun odbierzRozmowe(kontekst: Context, zWideo: Boolean) {
        val klient = messenger ?: return
        rozmowaWychodzaca = false
        rozmowaOd = System.currentTimeMillis()
        val przychodzaca = stan.przychodzacaRozmowa ?: return

        // Baner gaśnie razem z dzwonkiem, zanim cokolwiek innego się wydarzy.
        Powiadomienia.schowajRozmowe(getApplication())

        // Oferta idzie razem z odebraniem: `RozmowaAV` przetworzy ją dopiero
        // po pobraniu poświadczeń ICE — patrz komentarz przy `odbierz`.
        // Odbieranie może się nie udać z tych samych powodów co dzwonienie —
        // uzasadnienie przy `zadzwon`. Tu boli podwójnie: awaria przy odbieraniu
        // zabierała aplikację w chwili, w której ktoś do nas dzwonił.
        val nowa = runCatching {
            RozmowaAV.odbierz(
                kontekst = kontekst,
                messenger = klient,
                groupId = przychodzaca.groupId,
                callId = przychodzaca.callId,
                zWideo = zWideo,
                od = przychodzaca.od,
                oferta = przychodzaca.oferta,
                odcisk = przychodzaca.odcisk,
                zakres = viewModelScope,
                onZmiana = ::przyjmijStanRozmowy,
            )
        }.getOrElse { blad ->
            oczekujaceSygnaly.clear()
            stan = stan.copy(
                przychodzacaRozmowa = null,
                rozmowaAV = emptyList(),
                blad = "Nie udało się odebrać rozmowy: ${blad.message ?: "brak dostępu do mikrofonu"}",
            )
            return
        }
        rozmowa = nowa

        /*
         * Kandydaci uzbierani w czasie dzwonienia — teraz jest komu ich podać.
         *
         * Kolejność wobec oferty załatwia sama `RozmowaAV`: kandydat, który
         * przyjdzie przed opisem zdalnym, czeka w jej własnej kolejce. Tutaj
         * chodzi wyłącznie o to, żeby w ogóle do niej trafiły — bez tego
         * przepadały i połączenie nie miało się z czym zestawić.
         */
        val zalegle = oczekujaceSygnaly.toList()
        oczekujaceSygnaly.clear()

        for (sygnal in zalegle) {
            runCatching {
                nowa.przyjmij(
                    sygnal.senderUserId,
                    sygnal.kind,
                    sygnal.payload,
                    sygnal.dtlsFingerprint,
                )
            }
        }

        stan = stan.copy(rozmowaZWideo = zWideo, przychodzacaRozmowa = null)
    }

    /** Kontekst OpenGL trwającej rozmowy — potrzebny widokom rysującym obraz. */
    fun kontekstGlRozmowy(): org.webrtc.EglBase.Context? = rozmowa?.kontekstGl()

    /** Kończy rozmowę i zwalnia mikrofon oraz kamerę. */
    fun zakonczRozmowe() {
        zapiszSladRozmowy(
            wideo = stan.kameraWlaczona || stan.rozmowaZWideo,
            // Czas liczymy od ZESTAWIENIA, a nie od naciśnięcia „zadzwoń":
            // sekundy dzwonienia nie są rozmową, a doliczone dawałyby przy
            // nieodebranym połączeniu „rozmowa · 0:24", czyli zdanie nieprawdziwe.
            odbyta = stan.rozmowaAV.any { it.faza == FazaPolaczenia.POLACZONA },
            wychodzaca = rozmowaWychodzaca,
        )

        // Stan gaśnie pierwszy, żeby ekran dostał sygnał wyjścia najwcześniej,
        // jak się da. Nie wystarcza to jednak za synchronizację: Compose
        // sprząta dopiero przy kolejnej klatce, więc podglądy wideo mogą jeszcze
        // trzymać ścieżki, które `zakoncz` zaraz zwolni. Dlatego odpięcie
        // podglądu po stronie ekranu musi znieść już zwolniony zasób.
        stan = stan.copy(
            rozmowaAV = emptyList(),
            przychodzacaRozmowa = null,
            wideoLokalne = null,
            kameraWlaczona = false,
            mikrofonWlaczony = true,
        )

        rozmowa?.zakoncz()
        rozmowa = null
    }

    fun przelaczMikrofon() = rozmowa?.przelaczMikrofon()

    /** Kiedy rozmowa została zestawiona i kto dzwonił — do śladu w wątku. */
    private var rozmowaOd: Long? = null
    private var rozmowaWychodzaca: Boolean = true

    /**
     * Włącza albo wyłącza obraz.
     *
     * Zgoda na aparat jest sprawą ekranu, nie modelu — o uprawnienie prosi się
     * z widoku, bo tylko on ma `ActivityResultLauncher`. Tu przychodzi wywołanie
     * już po zgodzie.
     */
    fun przelaczKamere() = rozmowa?.przelaczKamere()

    /**
     * Odrzuca dzwoniącą rozmowę.
     *
     * Wysyłamy rozłączenie, zamiast po prostu zamilknąć: dzwoniący ma zobaczyć
     * odmowę, a nie czekać, aż połączenie samo wygaśnie.
     */
    fun odrzucRozmowe() {
        val przychodzaca = stan.przychodzacaRozmowa ?: return
        val klient = messenger ?: return

        viewModelScope.launch {
            runCatching {
                klient.sendCallSignal(
                    przychodzaca.groupId,
                    CallSignalKind.HANGUP,
                    przychodzaca.callId,
                    "",
                    "",
                    przychodzaca.od,
                )
            }
        }

        // Odrzucona rozmowa zostaje w wątku. Zniknięcie bez śladu znaczy, że po
        // odłożeniu telefonu nie da się już sprawdzić, kto dzwonił.
        zapiszSladRozmowy(wideo = false, odbyta = false, wychodzaca = false)

        stan = stan.copy(przychodzacaRozmowa = null)
    }

    /**
     * Dopisuje ślad po rozmowie do wątku.
     *
     * Wpis jest LOKALNY — patrz [ZapisRozmowy]. Trafia tą samą drogą co
     * wiadomość, więc przeplata się z nią w czasie zamiast stać w osobnej liście
     * wymagającej scalania dwóch porządków przy każdym rysowaniu wątku.
     */
    private fun zapiszSladRozmowy(wideo: Boolean, odbyta: Boolean, wychodzaca: Boolean) {
        if (stan.groupId == null) return
        val od = rozmowaOd
        rozmowaOd = null

        val wpis = Wiadomosc(
            autor = if (wychodzaca) "Ty" else (stan.rozmowca ?: ""),
            tresc = "",
            wlasna = wychodzaca,
            rozmowa = ZapisRozmowy(
                wideo = wideo,
                sekundy = if (odbyta && od != null) (System.currentTimeMillis() - od) / 1000 else null,
                wychodzaca = wychodzaca,
            ),
        )

        stan = stan.copy(wiadomosci = stan.wiadomosci + wpis)
        zapiszHistorie()
    }

    /**
     * Sygnał rozmowy z sieci.
     *
     * Oferta bez trwającej rozmowy znaczy, że ktoś do nas dzwoni — odkładamy ją
     * i pokazujemy pytanie. Przetworzenie jej od razu włączyłoby mikrofon bez
     * pytania nikogo o zgodę.
     */
    private fun obsluzSygnalRozmowy(
        zdarzenie: IncomingEvent.CallSignal,
        tryb: DeliveryMode,
    ): StanCzatu {
        val biezaca = rozmowa

        if (biezaca == null) {
            return when (zdarzenie.kind) {
                CallSignalKind.OFFER -> {
                    oczekujaceSygnaly.clear()
                    stan.copy(
                        trybPolaczenia = tryb,
                        przychodzacaRozmowa = PrzychodzacaRozmowa(
                            od = zdarzenie.senderUserId,
                            groupId = zdarzenie.groupId,
                            callId = zdarzenie.callId,
                            oferta = zdarzenie.payload,
                            odcisk = zdarzenie.dtlsFingerprint,
                        ),
                    )
                }

                CallSignalKind.HANGUP -> {
                    // Dzwoniący się rozmyślił, zanim ktokolwiek odebrał.
                    oczekujaceSygnaly.clear()
                    Powiadomienia.schowajRozmowe(getApplication())
                    stan.copy(trybPolaczenia = tryb, przychodzacaRozmowa = null)
                }

                /*
                 * Kandydat ICE, który przyszedł w trakcie DZWONIENIA.
                 *
                 * # Dlaczego wyrzucenie go psuło każdą rozmowę
                 *
                 * Dzwoniący nadaje kandydatów natychmiast po złożeniu oferty —
                 * `onIceCandidate` odzywa się zaraz po `setLocalDescription`,
                 * a nie po tym, jak ktoś odbierze. Przez cały czas dzwonienia
                 * `rozmowa` jest tu jeszcze `null`, bo połączenie powstaje
                 * dopiero po naciśnięciu „Odbierz" i po zgodzie na mikrofon.
                 *
                 * Wszyscy ci kandydaci lądowali więc w tej gałęzi i przepadali,
                 * uznani za „spóźniony sygnał z rozmowy, która się skończyła" —
                 * podczas gdy była to rozmowa, która się jeszcze nie zaczęła.
                 * Po odebraniu dzwoniący miał już zebrane swoje i nie nadawał
                 * ich drugi raz, więc zostawało połączenie znające adresy
                 * wyłącznie jednej strony. ICE nie miało czego z czym sparować
                 * i rozmowa nie zestawiała się nigdy: licznik szedł, a nikt
                 * nikogo nie słyszał.
                 *
                 * Teraz czekają i zostają podane rozmowie zaraz po jej
                 * utworzeniu (patrz `odbierzRozmowe`).
                 */
                else -> {
                    if (oczekujaceSygnaly.size < LIMIT_OCZEKUJACYCH) {
                        oczekujaceSygnaly.add(zdarzenie)
                    }
                    stan.copy(trybPolaczenia = tryb)
                }
            }
        }

        biezaca.przyjmij(
            zdarzenie.senderUserId,
            zdarzenie.kind,
            zdarzenie.payload,
            zdarzenie.dtlsFingerprint,
        )
        return stan.copy(trybPolaczenia = tryb)
    }

    /**
     * Wysyła plik jako załącznik.
     *
     * Odczyt przez `ContentResolver`, bo wybrany dokument jest adresem, a nie
     * ścieżką — aplikacja nie ma prawa czytać cudzych katalogów i nie musi.
     *
     * Gdy metadanych nie dało się usunąć, mówimy o tym w treści dymka.
     * Milczenie byłoby wprowadzaniem w błąd: użytkownik ma prawo wiedzieć,
     * że akurat to zdjęcie poszło z lokalizacją.
     */
    fun wyslijZalacznik(uri: Uri) {
        val klient = messenger ?: return
        val groupId = stan.groupId ?: return
        val rozmowca = stan.rozmowca ?: return

        viewModelScope.launch {
            stan = stan.copy(pracuje = true, blad = null)

            val wynik = runCatching {
                val resolver = getApplication<Application>().contentResolver
                val bajty = resolver.openInputStream(uri)?.use { it.readBytes() }
                    ?: error("nie udało się odczytać pliku")
                val mimeType = resolver.getType(uri) ?: "application/octet-stream"

                klient.sendAttachment(groupId, bajty, mimeType, nazwaPliku(uri), rozmowca)
            }

            stan = wynik.fold(
                { wyslany ->
                    val opis = wyslany.zalacznik.nazwaPliku ?: opisTypu(wyslany.zalacznik.mimeType)
                    stan.copy(
                        pracuje = false,
                        trybPolaczenia = wyslany.sposob,
                        wiadomosci = stan.wiadomosci + Wiadomosc(
                            autor = "Ty",
                            tresc = if (wyslany.metadaneUsuniete) {
                                opis
                            } else {
                                "$opis — nie udało się usunąć metadanych"
                            },
                            wlasna = true,
                            zalacznik = wyslany.zalacznik,
                        ),
                    )
                },
                { blad ->
                    stan.copy(
                        pracuje = false,
                        blad = blad.message ?: "nie udało się wysłać załącznika",
                    )
                },
            )

            zapiszHistorie()
        }
    }

    /** Pobiera i odszyfrowuje załącznik. `null`, gdy się nie udało. */
    suspend fun pobierzZalacznik(zalacznik: Zalacznik): ByteArray? =
        messenger?.let { runCatching { it.openAttachment(zalacznik) }.getOrNull() }

    /** Nazwa pliku z dostawcy treści — sam adres jej nie niesie. */
    private fun nazwaPliku(uri: Uri): String? =
        getApplication<Application>().contentResolver
            .query(uri, arrayOf(OpenableColumns.DISPLAY_NAME), null, null, null)
            ?.use { kursor ->
                if (kursor.moveToFirst()) kursor.getString(0) else null
            }

    /**
     * Dopisuje wiadomość do rozmowy, której nie ma na ekranie.
     *
     * Czyta i zapisuje wprost z dysku, bo stan w pamięci dotyczy wyłącznie
     * rozmowy otwartej. Nazwę bierzemy ze składu grupy — rozmowa mogła
     * powstać przed chwilą i nie mieć jeszcze żadnej.
     */
    /**
     * Nanosi potwierdzenie na własne wiadomości.
     *
     * Rozmowa otwarta na ekranie idzie przez stan, każda inna — prosto na dysk.
     * Bez tej drugiej ścieżki ptaszek pojawiałby się tylko w rozmowie akurat
     * oglądanej, a po wejściu w inną wracałby do „wysłano".
     */
    /**
     * Przenosi znacznik przeczytania z drugiego własnego urządzenia.
     *
     * Chwilę bierzemy z najnowszej **wymienionej** wiadomości, a nie z „teraz":
     * potwierdzenia wychodzą z losowym opóźnieniem do 30 s (`Potwierdzenia.kt`),
     * więc bieżący czas oznaczyłby jako przeczytane także to, co przyszło
     * w międzyczasie.
     */
    private fun przenieRoznacznikOdczytu(groupId: ByteArray, identyfikatory: List<ByteArray>) {
        val szukane = identyfikatory.map { it.hex() }.toSet()

        runCatching {
            val najnowsza = historia.wczytaj(groupId)
                .filter { it.id.hex() in szukane }
                .maxOfOrNull { it.czas }
                ?: return

            historia.oznaczPrzeczytane(groupId, najnowsza)
        }
    }

    private fun nanieStan(
        groupId: ByteArray,
        identyfikatory: List<ByteArray>,
        nowy: StanWiadomosci,
    ): StanCzatu {
        val szukane = identyfikatory.map { it.hex() }.toSet()

        fun podnies(wiadomosci: List<Wiadomosc>) = wiadomosci.map { w ->
            if (w.wlasna && w.id.hex() in szukane) {
                w.copy(stan = (w.stan ?: StanWiadomosci.WYSLANE).wyzszy(nowy))
            } else {
                w
            }
        }

        if (stan.groupId?.contentEquals(groupId) == true) {
            val podniesione = podnies(stan.wiadomosci)
            // Zapis od razu: potwierdzenie przychodzi RAZ. Gdyby nie trafiło na
            // dysk, po restarcie aplikacji dymek wróciłby do „wysłano", a drugie
            // potwierdzenie już nie przyjdzie.
            runCatching {
                val nazwa = stan.rozmowca ?: historia.rozmowca(groupId)
                if (nazwa != null) historia.zapisz(groupId, nazwa, podniesione)
            }
            return stan.copy(wiadomosci = podniesione)
        }

        runCatching {
            val nazwa = historia.rozmowca(groupId) ?: return stan
            historia.zapisz(groupId, nazwa, podnies(historia.wczytaj(groupId)))
        }
        return stan
    }

    private fun dopiszDoRozmowy(groupId: ByteArray, wiadomosc: Wiadomosc) {
        val nazwa = nazwaZeSkladu(groupId) ?: historia.rozmowca(groupId) ?: return
        // Atomowo: odczyt-i-zapis pod jednym zamkiem, żeby dwie wiadomości tuż
        // po sobie się nie nadpisały (patrz `Historia.dopisz`).
        runCatching { historia.dopisz(groupId, nazwa, wiadomosc) }
    }

    /**
     * Usuwa rozmowę z tego urządzenia i odświeża listę.
     *
     * Jeśli usuwana rozmowa jest tą zapamiętaną jako otwarta, czyścimy
     * `groupId` — wybór ekranu w [MainActivity] ma warunek `groupId != null`,
     * więc bez tego ekran mógłby wrócić do wątku, którego nie ma już na dysku.
     */
    fun usunRozmowe(groupId: ByteArray) {
        runCatching {
            historia.usun(groupId)
            val byla = stan.groupId?.contentEquals(groupId) == true
            stan = stan.copy(
                rozmowy = historia.lista(),
                groupId = if (byla) null else stan.groupId,
                wiadomosci = if (byla) emptyList() else stan.wiadomosci,
            )
        }
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

    /**
     * Odpina słuchacza zdarzeń — klienta NIE zamyka.
     *
     * To jest cała zmiana, przez którą telefon zaczął odbierać przy zamkniętej
     * aplikacji. Wcześniej stało tu `messenger?.close()`, więc obrót ekranu albo
     * wyjście z aplikacji zrywały połączenie ze skrzynką i kończyły odbieranie —
     * a wiadomość wysłana w tym czasie czekała na serwerze do następnego
     * uruchomienia. Klient żyje teraz w [Rdzen], razem z procesem, którego przy
     * życiu trzyma [UslugaNasluchu]; kończy go dopiero wylogowanie.
     */
    override fun onCleared() {
        odepnijSluchacza?.invoke()
        odepnijSluchacza = null
        super.onCleared()
    }
}
