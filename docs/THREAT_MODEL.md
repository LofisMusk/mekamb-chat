# Threat model

This document says plainly what mekamb-chat protects against and what it does
**not**. A messenger that promises more than it delivers is worse than one that
promises nothing — users make decisions based on those promises.

## What is protected

| Asset | Protection |
|---|---|
| Message content | E2EE via MLS. The server and relays see ciphertext only |
| Attachment content | AES-256-GCM on the client, a fresh key per file; the key travels in the MLS channel |
| File name and type | Travel in the MLS channel. The server sees only an opaque blob |
| Location and camera data in photos | Stripped before encryption, by default (EXIF, XMP, IPTC, PNG text chunks) |
| Location and device data in video | Stripped from MP4 and MOV, together with timed-metadata tracks (GPS tracks from action cameras) |
| Call media | WebRTC P2P, DTLS fingerprint authenticated through MLS and verified before the connection is set up |
| Conversation history | Only on devices. The server has nothing to hand over or lose |
| Sender identity | MLS credential, verified cryptographically |
| Who received and read what | Receipts go as MLS messages — the server sees ciphertext. They carry no read timestamp, because one doesn't exist in the protocol at all |
| Password | OPAQUE — the server doesn't see it, not even in memory |
| Backward secrecy | The MLS ratchet: a compromised key doesn't reveal earlier messages |
| Forward secrecy | Epoch updates cut the attacker off after removal from the group |

## What we do NOT protect

This list matters more than the previous one.

### Metadata

The server sees and can log:

- who has an account and when they sign in,
- which devices belong to which user,
- **whose** mailbox an envelope goes to — the mailbox is named after the username,
  otherwise it couldn't be delivered,
- the sender's IP address: `POST /inbox/:userId` is deliberately
  **unauthenticated**, so the server doesn't learn who is depositing, but it sees
  the connection,
- when and how many bytes go into the offline mailbox,
- **the size of every attachment**.

The server **no longer** sees the conversation identifier. The envelope carried
it in the clear up to version 2 of the format — that was enough to link envelopes
into conversations and build a graph without decrypting a single byte. Today the
envelope carries a random salt and a tag derived from it, different for every
envelope (`core/src/envelope.rs`). The object that orders epochs is named by a
separately derived value, so the conversation identifier doesn't reach the server
by any route.

What remains is the envelope's `kind`: the server sees that someone is adding
someone to a group right now, although it doesn't know which group. The recipient
needs to know this before it has anything to match against.

The server **no longer** sees group membership. `GroupRelay` used to keep a member
list because it fanned out commits itself — it was the only structure that told
it directly "who talks to whom". Today the sender fans out, knowing the membership
from the MLS tree, and the relay only claims successive epochs under an opaque
identifier. Membership can still be roughly reconstructed from who deposits into
whose mailboxes — but it no longer sits ready-made in the database.

The last point is more significant than it looks: size alone says a lot about the
type of a file — a phone photo, a screenshot and a short video are in clearly
different orders of magnitude. Hiding that would require padding files to fixed
thresholds, which for video would mean transferring many times more data. We
deliberately don't do that.

The server does **not** see content or — when P2P works — the messages themselves.

### The sender when depositing an envelope

Depositing into a mailbox **requires no account token**, and that isn't an
oversight: by design the server must not learn who writes to whom. The sender's
identity is authenticated cryptographically **inside** MLS, where the server
can't see it.

But since anyone can deposit, anyone could flood someone else's mailbox. A
**delivery token** defends against that: the server issues it on a *blinded*
value, so at issuance it doesn't see what it issued, and at redemption it doesn't
see for whom (`opaque/src/tokeny.rs`). The depositor proves "I'm allowed to
deposit" without saying "I am this account".

The client checks a proof that the server used its published key. Without it a
malicious server would **tag** users — issue each one tokens under a different key
and recognise at redemption whose token it was. The key is also pinned on first
download, so substituting it for one person requires changing it for everyone at
once.

A token is single-use: the `spent_tokens` table rejects a replay atomically, by
primary key. There's nothing about the sender in it, and there can't be.

