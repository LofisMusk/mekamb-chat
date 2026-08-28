package com.mekamb.chat

import org.junit.Assert.assertEquals
import org.junit.Assert.assertFalse
import org.junit.Assert.assertTrue
import org.junit.Test

/**
 * Znikanie wiadomości — logika czysta.
 *
 * Zachowanie musi być identyczne z `web/src/lib/znikanie.test.ts`. Rozjazd
 * znaczyłby, że ta sama rozmowa znika po innym czasie na telefonie i w
 * przeglądarce.
 */
class ZnikanieTest {

    // Sedno: granica to „najstarsza chwila do zachowania" = teraz − czas życia.
    @Test
    fun `granica to teraz minus czas zycia`() {
        val teraz = 1_000_000L
        val granice = Znikanie.graniceOdciecia(mapOf("aa" to 60L), teraz)
        assertEquals(teraz - 60_000L, granice["aa"])
    }

    // Rozmowa bez znikania (0 albo brak wpisu) nie ma się pojawić — inaczej
    // przycinanie usuwałoby wszystko starsze niż „teraz", czyli wszystko.
    @Test
    fun `pomija rozmowy bez ustawionego znikania`() {
        assertTrue(Znikanie.graniceOdciecia(emptyMap(), 1_000L).isEmpty())
        assertFalse(Znikanie.graniceOdciecia(mapOf("aa" to 0L), 1_000L).containsKey("aa"))
    }

    // Presety mają swoje nazwy; własne wartości opisujemy w największej równej
    // jednostce, żeby „3600 s" czytało się jako „1 godzina".
    @Test
    fun `opis nazywa presety i wartosci wlasne`() {
        assertEquals("1 godzina", opisZnikania(60 * 60))
        assertEquals("2 godz.", opisZnikania(2 * 60 * 60))
        assertEquals("90 min", opisZnikania(90 * 60))
        assertEquals("3 dni", opisZnikania(3 * 24 * 60 * 60))
    }
}
