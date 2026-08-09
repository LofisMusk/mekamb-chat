package com.mekamb.chat

import kotlinx.coroutines.runBlocking
import org.junit.Assert.assertArrayEquals
import org.junit.Assert.assertEquals
import org.junit.Assert.assertNull
import org.junit.Assert.assertTrue
import org.junit.Test

/**
 * Odbiór ze skrzynki.
 *
 * To jedyne miejsce w kliencie, w którym da się **trwale stracić wiadomość**:
 * potwierdzenie kasuje kopertę na serwerze bezpowrotnie. Drugą stroną tego
 * samego medalu jest zapętlenie — koperta, której nigdy nie da się przetworzyć,
 * wracałaby przy każdym połączeniu. Dlatego ta logika jest wydzielona z obsługi
 * gniazda i sprawdzana tutaj, a nie oglądana ręcznie na urządzeniu.
 */
class SkrzynkaTest {

    private fun ramka(id: Long, koperta: ByteArray): ByteArray =
        java.nio.ByteBuffer.allocate(BAJTY_IDENTYFIKATORA + koperta.size)
            .putLong(id)
            .put(koperta)
            .array()

    /// Sedno: identyfikator jest nadawany przez serwer i odsyłany
    /// w potwierdzeniu. Pomyłka o bajt kasowałaby cudzy wpis w kolejce albo
    /// nie kasowałaby żadnego.
    @Test
    fun `rozdziela ramke na identyfikator i koperte`() {
        val koperta = byteArrayOf(1, 2, 3, 4, 5)

        val rozdzielona = rozdzielRamke(ramka(7, koperta))!!

        assertEquals(7L, rozdzielona.id)
        assertArrayEquals(koperta, rozdzielona.koperta)
    }

    /// Sedno: pusta koperta jest poprawną ramką (sam identyfikator), ale ramka
    /// krótsza niż identyfikator już nie — nie da się jej ani przetworzyć,
    /// ani potwierdzić.
    @Test
    fun `ramka krotsza niz identyfikator jest odrzucana`() {
        assertNull(rozdzielRamke(byteArrayOf(1, 2, 3)))
        assertEquals(0, rozdzielRamke(ramka(9, byteArrayOf()))!!.koperta.size)
    }

    /// Sedno całego modułu: potwierdzenie kasuje kopertę na serwerze, więc może
    /// paść DOPIERO po tym, jak stan MLS został zapisany. Odwrotna kolejność
    /// gubi wiadomość przy restarcie między jednym a drugim.
    @Test
    fun `potwierdza dopiero po przetworzeniu koperty`() = runBlocking {
        val kolejnosc = mutableListOf<String>()

        obsluzRamke(
            ramka = ramka(1, byteArrayOf(42)),
            licznik = LicznikProb(),
            przetworz = { kolejnosc.add("przetworzone") },
            potwierdz = { kolejnosc.add("potwierdzone") },
        )

        assertEquals(listOf("przetworzone", "potwierdzone"), kolejnosc)
    }

    /// Sedno: koperta trafia do `przetworz` BEZ prefiksu z identyfikatorem.
    /// Prefiks w środku koperty psułby dekodowanie każdej wiadomości.
    @Test
    fun `do przetworzenia idzie sama koperta`() = runBlocking {
        var przekazana: ByteArray? = null

        obsluzRamke(
            ramka = ramka(3, byteArrayOf(9, 8, 7)),
            licznik = LicznikProb(),
            przetworz = { przekazana = it },
            potwierdz = {},
        )

        assertArrayEquals(byteArrayOf(9, 8, 7), przekazana)
    }

    /// Sedno pierwszej połowy: koperta nie może zostać skasowana za pierwszym
    /// razem, bo mogła tylko wyprzedzić commit, który jest jej potrzebny —
    /// druga próba, już po jego nadejściu, się powiedzie.
    @Test
    fun `pierwsza nieudana proba nie potwierdza koperty`() = runBlocking {
        var potwierdzone = false

        obsluzRamke(
            ramka = ramka(1, byteArrayOf(42)),
            licznik = LicznikProb(),
            przetworz = { error("brak commitu dla tej epoki") },
            potwierdz = { potwierdzone = true },
        )

        assertTrue(!potwierdzone)
    }

    /// Sedno drugiej połowy: koperta, której nigdy nie da się przetworzyć,
    /// musi w końcu zniknąć z kolejki — inaczej wraca przy każdym połączeniu
    /// do końca świata.
    @Test
    fun `po ustalonej liczbie prob koperta jest potwierdzana mimo bledu`() = runBlocking {
        val licznik = LicznikProb()
        val potwierdzone = mutableListOf<Long>()

        repeat(PROB_PRZED_ODRZUCENIEM) {
            obsluzRamke(
                ramka = ramka(5, byteArrayOf(42)),
                licznik = licznik,
                przetworz = { error("koperta nie do przetworzenia") },
                potwierdz = { potwierdzone.add(it) },
            )
        }

        assertEquals(listOf(5L), potwierdzone)
    }

    /// Sedno: licznik jest per koperta. Wspólny licznik odrzucałby zdrową
    /// kopertę tylko dlatego, że wcześniej zawiodły inne.
    @Test
    fun `nieudane proby roznych kopert nie sumuja sie`() = runBlocking {
        val licznik = LicznikProb()
        val potwierdzone = mutableListOf<Long>()

        for (id in 1L..PROB_PRZED_ODRZUCENIEM.toLong()) {
            obsluzRamke(
                ramka = ramka(id, byteArrayOf(42)),
                licznik = licznik,
                przetworz = { error("nie tym razem") },
                potwierdz = { potwierdzone.add(it) },
            )
        }

        assertEquals(emptyList<Long>(), potwierdzone)
    }

    /// Sedno: udane przetworzenie zeruje licznik. Bez tego koperta, która
    /// przeszła za drugim razem, zostawiałaby wpis — a identyfikatory są
    /// nadawane po kolei, więc licznik rósłby przez całe życie połączenia.
    @Test
    fun `udana proba zeruje licznik niepowodzen`() {
        val licznik = LicznikProb()

        assertEquals(Decyzja.PONOW, licznik.poNiepowodzeniu(1))
        licznik.poSukcesie(1)

        // Gdyby licznik przetrwał sukces, ta próba byłaby już drugą.
        assertEquals(Decyzja.PONOW, licznik.poNiepowodzeniu(1))
    }
}
