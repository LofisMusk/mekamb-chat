package com.mekamb.chat

import kotlin.random.Random
import org.junit.Assert.assertEquals
import org.junit.Assert.assertFalse
import org.junit.Assert.assertTrue
import org.junit.Test
import uniffi.mekamb_ffi.ReceiptKind

/**
 * Zbieranie i opóźnianie potwierdzeń.
 *
 * Sedno: potwierdzenie jest zaszyfrowane, ale CHWILA jego wysłania nie jest.
 * Serwer nie wie, co jest w kopercie — wie, kiedy poszła. Potwierdzenie odczytu
 * wysłane natychmiast po przeczytaniu mówi mu „B przeczytał wiadomość od A
 * cztery sekundy temu". Opóźnienie i zbieranie w paczki są jedyną obroną, jaką
 * ma tu klient, więc mają być sprawdzone, a nie założone.
 *
 * Reguły są te same co w webie (`web/src/lib/potwierdzenia.test.ts`). Rozjazd
 * znaczyłby, że jedna platforma ujawnia więcej niż druga przy tej samej
 * obietnicy w interfejsie.
 */
class PotwierdzeniaTest {

    private val grupa = byteArrayOf(1, 2, 3)
    private val innaGrupa = byteArrayOf(9, 9, 9)

    private fun id(n: Int) = ByteArray(16) { n.toByte() }

    @Test
    fun `opoznienie miesci sie w zadeklarowanym przedziale`() {
        repeat(200) {
            val opoznienie = losoweOpoznienie(Random(it))
            assertTrue(opoznienie >= 3_000L)
            assertTrue(opoznienie <= 30_000L)
        }
    }

    @Test
    fun `opoznienie nie jest stale`() {
        // Stałe opóźnienie przesuwa korelację, zamiast ją zrywać: obserwator
        // odejmuje pięć sekund i ma z powrotem chwilę odczytu.
        val wartosci = (1..50).map { losoweOpoznienie(Random(it)) }.toSet()
        assertTrue(wartosci.size > 1)
    }

    @Test
    fun `nowy zbieracz jest pusty`() {
        assertTrue(ZbieraczPotwierdzen().pusty())
    }

    @Test
    fun `skleja wiadomosci z jednej rozmowy w jedna paczke`() {
        // Liczba kopert też jest sygnałem: jedna na dziesięć odczytanych
        // wiadomości nie mówi obserwatorowi, ile ich było.
        val zbieracz = ZbieraczPotwierdzen()
        zbieracz.dodaj(grupa, ReceiptKind.READ, id(1))
        zbieracz.dodaj(grupa, ReceiptKind.READ, id(2))
        zbieracz.dodaj(grupa, ReceiptKind.READ, id(3))

        val paczki = zbieracz.zabierz()
        assertEquals(1, paczki.size)
        assertEquals(3, paczki[0].identyfikatory.size)
    }

    @Test
    fun `rozdziela paczki po rozmowie i po rodzaju`() {
        val zbieracz = ZbieraczPotwierdzen()
        zbieracz.dodaj(grupa, ReceiptKind.READ, id(1))
        zbieracz.dodaj(grupa, ReceiptKind.DELIVERED, id(2))
        zbieracz.dodaj(innaGrupa, ReceiptKind.READ, id(3))

        assertEquals(3, zbieracz.zabierz().size)
    }

    @Test
    fun `nie powtarza tego samego identyfikatora`() {
        val zbieracz = ZbieraczPotwierdzen()
        zbieracz.dodaj(grupa, ReceiptKind.DELIVERED, id(1))
        zbieracz.dodaj(grupa, ReceiptKind.DELIVERED, id(1))

        assertEquals(1, zbieracz.zabierz()[0].identyfikatory.size)
    }

    @Test
    fun `odczyt pochlania dostarczenie tej samej wiadomosci`() {
        // Odczyt mówi wszystko, co powiedziałoby dostarczenie. Wysłanie obu
        // byłoby drugą kopertą bez nowej treści — a każda koperta to sygnał.
        val zbieracz = ZbieraczPotwierdzen()
        zbieracz.dodaj(grupa, ReceiptKind.DELIVERED, id(1))
        zbieracz.dodaj(grupa, ReceiptKind.READ, id(1))

        val paczki = zbieracz.zabierz()
        assertEquals(1, paczki.size)
        assertEquals(ReceiptKind.READ, paczki[0].rodzaj)
    }

    @Test
    fun `dostarczenie po odczycie nie wraca`() {
        val zbieracz = ZbieraczPotwierdzen()
        zbieracz.dodaj(grupa, ReceiptKind.READ, id(1))
        zbieracz.dodaj(grupa, ReceiptKind.DELIVERED, id(1))

        val paczki = zbieracz.zabierz()
        assertEquals(1, paczki.size)
        assertEquals(ReceiptKind.READ, paczki[0].rodzaj)
    }

    @Test
    fun `zabranie czysci zbieracz`() {
        // Gdyby czyszczenie było osobnym krokiem, nieudana wysyłka zostawiłaby
        // potwierdzenia wysyłane w kółko.
        val zbieracz = ZbieraczPotwierdzen()
        zbieracz.dodaj(grupa, ReceiptKind.READ, id(1))

        assertEquals(1, zbieracz.zabierz().size)
        assertEquals(0, zbieracz.zabierz().size)
        assertTrue(zbieracz.pusty())
    }

    @Test
    fun `identyfikatory przezywaja pelne kolo przez tekst`() {
        // Zbieracz trzyma identyfikatory szesnastkowo, bo `ByteArray` nie
        // nadaje się na klucz zbioru. Zamiana musi być odwracalna, inaczej
        // ptaszki trafiałyby na przypadkowe dymki.
        val zbieracz = ZbieraczPotwierdzen()
        val oryginal = ByteArray(16) { (it * 7).toByte() }
        zbieracz.dodaj(grupa, ReceiptKind.READ, oryginal)

        assertTrue(zbieracz.zabierz()[0].identyfikatory[0].contentEquals(oryginal))
    }

    /*
     * Sedno: stan rośnie tylko w jedną stronę.
     *
     * Potwierdzenia idą przez skrzynkę i mogą dotrzeć w odwrotnej kolejności.
     * Bez tej reguły spóźniona paczka z dostarczeniem cofałaby dymek
     * z „przeczytane" na „dostarczone" — na oczach użytkownika.
     */
    @Test
    fun `stan wiadomosci rosnie tylko w jedna strone`() {
        assertEquals(
            StanWiadomosci.PRZECZYTANE,
            StanWiadomosci.DOSTARCZONE.wyzszy(StanWiadomosci.PRZECZYTANE),
        )
        assertEquals(
            StanWiadomosci.PRZECZYTANE,
            StanWiadomosci.PRZECZYTANE.wyzszy(StanWiadomosci.DOSTARCZONE),
        )
        assertEquals(
            StanWiadomosci.DOSTARCZONE,
            StanWiadomosci.WYSLANE.wyzszy(StanWiadomosci.DOSTARCZONE),
        )
        assertFalse(
            StanWiadomosci.PRZECZYTANE.wyzszy(StanWiadomosci.WYSLANE) == StanWiadomosci.WYSLANE,
        )
    }
}
