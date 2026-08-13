package com.mekamb.chat

import android.app.Notification
import android.app.NotificationChannel
import android.app.NotificationManager
import android.app.PendingIntent
import android.content.Context
import android.content.Intent
import android.media.AudioAttributes
import android.net.Uri
import android.os.Build
import androidx.core.app.NotificationCompat
import androidx.core.app.NotificationManagerCompat

/**
 * Powiadomienia: nowa wiadomość i dzwoniąca rozmowa.
 *
 * # Dlaczego to w ogóle powstało
 *
 * Bo bez tego aplikacja milczała. Połączenie ze skrzynką żyło tak długo, jak
 * ekran z rozmową — po zamknięciu aplikacji nie przychodziło nic, a wiadomości
 * pojawiały się dopiero wtedy, gdy użytkownik sam coś napisał i połączenie
 * wstawało przy okazji. Znaczyło to, że o wiadomości można się było dowiedzieć
 * wyłącznie przez przypadek. [UslugaNasluchu] utrzymuje połączenie; ten plik
 * odpowiada za to, żeby było o czym powiedzieć.
 *
 * # Dlaczego trzy kanały, a nie jeden
 *
 * Bo Android pozwala wyciszyć kanał, a nie pojedyncze powiadomienie — i to jest
 * jedyne miejsce, w którym użytkownik może powiedzieć „wiadomości po cichu, ale
 * telefon ma dzwonić". Jeden kanał odbierałby mu ten wybór: albo wszystko
 * z dźwiękiem, albo nic.
 *
 * Kanał usługi jest osobny i cichy z tego samego powodu, tylko z drugiej strony:
 * powiadomienie „mekamb działa" jest ceną, którą Android każe zapłacić za pracę
 * w tle, a nie treścią. Brzęczące przy każdym uruchomieniu byłoby karą za
 * działanie zgodnie z regułami systemu.
 *
 * # Czego w powiadomieniu NIE MA
 *
 * Treści wiadomości. Powiadomienie widać na zablokowanym ekranie, czyli
 * u każdego, kto sięgnie po leżący telefon — a to jest dokładnie ten model
 * zagrożenia, przed którym całe szyfrowanie nie chroni. Mówimy więc, KTO
 * napisał, i tyle; po treść trzeba odblokować telefon i wejść do aplikacji.
 */
object Powiadomienia {
    /** Nowe wiadomości. Domyślna ważność: dźwięk jest, wyskakującego okna nie. */
    const val KANAL_WIADOMOSCI = "wiadomosci"

    /** Dzwoniąca rozmowa. Najwyższa ważność — inaczej baner się nie pokaże. */
    const val KANAL_ROZMOWY = "rozmowy"

    /** Powiadomienie usługi. Najniższa ważność: ma być, ale nie ma przeszkadzać. */
    const val KANAL_USLUGI = "dzialanie"

    /** Stały identyfikator, bo powiadomienie usługi jest zawsze jedno. */
    const val ID_USLUGI = 1

    /** Tak samo: dzwoni się z jednej rozmowy naraz, więc kolejna zastępuje poprzednią. */
    const val ID_ROZMOWY = 2

    /**
     * Pierwszy wolny numer dla wiadomości.
     *
     * Powiadomienia o wiadomościach są grupowane po rozmowie — jedno na wątek,
     * kolejna wiadomość podmienia poprzednie. Numer bierze się ze skrótu
     * identyfikatora grupy, więc jest stały dla tej samej rozmowy i nie musi
     * być nigdzie zapamiętany.
     */
    private const val PIERWSZY_WOLNY = 100

    /** Dzwonek z zasobów aplikacji. */
    fun dzwonek(kontekst: Context): Uri =
        Uri.parse("android.resource://${kontekst.packageName}/${R.raw.mekamb_ring}")

    /**
     * Zakłada kanały. Wołane raz, przy starcie usługi.
     *
     * Powtórne wywołanie nic nie psuje — system aktualizuje wtedy tylko nazwę
     * i opis, a ustawienia dźwięku zmienione przez użytkownika zostawia. To jest
     * właściwe zachowanie: kto wyciszył kanał, wyciszył go na stałe.
     */
    fun zaloz(kontekst: Context) {
        if (Build.VERSION.SDK_INT < Build.VERSION_CODES.O) return

        val menedzer = kontekst.getSystemService(NotificationManager::class.java) ?: return

        menedzer.createNotificationChannel(
            NotificationChannel(
                KANAL_WIADOMOSCI,
                "Wiadomości",
                NotificationManager.IMPORTANCE_DEFAULT,
            ),
        )

        /*
         * Dzwonek zapętlony, tak jak w telefonie.
         *
         * `setSound` z atrybutami `USAGE_NOTIFICATION_RINGTONE` mówi systemowi,
         * że to dzwonek — dzięki temu gra przez głośnik dzwonka, a nie przez
         * kanał powiadomień, i słychać go także wtedy, gdy telefon leży
         * w kieszeni z przyciszonymi powiadomieniami.
         */
        menedzer.createNotificationChannel(
            NotificationChannel(
                KANAL_ROZMOWY,
                "Połączenia",
                NotificationManager.IMPORTANCE_HIGH,
            ).apply {
                setSound(
                    dzwonek(kontekst),
                    AudioAttributes.Builder()
                        .setUsage(AudioAttributes.USAGE_NOTIFICATION_RINGTONE)
                        .setContentType(AudioAttributes.CONTENT_TYPE_SONIFICATION)
                        .build(),
                )
                enableVibration(true)
            },
        )

        menedzer.createNotificationChannel(
            NotificationChannel(
                KANAL_USLUGI,
                "Działanie w tle",
                NotificationManager.IMPORTANCE_MIN,
            ).apply {
                description = "Utrzymuje połączenie, żeby wiadomości docierały od razu."
                setShowBadge(false)
            },
        )
    }

