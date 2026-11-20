# The mekamb-chat protocol, version 1

A normative document. An implementation in another language should be writable
from this document alone.

## 1. Foundations

| Layer | Choice |
|---|---|
| Group cryptography | MLS, RFC 9420 (OpenMLS) |
| Ciphersuite | `MLS_128_DHKEMX25519_AES128GCM_SHA256_Ed25519` (0x0001) |
| Transport | our own: UDP + STUN + Noise IK, the mailbox as fallback |
| Application payload | protobuf, [`proto/chat.proto`](../proto/chat.proto) |
| Authentication to the infrastructure | OPAQUE (RFC 9807) + TOTP (RFC 6238) |

The ciphersuite is mandatory-to-implement in RFC 9420, so the protocol stays
interoperable with other MLS implementations.

## 2. Identity and key derivation

A device stores **one** 32-byte seed. All keys are derived from it with
HKDF-SHA256, without a salt, using disjoint labels:

```
mls_signature_key = HKDF-SHA256(ikm = seed, info = "mekamb-chat/v1/mls-signature", L = 32)
transport_key     = HKDF-SHA256(ikm = seed, info = "mekamb-chat/v1/iroh-node",     L = 32)
```

> The transport label carries the historical name `iroh-node`. **It must not be
> changed**: every existing device would get a different key underneath it.
> Labels are immutable by design — a change of scheme needs a new version.

Both are 32-byte Ed25519 seeds; the public key is derived the standard way.

**The labels are disjoint on purpose.** The transport node key and the MLS
signature key are both Ed25519 pairs, so it's tempting to use one. The same key in
two protocols opens the door to carrying a signature across contexts. Separating
them costs one HKDF call.

**The labels are versioned and immutable.** Changing the derivation scheme needs a
new label (`/v2/`), never a modification of an existing one — otherwise devices'
keys would change underneath them and they'd drop out of every group.

Derivation is deterministic: importing the seed from a backup recreates exactly
the same identity.

### Credential

The MLS credential is a `BasicCredential`, and its content is:

```
user_id ":" device_id
```

Both fields: non-empty, UTF-8, **no colon**. The colon ban is a security
requirement, not cosmetics — without it a `user_id` of `"alice:phone"` would allow
impersonating a different user–device pair.

The recipient determines the author only from the credential verified by MLS. No
field from outside the MLS channel is a source of truth about the sender.

`user_id` is the **username**, never the server's database UUID: it is the same
string that names the mailbox (§ 10).

## 3. Conversations

**A DM is an MLS group of size 2.** There's no separate cryptographic path for
private and group conversations.

Group parameters — identical when creating and when joining:

- `padding_size` = 256 bytes. MLS encrypts content but doesn't hide its length;
  padding blurs the difference between "ok" and a longer message.
- `use_ratchet_tree_extension` = `true`. The ratchet tree travels in the message
  instead of being fetched separately — necessary in a P2P-first architecture
  where the server is sometimes unreachable.

### Key packages

Every device publishes a supply of key packages that let it be added to a group
while it's offline (the equivalent of prekeys in Signal).

A key package is **single-use**. The server must enforce handing it out once —
reuse breaks the forward-secrecy guarantees.

### Adding a person to a conversation

The same path handles creating a DM and growing a group — because a DM is a group
of size 2.

```
1. Fetch a key package for EVERY device of the person being added
2. Prepare the commit with one call (stage_add_members)
3. Send to GroupRelay: { epoch } — and nothing else
4a. Accepted → merge locally, fan the commit out to the other members' mailboxes,
               and the Welcome to the new person
4b. Rejected → discard the commit; the other commit arrives through the mailbox, then retry
```

**Only the epoch number goes to the relay.** Neither the commit nor the group
membership: the relay decides only ORDER, and the fan-out is done by the sender,
who knows the membership from the MLS tree. Both used to go through it — and that
was the only structure in the system telling the server directly who talks to whom.

