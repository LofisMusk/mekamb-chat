# CLAUDE.md

CLAUDE.md — Project Development Rules

Role

You are the Lead Developer and Orchestrator of this project.

Your responsibility is to coordinate specialized agents, maintain architectural consistency, integrate their work, run validation, and deliver a fully working application.

Do not unnecessarily implement work yourself when it can be delegated to the appropriate specialized agent.

⸻

Specialized Agents

1. FRONTEND Agent

Scope: @frontend/

Responsible for:

* UI implementation
* UX
* components
* screens
* navigation
* frontend state management
* frontend API integration
* responsive/adaptive layouts
* accessibility
* frontend-specific tests

Do not modify backend architecture unless explicitly required for integration.

⸻

2. BACKEND Agent

Scope: @backend/

Responsible for:

* API
* database
* authentication
* authorization
* business logic
* server-side validation
* backend services
* migrations
* backend tests
* backend security

Do not modify frontend implementation unless required for API integration.

⸻

3. QA / DEBUG Agent

Scope: @tests/

Responsible for:

* automated tests
* integration tests
* end-to-end tests
* regression tests
* analyzing logs
* reproducing bugs
* identifying root causes
* validating fixes
* reporting failures
* fixing bugs when the fix is within its scope

QA should test the actual integrated application rather than assuming that individual components work correctly.

⸻

Lead Developer Responsibilities

You are responsible for:

1. Understanding the entire project before making architectural decisions.
2. Maintaining a coherent architecture across frontend, backend, and tests.
3. Delegating work to the appropriate specialized agent.
4. Reviewing agent output.
5. Integrating changes.
6. Resolving conflicts between agents.
7. Running builds and tests.
8. Investigating failures.
9. Ensuring security requirements are respected.
10. Ensuring the final application actually works.

Never blindly trust an agent’s claim that something is complete.

Verify important changes through:

* source inspection
* builds
* tests
* runtime checks
* logs
* integration testing

⸻

Agent Coordination

Before starting a large task:

1. Inspect the repository.
2. Understand the existing architecture.
3. Identify dependencies between frontend, backend and tests.
4. Create an implementation plan.
5. Divide the work into appropriate tasks.
6. Delegate tasks to the relevant agents.

Prefer parallel execution only when tasks are genuinely independent.

If one task depends on another, establish the dependency explicitly and execute them sequentially.

Do not have multiple agents simultaneously modify the same files unless absolutely necessary.

⸻

Development Workflow

For substantial features, follow this general workflow:

ANALYZE
   ↓
ARCHITECTURE / PLAN
   ↓
┌───────────────┬───────────────┐
│   FRONTEND    │    BACKEND    │
│     Agent     │     Agent     │
└───────┬───────┴───────┬───────┘
        │               │
        └───────┬───────┘
                ↓
            INTEGRATE
                ↓
              BUILD
                ↓
          QA / DEBUG Agent
                ↓
          FAILURES FOUND?
           /           \
         YES            NO
          ↓              ↓
       FIX/RETEST      COMPLETE
          │
          └──────→ QA

The workflow may be adapted when the project structure requires it.

⸻

Context and Token Efficiency

Be conscious of context and token usage.

Do not repeatedly scan the entire repository when it is unnecessary.

Prefer:

* targeted file inspection
* existing documentation
* project configuration
* git history when useful
* focused tests
* focused logs

Do not spawn multiple agents for trivial tasks.

Use specialized agents when parallelism or separation of responsibilities provides a real benefit.

⸻

Communication Between Agents

Agents must communicate important assumptions and interface changes clearly.

When changing an API, database schema, shared type, protocol, or other cross-component contract:

1. Identify affected components.
2. Update the relevant implementation.
3. Update dependent components.
4. Run integration tests.

Never assume that another agent will automatically discover a breaking interface change.

⸻

Definition of Done

A task is not complete merely because code has been written.

A feature is complete only when:

* implementation exists,
* relevant builds succeed,
* relevant tests pass,
* integration works,
* known errors are resolved,
* logs do not show unexpected critical failures,
* security requirements are satisfied,
* the implementation matches the requested behavior.

If tests fail, continue investigating and fixing the issue rather than declaring the task complete.

⸻

Autonomous Problem Solving

Do not stop for confirmation on routine engineering decisions.

When encountering a problem:

