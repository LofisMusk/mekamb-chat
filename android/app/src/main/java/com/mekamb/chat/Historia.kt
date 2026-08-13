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

/**
 * Wersja formatu.
 *
 * 2 dołożyła nazwę rozmówcy, 3 znacznik przeczytania, 4 załącznik po tej
 * stronie, 5 identyfikator i stan wysyłki, 6 ślad po rozmowie A/V.
 * Numer był przy wersji 2 przez chwilę taki sam jak w kliencie
 * webowym mimo niezgodnego kształtu — przeniesienie konta między klientami
 * dałoby wtedy historię nie do odczytania. Każda zmiana układu idzie teraz po
 * obu stronach naraz.
 */
private const val WERSJA = 6

/**
 * Wersje, które umiemy wczytać.
 *
 * 3 różni się od 4 wyłącznie brakiem załącznika, 4 od 5 brakiem identyfikatora
 * wiadomości i stanu wysyłki, a 5 od 6 brakiem śladu po rozmowie A/V — każde
 * z tych pól jest opcjonalne i ma sensowną wartość domyślną, więc odczyt jest
 * bezstratny. Odrzucenie starszego zapisu byłoby
 * **skasowaniem historii użytkownika**, której serwer nie ma w kopii. Reguła
 * „numer odróżnia układy" zostaje; od odrzucania jest niezgodny układ, a nie
 * każdy inny numer.
 */
private val CZYTANE_WERSJE = setOf(3, 4, 5, WERSJA)

/**
 * Załącznik zapisany obok wiadomości.
 *
 * Kształt jest ten sam co w kliencie webowym (`historia.ts`): szyfrogram leży
 * na serwerze, a tutaj zostaje wyłącznie klucz do niego. Klucz i nonce jako
 * listy liczb, bo tak zapisuje je web — a zrzut przenoszenia konta wędruje
 * między klientami i musi się czytać po obu stronach.
 */
@Serializable
data class ZapisanyZalacznik(
    val blobId: String,
    val key: List<Int>,
    val nonce: List<Int>,
    val mimeType: String,
    val sizeBytes: Long,
    val fileName: String? = null,
)

/**
 * Załącznik w postaci używanej przez interfejs.
 *
 * `ByteArray` zamiast listy liczb, bo tak wygodniej go odszyfrować — konwersja
 * przy zapisie i odczycie jest ceną za zgodność z zapisem klienta webowego.
 */
data class Zalacznik(
    val blobId: String,
    val klucz: ByteArray,
    val nonce: ByteArray,
    val mimeType: String,
    val rozmiar: Long,
    val nazwaPliku: String? = null,
) {
    // ByteArray porównuje się przez referencję, więc data class wymaga tu
    // ręcznej roboty — bez tego dwa takie same załączniki są różne.
    override fun equals(other: Any?): Boolean =
        other is Zalacznik &&
            blobId == other.blobId &&
            klucz.contentEquals(other.klucz) &&
            nonce.contentEquals(other.nonce) &&
            mimeType == other.mimeType &&
            rozmiar == other.rozmiar &&
            nazwaPliku == other.nazwaPliku

    override fun hashCode(): Int = blobId.hashCode() * 31 + klucz.contentHashCode()

    fun doZapisu(): ZapisanyZalacznik = ZapisanyZalacznik(
        blobId = blobId,
        key = klucz.map { it.toInt() and 0xff },
        nonce = nonce.map { it.toInt() and 0xff },
        mimeType = mimeType,
        sizeBytes = rozmiar,
        fileName = nazwaPliku,
    )
}

fun ZapisanyZalacznik.doModelu(): Zalacznik = Zalacznik(
    blobId = blobId,
    klucz = ByteArray(key.size) { key[it].toByte() },
    nonce = ByteArray(nonce.size) { nonce[it].toByte() },
    mimeType = mimeType,
    rozmiar = sizeBytes,
    nazwaPliku = fileName,
)

/**
 * Ślad po rozmowie w postaci zapisywanej.
 *
 * Nazwy pól są DOKŁADNIE takie jak w `ZapisRozmowy` w `historia.ts` — zrzut
 * przeniesienia konta wędruje między klientami i rozjazd jednej nazwy dałby
 * po drugiej stronie rozmowę bez czasu trwania albo bez kierunku.
 */
@Serializable
private data class ZapisanaRozmowaAV(
    val wideo: Boolean = false,
    val sekundy: Long? = null,
    val wychodzaca: Boolean = false,
)

