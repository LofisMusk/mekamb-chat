package com.mekamb.chat

import org.junit.Assert.assertEquals
import org.junit.Assert.assertNull
import org.junit.Test

/**
 * Reguła wyboru rozmowy jeden na jeden.
 *
 * Odpowiednik `web/src/lib/rozmowy.test.ts` — te same przypadki po obu
 * stronach, bo rozjazd znaczyłby, że dwa urządzenia inaczej rozstrzygają,
 * czy rozmowa z daną osobą już istnieje.
 */
class RozmowyTest {

    private val ja = "ala"

    private data class Rozmowa(val id: Int) {
        val groupId: ByteArray get() = byteArrayOf(id.toByte())
    }

    private fun sklad(mapa: Map<Int, List<String>>): (ByteArray) -> List<String> = { groupId ->
        mapa[groupId[0].toInt()] ?: error("nie ma takiej grupy w stanie MLS")
    }

    private fun szukaj(
        rozmowy: List<Rozmowa>,
        mapa: Map<Int, List<String>>,
        rozmowca: String,
    ): Rozmowa? = Rozmowy.znajdz1na1(rozmowy, { it.groupId }, sklad(mapa), ja, rozmowca)

    /** Sedno: to jest ta usterka — druga próba zakładała drugą grupę. */
    @Test
    fun `znajduje istniejaca rozmowe z ta sama osoba`() {
        val rozmowy = listOf(Rozmowa(1))

        assertEquals(rozmowy[0], szukaj(rozmowy, mapOf(1 to listOf(ja, "bartek")), "bartek"))
    }

    @Test
    fun `nie podstawia rozmowy z kims innym`() {
        assertNull(szukaj(listOf(Rozmowa(1)), mapOf(1 to listOf(ja, "bartek")), "celina"))
    }

    /** Grupa nazwana imieniem jednej osoby wciąż jest grupą. */
    @Test
    fun `nie traktuje grupy trzyosobowej jako rozmowy z jedna osoba`() {
        val mapa = mapOf(1 to listOf(ja, "bartek", "celina"))

        assertNull(szukaj(listOf(Rozmowa(1)), mapa, "bartek"))
    }

    @Test
    fun `wybiera wlasciwa sposrod wielu rozmow`() {
        val rozmowy = listOf(Rozmowa(1), Rozmowa(2), Rozmowa(3))
        val mapa = mapOf(
            1 to listOf(ja, "bartek"),
            2 to listOf(ja, "celina", "dawid"),
            3 to listOf(ja, "celina"),
        )

        assertEquals(rozmowy[2], szukaj(rozmowy, mapa, "celina"))
    }

    /** Jedna pozycja nieznana stanowi MLS nie może zablokować reszty. */
    @Test
    fun `pomija rozmowe ktorej stan MLS nie zna i szuka dalej`() {
        val rozmowy = listOf(Rozmowa(9), Rozmowa(1))

        assertEquals(rozmowy[1], szukaj(rozmowy, mapOf(1 to listOf(ja, "bartek")), "bartek"))
    }

    @Test
    fun `nie podstawia rozmowy z samym soba`() {
        assertNull(szukaj(listOf(Rozmowa(1)), mapOf(1 to listOf(ja)), ja))
    }

    @Test
    fun `brak rozmow to brak dopasowania`() {
        assertNull(szukaj(emptyList(), emptyMap(), "bartek"))
    }

    /** Sedno: to jest ta usterka z listy rozmów — wiersz bez imienia. */
    @Test
    fun `rozmowa dwoch osob nazywa sie ta druga`() {
        assertEquals("bartek", Rozmowy.nazwa(listOf(ja, "bartek"), ja))
    }

    @Test
    fun `grupa wymienia wszystkich poza nami`() {
        assertEquals("bartek, celina", Rozmowy.nazwa(listOf(ja, "bartek", "celina"), ja))
    }

    /** MLS liczy urządzenia, nazwa dotyczy osób. */
    @Test
    fun `osoba z kilkoma urzadzeniami liczy sie raz`() {
        assertEquals("bartek", Rozmowy.nazwa(listOf(ja, "bartek", "bartek"), ja))
    }

    @Test
    fun `sami w rozmowie dajemy pusta nazwe`() {
        assertEquals("", Rozmowy.nazwa(listOf(ja), ja))
    }
}
