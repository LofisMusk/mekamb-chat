# CLAUDE.md

This file provides guidance to Claude Code (claude.ai/code) when working with code in this repository.

## Language

**Code, comments, commit messages and UI strings are in Polish.** Identifiers use
Polish names (`Wiadomosc`, `zapiszRozmowe`, `PrzyciskGlowny`). Match the existing
style — do not introduce English identifiers into Polish modules.

Doc comments explain **why**, not what. Most modules open with a `# Dlaczego …`
section stating the decision and the alternative rejected. Keep that habit.

## Commands

### Rust core (`core`, `opaque`, `transport`, bindings)

```bash
cargo test                                   # all crates
cargo test -p mekamb-core qr                 # single module's tests
cargo fmt --all --check                      # CI runs this
cargo clippy --all-targets --all-features    # CI treats warnings as errors
```

CI runs `fmt`, `clippy` and `test`. **Run clippy locally before pushing** — it has
caught pushes that passed tests.

### Server (`server/`) — Cloudflare Workers

```bash
cd server
npm test                       # vitest on workerd, not a mock
npx vitest run test/inbox.test.ts
npm run typecheck
npx wrangler dev
npx wrangler deploy
```

Tests run on **workerd** via `@cloudflare/vitest-pool-workers`, so Durable
Objects, D1 and WebSocket hibernation behave as in production. R2 is emulated by
miniflare (`r2Buckets` in `vitest.config.ts`).

### Web (`web/`) — PWA

```bash
cd web
npm run build                  # builds WASM, typechecks, bundles
npm test
npx vitest run src/lib/qr.test.ts
npm run typecheck
VITE_API_URL=https://… npx vite --port 5174
```

`npm run dev`/`build` rebuild the WASM bindings first via `wasm-pack`.
`tsconfig` has `noUncheckedIndexedAccess` — indexed access yields `T | undefined`.

### Android (`android/`)

```bash
cd android
./gradlew assembleDebug
./gradlew assembleDebug -PapiUrl=https://…      # override backend
./gradlew assembleRelease -Pabi=arm64-v8a,armeabi-v7a
```

`-Pabi` drives **both** cargo-ndk and APK packaging — one list, because a mismatch
either ships an APK without the library for a declared ABI (crash on launch) or
builds one for nothing.

Release signing reads `ANDROID_KEYSTORE_PATH` / `_PASSWORD` / `ANDROID_KEY_ALIAS`
/ `ANDROID_KEY_PASSWORD` from the environment. The only copy of the signing key
lives in `android/keystore/` (gitignored) and in GitHub secrets — losing it means
no more updates can be published.

Emulator needs `-gpu swiftshader_indirect`; the default GPU path fails with a
context error on this host.

## Architecture

### Crypto is written once, in Rust

```
core/       identity, MLS groups, framing, envelopes, attachments, safety
            numbers, media metadata stripping, QR generation
opaque/     OPAQUE (RFC 9807) — same code for server and both clients
transport/  UDP + STUN + Noise IK, hand-written (replaced iroh)
core/bindings/wasm     → web
core/bindings/uniffi   → Android
```

Two parallel MLS implementations would drift, so the UI is native per platform
and the security layer is not. **When adding anything cryptographic or
wire-format, put it in `core` and expose it through both bindings** — never
reimplement it in TypeScript or Kotlin.

Concretely: envelope encoding, attachment sealing and QR generation all live in
Rust for this reason. `add_member` returns *already-enveloped* commit and welcome
bytes so callers cannot forget to wrap them.

`proto/chat.proto` is the **normative document**; the Rust types are hand-written
`prost::Message` structs. Changing one requires changing the other.

### The server is infrastructure, not a participant

| Traffic | Path |
|---|---|
| Messages, media | Directly between devices; mailbox as fallback |
| MLS commits | `GroupRelay` Durable Object — the only ordering point |
| Offline delivery | `UserInbox` Durable Object |
| Directory, key packages | Worker + D1 |
| Attachments, transfer dumps | R2 (ciphertext only) |

`docs/PROTOCOL.md` is normative. `docs/THREAT_MODEL.md` states what is **not**
protected. Tests assert the server never holds plaintext by grepping stored
state for known markers — keep that pattern when adding stored data.

## Invariants that span files

**HKDF labels are frozen.** `core/src/identity.rs` derives every key from one
seed with disjoint labels. `LABEL_IROH_NODE` is historically misnamed (iroh is
long gone) — changing the string would orphan every existing device's keys.

**The history format version must be bumped on both clients in the same change.**
`web/src/lib/historia.ts` and `android/.../Historia.kt` must agree on shape *and*
number. This has already broken once: Android gained a field while keeping
version 1, so both clients claimed the same number for incompatible shapes and
account transfer silently produced empty history. Same rule for the transfer dump
format in `przeniesienie.ts` / `Przeniesienie.kt`.

**Envelopes are acked only after the client has persisted MLS state.** The
mailbox deletes on ack, so acking earlier loses messages. A frame that fails
processing is retried a bounded number of times and then acked as dead —
otherwise it redelivers forever (`web/src/lib/koperty.ts`).

**The inbox connection needs a keepalive and reconnect.** The server answers
`ping` with `pong`; the client half is in `web/src/lib/polaczenie.ts`. Without it
an idle socket is dropped and nothing recovers it.

**The service worker must serve the document network-first.** Cache-first on
`index.html` pins the app to one bundle forever and makes every deploy invisible.

## UI system

Both clients implement **Nocturne**, from the design project. Tokens are written
out explicitly in `web/src/styles.css` and `android/.../Nocturne.kt` — changing
the design means rewriting tokens on both sides, not re-picking shades.

Its defining rule: **the accent is a line, never a fill.** Primary actions are
outlined. A filled accent button immediately reads as belonging to a different
system.

Icons on Android are hand-drawn SVG paths in `Ikony.kt` — Phosphor is not
available and `material-icons-extended` weighs several MB against a 5.4 MB
release APK.

## Testing conventions

Tests state the decision they defend, not the mechanics. Comments like
*„Sedno: serwer przechowuje szyfrogram, więc nie może w nim być treści"* explain
why the test exists.

Where an implementation could plausibly be wrong in a way that still "works",
compare against an independent one rather than round-tripping through yourself:
the QR encoder is checked module-by-module against 40 fixtures produced by the
TypeScript implementation (`core/testy/qr-wzorce.tsv`), because a decoder is
lenient enough to accept genuinely broken codes — error correction repairs them.

## Not implemented

A/V calling on Android (no WebRTC dependency; the core does not export call
signalling to UniFFI — only WASM has `sendCallSignal`). Push notifications
(needs `google-services.json`). Camera-based QR scanning on Android. Search in
the conversation list.
