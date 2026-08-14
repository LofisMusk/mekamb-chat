package com.mekamb.chat

import android.Manifest
import android.content.pm.PackageManager
import androidx.activity.compose.rememberLauncherForActivityResult
import androidx.activity.result.contract.ActivityResultContracts
import androidx.camera.core.CameraSelector
import androidx.camera.core.ImageAnalysis
import androidx.camera.core.ImageProxy
import androidx.camera.lifecycle.ProcessCameraProvider
import androidx.camera.view.PreviewView
import androidx.compose.foundation.layout.Box
import androidx.compose.foundation.layout.aspectRatio
import androidx.compose.foundation.layout.fillMaxWidth
import androidx.compose.runtime.Composable
import androidx.compose.runtime.DisposableEffect
import androidx.compose.runtime.LaunchedEffect
import androidx.compose.runtime.getValue
import androidx.compose.runtime.mutableStateOf
import androidx.compose.runtime.remember
import androidx.compose.runtime.rememberUpdatedState
import androidx.compose.runtime.setValue
import androidx.compose.ui.Modifier
import androidx.compose.ui.platform.LocalContext
import androidx.compose.ui.viewinterop.AndroidView
import androidx.core.content.ContextCompat
import androidx.lifecycle.compose.LocalLifecycleOwner
import com.google.zxing.BinaryBitmap
import com.google.zxing.DecodeHintType
import com.google.zxing.MultiFormatReader
import com.google.zxing.PlanarYUVLuminanceSource
import com.google.zxing.ResultMetadataType
import com.google.zxing.common.HybridBinarizer
import java.util.concurrent.Executors

/**
 * Podgląd z aparatu, który czyta kody QR.
 *
 * # Dlaczego ZXing, a nie ML Kit
 *
 * ML Kit w wersji wbudowanej dokłada około 2,5 MB do 5,4 MB wydania, a w wersji
 * odchudzonej wymaga Usług Google Play — czyli odcina telefony bez nich.
 * W aplikacji o tym profilu to zły kompromis. ZXing to czysta Java.
 *
 * # Dlaczego bajty, a nie tekst
 *
 * Ramka transferu optycznego jest **binarna**. Odczytana jako tekst wraca
 * przepuszczona przez UTF-8 i nie da się jej odtworzyć. ZXing oddaje surowe
 * segmenty bajtowe w metadanych wyniku — i to one, a nie `text`, są tu
 * właściwym wyjściem. Klient webowy ma dokładnie ten sam problem i rozwiązuje
 * go tak samo (`jsQR.binaryData`).
 *
 * # Uprawnienie
 *
 * `CAMERA` jest w manifeście od czasu rozmów A/V, ale zgoda jest przyznawana
 * osobno na każde zastosowanie w czasie działania. Prosimy o nią tutaj, bo
 * ekran bez podglądu i bez wyjaśnienia wygląda na zepsuty.
 */

/** Co udało się odczytać z jednej klatki. */
data class OdczytQr(val tekst: String, val bajty: ByteArray) {
    // ByteArray porównuje się przez referencję, więc data class wymaga tu
    // ręcznej roboty — bez tego dwa identyczne odczyty są różne.
    override fun equals(other: Any?): Boolean =
        other is OdczytQr && tekst == other.tekst && bajty.contentEquals(other.bajty)

    override fun hashCode(): Int = tekst.hashCode() * 31 + bajty.contentHashCode()
}

