package com.mekamb.chat

import android.util.Base64
import kotlinx.coroutines.Dispatchers
import kotlinx.coroutines.withContext
import kotlinx.serialization.json.Json
import kotlinx.serialization.json.JsonObject
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

    /** Rejestruje urządzenie w katalogu i odświeża jego adres iroh. */
    suspend fun registerDevice(
        token: String,
        deviceId: String,
        mlsPublicKey: ByteArray,
        irohEndpointId: String?,
    ) {
        postJson(
            "/devices",
            buildJsonObject {
                put("deviceId", deviceId)
                put("mlsPublicKey", base64(mlsPublicKey))
                // Klient natywny MA adres — to główna różnica względem
                // przeglądarki, której nie da się bezpośrednio osiągnąć.
                irohEndpointId?.let { put("irohNodeId", it) }
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

    data class Device(val deviceId: String, val irohNodeId: String?)

    /**
     * Wyszukuje urządzenia użytkownika.
     *
     * `irohNodeId` bywa `null` — tak wygląda klient webowy, do którego nie da
     * się zadzwonić. Wywołujący musi wtedy pójść przez skrzynkę.
     */
    suspend fun lookupDevices(username: String): List<Device> = withContext(Dispatchers.IO) {
        val odpowiedz = get("/directory/$username")
        odpowiedz["devices"]?.jsonArray.orEmpty().map { wpis ->
            val obiekt = wpis as JsonObject
            Device(
                deviceId = obiekt["deviceId"]!!.jsonPrimitive.content,
                irohNodeId = obiekt["irohNodeId"]?.jsonPrimitive?.contentOrNull(),
            )
        }
    }

    /** Pobiera jednorazowy key package urządzenia. */
    suspend fun claimKeyPackage(deviceId: String): ByteArray {
        val odpowiedz = postJson("/key-packages/$deviceId/claim", buildJsonObject {}, null)
        return Base64.decode(odpowiedz["keyPackage"]!!.jsonPrimitive.content, Base64.NO_WRAP)
    }

    /** Zgłasza commit do rozstrzygnięcia kolejności. */
    suspend fun submitCommit(groupId: ByteArray, epoch: ULong, commit: ByteArray): Boolean {
        val body = buildJsonObject {
            put("epoch", epoch.toLong())
            put("commit", base64(commit))
        }

        return try {
            postJson("/groups/${hex(groupId)}/commit", body, null)
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
