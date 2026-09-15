package com.mekamb.chat

import androidx.compose.ui.graphics.Color
import org.junit.Assert.assertEquals
import org.junit.Assert.assertTrue
import org.junit.Test

/**
 * Kontrast akcentów.
 *
 * Sedno: akcent jest wyborem użytkownika, a wybór nie może mieć wariantu, w
 * którym własny dymek staje się nieczytelny. Przez długi czas telefon zalewał
 * akcje i dymki żywą próbką, więc na czterech z ośmiu akcentów biały tekst
 * leżał na tle poniżej 4,5:1 — i nic tego nie łapało, bo próg był trzymany
 * dyscypliną, a nie testem. Ten test jest tą asercją.
 *
 * Bliźniak po stronie weba: `web/src/lib/akcent.test.ts`. Obie platformy liczą
 * ten sam współczynnik z tej samej palety — rozjazd znaczyłby, że ta sama
 * rozmowa jest czytelna na jednym urządzeniu, a na drugim nie.
 */
class KontrastAkcentuTest {

    /**
     * Współczynnik kontrastu WCAG 2.1 (1.4.3).
     *
     * Liczony tu, a nie w produkcji, bo aplikacja nigdy nie potrzebuje tej
     * liczby w czasie działania — potrzebuje jej tylko CI, żeby powiedzieć
     * „nie", gdy ktoś dołoży dziewiąty kolor na oko.
     */
    private fun kontrast(a: Color, b: Color): Double {
        fun kanal(v: Float): Double {
            val c = v.toDouble()
            return if (c <= 0.04045) c / 12.92 else Math.pow((c + 0.055) / 1.055, 2.4)
        }

        fun luminancja(k: Color) =
            0.2126 * kanal(k.red) + 0.7152 * kanal(k.green) + 0.0722 * kanal(k.blue)

        val x = luminancja(a)
        val y = luminancja(b)
        return (maxOf(x, y) + 0.05) / (minOf(x, y) + 0.05)
    }

    private val bialy = Color(0xFFFFFFFF)

    /** Próg WCAG AA dla zwykłego tekstu. Etykieta akcji i treść dymka to zwykły tekst. */
    private val prog = 4.5

    @Test
    fun `wspolczynnik kontrastu zgadza sie ze znanymi wartosciami`() {
        // Kotwica: gdyby sama formuła była zła, wszystkie asercje niżej byłyby
        // bezwartościowe. Czerń na bieli to dokładnie 21:1, biel na bieli 1:1.
        assertEquals(21.0, kontrast(Color(0xFF000000), bialy), 0.01)
        assertEquals(1.0, kontrast(bialy, bialy), 0.001)
        assertEquals(4.02, kontrast(Color(0xFF007AFF), bialy), 0.01)
    }

    @Test
    fun `paleta ma osiem kolorow`() {
        // Ten sam zestaw co PALETA_AKCENTOW w webie. Dziewiąty kolor tutaj bez
        // dziewiątego tam to dwa różne selektory pod jedną obietnicą w UI.
        assertEquals(8, Akcent.entries.size)
    }

    @Test
    fun `wypelnienie kazdego akcentu udzwiga bialy tekst`() {
        // Rola `akcent`, `babelWlasny` i `znacznik` to wypełnienia pod BIAŁĄ
        // treścią — patrz MotywNocturne. Żywa próbka tu nie wystarcza:
        // #34C759 daje 2,22:1, #00C7BE 2,12:1.
        for (akcent in Akcent.entries) {
            if (akcent == Akcent.NIEBIESKI) continue

            val wynik = kontrast(akcent.wypelnienie, bialy)
            assertTrue(
                "${akcent.name}: wypełnienie ${szesnastkowo(akcent.wypelnienie)} pod białym " +
                    "tekstem daje ${"%.2f".format(wynik)}:1, a próg to $prog:1",
                wynik >= prog,
            )
        }
    }

    @Test
    fun `niebieski jest swiadomym wyjatkiem, nie przeoczeniem`() {
        // Systemowy błękit iOS: 4,02:1, czyli poniżej progu. Zostaje, bo jest
        // domyślnym akcentem obu klientów i tym, co ludzie znają z natywnego
        // komunikatora — a przyciemnienie go jest decyzją projektową dla weba i
        // Androida naraz, nie lokalną poprawką w Nocturne.kt.
        //
        // Asercja jest tu po to, żeby ten wyjątek był WIDOCZNY. Gdyby kiedyś
        // ktoś błękit przyciemnił, ten test upadnie i każe zdjąć wyjątek z
        // pętli wyżej, zamiast zostawić martwy `continue`.
        val wynik = kontrast(Akcent.NIEBIESKI.wypelnienie, bialy)
        assertEquals(4.02, wynik, 0.01)
        assertTrue("wyjątek przestał być potrzebny — zdejmij go z testu", wynik < prog)
    }

    @Test
    fun `probka zostaje zywym odcieniem i nie jest podstawiana pod wypelnienie`() {
        // Gdyby ktoś „uprościł" enum z powrotem do jednego odcienia, cztery
        // akcenty po cichu wróciłyby pod próg. Te cztery muszą się różnić.
        for (akcent in listOf(
            Akcent.ZIELONY,
            Akcent.POMARANCZOWY,
            Akcent.MALINOWY,
            Akcent.TURKUSOWY,
        )) {
            assertTrue(
                "${akcent.name}: próbka i wypełnienie znowu są tym samym odcieniem",
                akcent.probka != akcent.wypelnienie,
            )
            assertTrue(
                "${akcent.name}: żywa próbka pod białym tekstem byłaby nieczytelna " +
                    "— i o to chodzi, że nie jest wypełnieniem",
                kontrast(akcent.probka, bialy) < prog,
            )
        }
    }

    @Test
    fun `farba akcentu odcina sie od tla wlasnego motywu`() {
        // Rola `akcentTekst`: ikona, etykieta i obrys na neutralnym tle. Musi
        // kontrastować z TŁEM, a nie z białym tekstem, więc rozwiązuje się per
        // motyw. Próg 3:1 — WCAG 1.4.11 dla elementów nietekstowych; to jest
        // podłoga, którą paleta trzyma na tle GŁÓWNYM obu motywów.
        //
        // Czego ten test NIE pilnuje, świadomie: powierzchni drugorzędnych
        // (`karta2`). Na ciemnej karcie #2C2C2E indygo daje 2,47:1, a etykieta
        // PrzyciskDrugi na jasnej #F2F2F7 spada dla pomarańczu do 4,33:1.
        // Domknięcie tego wymaga trzeciego odcienia na akcent (osobna farba dla
        // motywu ciemnego) po obu stronach naraz — a to decyzja projektowa,
        // nie poprawka. Zostaje odnotowane, nie przemilczane.
        val progNietekstowy = 3.0
        for (akcent in Akcent.entries) {
            val jasne = kontrast(akcent.farba(jasny = true), JASNE.tlo)
            assertTrue(
                "${akcent.name}: farba na jasnym tle to ${"%.2f".format(jasne)}:1",
                jasne >= progNietekstowy,
            )

            val ciemne = kontrast(akcent.farba(jasny = false), CIEMNE.tlo)
            assertTrue(
                "${akcent.name}: farba na ciemnym tle to ${"%.2f".format(ciemne)}:1",
                ciemne >= progNietekstowy,
            )
        }
    }

    private fun szesnastkowo(kolor: Color): String =
        "#%02X%02X%02X".format(
            (kolor.red * 255).toInt(),
            (kolor.green * 255).toInt(),
            (kolor.blue * 255).toInt(),
        )
}
