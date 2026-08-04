package com.mekamb.chat

import kotlinx.serialization.Serializable
import kotlinx.serialization.json.Json

/**
 * Historia rozmów na urządzeniu.
 *
 * # Czemu to musiało powstać
 *
 * Wiadomości żyły wyłącznie w pamięci modelu i znikały razem z procesem.
 * Zamknięcie aplikacji kasowało rozmowę, a lista rozmów nie miała z czego
 * powstać — pokazywała najwyżej tę jedną, którą akurat otwarto.
 *
 * Klient webowy dostał to wcześniej (`web/src/lib/historia.ts`); tu jest to
 * samo, na skarbcu chronionym kluczem z Android Keystore.
 *
 * # Czego to nie zmienia
 *
 * Historia zostaje **wyłącznie tutaj**. Serwer jej nie ma i nigdy nie będzie
 * miał — utrata wszystkich urządzeń nadal oznacza utratę rozmów. To założenie
 * z pierwszego dnia, nie niedopatrzenie.
 */

/**
 * Ile wiadomości trzymamy na rozmowę.
 *
 * Cały rekord jest szyfrowany przy każdym zapisie, więc nieograniczona
 * historia zamieniłaby dopisanie jednej wiadomości w rosnący bez końca koszt.
 */
private const val LIMIT_WIADOMOSCI = 500

/** Wersja formatu. Zmiana układu pól wymaga podniesienia. */
private const val WERSJA = 1

@Serializable
private data class ZapisanaWiadomosc(
    val autor: String,
    val tresc: String,
    val wlasna: Boolean,
    val czas: Long,
)

/**
 * Zapisana rozmowa.
 *
 * Nazwa rozmówcy leży obok wiadomości, bo z samego identyfikatora grupy nie da
 * się jej odtworzyć — a lista rozmów musi wiedzieć, kogo pokazać, zanim
 * cokolwiek odszyfruje.
 */
@Serializable
private data class ZapisanaRozmowa(
    val rozmowca: String,
    val wiadomosci: List<ZapisanaWiadomosc> = emptyList(),
)

@Serializable
private data class ZapisanaHistoria(
    val wersja: Int = WERSJA,
    /** Klucz to identyfikator rozmowy zapisany szesnastkowo. */
    val rozmowy: Map<String, ZapisanaRozmowa> = emptyMap(),
)

/** Rozmowa w postaci potrzebnej liście. */
data class PozycjaListy(
    val groupId: ByteArray,
    val rozmowca: String,
    val ostatnia: Wiadomosc?,
) {
    // ByteArray porównuje się przez referencję, więc data class wymaga tu
    // ręcznej roboty. Bez tego dwie takie same pozycje byłyby różne.
    override fun equals(other: Any?): Boolean =
        other is PozycjaListy &&
            groupId.contentEquals(other.groupId) &&
            rozmowca == other.rozmowca &&
            ostatnia == other.ostatnia

    override fun hashCode(): Int = groupId.contentHashCode() * 31 + rozmowca.hashCode()
}

/**
 * Historia w skarbcu.
 *
 * Osobna klasa, a nie metody na `Vault`: skarbiec ma trzymać bajty i nic nie
 * wiedzieć o tym, co w nich jest.
 */
class Historia(private val vault: Vault) {

    private val json = Json { ignoreUnknownKeys = true }

    /** Wczytuje historię jednej rozmowy. */
    fun wczytaj(groupId: ByteArray): List<Wiadomosc> =
        wczytajWszystko().rozmowy[klucz(groupId)]
            ?.wiadomosci
            ?.map { Wiadomosc(it.autor, it.tresc, it.wlasna, it.czas) }
            ?: emptyList()

    /** Z kim była ta rozmowa. */
    fun rozmowca(groupId: ByteArray): String? =
        wczytajWszystko().rozmowy[klucz(groupId)]?.rozmowca

    /**
     * Zapisuje historię jednej rozmowy, nie ruszając pozostałych.
     *
     * Odczyt przed zapisem jest konieczny: wszystkie rozmowy leżą w jednym
     * zaszyfrowanym rekordzie, więc zapis samej bieżącej skasowałby resztę.
     */
    fun zapisz(groupId: ByteArray, rozmowca: String, wiadomosci: List<Wiadomosc>) {
        val zapis = wczytajWszystko()

        // Obcinamy od początku — najstarsze idą pierwsze.
        val przyciete = wiadomosci.takeLast(LIMIT_WIADOMOSCI)
            .map { ZapisanaWiadomosc(it.autor, it.tresc, it.wlasna, it.czas) }

        val nowe = zapis.copy(
            rozmowy = zapis.rozmowy + (klucz(groupId) to ZapisanaRozmowa(rozmowca, przyciete)),
        )
        vault.saveHistory(json.encodeToString(nowe).toByteArray())
    }

    /**
     * Wszystkie rozmowy, od najświeższej.
     *
     * Kolejność po czasie ostatniej wiadomości, a nie po nazwie: lista ma
     * pokazywać to, do czego wraca się najczęściej.
     */
    fun lista(): List<PozycjaListy> =
        wczytajWszystko().rozmowy
            .map { (hex, rozmowa) ->
                PozycjaListy(
                    groupId = zHex(hex),
                    rozmowca = rozmowa.rozmowca,
                    ostatnia = rozmowa.wiadomosci.lastOrNull()
                        ?.let { Wiadomosc(it.autor, it.tresc, it.wlasna, it.czas) },
                )
            }
            .sortedByDescending { it.ostatnia?.czas ?: 0L }

    private fun wczytajWszystko(): ZapisanaHistoria {
        val surowe = vault.loadHistory() ?: return ZapisanaHistoria()

        return runCatching {
            val zapis = json.decodeFromString<ZapisanaHistoria>(String(surowe))

            // Historia z innej wersji formatu jest odrzucana w całości. Próba
            // odgadnięcia starego układu dałaby rozmowy poprzestawiane
            // w czasie — gorsze niż pusty ekran, bo wygląda na prawdziwe.
            if (zapis.wersja != WERSJA) ZapisanaHistoria() else zapis
        }.getOrElse { ZapisanaHistoria() }
    }

    companion object {
        /** Identyfikator rozmowy jako tekst — `ByteArray` nie nadaje się na klucz. */
        fun klucz(groupId: ByteArray): String =
            groupId.joinToString("") { "%02x".format(it) }

        private fun zHex(hex: String): ByteArray =
            ByteArray(hex.length / 2) { hex.substring(it * 2, it * 2 + 2).toInt(16).toByte() }
    }
}
