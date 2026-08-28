package com.mekamb.chat

import kotlinx.serialization.Serializable
import kotlinx.serialization.json.Json

/**
 * Zablokowani użytkownicy — zapora silniejsza niż prośba o rozmowę.
 *
 * # Czym różni się od próśb
 *
 * Prośba mówi „nie wpuszczaj tej rozmowy między prawdziwe, dopóki jej nie
 * przyjmę". Blokada mówi „nie chcę od tej osoby NICZEGO": jej wiadomości nie
 * dopisują się do żadnej rozmowy, jej zaproszenia (Welcome) nie zakładają nawet
 * prośby, a rozmowy jeden-na-jeden z nią znikają z listy.
 *
 * # Dlaczego to jest LOKALNE i egzekwowane po odbiorze
 *
 * Serwer nie może wiedzieć, kogo blokujesz — depozyt do skrzynki nie niesie
 * tożsamości nadawcy, więc nie da się mu powiedzieć „odrzucaj od tej osoby".
 * Blokada działa więc na TYM urządzeniu: kopertę i tak odbieramy i
 * odszyfrowujemy (żeby poznać nadawcę z credentiala MLS — jedynego wiarygodnego
 * źródła), ale nadawcę zablokowanego pomijamy. Blokujemy po **nazwie
 * użytkownika**, bo to ona jest tożsamością MLS, a nie po nicku, który jest
 * tylko warstwą wyświetlania.
 *
 * Odpowiednik `web/src/lib/blokady.ts`.
 */

/** Wersja formatu zapisu. */
private const val WERSJA_BLOKAD = 1

@Serializable
private data class ZapisaneBlokady(
    val wersja: Int = WERSJA_BLOKAD,
    /** Nazwy użytkowników (nie nicki), które są zablokowane. */
    val zablokowani: List<String> = emptyList(),
)

/**
 * Blokady w skarbcu.
 *
 * Wszystkie metody `@Synchronized` — cały zapis leży w jednym zaszyfrowanym
 * rekordzie, więc każda zmiana to odczyt-zmiana-zapis.
 */
class Blokady(private val vault: Vault) {

    private val json = Json { ignoreUnknownKeys = true }

    /** Wczytuje zbiór zablokowanych — do zasiania interfejsu przy starcie. */
    @Synchronized
    fun wczytaj(): Set<String> {
        val surowe = vault.loadBlocked() ?: return emptySet()
        val zapis = runCatching { json.decodeFromString<ZapisaneBlokady>(String(surowe)) }
            .getOrNull()
            ?: return emptySet()
        if (zapis.wersja != WERSJA_BLOKAD) return emptySet()
        return zapis.zablokowani.toSet()
    }

    /** Blokuje użytkownika po nazwie. Zwraca świeży zbiór. */
    @Synchronized
    fun zablokuj(username: String): Set<String> {
        val nowy = wczytaj() + username
        zapisz(nowy)
        return nowy
    }

    /** Odblokowuje użytkownika. Zwraca świeży zbiór. */
    @Synchronized
    fun odblokuj(username: String): Set<String> {
        val nowy = wczytaj() - username
        zapisz(nowy)
        return nowy
    }

    private fun zapisz(zablokowani: Set<String>) {
        val plik = ZapisaneBlokady(wersja = WERSJA_BLOKAD, zablokowani = zablokowani.toList())
        vault.saveBlocked(json.encodeToString(plik).toByteArray())
    }
}
