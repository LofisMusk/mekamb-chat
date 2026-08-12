package com.mekamb.chat

import java.text.SimpleDateFormat
import java.util.Calendar
import java.util.Date
import java.util.Locale

/**
 * Układ wątku: rozdzielacze dni i sklejanie wiadomości w bloki.
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
 * dni i inne bloki — a użytkownik zapamiętuje kształt rozmowy, nie tylko treść.
 * `WatekTest` pilnuje reguł po tej stronie.
 */

/** Ile czasu między wiadomościami tej samej osoby zrywa blok. */
const val PRZERWA_BLOKU_MS = 5 * 60 * 1000L

sealed interface PozycjaWatku {
    /** Klucz stabilny między złożeniami — `LazyColumn` bez niego gubi pozycję. */
    val klucz: String

    data class Dzien(override val klucz: String, val etykieta: String) : PozycjaWatku

    data class Dymek(
        override val klucz: String,
        val wiadomosc: Wiadomosc,
        /** Czy to kolejna wiadomość w bloku — wtedy bez autora i ze ściętym rogiem. */
        val ciag: Boolean,
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
 * wiadomość jest z innego roku.
 */
fun etykietaDnia(czas: Long, teraz: Long): String {
    val wczoraj = teraz - 24 * 60 * 60 * 1000L

    return when (dzien(czas)) {
        dzien(teraz) -> "Dziś"
        dzien(wczoraj) -> "Wczoraj"
        else -> {
            val wzor = if (rok(czas) == rok(teraz)) "d MMMM" else "d MMMM yyyy"
            SimpleDateFormat(wzor, Locale.getDefault()).format(Date(czas))
        }
    }
}

/**
 * Układa wątek.
 *
 * Blok zrywa: zmiana dnia, zmiana strony dymka, zmiana autora i przerwa dłuższa
 * niż [PRZERWA_BLOKU_MS]. Ostatni warunek jest istotny — bez niego dwie
 * wiadomości tej samej osoby wysłane rano i wieczorem sklejałyby się w jeden
 * dymek, choć dzieli je pół dnia.
 */
fun ulozWatek(wiadomosci: List<Wiadomosc>, teraz: Long): List<PozycjaWatku> {
    val uklad = mutableListOf<PozycjaWatku>()
    var poprzednia: Wiadomosc? = null

    wiadomosci.forEachIndexed { i, wiadomosc ->
        val nowyDzien = poprzednia == null || dzien(poprzednia.czas) != dzien(wiadomosc.czas)

        if (nowyDzien) {
            uklad += PozycjaWatku.Dzien(
                klucz = "dzien-${dzien(wiadomosc.czas)}",
                etykieta = etykietaDnia(wiadomosc.czas, teraz),
            )
        }

        val ciag = !nowyDzien &&
            poprzednia != null &&
            poprzednia.wlasna == wiadomosc.wlasna &&
            poprzednia.autor == wiadomosc.autor &&
            wiadomosc.czas - poprzednia.czas < PRZERWA_BLOKU_MS

        // Wiadomości nie mają własnego identyfikatora po tej stronie, a treść
        // i czas potrafią się powtórzyć (dwa razy „ok" w tej samej sekundzie).
        // Indeks jest tu jedynym kluczem, który na pewno nie kolejkuje dwóch
        // dymków pod jednym.
        uklad += PozycjaWatku.Dymek(klucz = "w-$i", wiadomosc = wiadomosc, ciag = ciag)
        poprzednia = wiadomosc
    }

    return uklad
}
