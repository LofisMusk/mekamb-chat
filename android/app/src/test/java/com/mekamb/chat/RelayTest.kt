package com.mekamb.chat

import org.junit.Assert.assertEquals
import org.junit.Assert.assertNotNull
import org.junit.Assert.assertNull
import org.junit.Assert.assertTrue
import org.junit.Test

/**
 * Reguła reakcji na odmowę relaya.
 *
 * Odpowiednik `web/src/lib/relay.test.ts` — te same przypadki po obu stronach,
 * bo rozjazd znaczyłby, że ta sama odmowa zostawia dwa różne stany na dwóch
 * urządzeniach jednego konta.
 *
 * Sedno: odmowa, po której commit zostaje przygotowany, psuje CAŁĄ rozmowę —
 * nie tylko dodawanie osoby. Pomyłka w tę stronę jest niewidoczna od razu:
 * objawia się dopiero przy następnej wysłanej wiadomości.
 *
 * Niepusty wynik znaczy „porzuć commit i powiedz to użytkownikowi", `null` —
 * „nie ruszaj stanu MLS".
 */
class RelayTest {

    @Test
    fun `wyscig porzuca commit`() {
        // 409 znaczy „ktoś był pierwszy": epoka jest zajęta cudzym commitem,
        // a nasz nie ma już szans i musi zniknąć.
        assertEquals(Relay.WYSCIG, Relay.odmowa(409))
    }

    @Test
    fun `serwer w innej wersji porzuca commit`() {
        // Tak wyglądała usterka #18: wdrożony Worker wymagał pól, których
        // klient już nie wysyła, i odpowiadał 400. Żądanie nie doszło do
        // relaya, więc epoka jest nietknięta — commit ma zostać porzucony.
        assertNotNull(Relay.odmowa(400))
        assertNotNull(Relay.odmowa(404))
        assertTrue(Relay.odmowa(400)!!.contains("starszej wersji"))
    }

    @Test
    fun `wygasla sesja mowi o logowaniu, nie o wersji serwera`() {
        // Inne wyjście dla użytkownika, więc nie może chować się pod
        // komunikatem o starym serwerze — po nim nikt nie wpadnie, że
        // wystarczy się zalogować.
        assertTrue(Relay.odmowa(401)!!.contains("Zaloguj"))
        assertTrue(Relay.odmowa(403)!!.contains("Zaloguj"))
        assertTrue(!Relay.odmowa(400)!!.contains("Zaloguj"))
    }

    @Test
    fun `awaria serwera nie rozstrzyga niczego`() {
        // 5xx nie mówi, czy relay zdążył zająć epokę. Porzucenie commitu byłoby
        // zgadywaniem, a zgadnięcie źle rozjeżdża epokę z resztą grupy na stałe.
        assertNull(Relay.odmowa(500))
        assertNull(Relay.odmowa(502))
        assertNull(Relay.odmowa(503))
    }

    @Test
    fun `zaden komunikat nie mowi jezykiem serwera`() {
        // Ekran dostaje zdanie, z którym użytkownik może coś zrobić. „Epoka",
        // „commit" i „relay" nie należą do jego świata.
        for (status in listOf(400, 401, 403, 404, 409)) {
            val komunikat = Relay.odmowa(status)
            assertNotNull("$status: brak komunikatu", komunikat)

            val male = komunikat!!.lowercase()
            assertTrue(male.isNotEmpty())
            for (slowo in listOf("epok", "commit", "relay", "mls")) {
                assertTrue("$status: $male", !male.contains(slowo))
            }
        }
    }
}