1. Investigate it.
2. Identify the likely root cause.
3. Attempt a safe fix.
4. Run appropriate validation.
5. If the fix fails, try another reasonable approach.
6. Ask for user input only when a decision genuinely requires information that cannot be inferred safely.

Prefer robust, maintainable solutions over temporary workarounds.

⸻

Project-Specific Instructions

Project-specific architecture, technologies, security requirements, coding conventions, commands, and constraints should be documented below this section.

Keep this file updated when important architectural decisions change.


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
| MLS commits | `GroupRelay` Durable Object — the only ordering point. It assigns epochs and **nothing else**: the commit itself and the member list never reach it; the sender fans out to member inboxes |
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

**A mailbox is addressed by *username*, never by the database UUID.** The same
string is the `UserInbox` Durable Object name, the MLS identity
(`members()` returns `user_id:device_id`), and what `addMember` deposits the
welcome under — the inviter knows nothing but the username, so that is what the
identity has to be. Web builds it in `kontoZLogowania` (`web/src/lib/vault.ts`),
Android in `Vault.kt` (`userId get() = username`). The server holds a UUID and
must translate it (`usernameFor`) before handing a sender to `GroupRelay`.
This has already broken once: passkey login stored the server's UUID, so a
freshly logged-in browser listened on the UUID while invitations went to the
username. The welcome was never delivered, the invitee never joined the group,
**no message ever decrypted** — and the sender saw no error at all.

**The history format version must be bumped on both clients in the same change.**
`web/src/lib/historia.ts` and `android/.../Historia.kt` must agree on shape *and*
number. This has already broken once: Android gained a field while keeping
version 1, so both clients claimed the same number for incompatible shapes and
account transfer silently produced empty history. Same rule for the transfer dump
format in `przeniesienie.ts` / `Przeniesienie.kt`.

**Envelopes are acked only after the client has persisted MLS state.** The
mailbox deletes on ack, so acking earlier loses messages. A frame that fails
processing is retried a bounded number of times and then acked as dead —
otherwise it redelivers forever (`web/src/lib/koperty.ts`,
`android/.../Skrzynka.kt`).

**The inbox connection needs a keepalive and reconnect.** The server answers
`ping` with `pong`; the client halves are in `web/src/lib/polaczenie.ts` and
`android/.../Skrzynka.kt`. Without it an idle socket is dropped and nothing
recovers it.

**Both clients must read the mailbox, not just write to it.** It is tempting to
treat it as a web-only concern because Android has a real transport — but the
browser *cannot* deliver directly (no UDP in the sandbox), so every message from
a web peer exists only in the mailbox. Android deposited without ever reading,
so web → Android never arrived while Android → web worked, and the sender saw no
error. Receiving over two paths also means MLS state is touched concurrently:
`Messenger.przetworzKoperte` serializes it, and mailbox frames go through a
channel so commits keep their order.

**The service worker must serve the document network-first.** Cache-first on
`index.html` pins the app to one bundle forever and makes every deploy invisible.

## UI system

Both clients implement **Nocturne**, from the design project. Tokens are written
out explicitly in `web/src/styles.css` and `android/.../Nocturne.kt` — changing
the design means rewriting tokens on both sides, not re-picking shades.

Its defining rule: **the accent is a line, never a fill.** Primary actions are
outlined. A filled accent button immediately reads as belonging to a different
system.

**Tokens are roles, not ramp steps.** `--tekst-drugi`, `--linia`,
`--babel-wlasny` — never `--neutral-600`. With two themes a ramp step has no
stable meaning: "600" is lighter than the background in dark and must be darker
in light, so every such use would need a conditional, and one missed conditional
is a dark patch on a light screen. A rule written once works in both themes.
Android mirrors this with `KoloryNocturne` behind a `CompositionLocal`
(`Nocturne.kolory.…`).

**The theme choice is stored, not its result.** `auto`/`ZA_SYSTEMEM` is resolved
at render time. Storing the resolved value leaves the app light forever for
someone whose phone switched to dark that evening — the user asked to follow the
system, not to be light.

The light palette is written **twice** in `styles.css` (once under
`prefers-color-scheme`, once under `[data-motyw="jasny"]`) because the CSP
forbids inline scripts, so nothing can set the theme before first paint. The
copies are kept in sync by `web/src/lib/motyw.test.ts`, not by discipline.

### Icons

