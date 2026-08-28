package com.mekamb.chat

import kotlinx.serialization.Serializable
import kotlinx.serialization.json.Json

/**
 * Prośby o rozmowę — zapora przed zalewem nieproszonych rozmów.
 *
 * # Reguła
 *
 * Rozmowa przychodząca przez **Welcome** od kogoś, z kim nie mamy jeszcze
 * zaakceptowanej rozmowy (nie jest naszym kontaktem), trafia do PRÓŚB, a nie
 * wprost na listę. Jeśli zaprasza kontakt — wchodzi od razu. Rozmowy, które
 * zakładamy sami, są zaakceptowane z definicji.
 *
 * # Jak to przechowujemy
 *
 * Nie „które są prośbami", tylko „które są ZAAKCEPTOWANE" — zbiór `groupId`
 * (hex). Rozmowa obecna w historii, ale spoza tego zbioru, jest prośbą.
 * Odwrotny zapis (zbiór próśb) wymagałby dopisywania każdej istniejącej
 * rozmowy przy wdrożeniu; ten sam efekt daje jednorazowe zasianie zbioru
 * wszystkimi dotychczasowymi rozmowami (patrz [zainicjuj]), po którym nowa
 * rozmowa spoza zbioru jest zawsze świeżą prośbą.
 *
 * # Dlaczego to jest LOKALNE
 *
 * „Kontakt" jest pojęciem tego urządzenia, nie faktem o grupie MLS. Odrzucenie
 * prośby jest opuszczeniem grupy w rdzeniu (`leave_conversation`) i skasowaniem
 * lokalnej historii — a stan akceptacji zostaje wyłącznie tutaj.
 *
 * Odpowiednik `web/src/lib/prosby.ts`.
 */

/** Stan próśb w postaci wygodnej dla interfejsu. */
data class StanProsb(
    /** `groupId` (hex) rozmów zaakceptowanych. */
    val zaakceptowane: Set<String> = emptySet(),
    /** Czy zbiór był już zasiany dotychczasowymi rozmowami. */
    val zainicjowano: Boolean = false,
)

/** Wersja formatu zapisu. */
private const val WERSJA_PROSB = 1

@Serializable
private data class ZapisaneProsby(
    val wersja: Int = WERSJA_PROSB,
    val zaakceptowane: List<String> = emptyList(),
    /**
     * Czy zbiór był już raz zasiany dotychczasowymi rozmowami.
     *
     * Bez tego pierwsze uruchomienie z tą funkcją uznałoby WSZYSTKIE istniejące
     * rozmowy za prośby — bo żadnej nie ma jeszcze w zbiorze.
     */
    val zainicjowano: Boolean = false,
)

/**
 * Prośby w skarbcu.
 *
 * Wszystkie metody `@Synchronized` na tej instancji — cały zapis leży w jednym
 * zaszyfrowanym rekordzie, więc każda zmiana to odczyt-zmiana-zapis.
 */
class Prosby(private val vault: Vault) {

    private val json = Json { ignoreUnknownKeys = true }

    /** Wczytuje stan — do zasiania interfejsu przy starcie. */
    @Synchronized
    fun wczytaj(): StanProsb {
        val surowe = vault.loadRequests() ?: return StanProsb()
        val zapis = runCatching { json.decodeFromString<ZapisaneProsby>(String(surowe)) }
            .getOrNull()
            ?: return StanProsb()
        if (zapis.wersja != WERSJA_PROSB) return StanProsb()
        return StanProsb(
            zaakceptowane = zapis.zaakceptowane.toSet(),
            zainicjowano = zapis.zainicjowano,
        )
    }

    /**
     * Zasiewa zbiór wszystkimi dotychczasowymi rozmowami — jednorazowo.
     *
     * Uruchamiane raz, przy pierwszym starcie z tą funkcją: bez tego każda
     * rozmowa sprzed wdrożenia próśb wyglądałaby jak prośba. Powtórne wywołanie
     * nic nie robi (`zainicjowano`), więc świeża rozmowa spoza zbioru jest już
     * prawdziwą prośbą.
     */
    @Synchronized
    fun zainicjuj(kluczeHex: List<String>): StanProsb {
        val stan = wczytaj()
        if (stan.zainicjowano) return stan

        val nowy = stan.copy(zaakceptowane = stan.zaakceptowane + kluczeHex, zainicjowano = true)
        zapisz(nowy)
        return nowy
    }

    /** Oznacza rozmowę jako zaakceptowaną. Zwraca świeży stan. */
    @Synchronized
    fun zaakceptuj(groupId: ByteArray): StanProsb {
        val stan = wczytaj()
        val nowy = stan.copy(zaakceptowane = stan.zaakceptowane + Historia.klucz(groupId))
        zapisz(nowy)
        return nowy
    }

    /**
     * Zapomina rozmowę ze zbioru zaakceptowanych.
     *
     * Wołane przy usuwaniu rozmowy, żeby po skasowaniu i ewentualnym ponownym
     * założeniu ta sama grupa nie została z „duchem" akceptacji — a przy
     * odrzuceniu prośby, żeby zbiór nie puchł o rozmowy, których już nie ma.
     */
    @Synchronized
    fun zapomnij(groupId: ByteArray): StanProsb {
        val stan = wczytaj()
        val nowy = stan.copy(zaakceptowane = stan.zaakceptowane - Historia.klucz(groupId))
        zapisz(nowy)
        return nowy
    }

    private fun zapisz(stan: StanProsb) {
        val plik = ZapisaneProsby(
            wersja = WERSJA_PROSB,
            zaakceptowane = stan.zaakceptowane.toList(),
            zainicjowano = stan.zainicjowano,
        )
        vault.saveRequests(json.encodeToString(plik).toByteArray())
    }
}