The sender fans the commit out **skipping itself and the new person**: it has
merged the commit itself, and the new person gets the Welcome, because it can't
process the commit that brings it into the group.

**A refusal must discard the prepared commit** — and that applies to every refusal
known to mean the epoch wasn't claimed, not just a race. A commit that was prepared
and not discarded blocks the whole conversation in MLS: neither membership changes
nor ordinary messages are possible. A response that doesn't decide (5xx, no
network) doesn't change MLS state: the relay may have claimed the epoch before it
stopped responding. The rule: `web/src/lib/relay.ts`, `android/.../Relay.kt`,
`ios/Mekamb/Rdzen/Relay.swift`.

**The new person doesn't see earlier messages.** That follows directly from MLS:
they join at the current epoch and have no key material from previous ones.
Intended.

## 4. Traffic split

This is the core of the architecture.

| Kind | Channel | Why |
|---|---|---|
| Application messages | own P2P transport | Commutative within an epoch, need no ordering |
| Call media | WebRTC P2P | Volume and latency |
| Call signalling | MLS channel | Must be authenticated |
| MLS commits | `GroupRelay` (Durable Object) | Need one authoritative order |
| Messages for offline devices | `UserInbox` (Durable Object) | Someone has to store them |

### Mailbox delivery requires an acknowledgement

An envelope **always** goes into the queue, even when the recipient has an open
connection. Sending into the socket is an acceleration, not delivery: `send`
succeeds when the bytes reach the buffer, not when the client has processed and
stored them.

The client acknowledges an envelope (`ack:<id>`) only **after** persisting MLS
state. Without that, closing the tab between receiving and saving would be enough
to lose a message — the sender would consider it delivered and nobody would
repeat it.

The price is the possibility of receiving the same envelope twice — and that
needs more care on the client than it seems.

A repeated envelope is rejected by MLS (the ratchet has already moved), so the
client **won't acknowledge** it — and then it comes back on the next connection.
And the next. So the client must count failed attempts and, after a few,
acknowledge the envelope anyway, treating it as dead.

Not after the first attempt: an envelope may overtake the commit it needs and
succeed only on the second try.

Failing to process an envelope **is not an error to show the user**. A repeat, a
stale epoch and a packet crafted by someone on the network look the same, and the
user has no influence over any of them.

### Commit life cycle

A commit changes the epoch, so two parallel commits must be resolved. `GroupRelay`
resolves them, because a Durable Object is single-threaded.

```
1. Client prepares a commit             → stage_add_members / stage_remove_member
2. Reports the epoch number to the relay
3a. Relay confirms (it was first)       → confirm_pending_commit  → epoch +1,
                                          fan-out to mailboxes
3b. Relay refuses (decisively)          → discard_pending_commit  → epoch unchanged,
                                          process the other commit and retry
3c. Relay doesn't answer (5xx, network) → don't touch MLS state: it's unknown
                                          whether the epoch was claimed
```

**A commit isn't merged before confirmation.** Merging immediately on rejection
would leave the client in an epoch the rest of the group doesn't know — that is,
outside the conversation.

**A commit also can't be prepared and forgotten.** While it's pending, MLS refuses
everything in that conversation — including sending an ordinary message — so a
client that only shows an error on refusal breaks the conversation until restart.

### P2P transport

| Layer | Solution |
|---|---|
| Socket | UDP |
| Learning one's own address | STUN (RFC 5389) |
| Setting up the connection | simultaneous packets, NAT hole punching |
| Encryption and authentication | Noise IK (`Noise_IK_25519_ChaChaPoly_BLAKE2s`) |

The **IK** pattern is chosen on purpose: the initiator knows the responder's static
key in advance — it takes it from the directory. If the directory lied, **the
handshake fails**, so the server can't put itself in the middle of the connection.

The directory record with a device's transport key and addresses is signed with
that device's MLS signature key, and the client verifies it against the key from
the conversation's MLS tree — never against a key that arrived next to the
signature. An unsigned record means "mailbox only".

