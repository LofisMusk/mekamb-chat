package com.mekamb.chat

import android.content.Context
import android.security.keystore.KeyGenParameterSpec
import android.security.keystore.KeyProperties
import java.security.KeyStore
import javax.crypto.Cipher
import javax.crypto.KeyGenerator
import javax.crypto.SecretKey
import javax.crypto.spec.GCMParameterSpec

/**
 * Trwały magazyn tożsamości i stanu MLS.
 *
 * # Co tu leży i czym jest chronione
 *
 * Ziarno urządzenia (32 bajty) i zrzut stanu MLS — oba zawierają klucze
 * prywatne. Szyfrujemy je AES-GCM kluczem wygenerowanym **w Android Keystore**.
 *
 * Istotne jest, że ten klucz nigdy nie istnieje w pamięci aplikacji: system
 * trzyma go w bezpiecznym sprzęcie i wykonuje operacje w naszym imieniu.
 * Skopiowanie plików aplikacji na inne urządzenie daje więc bezużyteczny
 * szyfrogram — inaczej niż przy kluczu zapisanym obok danych.
 *
 * Czego to nie chroni: odblokowanej aplikacji na przejętym urządzeniu.
 * E2EE nie broni przed atakującym po Twojej stronie ekranu.
 */
class Vault(context: Context) {

    private val prefs = context.getSharedPreferences(PLIK, Context.MODE_PRIVATE)

    /** Zapisuje ziarno tożsamości urządzenia. */
    fun saveSeed(seed: ByteArray) = zapisz(KLUCZ_ZIARNO, seed)

    fun loadSeed(): ByteArray? = odczytaj(KLUCZ_ZIARNO)

    /** Zapisuje zrzut stanu MLS. Wołane po każdej operacji zmieniającej ratchet. */
    fun saveState(state: ByteArray) = zapisz(KLUCZ_STAN, state)

    fun loadState(): ByteArray? = odczytaj(KLUCZ_STAN)

    fun saveAccount(account: Account) {
        prefs.edit()
            .putString(KLUCZ_UZYTKOWNIK, account.username)
            .putString(KLUCZ_URZADZENIE, account.deviceId)
            .apply()
    }

    fun loadAccount(): Account? {
        val username = prefs.getString(KLUCZ_UZYTKOWNIK, null) ?: return null
        val deviceId = prefs.getString(KLUCZ_URZADZENIE, null) ?: return null
        return Account(username = username, deviceId = deviceId)
    }

    /**
     * Kasuje wszystko wraz z kluczem w Keystore.
     *
     * Po tym kroku historia rozmów jest nie do odzyskania — serwer jej nie ma.
     */
    fun wipe() {
        prefs.edit().clear().apply()
        runCatching { keyStore().deleteEntry(ALIAS_KLUCZA) }
    }

    private fun zapisz(nazwa: String, dane: ByteArray) {
        val cipher = Cipher.getInstance(TRANSFORMACJA).apply {
            init(Cipher.ENCRYPT_MODE, kluczSzyfrujacy())
        }

        // Wektor inicjujący generuje sam Keystore. Doklejamy go przed
        // szyfrogramem, żeby odczyt nie potrzebował osobnego pola.
        val szyfrogram = cipher.doFinal(dane)
        val spakowane = cipher.iv + szyfrogram

        prefs.edit()
            .putString(nazwa, android.util.Base64.encodeToString(spakowane, android.util.Base64.NO_WRAP))
            .apply()
    }

    private fun odczytaj(nazwa: String): ByteArray? {
        val zapisane = prefs.getString(nazwa, null) ?: return null
        val spakowane = android.util.Base64.decode(zapisane, android.util.Base64.NO_WRAP)

        if (spakowane.size <= DLUGOSC_IV) return null

        val cipher = Cipher.getInstance(TRANSFORMACJA).apply {
            init(
                Cipher.DECRYPT_MODE,
                kluczSzyfrujacy(),
                GCMParameterSpec(BITY_ZNACZNIKA, spakowane, 0, DLUGOSC_IV),
            )
        }

        return runCatching {
            cipher.doFinal(spakowane, DLUGOSC_IV, spakowane.size - DLUGOSC_IV)
        }.getOrNull()
    }

    /** Zwraca klucz z Keystore, tworząc go przy pierwszym użyciu. */
    private fun kluczSzyfrujacy(): SecretKey {
        val store = keyStore()
        (store.getEntry(ALIAS_KLUCZA, null) as? KeyStore.SecretKeyEntry)?.let { return it.secretKey }

        val generator = KeyGenerator.getInstance(KeyProperties.KEY_ALGORITHM_AES, DOSTAWCA)
        generator.init(
            KeyGenParameterSpec.Builder(
                ALIAS_KLUCZA,
                KeyProperties.PURPOSE_ENCRYPT or KeyProperties.PURPOSE_DECRYPT,
            )
                .setBlockModes(KeyProperties.BLOCK_MODE_GCM)
                .setEncryptionPaddings(KeyProperties.ENCRYPTION_PADDING_NONE)
                .setKeySize(256)
                // Świadomie NIE wymagamy uwierzytelnienia użytkownika przy każdej
                // operacji: klient musi odbierać wiadomości w tle, a klucz
                // wymagający odcisku palca uniemożliwiłby odszyfrowanie
                // czegokolwiek bez obecności użytkownika przy telefonie.
                .setUserAuthenticationRequired(false)
                .build(),
        )

        return generator.generateKey()
    }

    private fun keyStore(): KeyStore = KeyStore.getInstance(DOSTAWCA).apply { load(null) }

    private companion object {
        const val PLIK = "mekamb-vault"
        const val DOSTAWCA = "AndroidKeyStore"
        const val ALIAS_KLUCZA = "mekamb-magazyn"
        const val TRANSFORMACJA = "AES/GCM/NoPadding"
        const val DLUGOSC_IV = 12
        const val BITY_ZNACZNIKA = 128

        const val KLUCZ_ZIARNO = "ziarno"
        const val KLUCZ_STAN = "stan-mls"
        const val KLUCZ_UZYTKOWNIK = "uzytkownik"
        const val KLUCZ_URZADZENIE = "urzadzenie"
    }
}

data class Account(val username: String, val deviceId: String) {
    /** Identyfikator użytkownika w API. Na razie równy nazwie użytkownika. */
    val userId: String get() = username
}
