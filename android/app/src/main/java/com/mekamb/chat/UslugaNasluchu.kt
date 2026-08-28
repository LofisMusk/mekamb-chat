package com.mekamb.chat

import android.app.Service
import android.content.Context
import android.content.Intent
import android.content.pm.ServiceInfo
import android.os.Build
import android.os.IBinder
import androidx.core.app.ServiceCompat
import uniffi.mekamb_ffi.CallSignalKind
import uniffi.mekamb_ffi.DeliveryMode
import uniffi.mekamb_ffi.IncomingEvent

/**
 * Usługa pierwszoplanowa: trzyma proces przy życiu, żeby wiadomości dochodziły.
 *
 * # Dlaczego usługa, a nie „po prostu wątek w tle"
 *
 * Bo Android zabija procesy bez widocznej aktywności — i robi to tym chętniej,
 * im dłużej aplikacja jest schowana. Wątek, korutyna i otwarte gniazdo nie
 * chronią przed niczym: giną razem z procesem. Usługa pierwszoplanowa jest
 * jedynym sposobem powiedzenia systemowi „ten proces coś robi dla użytkownika",
 * a ceną za to jest powiadomienie, którego nie da się schować.
 *
 * Płacimy ją świadomie. Bez tego stan wyglądał tak: po zamknięciu aplikacji nie
 * przychodziło nic, a wiadomości pojawiały się dopiero wtedy, gdy użytkownik
 * sam coś napisał i połączenie wstawało przy okazji — czyli o cudzej wiadomości
 * można było się dowiedzieć wyłącznie przez przypadek.
 *
 * # Dlaczego to nie jest push
 *
 * Bo push wymaga `google-services.json` i przepuszczenia sygnału przez serwery
 * Google — czyli oddania im informacji o TYM, że i KIEDY ktoś do nas pisze.
 * Treści by nie zobaczyli, ale metadane owszem, a to jest dokładnie ta rzecz,
 * której ten projekt nie oddaje. Trwałe połączenie kosztuje trochę baterii
 * i jest tego warte; gdyby kiedyś doszedł push, ta usługa zostaje dla tych,
 * którzy nie chcą go używać.
 *
 * # Dlaczego usługa NIE trzyma klienta
 *
 * Trzyma go [Rdzen], a usługa tylko istnieje. Klient przypięty do usługi ginąłby
 * przy każdym jej zatrzymaniu przez system, a odtwarzany przy `START_STICKY`
 * otwierałby DRUGI stan MLS na tym samym skarbcu — czyli psuł konto. Podział
 * jest więc taki: [Rdzen] wie, co robić, usługa dba o to, żeby było gdzie.
 */
class UslugaNasluchu : Service() {

    /** Odpięcie słuchacza powiadomień. `null`, dopóki usługa nie ruszyła. */
    private var odepnij: (() -> Unit)? = null

    override fun onCreate() {
        super.onCreate()
        Powiadomienia.zaloz(this)

        odepnij = Rdzen.sluchaj { zdarzenie, _ -> powiadom(zdarzenie) }
    }

    override fun onStartCommand(intent: Intent?, flags: Int, startId: Int): Int {
        /*
         * Od Androida 14 typ usługi jest obowiązkowy i musi zgadzać się
         * z manifestem — inaczej system wyrzuca wyjątek zamiast uruchomić
         * usługę. Domyślnie `DATA_SYNC`: utrzymujemy połączenie, którym płyną
         * dane użytkownika.
         *
         * Na czas rozmowy A/V awansujemy do `MICROPHONE` (i `CAMERA` przy
         * wideo). Rozmowa potrafi trwać po zablokowaniu ekranu, gdy nie ma już
         * widocznej aktywności — a wtedy dostęp do mikrofonu z usługi bez tego
         * typu jest od Androida 14 `SecurityException`. Typ zdejmujemy z powrotem
         * po rozmowie [AKCJA_KONIEC_ROZMOWY], żeby nie trzymać mikrofonu dłużej,
         * niż trzeba.
         *
         * Awans jest pod `runCatching` z odwrotem do `DATA_SYNC`: gdyby system
         * odmówił typu mikrofonowego (np. cofnięte w międzyczasie uprawnienie),
         * usługa ma zostać przy życiu jako skrzynka, a nie paść razem z wyjątkiem.
         */
        val wRozmowie = intent?.action == AKCJA_ROZMOWA
        val zWideo = intent?.getBooleanExtra(EXTRA_WIDEO, false) ?: false

        if (!uruchomPierwszoplanowo(wRozmowie, zWideo)) {
            uruchomPierwszoplanowo(wRozmowie = false, zWideo = false)
        }

        /*
         * `START_STICKY`: po zabiciu przez system usługa ma wrócić.
         *
         * Wraca bez intencji i bez klienta — i to jest w porządku, bo klienta
         * i tak trzyma [Rdzen]. Gdy proces zginął w całości, [Rdzen] jest pusty,
         * usługa nie ma czego pilnować i sama się zatrzymuje. Odbieranie wróci
         * przy następnym otwarciu aplikacji, kiedy skarbiec da się znów otworzyć.
         */
        if (Rdzen.messenger == null) stopSelf()

        return START_STICKY
    }