What this does **not** hide: the depositor's IP address and the fact that someone
deposited into a particular mailbox at a given moment. Tokens are fetched in
advance and rarely, so that the authenticated fetch isn't adjacent in time to the
deposit — but IP correlation remains. That would need traffic mixing, which we
don't have.

Reading is the other way round — it **requires a token, and the mailbox owner's**.
The `GET /inbox/:userId/connect` route used to have no authentication at all:
anyone who knew a username could connect to someone else's mailbox and, with an
`ack:<id>`, delete envelopes before they reached the owner — the message vanished
without a trace and the sender saw no error. Tests in `server/test/inbox.test.ts`
guard this now.

Hiding the remaining metadata would require traffic mixing and padding. Out of
scope for version 1.

### The moment of reading

Delivery and read receipts are encrypted, so the server doesn't know WHAT is in
the envelope. It does know **when** the envelope went — and a receipt sent the
instant something was read would be readable from traffic alone: "device B sent
something four seconds after the message from A".

That's why clients **batch** receipts and send them after a **random** delay of
up to 30 seconds (`web/src/lib/potwierdzenia.ts`, `android/.../Potwierdzenia.kt`,
`ios/Mekamb/Rdzen/Potwierdzenia.swift`). Random, not fixed: a fixed delay only
shifts the correlation instead of breaking it. One envelope for many messages also
hides how many were read.

This **limits** the leak, it doesn't remove it. An observer who sees all traffic
still knows that something went within the 30-second window. Anyone who doesn't
want that turns off read receipts in settings — then none are sent at all (and,
symmetrically, other people's aren't shown). **Delivery** receipts stay: they're
created when the envelope is received, so they don't add an event at a moment
other than one that happened anyway.

The receipt payload itself carries no timestamp, and a test in
`core/src/framing.rs` enforces that — if someone added one, delaying the send
would stop achieving anything.

### Your IP address towards the people you talk to

**A direct connection reveals your IP to the person you're talking to.** That's a
deliberate design decision, the price of P2P.

It's the reverse of the classic model: an intermediary server would actually hide
the IP. The call screen says plainly which path a call takes and who learns the
IP address.

### Relays

There is no relay for messages: with a symmetric NAT traffic goes through the
server mailbox, which sees ciphertext only.

STUN servers see that a given IP address asked for its public address — as much
as any router on the way. **They don't need to be trusted**: if they lied, the
direct connection simply wouldn't be set up.

Cloudflare's TURN, used only for voice/video calls, sees the IP and traffic volume
of both sides. It doesn't see the media — that's encrypted with DTLS-SRTP.

### Unusual container variants

Metadata stripping covers JPEG, PNG, MP4 and MOV. A file in a variant the parser
doesn't recognise **goes through unchanged** — deliberately, because blocking the
send would be worse than delivering a file with metadata. The interface says so
plainly when stripping failed.

Formats outside that list (HEIC, WebP, AVI) aren't stripped at all.

### How many files and how big

The server doesn't know **what** it stores, but it knows **how much** and **for
how long**. Blobs not fetched for 30 days are deleted, because the server can't
tell whether anyone will still reach for them — it doesn't know the content of the
messages that refer to them.

### Push providers

FCM and Web Push are external services. That's why the notification payload is
**wake-up only**: no sender, no content, no group identifier. After waking up the
client fetches the data itself.

### A device taken over by an attacker

Device compromise is game over for that device. The keys at rest are encrypted
(Android Keystore / iOS Keychain / WebAuthn PRF), but an unlocked app has access
to its own history. E2EE doesn't protect against an attacker on your side of the
screen.

### Code delivered by the browser

The web client downloads its cryptographic code on every visit. A malicious or
compromised deployment can steal keys without the user noticing.

That's a **fundamentally weaker** guarantee than a native app, installed once and
signed. We reduce the risk with reproducible builds and published hashes, but it
can't be removed. Users with the highest requirements should use a native client.

### Recording the screen during the optical transfer

History from before pairing goes from one device's screen to the other device's
camera. Anyone who sets up their own camera next to it and records the whole
transmission has **every frame**.