The second layer of encryption doesn't duplicate MLS. MLS protects content; Noise
protects the **envelope's routing fields**, which the recipient must read before
decrypting. Without Noise a network observer could correlate envelopes into a
conversation graph.

**There is no relay.** With a symmetric NAT on both sides hole punching fails and
the mailbox takes over. Our own relay would need a server with UDP, and the
architecture runs on Cloudflare Workers, which don't support UDP.

## 5. Application payload

Full definition: [`proto/chat.proto`](../proto/chat.proto). The payload **always**
travels inside an MLS application message.

The recipient rejects the payload when:
- `protocol_version` ≠ 1,
- `body` is empty (an unrecognised `oneof` variant),
- `message_id` isn't exactly 16 bytes.

`sent_at_ms` is **the sender's claim**, not a fact — the sender can write any value.
Use the order of receipt for ordering in the interface, and the timestamp only for
display.

## 6. Attachments

A file is encrypted **before** it's sent to the server, with a fresh AES-256-GCM key.

```
1. The client draws a key (32 B) and a nonce (12 B)
2. Encrypts the file; `mime_type` goes into the authenticated data (AAD)
3. Uploads ONLY THE CIPHERTEXT to the server → gets a `blob_id`
4. Sends an `AttachmentBody` with the key, nonce, type and name — over the MLS channel
```

Properties this construction must keep:

- **A fresh key for every file.** Repeating a (key, nonce) pair in AES-GCM doesn't
  weaken the cipher "a bit" — it lets you recover the keystream and forge any
  message. Drawing a key per file removes that possibility by definition, instead
  of relying on counting correctly.
- **The file type is authenticated.** `mime_type` goes into the AAD, so changing the
  declared type invalidates the ciphertext. Without that an intermediary could pass
  a video off as an image and route it to a different decoder than intended.
- **The file name and type don't reach the server.** They're content metadata, so
  they stay in the MLS channel. R2 stores only the bytes and the upload time.
- **A 25 MB limit.** Fits photos and short videos without multipart upload. Bigger
  files would need uploading straight to R2, bypassing the Worker — that's a
  separate feature, not a change of constant.

The server assigns the `blob_id` itself. Letting the client choose the name would
allow overwriting someone else's blob or guessing existing ones.

### Photo metadata

We strip metadata from photos **before** encryption, by default and without asking.

The reason is simple: EXIF in a phone photo carries GPS coordinates accurate to a
few metres, the camera model and the time it was taken. Encryption doesn't help
with data we put inside the ciphertext ourselves — it reaches the recipient along
with the image and can travel further.

Stripping rewrites the file structure, letting through only the parts needed to
display it. **The pixels stay bit-for-bit identical** — unlike re-encoding, which
would cost quality.

| Format | Kept | Removed |
|---|---|---|
| JPEG | JFIF, ICC profile, tables and frame headers | APP1 (EXIF, XMP), APP13 (IPTC), comments, other APPn |
| PNG | critical chunks, colour, APNG | `tEXt`, `zTXt`, `iTXt`, `eXIf`, `tIME` |

Both lists are **allow lists**, not deny lists. With the opposite approach every
new, unknown segment type would get through by default — exactly the case we want
to avoid.

### Video metadata (MP4, MOV)

We clean ISO BMFF containers differently from images, and that matters.

MP4 keeps **absolute offsets** into the picture data in `mdat` in its `stco` and
`co64` tables. Cutting anything out before `mdat` would shift everything after it,
and the tables would point into the void — the file would stop playing.

That's why we **overwrite metadata boxes with the `free` type and zero their
content**. The size stays the same, so no offset changes, and players skip `free`
by definition.

