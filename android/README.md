# mekamb-chat — klient Android

Kotlin + Jetpack Compose. Rdzeń kryptograficzny i transport pochodzą z Rusta
przez UniFFI — ten sam kod, którego używa klient webowy.

## Czym różni się od klienta webowego

**Tu P2P działa naprawdę.** Android przebija NAT i łączy się wprost z drugim
urządzeniem; skrzynka na serwerze wchodzi do gry dopiero, gdy odbiorcy nie da
się osiągnąć. W przeglądarce pośrednik jest zawsze, bo sandbox nie pozwala na
połączenia przychodzące.

Interfejs pokazuje tryb połączenia („bezpośrednie" / „przez serwer"), żeby nie
sugerować P2P tam, gdzie go nie ma.

## Wymagania

- Android Studio z SDK (platforma 36)
- **NDK** — Settings → SDK Manager → SDK Tools → zaznacz *NDK (Side by side)*
- `cargo-ndk`:

```bash
cargo install cargo-ndk && rustup target add aarch64-linux-android armv7-linux-androideabi x86_64-linux-android
```

## Budowanie

Gradle sam buduje rdzeń w Rust i generuje wiązania Kotlina — nie ma osobnego
kroku do zapamiętania:

```bash
cd android && ./gradlew assembleDebug
```

Wiązania powstają z **metadanych zbudowanej biblioteki**, a nie z osobnego
pliku opisu, więc nie mają jak rozjechać się z kodem Rusta.

Domyślny adres backendu to `http://10.0.2.2:8787` — tak emulator widzi
`wrangler dev` na hoście. Dla fizycznego urządzenia zmień `API_URL`
w `app/build.gradle.kts`.

## Czego jeszcze nie ma

- **Logowania.** Wymaga natywnego klienta OPAQUE; problem zgodności między
  implementacją rustową a serwerową opisany w [`Auth.kt`](app/src/main/java/com/mekamb/chat/Auth.kt).
  Do tego czasu aplikacja zgłasza jawny błąd zamiast udawać zalogowanie.
- **Push (FCM).** Warstwa gotowa do dopisania; wymaga `google-services.json`
  z projektu Firebase. Ładunek ma być wyłącznie budzący — bez nadawcy i treści.
- **Rozmów audio/wideo.** Faza 7.
