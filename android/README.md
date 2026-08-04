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

## Historia: dlaczego transport jest własny

Pierwsza wersja opierała się na iroh. Logowanie działało, ale proces ginął
zaraz po nim przez natywne `abort()`:

```
signal 6 (SIGABRT)
Abort message: 'android context was not initialized'
```

`rustls-platform-verifier` — wciągany przez `reqwest`, którego iroh używa do
relayów — wymaga na Androidzie inicjalizacji przez JNI i bez niej **przerywa
proces**. Nie dało się tego wyłączyć flagą, bo zależność jest twarda.

Zamiast wchodzić w JNI i vendorowanie cudzego komponentu Kotlina spoza Mavena,
transport został napisany od nowa: UDP, STUN i Noise. Ani `reqwest`, ani
`rustls-platform-verifier` nie występują już w drzewie zależności.

## Czego jeszcze nie ma

- **Push (FCM).** Warstwa gotowa do dopisania; wymaga `google-services.json`
  z projektu Firebase. Ładunek ma być wyłącznie budzący — bez nadawcy i treści.
- **Rozmów audio/wideo.** Klient webowy je ma; Android wymaga osobnej
  integracji z WebRTC.
- **Działającego transportu.** Patrz sekcja o blokerze powyżej.

## Klucz podpisu wydania

APK bez podpisu nie da się zainstalować — Android odmawia. Klucz **nie leży
w repozytorium**; workflow wydania czyta go z sekretów GitHuba i przerywa, gdy
ich nie ma. Podpisywanie kluczem debugowym byłoby gorsze niż brak podpisu: plik
dałoby się zainstalować, więc nikt by nie zauważył, że komunikator „szyfrowany
end-to-end" jest sygnowany kluczem, który każdy ma na dysku.

Klucz tworzy się raz:

```bash
keytool -genkeypair -v -keystore wydanie.jks -alias mekamb -keyalg RSA -keysize 4096 -validity 10950
```

Potem cztery sekrety w repozytorium (`Settings → Secrets and variables →
Actions`):

| Sekret | Zawartość |
| --- | --- |
| `ANDROID_KEYSTORE_BASE64` | `base64 -i wydanie.jks \| tr -d '\n'` |
| `ANDROID_KEYSTORE_PASSWORD` | hasło magazynu |
| `ANDROID_KEY_ALIAS` | alias klucza (`mekamb`) |
| `ANDROID_KEY_PASSWORD` | hasło klucza |

**Plik `wydanie.jks` trzeba zachować poza repozytorium.** Sekretów GitHuba nie
da się odczytać po zapisaniu, więc kopia z dysku jest jedyną. Bez tego klucza
nie da się już wydać aktualizacji — Android odmawia instalacji aktualizacji
podpisanej innym kluczem i jedynym wyjściem byłoby odinstalowanie aplikacji
przez każdego użytkownika, co kasuje klucze i całą historię rozmów.

Katalog `android/keystore/` jest w `.gitignore` i jest wygodnym miejscem na tę
kopię — ale to nadal tylko jeden dysk.

## Rozmiar APK

Wydanie pakuje wyłącznie `arm64-v8a` i `armeabi-v7a`. Sterowana tym jest
właściwość `-Pabi`, ta sama, która decyduje o tym, co buduje cargo-ndk —
jedna lista, bo rozjazd dałby albo APK bez biblioteki dla zadeklarowanej
architektury (aplikacja wywala się przy starcie), albo bibliotekę zbudowaną
na darmo.

Lokalnie domyślnie dochodzi `x86_64`, bo bez niego nie ruszy emulator:

```bash
./gradlew assembleDebug
```

Filtr ABI odcina też architektury dorzucane przez JNA — `mips`, `mips64`
i `armeabi` zostały wycofane z NDK w 2018 roku i nie działają na żadnym
dzisiejszym urządzeniu.

Uwaga na `jniLibs/`: cargo-ndk tylko dokłada tam pliki, więc zadanie budujące
czyści katalog przed każdym przebiegiem. Bez tego biblioteka po usuniętej
zależności zostawała na dysku i trafiała do APK zbudowanego lokalnie —
w CI tego nie widać, bo checkout jest czysty.
