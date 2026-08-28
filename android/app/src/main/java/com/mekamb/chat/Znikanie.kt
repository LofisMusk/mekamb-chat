package com.mekamb.chat

import kotlinx.serialization.Serializable
import kotlinx.serialization.json.Json

/**
 * Znikające wiadomości — retencja lokalna per rozmowa.
 *
 * Ustawiasz na rozmowie czas, po którym jej wiadomości znikają z TEGO
 * urządzenia. Po jego upływie wiadomość jest usuwana z zaszyfrowanej historii.
 *
 * # Retencja lokalna, nie „zniknij drugiej stronie"
 *
 * Historia żyje wyłącznie na urządzeniu — serwer jej nie ma. Nie istnieje więc
 * miejsce, z którego dałoby się skasować wiadomość rozmówcy; każdy trzyma własną
 * kopię. „Znikanie" znaczy tu tyle, ile może: „nie przechowuj tego u mnie dłużej
 * niż X". Domyślnie wyłączone — rozmowa bez wpisu w tej mapie nie ma znikania.
 *
 * Odpowiednik `web/src/lib/znikanie.ts`.
 */

/** Wersja formatu zapisu. */
private const val WERSJA_ZNIKANIA = 1

@Serializable
private data class ZapisaneZnikanie(
    val wersja: Int = WERSJA_ZNIKANIA,
    /** `groupId` (hex) → ile sekund wiadomość ma przeżyć. */
    val rozmowy: Map<String, Long> = emptyMap(),
)

/** Jeden gotowy czas do wyboru w interfejsie. */
data class PresetZnikania(val sekundy: Long, val etykieta: String)

/** Gotowe długości do wyboru; „Własny" zostaje osobno w interfejsie. */
val PRESETY_ZNIKANIA = listOf(
    PresetZnikania(5 * 60, "5 minut"),
    PresetZnikania(60 * 60, "1 godzina"),
    PresetZnikania(8 * 60 * 60, "8 godzin"),
    PresetZnikania(24 * 60 * 60, "1 dzień"),
    PresetZnikania(7 * 24 * 60 * 60, "1 tydzień"),
    PresetZnikania(28 * 24 * 60 * 60, "4 tygodnie"),
)

/** Jednostki dla pola „własny czas". */
data class JednostkaZnikania(val mnoznik: Long, val etykieta: String)

val JEDNOSTKI_ZNIKANIA = listOf(
    JednostkaZnikania(60, "minut"),
    JednostkaZnikania(60 * 60, "godzin"),
    JednostkaZnikania(24 * 60 * 60, "dni"),
)

/** Ludzki opis długości znikania — do pokazania w panelu. */
fun opisZnikania(sekundy: Long): String {
    PRESETY_ZNIKANIA.firstOrNull { it.sekundy == sekundy }?.let { return it.etykieta }

    return when {
        sekundy % (24 * 60 * 60) == 0L -> {
            val dni = sekundy / (24 * 60 * 60)
            "$dni ${if (dni == 1L) "dzień" else "dni"}"
        }
        sekundy % (60 * 60) == 0L -> "${sekundy / (60 * 60)} godz."
        sekundy % 60 == 0L -> "${sekundy / 60} min"
        else -> "$sekundy s"
    }
}

/**
 * Ustawienia znikania w skarbcu.
 *
 * Wszystkie metody `@Synchronized` — cały zapis leży w jednym zaszyfrowanym
 * rekordzie, więc każda zmiana to odczyt-zmiana-zapis.
 */
class Znikanie(private val vault: Vault) {

    private val json = Json { ignoreUnknownKeys = true }

    /** Wczytuje ustawienia — do zasiania interfejsu przy starcie. */
    @Synchronized
    fun wczytaj(): Map<String, Long> {
        val surowe = vault.loadEphemeral() ?: return emptyMap()
        val zapis = runCatching { json.decodeFromString<ZapisaneZnikanie>(String(surowe)) }
            .getOrNull()
            ?: return emptyMap()
        if (zapis.wersja != WERSJA_ZNIKANIA) return emptyMap()
        return zapis.rozmowy
    }

    /**
     * Ustawia (albo wyłącza, przez `null`) znikanie dla jednej rozmowy.
     *
     * Wyłączenie kasuje wpis, a nie zapisuje zero: domyślny stan to brak wpisu,
     * a „0 s" udawałoby ustawienie i przycinanie brałoby je za „wszystko od razu".
     */
    @Synchronized
    fun ustaw(groupId: ByteArray, sekundy: Long?): Map<String, Long> {
        val klucz = Historia.klucz(groupId)
        val stan = wczytaj()
        val nowy = if (sekundy != null && sekundy > 0) stan + (klucz to sekundy) else stan - klucz
        zapisz(nowy)
        return nowy
    }

    /** Zapomina ustawienie przy usuwaniu rozmowy, żeby mapa nie puchła. */
    @Synchronized
    fun zapomnij(groupId: ByteArray): Map<String, Long> {
        val nowy = wczytaj() - Historia.klucz(groupId)
        zapisz(nowy)
        return nowy
    }

    private fun zapisz(rozmowy: Map<String, Long>) {
        val plik = ZapisaneZnikanie(wersja = WERSJA_ZNIKANIA, rozmowy = rozmowy)
        vault.saveEphemeral(json.encodeToString(plik).toByteArray())
    }

    companion object {
        /**
         * Zamienia ustawienia na mapę `klucz → najstarsza chwila do zachowania`.
         *
         * Wiadomość starsza niż zwrócona granica ma zostać usunięta. Czysta
         * względem zegara: `teraz` podaje wołający.
         */
        fun graniceOdciecia(stan: Map<String, Long>, teraz: Long): Map<String, Long> =
            stan.filterValues { it > 0 }.mapValues { (_, sekundy) -> teraz - sekundy * 1000 }
    }
}
