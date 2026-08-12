package com.mekamb.chat

import java.nio.ByteBuffer
import java.util.concurrent.Executors
import java.util.concurrent.ScheduledExecutorService
import java.util.concurrent.ScheduledFuture
import java.util.concurrent.TimeUnit
import kotlin.coroutines.cancellation.CancellationException
import okhttp3.OkHttpClient
import okhttp3.Request
import okhttp3.Response
import okhttp3.WebSocket
import okhttp3.WebSocketListener
import okio.ByteString

/**
 * Odbiór ze skrzynki na serwerze.
 *
 * # Dlaczego to w ogóle musi istnieć na Androidzie
 *
 * Klient natywny ma własny transport i odbiera wprost od drugiego urządzenia,
 * więc łatwo uznać skrzynkę za coś, co dotyczy tylko przeglądarki. Jest
 * odwrotnie: **przeglądarka nie potrafi dostarczyć bezpośrednio.** Sandbox nie
 * pozwala jej wysłać pakietu UDP ani przyjąć połączenia, więc każda wiadomość
 * od rozmówcy z weba ląduje w skrzynce — i tylko tam.
 *
 * Android deponował do skrzynki (`Api.deposit`), ale nigdy z niej nie czytał:
 * `startReceiving` słuchało wyłącznie transportu P2P. Skutek był jednostronny
 * i przez to mylący — Android → web działało, web → Android nie docierało
 * nigdy, a nadawca nie widział żadnego błędu, bo zostawienie koperty
 * w skrzynce kończy się powodzeniem.
 *
 * # Dlaczego to nie jest w rdzeniu w Rust
 *
 * Rdzeń odpowiada za kryptografię i format kopert; ten plik nie dotyka ani
 * jednego, ani drugiego — otwiera gniazdo i potwierdza wpisy w kolejce.
 * Odpowiednik po stronie weba (`web/src/lib/polaczenie.ts`) też jest napisany
 * w języku klienta, a treść koperty i tak przechodzi przez `openEnvelope`.
 */

/** Co ile wysyłamy podtrzymanie. Serwer odpowiada `pong`. */
private const val PING_MS = 30_000L

/** Od tylu milisekund zaczyna się odczekiwanie przed ponowieniem. */
private const val PONOWIENIE_MIN_MS = 1_000L

/** Powyżej tego nie czekamy dłużej — użytkownik patrzy na ekran. */
private const val PONOWIENIE_MAX_MS = 30_000L

/** Długość prefiksu z identyfikatorem wpisu w kolejce (`server/src/inbox.ts`). */
const val BAJTY_IDENTYFIKATORA = 8

/**
 * Ile razy próbujemy przetworzyć kopertę, zanim uznamy ją za martwą.
 *
 * Więcej niż raz, bo koperta może wyprzedzić commit, który jest jej potrzebny —
 * wtedy druga próba, już po nadejściu commitu, się powiedzie. Potwierdzenie po
 * pierwszym niepowodzeniu kasowałoby takie koperty bezpowrotnie.
 */
const val PROB_PRZED_ODRZUCENIEM = 3

/** Ramka ze skrzynki: identyfikator wpisu w kolejce i sama koperta. */
class RamkaSkrzynki(val id: Long, val koperta: ByteArray)

/**
 * Rozdziela ramkę na identyfikator i kopertę.
 *
 * Pierwsze osiem bajtów to numer wpisu w kolejce serwera, zapisany
 * big-endian — klient odsyła go w potwierdzeniu, dzięki czemu serwer wie, co
 * skasować. Zwraca `null`, gdy ramka jest za krótka, żeby ten numer w niej był:
 * takiej ramki nie da się ani przetworzyć, ani potwierdzić, a wyjątek zrywałby
 * połączenie z powodu jednego uszkodzonego pakietu.
 */
fun rozdzielRamke(ramka: ByteArray): RamkaSkrzynki? {
    if (ramka.size < BAJTY_IDENTYFIKATORA) return null

    val id = ByteBuffer.wrap(ramka, 0, BAJTY_IDENTYFIKATORA).long
    return RamkaSkrzynki(id, ramka.copyOfRange(BAJTY_IDENTYFIKATORA, ramka.size))
}

/** Co zrobić z kopertą po nieudanym przetworzeniu. */
enum class Decyzja {
    /** Zostaw w kolejce — wróci przy następnym połączeniu i spróbujemy znowu. */
    PONOW,

