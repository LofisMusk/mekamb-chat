package com.mekamb.chat

import androidx.compose.runtime.Composable
import androidx.compose.runtime.ReadOnlyComposable
import androidx.compose.runtime.staticCompositionLocalOf

/**
 * Język interfejsu i jego rozstrzyganie na miejscu użycia.
 *
 * # Dlaczego przełącznik, a nie napis dwujęzyczny
 *
 * Wcześniej Android nie miał wyboru języka wcale — każdy napis niósł obie wersje
 * naraz („Załóż konto · Create account"). Web ma przełącznik PL/EN (patrz
 * `web/src/lib/jezyk.ts`) i tak samo wygląda projekt „Mekamb Mobile": jedna
 * etykieta, którą przełącznik zamienia. Dwujęzyczny napis w każdym przycisku był
 * obejściem braku tego przełącznika, a nie decyzją.
 *
 * # Jak to działa
 *
 * [LokalnyJezyk] niesie wybór przez drzewo tak samo jak [LokalneKolory] niesie
 * akcent: zmiana przemalowuje całą gałąź. Ekrany nie trzymają dwóch napisów —
 * wołają [t], które oddaje właściwą połowę. Ta sama zasada „rola, nie wynik", co
 * przy motywie: przełącznik przełącza JĘZYK, a nie konkretne napisy.
 */
enum class Jezyk {
    PL,
    EN;

    /** Etykieta na przełączniku — krótka, wielkimi literami, jak w projekcie. */
    val etykieta: String
        get() = when (this) {
            PL -> "PL"
            EN -> "EN"
        }
}

/**
 * Bieżący język interfejsu.
 *
 * `staticCompositionLocalOf`, jak [LokalneKolory]: język zmienia się rzadko, więc
 * śledzenie odczytów byłoby płaceniem za nic — zmiana i tak przerysowuje gałąź.
 */
val LokalnyJezyk = staticCompositionLocalOf { Jezyk.PL }

/**
 * Wybiera połowę pary językowej wg [LokalnyJezyk].
 *
 * `@ReadOnlyComposable`, bo tylko czyta bieżący język i nie emituje niczego —
 * dzięki temu wolno jej wołać się w miejscach, które same nie są węzłami UI
 * (etykiety, `contentDescription`, treść przekazywana dalej jako `String`).
 */
@Composable
@ReadOnlyComposable
fun t(pl: String, en: String): String = t(LokalnyJezyk.current, pl, en)

/**
 * Wariant bez kontekstu Compose — gdy język trzeba rozstrzygnąć w miejscu, które
 * samo nie jest węzłem UI (lambda launchera, korutyna, callback). Wtedy język
 * odczytuje się raz na górze funkcji composable (`val jezyk = LokalnyJezyk.current`)
 * i podaje tutaj.
 */
fun t(jezyk: Jezyk, pl: String, en: String): String = when (jezyk) {
    Jezyk.PL -> pl
    Jezyk.EN -> en
}
