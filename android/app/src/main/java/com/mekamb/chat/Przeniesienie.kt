package com.mekamb.chat

import android.net.Uri
import android.util.Base64
import kotlinx.coroutines.Dispatchers
import kotlinx.coroutines.withContext
import kotlinx.serialization.json.Json
import kotlinx.serialization.json.jsonObject
import kotlinx.serialization.json.jsonPrimitive
import okhttp3.OkHttpClient
import okhttp3.Request
import java.nio.ByteBuffer
import java.util.concurrent.TimeUnit
import javax.crypto.Cipher
import javax.crypto.spec.GCMParameterSpec
import javax.crypto.spec.SecretKeySpec

/**
 * Odbiór konta przeniesionego z innego urządzenia.
 *
 * # Skąd bierze się klucz
 *
 * Z kodu, nie z serwera. Serwer przechowuje wyłącznie szyfrogram i nie ma go
 * czym otworzyć — klucz podróżuje w kodzie QR pokazywanym z ekranu na ekran.
 * Dlatego odbiór nie wymaga tokenu: urządzenie docelowe jeszcze nie ma konta,
 * a zabezpieczeniem jest nieodgadywalny identyfikator i szyfrowanie.
 *
 * # To jest przeniesienie, nie sklonowanie
 *
 * Po odebraniu **stare urządzenie musi przestać być używane**. Dwa urządzenia
 * z tą samą tożsamością MLS dzielą liść w drzewie grupy; gdy oba zaczną
 * wysyłać, ratchet się rozjedzie i obie strony przestaną się rozszyfrowywać.
 *
 * # Format
 *
 * Identyczny jak w kliencie webowym (`web/src/lib/przeniesienie.ts`) — inaczej
 * przeniesienie działałoby tylko między urządzeniami tego samego rodzaju, czyli
 * dokładnie nie wtedy, kiedy jest potrzebne. Zmiana układu pól po jednej
 * stronie wymaga zmiany po drugiej i podniesienia [WERSJA].
 */
object Przeniesienie {

    private const val SCHEMAT = "mekamb"
    private const val HOST = "transfer"

    /** Wersja formatu zrzutu. Musi zgadzać się z klientem webowym. */
    private const val WERSJA: Byte = 1

    /** Długość nonce'a AES-GCM. */
    private const val NONCE = 12

    /** Znacznik uwierzytelniający AES-GCM, w bitach. */
    private const val TAG_BITOW = 128

    private val http = OkHttpClient.Builder()
        .connectTimeout(10, TimeUnit.SECONDS)
        .readTimeout(30, TimeUnit.SECONDS)
        .build()

    private val json = Json { ignoreUnknownKeys = true }

    /** Czy tekst w ogóle wygląda na kod przeniesienia. */
    fun czyKodPrzeniesienia(tekst: String): Boolean =
        tekst.trim().startsWith("$SCHEMAT://$HOST?")

    /**
     * Pobiera zrzut, odszyfrowuje go i zapisuje konto na tym urządzeniu.
     *
     * Zwraca odebrane konto. Po powodzeniu urządzenie ma tożsamość źródła.
     */
    suspend fun odbierz(vault: Vault, baseUrl: String, kod: String): Account =
        withContext(Dispatchers.IO) {
            val oczyszczony = kod.trim()
            require(czyKodPrzeniesienia(oczyszczony)) { "to nie jest kod przeniesienia konta" }

            val uri = Uri.parse(oczyszczony)
            val identyfikator = uri.getQueryParameter("i")
            val kluczBase64 = uri.getQueryParameter("k")
            require(!identyfikator.isNullOrBlank() && !kluczBase64.isNullOrBlank()) {
                "kod przeniesienia jest niekompletny"
            }

            val ladunek = pobierz(baseUrl, identyfikator)
            val zrzut = odszyfruj(ladunek, zBase64url(kluczBase64))
            val (konto, ziarno, stan) = rozloz(zrzut)

            // Kolejność ma znaczenie: konto na końcu. To ono decyduje, czy
            // aplikacja uzna urządzenie za skonfigurowane, więc zapisane jako
            // pierwsze zostawiłoby przy przerwanym zapisie konto bez kluczy —
            // stan nie do naprawienia.
            vault.saveSeed(ziarno)
            vault.saveState(stan)
            vault.saveAccount(konto)

            konto
        }

