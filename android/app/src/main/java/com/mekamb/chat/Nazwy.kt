package com.mekamb.chat

import kotlinx.serialization.Serializable
import kotlinx.serialization.json.Json

/**
 * Współdzielone nazwy: nazwa grupy i nick (nazwa wyświetlana) rozmówcy.
 *
 * # Dlaczego to jest WARSTWA WYŚWIETLANIA, a nie tożsamość
 *
 * Tożsamością w drzewie MLS i adresem skrzynki zostaje nazwa użytkownika
 * (`Account.userId` w `Vault.kt`). Nick i nazwa grupy nigdy nie służą do
 * routingu ani adresowania: koperta trafia pod nazwę użytkownika, a grupa jest
 * identyfikowana `groupId`. Ta mapa mówi wyłącznie, jak to NARYSOWAĆ — surowa
 * nazwa użytkownika zostaje pod spodem.
 *
 * # Skąd się biorą
 *
 * Z wiadomości aplikacyjnej MLS (`MetadataBody` w `proto/chat.proto`), tą samą
 * drogą co każda inna wiadomość — serwer widzi wyłącznie szyfrogram i nigdy nie
 * pozna, jak ktoś nazwał grupę ani siebie. Rdzeń wysyła je przez `sendMetadata`
 * (patrz `Messenger.kt`), a odbiera jako `IncomingEvent.Metadata`; spina to
 * `ChatViewModel`, a przechowuje ta klasa.
 *
 * # Pusty łańcuch znaczy „wyczyszczone"
 *
 * Rdzeń rozróżnia `null` („nie zmieniam tego pola") od `""` („czyszczę").
 * U nas czyszczenie to po prostu usunięcie wpisu — brak nicku jest
 * nieodróżnialny od nicku pustego, bo w obu przypadkach pokazujemy surową
 * nazwę użytkownika.
 *
 * Odpowiednik `web/src/lib/nazwy.ts`; rozjazd znaczyłby, że te same metadane
 * dają inne nazwy na dwóch platformach.
 */

/** Stan nazw w postaci wygodnej dla interfejsu. */
data class StanNazw(
    /** `groupId` (hex) → nazwa grupy. */
    val grupy: Map<String, String> = emptyMap(),
    /** nazwa użytkownika → nick. */
    val nicki: Map<String, String> = emptyMap(),
    /** Własny nick — pokazywany w Koncie i rozsyłany do rozmów. */
    val mojNick: String = "",
)

/** Wersja formatu zapisu — na wypadek zmiany kształtu w przyszłości. */
private const val WERSJA_NAZW = 1

@Serializable
private data class ZapisaneNazwy(
    val wersja: Int = WERSJA_NAZW,
    val grupy: Map<String, String> = emptyMap(),
    val nicki: Map<String, String> = emptyMap(),
    val mojNick: String = "",
)

/**
 * Nazwy w skarbcu.
 *
 * Osobna klasa, a nie metody na `Vault`: skarbiec ma trzymać bajty i nic nie
 * wiedzieć o tym, co w nich jest. Wszystkie metody są `@Synchronized` na tej
 * instancji, bo cały zapis leży w JEDNYM zaszyfrowanym rekordzie — dwie
 * metadane, które przyjdą tuż po sobie, czytałyby ten sam stan i druga
 * nadpisałaby pierwszą (ten sam problem, który `Historia` rozwiązuje zamkiem).
 */
class Nazwy(private val vault: Vault) {

    private val json = Json { ignoreUnknownKeys = true }

    /** Wczytuje całość — do zasiania stanu interfejsu przy starcie. */
    @Synchronized
    fun wczytaj(): StanNazw {
        val surowe = vault.loadNames() ?: return StanNazw()
        val zapis = runCatching { json.decodeFromString<ZapisaneNazwy>(String(surowe)) }
            .getOrNull()
            ?: return StanNazw()
        if (zapis.wersja != WERSJA_NAZW) return StanNazw()
        return StanNazw(grupy = zapis.grupy, nicki = zapis.nicki, mojNick = zapis.mojNick)
    }

    /**
     * Ustawia albo czyści nazwę grupy. Zwraca świeży, pełny stan.
     *
     * Pusta nazwa kasuje wpis: „bez nazwy" wraca do sklejanych nazw uczestników.
     */
    @Synchronized
    fun ustawNazweGrupy(groupId: ByteArray, nazwa: String?): StanNazw {
        val stan = wczytaj()
        val klucz = Historia.klucz(groupId)
        val grupy = stan.grupy.toMutableMap()

        if (!nazwa.isNullOrBlank()) grupy[klucz] = nazwa.trim() else grupy.remove(klucz)

        val nowy = stan.copy(grupy = grupy)
        zapisz(nowy)
        return nowy
    }

    /**
     * Ustawia albo czyści nick rozmówcy. Zwraca świeży, pełny stan.
     *
     * `username` to zawsze SUROWA nazwa użytkownika (tożsamość MLS) — nick jest
     * tylko wartością pod tym kluczem.
     */
    @Synchronized
    fun ustawNick(username: String, nick: String?): StanNazw {
        val stan = wczytaj()
        val nicki = stan.nicki.toMutableMap()

        if (!nick.isNullOrBlank()) nicki[username] = nick.trim() else nicki.remove(username)

        val nowy = stan.copy(nicki = nicki)
        zapisz(nowy)
        return nowy
    }

    /** Zapisuje własny nick — pokazywany w Koncie i rozsyłany do rozmów. */
    @Synchronized
    fun ustawMojNick(nick: String): StanNazw {
        val nowy = wczytaj().copy(mojNick = nick.trim())
        zapisz(nowy)
        return nowy
    }

    private fun zapisz(stan: StanNazw) {
        val plik = ZapisaneNazwy(
            wersja = WERSJA_NAZW,
            grupy = stan.grupy,
            nicki = stan.nicki,
            mojNick = stan.mojNick,
        )
        vault.saveNames(json.encodeToString(plik).toByteArray())
    }
}
