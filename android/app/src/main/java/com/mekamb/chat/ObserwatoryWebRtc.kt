package com.mekamb.chat

import org.webrtc.DataChannel
import org.webrtc.IceCandidate
import org.webrtc.MediaStream
import org.webrtc.PeerConnection
import org.webrtc.RtpReceiver
import org.webrtc.SdpObserver
import org.webrtc.SessionDescription

/**
 * Puste implementacje interfejsów WebRTC.
 *
 * `PeerConnection.Observer` i `SdpObserver` mają po kilkanaście metod, z których
 * używamy trzech. Anonimowe obiekty implementujące wszystkie zamieniłyby każde
 * użycie w ścianę pustych ciał — a wtedy nie widać, które metody naprawdę coś
 * robią. Tutaj jest ta ściana, raz.
 */
abstract class ProstyObserwator : PeerConnection.Observer {
    override fun onSignalingChange(stan: PeerConnection.SignalingState?) = Unit
    override fun onIceConnectionChange(stan: PeerConnection.IceConnectionState?) = Unit
    override fun onIceConnectionReceivingChange(odbiera: Boolean) = Unit
    override fun onIceGatheringChange(stan: PeerConnection.IceGatheringState?) = Unit
    override fun onIceCandidatesRemoved(kandydaci: Array<out IceCandidate>?) = Unit
    override fun onRemoveStream(stream: MediaStream?) = Unit
    override fun onDataChannel(kanal: DataChannel?) = Unit
    override fun onRenegotiationNeeded() = Unit
    override fun onAddTrack(odbiornik: RtpReceiver?, strumienie: Array<out MediaStream>?) = Unit

    override fun onIceCandidate(kandydat: IceCandidate?) = Unit
    override fun onAddStream(stream: MediaStream?) = Unit
    override fun onConnectionChange(nowy: PeerConnection.PeerConnectionState?) = Unit
}

/** To samo dla `SdpObserver`: nadpisujemy tylko to, co naprawdę obsługujemy. */
open class ProstySdpObserver : SdpObserver {
    override fun onCreateSuccess(opis: SessionDescription?) = Unit
    override fun onSetSuccess() = Unit

    // Niepowodzenie negocjacji nie jest awarią aplikacji: rozmówca mógł
    // rozłączyć się w trakcie. Stan połączenia i tak zejdzie do FAILED,
    // a to jest sygnał, na który reaguje ekran.
    override fun onCreateFailure(powod: String?) = Unit
    override fun onSetFailure(powod: String?) = Unit
}