| Level | Kept | Removed |
|---|---|---|
| top | `ftyp`, `moov`, `mdat`, `moof`, `mfra`, `sidx` | `uuid` (XMP), `meta`, `free` |
| `moov` | `mvhd`, `trak`, `mvex`, `iods` | `udta` (GPS, model), `meta`, `uuid` |
| `trak` | `tkhd`, `mdia`, `edts`, `tref` | `udta`, `meta`, `uuid` |

We separately detect **timed-metadata tracks**: a `trak` whose `mdia/hdlr` has the
`meta` or `mebx` type. Formally it's an ordinary track, so the allow list wouldn't
filter it out — and action cameras store the full GPS route there, the biggest
possible leak.

We zero the content rather than just changing the box type: changing the type
alone would leave the coordinates in the file, just in a place the player skips.
Any data-recovery tool would find them.

Cost: the file doesn't shrink. A reasonable price for certainty that the
recording still works.

**Failed stripping doesn't block sending.** It's better to deliver a file in an
unusual container variant than to reject it — provided the interface says that
this particular one went with its metadata.

## 7. Safety number

A code to compare outside the app, computed only from the participants' identities.

```
material = "mekamb-chat/v1/safety-number"
         || for each participant (sorted, deduplicated):
              len(identity) || identity || len(signature_key) || signature_key

digest = SHA-512(material)
repeat 5200 times:  digest = SHA-512(digest || label)

code = 12 groups of 5 digits, each from the next 5 bytes of the digest modulo 100000
```

The decisions that matter here:

- **Sorting and deduplication.** Without them two people in the same conversation
  would see different codes and the comparison would never succeed.
- **Length prefixes.** Without them you could shift the boundary between name and
  key and craft a different membership giving the same code.
- **Repeated hashing.** The code has ~200 bits, less than a key — the attack is to
  search for another key pair giving the same result. The iterations multiply the
  cost of that search. Mixing in the label every round forces walking the whole
  chain instead of parallelising it.
- **Keys from the MLS tree, not the directory.** If the server slipped in someone
  else's device, it would be in the tree and change the code. Reading from the
  directory would let the server show one thing and put something else into the group.

The code changes whenever the conversation's membership changes — participants
should compare it again then.

## 8. Voice/video calls

WebRTC, mesh topology, at most 4 participants. No media server.

Every pair of participants sets up a **separate** connection with **separate
trust**: dropping one because of a mismatched certificate fingerprint doesn't end
the call with the others.

Signalling carries a `target` field. MLS messages go to the whole group, so
without an addressee a third person would try to process an offer meant for
someone else. An empty `target` means "for everyone" and is used for invitations.

Signalling (`CallSignalBody`) goes **over the MLS channel**. That makes the DTLS
fingerprint cryptographically authenticated: whoever controls the transport layer
can't put themselves in the middle of the connection, because they can't forge an
MLS message.

### Fingerprint verification

```
1. The caller creates an SDP offer
2. Extracts its own DTLS fingerprint from it
3. Sends the SDP and the fingerprint TOGETHER, inside an MLS message
4. The recipient compares the fingerprint in the SDP with the one from the MLS channel
5a. Match     → sets up the connection
5b. Mismatch  → drops it, WITHOUT asking the user
```

Three details decide whether this works:

- **We check every fingerprint in the SDP, not the first.** SDP can carry a
  session-level fingerprint and separate ones per media section. Adding a second
  section with your own fingerprint would be enough if only the first were checked.
- **Verification comes before setting the remote description.** The reverse order
  would create — even for a moment — a connection to an unverified party.
- **SHA-256 only.** An allow list with one entry doesn't allow downgrading to an
  algorithm for which a collision can be found.

**A DTLS fingerprint mismatch = the connection is dropped immediately, without
asking the user.** A question at this point would hand a cryptographic decision to
someone who has no way of judging it — and "yes" would be the most common answer.

### IP address and connection path

A direct connection reveals the other person's IP address. Through TURN, the relay
sees the address instead of the other person. The interface shows which path is
in use — silence would suggest nothing is revealed.

