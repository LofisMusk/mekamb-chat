package com.mekamb.chat

import java.security.MessageDigest

/**
 * Rozpoznawanie własnych kopert wracających z własnej skrzynki.
 *
 * # Dlaczego to musi istnieć
 *
 * Żeby laptop zobaczył wiadomość wysłaną z telefonu, telefon musi wrzucić ją
 * także do **własnej** skrzynki — bo skrzynka adresowana jest nazwą
 * użytkownika, a nie urządzeniem. Nie da się powiedzieć „dostarcz moim innym
 * urządzeniom, ale nie temu". Koperta wraca więc do nadawcy.
 *
 * A nadawca nie potrafi jej odszyfrować: MLS z założenia nie pozwala
 * przetworzyć własnej wiadomości. Bez rozpoznania własnego echa koperta
 * wpadłaby w politykę ponawiania z [`LicznikProb`] i wisiała w kolejce przez
 * trzy połączenia, zanim zostałaby uznana za martwą.
 *
 * # Dlaczego skrót, a nie identyfikator wiadomości
 *
 * `messageId` siedzi **wewnątrz** szyfrogramu, więc jest nieczytelny dokładnie
 * dla tego, kto go potrzebuje. Skrót z bajtów koperty rozpoznaje ją bez
 * zaglądania do środka. Te same bajty idą do wszystkich odbiorców, więc jeden
 * wpis wystarcza na całe rozesłanie.
 *
 * # Dlaczego pamięć, a nie skarbiec
 *
 * Echo wraca w sekundy, a nie po restarcie. Zapis na dysk kosztowałby przy
 * każdej wysyłce, a jego brak niczego nie psuje: po restarcie niedokończone
 * echo przejdzie zwykłą ścieżką ponawiania i zostanie potwierdzone jako
 * martwe. Tak samo licznik prób celowo nie przeżywa procesu.
 *
 * Odpowiednik `web/src/lib/echa.ts` — obie strony muszą zachowywać się tak
 * samo, bo inaczej jedna platforma krąży kopertami, których druga nie widzi.
 */
object Echa {
    /**
     * Jak długo pamiętamy własną kopertę.
     *
     * Echo z podłączonego gniazda wraca natychmiast, ale koperta nadana tuż
     * przed utratą sieci wróci dopiero przy następnym połączeniu. Dziesięć
     * minut pokrywa ten przypadek i nie trzyma śmieci przez całą sesję.
     */
    private const val ZYCIE_MS = 10L * 60 * 1000

    /**
     * Ile skrótów trzymamy najwyżej.
     *
     * Bez ograniczenia długa sesja rosłaby bez końca. Przekroczenie limitu
     * wyrzuca najstarsze wpisy — a najgorsze, co się wtedy dzieje, to powrót
     * do zachowania sprzed tego pliku.
     */
    private const val LIMIT = 512

    /** `LinkedHashMap` zachowuje kolejność wstawiania — najstarsze na początku. */
    private val znane = LinkedHashMap<String, Long>()

    private fun skrot(koperta: ByteArray): String =
        MessageDigest.getInstance("SHA-256")
            .digest(koperta)
            .joinToString("") { bajt -> "%02x".format(bajt) }

    private fun posprzataj() {
        val prog = System.currentTimeMillis() - ZYCIE_MS
        znane.entries.removeAll { (_, czas) -> czas < prog }

        val iterator = znane.entries.iterator()
        while (znane.size > LIMIT && iterator.hasNext()) {
            iterator.next()
            iterator.remove()
        }
    }

    /** Zapamiętuje kopertę, którą sami nadajemy. */
    @Synchronized
    fun zapamietaj(koperta: ByteArray) {
        znane[skrot(koperta)] = System.currentTimeMillis()
        posprzataj()
    }

    /**
     * Czy ta koperta to nasze własne echo.
     *
     * Rozpoznaną kopertę **zapominamy** — wraca dokładnie raz na urządzenie,
     * a to urządzenie właśnie ją dostało. Zostawienie wpisu groziłoby uznaniem
     * kolejnej koperty o identycznych bajtach za własną i porzuceniem jej.
     */
    @Synchronized
    fun czyWlasna(koperta: ByteArray): Boolean = znane.remove(skrot(koperta)) != null

    /** Czyści pamięć — przy wylogowaniu i w testach. */
    @Synchronized
    fun zapomnijWszystko() = znane.clear()
}
