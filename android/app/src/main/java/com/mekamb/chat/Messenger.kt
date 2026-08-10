package com.mekamb.chat

import kotlinx.coroutines.CoroutineScope
import kotlinx.coroutines.Dispatchers
import kotlinx.coroutines.channels.Channel
import kotlinx.coroutines.isActive
import kotlinx.coroutines.launch
import kotlinx.coroutines.sync.Mutex
import kotlinx.coroutines.sync.withLock
import kotlinx.coroutines.withContext
import uniffi.mekamb_ffi.CallSignalKind
import uniffi.mekamb_ffi.DeliveryMode
import uniffi.mekamb_ffi.IncomingEvent
import uniffi.mekamb_ffi.MekambClient
import uniffi.mekamb_ffi.MekambTransport
import uniffi.mekamb_ffi.canStripMetadata
import uniffi.mekamb_ffi.maxAttachmentBytes
import uniffi.mekamb_ffi.openAttachment
import uniffi.mekamb_ffi.sealAttachment
import uniffi.mekamb_ffi.stripMetadata
import uniffi.mekamb_ffi.tryDirectDelivery

/**
 * Wynik wysyłki załącznika.
 *
 * `metadaneUsuniete = false` znaczy, że plik poszedł z metadanymi — interfejs
 * ma o tym powiedzieć wprost. Milczenie byłoby wprowadzaniem w błąd:
 * użytkownik ma prawo wiedzieć, że akurat to zdjęcie niesie lokalizację.
 */
data class WyslanyZalacznik(
    val zalacznik: Zalacznik,
    val metadaneUsuniete: Boolean,
    val sposob: DeliveryMode,
)

