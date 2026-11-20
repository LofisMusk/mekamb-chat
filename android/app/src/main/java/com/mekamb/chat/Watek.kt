package com.mekamb.chat

import java.text.SimpleDateFormat
import java.util.Calendar
import java.util.Date
import java.util.Locale

/**
 * Układ wątku: rozdzielacze czasu i sklejanie wiadomości w bloki.
 *
 * # Dlaczego to jest czystą funkcją, a nie warunkiem w składaniu ekranu
 *
 * Bo obie decyzje są o SĄSIEDZTWIE — „czy poprzednia wiadomość była tego samego
 * dnia", „czy pisała ją ta sama osoba w podobnym czasie". Warunek rozsypany po
 * `LazyColumn` sięga do elementu o indeks niżej w kilku miejscach i przy
 * pierwszej zmianie sortowania zaczyna kłamać w jednym z nich.
 *
 * # Dlaczego reguły są przepisane, a nie wymyślone na nowo
 *
 * Web ma to samo w `web/src/lib/watek.ts` i te same progi. Rozjazd znaczyłby,
 * że ta sama rozmowa czytana na telefonie i w przeglądarce ma inne rozdzielacze
 * i inne bloki — a użytkownik zapamiętuje kształt rozmowy, nie tylko treść.
 * `WatekTest` pilnuje reguł po tej stronie.
 */

/** Ile czasu między wiadomościami tej samej osoby zrywa blok. */
const val PRZERWA_BLOKU_MS = 5 * 60 * 1000L

/**
 * Ile ciszy stawia nowy rozdzielacz z godziną.
 *
 * # Dlaczego godzina wyszła z dymka
 *
 * Miała ją KAŻDA wiadomość, w stopce, przy własnej krawędzi. Przy rozmowie
 * pisanej seriami po kilka zdań dawało to kolumnę powtórzonych „21:14, 21:14,
 * 21:15" — informację, o którą nikt nie pytał, płaconą drugim wierszem w każdym
 * dymku. Pytanie „o której to było" zadaje się raz na wątek ciszy, a nie raz na
 * zdanie: rozdzielacz stoi przy zmianie dnia i po godzinie przerwy.
 */
const val PRZERWA_ROZDZIELACZA_MS = 60 * 60 * 1000L

sealed interface PozycjaWatku {
    /** Klucz stabilny między złożeniami — `LazyColumn` bez niego gubi pozycję. */
    val klucz: String

    /** Wyśrodkowany rozdzielacz: „Dziś 08:42". */
    data class Rozdzielacz(override val klucz: String, val etykieta: String, val czas: Long) : PozycjaWatku

    data class Dymek(
        override val klucz: String,
        val wiadomosc: Wiadomosc,
        /** Kolejna wiadomość tego samego bloku — ciaśniejszy odstęp nad nią, bez autora. */
        val ciag: Boolean,
        /** Ostatnia wiadomość bloku — tylko ona dostaje ogon dymka. */
        val ogon: Boolean = true,
        /** Ostatnia własna wiadomość wątku — pod nią stoi stan wysyłki słowem. */
        val ostatniaWlasna: Boolean = false,
    ) : PozycjaWatku
}

/** Dzień jako `RRRR-DDD` w strefie urządzenia — klucz do porównań. */
private fun dzien(czas: Long): String {
    val kalendarz = Calendar.getInstance().apply { timeInMillis = czas }
    return "${kalendarz.get(Calendar.YEAR)}-${kalendarz.get(Calendar.DAY_OF_YEAR)}"
}

private fun rok(czas: Long): Int =
    Calendar.getInstance().apply { timeInMillis = czas }.get(Calendar.YEAR)

/**
 * Etykieta rozdzielacza.
 *
 * „Dziś" i „Wczoraj" słowem, nie datą: przy rozmowie sprzed godziny data jest
 * odpowiedzią na pytanie, którego nikt nie zadał. Rok dopisujemy dopiero, gdy
 * wiadomość jest z innego roku. Nazwa miesiąca idzie za językiem interfejsu,
 * nie za ustawieniem telefonu — inaczej angielski interfejs pisałby „14 marca".
 */
