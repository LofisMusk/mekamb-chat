package com.mekamb.chat

/**
 * Uwierzytelnianie klienta natywnego.
 *
 * # Stan: NIEDOKOŃCZONE — i to celowo widoczne
 *
 * Ten obiekt nie loguje. Zgłasza jawny błąd zamiast udawać, że przeszło —
 * atrapa zwracająca fałszywy token byłaby gorsza niż brak funkcji, bo reszta
 * aplikacji zachowywałaby się tak, jakby użytkownik był uwierzytelniony.
 *
 * # Na czym polega problem
 *
 * Serwer używa OPAQUE w implementacji TypeScript (`@cloudflare/opaque-ts`).
 * Klient webowy korzysta z **tej samej** biblioteki, więc zgodność jest
 * zagwarantowana z definicji. Android nie może jej użyć i potrzebuje
 * implementacji natywnej — najrozsądniej `opaque-ke` w rdzeniu Rust, wystawione
 * przez UniFFI obok reszty API.
 *
 * Haczyk: **dwie niezależne implementacje tego samego szkicu RFC nie są
 * automatycznie zgodne na poziomie bajtów.** Muszą się zgadzać: zestaw OPRF
 * (P-256), KDF, MAC, funkcja skrótu oraz funkcja rozciągania klucza — Cloudflare
 * domyślnie nie rozciąga wcale, a `opaque-ke` owszem. Rozjazd w którymkolwiek
 * z tych elementów daje nie „gorsze bezpieczeństwo", tylko logowanie, które
 * po prostu nigdy nie przechodzi.
 *
 * # Co trzeba zrobić
 *
 * 1. Dodać `opaque-ke` do rdzenia z konfiguracją odwzorowującą `OPAQUE_P256`.
 * 2. Napisać test zgodności: rejestracja w Rust, logowanie przez prawdziwy
 *    Worker. Bez tego testu nie ma podstaw twierdzić, że to działa.
 * 3. Dopiero po jego przejściu wystawić rejestrację i logowanie przez UniFFI.
 *
 * Gdyby zgodność okazała się nieosiągalna, alternatywą jest przeniesienie
 * serwerowej strony OPAQUE na Rust skompilowany do WASM — wtedy obie strony
 * pochodzą z jednej implementacji. To większa zmiana, ale usuwa całą klasę
 * problemów ze zgodnością.
 */
object Auth {

    /**
     * Przeprowadza logowanie i zwraca token dostępowy.
     *
     * @throws NotImplementedError dopóki natywny OPAQUE nie jest gotowy.
     */
    @Suppress("UNUSED_PARAMETER")
    suspend fun zaloguj(api: Api, username: String, haslo: String, kod: String): String {
        throw NotImplementedError(
            "Logowanie na Androidzie wymaga natywnego klienta OPAQUE. " +
                "Szczegóły i plan w komentarzu przy com.mekamb.chat.Auth.",
        )
    }
}
