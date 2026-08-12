package com.mekamb.chat

import android.content.Context
import kotlin.random.Random

/**
 * Zbieranie i opóźnianie potwierdzeń.
 *
 * # Dlaczego to nie leci od razu
 *
 * Potwierdzenie jest zaszyfrowane kanałem MLS, więc serwer nie wie, CO to jest.
 * Ale wie, KIEDY poszło — a potwierdzenie odczytu wysłane natychmiast po
 * przeczytaniu jest odczytywalne z samego ruchu: „urządzenie B nadało kopertę
 * cztery sekundy po wiadomości od A". To dokładnie ta informacja, której nie
 * chcemy oddawać, i której zaszyfrowanie treści nie ukrywa.
 *
 * Dlatego potwierdzenia są **zbierane** i wysyłane paczką po **losowym**
 * opóźnieniu. Losowym, nie stałym: stałe pięć sekund to tylko przesunięcie
 * korelacji o pięć sekund, a nie jej zerwanie.
 *
 * Ceną jest ptaszek pojawiający się z opóźnieniem. To widać i jest zamierzone —
 * interfejs nie udaje, że wiemy więcej, niż wiemy.
 *
 * Reguły są te same co w webie (`web/src/lib/potwierdzenia.ts`), łącznie
 * z granicami opóźnienia. Rozjazd znaczyłby, że jedna platforma ujawnia więcej
 * niż druga przy tej samej obietnicy w interfejsie.
 */

/** Dolna i górna granica opóźnienia. Górna z decyzji: do 30 sekund. */
private const val MIN_OPOZNIENIE_MS = 3_000L
private const val MAX_OPOZNIENIE_MS = 30_000L

/** Losuje opóźnienie z przedziału. Wydzielone, żeby dało się je sprawdzić testem. */
fun losoweOpoznienie(los: Random = Random.Default): Long =
    MIN_OPOZNIENIE_MS + los.nextLong(MAX_OPOZNIENIE_MS - MIN_OPOZNIENIE_MS)

/** Stan wysyłki własnej wiadomości. Rośnie tylko w jedną stronę. */
enum class StanWiadomosci {
    WYSLANE,
    DOSTARCZONE,
    PRZECZYTANE;

    /**
     * Wyższy z dwóch stanów.
     *
     * Potwierdzenia idą przez skrzynkę i mogą dotrzeć w odwrotnej kolejności —
     * bez tej reguły „przeczytane" cofałoby się do „dostarczone", gdy spóźniona
     * paczka dotarła po tej nowszej. Na oczach użytkownika.
     */
    fun wyzszy(inny: StanWiadomosci): StanWiadomosci =
        if (inny.ordinal > ordinal) inny else this
}

/** Paczka gotowa do wysłania: jedna rozmowa, jeden rodzaj, wiele wiadomości. */
data class PaczkaPotwierdzen(
    val groupId: ByteArray,
    val rodzaj: uniffi.mekamb_ffi.ReceiptKind,
    val identyfikatory: List<ByteArray>,
) {
    // `ByteArray` porównuje się przez referencję, a ta klasa trafia do list
    // porównywanych w testach — bez tego równość znaczyłaby „ten sam obiekt".
    override fun equals(other: Any?): Boolean {
        if (this === other) return true
        if (other !is PaczkaPotwierdzen) return false
        return groupId.contentEquals(other.groupId) &&
            rodzaj == other.rodzaj &&
            identyfikatory.size == other.identyfikatory.size &&
            identyfikatory.zip(other.identyfikatory).all { (a, b) -> a.contentEquals(b) }
    }

    override fun hashCode(): Int =
        31 * groupId.contentHashCode() + rodzaj.hashCode()
}

/**
 * Zbieracz potwierdzeń.
 *
 * Czysty: nic nie wysyła i nie zna czasu. Trzyma, co się nazbierało, i oddaje
 * to na żądanie. Dzięki temu reguły — a jest ich kilka i każda ma powód — dają
 * się sprawdzić bez zegara i bez sieci.
 */
class ZbieraczPotwierdzen {

