package com.mekamb.chat

import android.util.Base64
import kotlinx.coroutines.Dispatchers
import kotlinx.coroutines.withContext
import kotlinx.serialization.json.Json
import kotlinx.serialization.json.JsonObject
import kotlinx.serialization.json.add
import kotlinx.serialization.json.buildJsonArray
import kotlinx.serialization.json.buildJsonObject
import kotlinx.serialization.json.jsonArray
import kotlinx.serialization.json.jsonPrimitive
import kotlinx.serialization.json.put
import okhttp3.MediaType.Companion.toMediaType
import okhttp3.OkHttpClient
import okhttp3.Request
import okhttp3.RequestBody.Companion.toRequestBody
import java.util.concurrent.TimeUnit

/**
 * Klient HTTP backendu.
 *
 * # Czego ten klient NIE robi
 *
 * Nie przesyła treści. Do serwera trafiają wyłącznie koperty — nieprzezroczyste
 * bajty zaszyfrowane MLS — oraz metadane potrzebne do routingu. Klucze nie
 * opuszczają urządzenia w żadnym wywołaniu z tego pliku.
 */
class Api(private val baseUrl: String) {

    private val http = OkHttpClient.Builder()
        .connectTimeout(10, TimeUnit.SECONDS)
        .readTimeout(30, TimeUnit.SECONDS)
        .build()

    private val json = Json { ignoreUnknownKeys = true }

    class ApiException(val status: Int, message: String) : Exception(message)

    // --- uwierzytelnianie ---

    /** Runda 1 rejestracji: zwraca odpowiedź serwera OPAQUE. */
    suspend fun registerStart(username: String, request: ByteArray): ByteArray {
        val odpowiedz = postJson(
            "/auth/register/start",
            buildJsonObject {
                put("username", username)
                put("registrationRequest", base64(request))
            },
            null,
        )
        return odpowiedz["registrationResponse"]!!.jsonPrimitive.content.fromBase64()
    }

    /** Runda 2 rejestracji: zakłada konto i zwraca sekret TOTP. */
    suspend fun registerFinish(username: String, upload: ByteArray): RegistrationResult {
        val odpowiedz = postJson(
            "/auth/register/finish",
            buildJsonObject {
                put("username", username)
                put("registrationRecord", base64(upload))
            },
            null,
        )
        return RegistrationResult(
            totpSecret = odpowiedz["totpSecret"]!!.jsonPrimitive.content,
            otpauthUri = odpowiedz["otpauthUri"]!!.jsonPrimitive.content,
        )
    }

    /** Aktywuje konto kodem z authenticatora. */
    suspend fun registerConfirm(username: String, code: String) {
        postJson(
            "/auth/register/confirm",
            buildJsonObject {
                put("username", username)
                put("code", code)
            },
            null,
        )
    }

    /** Runda 1 logowania. Zwraca identyfikator sesji i odpowiedź OPAQUE. */
    suspend fun loginStart(username: String, request: ByteArray): Pair<String, ByteArray> {
        val odpowiedz = postJson(
            "/auth/login/start",
            buildJsonObject {
                put("username", username)
                put("ke1", base64(request))
            },
            null,
        )
        return odpowiedz["loginId"]!!.jsonPrimitive.content to
            odpowiedz["ke2"]!!.jsonPrimitive.content.fromBase64()
    }

    /** Runda 2 logowania: dowód klienta. */
    suspend fun loginFinish(loginId: String, username: String, finalization: ByteArray) {
        postJson(
            "/auth/login/finish",
            buildJsonObject {
                put("loginId", loginId)
                put("username", username)
                put("ke3", base64(finalization))
            },
            null,
        )
    }

    /** Runda 3: drugi składnik. Dopiero tutaj powstaje token dostępowy. */
    suspend fun loginTotp(loginId: String, code: String, deviceId: String): String {
        val odpowiedz = postJson(
            "/auth/login/totp",
            buildJsonObject {
                put("loginId", loginId)
                put("code", code)
                put("deviceId", deviceId)
            },
            null,
        )
        return odpowiedz["token"]!!.jsonPrimitive.content
    }

    // --- katalog i skrzynka ---

    /** Rejestruje urządzenie w katalogu i odświeża jego adres iroh. */
    suspend fun registerDevice(
        token: String,
        deviceId: String,
        mlsPublicKey: ByteArray,
        transportKey: ByteArray,
        transportAddresses: List<String>,
    ) {
        postJson(
            "/devices",
            buildJsonObject {
                put("deviceId", deviceId)
                put("mlsPublicKey", base64(mlsPublicKey))
                // Klient natywny MA adresy — to główna różnica względem
                // przeglądarki, której nie da się bezpośrednio osiągnąć.
                put("transportKey", base64(transportKey))
                put("transportAddresses", transportAddresses.joinToString(","))
                put("displayName", "Android")
            },
            token,
        )
    }

    /** Publikuje zapas key packages, żeby dało się nas dodać do grupy offline. */
    suspend fun publishKeyPackages(token: String, deviceId: String, packages: List<ByteArray>) {
        val body = buildJsonObject {
            put(
                "keyPackages",
                Json.parseToJsonElement(packages.joinToString(",", "[", "]") { "\"${base64(it)}\"" }),
            )
        }
        postJson("/key-packages/$deviceId", body, token)
    }

    data class Device(
        val deviceId: String,
        /** Klucz publiczny transportu. `null` = odbiorca tylko przez skrzynkę. */
        val transportKey: ByteArray?,
        val transportAddresses: List<String>,
    )