    /** Potwierdź mimo niepowodzenia. Koperta jest martwa i ma zniknąć z kolejki. */
    ODRZUC,
}

/**
 * Licznik nieudanych prób per koperta.
 *
 * Trzymany w pamięci, więc restart aplikacji zeruje próby. To celowe: po
 * restarcie warunki mogą być inne (doszedł brakujący commit), więc koperta
 * zasługuje na kolejne podejście.
 */
class LicznikProb {
    private val proby = mutableMapOf<Long, Int>()

    /**
     * Odnotowuje nieudane przetworzenie koperty i mówi, co dalej.
     *
     * Bez potwierdzenia koperta wraca przy **każdym** połączeniu. Koperta,
     * której nigdy nie da się przetworzyć — powtórzona ze skrzynki, z
     * nieaktualnej epoki, spreparowana przez kogoś z sieci — krążyłaby więc bez
     * końca. Po kilku próbach uznajemy ją za martwą i potwierdzamy.
     */
    fun poNiepowodzeniu(id: Long): Decyzja {
        val proba = (proby[id] ?: 0) + 1

        if (proba >= PROB_PRZED_ODRZUCENIEM) {
            proby.remove(id)
            return Decyzja.ODRZUC
        }

        proby[id] = proba
        return Decyzja.PONOW
    }

    /**
     * Kasuje licznik po udanym przetworzeniu.
     *
     * Bez tego koperta, która przeszła za drugim razem, zostawiałaby po sobie
     * wpis — a identyfikatory kolejki są nadawane po kolei, więc licznik rósłby
     * przez całe życie połączenia.
     */
    fun poSukcesie(id: Long) {
        proby.remove(id)
    }
}

/**
 * Przetwarza jedną ramkę i decyduje o potwierdzeniu.
 *
 * # Tu jest cała ostrożność tego modułu
 *
 * Potwierdzenie kasuje kopertę na serwerze. Dlatego pada **dopiero** po tym,
 * jak `przetworz` się powiodło — czyli gdy stan MLS jest już zapisany na dysku.
 * Potwierdzenie wcześniej gubi wiadomość bezpowrotnie: serwer ją usuwa, a
 * urządzenie po restarcie nie potrafi jej odtworzyć.
 *
 * Wydzielone z obsługi gniazda, bo to jedyne miejsce, w którym klient może
 * trwale stracić wiadomość albo zapętlić się na jednej kopercie — a wpisane
 * w środek `WebSocketListener` byłoby nietestowalne.
 */
suspend fun obsluzRamke(
    ramka: ByteArray,
    licznik: LicznikProb,
    przetworz: suspend (ByteArray) -> Unit,
    potwierdz: (Long) -> Unit,
) {
    val rozdzielona = rozdzielRamke(ramka) ?: return

    try {
        przetworz(rozdzielona.koperta)

        potwierdz(rozdzielona.id)
        licznik.poSukcesie(rozdzielona.id)
    } catch (anulowanie: CancellationException) {
        // Anulowanie korutyny NIE jest błędem koperty. Potraktowane jak
        // niepowodzenie podbijałoby licznik prób przy każdym zamknięciu
        // ekranu i po kilku razach potwierdziłoby — czyli skasowało — kopertę
        // zdrową, tylko nieprzetworzoną do końca.
        throw anulowanie
    } catch (blad: Exception) {
        // Nieudane przetworzenie koperty jest sytuacją SPODZIEWANĄ: powtórzenie
        // ze skrzynki, pakiet z nieaktualnej epoki, dane spreparowane przez
        // kogoś z sieci. Nie jest błędem do pokazania użytkownikowi.
        if (licznik.poNiepowodzeniu(rozdzielona.id) == Decyzja.ODRZUC) {
            potwierdz(rozdzielona.id)
        }
    }
}

/** Stan połączenia ze skrzynką — do pokazania użytkownikowi. */
enum class StanPolaczenia { LACZENIE, POLACZONE, ROZLACZONE }

/**
 * Trwałe połączenie ze skrzynką: podtrzymywane i wznawiane po zerwaniu.
 *
 * Bez podtrzymania bezczynne gniazdo jest zrywane po drodze, a bez wznawiania
 * nic go już nie przywraca — telefon po wyjściu z zasięgu przestawałby
 * odbierać do końca życia procesu.
 *
 * Odstęp między ponowieniami rośnie, żeby urządzenie bez sieci nie próbowało
 * w kółko co sekundę i nie zjadało baterii; jest ograniczony z góry, bo po
 * odzyskaniu zasięgu użytkownik ma zobaczyć wiadomości od razu, a nie po kilku
 * minutach.
 */
