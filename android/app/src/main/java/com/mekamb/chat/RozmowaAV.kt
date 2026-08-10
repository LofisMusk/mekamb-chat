package com.mekamb.chat

import android.content.Context
import kotlinx.coroutines.CoroutineScope
import kotlinx.coroutines.Dispatchers
import kotlinx.coroutines.launch
import kotlinx.serialization.Serializable
import kotlinx.serialization.json.Json
import org.webrtc.AudioTrack
import org.webrtc.Camera2Enumerator
import org.webrtc.CameraVideoCapturer
import org.webrtc.DefaultVideoDecoderFactory
import org.webrtc.DefaultVideoEncoderFactory
import org.webrtc.EglBase
import org.webrtc.IceCandidate
import org.webrtc.MediaConstraints
import org.webrtc.MediaStream
import org.webrtc.PeerConnection
import org.webrtc.PeerConnectionFactory
import org.webrtc.SessionDescription
import org.webrtc.SurfaceTextureHelper
import org.webrtc.VideoTrack
import uniffi.mekamb_ffi.CallSignalKind
import uniffi.mekamb_ffi.ownSdpFingerprint
import uniffi.mekamb_ffi.verifySdpFingerprint

/**
 * Rozmowa audio/wideo — mesh, bez serwera pośredniczącego w mediach.
 *
 * # Dlaczego mesh, a nie SFU
 *
 * SFU odszyfrowuje media, żeby je przemiksować — czyli widzi i słyszy
 * rozmowę. Mesh znaczy, że każda para negocjuje własne połączenie DTLS-SRTP
 * i nikt trzeci nie ma czego podsłuchać. Cena to ruch rosnący z kwadratem
 * liczby uczestników, stąd rozsądny limit czterech osób.
 *
 * # Czemu ufamy w sygnalizacji, a czemu nie
 *
 * SDP idzie tą samą drogą co reszta ruchu — przez skrzynkę albo wprost — więc
 * pośrednik może je podmienić i podstawić własne połączenie DTLS. Rozmowa
 * wyglądałaby wtedy na zabezpieczoną, bo szyfrowanie *by działało*: tyle że
 * z nim.
 *
 * Dlatego odcisk DTLS podróżuje **wewnątrz MLS**, niezależnie od SDP, a przed
 * zestawieniem połączenia porównujemy jedno z drugim. Niezgodność zrywa
 * rozmowę **bez pytania użytkownika** — pytanie „czy na pewno chcesz połączyć
 * się mimo niezgodności" jest pytaniem, na które nikt nie umie odpowiedzieć,
 * a zgoda kliknięta w pośpiechu unieważnia całą tę ochronę.
 *
 * Porównanie robi rdzeń (`verify_sdp_fingerprint`), ten sam kod co w kliencie
 * webowym.
 *
 * # Czego to nie zmienia
 *
 * Rozmowa bezpośrednia zdradza rozmówcy adres IP, a przez TURN — serwerowi.
 * To jest w projekcie napisane wprost na ekranie rozmowy i ma tam zostać.
 */
