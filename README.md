# mekamb-chat

An open-source, end-to-end encrypted messenger with a **P2P-first** architecture.

> # ⚠️ This is the `dev` test branch — NOT for personal use
>
> This branch **deliberately weakens security** to make testing easier (the
> server's `TRYB_DEWELOPERSKI` flag, see [`server/src/dev.ts`](server/src/dev.ts)):
>
> - **skips 2FA** — sign-in accepts any TOTP code,
> - **disables sign-in rate limits**,
> - **activates accounts without confirmation**,
> - exposes a `/dev/seed` endpoint with ready-made accounts with **known passwords**
>   (`test1` / `test2`, password `test1234`).
>
> Run it **only** on a separate test deployment (`wrangler deploy --env dev`,
> a separate D1 database) and **never have private conversations on it**. The app
> built from this branch shows a warning about this and asks for confirmation
> before creating an account. For real use there's the **`main`** branch, where
> these back doors don't exist.

> **Status: under construction, not audited.** Don't use it where disclosure of
> the content would have serious consequences. See [`SECURITY.md`](SECURITY.md).

## Principles

- **Every conversation end-to-end encrypted** — MLS (RFC 9420), no home-made cryptography
- **Traffic goes directly between devices** — hole punching gets through NAT in roughly 90–95% of cases
- **DMs and multi-person groups** — a DM is simply an MLS group of size 2
- **Photos and video** — encrypted with a separate key per file; location and device data are stripped
- **Voice and video calls** — WebRTC mesh for up to 4 people, no media server
- **Sign-in: username + password + TOTP code** — the password goes through OPAQUE, so the server never sees it
- **Keys only on the device** — the server has nothing to hand over or lose
- **Zero hosting cost** — free tiers of Cloudflare and GitHub Pages

## Architecture at a glance

The server is supporting infrastructure, not a party to the conversation.

| Traffic | Channel |
|---|---|
| Messages, call media | Directly between devices (own UDP transport, WebRTC) |
| MLS commits (group membership changes) | `GroupRelay` — the only ordering point |
| Messages for offline devices | `UserInbox` |
| Directory, key packages, push | Worker + D1 |

Rationale and the full description: [`docs/PROTOCOL.md`](docs/PROTOCOL.md).
What is protected and what is **not**: [`docs/THREAT_MODEL.md`](docs/THREAT_MODEL.md).
The visual system shared by all clients: [`docs/UI_NEUTRALNY.md`](docs/UI_NEUTRALNY.md).

## Clients

| Platform | Technology | Distribution |
|---|---|---|
| Android | Kotlin + Compose, core via UniFFI | Signed APK in Releases |
| iOS | Swift + SwiftUI, core via UniFFI (XCFramework) | Built from Xcode (no App Store build yet) |
| Desktop, browser, iOS without Xcode | PWA, core via WebAssembly | GitHub Pages |

The native iOS app is new and mailbox-only for now (no direct UDP transport, no
push, no optical pairing). Push needs APNs, which a free Apple ID doesn't give —
until that exists, the PWA added to the home screen is the way to get Web Push
on iPhone (Safari 16.4+).

The interface language is English by default; Polish is available in settings and
on the welcome screen on every client.

## Layout

```
core/       Rust — cryptography: identity, MLS, framing, envelopes
opaque/     Rust — OPAQUE (RFC 9807), one implementation for server and clients
core/bindings/  WASM (browser) and UniFFI (Android, iOS) — one core, two bindings
transport/  Rust — P2P networking: UDP, STUN, Noise IK, delivery path selection
server/     Cloudflare Workers — auth, directory, mailbox, commit ordering
web/        PWA (desktop, browser)
android/    Kotlin
ios/        Swift (project generated from ios/project.yml with xcodegen)
docs/       Protocol, threat model, visual system
proto/      Normative message format
```

Cryptography is written **once**, in Rust. The user interface is native per
platform, the security layer is not — parallel MLS implementations would drift
apart in the most sensitive place in the system.

`core` and `transport` are separate on purpose: the cryptographic core builds for
WASM without any C toolchain, and the heavy networking dependency doesn't weigh on
code that only needs MLS.

## Building

Required: Rust 1.85+.

```bash
cargo test
```

Running everything locally (backend + web client):

```bash
cd server && npx wrangler d1 migrations apply mekamb --local && npx wrangler dev
```

```bash
cd web && npm run dev
```

iOS (needs Xcode and `xcodegen`; the build compiles the Rust core first):

```bash
cd ios && xcodegen generate && open Mekamb.xcodeproj
```

Checking the core for the browser — works anywhere, no extra tools:

```bash
cargo check -p mekamb-core --target wasm32-unknown-unknown
```

The transport for WASM needs a clang that can target wasm32 (the system clang on
macOS can't — you need LLVM, e.g. from Homebrew). CI checks this on Linux:

```bash
CC_wasm32_unknown_unknown=clang AR_wasm32_unknown_unknown=llvm-ar cargo check -p mekamb-transport --target wasm32-unknown-unknown
```

## Progress

- [x] **Phase 0** — repository skeleton, CI, protocol documentation
- [x] **Phase 1** — core: identity, key derivation, MLS groups, framing
- [x] **Phase 2** — own P2P transport: UDP, STUN, Noise, fallback to the mailbox
- [x] **Phase 3** — backend: Durable Objects, directory, OPAQUE + TOTP
- [x] **Phase 4** — PWA: registration, sign-in, text DMs, deployment to Pages
- [x] **Phase 5** — Android: the APK builds, signs in and keeps the P2P transport up
- [x] **Phase 6** — attachments: photos and video encrypted end-to-end
- [x] **Phase 7** — multi-person groups: adding members, fan-out to the group
- [~] **Phase 8** — safety numbers (device linking by QR is what's left)
- [~] **Phase 9** — 1:1 calls: negotiation and fingerprint verification tested, media capture not
- [~] **Phase 10** — group mesh calls for up to 4 people (as above)
- [~] **Phase 11** — native iOS app: sign-in, conversations, calls; transport, pairing and push still missing
- [ ] **Phase 12** — hardening: reproducible builds, audit, production deployment

## Deployment

| | |
|---|---|
| Web client | https://lofismusk.github.io/mekamb-chat/ |
| Backend | https://mekamb.grubyogon10.workers.dev |

**Attachments are disabled** until R2 is enabled on the Cloudflare account. Until
then the endpoints return a readable 503 instead of crashing. Once it's enabled:
uncomment `r2_buckets` in [`server/wrangler.jsonc`](server/wrangler.jsonc) and run
`wrangler deploy`.

Registration is open — anyone can create an account. That's a deliberate state for
the testing period; limiting it to invitations is noted as an open question.

## License

- `core/`, `web/`, `android/`, `ios/` — Apache-2.0 ([`LICENSE-APACHE`](LICENSE-APACHE))
- `server/` — AGPL-3.0 ([`server/LICENSE-AGPL`](server/LICENSE-AGPL))

AGPL on the server forces anyone who runs their own instance to publish their
changes. In a messenger a swapped server is a real attack vector, so its code
should be verifiable.