    /**
     * Powiadamia o tym, co przyszło, gdy nikt nie patrzy.
     *
     * Warunek jest o UWADZE użytkownika, nie o dotarciu koperty: kto ma
     * aplikację przed oczami, ten wiadomość widzi, a powiedzenie mu o niej
     * drugi raz jest szumem. Rozmowa dzwoni zawsze — także przy otwartej
     * aplikacji, bo baner jest wtedy jedynym sygnałem, że dzwoni ktoś spoza
     * wątku, na który się patrzy.
     */
    private fun powiadom(zdarzenie: IncomingEvent) {
        when (zdarzenie) {
            is IncomingEvent.CallSignal -> when (zdarzenie.kind) {
                CallSignalKind.OFFER -> Powiadomienia.pokazRozmowe(this, zdarzenie.senderUserId)

                // Dzwoniący się rozmyślił — baner gaśnie razem z dzwonkiem.
                CallSignalKind.HANGUP -> Powiadomienia.schowajRozmowe(this)

                // Kandydaci ICE i odpowiedź to sygnalizacja w toku, nie zdarzenie
                // dla użytkownika: telefon już dzwoni albo rozmowa już trwa.
                else -> Unit
            }

            is IncomingEvent.Message ->
                powiadomOWiadomosci(zdarzenie.groupId, zdarzenie.senderUserId)

            is IncomingEvent.Attachment ->
                powiadomOWiadomosci(zdarzenie.groupId, zdarzenie.senderUserId)

            /*
             * Reszta nie jest niczym, o czym da się powiedzieć zdanie.
             *
             * Potwierdzenia zmieniają ptaszki przy wiadomościach, które
             * użytkownik już wysłał; zmiany składu i propozycje dzieją się
             * pod spodem. Powiadomienie o którymkolwiek z nich byłoby
             * powiadomieniem o działaniu protokołu.
             */
            else -> Unit
        }
    }

    /**
     * Powiadamia, chyba że użytkownik i tak na to patrzy.
     *
     * Warunek jest o UWADZE, nie o dotarciu koperty: kto ma tę rozmowę otwartą
     * na wierzchu, ten widzi wiadomość wchodzącą do wątku, a powiedzenie mu
     * o niej drugi raz jest szumem. Wiadomość z INNEJ rozmowy powiadamia nawet
     * przy otwartej aplikacji — tego wątku nie widać.
     */
    private fun powiadomOWiadomosci(groupId: ByteArray, od: String) {
        if (Rdzen.naWierzchu && czytana(groupId)) return
        Powiadomienia.pokazWiadomosc(this, groupId, od)
    }

    private fun czytana(groupId: ByteArray): Boolean =
        Rdzen.otwartaGrupa?.contentEquals(groupId) == true

    /**
     * Wchodzi w tryb pierwszoplanowy z odpowiednim typem usługi.
     *
     * Zwraca `false`, gdy system odrzucił start z tym typem — wołający próbuje
     * wtedy zwykłego `DATA_SYNC`, żeby usługa przetrwała jako skrzynka.
     */
    private fun uruchomPierwszoplanowo(wRozmowie: Boolean, zWideo: Boolean): Boolean {
        val typ = when {
            Build.VERSION.SDK_INT >= Build.VERSION_CODES.R -> {
                var t = ServiceInfo.FOREGROUND_SERVICE_TYPE_DATA_SYNC
                if (wRozmowie) {
                    t = t or ServiceInfo.FOREGROUND_SERVICE_TYPE_MICROPHONE
                    if (zWideo) t = t or ServiceInfo.FOREGROUND_SERVICE_TYPE_CAMERA
                }
                t
            }

            Build.VERSION.SDK_INT >= Build.VERSION_CODES.Q ->
                ServiceInfo.FOREGROUND_SERVICE_TYPE_DATA_SYNC

            else -> 0
        }

        return runCatching {
            ServiceCompat.startForeground(
                this,
                Powiadomienia.ID_USLUGI,
                Powiadomienia.powiadomienieUslugi(this),
                typ,
            )
        }.isSuccess
    }

    companion object {
        /** Awans usługi do typu mikrofon/aparat na czas rozmowy. */
        private const val AKCJA_ROZMOWA = "com.mekamb.chat.ROZMOWA"
        private const val EXTRA_WIDEO = "wideo"

        /**
         * Wchodzi w tryb rozmowy: usługa dostaje typ `microphone` (+`camera`).
         *
         * Wołane po przyznaniu `RECORD_AUDIO` (i `CAMERA` przy wideo), więc
         * uprawnienia do typu są już na miejscu. Pod `runCatching`, bo start
         * usługi nie może wywrócić samego zestawiania rozmowy.
         */
        fun wejdzWTrybRozmowy(kontekst: Context, zWideo: Boolean) {
            val intencja = Intent(kontekst, UslugaNasluchu::class.java).apply {
                action = AKCJA_ROZMOWA
                putExtra(EXTRA_WIDEO, zWideo)
            }
            runCatching {
                if (Build.VERSION.SDK_INT >= Build.VERSION_CODES.O) {
                    kontekst.startForegroundService(intencja)
                } else {
                    kontekst.startService(intencja)
                }
            }
        }

        /** Zdejmuje typ mikrofon/aparat po rozmowie — z powrotem do `dataSync`. */
        fun wyjdzZTrybuRozmowy(kontekst: Context) {
            val intencja = Intent(kontekst, UslugaNasluchu::class.java)
            runCatching {
                if (Build.VERSION.SDK_INT >= Build.VERSION_CODES.O) {
                    kontekst.startForegroundService(intencja)
                } else {
                    kontekst.startService(intencja)
                }
            }
        }
    }

    override fun onDestroy() {
        odepnij?.invoke()
        odepnij = null
        super.onDestroy()
    }

    /** Usługa jest uruchamiana, nie wiązana — rozmawia się z nią przez [Rdzen]. */
    override fun onBind(intent: Intent?): IBinder? = null
}
