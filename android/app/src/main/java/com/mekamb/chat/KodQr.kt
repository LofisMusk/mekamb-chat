package com.mekamb.chat

import androidx.compose.foundation.Canvas
import androidx.compose.foundation.background
import androidx.compose.foundation.layout.Box
import androidx.compose.foundation.layout.aspectRatio
import androidx.compose.foundation.layout.fillMaxWidth
import androidx.compose.foundation.layout.padding
import androidx.compose.foundation.layout.widthIn
import androidx.compose.foundation.shape.RoundedCornerShape
import androidx.compose.runtime.Composable
import androidx.compose.runtime.remember
import androidx.compose.ui.Modifier
import androidx.compose.ui.geometry.Offset
import androidx.compose.ui.geometry.Size
import androidx.compose.ui.graphics.Color
import androidx.compose.ui.semantics.contentDescription
import androidx.compose.ui.semantics.semantics
import androidx.compose.ui.unit.dp
import uniffi.mekamb_ffi.qrCode

/**
 * Kod QR.
 *
 * # Skąd biorą się moduły
 *
 * Z rdzenia w Rust ([`mekamb_core::qr`]), tego samego, którego używa klient
 * webowy. Druga implementacja po tej stronie rozjechałaby się z pierwszą,
 * a rozjazd objawiłby się kodem nie do zeskanowania — czyli u użytkownika
 * stojącego z dwoma telefonami, nie w testach.
 *
 * # Dlaczego jasne tło jest częścią kodu
 *
 * Czytnik potrzebuje kontrastu i cichego marginesu. Na ciemnym ekranie aplikacji
 * sam kod bez jasnego podkładu bywa nie do znalezienia, więc tło i margines są
 * rysowane tutaj, a nie zostawione ekranowi.
 */

/** Cichy margines w modułach — wymagany przez normę. */
private const val MARGINES = 4

@Composable
fun KodQr(tresc: String, opis: String, modifier: Modifier = Modifier) {
    // Liczenie kodu jest deterministyczne i niezależne od rysowania, więc
    // pamiętamy wynik — inaczej każde przerysowanie liczyłoby Reeda-Solomona
    // od nowa, także przy samym odliczaniu czasu obok.
    val kod = remember(tresc) { runCatching { qrCode(tresc) }.getOrNull() } ?: return

    KodQrZMacierzy(kod, opis, modifier)
}

/**
 * To samo, ale z gotowej macierzy.
 *
 * Transfer optyczny podmienia klatkę dziesięć razy na sekundę i liczy ją
 * w rdzeniu razem z kodowaniem fountain — przepuszczanie jej przez tekst
 * wymagałoby base64 i kosztowało jedną trzecią przepustowości.
 */
@Composable
fun KodQrZMacierzy(
    kod: uniffi.mekamb_ffi.KodQr,
    opis: String,
    modifier: Modifier = Modifier,
) {
    val bok = kod.bok.toInt()
    val zMarginesem = bok + MARGINES * 2

    Box(
        modifier = modifier
            .widthIn(max = 260.dp)
            .fillMaxWidth()
            .aspectRatio(1f)
            // Biel wprost, nie kolor tekstu z motywu: czytnik opiera się na
            // kontraście czarnych modułów wobec tła kodu, a nie na tym, co
            // aplikacja uznała dziś za jasne. W motywie jasnym kolor tekstu
            // jest prawie czarny — kod przestałby się dać zeskanować.
            .background(Color.White, RoundedCornerShape(10.dp))
            .padding(2.dp)
            .semantics { contentDescription = opis },
    ) {
        Canvas(Modifier.fillMaxWidth().aspectRatio(1f)) {
            val modul = size.width / zMarginesem

            for (y in 0 until bok) {
                for (x in 0 until bok) {
                    if (!kod.moduly[y * bok + x]) continue

                    drawRect(
                        color = Color.Black,
                        topLeft = Offset((x + MARGINES) * modul, (y + MARGINES) * modul),
                        // Bez zaokrąglania w górę sąsiadujące moduły zostawiają
                        // włosowe szpary, po których czytnik gubi siatkę.
                        size = Size(modul + 0.5f, modul + 0.5f),
                    )
                }
            }
        }
    }
}