class PolaczenieZeSkrzynka(
    private val http: OkHttpClient,
    private val adres: String,
    /** Token dostępowy — serwer wpuszcza wyłącznie właściciela skrzynki. */
    private val token: String,
    private val naRamke: (ByteArray, (Long) -> Unit) -> Unit,
    private val naStan: (StanPolaczenia) -> Unit = {},
    private val zegar: ScheduledExecutorService =
        Executors.newSingleThreadScheduledExecutor { zadanie ->
            Thread(zadanie, "skrzynka").apply { isDaemon = true }
        },
) {
    private var gniazdo: WebSocket? = null
    private var ping: ScheduledFuture<*>? = null
    private var ponowienie: ScheduledFuture<*>? = null
    private var odstep = PONOWIENIE_MIN_MS

    @Volatile
    private var zamkniete = false

    fun polacz() {
        if (zamkniete) return

        naStan(StanPolaczenia.LACZENIE)
        // Token idzie podprotokołem, tak samo jak w przeglądarce — tam nie da
        // się dodać nagłówka `Authorization`, a serwer ma czytać jedno miejsce,
        // nie dwa. Bez tego serwer wpuszczał kogokolwiek do cudzej skrzynki.
        gniazdo = http.newWebSocket(
            Request.Builder()
                .url(adres)
                .header("Sec-WebSocket-Protocol", token)
                .build(),
            Nasluch(),
        )
    }

    /** Zamyka na stałe. Po tym nie ma już ponowień. */
    fun zamknij() {
        zamkniete = true
        zatrzymajPing()
        ponowienie?.cancel(false)
        ponowienie = null

        // 1000 = zamknięcie normalne. Zamykanie zamkniętego gniazda nie jest
        // błędem, więc wynik nas nie interesuje.
        gniazdo?.close(1000, null)
        gniazdo = null
        zegar.shutdownNow()
    }

    private fun zatrzymajPing() {
        ping?.cancel(false)
        ping = null
    }

    private fun zaplanujPonowienie() {
        if (zamkniete || ponowienie != null) return

        ponowienie = zegar.schedule(
            {
                ponowienie = null
                odstep = minOf(odstep * 2, PONOWIENIE_MAX_MS)
                polacz()
            },
            odstep,
            TimeUnit.MILLISECONDS,
        )
    }

    private inner class Nasluch : WebSocketListener() {
        override fun onOpen(webSocket: WebSocket, response: Response) {
            // Zerowanie odstępu dopiero po UDANYM połączeniu. Zerowane przy
            // próbie dawałoby stały, najkrótszy odstęp dokładnie wtedy, gdy
            // serwer odrzuca połączenia od razu — czyli gdy odczekanie jest
            // najbardziej potrzebne.
            odstep = PONOWIENIE_MIN_MS
            naStan(StanPolaczenia.POLACZONE)

            zatrzymajPing()
            ping = zegar.scheduleAtFixedRate(
                { runCatching { webSocket.send("ping") } },
                PING_MS,
                PING_MS,
                TimeUnit.MILLISECONDS,
            )
        }

        /** Tekst z serwera to wyłącznie `pong` — koperty idą binarnie. */
        override fun onMessage(webSocket: WebSocket, text: String) = Unit

        override fun onMessage(webSocket: WebSocket, bytes: ByteString) {
            naRamke(bytes.toByteArray()) { id ->
                // Potwierdzamy przez gniazdo, KTÓRE ramkę przyniosło. Wspólna
                // referencja trafiałaby po ponowieniu na gniazdo już zamknięte,
                // a koperta zostawałaby w kolejce na zawsze.
                runCatching { webSocket.send("ack:$id") }
            }
        }

        override fun onFailure(webSocket: WebSocket, t: Throwable, response: Response?) {
            zatrzymajPing()
            if (zamkniete) return
            naStan(StanPolaczenia.ROZLACZONE)
            zaplanujPonowienie()
        }

        override fun onClosed(webSocket: WebSocket, code: Int, reason: String) {
            zatrzymajPing()
            if (zamkniete) return
            naStan(StanPolaczenia.ROZLACZONE)
            zaplanujPonowienie()
        }
    }
}
