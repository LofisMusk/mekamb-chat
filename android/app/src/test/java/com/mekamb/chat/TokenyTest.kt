package com.mekamb.chat

import org.junit.Assert.assertEquals
import org.junit.Assert.assertFalse
import org.junit.Assert.assertNotNull
import org.junit.Assert.assertNull
import org.junit.Assert.assertTrue
import org.junit.Test

/**
 * Portfel tokenów doręczeniowych.
 *
 * Sedno: token ma dowodzić „mam prawo nadać", nie mówiąc „jestem tym kontem".
 * Wydawanie ich pojedynczo tuż przed wysyłką zniweczyłoby to, bo pobranie jest
 * żądaniem uwierzytelnionym — serwer widziałby „konto A poprosiło o token,
 * sekundę później ktoś nadał do skrzynki B". Dlatego zapas bierze się z góry
 * i wydaje pojedynczo.
 *
 * Reguły są te same co w webie (`web/src/lib/tokeny.test.ts`).
 */
class TokenyTest {

    /** Magazyn w pamięci — reguły portfela mają dać się sprawdzić bez Androida. */
    private class MagazynWPamieci(
        private val dane: MutableMap<String, String> = mutableMapOf(),
    ) : MagazynTokenow {
        override fun odczytaj(klucz: String): String? = dane[klucz]
        override fun zapisz(klucz: String, wartosc: String) {
            dane[klucz] = wartosc
        }
    }

    private fun portfel(vararg tokeny: TokenDoreczenia): PortfelTokenow {
        val p = PortfelTokenow(MagazynWPamieci())
        p.doloz(tokeny.toList())
        return p
    }

    private val token = TokenDoreczenia("AAAA", "BBBB")

    @Test
    fun `pusty zapas nie daje tokenu`() {
        // Wołający ma wtedy nadać BEZ tokenu: wiadomość jest ważniejsza niż
        // limit nadużyć, dopóki serwer tokenów nie wymusza.
        assertNull(portfel().wez())
    }

    @Test
    fun `wydaje po jednym i zdejmuje z zapasu`() {
        val p = portfel(token, TokenDoreczenia("CCCC", "DDDD"))

        assertEquals(token, p.wez())
        assertEquals(1, p.ile())
        assertEquals(TokenDoreczenia("CCCC", "DDDD"), p.wez())
        assertNull(p.wez())
    }

    @Test
    fun `ten sam token nie wychodzi dwa razy`() {
        // Serwer odrzuciłby drugie użycie, ale wiadomość by wtedy nie doszła —
        // a przyczyna byłaby po naszej stronie.
        val p = portfel(token)

        assertNotNull(p.wez())
        assertNull(p.wez())
    }

    @Test
    fun `uszkodzony zapis znaczy pusty zapas, a nie awarie`() {
        val magazyn = MagazynWPamieci(mutableMapOf("zapas" to "{to nie jest json"))
        val p = PortfelTokenow(magazyn)

        assertEquals(0, p.ile())
        assertNull(p.wez())
    }

    @Test
    fun `naglowek ma ksztalt, jakiego oczekuje serwer`() {
        // Dwa pola rozdzielone kropką. Rozjazd tutaj znaczy odrzucone nadanie
        // z komunikatem, który niczego nie tłumaczy.
        assertEquals("AAAA.BBBB", token.naglowek())
        assertEquals(2, token.naglowek().split(".").size)
    }

    @Test
    fun `dobieramy zanim zapas sie skonczy`() {
        // Próg równy zeru znaczyłby dobieranie dopiero przy pustym portfelu,
        // czyli uwierzytelnione żądanie dokładnie w chwili wysyłania.
        assertTrue(portfel().trzebaDobrac())
        assertTrue(portfel(*Array(5) { token }).trzebaDobrac())
        assertFalse(portfel(*Array(PortfelTokenow.DOCELOWY) { token }).trzebaDobrac())
    }

    /*
     * Sedno: serwer wydający różnym osobom tokeny różnymi kluczami ZNAKUJE je —
     * przy nadaniu rozpoznaje, czyj był token. Dowód wykrywa użycie innego
     * klucza niż podany, ale nie to, że sam klucz podstawiono pod nas.
     * Przypięcie zamienia atak z niewidocznego w wymagający zmiany klucza
     * u wszystkich naraz.
     */
    @Test
    fun `pierwszy klucz zostaje przypiety`() {
        val p = PortfelTokenow(MagazynWPamieci())

        assertTrue(p.przypnijKlucz("klucz-a"))
        assertTrue(p.przypnijKlucz("klucz-a"))
    }

    @Test
    fun `zmiana klucza jest odrzucana`() {
        val p = PortfelTokenow(MagazynWPamieci())
        p.przypnijKlucz("klucz-a")

        assertFalse(p.przypnijKlucz("klucz-b"))
    }
}