@Serializable
private data class ZapisanaWiadomosc(
    val autor: String,
    val tresc: String,
    val wlasna: Boolean,
    val czas: Long,
    val zalacznik: ZapisanyZalacznik? = null,
    /** Ślad po rozmowie A/V. Brak znaczy „to zwykła wiadomość". */
    val rozmowa: ZapisanaRozmowaAV? = null,
    /**
     * Identyfikator z protokołu, szesnastkowo.
     *
     * Potwierdzenia wskazują wiadomości właśnie po nim, więc musi przeżyć
     * zapis. Pusty w zapisach sprzed wersji 5 — takiej wiadomości żadne
     * potwierdzenie już nie dosięgnie i to jest w porządku: dotyczyłoby
     * rozmowy sprzed aktualizacji.
     */
    val id: String = "",
    /** Dokąd doszła własna wiadomość. Brak znaczy „wysłana". */
    val stan: StanWiadomosci? = null,
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
    /**
     * Czas ostatniej wiadomości, którą użytkownik widział.
     *
     * Znacznik czasu, a nie identyfikator ostatniej wiadomości: identyfikator
     * przestaje cokolwiek znaczyć, gdy ta wiadomość wypadnie poza limit
     * historii, a czas zostaje porównywalny zawsze.
     */
    val przeczytaneDo: Long? = null,
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
    /** Ile wiadomości przyszło od ostatniego zajrzenia. Własne się nie liczą. */
    val nieprzeczytane: Int = 0,
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
            ?.map {
                Wiadomosc(
                    autor = it.autor,
                    tresc = it.tresc,
                    wlasna = it.wlasna,
                    czas = it.czas,
                    zalacznik = it.zalacznik?.doModelu(),
                    rozmowa = it.rozmowa?.let { r ->
                        ZapisRozmowy(wideo = r.wideo, sekundy = r.sekundy, wychodzaca = r.wychodzaca)
                    },
                    id = it.id.zHex(),
                    stan = it.stan,
                )
            }
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
            .map {
                ZapisanaWiadomosc(
                    autor = it.autor,
                    tresc = it.tresc,
                    wlasna = it.wlasna,
                    czas = it.czas,
                    zalacznik = it.zalacznik?.doZapisu(),
                    rozmowa = it.rozmowa?.let { r ->
                        ZapisanaRozmowaAV(wideo = r.wideo, sekundy = r.sekundy, wychodzaca = r.wychodzaca)
                    },
                    id = it.id.hex(),
                    stan = it.stan,
                )
            }

        val klucz = klucz(groupId)
        val nowe = zapis.copy(
            rozmowy = zapis.rozmowy + (
                klucz to ZapisanaRozmowa(
                    rozmowca,
                    przyciete,
                    // Zapis nie jest przeczytaniem — znacznik zostaje taki, jaki był.
                    zapis.rozmowy[klucz]?.przeczytaneDo,
                )
                ),
        )
        vault.saveHistory(json.encodeToString(nowe).toByteArray())
    }

    /**
     * Oznacza rozmowę jako przeczytaną do podanej chwili.
     *
     * Wołane, gdy rozmowa jest otwarta na ekranie — czyli wtedy, gdy użytkownik
     * naprawdę na nią patrzy, a nie gdy wiadomość tylko dotarła.
     */
    fun oznaczPrzeczytane(groupId: ByteArray, doChwili: Long) {
        val zapis = wczytajWszystko()
        val klucz = klucz(groupId)
        val rozmowa = zapis.rozmowy[klucz] ?: return

        // Znacznik nie może się cofać: starsza chwila po nowszej znaczyłaby,
        // że przeczytane wiadomości wracają jako nieprzeczytane.
        if ((rozmowa.przeczytaneDo ?: 0L) >= doChwili) return

        val nowe = zapis.copy(
            rozmowy = zapis.rozmowy + (klucz to rozmowa.copy(przeczytaneDo = doChwili)),
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
                val doChwili = rozmowa.przeczytaneDo ?: 0L

                PozycjaListy(
                    groupId = zHex(hex),
                    rozmowca = rozmowa.rozmowca,
                    ostatnia = rozmowa.wiadomosci.lastOrNull()
                        ?.let { Wiadomosc(it.autor, it.tresc, it.wlasna, it.czas) },
                    // Własne wiadomości się nie liczą — nikt nie ma
                    // nieprzeczytanych wiadomości od samego siebie.
                    nieprzeczytane = rozmowa.wiadomosci.count { !it.wlasna && it.czas > doChwili },
                )
            }
            .sortedByDescending { it.ostatnia?.czas ?: 0L }

    private fun wczytajWszystko(): ZapisanaHistoria {
        val surowe = vault.loadHistory() ?: return ZapisanaHistoria()

        return runCatching {
            val zapis = json.decodeFromString<ZapisanaHistoria>(String(surowe))

            // Historia z UKŁADU, którego nie znamy, jest odrzucana w całości.
            // Próba odgadnięcia go dałaby rozmowy poprzestawiane w czasie —
            // gorsze niż pusty ekran, bo wygląda na prawdziwe. Wersje z listy
            // czytamy normalnie: różnią się polem, którego brak jest
            // nieodróżnialny od jego pustej wartości.
            if (zapis.wersja !in CZYTANE_WERSJE) ZapisanaHistoria() else zapis.copy(wersja = WERSJA)
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
