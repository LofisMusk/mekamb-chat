package com.mekamb.chat

import org.junit.Assert.assertEquals
import org.junit.Assert.assertTrue
import org.junit.Test

/**
 * Scalanie historii z drugiego urządzenia.
 *
 * # Sedno
 *
 * Wiadomości są niezmienne i rozłączne, więc to nie jest „merge" w sensie
 * gita — to suma zbiorów po identyfikatorze. Cała trudność siedzi w kolejności
 * i w tym, czego scalać NIE wolno.
 *
 * Zachowanie musi być identyczne z `web/src/lib/historia.test.ts`. Rozjazd
 * znaczyłby, że po scaleniu każde urządzenie pokazuje inny wątek — czyli
 * dokładnie to, czemu scalanie ma zapobiegać.
 */
class ScalanieHistoriiTest {

    private fun wiadomosc(id: String, czas: Long = 1000) = ZapisanaWiadomosc(
        autor = "ala",
        tresc = "tresc $id",
        wlasna = false,
        czas = czas,
        id = id,
    )

    @Test
    fun `suma zbiorow bez duplikatow`() {
        val nasze = listOf(wiadomosc("a", 1), wiadomosc("b", 2))
        val obce = listOf(wiadomosc("b", 2), wiadomosc("c", 3))

        assertEquals(listOf("a", "b", "c"), scalWiadomosci(nasze, obce).map { it.id })
    }

    /**
     * `czas` to chwila nadania podana przez nadawcę, więc zegary laptopa
     * i telefonu realnie się rozjeżdżają. Przy równych znacznikach potrzebny
     * jest rozstrzygnik dający ten sam wynik po obu stronach — inaczej dwa
     * urządzenia pokazywałyby wątek inaczej po tym samym scaleniu.
     */
    @Test
    fun `kolejnosc jest ta sama niezaleznie od strony scalania`() {
        val nasze = listOf(wiadomosc("z", 5), wiadomosc("a", 5))
        val obce = listOf(wiadomosc("m", 5), wiadomosc("b", 1))

        val tam = scalWiadomosci(nasze, obce).map { it.id }
        val zpowrotem = scalWiadomosci(obce, nasze).map { it.id }

        assertEquals(tam, zpowrotem)
        assertEquals(listOf("b", "a", "m", "z"), tam)
    }

    /**
     * „Nieodebrana" jest faktem o TYM urządzeniu — drugie urządzenie tej samej
     * osoby nie widzi nic, bo nic się przy nim nie wydarzyło.
     */
    @Test
    fun `slady po rozmowach AV nie przechodza z drugiego urzadzenia`() {
        val nasze = listOf(wiadomosc("a", 1))
        val obce = listOf(
            wiadomosc("b", 2),
            wiadomosc("c", 3).copy(rozmowa = ZapisanaRozmowaAV(wideo = false, wychodzaca = true)),
        )

        assertEquals(listOf("a", "b"), scalWiadomosci(nasze, obce).map { it.id })
    }

    @Test
    fun `wlasny slad po rozmowie zostaje nietkniety`() {
        val nasze = listOf(
            wiadomosc("a", 1).copy(rozmowa = ZapisanaRozmowaAV(wideo = true, wychodzaca = false)),
        )

        assertEquals(listOf("a", "b"), scalWiadomosci(nasze, listOf(wiadomosc("b", 2))).map { it.id })
    }

    /** Stan idzie tylko w górę — „przeczytane" nie cofa się do „wysłane". */
    @Test
    fun `stan wysylki bierze dalszy z dwoch`() {
        val nasze = listOf(wiadomosc("a", 1).copy(stan = StanWiadomosci.WYSLANE))
        val obce = listOf(wiadomosc("a", 1).copy(stan = StanWiadomosci.PRZECZYTANE))

        assertEquals(StanWiadomosci.PRZECZYTANE, scalWiadomosci(nasze, obce)[0].stan)
        assertEquals(StanWiadomosci.PRZECZYTANE, scalWiadomosci(obce, nasze)[0].stan)
    }

    /**
     * Sedno przycinania: dwa ogony po 500 dają w sumie więcej niż 500.
     * Obcięcie KAŻDEGO Z OSOBNA przed scaleniem wyrzuca wiadomości, które
     * istnieją tylko po jednej stronie — a to jest dokładnie to, po co scalamy.
     */
    @Test
    fun `przycina po scaleniu a nie przed`() {
        val nasze = (0 until 400).map { wiadomosc("n$it", 1000L + it) }
        val obce = (0 until 400).map { wiadomosc("o$it", 1000L + it) }

        val scalone = scalWiadomosci(nasze, obce)

        assertEquals(500, scalone.size)
        assertTrue(scalone.any { it.id.startsWith("n") })
        assertTrue(scalone.any { it.id.startsWith("o") })
    }

    /**
     * Zapisy sprzed wersji 5 mają pusty `id`. Bez klucza zastępczego cała stara
     * historia dublowałaby się przy każdym parowaniu.
     */
    @Test
    fun `zapisy bez identyfikatora nie mnoza sie`() {
        val stara = wiadomosc("", 1).copy(tresc = "sprzed wersji 5")

        assertEquals(1, scalWiadomosci(listOf(stara), listOf(stara.copy())).size)
    }

    @Test
    fun `klucz zastepczy rozroznia rozne tresci`() {
        val a = wiadomosc("", 1).copy(tresc = "pierwsza")
        val b = wiadomosc("", 1).copy(tresc = "druga")

        assertEquals(2, scalWiadomosci(listOf(a), listOf(b)).size)
    }
}
