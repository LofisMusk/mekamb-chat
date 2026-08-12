package com.mekamb.chat

import android.util.Base64

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
import uniffi.mekamb_ffi.ReceiptKind
import uniffi.mekamb_ffi.MekambTransport
import uniffi.mekamb_ffi.canStripMetadata
import uniffi.mekamb_ffi.maxAttachmentBytes
import uniffi.mekamb_ffi.openAttachment
import uniffi.mekamb_ffi.sealAttachment
import uniffi.mekamb_ffi.stripMetadata
import uniffi.mekamb_ffi.tokenOdslon
import uniffi.mekamb_ffi.tokenOslep
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
    /** Identyfikator z rdzenia — po nim wracają potwierdzenia. */
    val messageId: ByteArray,
)

/** Wysłana wiadomość: którą drogą poszła i pod jakim identyfikatorem. */
data class WyslanaWiadomosc(
    val sposob: DeliveryMode,
    val messageId: ByteArray,
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

    /**
     * Portfel tokenów doręczeniowych.
     *
     * Zapas bierzemy z góry i wydajemy pojedynczo: pobranie jest żądaniem
     * uwierzytelnionym, więc branie tokenu tuż przed każdą wiadomością dałoby
     * serwerowi dokładnie to powiązanie, które ten schemat usuwa.
     */
    private var portfel: PortfelTokenow? = null

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

    /**
     * Otwiera rozmowy zapisane na dysku.
     *
     * # Czemu to musiało powstać
     *
     * Stan MLS przeżywał restart w magazynie, ale lista OTWARTYCH rozmów
     * powstawała wyłącznie przy zakładaniu grupy albo przyjmowaniu zaproszenia.
     * Po restarcie klient miał pełny stan na dysku i pustą listę — każde
     * wysłanie i odebranie kończyło się „nie ma takiej rozmowy w tym kliencie".
     *
     * Identyfikatory znamy z własnej historii, więc otwieramy je sami. Rozmowa
     * bez stanu MLS (np. po przeniesieniu konta) po prostu się nie otworzy —
     * zostaje w historii do czytania i tyle.
     */
    fun otworzZnaneRozmowy(groupIds: List<ByteArray>) {
        for (groupId in groupIds) {
            // Uszkodzony wpis nie może zablokować pozostałych rozmów.
            runCatching { client.openConversation(groupId) }
        }
    }

    /** Podpina portfel tokenów. Wołane raz, po zalogowaniu. */
    fun ustawPortfel(nowy: PortfelTokenow) {
        portfel = nowy
    }

    /**
     * Uzupełnia zapas tokenów, jeśli zszedł poniżej progu.
     *
     * Cicha przy każdym niepowodzeniu: wdrożenie bez skonfigurowanych tokenów
     * odpowiada 503 i to jest poprawny stan, nie awaria. Brak tokenów nie może
     * zatrzymać wysyłania.
     */
    suspend fun uzupelnijTokeny() {
        val portfel = portfel ?: return
        if (!portfel.trzebaDobrac()) return

        runCatching {
            val kluczPubliczny = api.kluczTokenow() ?: return

            // Przypięcie klucza: serwer wydający różnym osobom tokeny różnymi
            // kluczami ZNAKUJE je. Dowód wykrywa użycie innego klucza niż
            // podany, ale nie to, że sam klucz podstawiono pod nas.
            if (!portfel.przypnijKlucz(kluczPubliczny)) return

            val proby = List(PortfelTokenow.DOCELOWY) { tokenOslep() }
            val wydane = api.wydajTokeny(token, proby.map { it.oslepione })
            val klucz = kluczPubliczny.fromBase64()

            val nowe = wydane.mapIndexedNotNull { i, (ocenione, wyzwanie, odpowiedz) ->
                val proba = proby.getOrNull(i) ?: return@mapIndexedNotNull null

                // Odrzucony token pomijamy zamiast wywracać całe uzupełnienie:
                // jeden zły nie może kosztować pozostałych.
                runCatching {
                    val gotowy = tokenOdslon(proba, ocenione, wyzwanie, odpowiedz, klucz)
                    TokenDoreczenia(
                        Base64.encodeToString(gotowy.ziarno, Base64.NO_WRAP),
                        Base64.encodeToString(gotowy.odslonione, Base64.NO_WRAP),
                    )
                }.getOrNull()
            }

            portfel.doloz(nowe)
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

        /*
         * Do serwera idzie sam numer epoki.
         *
         * Ani commit, ani skład grupy — serwer rozstrzyga wyłącznie KOLEJNOŚĆ.
         * Wcześniej dostawał jedno i drugie, bo sam rozsyłał commity, i była to
         * jedyna w systemie struktura mówiąca mu wprost, kto z kim rozmawia.
         */
        val przyjety = api.zajmijEpoke(token, client.relayId(groupId), client.epoch(groupId))
        if (!przyjety) {
            // Relay odrzucił commit — ktoś zmienił grupę w międzyczasie.
            // Scalenie na siłę wypchnęłoby nas poza rozmowę.
            client.discardCommit(groupId)
            vault.saveState(client.exportState())
            error("ktoś zmienił grupę w międzyczasie — spróbuj ponownie")
        }

        client.confirmCommit(groupId)
        vault.saveState(client.exportState())

        // Rozsyłkę commitu robi nadawca — patrz `dodajCzlonka`. Przy zakładaniu
        // rozmowy nie ma jednak komu go wysłać: w grupie jesteśmy my i osoba,
        // którą właśnie zapraszamy, a ona dostaje `welcome`.
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

            val przyjety = api.zajmijEpoke(token, client.relayId(groupId), client.epoch(groupId))

            if (!przyjety) {
                client.discardCommit(groupId)
                vault.saveState(client.exportState())
                error("ktoś zmienił grupę w międzyczasie — spróbuj ponownie")
            }

            client.confirmCommit(groupId)
            vault.saveState(client.exportState())

            /*
             * Rozsyłamy commit sami — po zajęciu epoki, nie przed.
             *
             * Kolejność ma znaczenie: rozesłanie przed potwierdzeniem oznaczałoby
             * wysłanie commitu, który relay może odrzucić, a odbiorcy nie mają
             * jak cofnąć tego, co już przetworzyli.
             *
             * Nowa osoba jest pomijana: dostaje `welcome`, a commitu, który ją
             * wprowadza do grupy, nie potrafi przetworzyć.
             */
            for (osoba in uczestnicy(groupId)) {
                if (osoba == peerUsername || osoba == account.userId) continue
                api.deposit(osoba, oczekujacy.commit)
            }

            oczekujacy.welcome?.let { wyslij(peerUsername, urzadzenie, it) }
        }

    /**
     * Szyfruje i wysyła wiadomość tekstową.
     *
     * Zwraca też identyfikator z rdzenia: potwierdzenia drugiej strony wskazują
     * wiadomości właśnie po nim, więc bez zapisania go ptaszek nigdy by się nie
     * zmienił — i nikt nie wiedziałby dlaczego.
     */
    suspend fun sendText(
        groupId: ByteArray,
        text: String,
        recipient: String,
    ): WyslanaWiadomosc = withContext(Dispatchers.IO) {
        val zapakowana = client.sealText(groupId, text, System.currentTimeMillis().toULong())

        // Ratchet przesunął się już przy szyfrowaniu, więc zapis musi nastąpić
        // nawet wtedy, gdy wysyłka po nim zawiedzie.
        vault.saveState(client.exportState())

        val urzadzenie = api.lookupDevices(recipient).firstOrNull()
        WyslanaWiadomosc(
            sposob = wyslij(recipient, urzadzenie, zapakowana.koperta),
            messageId = zapakowana.messageId,
        )
    }

    /**
     * Wysyła paczkę potwierdzeń.
     *
     * Idzie tą samą drogą co wiadomość, więc serwer widzi wyłącznie szyfrogram.
     * **Chwili** wysyłki to nie ukrywa — o to dba wołający, który zbiera
     * potwierdzenia i opóźnia wysyłkę o losowy czas (`Potwierdzenia.kt`).
     */
    suspend fun sendReceipt(
        groupId: ByteArray,
        rodzaj: ReceiptKind,
        messageIds: List<ByteArray>,
        recipient: String,
    ) = withContext(Dispatchers.IO) {
        if (messageIds.isEmpty()) return@withContext

        val koperta = client.sendReceipt(
            groupId,
            rodzaj,
            messageIds,
            System.currentTimeMillis().toULong(),
        )

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

        val zapakowana = client.sealAttachmentMessage(
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
        val sposob = wyslij(recipient, urzadzenie, zapakowana.koperta)

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
            messageId = zapakowana.messageId,
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

    /** Poświadczenia STUN/TURN dla rozmowy A/V — token trzyma `Messenger`. */
    suspend fun serweryIce(): List<Api.SerwerIce> = api.iceServers(token)

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
            // Token doręczeniowy tylko na drodze przez skrzynkę: przy
            // dostarczeniu wprost serwera w ogóle nie ma w torze, więc nie ma
            // komu niczego dowodzić.
            api.deposit(recipient, koperta, portfel?.wez()?.naglowek())

            // Uzupełnianie PO wysyłce, nie przed: pobranie zapasu jest żądaniem
            // uwierzytelnionym, więc trzymamy je z dala od chwili nadania.
            uzupelnijTokeny()
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
            token = token,
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
