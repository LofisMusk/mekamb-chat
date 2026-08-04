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

## Pułapki, na które natknął się ten build

Zapisane, bo każda kosztowała osobne podejście:

- **AGP 9 ma wbudowaną obsługę Kotlina.** Osobna wtyczka `kotlin.android` jest
  nie tylko zbędna — build ją odrzuca.
- **Metadanych UniFFI nie da się odczytać z artefaktu androidowego.** Profil
  `release` usuwa je przy strippingu, więc bindingi generujemy z osobnej
  biblioteki dla hosta. Obie powstają z tego samego źródła w jednym przebiegu.
- **`close()` koliduje z `AutoCloseable`.** UniFFI generuje własne `close()` do
  zwalniania uchwytu natywnego; własna metoda o tej nazwie tworzy niejednoznaczne
  przeciążenie. Nasza nazywa się `shutdown`.
- **Konstruktory drugorzędne trafiają do companion object.** `MekambTransport`
  tworzy się przez `MekambTransport.start(...)`, a nie przez konstruktor klasy.

## BLOKER: transport iroh przerywa proces na Androidzie

Logowanie działa — pełna ścieżka OPAQUE + TOTP przechodzi przeciwko prawdziwemu
serwerowi. **Zaraz po nim proces ginie**, i to nie przez wyjątek Kotlina, tylko
przez natywne `abort()`:

```
signal 6 (SIGABRT)
Abort message: 'android context was not initialized'
```

### Przyczyna

`rustls-platform-verifier` wymaga na Androidzie dostępu do JVM przez JNI i bez
inicjalizacji **przerywa proces**. Nie da się tego złapać — `abort` nie jest
wyjątkiem ani paniką Rusta.

Do naszego drzewa trafia przez `reqwest`, którego iroh używa do relayów
i odkrywania węzłów:

```
rustls-platform-verifier ← reqwest (feature "rustls-no-provider") ← iroh
```

**Nie da się tego wyłączyć flagą.** Feature `rustls-no-provider` ma
`dep:rustls-platform-verifier` jako twardą zależność, a włączają go zarówno
`tls-ring`, jak i `portmapper` w iroh.

### Dwie drogi wyjścia

1. **Zainicjalizować JNI.** Poprawne rozwiązanie, ale wymaga zvendorowania
   komponentu Kotlina z repozytorium `rustls-platform-verifier` — nie ma go na
   Mavenie — plus konfiguracji Gradle i funkcji JNI wołanej z `Application`.
2. **Odciąć iroh na Androidzie** i korzystać wyłącznie ze skrzynki, tak jak
   robi to przeglądarka. Aplikacja zacznie działać od razu, ale traci to,
   co jest głównym powodem istnienia klienta natywnego — bezpośrednie P2P.

Do rozstrzygnięcia przed dalszą pracą nad Androidem.

## Czego jeszcze nie ma

- **Push (FCM).** Warstwa gotowa do dopisania; wymaga `google-services.json`
  z projektu Firebase. Ładunek ma być wyłącznie budzący — bez nadawcy i treści.
- **Rozmów audio/wideo.** Klient webowy je ma; Android wymaga osobnej
  integracji z WebRTC.
- **Działającego transportu.** Patrz sekcja o blokerze powyżej.