- STUN: `stun.cloudflare.com`
- TURN: Cloudflare Realtime, short-lived credentials issued by the Worker

The limit of 4 people comes from bandwidth: with 5 participants each sends 4
streams upstream, which exceeds a typical home connection.

### Device addresses

The directory stores **two** addresses: on the local network and the public one
from STUN.

The public address alone isn't enough. Two devices on the same Wi-Fi would then
have to reach each other through the router, sending packets out and back in —
which many routers don't do. We find the local address with a trick: a UDP socket
"connected" to an address on the internet — no packet leaves, and the system
reveals the interface the traffic would take.

## 9. Authentication to the infrastructure

```
registration:  register/start → register/finish → register/confirm
               (OPAQUE)         (pending account,  (authenticator code
                                 TOTP secret)       activates the account)

sign-in:       login/start    → login/finish    → login/totp
               (OPAQUE round 1) (OPAQUE round 2)  (second factor → token)
```

**The server and all clients use the same implementation** — `opaque-ke` in Rust,
exposed through WebAssembly (Worker, browser) and UniFFI (Android, iOS).

Two independent implementations of the same protocol aren't byte-compatible just
because both "do OPAQUE". We learned this the hard way: the TypeScript
implementation followed draft-07, the Rust one RFC 9807, and the message format
changed between them. Shared code removes a whole class of problems.

Properties this path must keep:

- **The server never sees the password**, neither at registration nor at sign-in.
  An offline dictionary attack can't be run from the database record — unlike from
  a hash.
- **A non-existent username goes down the same path** as an existing one, with a
  dummy record (`RegistrationRecord.createFake`). Without that, the shape or timing
  of the response would reveal which accounts exist.
- **A TOTP code is single-use within its window.** We store the number of the last
  used window and reject anything that isn't later (RFC 6238 §5.2). The visible
  consequence: after activating an account you have to wait for a new code.
- **A sign-in session is single-use** — consumed atomically by
  `DELETE ... RETURNING`.

**The password and TOTP don't unlock messages.** They authorise only access to the
infrastructure: the offline mailbox, the directory and publishing key packages.
Message keys never leave the device, so taking over an account gives no access to
history.

### Delivery tokens

Depositing into a mailbox carries **no account token** — the server must not learn
who writes to whom; the sender is authenticated inside MLS. The right to deposit is
proved by a single-use **delivery token** instead, issued on a blinded value
(`opaque/src/tokeny.rs`): at issuance the server can't see what it signed, at
redemption it can't see for whom. The client verifies a Chaum–Pedersen proof that
the server used its published key, and pins that key on first download.

Reading a mailbox (`GET /inbox/:userId/connect`) requires the **owner's** account
token, passed as `Sec-WebSocket-Protocol` because browsers can't set
`Authorization` on a WebSocket.

## 10. Multiple devices on one account

A member of an MLS group is a **device**, not a person: the credential is
`user_id:device_id`. The mailbox, on the other hand, is **per user**, because the
sender knows only the name. Everything below follows from that mismatch.

### 10.1 The mailbox and per-device reads

The mailbox is an append-only log. `UserInbox` records, per device, **the set of
envelope ids that device has read** (`device_reads`). An acknowledgement marks one
envelope as read for **that** device — it isn't a high-water mark: clients
acknowledge out of order on purpose (an envelope that failed to process is held for
a retry while a later one is acknowledged), so a gap stays a gap and comes back on
the next connection. Only retention (`MAILBOX_RETENTION_DAYS`) deletes an envelope,
because the mailbox doesn't know group membership and so can't know how many
devices still owe a read.

The server takes the device identifier from the **signed token**, never from the
request.

### 10.2 Echo of one's own messages

The sender also drops the envelope into their **own** mailbox, otherwise their
other devices would never learn about it. So the envelope comes back to the sender,
who can't decrypt it — MLS doesn't allow processing one's own message. The client
recognises it by the SHA-256 of the envelope bytes and acknowledges it without
processing.

