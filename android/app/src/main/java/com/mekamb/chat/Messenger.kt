package com.mekamb.chat

import kotlinx.coroutines.CoroutineScope
import kotlinx.coroutines.Dispatchers
import kotlinx.coroutines.isActive
import kotlinx.coroutines.launch
import kotlinx.coroutines.withContext
import uniffi.mekamb_ffi.DeliveryMode
import uniffi.mekamb_ffi.IncomingEvent
import uniffi.mekamb_ffi.MekambClient
import uniffi.mekamb_ffi.MekambTransport
import uniffi.mekamb_ffi.tryDirectDelivery

/**
 * Warstwa spinająca rdzeń w Rust z siecią.
 *
 * # Tu klient natywny różni się od webowego
 *
 * Android ma pełny transport iroh: przebija NAT i łączy się **wprost** z drugim
 * urządzeniem. Skrzynka na serwerze wchodzi do gry dopiero, gdy odbiorcy nie da
 * się osiągnąć. W przeglądarce jest odwrotnie — tam pośrednik jest zawsze,
 * bo sandbox nie pozwala na połączenia przychodzące.
 *
 * # Stan zapisujemy po każdej zmianie
 *
 * MLS przesuwa ratchet przy wysyłce i odbiorze. Pominięcie zapisu po
 * którejkolwiek operacji cofa klienta do starej epoki i sprawia, że przestaje
 * cokolwiek odszyfrowywać. Dlatego zapis jest wpleciony w każdą ścieżkę tutaj,
 * a nie zostawiony wywołującemu.
 */
class Messenger private constructor(
    private val client: MekambClient,
    private val transport: MekambTransport,
    private val api: Api,
    private val vault: Vault,
    val account: Account,
    private val token: String,
) {

    companion object {
        /** Tworzy nową tożsamość urządzenia albo odtwarza zapisaną. */
        suspend fun open(
            vault: Vault,
            api: Api,
            account: Account,
            token: String,
        ): Messenger = withContext(Dispatchers.IO) {
            val seed = vault.loadSeed()
            val state = vault.loadState()

            val client = if (seed != null && state != null) {
                MekambClient.restore(account.userId, account.deviceId, seed, state)
            } else {
                MekambClient(account.userId, account.deviceId).also {
                    vault.saveSeed(it.exportSeed())
                    vault.saveState(it.exportState())
                }
            }

            // Klucz transportowy jest wyprowadzany z tego samego ziarna, ale
            // rozłączną etykietą HKDF — patrz docs/PROTOCOL.md.
            // `start` jest w UniFFI konstruktorem drugorzędnym, więc trafia do
            // companion object — konstruktor klasy przyjmuje uchwyt natywny.
            val transport = MekambTransport.start(client.irohSecret())

            Messenger(client, transport, api, vault, account, token)
        }
    }

    /** Adresy, pod którymi urządzenie jest osiągalne. */
    fun addresses(): List<String> = transport.addresses()

    /** Zgłasza urządzenie do katalogu wraz z adresami P2P. */
    suspend fun registerDevice() {
        api.registerDevice(
            token = token,
            deviceId = account.deviceId,
            mlsPublicKey = client.mlsPublicKey(),
            transportKey = transport.publicKey(),
            transportAddresses = transport.addresses(),
        )
    }

    /** Publikuje zapas key packages. */
    suspend fun publishKeyPackages(ile: Int = 10) = withContext(Dispatchers.IO) {
        val pakiety = List(ile) { client.createKeyPackage() }

        // Zapis PRZED wysyłką: klucze prywatne pakietów są już w magazynie,
        // a ich utrata oznaczałaby brak możliwości dołączenia do grupy,
        // do której ktoś nas właśnie zaprosił.
        vault.saveState(client.exportState())
        api.publishKeyPackages(token, account.deviceId, pakiety)
    }

    /** Zakłada rozmowę z użytkownikiem i zwraca identyfikator grupy. */
    suspend fun startConversation(peerUsername: String): ByteArray = withContext(Dispatchers.IO) {
        val urzadzenia = api.lookupDevices(peerUsername)
        val urzadzenie = urzadzenia.firstOrNull()
            ?: error("użytkownik $peerUsername nie ma zarejestrowanych urządzeń")

        val keyPackage = api.claimKeyPackage(urzadzenie.deviceId)

        val groupId = client.createConversation()
        val oczekujacy = client.addMember(groupId, keyPackage)

        val przyjety = api.submitCommit(token, groupId, client.epoch(groupId), oczekujacy.commit)
        if (!przyjety) {
            // Relay odrzucił commit — ktoś zmienił grupę w międzyczasie.
            // Scalenie na siłę wypchnęłoby nas poza rozmowę.
            client.discardCommit(groupId)
            vault.saveState(client.exportState())
            error("ktoś zmienił grupę w międzyczasie — spróbuj ponownie")
        }

        client.confirmCommit(groupId)
        vault.saveState(client.exportState())

        oczekujacy.welcome?.let { welcome ->
            wyslij(peerUsername, urzadzenie, welcome)
        }

        groupId
    }

    /** Szyfruje i wysyła wiadomość tekstową. */
    suspend fun sendText(
        groupId: ByteArray,
        text: String,
        recipient: String,
    ): DeliveryMode = withContext(Dispatchers.IO) {
        val koperta = client.sealText(groupId, text, System.currentTimeMillis().toULong())

        // Ratchet przesunął się już przy szyfrowaniu, więc zapis musi nastąpić
        // nawet wtedy, gdy wysyłka po nim zawiedzie.
        vault.saveState(client.exportState())

        val urzadzenie = api.lookupDevices(recipient).firstOrNull()
        wyslij(recipient, urzadzenie, koperta)
    }

    /**
     * Dostarcza kopertę: najpierw bezpośrednio, w razie niepowodzenia do skrzynki.
     *
     * Nieosiągalny odbiorca **nie jest błędem** — ma pełne prawo być offline.
     */
    private suspend fun wyslij(
        recipient: String,
        urzadzenie: Api.Device?,
        koperta: ByteArray,
    ): DeliveryMode {
        val sposob = tryDirectDelivery(
            transport,
            urzadzenie?.transportKey,
            urzadzenie?.transportAddresses.orEmpty(),
            koperta,
        )

        if (sposob == DeliveryMode.MAILBOX) {
            api.deposit(recipient, koperta)
        }

        return sposob
    }

    /**
     * Pętla odbioru połączeń przychodzących.
     *
     * Blokujące `receiveNext` chodzi na `Dispatchers.IO`, bo runtime asynchroniczny
     * mieszka po stronie Rusta — uzasadnienie w `core/bindings/uniffi/src/lib.rs`.
     */
    fun startReceiving(scope: CoroutineScope, onEvent: (IncomingEvent) -> Unit) {
        scope.launch(Dispatchers.IO) {
            while (isActive) {
                val koperta = runCatching { transport.receiveNext() }.getOrNull() ?: break

                runCatching {
                    val zdarzenie = client.openEnvelope(koperta)
                    vault.saveState(client.exportState())
                    zdarzenie
                }.onSuccess(onEvent)
                // Błąd przetwarzania jednej koperty nie może zatrzymać pętli:
                // spreparowany pakiet z sieci jest sytuacją spodziewaną.
            }
        }
    }

    fun close() {
        transport.shutdown()
    }
}
