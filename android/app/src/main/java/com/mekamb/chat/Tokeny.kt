package com.mekamb.chat

import android.content.Context
import kotlinx.serialization.Serializable
import kotlinx.serialization.json.Json

/**
 * Portfel tokenów doręczeniowych.
 *
 * # Po co to jest
 *
 * Zostawienie koperty w cudzej skrzynce jest nieuwierzytelnione, bo serwer nie
 * ma się dowiadywać, kto do kogo pisze. Ceną było to, że nadawać może każdy —
 * więc każdy może zalewać cudzą skrzynkę. Token doręczeniowy dowodzi „mam prawo
 * nadać", nie mówiąc „jestem tym kontem".
 *
 * # Dlaczego zapas, a nie token na żądanie
 *
 * Bo pójście po token jest żądaniem **uwierzytelnionym** — serwer wiąże je
 * z kontem. Branie jednego przed każdą wiadomością dałoby mu ciąg „konto A
 * poprosiło o token, sekundę później ktoś nadał do skrzynki B", czyli dokładnie
 * to powiązanie, które ten schemat usuwa.
 *
 * # Dlaczego to nie leży w skarbcu
 *
 * Bo token nie jest sekretem tożsamości: jego utrata nie odsłania niczego,
 * a odzyskanie go nie daje dostępu do konta. Kosztuje jedno pobranie zapasu.
 *
 * Reguły są te same co w webie (`web/src/lib/tokeny.ts`), łącznie z progami.
 */

/** Ile bierzemy naraz. Serwer i tak nie wyda więcej na jedno żądanie. */
private const val ZAPAS_DOCELOWY = 50

/** Poniżej tego progu dobieramy. Zapas ma się kończyć przed, a nie w trakcie. */
private const val PROG_DOBRANIA = 10

@Serializable
data class TokenDoreczenia(val ziarno: String, val odslonione: String) {
    /**
     * Postać nagłówka `X-Delivery-Token`.
     *
     * Dwa pola rozdzielone kropką, tak jak czyta je serwer. Rozjazd tutaj znaczy
     * odrzucone nadanie z komunikatem, który niczego nie tłumaczy.
     */
    fun naglowek(): String = "$ziarno.$odslonione"
}

/**
 * Magazyn portfela.
 *
 * Wydzielony za interfejs, bo `SharedPreferences` nie istnieje poza Androidem,
 * a reguły portfela — wydawanie po jednym, brak powtórek, przypięcie klucza —
 * są dokładnie tym, co trzeba sprawdzić testem. Bez tego jedyna droga do nich
 * wiodłaby przez emulator.
 */
interface MagazynTokenow {
    fun odczytaj(klucz: String): String?
    fun zapisz(klucz: String, wartosc: String)
}

/** Magazyn oparty o `SharedPreferences`. Token nie jest sekretem tożsamości. */
class MagazynWPreferencjach(context: Context) : MagazynTokenow {
    private val prefs = context.getSharedPreferences("mekamb.tokeny", Context.MODE_PRIVATE)

    override fun odczytaj(klucz: String): String? = prefs.getString(klucz, null)

    override fun zapisz(klucz: String, wartosc: String) {
        prefs.edit().putString(klucz, wartosc).apply()
    }
}

class PortfelTokenow(private val magazyn: MagazynTokenow) {

    private val json = Json { ignoreUnknownKeys = true }

    private fun wczytaj(): MutableList<TokenDoreczenia> {
        val surowe = magazyn.odczytaj(KLUCZ_ZAPAS) ?: return mutableListOf()

        // Uszkodzony zapis znaczy pusty zapas — dobierzemy nowy. Token jest
        // wygodą, nie danymi, więc nie ma tu czego ratować.
        return runCatching { json.decodeFromString<List<TokenDoreczenia>>(surowe).toMutableList() }
            .getOrElse { mutableListOf() }
    }

    private fun zapisz(tokeny: List<TokenDoreczenia>) {
        magazyn.zapisz(KLUCZ_ZAPAS, json.encodeToString(tokeny))
    }

    /** Ile tokenów zostało. */
    fun ile(): Int = wczytaj().size

    /**
     * Wyjmuje jeden token z zapasu.
     *
     * `null` znaczy pusty zapas — wołający ma wtedy nadać BEZ tokenu. To celowe:
     * dopóki serwer tokenów nie wymusza, brak zapasu nie może blokować
     * wysyłania. Wiadomość jest ważniejsza niż limit nadużyć.
     */
    @Synchronized
    fun wez(): TokenDoreczenia? {
        val zapas = wczytaj()
        if (zapas.isEmpty()) return null

        // `removeAt(0)`, a nie `removeFirstOrNull()`: to drugie koliduje
        // z `SequencedCollection` na nowszych JDK i wywala się dopiero
        // w czasie działania, na urządzeniu.
        val token = zapas.removeAt(0)
        zapisz(zapas)
        return token
    }

    /** Czy warto już dobrać zapas. */
    fun trzebaDobrac(): Boolean = ile() <= PROG_DOBRANIA

    /**
     * Dokłada świeżo wydane tokeny do zapasu.
     *
     * Osobno od pobierania, bo sama wymiana z serwerem jest zadaniem `Api`,
     * a ta klasa ma być sprawdzalna bez sieci.
     */
    @Synchronized
    fun doloz(nowe: List<TokenDoreczenia>) {
        if (nowe.isEmpty()) return
        zapisz(wczytaj() + nowe)
    }

    /**
     * Przypina klucz wydawania przy pierwszym pobraniu.
     *
     * Serwer, który wydaje różnym osobom tokeny różnymi kluczami, ZNAKUJE je —
     * przy nadaniu rozpoznaje, czyj był token. Dowód w `tokenOdslon` wykrywa
     * użycie innego klucza niż podany, ale nie wykryje, że sam klucz jest
     * podstawiony pod nas. Przypięcie zamienia atak z niewidocznego w taki,
     * który wymaga zmiany klucza u wszystkich naraz.
     *
     * Zwraca `false`, gdy klucz się zmienił — wołający ma wtedy nie brać tokenów.
     */
    fun przypnijKlucz(kluczPubliczny: String): Boolean {
        val przypiety = magazyn.odczytaj(KLUCZ_PUBLICZNY)

        if (przypiety == null) {
            magazyn.zapisz(KLUCZ_PUBLICZNY, kluczPubliczny)
            return true
        }

        return przypiety == kluczPubliczny
    }

    companion object {
        private const val KLUCZ_ZAPAS = "zapas"
        private const val KLUCZ_PUBLICZNY = "klucz"

        /** Ile prosić naraz. Wystawione, żeby test i `Api` widziały tę samą liczbę. */
        const val DOCELOWY = ZAPAS_DOCELOWY
    }
}