    private fun pobierz(baseUrl: String, identyfikator: String): ByteArray {
        val zadanie = Request.Builder()
            .url("$baseUrl/transfer/$identyfikator")
            .get()
            .build()

        http.newCall(zadanie).execute().use { odpowiedz ->
            if (!odpowiedz.isSuccessful) {
                // Zrzut jest jednorazowy i żyje kwadrans, więc to najczęstszy
                // błąd — komunikat ma od razu mówić, co zrobić.
                throw IllegalStateException(
                    "kod wygasł albo został już użyty; wygeneruj nowy na starym urządzeniu",
                )
            }
            return odpowiedz.body?.bytes() ?: throw IllegalStateException("pusta odpowiedź serwera")
        }
    }

    private fun odszyfruj(ladunek: ByteArray, klucz: ByteArray): ByteArray {
        require(ladunek.size > NONCE) { "zrzut jest uszkodzony" }

        val szyfr = Cipher.getInstance("AES/GCM/NoPadding")
        szyfr.init(
            Cipher.DECRYPT_MODE,
            SecretKeySpec(klucz, "AES"),
            GCMParameterSpec(TAG_BITOW, ladunek, 0, NONCE),
        )

        return try {
            szyfr.doFinal(ladunek, NONCE, ladunek.size - NONCE)
        } catch (e: Exception) {
            // Zły klucz i naruszony szyfrogram wyglądają tak samo i tak samo
            // się kończą — rozróżnianie ich dałoby atakującemu wyrocznię.
            throw IllegalArgumentException("kodu nie da się odczytać — sprawdź, czy jest cały", e)
        }
    }

    /**
     * Rozkłada zrzut: wersja, a potem trzy pola poprzedzone długością.
     *
     * Długości są konieczne — bez nich granice między kontem, ziarnem a stanem
     * byłyby domyślne, a pomyłka o jeden bajt dałaby zrzut, który wygląda na
     * poprawny i nie działa.
     */
    private fun rozloz(zrzut: ByteArray): Triple<Account, ByteArray, ByteArray> {
        require(zrzut.isNotEmpty() && zrzut[0] == WERSJA) {
            "zrzut pochodzi z innej wersji aplikacji"
        }

        val bufor = ByteBuffer.wrap(zrzut, 1, zrzut.size - 1)
        val czesci = List(3) {
            require(bufor.remaining() >= 4) { "zrzut jest uszkodzony" }
            val dlugosc = bufor.int
            require(dlugosc >= 0 && dlugosc <= bufor.remaining()) { "zrzut jest uszkodzony" }
            ByteArray(dlugosc).also(bufor::get)
        }

        val opis = json.parseToJsonElement(String(czesci[0], Charsets.UTF_8)).jsonObject
        val username = opis["username"]?.jsonPrimitive?.content
        val deviceId = opis["deviceId"]?.jsonPrimitive?.content
        require(!username.isNullOrBlank() && !deviceId.isNullOrBlank()) {
            "zrzut nie zawiera danych konta"
        }

        // `userId` z klienta webowego pomijamy świadomie: po obu stronach jest
        // równy nazwie użytkownika, a `Account` wylicza go z niej sam. Zapisanie
        // go osobno pozwoliłoby tym dwóm wartościom się rozjechać.
        return Triple(Account(username, deviceId), czesci[1], czesci[2])
    }

    /** base64url bez wypełniania — takie, jakie wkłada do kodu klient webowy. */
    private fun zBase64url(tekst: String): ByteArray =
        Base64.decode(tekst, Base64.URL_SAFE or Base64.NO_PADDING or Base64.NO_WRAP)
}
