package com.mekamb.chat

import android.content.Context

/**
 * Wybór motywu i jego zapamiętanie.
 *
 * # Dlaczego zapisujemy wybór, a nie wynik
 *
 * [ZA_SYSTEMEM] zapisane jako wyliczony wynik znaczy, że telefon przełączony
 * wieczorem na ciemny zostawia aplikację jasną do końca świata — bo w chwili
 * zapisu system był jeszcze jasny. Wybór użytkownika to „idź za systemem",
 * a nie „bądź jasny", więc dokładnie to jest zapisywane, a rozwiązywane dopiero
 * przy składaniu interfejsu (patrz `MotywNocturne`).
 *
 * # Dlaczego domyślnie jasny
 *
 * Tak startowały dotychczasowe wydania i zmiana systemu wizualnego na
 * „Neutralny" tego nie rusza — kto nic nie wybierał, nie powinien po
 * aktualizacji obudzić się w innym motywie. Ciemny i „za systemem" są do
 * wyboru jawnego.
 *
 * # Dlaczego osobne `SharedPreferences`, a nie `Vault`
 *
 * `Vault` szyfruje wszystko kluczem z Android Keystore, bo trzyma ziarno
 * tożsamości i historię rozmów. Motyw nie jest tajemnicą, a wrzucenie go tam
 * kazałoby odszyfrować skarbiec, zanim w ogóle da się cokolwiek narysować —
 * czyli opóźniłoby pierwszy ekran o operację kryptograficzną dla ustawienia
 * kosmetycznego.
 */
enum class WyborMotywu {
    CIEMNY,
    JASNY,
    ZA_SYSTEMEM;

    /** Etykieta w interfejsie. */
    val etykieta: String
        get() = when (this) {
            CIEMNY -> "Ciemny"
            JASNY -> "Jasny"
            ZA_SYSTEMEM -> "Systemowy"
        }
}

object Motyw {

    private const val PLIK = "mekamb.wyglad"
    private const val KLUCZ = "motyw"

    fun wczytaj(context: Context): WyborMotywu {
        val zapisane = context
            .getSharedPreferences(PLIK, Context.MODE_PRIVATE)
            .getString(KLUCZ, null)

        // Wartość spoza zbioru bierze się ze starszego wydania albo z ręcznej
        // edycji pliku. Jasny jest domyślny, więc to bezpieczny powrót.
        return WyborMotywu.entries.firstOrNull { it.name == zapisane } ?: WyborMotywu.JASNY
    }

    fun zapisz(context: Context, wybor: WyborMotywu) {
        context
            .getSharedPreferences(PLIK, Context.MODE_PRIVATE)
            .edit()
            .putString(KLUCZ, wybor.name)
            .apply()
    }

    /**
     * Wybrany wygląd akcji głównej — domyślnie [Akcent.NEUTRALNY].
     *
     * Ten sam plik `SharedPreferences` co motyw — oba są ustawieniami wyglądu,
     * nie tajemnicą, więc nie idą do szyfrowanego `Vault`, który trzeba by
     * odblokować, zanim cokolwiek się narysuje.
     */
    private const val KLUCZ_AKCENT = "akcent"

    fun wczytajAkcent(context: Context): Akcent {
        val zapisane = context
            .getSharedPreferences(PLIK, Context.MODE_PRIVATE)
            .getString(KLUCZ_AKCENT, null)
        // Brak zapisu znaczy „nikt jeszcze nie wybierał", więc dostaje domyślny
        // wygląd systemu — neutralny. Kto wybrał kolor jawnie, ma go zapisanego
        // i zostaje przy nim.
        return Akcent.entries.firstOrNull { it.name == zapisane } ?: Akcent.NEUTRALNY
    }

    fun zapiszAkcent(context: Context, akcent: Akcent) {
        context
            .getSharedPreferences(PLIK, Context.MODE_PRIVATE)
            .edit()
            .putString(KLUCZ_AKCENT, akcent.name)
            .apply()
    }

    /**
     * Wybrany język interfejsu.
     *
     * Ten sam plik co motyw i akcent — kolejne ustawienie wyglądu, które musi
     * działać od pierwszego ekranu, jeszcze przed odblokowaniem `Vault`.
     * Domyślnie angielski — główny język projektu; polski jest wyborem
     * w ustawieniach i na ekranie powitania.
     */
    private const val KLUCZ_JEZYK = "jezyk"

    fun wczytajJezyk(context: Context): Jezyk {
        val zapisane = context
            .getSharedPreferences(PLIK, Context.MODE_PRIVATE)
            .getString(KLUCZ_JEZYK, null)
        return Jezyk.entries.firstOrNull { it.name == zapisane } ?: Jezyk.EN
    }

    fun zapiszJezyk(context: Context, jezyk: Jezyk) {
        context
            .getSharedPreferences(PLIK, Context.MODE_PRIVATE)
            .edit()
            .putString(KLUCZ_JEZYK, jezyk.name)
            .apply()
    }
}