/**
 * Warstwa spinająca rdzeń w Rust z siecią.
 *
 * # Tu klient natywny różni się od webowego
 *
 * Android ma pełny transport: przebija NAT i łączy się **wprost** z drugim
 * urządzeniem. Przy WYSYŁCE skrzynka na serwerze wchodzi więc do gry dopiero
 * wtedy, gdy odbiorcy nie da się osiągnąć.
 *
 * Przy ODBIORZE tak nie jest i to kosztowało już jedną awarię. Rozmówca
 * z przeglądarki nie potrafi dostarczyć bezpośrednio — sandbox nie pozwala mu
 * wysłać pakietu UDP — więc jego wiadomości leżą wyłącznie w skrzynce.
 * Nasłuchiwanie samego transportu oznaczało, że web → Android nie docierało
 * nigdy, przy działającym kierunku odwrotnym. Dlatego [startReceiving]
 * uruchamia obie drogi naraz.
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
    /**
     * Token dostępowy.
     *
     * Widoczny na zewnątrz, bo przeniesienie konta wysyła zrzut własnym
     * żądaniem — nie przez `Messenger`, który zajmuje się rozmowami.
     */
    val token: String,
) {
    /** Szereguje dostęp do stanu MLS — patrz [przetworzKoperte]. */
    private val mlsMutex = Mutex()

    private var skrzynka: PolaczenieZeSkrzynka? = null
    private var kolejkaSkrzynki: Channel<Pair<ByteArray, (Long) -> Unit>>? = null

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

        // Skład PO commicie: nowa osoba musi znaleźć się na liście, do której
        // relay rozsyła, inaczej nie dostanie kolejnych commitów. `members()`
        // zwraca `user_id:device_id`, a serwer adresuje skrzynki po user_id.
        val czlonkowie = (
            client.members(groupId).map { it.substringBefore(':') } + peerUsername
        ).distinct()

        val przyjety =
            api.submitCommit(token, groupId, client.epoch(groupId), oczekujacy.commit, czlonkowie)
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

    /**
     * Skład rozmowy — nazwy użytkowników z drzewa MLS.
     *
     * `members()` zwraca `user_id:device_id`; jedna osoba może mieć kilka
     * urządzeń, więc powtórzenia odsiewamy.
     */
    fun uczestnicy(groupId: ByteArray): List<String> =
        client.members(groupId).map { it.substringBefore(':') }.distinct()

    /** Kod bezpieczeństwa rozmowy — do porównania poza aplikacją. */
    fun kodBezpieczenstwa(groupId: ByteArray): String? =
        runCatching { client.safetyNumber(groupId) }.getOrNull()

    /**
     * Dodaje osobę do rozmowy.
     *
     * Ta sama droga co przy zakładaniu rozmowy: key package z katalogu, commit
     * do relaya, welcome do nowej osoby.
     */
    suspend fun dodajCzlonka(groupId: ByteArray, peerUsername: String): Unit =
        withContext(Dispatchers.IO) {
            val urzadzenie = api.lookupDevices(peerUsername).firstOrNull()
                ?: error("użytkownik $peerUsername nie ma zarejestrowanych urządzeń")

            val keyPackage = api.claimKeyPackage(urzadzenie.deviceId)
            val oczekujacy = client.addMember(groupId, keyPackage)

            val czlonkowie = (uczestnicy(groupId) + peerUsername).distinct()
            val przyjety =
                api.submitCommit(token, groupId, client.epoch(groupId), oczekujacy.commit, czlonkowie)

            if (!przyjety) {
                client.discardCommit(groupId)
                vault.saveState(client.exportState())
                error("ktoś zmienił grupę w międzyczasie — spróbuj ponownie")
            }

            client.confirmCommit(groupId)
            vault.saveState(client.exportState())

            oczekujacy.welcome?.let { wyslij(peerUsername, urzadzenie, it) }
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
     * Wysyła załącznik: czyści metadane, szyfruje, wgrywa, rozsyła klucz.
     *
     * # Kolejność ma znaczenie
     *
     * Metadane usuwamy **przed** zaszyfrowaniem. Lokalizacja z EXIF-a
     * umieszczona w środku szyfrogramu dociera do odbiorcy dokładnie tak samo
     * jak treść — szyfrowanie nie chroni przed tym, co sami tam włożyliśmy.
     *
     * Szyfrogram idzie do R2, a klucz osobno, w wiadomości MLS. Serwer nigdy
     * nie ma obu naraz i to jest cały sens tego podziału.
     *
     * Zwraca `false` w drugim polu, gdy metadanych nie dało się usunąć —
     * użytkownik ma się o tym dowiedzieć wprost, a nie z milczenia.
     */
    suspend fun sendAttachment(
        groupId: ByteArray,
        bajty: ByteArray,
        mimeType: String,
        nazwaPliku: String?,
        recipient: String,
    ): WyslanyZalacznik = withContext(Dispatchers.IO) {
        // UniFFI zwraca `u64` jako `ULong` — porównanie z rozmiarem tablicy
        // wymaga wspólnego typu, a limit i tak mieści się w `Long`.
        val limit = maxAttachmentBytes().toLong()
        require(bajty.size.toLong() <= limit) {
            "plik jest za duży — limit to ${limit / 1024 / 1024} MB"
        }

        val (doWyslania, oczyszczone) = if (canStripMetadata(mimeType)) {
            runCatching { stripMetadata(bajty, mimeType) }
                .fold({ it to true }, { bajty to false })
        } else {
            bajty to false
        }

        val zapieczetowany = sealAttachment(doWyslania, mimeType)
        val blobId = api.uploadAttachment(token, zapieczetowany.ciphertext)

        val koperta = client.sealAttachmentMessage(
            groupId,
            blobId,
            zapieczetowany.key,
            zapieczetowany.nonce,
            mimeType,
            doWyslania.size.toULong(),
            nazwaPliku,
            System.currentTimeMillis().toULong(),
        )

        // Ratchet przesunął się już przy szyfrowaniu, więc zapis musi nastąpić
        // nawet wtedy, gdy wysyłka po nim zawiedzie.
        vault.saveState(client.exportState())

        val urzadzenie = api.lookupDevices(recipient).firstOrNull()
        val sposob = wyslij(recipient, urzadzenie, koperta)

        WyslanyZalacznik(
            zalacznik = Zalacznik(
                blobId = blobId,
                klucz = zapieczetowany.key,
                nonce = zapieczetowany.nonce,
                mimeType = mimeType,
                rozmiar = doWyslania.size.toLong(),
                nazwaPliku = nazwaPliku,
            ),
            metadaneUsuniete = oczyszczone,
            sposob = sposob,
        )
    }

    /**
     * Wysyła sygnał rozmowy A/V do jednego uczestnika.
     *
     * # Dlaczego odcisk DTLS jedzie osobno
     *
     * SDP przechodzi tą samą drogą co reszta ruchu, więc pośrednik może je
     * podmienić. Odcisk podróżuje **wewnątrz** MLS, którego podmienić nie może,
     * a odbiorca porównuje jedno z drugim przed zestawieniem połączenia.
     * Niezgodność znaczy podstawione połączenie — wtedy zrywamy.
     *
     * `target` jest konieczny, bo wiadomość MLS trafia do CAŁEJ grupy, a
     * w rozmowie mesh każda para negocjuje osobne połączenie. Bez adresata
     * trzecia osoba próbowałaby przetworzyć ofertę przeznaczoną dla kogoś
     * innego i zerwałaby własne.
     */
    suspend fun sendCallSignal(
        groupId: ByteArray,
        kind: CallSignalKind,
        callId: ByteArray,
        payload: String,
        dtlsFingerprint: String,
        target: String,
    ): Unit = withContext(Dispatchers.IO) {
        val koperta = client.sealCallSignal(
            groupId,
            kind,
            callId,
            payload,
            dtlsFingerprint,
            target,
            System.currentTimeMillis().toULong(),
        )

        // Ratchet przesunął się przy szyfrowaniu — zapis musi nastąpić nawet
        // wtedy, gdy wysyłka po nim zawiedzie.
        vault.saveState(client.exportState())

        val urzadzenie = api.lookupDevices(target).firstOrNull()
        wyslij(target, urzadzenie, koperta)
    }

    /** Pobiera szyfrogram załącznika i odszyfrowuje go na urządzeniu. */
    suspend fun openAttachment(zalacznik: Zalacznik): ByteArray = withContext(Dispatchers.IO) {
        val szyfrogram = api.downloadAttachment(token, zalacznik.blobId)
        openAttachment(szyfrogram, zalacznik.klucz, zalacznik.nonce, zalacznik.mimeType)
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
     * Otwiera kopertę i utrwala stan MLS.
     *
     * # Dlaczego pod zamkiem
     *
     * Koperty przychodzą teraz DWIEMA drogami naraz — wprost przez transport
     * i ze skrzynki. Obie przesuwają ten sam ratchet i obie zapisują ten sam
     * stan, więc bez szeregowania dwa wątki potrafiłyby przeplatać
     * `openEnvelope` z `exportState` i zapisać stan starszy niż wykonana już
     * operacja. Skutkiem byłby klient cofnięty do poprzedniej epoki, czyli
     * dokładnie ta awaria, przed którą chroni zapis po każdej zmianie.
     */
    private suspend fun przetworzKoperte(koperta: ByteArray): IncomingEvent = mlsMutex.withLock {
        val zdarzenie = client.openEnvelope(koperta)
        vault.saveState(client.exportState())
        zdarzenie
    }

    /**
     * Uruchamia odbiór: transport P2P **i** skrzynkę.
     *
     * # Dlaczego obie drogi, a nie sam transport
     *
     * Rozmówca z przeglądarki nie potrafi dostarczyć bezpośrednio — sandbox nie
     * pozwala mu wysłać pakietu UDP — więc jego wiadomości leżą wyłącznie
     * w skrzynce. Sam transport oznaczał, że web → Android nie docierało nigdy.
     *
     * Blokujące `receiveNext` chodzi na `Dispatchers.IO`, bo runtime asynchroniczny
     * mieszka po stronie Rusta — uzasadnienie w `core/bindings/uniffi/src/lib.rs`.
     */
    fun startReceiving(scope: CoroutineScope, onEvent: (IncomingEvent, DeliveryMode) -> Unit) {
        // Powtórne uruchomienie porzucałoby poprzednie gniazdo bez zamknięcia:
        // wisiałoby dalej, wznawiało się i przetwarzało koperty równolegle
        // z nowym. Podmiana referencji sama tego nie sprząta.
        skrzynka?.zamknij()
        kolejkaSkrzynki?.close()

        scope.launch(Dispatchers.IO) {
            while (isActive) {
                val koperta = runCatching { transport.receiveNext() }.getOrNull() ?: break

                runCatching { przetworzKoperte(koperta) }
                    .onSuccess { onEvent(it, DeliveryMode.DIRECT) }
                // Błąd przetwarzania jednej koperty nie może zatrzymać pętli:
                // spreparowany pakiet z sieci jest sytuacją spodziewaną.
            }
        }

        // Ramki idą przez kolejkę, a nie każda we własnej korutynie, bo commity
        // MLS muszą zostać zastosowane w kolejności nadania. Serwer wysyła je
        // po kolei i ta kolejność musi przetrwać do `openEnvelope`.
        //
        // `trySend` do kolejki bez ograniczenia nie blokuje wątku czytającego
        // gniazdo, więc odbiór nie czeka na przetworzenie poprzedniej koperty.
        val kolejka = Channel<Pair<ByteArray, (Long) -> Unit>>(Channel.UNLIMITED)

        scope.launch(Dispatchers.IO) {
            val licznik = LicznikProb()

            for ((ramka, potwierdz) in kolejka) {
                obsluzRamke(
                    ramka = ramka,
                    licznik = licznik,
                    przetworz = { koperta -> onEvent(przetworzKoperte(koperta), DeliveryMode.MAILBOX) },
                    potwierdz = potwierdz,
                )
            }
        }

        skrzynka = api.polaczZeSkrzynka(
            userId = account.userId,
            naRamke = { ramka, potwierdz -> kolejka.trySend(ramka to potwierdz) },
        )
        kolejkaSkrzynki = kolejka
    }

    fun close() {
        skrzynka?.zamknij()
        skrzynka = null
        kolejkaSkrzynki?.close()
        kolejkaSkrzynki = null
        transport.shutdown()
    }
}
