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
 * # Dlaczego domyślnie ciemny, a nie za systemem
 *
 * Nocturne jest systemem ciemnym z założenia. Wariant jasny dołożyliśmy dla
 * tych, którzy go potrzebują, a nie po to, żeby stał się domyślny na połowie
 * urządzeń. Kto chce iść za systemem, wybiera to jawnie.
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
        // edycji pliku. Ciemny jest domyślny, więc to bezpieczny powrót.
        return WyborMotywu.entries.firstOrNull { it.name == zapisane } ?: WyborMotywu.CIEMNY
    }

    fun zapisz(context: Context, wybor: WyborMotywu) {
        context
            .getSharedPreferences(PLIK, Context.MODE_PRIVATE)
            .edit()
            .putString(KLUCZ, wybor.name)
            .apply()
    }
}
