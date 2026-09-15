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

3. Android app Agent

Scope: @android/

Responsible for:
* frontend changes for the android app
* general app changes
* android app security
* android app testing and emulating

Modify the app's frontend according to the webui so they look similar, only dont do it when the user says for example: only on the website do ...; it needs to be specified.

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
| Attachments | R2 (ciphertext only) |

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

**A transport address is worth nothing until its signature checks out, and
the key must come from the MLS tree.** The directory hands out each device's
transport key and addresses, and a client that trusts them sends envelopes
straight there. Content stays sealed, but delivery to a substituted address
*succeeds*, so the mailbox fallback never fires: the message vanishes with no
error on either side and the substituter learns who talks to whom. The record
is therefore signed with the device's MLS signature key (`core/src/adres.rs`,
length-prefixed fields under a distinct label) and verified through
`verifyPeerAddress`, which deliberately takes **no key argument** — it reads the
signature key from the conversation's MLS tree, the same anchor as the safety
number. Verifying with the `mlsPublicKey` that arrived beside the signature
proves nothing: the server would have issued both. This was a column and two
comments for a long time before it was any code; an unsigned record now means
"mailbox only", never "trust it".

**The history format version must be bumped on both clients in the same change.**
`web/src/lib/historia.ts` and `android/.../Historia.kt` must agree on shape *and*
number. This has already broken once: Android gained a field while keeping
version 1, so both clients claimed the same number for incompatible shapes and
the optical history transfer to a freshly paired device silently produced empty
history.

**Envelopes are acked only after the client has persisted MLS state.** The
mailbox retains until ack, so acking earlier loses messages. A frame that fails
processing is retried a bounded number of times and then acked as dead —
otherwise it redelivers forever (`web/src/lib/koperty.ts`,
`android/.../Skrzynka.kt`).

**An ack is a fact about one envelope, not a high-water mark.** Clients ack out
of order on purpose: an envelope that fails to process is left for a retry while
a later one that succeeded is acked immediately (`web/src/lib/koperty.ts`,
`android/.../Skrzynka.kt`). A single `ostatni_id` cursor raised to `MAX`
therefore skipped the held-back envelope forever — `flushTo` only sent
`id > cursor` — and deleted it, so the whole retry policy did nothing and a
commit or welcome lost that way reproduced the silent "nothing decrypts"
failure. `device_reads` stores the set of envelope ids each device has read;
a gap stays a gap and comes back on the next connection.

**An ack marks the envelope read for *one device*, never for the account.** One
mailbox is shared by all of a user's devices (it is named by username). The
queue is therefore an append-only log and `UserInbox` tracks reads per device
in `device_reads`; only retention deletes an envelope, because the mailbox does
not know the group's membership and so cannot know how many devices still owe a
read. This has already broken once: the queue deleted on the first ack, so
whichever device processed an envelope first deleted it for the rest — and
because welcomes and MLS commits travel the same queue, a device that lost one
never joined the group, so sending and receiving both failed on it with no error
(`server/src/inbox.ts`). The device identity is taken from the authenticated
token in `GET /inbox/:userId/connect`, not from client-supplied data, so no one
can read another device's backlog.

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

Both clients implement **Nocturne**, in its **"Mekamb Mobile"** variant. Tokens
are written out explicitly in `web/src/styles.css` and `android/.../Nocturne.kt`
— changing the design means rewriting tokens on both sides, not re-picking
shades.

Its defining rule: **the accent is a fill, not a line.** Primary actions are
flooded with colour, switches are iOS-style, badges are filled. This is a
deliberate reversal of the original Nocturne, where the accent was an outline and
a filled accent button "immediately read as belonging to a different system". The
reason is that this is a messenger, not a console: it has to look like the native
thing people already use. Android moved first (`Nocturne.kt` carries the
rationale); web followed and now matches it.