class RozmowaAV private constructor(
    private val kontekst: Context,
    private val messenger: Messenger,
    private val groupId: ByteArray,
    private val callId: ByteArray,
    private val zakres: CoroutineScope,
    private val onZmiana: (List<UczestnikRozmowy>) -> Unit,
) {
    private val eglBase: EglBase = EglBase.create()
    private val fabryka: PeerConnectionFactory
    private var audio: AudioTrack? = null
    private var wideo: VideoTrack? = null
    private var kamera: CameraVideoCapturer? = null

    /** Połączenia po nazwie rozmówcy. Mesh: jedno na parę. */
    private val polaczenia = LinkedHashMap<String, Polaczenie>()

    /**
     * Serwery ICE z Workera.
     *
     * Pobierane raz na rozmowę, zanim powstanie pierwsze połączenie: TURN
     * dostaje krótkożyjące poświadczenia, więc nie da się ich trzymać na stałe,
     * a każde połączenie w siatce ma używać tych samych.
     */
    private var serweryIce: List<PeerConnection.IceServer> = listOf(
        PeerConnection.IceServer.builder(STUN_ZAPASOWY).createIceServer(),
    )

    var mikrofonWlaczony: Boolean = true
        private set
    var kameraWlaczona: Boolean = false
        private set

    init {
        PeerConnectionFactory.initialize(
            PeerConnectionFactory.InitializationOptions.builder(kontekst)
                .createInitializationOptions(),
        )

        fabryka = PeerConnectionFactory.builder()
            .setVideoEncoderFactory(DefaultVideoEncoderFactory(eglBase.eglBaseContext, true, true))
            .setVideoDecoderFactory(DefaultVideoDecoderFactory(eglBase.eglBaseContext))
            .createPeerConnectionFactory()
    }

    companion object {
        /**
         * Górny limit uczestników.
         *
         * Mesh zestawia połączenie każdy z każdym, więc ruch rośnie z kwadratem
         * liczby osób. Powyżej czterech telefon przestaje nadążać z kodowaniem
         * i rozmowa psuje się wszystkim naraz.
         */
        const val LIMIT_UCZESTNIKOW = 4

        /** Gdy Worker nie odpowie — bez żadnego serwera ICE nie zestawi się nic. */
        private const val STUN_ZAPASOWY = "stun:stun.cloudflare.com:3478"

        /** Zaczyna rozmowę: wysyła ofertę do każdego pozostałego uczestnika. */
        fun zadzwon(
            kontekst: Context,
            messenger: Messenger,
            groupId: ByteArray,
            rozmowcy: List<String>,
            zWideo: Boolean,
            zakres: CoroutineScope,
            onZmiana: (List<UczestnikRozmowy>) -> Unit,
        ): RozmowaAV {
            val rozmowa = RozmowaAV(
                kontekst,
                messenger,
                groupId,
                ByteArray(16).also { java.security.SecureRandom().nextBytes(it) },
                zakres,
                onZmiana,
            )

            rozmowa.przygotujMedia(zWideo)

            // Oferty idą dopiero po pobraniu poświadczeń: połączenie zestawione
            // bez TURN-a nie doda go sobie później, a użytkownik za
            // restrykcyjnym NAT-em nie usłyszałby nikogo bez śladu przyczyny.
            zakres.launch {
                rozmowa.pobierzSerweryIce()
                rozmowcy.take(LIMIT_UCZESTNIKOW - 1).forEach { rozmowa.zaproponuj(it) }
            }

            return rozmowa
        }

        /**
         * Odbiera rozmowę zaczętą przez kogoś innego.
         *
         * Identyfikator rozmowy bierzemy z oferty, a nie losujemy własnego:
         * dwie strony z różnymi identyfikatorami zestawiłyby dwie rozmowy
         * zamiast jednej.
         *
         * Oferta jest przetwarzana TUTAJ, po pobraniu poświadczeń ICE — a nie
         * przez wywołującego zaraz po powrocie. Połączenie zestawione przed
         * ich pobraniem nie doda sobie TURN-a później, więc strona odbierająca
         * za restrykcyjnym NAT-em nie usłyszałaby nikogo, bez śladu przyczyny.
         */
        fun odbierz(
            kontekst: Context,
            messenger: Messenger,
            groupId: ByteArray,
            callId: ByteArray,
            zWideo: Boolean,
            od: String,
            oferta: String,
            odcisk: String,
            zakres: CoroutineScope,
            onZmiana: (List<UczestnikRozmowy>) -> Unit,
        ): RozmowaAV {
            val rozmowa = RozmowaAV(kontekst, messenger, groupId, callId, zakres, onZmiana)
            rozmowa.przygotujMedia(zWideo)

            zakres.launch {
                rozmowa.pobierzSerweryIce()
                rozmowa.przyjmij(od, CallSignalKind.OFFER, oferta, odcisk)
            }

            return rozmowa
        }
    }

    /** Kontekst OpenGL do podglądu — potrzebny widokom rysującym obraz. */
    fun kontekstGl(): EglBase.Context = eglBase.eglBaseContext

    private fun przygotujMedia(zWideo: Boolean) {
        val zrodloAudio = fabryka.createAudioSource(MediaConstraints())
        audio = fabryka.createAudioTrack("audio", zrodloAudio)

        if (!zWideo) return

        val enumerator = Camera2Enumerator(kontekst)
        val nazwa = enumerator.deviceNames.firstOrNull { enumerator.isFrontFacing(it) }
            ?: enumerator.deviceNames.firstOrNull()
            ?: return

        val capturer = enumerator.createCapturer(nazwa, null) ?: return
        val zrodloWideo = fabryka.createVideoSource(capturer.isScreencast)
        val pomocnik = SurfaceTextureHelper.create("kamera", eglBase.eglBaseContext)

        capturer.initialize(pomocnik, kontekst, zrodloWideo.capturerObserver)
        capturer.startCapture(1280, 720, 30)

        kamera = capturer
        wideo = fabryka.createVideoTrack("wideo", zrodloWideo)
        kameraWlaczona = true
    }

    /** Zestawia połączenie z jedną osobą i wysyła jej ofertę. */
    private fun zaproponuj(rozmowca: String) {
        val polaczenie = polaczenie(rozmowca) ?: return

        polaczenie.pc.createOffer(
            object : ProstySdpObserver() {
                override fun onCreateSuccess(opis: SessionDescription?) {
                    val oferta = opis ?: return
                    polaczenie.pc.setLocalDescription(ProstySdpObserver(), oferta)
                    wyslij(rozmowca, CallSignalKind.OFFER, oferta.description)
                }
            },
            MediaConstraints(),
        )
    }

    /**
     * Przyjmuje sygnał od jednego uczestnika.
     *
     * Oferta i odpowiedź przechodzą przez porównanie odcisku. Kandydat ICE nie
     * niesie odcisku — jest bezużyteczny bez opisu, który już porównaliśmy.
     */
    fun przyjmij(od: String, rodzaj: CallSignalKind, tresc: String, odciskZMls: String) {
        when (rodzaj) {
            CallSignalKind.OFFER -> {
                if (!odciskSieZgadza(od, tresc, odciskZMls)) return

                val polaczenie = polaczenie(od) ?: return
                polaczenie.pc.setRemoteDescription(
                    object : ProstySdpObserver() {
                        override fun onSetSuccess() {
                            polaczenie.oproznijKolejkeIce()
                            polaczenie.pc.createAnswer(
                                object : ProstySdpObserver() {
                                    override fun onCreateSuccess(opis: SessionDescription?) {
                                        val odp = opis ?: return
                                        polaczenie.pc.setLocalDescription(ProstySdpObserver(), odp)
                                        wyslij(od, CallSignalKind.ANSWER, odp.description)
                                    }
                                },
                                MediaConstraints(),
                            )
                        }
                    },
                    SessionDescription(SessionDescription.Type.OFFER, tresc),
                )
            }

            CallSignalKind.ANSWER -> {
                if (!odciskSieZgadza(od, tresc, odciskZMls)) return

                val polaczenie = polaczenia[od] ?: return
                polaczenie.pc.setRemoteDescription(
                    object : ProstySdpObserver() {
                        override fun onSetSuccess() = polaczenie.oproznijKolejkeIce()
                    },
                    SessionDescription(SessionDescription.Type.ANSWER, tresc),
                )
            }

            CallSignalKind.ICE_CANDIDATE -> {
                val polaczenie = polaczenia[od] ?: return
                polaczenie.dodajKandydata(tresc)
            }

            CallSignalKind.HANGUP -> {
                polaczenia.remove(od)?.zamknij()
                zglos()
            }

            CallSignalKind.UNSPECIFIED -> Unit
        }
    }

    /**
     * Porównuje odcisk z SDP z tym, który przyszedł kanałem MLS.
     *
     * Niezgodność zrywa połączenie z tą osobą i zostawia ślad w stanie —
     * użytkownik ma zobaczyć, że rozmowa się nie zestawiła, i dlaczego.
     */
    private fun odciskSieZgadza(od: String, sdp: String, odciskZMls: String): Boolean {
        val wynik = runCatching { verifySdpFingerprint(sdp, odciskZMls) }
        if (wynik.isSuccess) return true

        polaczenia[od]?.let {
            it.faza = FazaPolaczenia.ODRZUCONA
            it.zamknij()
        }
        zglos()
        return false
    }

    private fun polaczenie(rozmowca: String): Polaczenie? {
        polaczenia[rozmowca]?.let { return it }
        if (polaczenia.size >= LIMIT_UCZESTNIKOW - 1) return null

        val konfiguracja = PeerConnection.RTCConfiguration(serweryIce).apply {
            sdpSemantics = PeerConnection.SdpSemantics.UNIFIED_PLAN
        }

        val polaczenie = Polaczenie(rozmowca)
        val pc = fabryka.createPeerConnection(konfiguracja, polaczenie.obserwator) ?: return null

        polaczenie.pc = pc
        audio?.let { pc.addTrack(it, listOf("mekamb")) }
        wideo?.let { pc.addTrack(it, listOf("mekamb")) }

        polaczenia[rozmowca] = polaczenie
        zglos()
        return polaczenie
    }

    /**
     * Pobiera poświadczenia STUN/TURN z Workera.
     *
     * Bez TURN-a nie uda się wyłącznie połączenie między dwoma restrykcyjnymi
     * NAT-ami — reszta działa na samym STUN-ie, więc niepowodzenie zostawia
     * zapasowy serwer zamiast przerywać rozmowę.
     */
    internal suspend fun pobierzSerweryIce() {
        serweryIce = messenger.serweryIce().map { serwer ->
            PeerConnection.IceServer.builder(serwer.urls)
                .apply {
                    serwer.username?.let { setUsername(it) }
                    serwer.credential?.let { setPassword(it) }
                }
                .createIceServer()
        }
    }

    private fun wyslij(doKogo: String, rodzaj: CallSignalKind, tresc: String) {
        val odcisk = if (rodzaj == CallSignalKind.OFFER || rodzaj == CallSignalKind.ANSWER) {
            runCatching { ownSdpFingerprint(tresc) }.getOrDefault("")
        } else {
            ""
        }

        zakres.launch(Dispatchers.IO) {
            runCatching {
                messenger.sendCallSignal(groupId, rodzaj, callId, tresc, odcisk, doKogo)
            }
        }
    }

    /** Wycisza albo włącza mikrofon. */
    fun przelaczMikrofon() {
        mikrofonWlaczony = !mikrofonWlaczony
        audio?.setEnabled(mikrofonWlaczony)
        zglos()
    }

    /** Włącza albo wyłącza obraz z kamery. */
    fun przelaczKamere() {
        kameraWlaczona = !kameraWlaczona
        wideo?.setEnabled(kameraWlaczona)
        zglos()
    }

    /** Kończy rozmowę i zwalnia sprzęt. */
    fun zakoncz() {
        polaczenia.keys.forEach { wyslij(it, CallSignalKind.HANGUP, "") }
        polaczenia.values.forEach { it.zamknij() }
        polaczenia.clear()

        runCatching { kamera?.stopCapture() }
        kamera?.dispose()
        audio?.dispose()
        wideo?.dispose()
        fabryka.dispose()
        eglBase.release()
        zglos()
    }

    private fun zglos() = onZmiana(
        polaczenia.map { (nazwa, p) -> UczestnikRozmowy(nazwa, p.faza, p.bezposrednio) },
    )

    /** Jedno połączenie w siatce. */
    private inner class Polaczenie(val rozmowca: String) {
        lateinit var pc: PeerConnection
        var faza: FazaPolaczenia = FazaPolaczenia.LACZENIE
        var bezposrednio: Boolean = false

        /** Kandydaci, którzy dotarli przed opisem zdalnym. */
        private val kolejkaIce = mutableListOf<IceCandidate>()

        fun dodajKandydata(json: String) {
            val kandydat = kandydatZJson(json) ?: return
            if (::pc.isInitialized && pc.remoteDescription != null) {
                pc.addIceCandidate(kandydat)
            } else {
                kolejkaIce.add(kandydat)
            }
        }

        fun oproznijKolejkeIce() {
            kolejkaIce.forEach { pc.addIceCandidate(it) }
            kolejkaIce.clear()
        }

        fun zamknij() {
            if (::pc.isInitialized) pc.close()
            if (faza != FazaPolaczenia.ODRZUCONA) faza = FazaPolaczenia.ZAKONCZONA
        }

        /**
         * Rozstrzyga, czy media idą wprost, czy przez przekaźnik.
         *
         * Typ kandydata „relay" znaczy TURN — wtedy nasz adres IP widzi
         * przekaźnik zamiast rozmówcy. To jest różnica, o której ekran mówi
         * wprost, więc nie wolno jej zgadywać: dopóki statystyki nie odpowiedzą,
         * zostaje ostrożniejsze „przez przekaźnik".
         *
         * Ta sama reguła co w kliencie webowym (`ustalDroge` w `calls.ts`).
         */
        fun ustalDroge() {
            pc.getStats { raport ->
                val para = raport.statsMap.values.firstOrNull {
                    it.type == "candidate-pair" && it.members["state"] == "succeeded"
                } ?: return@getStats

                val idLokalnego = para.members["localCandidateId"] as? String ?: return@getStats
                val typ = raport.statsMap[idLokalnego]?.members?.get("candidateType") as? String

                bezposrednio = typ != null && typ != "relay"
                zglos()
            }
        }

        val obserwator = object : ProstyObserwator() {
            override fun onIceCandidate(kandydat: IceCandidate?) {
                kandydat ?: return
                wyslij(rozmowca, CallSignalKind.ICE_CANDIDATE, kandydatDoJson(kandydat))
            }

            override fun onConnectionChange(nowy: PeerConnection.PeerConnectionState?) {
                if (nowy == PeerConnection.PeerConnectionState.CONNECTED) ustalDroge()

                faza = when (nowy) {
                    PeerConnection.PeerConnectionState.CONNECTED -> FazaPolaczenia.POLACZONA
                    PeerConnection.PeerConnectionState.FAILED,
                    PeerConnection.PeerConnectionState.CLOSED,
                    -> FazaPolaczenia.ZAKONCZONA
                    else -> FazaPolaczenia.LACZENIE
                }
                zglos()
            }

            override fun onAddStream(stream: MediaStream?) = zglos()
        }
    }
}