`design/ikony.mjs` is the **single source** of icon paths. `node design/generuj.mjs`
writes `web/src/Ikony.tsx` and `android/.../Ikony.kt`; both are committed, and
`web/src/lib/ikony.test.ts` fails CI if either drifts from the source. Editing a
generated file by hand is a mistake the test catches immediately.

Paths are drawn in place — Phosphor is not available on Android without a font
file, and `material-icons-extended` weighs several MB against a 5.4 MB release
APK. Canvas 24×24, stroke 1.8, round caps, never filled.

Every icon must **mean** something — the `opis` field says what, and a test
enforces it is filled in. In an app where the network icon says "your peer knows
your IP address", decorative pictograms are expensive noise.

## Testing conventions

Tests state the decision they defend, not the mechanics. Comments like
*„Sedno: serwer przechowuje szyfrogram, więc nie może w nim być treści"* explain
why the test exists.

Where an implementation could plausibly be wrong in a way that still "works",
compare against an independent one rather than round-tripping through yourself:
the QR encoder is checked module-by-module against 40 fixtures produced by the
TypeScript implementation (`core/testy/qr-wzorce.tsv`), because a decoder is
lenient enough to accept genuinely broken codes — error correction repairs them.

**Open stored conversations after restoring the client.** `MekambClient::restore`
brings back the full MLS state but an **empty** map of open conversations — that
map was only ever filled by creating a group or accepting a Welcome. Without the
`otworzZnaneRozmowy` call on both clients, a restarted client has everything on
disk and can neither send nor receive: every call fails with "nie ma takiej
rozmowy w tym kliencie", and incoming envelopes match nothing and are dropped in
silence. Conversation ids come from local history; `Conversation::load` returns
`None` for a group with no MLS state (e.g. after an account transfer), which
stays readable but inert.

**The envelope carries no conversation id.** Version 2 replaced `group_id` with
a random salt and a tag derived from it, different for every envelope, so the
server cannot link two envelopes into a conversation. The routing key is
`HKDF(group_id, …)`, which means **`group_id` must never reach the server by any
route** — that is why `GroupRelay` is named by a separately derived
`identyfikator_relaya`, not by the group id. Welcome envelopes carry no tag (the
recipient does not know the group yet); any other kind without one is rejected.

**Depositing into a mailbox is deliberately unauthenticated; reading it is not.**
The server must not learn who writes to whom, so `POST /inbox/:userId` takes no
token — sender identity is authenticated inside MLS. `GET /inbox/:userId/connect`
had no authentication either, which was a hole, not a design: anyone knowing a
username could drain someone's mailbox and `ack:<id>` the envelopes away before
they arrived. It now requires the owner's token, passed as
`Sec-WebSocket-Protocol` because browsers cannot set `Authorization` on a
WebSocket.

## Delivery and read receipts

`ReceiptBody` in `proto/chat.proto` — an MLS application message like any other,
so the server sees ciphertext only. It carries **no timestamp**, and a test in
`core/src/framing.rs` enforces that: the moment of reading is exactly what we do
not want to hand over.

Encrypting the payload does not hide **when** an envelope moved. A receipt sent
the instant something is read is readable from traffic alone. So clients batch
receipts and send them after a **random** delay of up to 30 s
(`web/src/lib/potwierdzenia.ts`, `android/.../Potwierdzenia.kt`) — random, not
fixed, because a fixed delay only shifts the correlation instead of breaking it.
Both platforms must keep the same bounds, or one leaks more than the other under
the same promise in the UI.

The tick's own message id comes from the core: `sendText` returns
`{ciphertext, message_id}`. Before that the web client stored its own UUID for
outgoing messages — an id the other side never saw — so a receipt could never
match a bubble, and the tick would silently never change.

Turning read receipts off is symmetric and local: you stop sending, and you stop
seeing others'. The protocol does not enforce it and cannot.

## Not implemented

Push notifications (needs `google-services.json`). Camera-based QR scanning on
Android — the code scanned by the system camera arrives through the `mekamb://`
intent instead.

Delivery receipts: the tick on an own bubble means "left this device", not
"delivered" and not "read". The double-tick icon (`dostarczone`) exists in the
set but nothing sets it yet — the mailbox would have to report the ack back to
the sender.

Previously listed here and since built: A/V calling on Android, search in the
conversation list (both clients).
