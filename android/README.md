# mekamb-chat — Android client

Kotlin + Jetpack Compose. The cryptographic core and the transport come from Rust
through UniFFI — the same code the web and iOS clients use.

## How it differs from the web client

**P2P actually works here.** Android punches through NAT and connects straight to
the other device; the server mailbox only comes into play when the recipient
can't be reached. In the browser there's always an intermediary, because the
sandbox doesn't allow incoming connections. Android also reads the mailbox, since
messages from web and iOS peers exist only there.

## Requirements

- Android Studio with the SDK (platform 36)
- **NDK** — Settings → SDK Manager → SDK Tools → tick *NDK (Side by side)*
- `cargo-ndk`:

```bash
cargo install cargo-ndk && rustup target add aarch64-linux-android armv7-linux-androideabi x86_64-linux-android
```

## Building

Gradle builds the Rust core and generates the Kotlin bindings itself — there's no
separate step to remember:

```bash
cd android && ./gradlew assembleDebug
```

The bindings are generated from the **metadata of the built library**, not from a
separate description file, so they can't drift from the Rust code.

The default backend address is `http://10.0.2.2:8787` — that's how the emulator
sees `wrangler dev` on the host. Override it with `-PapiUrl=https://…`.

The emulator needs `-gpu swiftshader_indirect`; the default GPU path fails with a
context error on some hosts.

## Pitfalls this build ran into

Written down because each one cost a separate attempt:

- **AGP 9 has built-in Kotlin support.** The separate `kotlin.android` plugin
  isn't just redundant — the build rejects it.
- **UniFFI metadata can't be read from the Android artifact.** The `release`
  profile strips it, so the bindings are generated from a separate host library.
  Both come from the same source in one pass.
- **`close()` clashes with `AutoCloseable`.** UniFFI generates its own `close()`
  to release the native handle; our own method with that name creates an
  ambiguous overload. Ours is called `shutdown`.
- **Secondary constructors end up in the companion object.** `MekambTransport` is
  created with `MekambTransport.start(...)`, not the class constructor.

## History: why the transport is our own

The first version was built on iroh. Sign-in worked, but the process died right
after it with a native `abort()`:

```
signal 6 (SIGABRT)
Abort message: 'android context was not initialized'
```

`rustls-platform-verifier` — pulled in by `reqwest`, which iroh uses for relays —
requires JNI initialisation on Android and **aborts the process** without it. It
couldn't be turned off with a feature flag, because the dependency is hard.

Instead of going into JNI and vendoring someone else's Kotlin component from
outside Maven, the transport was rewritten: UDP, STUN and Noise. Neither `reqwest`
nor `rustls-platform-verifier` is in the dependency tree any more.

## What's still missing

- **Push (FCM).** The layer is ready to be added; it needs `google-services.json`
  from a Firebase project. The payload must be wake-up only — no sender, no content.
- **Camera QR scanning in the app.** A code scanned with the system camera arrives
  through the `mekamb://` intent instead.

## Release signing key

An unsigned APK can't be installed — Android refuses. The key **is not in the
repository**; the release workflow reads it from GitHub secrets and stops if they're
missing. Signing with the debug key would be worse than not signing: the file would
install, so nobody would notice that an "end-to-end encrypted" messenger is signed
with a key everyone has on disk.

The key is created once:

```bash
keytool -genkeypair -v -keystore wydanie.jks -alias mekamb -keyalg RSA -keysize 4096 -validity 10950
```

Then four repository secrets (`Settings → Secrets and variables → Actions`):

| Secret | Contents |
| --- | --- |
| `ANDROID_KEYSTORE_BASE64` | `base64 -i wydanie.jks \| tr -d '\n'` |
| `ANDROID_KEYSTORE_PASSWORD` | keystore password |
| `ANDROID_KEY_ALIAS` | key alias (`mekamb`) |
| `ANDROID_KEY_PASSWORD` | key password |

**Keep the `wydanie.jks` file outside the repository.** GitHub secrets can't be
read back once saved, so the copy on disk is the only one. Without this key no
further updates can be released — Android refuses to install an update signed with
a different key, and the only way out would be for every user to uninstall the
app, which wipes the keys and the entire chat history.

The `android/keystore/` directory is in `.gitignore` and is a convenient place for
that copy — but it's still just one disk.

## APK size

The release packages only `arm64-v8a` and `armeabi-v7a`. This is driven by the
`-Pabi` property, the same one that decides what cargo-ndk builds — one list,
because a mismatch would give either an APK without the library for a declared
architecture (the app crashes on start) or a library built for nothing.

Locally `x86_64` is added by default, because the emulator won't start without it:

```bash
./gradlew assembleDebug
```

The ABI filter also cuts architectures added by JNA — `mips`, `mips64` and
`armeabi` were removed from the NDK in 2018 and don't run on any current device.

Watch out for `jniLibs/`: cargo-ndk only adds files there, so the build task
clears the directory before every run. Without that, the library of a removed
dependency stayed on disk and ended up in a locally built APK — CI doesn't show
it, because its checkout is clean.