    /** Intencja otwierająca aplikację — tę samą, która już działa, jeśli działa. */
    private fun otworzAplikacje(kontekst: Context): PendingIntent =
        PendingIntent.getActivity(
            kontekst,
            0,
            Intent(kontekst, MainActivity::class.java).apply {
                flags = Intent.FLAG_ACTIVITY_SINGLE_TOP or Intent.FLAG_ACTIVITY_CLEAR_TOP
            },
            PendingIntent.FLAG_UPDATE_CURRENT or PendingIntent.FLAG_IMMUTABLE,
        )

    /** Powiadomienie, które Android wymaga od usługi pierwszoplanowej. */
    fun powiadomienieUslugi(kontekst: Context): Notification =
        NotificationCompat.Builder(kontekst, KANAL_USLUGI)
            .setContentTitle("mekamb")
            .setContentText("Czeka na wiadomości")
            .setSmallIcon(android.R.drawable.stat_notify_chat)
            .setPriority(NotificationCompat.PRIORITY_MIN)
            .setOngoing(true)
            .setShowWhen(false)
            .setContentIntent(otworzAplikacje(kontekst))
            .build()

    /**
     * Mówi, że ktoś napisał — bez mówienia, co napisał.
     *
     * Numer bierze się z identyfikatora grupy, więc druga wiadomość z tej samej
     * rozmowy podmienia pierwszą zamiast układać stos powiadomień o tym samym.
     */
    fun pokazWiadomosc(kontekst: Context, groupId: ByteArray, od: String) {
        val powiadomienie = NotificationCompat.Builder(kontekst, KANAL_WIADOMOSCI)
            .setContentTitle(od)
            .setContentText("Nowa wiadomość")
            .setSmallIcon(android.R.drawable.stat_notify_chat)
            .setPriority(NotificationCompat.PRIORITY_DEFAULT)
            .setCategory(NotificationCompat.CATEGORY_MESSAGE)
            // Treści nie ma nawet w rozwinięciu — patrz komentarz na górze pliku.
            .setVisibility(NotificationCompat.VISIBILITY_PRIVATE)
            .setAutoCancel(true)
            .setContentIntent(otworzAplikacje(kontekst))
            .build()

        powiadom(kontekst, PIERWSZY_WOLNY + (groupId.contentHashCode() and 0xffff), powiadomienie)
    }

    /**
     * Baner dzwoniącej rozmowy.
     *
     * `setFullScreenIntent` jest tym, co czyni z powiadomienia BANER: przy
     * zablokowanym ekranie Android pokazuje wtedy pełny ekran dzwonienia, a przy
     * odblokowanym — pasek u góry, tak jak w każdym innym komunikatorze. Bez
     * tego przychodząca rozmowa byłaby zwykłym wierszem na liście powiadomień,
     * czyli czymś, co się zauważa po fakcie.
     *
     * `setOngoing` odbiera możliwość zmiecenia go gestem: dzwoniąca rozmowa ma
     * dwa wyjścia — odebrać albo odrzucić — i oba są w aplikacji.
     */
    fun pokazRozmowe(kontekst: Context, od: String) {
        val powiadomienie = NotificationCompat.Builder(kontekst, KANAL_ROZMOWY)
            .setContentTitle(od)
            .setContentText("Dzwoni")
            .setSmallIcon(android.R.drawable.stat_sys_phone_call)
            .setPriority(NotificationCompat.PRIORITY_MAX)
            .setCategory(NotificationCompat.CATEGORY_CALL)
            .setOngoing(true)
            .setAutoCancel(false)
            .setSound(dzwonek(kontekst))
            .setFullScreenIntent(otworzAplikacje(kontekst), true)
            .setContentIntent(otworzAplikacje(kontekst))
            .build()

        powiadom(kontekst, ID_ROZMOWY, powiadomienie)
    }

    /** Gasi baner — po odebraniu, odrzuceniu albo rozłączeniu się dzwoniącego. */
    fun schowajRozmowe(kontekst: Context) {
        NotificationManagerCompat.from(kontekst).cancel(ID_ROZMOWY)
    }

    /** Gasi powiadomienie o wiadomościach z tej rozmowy — bo właśnie ją otwarto. */
    fun schowajWiadomosci(kontekst: Context, groupId: ByteArray) {
        NotificationManagerCompat.from(kontekst)
            .cancel(PIERWSZY_WOLNY + (groupId.contentHashCode() and 0xffff))
    }

    /**
     * Wysyła powiadomienie, znosząc brak zgody.
     *
     * Od Androida 13 `POST_NOTIFICATIONS` jest uprawnieniem, którego użytkownik
     * może nie dać — i to jest jego prawo, a nie usterka. `NotificationManagerCompat`
     * rzuca wtedy `SecurityException`; przechwycenie go tutaj sprawia, że odmowa
     * powiadomień znaczy „nie ma powiadomień", a nie „aplikacja się wywala".
     */
    private fun powiadom(kontekst: Context, id: Int, powiadomienie: Notification) {
        runCatching { NotificationManagerCompat.from(kontekst).notify(id, powiadomienie) }
    }
}
