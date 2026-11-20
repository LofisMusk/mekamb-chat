#!/usr/bin/env bash
#
# Buduje rdzeń Rust dla iOS i składa z niego XCFramework z wiązaniami Swifta.
#
#     ios/skrypty/zbuduj-rdzen.sh
#
# Wynik (oba katalogi są w .gitignore — powstają z kodu, nie są kodem):
#   ios/Rdzen/MekambFFI.xcframework   biblioteka statyczna + nagłówek + modulemap
#   ios/Wygenerowane/mekamb_ffi.swift wiązania UniFFI dla Swifta
#
# # Dlaczego biblioteka statyczna, a nie dynamiczna jak na Androidzie
#
# iOS nie ładuje luźnych bibliotek `.dylib` z paczki aplikacji — dynamiczny kod
# musi siedzieć w podpisanym frameworku. Statyczna biblioteka linkuje się wprost
# do pliku wykonywalnego aplikacji i nie wymaga osobnego podpisu ani osadzania.
#
# # Dlaczego zawsze profil `release`
#
# Ten sam powód co na Androidzie: OpenMLS i OPAQUE w profilu debug są wolne na
# tyle, że logowanie i otwieranie kopert wyglądają na zawieszenie aplikacji.
# Kompilacja trwa dłużej tylko przy zmianie Rusta — cargo buforuje resztę.
#
# # Dlaczego wiązania generujemy z biblioteki HOSTA
#
# Profil `release` ma `strip = true`, a metadane UniFFI siedzą w sekcji, którą
# strip usuwa. Android ma dokładnie ten sam problem i to samo rozwiązanie
# (`buildHostLib` w android/app/build.gradle.kts). Obie biblioteki powstają
# z tego samego źródła w jednym przebiegu, więc rozjazd nie ma skąd się wziąć.
#
# # Kiedy składamy XCFramework od nowa
#
# Tylko gdy któraś z bibliotek jest nowsza niż znacznik ostatniego składania.
# Skrypt jest wołany z fazy budowania Xcode przy KAŻDYM buildzie; składanie
# frameworka za każdym razem zmieniałoby jego datę i wymuszało ponowne
# linkowanie aplikacji bez żadnej zmiany w kodzie.

set -euo pipefail

KORZEN="$(cd "$(dirname "${BASH_SOURCE[0]}")/../.." && pwd)"
IOS="$KORZEN/ios"
WYNIK_FRAMEWORK="$IOS/Rdzen/MekambFFI.xcframework"
WYNIK_SWIFT="$IOS/Wygenerowane"
ZNACZNIK="$IOS/Rdzen/.zlozono"
ROBOCZY="$KORZEN/target/ios-xcframework"

# Xcode uruchamia fazy skryptowe z okrojonym PATH, w którym nie ma rustupa.
# Dokładamy typowe miejsca instalacji — tak samo jak `rustPath` po stronie Gradle.
#
# Proxy rustupa MUSZĄ stać przed `/opt/homebrew/bin`: Homebrew potrafi mieć
# obok własny pakiet `rust`, bez bibliotek standardowych dla iOS. Wtedy build
# kończy się „can't find crate for `core`", co wygląda na brak celu w rustupie,
# choć cel jest zainstalowany — tylko nie ten kompilator został wywołany.
export PATH="$HOME/.cargo/bin:/opt/homebrew/opt/rustup/bin:/usr/local/opt/rustup/bin:$PATH:/opt/homebrew/bin:/usr/local/bin"

# Zmienne środowiskowe Xcode (SDKROOT, platforma symulatora, cele wdrożenia)
# przeciekają do cargo i potrafią skierować build hosta na SDK iOS — wtedy
# `uniffi-bindgen` nie linkuje się wcale. Rust dostaje czyste środowisko.
for zmienna in SDKROOT PLATFORM_NAME IPHONEOS_DEPLOYMENT_TARGET MACOSX_DEPLOYMENT_TARGET \
  LIBRARY_PATH CC CXX LD CFLAGS LDFLAGS; do
  unset "$zmienna" || true
done

# iOS 17 jak w project.yml. Bez tego rustc przyjmuje własne minimum i linker
# ostrzega przy każdym obiekcie, że zbudowano go „dla nowszej wersji".
export IPHONEOS_DEPLOYMENT_TARGET=17.0

cd "$KORZEN"

CELE=(aarch64-apple-ios aarch64-apple-ios-sim)

for cel in "${CELE[@]}"; do
  cargo build --release --target "$cel" -p mekamb-ffi
done

# Biblioteka hosta: wyłącznie dla metadanych UniFFI (patrz komentarz na górze).
unset IPHONEOS_DEPLOYMENT_TARGET
cargo build -p mekamb-ffi

BIBLIOTEKA_HOSTA="$KORZEN/target/debug/libmekamb_ffi.dylib"
URZADZENIE="$KORZEN/target/aarch64-apple-ios/release/libmekamb_ffi.a"
SYMULATOR="$KORZEN/target/aarch64-apple-ios-sim/release/libmekamb_ffi.a"

if [[ -f "$ZNACZNIK" && -d "$WYNIK_FRAMEWORK" && -f "$WYNIK_SWIFT/mekamb_ffi.swift" \
  && ! "$URZADZENIE" -nt "$ZNACZNIK" && ! "$SYMULATOR" -nt "$ZNACZNIK" \
  && ! "$BIBLIOTEKA_HOSTA" -nt "$ZNACZNIK" ]]; then
  echo "Rdzeń aktualny — XCFramework bez zmian."
  exit 0
fi

rm -rf "$ROBOCZY"
mkdir -p "$ROBOCZY/wiazania" "$ROBOCZY/naglowki" "$WYNIK_SWIFT" "$IOS/Rdzen"

cargo run -q -p mekamb-ffi --bin uniffi-bindgen -- \
  generate --library "$BIBLIOTEKA_HOSTA" \
  --language swift \
  --out-dir "$ROBOCZY/wiazania" \
  --no-format

# Nagłówek C i modulemap trafiają do frameworka; plik Swifta — do źródeł
# aplikacji. Moduł musi nazywać się `module.modulemap`, bo tylko tak nazwany
# plik Xcode znajduje sam w katalogu nagłówków XCFrameworka.
cp "$ROBOCZY/wiazania/mekamb_ffiFFI.h" "$ROBOCZY/naglowki/"
cp "$ROBOCZY/wiazania/mekamb_ffiFFI.modulemap" "$ROBOCZY/naglowki/module.modulemap"
cp "$ROBOCZY/wiazania/mekamb_ffi.swift" "$WYNIK_SWIFT/mekamb_ffi.swift"

rm -rf "$WYNIK_FRAMEWORK"
xcodebuild -create-xcframework \
  -library "$URZADZENIE" -headers "$ROBOCZY/naglowki" \
  -library "$SYMULATOR" -headers "$ROBOCZY/naglowki" \
  -output "$WYNIK_FRAMEWORK" >/dev/null

touch "$ZNACZNIK"
echo "Złożono $WYNIK_FRAMEWORK"
