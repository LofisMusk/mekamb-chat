package com.mekamb.chat

import org.junit.Assert.assertFalse
import org.junit.Assert.assertTrue
import org.junit.Before
import org.junit.Test

/**
 * Sedno: wysyłamy także do własnej skrzynki, więc koperta wraca do nadawcy,
 * a MLS nie pozwala przetworzyć własnej wiadomości. Bez rozpoznania echa
 * koperta wisiałaby w kolejce przez trzy połączenia, zanim zostałaby uznana
 * za martwą.
 *
 * Zachowanie musi być identyczne z `web/src/lib/echa.test.ts` — rozjazd
 * oznaczałby, że jedna platforma krąży kopertami, których druga nie widzi.
 */
class EchaTest {
    @Before
    fun czysto() = Echa.zapomnijWszystko()

    private fun koperta(tresc: String) = tresc.toByteArray()

    @Test
    fun `rozpoznaje koperte ktora sami nadalismy`() {
        val nasza = koperta("wyslane z telefonu")
        Echa.zapamietaj(nasza)

        assertTrue(Echa.czyWlasna(nasza))
    }

    @Test
    fun `nie rozpoznaje cudzej koperty`() {
        Echa.zapamietaj(koperta("nasza"))

        assertFalse(Echa.czyWlasna(koperta("od rozmowcy")))
    }

    @Test
    fun `rozpoznaje po zawartosci a nie po tozsamosci obiektu`() {
        // Koperta wraca ze skrzynki jako świeże bajty, nigdy jako ta sama tablica.
        Echa.zapamietaj(koperta("te same bajty"))

        assertTrue(Echa.czyWlasna(koperta("te same bajty")))
    }

    /**
     * Echo wraca dokładnie raz na urządzenie. Gdyby wpis został, kolejna
     * koperta o identycznych bajtach zostałaby uznana za własną i przepadła
     * bez pokazania.
     */
    @Test
    fun `rozpoznana koperte zapomina`() {
        val nasza = koperta("jednorazowa")
        Echa.zapamietaj(nasza)

        assertTrue(Echa.czyWlasna(nasza))
        assertFalse(Echa.czyWlasna(nasza))
    }

    @Test
    fun `zapomnienie wszystkiego czysci pamiec`() {
        val nasza = koperta("do zapomnienia")
        Echa.zapamietaj(nasza)

        Echa.zapomnijWszystko()

        assertFalse(Echa.czyWlasna(nasza))
    }
}
