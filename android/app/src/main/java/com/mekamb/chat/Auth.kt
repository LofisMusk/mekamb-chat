package com.mekamb.chat

import android.util.Base64
import kotlinx.coroutines.Dispatchers
import kotlinx.coroutines.withContext
import uniffi.mekamb_ffi.opaqueLoginFinish
import uniffi.mekamb_ffi.opaqueLoginStart
import uniffi.mekamb_ffi.opaqueRegisterFinish
import uniffi.mekamb_ffi.opaqueRegisterStart

/**
 * Uwierzytelnianie klienta natywnego.
 *
 * # Hasło nie opuszcza tego urządzenia
 *
 * OPAQUE wykonuje kosztowną część obliczeń tutaj i wysyła na serwer wyłącznie
 * ślepe wartości. Serwer nigdy nie widzi hasła — ani przy rejestracji, ani przy
 * logowaniu — więc nie ma czego z niego wyciec.
 *
 * # Ten sam kod co na serwerze
 *
 * Kryptografia pochodzi z `mekamb-opaque` (Rust, RFC 9807) przez UniFFI.
 * Serwer używa tego samego kodu skompilowanego do WebAssembly, przeglądarka
 * również. Zgodność wynika z konstrukcji.
 *
 * Wcześniej było inaczej i to nie działało: serwer miał implementację
 * w TypeScripcie realizującą **draft-07** protokołu, a klient natywny miałby
 * rustową realizującą **RFC 9807**. Te dwie nigdy by się nie dogadały —
 * nie „mniej bezpiecznie", tylko logowanie, które nigdy nie przechodzi.
 */
object Auth {

    /** Zakłada konto. Nieaktywne aż do [confirmRegistration]. */
    suspend fun register(
        api: Api,
        username: String,
        password: String,
    ): RegistrationResult = withContext(Dispatchers.Default) {
        val start = opaqueRegisterStart(password)

        val response = api.registerStart(username, start.request)
        val finish = opaqueRegisterFinish(start.state, password, username, response)

        // `exportKey` to klucz wyprowadzony z hasła, nieznany serwerowi.
        // Nadaje się do szyfrowania kopii, których serwer ma nie odczytać —
        // na razie go nie używamy i świadomie nigdzie nie wysyłamy.

        api.registerFinish(username, finish.upload)
    }

    /** Aktywuje konto pierwszym kodem z authenticatora. */
    suspend fun confirmRegistration(api: Api, username: String, code: String) {
        api.registerConfirm(username, code)
    }

    /**
     * Loguje i zwraca token dostępowy.
     *
     * Trzy rundy: wymiana OPAQUE, dowód klienta, drugi składnik. Samo hasło
     * nie wystarcza — serwer wydaje token dopiero po kodzie z authenticatora.
     */
    /**
     * Pierwszy krok: hasło.
     *
     * Rozdzielenie na dwa kroki nie jest kosmetyką. Przy jednym wywołaniu
     * z hasłem i kodem naraz każde niepowodzenie wyglądało tak samo, więc
     * użytkownik z pomyłką w haśle przepisywał kod z authenticatora w kółko.
     * Teraz złe hasło odpada tutaj i mówi o sobie wprost.
     *
     * Zwrócona sesja żyje po stronie serwera do czasu podania kodu.
     */
    suspend fun loginPassword(
        api: Api,
        username: String,
        password: String,
    ): SesjaLogowania = withContext(Dispatchers.Default) {
        val start = opaqueLoginStart(password)
        val (loginId, ke2) = api.loginStart(username, start.request)

        val finish = try {
            opaqueLoginFinish(start.state, password, username, ke2)
        } catch (e: Exception) {
            // Złe hasło i nieistniejące konto dają ten sam komunikat — serwer
            // celowo nie pozwala ich odróżnić, więc klient też nie może.
            throw IllegalArgumentException("nieprawidłowa nazwa użytkownika lub hasło", e)
        }

        api.loginFinish(loginId, username, finish.finalization)
        SesjaLogowania(loginId, username)
    }

    /** Drugi krok: kod z authenticatora. Zwraca token dostępowy. */
    suspend fun loginCode(
        api: Api,
        sesja: SesjaLogowania,
        code: String,
        deviceId: String,
    ): String = withContext(Dispatchers.Default) {
        api.loginTotp(sesja.loginId, code, deviceId)
    }
}

/** Sesja między krokiem hasła a krokiem kodu. */
data class SesjaLogowania(val loginId: String, val username: String)

data class RegistrationResult(val totpSecret: String, val otpauthUri: String)

/** Kodowanie base64 zgodne z tym, którego używa serwer. */
internal fun ByteArray.toBase64(): String = Base64.encodeToString(this, Base64.NO_WRAP)

internal fun String.fromBase64(): ByteArray = Base64.decode(this, Base64.NO_WRAP)