Do not "restore" the outline rule from an old comment or an old artboard. If the
outline is ever wanted back, that is a design decision taken again on both
clients at once — not a local fix.

**The accent is the user's choice, and it repaints everything.** Eight colours,
the *same eight swatches* on both platforms — `PALETA_AKCENTOW`
(`web/src/lib/akcent.ts`) and the `Akcent` enum (`Nocturne.kt`). One pick
substitutes the accent, the own-message bubble and the unread badge together, so
the whole interface turns over at once.

**The vivid swatch is a swatch, never a fill.** Both platforms now split the two,
and the split is the whole point:

| | swatch in the picker | filled under white text | ink on a neutral ground |
|---|---|---|---|
| web | `probka` | `fill` — darkened (green `#34C759` → `#19702F`) | `fill` |
| Android | `probka` | `wypelnienie` — the same values as web's `fill` | `farba(jasny)` |

Green, orange, pink and teal under **white** text land under 4.5:1 — the same
trap that once forced the brand cyan down to `#0E7490`. Android used to fill with
the vivid swatch directly (`babelWlasny = akcent.probka`), so on the phone those
four accents put white text on too light a ground in every primary action and
every own bubble. `Akcent` now carries `wypelnienie` beside `probka`, copied 1:1
from web's `fill` so the two clients cannot drift apart on the same conversation.

Android splits one step further than web, because a role that is *ink* has the
opposite requirement to a role that is *fill*: ink must contrast with the
**background**, which flips with the theme. `akcent` is now fill-only and
`akcentTekst` is ink-only, resolved per theme by `Akcent.farba(jasny)` — dark
shade on light, vivid shade on dark. Icon tints, focused borders and accent
labels were reading from `akcent` and were moved across; `akcent` survives on
exactly five call sites, all of them genuine fills.

**The threshold is now a test, not discipline.** `KontrastAkcentuTest.kt` and the
matching block in `akcent.test.ts` compute the WCAG ratio for all eight fills
under white and require 4.5:1. Two things they deliberately record rather than
enforce:

- **`niebieski` is a pinned exception at 4.02:1.** It is the iOS system blue, the
  default accent on both clients and a hard value in `styles.css`. Darkening it
  is a design decision taken on both clients at once, so the tests assert its
  exact ratio — the exception is visible instead of silent, and the assertion
  fails the day someone changes it.
- **Secondary surfaces are not covered.** On the dark card `#2C2C2E` indigo ink
  is 2.47:1, and `PrzyciskDrugi`'s label on the light `#F2F2F7` drops to 4.33:1
  for orange. Closing that needs a *third* shade per accent (a separate dark-theme
  ink) on both platforms — a palette decision, not a local fix. The ink test
  holds a 3:1 floor against each theme's primary background and says so.

**The own bubble now tracks the theme.** `--babel-wlasny` is the accent
(`#007AFF` light, `#0A84FF` dark), not a fixed shade. The older rule — one shade
in both themes, "because an utterance should not change author with the time of
day" — went out with the brand cyan, since the bubble follows a colour the user
picks and both clients render the iOS pair.

**Default theme is light on both clients**, not dark: `wczytajWybor` returns
`"jasny"` (`web/src/lib/motyw.ts`, `TLO.jasny` is `#ffffff`) and
`WyborMotywu.JASNY` is the Compose default. A messenger is expected to start
light; the dark variant is for people who want it, not for half the installs by
accident.

Bubble anatomy on web (`web/src/styles.css`, `web/src/lib/watek.ts`) survived the
restyle intact: the bubble radius is still one value (`--promien-babel`, 18px); a
run of messages from one side is held together by **spacing** (2px inside a run,
`--odstep-3` between runs) and closed by a **tail on the last bubble only** — a
tail on each one splits a series into three separate utterances. The clock is not
in the bubble: it lives on a centred separator ("Dziś 08:42") that appears on a
day change and after an hour of silence, with the exact time of a single message
in its `title`. Delivery state is a **word** under the last own message —
"dostarczono" and "przeczytano" are a difference you have to understand, not one
you can recognise from two shades of the same tick.