That's the only metadata this adds for the server: one deposit under one's own
username, i.e. "this person sent something".

### 10.3 Pairing

Pairing **doesn't copy the seed**. The new device has its own seed from sign-in and
joins conversations as a separate MLS leaf — both devices keep working side by side.

1. The new device signs in, registers in the directory, publishes key packages and
   **connects to the mailbox**.
2. It shows the code `mekamb://parowanie?d=<device_id>&k=<x25519_pub>` with an
   ephemeral public key.
3. The old device scans the code, generates its own ephemeral pair and derives the
   transfer key: `HKDF-SHA256(X25519(secret, peer_pub), "mekamb-chat/v1/parowanie-transfer")`.
   An all-zero shared secret is rejected (a small-order point).
4. The old device adds the new leaf to **every** conversation: `addMembers` → commit
   → claiming the epoch in `GroupRelay` → fanning out the commit and Welcome.
   Sequentially, because each conversation is a separate epoch.
5. The old device sends the history by optical transfer (§ 10.4).

The username isn't in the code: the old device knows it, because it pairs with its
own account.

**The direction of the code is part of the protection.** The new device — the one
that will *receive* — shows the code. Someone who films the sender's screen for the
whole transmission has every frame and nothing to decrypt them with.

Contacts will see the safety number change — a leaf was added. That's correct and
must be visible.

### 10.4 Optical transfer

History from before pairing **doesn't go through the server in any form**. The new
device wasn't in the group then, so it can't be resent over the MLS channel.

The sender's pipeline: `deflate` → `AES-256-GCM` → split into blocks → fountain
codes → QR code version 40 at error correction L (2953 bytes per frame).

A frame is a 59-byte header plus payload:

```
0   1   format version
1   4   k — number of blocks (u32 BE)
5   2   block size (u16 BE)
7   4   ciphertext length (u32 BE)
11  12  AES-GCM nonce
23  32  SHA-256 of the ciphertext — the transfer's identity
55  4   frame seed (u32 BE)
59  ..  payload
```

A seed smaller than `k` means a **systematic** frame: it carries the block with that
number directly. A clean capture finishes the transfer in exactly `k` frames. The
remaining frames are the XOR of a subset chosen by a SplitMix64 generator seeded
with the seed, with a degree from the ideal soliton distribution plus a 5% extra
for degree 1.

The distribution is computed **in integers**. `ln` isn't bit-identical across
platforms, and a difference in the last bit gives a different frame degree and a
decoder that reconstructs nothing.

The sender's public key travels in the clear, as every eighth frame
(`mekamb://parowanie-nadawca?k=…`). The secret can't be computed from two
**public** keys, and if it were shown once at the start, anyone a second late would
miss it.

The receiver takes the key only when assembling — collecting frames doesn't need
it, and during pairing the key comes through the same camera as the frames.

### 10.5 Revoking access

`removeDevice` removes the leaf by its `user_id:device_id` identity — not by leaf
index, because the order in `members()` isn't the leaf numbering.

Order: **first** the MLS commits in every conversation, **then**
`DELETE /devices/:id`. The other way round we'd lose the means to address the
device. Removing it from the directory alone revokes nothing — group membership
lives in the MLS tree, which the server doesn't know.

Removing yourself is an error. Removing a device that isn't in a given conversation
is not.

### 10.6 Merging history

The union of sets by `message_id`, sorted by `(time, id)`. The read marker goes up.
Voice/video call traces are **not** merged — they're a fact about one device. The
500-message limit applies **after** merging, not before.

The history format is shared by all clients, and its version must be bumped on
every client in the same change.

## 11. Versioning

Every envelope carries the protocol version. The recipient rejects an unknown major
version instead of guessing — a readable error is better than silent mis-parsing.

Breaking changes require bumping `PAYLOAD_VERSION` and new HKDF labels.