fun etykietaDnia(czas: Long, teraz: Long, jezyk: Jezyk = Jezyk.PL): String {
    val wczoraj = teraz - 24 * 60 * 60 * 1000L

    return when (dzien(czas)) {
        dzien(teraz) -> t(jezyk, "Dziś", "Today")
        dzien(wczoraj) -> t(jezyk, "Wczoraj", "Yesterday")
        else -> {
            val tenRok = rok(czas) == rok(teraz)
            val (wzor, lokalizacja) = when (jezyk) {
                Jezyk.PL -> (if (tenRok) "d MMMM" else "d MMMM yyyy") to Locale.forLanguageTag("pl")
                Jezyk.EN -> (if (tenRok) "MMMM d" else "MMMM d, yyyy") to Locale.ENGLISH
            }
            SimpleDateFormat(wzor, lokalizacja).format(Date(czas))
        }
    }
}

/**
 * Układa wątek.
 *
 * Blok zrywa: rozdzielacz, zmiana strony dymka, zmiana autora i przerwa dłuższa
 * niż [PRZERWA_BLOKU_MS]. Ostatni warunek jest istotny — bez niego dwie
 * wiadomości tej samej osoby wysłane rano i wieczorem sklejałyby się w jeden
 * blok, choć dzieli je pół dnia.
 *
 * `ogon` i `ostatniaWlasna` są o tym, co stoi PO wiadomości, więc wypełnia je
 * przebieg wsteczny na końcu — tak samo jak na webie.
 */
fun ulozWatek(wiadomosci: List<Wiadomosc>, teraz: Long, jezyk: Jezyk = Jezyk.PL): List<PozycjaWatku> {
    val uklad = mutableListOf<PozycjaWatku>()
    var poprzednia: Wiadomosc? = null

    wiadomosci.forEachIndexed { i, wiadomosc ->
        val nowyDzien = poprzednia == null || dzien(poprzednia.czas) != dzien(wiadomosc.czas)
        val cisza = poprzednia != null && wiadomosc.czas - poprzednia.czas >= PRZERWA_ROZDZIELACZA_MS

        if (nowyDzien || cisza) {
            uklad += PozycjaWatku.Rozdzielacz(
                // Czas w kluczu, bo w jednym dniu rozdzielaczy może być kilka —
                // sama data dawałaby duplikaty kluczy w `LazyColumn`.
                klucz = "rozdzielacz-${wiadomosc.czas}-$i",
                etykieta = etykietaDnia(wiadomosc.czas, teraz, jezyk),
                czas = wiadomosc.czas,
            )
        }

        /*
         * Ślad po rozmowie A/V nie należy do żadnego bloku — z żadnej strony.
         *
         * Rysuje się na środku, jak rozdzielacz, więc sklejenie go z sąsiadem
         * zabierało ogon dymkowi stojącemu nad nim: blok kończył się wizualnie
         * na czymś, co nie jest dymkiem, i ostatnie zdanie wyglądało na urwane.
         */
        val ciag = !nowyDzien &&
            !cisza &&
            poprzednia.rozmowa == null &&
            wiadomosc.rozmowa == null &&
            poprzednia.wlasna == wiadomosc.wlasna &&
            poprzednia.autor == wiadomosc.autor &&
            wiadomosc.czas - poprzednia.czas < PRZERWA_BLOKU_MS

        // Wiadomości nie mają własnego identyfikatora po tej stronie (zapisy
        // sprzed wersji 5 historii mają pusty `id`), a treść i czas potrafią się
        // powtórzyć. Indeks jest tu jedynym kluczem, który na pewno nie
        // kolejkuje dwóch dymków pod jednym.
        uklad += PozycjaWatku.Dymek(klucz = "w-$i", wiadomosc = wiadomosc, ciag = ciag)
        poprzednia = wiadomosc
    }

    /*
     * Ogon ma OSTATNI dymek bloku, nie pierwszy.
     *
     * Ogon jest znakiem „ktoś to powiedział" — postawiony przy każdym dymku serii
     * daje trzy ogony pod rzędem i seria przestaje czytać się jak jedna
     * wypowiedź. Blok kończy się tam, gdzie następna pozycja nie jest już jego
     * ciągiem: przy rozdzielaczu, przy zmianie strony i na końcu listy.
     */
    var znalezionaWlasna = false
    for (i in uklad.indices.reversed()) {
        val pozycja = uklad[i] as? PozycjaWatku.Dymek ?: continue
        val nastepna = uklad.getOrNull(i + 1)
        val ogon = nastepna !is PozycjaWatku.Dymek || !nastepna.ciag

        val ostatniaWlasna = !znalezionaWlasna && pozycja.wiadomosc.wlasna && pozycja.wiadomosc.rozmowa == null
        if (ostatniaWlasna) znalezionaWlasna = true

        uklad[i] = pozycja.copy(ogon = ogon, ostatniaWlasna = ostatniaWlasna)
    }

    return uklad
}