Everything *other* than the bubble got a **new radius scale** on web, and the
split is the point: `--promien-pole` (10px) and `--promien-przycisk` (12px) are
separate tokens, because a text field and the button beside it read as the same
control when they share a radius.

**Android's bubble is filled and tailed like web's, but the clock is still inside
it** — there is no centred time separator and no hour-of-silence rule on the
phone. Delivery words exist on both. That is the remaining thread divergence;
bringing the separator across is a follow-up.

**The PL/EN chrome toggle is web-only** (`web/src/lib/jezyk.ts`). It covers the
app chrome *after* sign-in — navigation, conversation-list header, search, empty
states, appearance settings. It deliberately does **not** replace the bilingual
entry screens ("Załóż konto · Create account"): those are one decision you have
to understand before you can pick anything, so a toggle would arrive too late to
help. Account, backup and device screens stay Polish. Android has no equivalent
module — widening coverage is its own decision, not a side effect.

The design of record is a canvas under `design/kanwa/` — artboards as `*.dc.html`
plus `canvas.json`. Change the design there too when you change the stylesheet,
or the two drift and the canvas starts describing controls the app does not have.
All six artboards were repainted to the filled accent; the `Mekamb Web.dc.html`
the web restyle was built from was a handoff that never landed in the repo, so
the canvas was brought forward from the stylesheet instead, which is the
direction that rule points anyway.

**`design/kanwa/STAN.md` says how far the canvas is trusted**, artboard by
artboard, and lists what it deliberately does *not* show yet. Read it before
trusting an artboard and extend it when you leave something behind: a
half-updated canvas is worse than an openly stale one, because nobody can tell
which half to believe. It also records findings the canvas surfaced but does not
fix — the white-on-white search field in the light theme, and the stale `opis`
on the `ksiezyc` icon in `design/ikony.mjs` (still calls dark the default),
which needs `node design/generuj.mjs` and so is not a by-the-way edit.

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

Because the accent is resolved against the theme, it has to be recomputed
whenever the theme changes — including when the *system* changes it under an
`auto` choice. `motyw.ts` therefore fires `ZDARZENIE_MOTYWU` on every
`zastosuj()` and `akcent.ts` listens, rather than `motyw.ts` having to know the
accent exists.

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
`None` for a group with no MLS state (e.g. a freshly paired device that received
the conversation's history optically but was never added to the group), which
stays readable but inert.

**The envelope carries no conversation id.** Version 2 replaced `group_id` with
a random salt and a tag derived from it, different for every envelope, so the
server cannot link two envelopes into a conversation. The routing key is
`HKDF(group_id, …)`, which means **`group_id` must never reach the server by any
route** — that is why `GroupRelay` is named by a separately derived
`identyfikator_relaya`, not by the group id. Welcome envelopes carry no tag (the
recipient does not know the group yet); any other kind without one is rejected.

**Depositing into a mailbox carries no account token; reading requires one.**
The server must not learn who writes to whom, so `POST /inbox/:userId` takes no
account token — sender identity is authenticated inside MLS. The right to send
is proved by a **delivery token** instead (`opaque/src/tokeny.rs`): the server
signs a *blinded* value, so at issuance it cannot see what it signed and at
redemption it cannot see whom it signed for. The client verifies a
Chaum-Pedersen proof that the server used its published key — without it a
malicious server would tag users by issuing each one tokens under a different
key. Tokens are single-use; `spent_tokens` rejects a replay atomically via its
primary key and holds nothing about the sender.

Issuance and enforcement are separate settings (`DELIVERY_TOKEN_KEY` and
`DELIVERY_TOKEN_REQUIRED`) because a server that starts refusing untokened
deposits the moment it is deployed cuts off every client that has not updated
yet. `GET /inbox/:userId/connect`
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