The frames are encrypted with a key agreed through ECDH, and the code with the
recipient's public key is shown on the **other** device — someone filming the
sender's screen didn't see it. That's enough against a camera pointed at one screen
and **not enough** against someone who filmed both. Pairing takes a few dozen
seconds and is done where nobody is looking over your shoulder.

What it doesn't replace: if someone slipped in their own device and scanned the
invitation code, they'd join conversations as a new leaf. The defence is that an
already-trusted device signs the consent, and **your contacts will see the safety
number change**. That signal is the only one that detects such a swap, which is
why it must never be hidden.

### The "this person sent something" metadata

Since the sender also drops the envelope into their own mailbox — otherwise their
second device would never learn about it — the server sees one deposit under the
sender's name for every message sent.

Before, it saw only deposits under recipients' names. **Who writes to whom is
still unknown** (a deposit carries no sender identity, § 9), but "this user is
active right now" became readable directly, without inferring it from recipients'
traffic.

That's the price of a working second device, and it's paid deliberately.

### A lost device

**Stopped only once its access is revoked.** A paired device is a full member of
conversations: it reads everything that arrives until it's removed by an MLS
commit from every conversation.

Removal works **forwards**: from the new epoch the device won't decrypt anything.
What it has already read and stored locally can't be undone — the history sits on
its disk, encrypted with the vault key.

Revoking access needs another working device. Someone who had only one and lost it
has nothing to sign the commit with — the server won't do it, because it doesn't
know group membership.

## Adversaries

### Passive network observer

**Stopped as far as content goes.** Sees that traffic exists and estimates its
volume. Padding to 256 bytes blurs message lengths.

### Malicious server

**Stopped as far as content goes.** It can't read messages or forge the author.

It can, however: deny service, delay or drop messages from the mailbox, collect
metadata, and **swap a key package or a directory record** to try to slip its own
device into a group.

The last attack is detected by the **safety number** — computed from the identity
keys in the MLS tree, so slipping in someone else's device changes it. The number
is visible in the interface for every conversation.

The protection works **only if participants actually compare the number over
another channel** — in person, by phone, by video. Comparing it through the
messenger itself proves nothing, because that's exactly the channel we don't
trust. The app can show the number and explain it; it can't force a comparison.

### Active network attacker

**Stopped.** Modifying ciphertext is detected (AEAD), and the DTLS fingerprint
carried over the MLS channel blocks MITM on calls.

### A group member

**Not stopped, and can't be.** Every member reads the group's messages and can
copy them. Removal cuts them off from future messages (a new epoch), but not from
the ones they've already seen.

### Physical coercion

Not in the model. No deniable mode and no hidden vaults.

## Known operational risks

| Risk | Consequence | Response |
|---|---|---|
| iOS wipes PWA storage after ~7 days | Losing MLS state = losing history | Enforced onboarding order, `navigator.storage.persist()`, identity export, a warning at start-up; the native iOS app doesn't have this problem |
| Losing all devices | Permanent loss of history | Intended. Communicated at registration |
| Protocol version mismatch | Unable to talk | A version in every envelope, explicit rejection of an unknown one |
| Running out of key packages | An offline device can't be added | The client tops up the supply on every sign-in |

## Implementation note: hostile input

Everything that comes from the network is hostile by assumption. Parsers must
return an error, never panic.

OpenMLS 0.8 contains `debug_assert!(false, "Ciphertext decryption failed")` in the
decryption path. For a library tested on valid vectors that's a sensible
assertion; for a messenger it isn't — for us a failed decryption is a normal
result of a modified packet. In a release build the function returns `AeadError`
anyway; the problem is only the panic in debug, which would let a single hostile
packet crash a development build.

That's why `Cargo.toml` turns off `debug-assertions` **specifically for the
`openmls` package**, keeping them in our own code. The
`zmodyfikowany_szyfrogram_jest_odrzucany` test makes sure the behaviour stays
correct.

## Reporting vulnerabilities

See [`SECURITY.md`](../SECURITY.md).