/** Wyciąga z klatki YUV kod QR, o ile jakiś na niej jest. */
private fun odczytaj(czytnik: MultiFormatReader, klatka: ImageProxy): OdczytQr? {
    // Płaszczyzna Y to sama jasność — dokładnie to, czego potrzebuje binaryzator.
    // Konwersja do RGB byłaby pracą wykonaną po to, żeby ją zaraz wyrzucić.
    val plaszczyzna = klatka.planes[0]
    val bufor = plaszczyzna.buffer
    val dane = ByteArray(bufor.remaining())
    bufor.get(dane)

    val zrodlo = PlanarYUVLuminanceSource(
        dane,
        plaszczyzna.rowStride,
        klatka.height,
        0,
        0,
        klatka.width,
        klatka.height,
        false,
    )

    val wynik = runCatching {
        czytnik.decodeWithState(BinaryBitmap(HybridBinarizer(zrodlo)))
    }.getOrNull() ?: return null

    // Segmenty bajtowe zamiast `text`: ramka transferu jest binarna.
    @Suppress("UNCHECKED_CAST")
    val segmenty = wynik.resultMetadata?.get(ResultMetadataType.BYTE_SEGMENTS) as? List<ByteArray>

    return OdczytQr(
        tekst = wynik.text ?: "",
        bajty = segmenty?.firstOrNull() ?: ByteArray(0),
    )
}

@Composable
fun SkanerQr(
    naOdczyt: (OdczytQr) -> Unit,
    modifier: Modifier = Modifier,
    naBrakZgody: () -> Unit = {},
) {
    val kontekst = LocalContext.current
    val wlasciciel = LocalLifecycleOwner.current
    val aktualne by rememberUpdatedState(naOdczyt)

    var zgoda by remember {
        mutableStateOf(
            ContextCompat.checkSelfPermission(kontekst, Manifest.permission.CAMERA) ==
                PackageManager.PERMISSION_GRANTED,
        )
    }

    val pytanie = rememberLauncherForActivityResult(ActivityResultContracts.RequestPermission()) {
        zgoda = it
        if (!it) naBrakZgody()
    }

    LaunchedEffect(Unit) {
        if (!zgoda) pytanie.launch(Manifest.permission.CAMERA)
    }

    if (!zgoda) return

    val podglad = remember { PreviewView(kontekst) }

    // Osobny wątek na dekodowanie: ZXing na klatce 1280x720 potrafi zająć
    // kilkadziesiąt milisekund, a na wątku głównym zacinałby interfejs
    // dokładnie wtedy, gdy pokazuje postęp.
    val wykonawca = remember { Executors.newSingleThreadExecutor() }

    DisposableEffect(wlasciciel) {
        val dostawca = ProcessCameraProvider.getInstance(kontekst)

        dostawca.addListener({
            val kamera = dostawca.get()
            val czytnik = MultiFormatReader().apply {
                setHints(mapOf(DecodeHintType.TRY_HARDER to true))
            }

            val podglądUC = androidx.camera.core.Preview.Builder().build().also {
                it.surfaceProvider = podglad.surfaceProvider
            }

            val analiza = ImageAnalysis.Builder()
                // Zaległe klatki są bezużyteczne: strumień idzie dalej, a my
                // i tak potrzebujemy DOWOLNYCH ramek, nie akurat tych.
                .setBackpressureStrategy(ImageAnalysis.STRATEGY_KEEP_ONLY_LATEST)
                .build()
                .also { analizator ->
                    analizator.setAnalyzer(wykonawca) { klatka ->
                        try {
                            odczytaj(czytnik, klatka)?.let(aktualne)
                        } finally {
                            // Bez zamknięcia strumień staje po kilku klatkach.
                            klatka.close()
                        }
                    }
                }

            runCatching {
                kamera.unbindAll()
                kamera.bindToLifecycle(
                    wlasciciel,
                    CameraSelector.DEFAULT_BACK_CAMERA,
                    podglądUC,
                    analiza,
                )
            }
        }, ContextCompat.getMainExecutor(kontekst))

        onDispose {
            runCatching { dostawca.get().unbindAll() }
            wykonawca.shutdown()
        }
    }

    Box(modifier.fillMaxWidth().aspectRatio(1f)) {
        AndroidView(factory = { podglad }, modifier = Modifier.fillMaxWidth().aspectRatio(1f))
    }
}