    /** Klucz rozmowy → rodzaj → identyfikatory (szesnastkowo, żeby dały się porównać). */
    private val oczekujace = linkedMapOf<String, LinkedHashMap<uniffi.mekamb_ffi.ReceiptKind, LinkedHashSet<String>>>()
    private val grupy = mutableMapOf<String, ByteArray>()

    /**
     * Dokłada potwierdzenie.
     *
     * `PRZECZYTANE` pochłania `DOSTARCZONE` dla tej samej wiadomości: odczyt
     * mówi wszystko, co powiedziałoby dostarczenie, więc wysyłanie obu byłoby
     * drugą kopertą bez nowej treści — a każda koperta to sygnał w ruchu.
     */
    fun dodaj(groupId: ByteArray, rodzaj: uniffi.mekamb_ffi.ReceiptKind, identyfikator: ByteArray) {
        val klucz = groupId.hex()
        grupy[klucz] = groupId

        val rozmowa = oczekujace.getOrPut(klucz) { linkedMapOf() }
        val id = identyfikator.hex()

        if (rodzaj == uniffi.mekamb_ffi.ReceiptKind.READ) {
            rozmowa[uniffi.mekamb_ffi.ReceiptKind.DELIVERED]?.remove(id)
        } else if (rozmowa[uniffi.mekamb_ffi.ReceiptKind.READ]?.contains(id) == true) {
            // Dostarczenie po odczycie nie wnosi nic — odczyt już to zawiera.
            return
        }

        rozmowa.getOrPut(rodzaj) { linkedSetOf() }.add(id)
    }

    /** Czy jest co wysyłać. */
    fun pusty(): Boolean = oczekujace.values.all { rozmowa -> rozmowa.values.all { it.isEmpty() } }

    /**
     * Zabiera wszystko, co się nazbierało, i czyści zbieracz.
     *
     * Zabranie, a nie odczyt: gdyby czyszczenie było osobnym krokiem, nieudana
     * wysyłka zostawiłaby potwierdzenia wysyłane w kółko.
     */
    fun zabierz(): List<PaczkaPotwierdzen> {
        val paczki = mutableListOf<PaczkaPotwierdzen>()

        for ((klucz, rozmowa) in oczekujace) {
            val groupId = grupy[klucz] ?: continue
            for ((rodzaj, zbior) in rozmowa) {
                if (zbior.isEmpty()) continue
                paczki += PaczkaPotwierdzen(groupId, rodzaj, zbior.map { it.zHex() })
            }
        }

        oczekujace.clear()
        return paczki
    }
}

/** Bajty jako tekst szesnastkowy — potrzebne, bo `ByteArray` nie nadaje się na klucz. */
internal fun ByteArray.hex(): String = joinToString("") { "%02x".format(it) }

internal fun String.zHex(): ByteArray =
    ByteArray(length / 2) { substring(it * 2, it * 2 + 2).toInt(16).toByte() }

/**
 * Czy wysyłamy potwierdzenia odczytu.
 *
 * # Dlaczego to nie jedzie na serwer
 *
 * Bo serwer nie ma prawa wiedzieć, czy wysyłasz potwierdzenia odczytu — sama
 * ta informacja jest metadaną o Tobie. Ustawienie dotyczy tego urządzenia
 * i nigdzie się nie zgłasza.
 *
 * **Wyłączenie działa w obie strony**: nie wysyłamy i nie pokazujemy cudzych.
 * To decyzja lokalna, nie wymuszona protokołem — druga strona nadal może
 * potwierdzenia wysyłać, my ich po prostu nie użyjemy. Pokazywanie cudzych
 * odczytów komuś, kto własnych nie oddaje, byłoby jednostronną wymianą.
 */
object PotwierdzeniaOdczytu {

    private const val PLIK = "mekamb.prywatnosc"
    private const val KLUCZ = "odczyt"

    fun wlaczone(context: Context): Boolean =
        context.getSharedPreferences(PLIK, Context.MODE_PRIVATE).getBoolean(KLUCZ, true)

    fun ustaw(context: Context, wlaczone: Boolean) {
        context.getSharedPreferences(PLIK, Context.MODE_PRIVATE)
            .edit()
            .putBoolean(KLUCZ, wlaczone)
            .apply()
    }
}