    /**
     * Wyszukuje urządzenia użytkownika.
     *
     * Klucz transportowy bywa `null` — tak wygląda klient webowy, do którego
     * nie da się zadzwonić. Wywołujący musi wtedy pójść przez skrzynkę.
     */
    suspend fun lookupDevices(username: String): List<Device> = withContext(Dispatchers.IO) {
        val odpowiedz = get("/directory/$username")
        odpowiedz["devices"]?.jsonArray.orEmpty().map { wpis ->
            val obiekt = wpis as JsonObject
            Device(
                deviceId = obiekt["deviceId"]!!.jsonPrimitive.content,
                transportKey = obiekt["transportKey"]?.jsonPrimitive?.contentOrNull()?.fromBase64(),
                transportAddresses = obiekt["transportAddresses"]
                    ?.jsonPrimitive?.contentOrNull()
                    ?.split(",")
                    ?.filter { it.isNotBlank() }
                    .orEmpty(),
            )
        }
    }

    /** Pobiera jednorazowy key package urządzenia. */
    suspend fun claimKeyPackage(deviceId: String): ByteArray {
        val odpowiedz = postJson("/key-packages/$deviceId/claim", buildJsonObject {}, null)
        return Base64.decode(odpowiedz["keyPackage"]!!.jsonPrimitive.content, Base64.NO_WRAP)
    }

    /**
     * Zgłasza commit do rozstrzygnięcia kolejności.
     *
     * Wymaga tokenu — inaczej serwer odrzuca żądanie i **żadna rozmowa nie
     * daje się rozpocząć**. Relay porządkuje epoki grupy, więc dopuszczenie tu
     * kogokolwiek pozwalałoby obcemu wywracać kolejność commitów.
     */
    suspend fun submitCommit(
        token: String,
        groupId: ByteArray,
        epoch: ULong,
        envelope: ByteArray,
        members: List<String>,
    ): Boolean {
        // Pola muszą nazywać się tak, jak czyta je serwer. Wcześniej szło stąd
        // `commit` bez listy członków, więc serwer odrzucał każdy commit
        // i ROZPOCZĘCIE ROZMOWY NA ANDROIDZIE BYŁO NIEMOŻLIWE.
        val body = buildJsonObject {
            put("epoch", epoch.toLong())
            put("envelope", base64(envelope))
            put("members", buildJsonArray { members.forEach { add(it) } })
        }

        return try {
            postJson("/groups/${hex(groupId)}/commit", body, token)
            true
        } catch (e: ApiException) {
            // 409 nie jest błędem klienta — znaczy „ktoś był pierwszy".
            // Wywołujący ma porzucić commit i spróbować ponownie.
            if (e.status == 409) false else throw e
        }
    }

    /** Zostawia kopertę w skrzynce odbiorcy. */
    suspend fun deposit(userId: String, envelope: ByteArray) = withContext(Dispatchers.IO) {
        val zadanie = Request.Builder()
            .url("$baseUrl/inbox/$userId")
            .post(envelope.toRequestBody(BINARNE))
            .build()

        http.newCall(zadanie).execute().use { odpowiedz ->
            if (!odpowiedz.isSuccessful) {
                throw ApiException(odpowiedz.code, "nie udało się zostawić wiadomości w skrzynce")
            }
        }
    }

    private suspend fun postJson(
        sciezka: String,
        body: JsonObject,
        token: String?,
    ): JsonObject = withContext(Dispatchers.IO) {
        val budowniczy = Request.Builder()
            .url("$baseUrl$sciezka")
            .post(body.toString().toRequestBody(JSON_MEDIA))

        token?.let { budowniczy.header("Authorization", "Bearer $it") }

        http.newCall(budowniczy.build()).execute().use { odpowiedz ->
            val tresc = odpowiedz.body?.string().orEmpty()
            if (!odpowiedz.isSuccessful) {
                throw ApiException(odpowiedz.code, bladZOdpowiedzi(tresc, odpowiedz.code))
            }
            if (tresc.isBlank()) JsonObject(emptyMap())
            else json.parseToJsonElement(tresc) as JsonObject
        }
    }

    private fun get(sciezka: String): JsonObject {
        val zadanie = Request.Builder().url("$baseUrl$sciezka").build()
        http.newCall(zadanie).execute().use { odpowiedz ->
            val tresc = odpowiedz.body?.string().orEmpty()
            if (!odpowiedz.isSuccessful) {
                throw ApiException(odpowiedz.code, bladZOdpowiedzi(tresc, odpowiedz.code))
            }
            return json.parseToJsonElement(tresc) as JsonObject
        }
    }

    private fun bladZOdpowiedzi(tresc: String, kod: Int): String = runCatching {
        (json.parseToJsonElement(tresc) as JsonObject)["error"]!!.jsonPrimitive.content
    }.getOrElse { "żądanie nie powiodło się ($kod)" }

    private fun base64(bytes: ByteArray) = Base64.encodeToString(bytes, Base64.NO_WRAP)

    private fun hex(bytes: ByteArray) = bytes.joinToString("") { "%02x".format(it) }

    private companion object {
        val JSON_MEDIA = "application/json".toMediaType()
        val BINARNE = "application/octet-stream".toMediaType()
    }
}

private fun kotlinx.serialization.json.JsonPrimitive.contentOrNull(): String? =
    if (this is kotlinx.serialization.json.JsonNull) null else content