/** Stan jednego rozmówcy — do pokazania na ekranie rozmowy. */
data class UczestnikRozmowy(
    val nazwa: String,
    val faza: FazaPolaczenia,
    /** `true`, gdy media idą wprost — czyli rozmówca zna nasz adres IP. */
    val bezposrednio: Boolean,
)

enum class FazaPolaczenia { LACZENIE, POLACZONA, ZAKONCZONA, ODRZUCONA }

/**
 * Kandydat ICE jako JSON — tym samym kształtem, którego używa klient webowy
 * (`RTCIceCandidate.toJSON`). Rozjazd oznaczałby, że web i Android nie
 * dogadają się przy zestawianiu połączenia.
 */
internal fun kandydatDoJson(k: IceCandidate): String =
    Json.encodeToString(KandydatJson(k.sdp, k.sdpMid, k.sdpMLineIndex))

internal fun kandydatZJson(json: String): IceCandidate? = runCatching {
    val obiekt = Json { ignoreUnknownKeys = true }.decodeFromString<KandydatJson>(json)
    IceCandidate(obiekt.sdpMid, obiekt.sdpMLineIndex, obiekt.candidate)
}.getOrNull()

@Serializable
internal data class KandydatJson(
    val candidate: String,
    val sdpMid: String? = null,
    val sdpMLineIndex: Int = 0,
)
