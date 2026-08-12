package com.mekamb.chat

import java.util.Calendar
import org.junit.Assert.assertEquals
import org.junit.Assert.assertFalse
import org.junit.Assert.assertTrue
import org.junit.Test

/**
 * Układ wątku.
 *
 * Sedno: rozdzielacze dni i sklejanie dymków muszą działać tak samo jak w webie
 * (`web/src/lib/watek.ts`). Rozjazd znaczyłby, że ta sama rozmowa czytana na
 * telefonie i w przeglądarce ma inny kształt — a kształt rozmowy zapamiętuje
 * się razem z treścią.
 */
class WatekTest {

    private fun poludnie(rok: Int, miesiac: Int, dzien: Int, godzina: Int = 12): Long =
        Calendar.getInstance().apply {
            set(rok, miesiac - 1, dzien, godzina, 0, 0)
            set(Calendar.MILLISECOND, 0)
        }.timeInMillis

    private fun wiadomosc(czas: Long, autor: String = "ola", wlasna: Boolean = false) =
        Wiadomosc(autor = autor, tresc = "cześć", wlasna = wlasna, czas = czas)

    private val teraz = poludnie(2026, 8, 10)

    @Test
    fun `pusty watek nie ma rozdzielaczy`() {
        assertTrue(ulozWatek(emptyList(), teraz).isEmpty())
    }

    @Test
    fun `dzis i wczoraj sa slowem, nie data`() {
        // Data przy rozmowie sprzed godziny jest odpowiedzią na pytanie,
        // którego nikt nie zadał.
        assertEquals("Dziś", etykietaDnia(teraz - 3 * 60 * 60 * 1000L, teraz))
        assertEquals("Wczoraj", etykietaDnia(poludnie(2026, 8, 9), teraz))
    }

    @Test
    fun `rok pojawia sie dopiero przy innym roku`() {
        assertFalse(etykietaDnia(poludnie(2026, 3, 14), teraz).contains("2026"))
        assertTrue(etykietaDnia(poludnie(2025, 3, 14), teraz).contains("2025"))
    }

    @Test
    fun `kazdy dzien dostaje jeden rozdzielacz`() {
        val uklad = ulozWatek(
            listOf(
                wiadomosc(poludnie(2026, 8, 8)),
                wiadomosc(poludnie(2026, 8, 8) + 60_000),
                wiadomosc(poludnie(2026, 8, 9)),
            ),
            teraz,
        )

        assertEquals(2, uklad.count { it is PozycjaWatku.Dzien })
        assertTrue(uklad.first() is PozycjaWatku.Dzien)
    }

    @Test
    fun `sklejone tylko wtedy, gdy ta sama osoba i blisko w czasie`() {
        val start = poludnie(2026, 8, 10, 9)
        val dymki = ulozWatek(
            listOf(wiadomosc(start), wiadomosc(start + 30_000)),
            teraz,
        ).filterIsInstance<PozycjaWatku.Dymek>()

        // Pierwsza w bloku nigdy nie jest ciągiem — inaczej ścięty róg pojawia
        // się pod rozdzielaczem dnia i sugeruje, że coś jest wyżej.
        assertFalse(dymki[0].ciag)
        assertTrue(dymki[1].ciag)
    }

    @Test
    fun `przerwa dluzsza niz kilka minut zrywa blok`() {
        // Bez tego dwie wiadomości tej samej osoby — rano i wieczorem — skleiłyby
        // się w jeden dymek, choć dzieli je pół dnia.
        val start = poludnie(2026, 8, 10, 9)
        val dymki = ulozWatek(
            listOf(wiadomosc(start), wiadomosc(start + PRZERWA_BLOKU_MS + 1)),
            teraz,
        ).filterIsInstance<PozycjaWatku.Dymek>()

        assertFalse(dymki[1].ciag)
    }

    @Test
    fun `wlasna po cudzej zrywa blok mimo tego samego autora`() {
        // Strona dymka jest ważniejsza niż nazwa autora: sklejenie dymka po
        // lewej z dymkiem po prawej dałoby ścięty róg tam, gdzie nic nad nim
        // nie stoi.
        val start = poludnie(2026, 8, 10, 9)
        val dymki = ulozWatek(
            listOf(
                wiadomosc(start, "ola", wlasna = false),
                wiadomosc(start + 1000, "ola", wlasna = true),
            ),
            teraz,
        ).filterIsInstance<PozycjaWatku.Dymek>()

        assertFalse(dymki[1].ciag)
    }

    @Test
    fun `klucze sa niepowtarzalne nawet przy identycznych wiadomosciach`() {
        // Dwa razy „ok" w tej samej sekundzie to nie hipoteza — a dwa elementy
        // `LazyColumn` pod jednym kluczem to wywrócone przewijanie.
        val start = poludnie(2026, 8, 10, 9)
        val uklad = ulozWatek(listOf(wiadomosc(start), wiadomosc(start)), teraz)

        assertEquals(uklad.size, uklad.map { it.klucz }.toSet().size)
    }
}
