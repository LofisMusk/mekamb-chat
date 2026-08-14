package com.mekamb.chat

/**
 * Wybór rozmowy, do której trafia „napisz do tej osoby".
 *
 * # Czemu to musiało powstać
 *
 * Rozpoczęcie rozmowy zawsze zakładało **nową grupę MLS**, więc wpisanie tej
 * samej nazwy drugi raz dawało drugą rozmowę z tą samą osobą. Lista puchła od
 * duplikatów, a historia rozjeżdżała się między nimi: część wiadomości szła do
 * jednej grupy, część do drugiej, i żadna nie pokazywała całości.
 *
 * # Reguła
 *
 * Rozmowa jest tą samą rozmową, gdy jej **skład** to dokładnie dwie osoby: my
 * i ten rozmówca. Skład bierzemy z drzewa MLS, a nie z zapisanej obok nazwy
 * rozmówcy: nazwa jest etykietą listy, a skład jest faktem. Grupa trzyosobowa
 * nazwana imieniem jednej osoby nie jest DM-em i wciągnięcie do niej rozmowy
 * prywatnej pokazałoby ją dwóm dodatkowym osobom.
 *
 * Ta sama reguła obowiązuje w kliencie webowym (`web/src/lib/rozmowy.ts`).
 * Rozjazd znaczyłby, że te same dwa urządzenia inaczej rozstrzygają, czy
 * rozmowa już istnieje.
 */
object Rozmowy {

    /**
     * Nazwa rozmowy — kto w niej jest poza nami.
     *
     * Nazwa brała się ze stanu ekranu: wpisanej w Kontaktach albo odczytanej
     * z klikniętej pozycji listy. Rozmowa założona przez KOGOŚ INNEGO nie
     * przechodzi przez żadne z tych miejsc, więc zostawała nazwa poprzednio
     * otwartej rozmowy — wiadomości od jednej osoby podpisywały się drugą —
     * albo nie było jej wcale i lista pokazywała wiersz bez imienia.
     *
     * Skład z drzewa MLS zna każdy sposób powstania rozmowy, bo grupa nie
     * istnieje bez składu. Odpowiednik `nazwaRozmowy` w `rozmowy.ts`.
     */
    fun nazwa(czlonkowie: List<String>, ja: String): String =
        czlonkowie.distinct().filter { it != ja }.joinToString(", ")

    /**
     * Znajduje istniejącą rozmowę jeden na jeden z podaną osobą.
     *
     * [czlonkowie] zwraca identyfikatory użytkowników w grupie. Wyjątek dla
     * pojedynczej grupy (stan MLS mógł jej nie mieć, np. na świeżo sparowanym
     * urządzeniu) nie może przerwać szukania — po prostu ta grupa nie pasuje.
     */
    fun <T> znajdz1na1(
        rozmowy: List<T>,
        groupId: (T) -> ByteArray,
        czlonkowie: (ByteArray) -> List<String>,
        ja: String,
        rozmowca: String,
    ): T? {
        if (rozmowca == ja) return null

        return rozmowy.firstOrNull { rozmowa ->
            val sklad = runCatching { czlonkowie(groupId(rozmowa)).toSet() }.getOrNull()
                ?: return@firstOrNull false

            sklad.size == 2 && ja in sklad && rozmowca in sklad
        }
    }
}
