package com.mekamb.chat

import android.content.Context
import android.content.Intent
import android.os.Build
import kotlinx.coroutines.CoroutineScope
import kotlinx.coroutines.Dispatchers
import kotlinx.coroutines.SupervisorJob
import uniffi.mekamb_ffi.DeliveryMode
import uniffi.mekamb_ffi.IncomingEvent

/**
 * Klient i jego zakres — na czas ŻYCIA PROCESU, nie ekranu.
 *
 * # Dlaczego to nie mogło zostać w modelu widoku
 *
 * Bo `viewModelScope` gaśnie razem z aktywnością, a razem z nim gasło
 * połączenie ze skrzynką. Zamknięcie aplikacji znaczyło więc: koniec odbierania.
 * Wiadomość wysłana w tym czasie leżała na serwerze, a telefon dowiadywał się
 * o niej dopiero przy następnym uruchomieniu — albo wtedy, gdy użytkownik sam
 * coś napisał i połączenie wstawało przy okazji. Z zewnątrz wyglądało to tak,
 * jakby wiadomości przychodziły tylko wtedy, kiedy się na nie odpisuje.
 *
 * Klient siedzi więc tutaj, poza cyklem życia ekranu, a [UslugaNasluchu] dba
 * o to, żeby system nie zabił procesu, w którym on żyje.
 *
 * # Dlaczego JEDEN klient, a nie po jednym na miejsce
 *
 * Bo `Messenger` trzyma stan MLS. Dwa klienty otwarte na tym samym skarbcu to
 * dwa ratchety przesuwane niezależnie: każdy zapis jednego cofa to, co zrobił
 * drugi, a wiadomości przestają się odszyfrowywać po obu stronach. To nie jest
 * kwestia wydajności — dwie instancje **psują konto**.
 *
 * # Dlaczego zdarzenia idą do listy słuchaczy
 *
 * Bo mają dwóch odbiorców o różnym czasie życia. Model widoku chce ich do
 * rysowania i znika razem z ekranem; usługa chce ich do powiadomień i zostaje.
 * Jeden `onEvent` przekazany do `startReceiving` musiałby więc albo umrzeć
 * z ekranem (i zabrać powiadomienia), albo przeżyć go i trzymać przy życiu
 * cały model widoku.
 */
object Rdzen {
    /**
     * Zakres na czas życia procesu.
     *
     * `SupervisorJob`, bo awaria jednej korutyny — na przykład przetwarzania
     * jednej koperty — nie ma prawa uciszyć odbierania w ogóle.
     */
    val zakres = CoroutineScope(SupervisorJob() + Dispatchers.Default)

    /** Otwarty klient albo `null`, gdy nikt nie jest zalogowany. */
    @Volatile
    var messenger: Messenger? = null
        private set

    /**
     * Czy aplikacja jest na wierzchu.
     *
     * Decyduje o powiadomieniach: kto patrzy na ekran, ten widzi wiadomość
     * i drugie powiedzenie mu o niej jest szumem. Ustawiane przez aktywność
     * w `onStart`/`onStop`.
     */
    @Volatile
    var naWierzchu: Boolean = false

    /**
     * Rozmowa otwarta na ekranie.
     *
     * Powiadomienie o wiadomości z rozmowy, którą użytkownik ma właśnie przed
     * oczami, jest powiadomieniem o czymś, co już widzi.
     */
    @Volatile
    var otwartaGrupa: ByteArray? = null

    private val sluchacze = mutableListOf<(IncomingEvent, DeliveryMode) -> Unit>()

    /**
     * Podpina klienta i zaczyna odbierać.
     *
     * Odbieranie rusza z [zakres], więc trwa po zamknięciu ekranu. Poprzedni
     * klient jest zamykany: dwa otwarte na tym samym skarbcu psują stan MLS.
     */
    fun podepnij(kontekst: Context, klient: Messenger) {
        messenger?.close()
        messenger = klient

        klient.startReceiving(zakres) { zdarzenie, droga -> rozeslij(zdarzenie, droga) }
        uruchomUsluge(kontekst)
    }

    /** Zamyka klienta i gasi usługę — po wylogowaniu albo skasowaniu konta. */
    fun odepnij(kontekst: Context) {
        messenger?.close()
        messenger = null
        otwartaGrupa = null

        kontekst.stopService(Intent(kontekst, UslugaNasluchu::class.java))
    }

    /**
     * Dopisuje słuchacza i oddaje funkcję odpinającą.
     *
     * Odpięcie jest obowiązkiem wywołującego i dlatego wraca stąd, a nie
     * z osobnej metody: słuchacz modelu widoku trzyma referencję do modelu,
     * więc nieodpięty przy każdym obrocie ekranu zostawiałby po sobie kolejny
     * martwy model rysujący w próżnię.
     */
    fun sluchaj(sluchacz: (IncomingEvent, DeliveryMode) -> Unit): () -> Unit {
        synchronized(sluchacze) { sluchacze.add(sluchacz) }
        return { synchronized(sluchacze) { sluchacze.remove(sluchacz) } }
    }

    private fun rozeslij(zdarzenie: IncomingEvent, droga: DeliveryMode) {
        // Kopia pod zamkiem, wywołanie poza nim: słuchacz, który przy okazji
        // dopisze albo usunie innego, zakleszczyłby się na tym samym zamku.
        val biezacy = synchronized(sluchacze) { sluchacze.toList() }
        for (sluchacz in biezacy) runCatching { sluchacz(zdarzenie, droga) }
    }

    private fun uruchomUsluge(kontekst: Context) {
        val intencja = Intent(kontekst, UslugaNasluchu::class.java)

        if (Build.VERSION.SDK_INT >= Build.VERSION_CODES.O) {
            kontekst.startForegroundService(intencja)
        } else {
            kontekst.startService(intencja)
        }
    }
}
