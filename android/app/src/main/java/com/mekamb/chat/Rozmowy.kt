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
     * Znajduje istniejącą rozmowę jeden na jeden z podaną osobą.
     *
     * [czlonkowie] zwraca identyfikatory użytkowników w grupie. Wyjątek dla
     * pojedynczej grupy (stan MLS mógł jej nie mieć, np. po przeniesieniu
     * konta) nie może przerwać szukania — po prostu ta grupa nie pasuje.
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
