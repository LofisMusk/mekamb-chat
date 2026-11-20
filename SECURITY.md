# Security policy

## Project status

**mekamb-chat is under construction and has not had an independent audit.**

Don't use it where disclosure of the content would have serious consequences.
There are audited messengers for that — Signal.

## Known audit findings

`cargo audit` reports nine items, all silenced in
[`.cargo/audit.toml`](.cargo/audit.toml) with a justification. The assessment
follows — openly, because silencing without a justification is worse than no
audit at all.

### Actually in the dependency tree

`libcrux-sha3` and `libcrux-secrets` come in through `hpke-rs` →
`openmls_rust_crypto`. Three findings (RUSTSEC-2026-0207, -0208, -0212), all high
severity, all about **SHA3 and SHAKE**.

Our ciphersuite is `MLS_128_DHKEMX25519_AES128GCM_SHA256_Ed25519` — X25519,
AES-128-GCM, SHA-256, Ed25519. **Neither SHA3 nor SHAKE is on that path.**

This assessment is based on the choice of ciphersuite, not on tracing the
`hpke-rs` code. If someone switched to a ciphersuite with SHA3, it stops holding.

Fixes exist (`libcrux-sha3` ≥ 0.0.10, `libcrux-secrets` ≥ 0.0.6), but `hpke-rs`
pins older versions. **Remove from the silenced list once hpke-rs updates libcrux.**

### Not in the tree

`libcrux-aesgcm` and `libcrux-chacha20poly1305` appear in `Cargo.lock`, but
`cargo tree` shows **zero occurrences** — they don't end up in any build. It's a
leftover of resolving optional dependencies.

### JavaScript dependencies

The npm audit blocks only on **production dependencies** — the ones that reach
users. There are zero findings there.

Build and test tools are checked separately, informationally: `wrangler` and
`miniflare` pull in `undici` with open findings, and the only fix npm offers is
downgrading wrangler. These dependencies run neither on the production server
(the Worker runs on Cloudflare's runtime, not undici) nor on users' devices.

### Unmaintained

`instant` and `proc-macro-error2` are unmaintained warnings, not vulnerabilities.
Both come in through build tooling.

## Reporting a vulnerability

Please report vulnerabilities through **GitHub Security Advisories** in this
repository (Security tab → Report a vulnerability). The channel stays private
until a fix is released.

Please **don't** open public issues for security problems.

Useful in a report: a description, steps to reproduce, version and platform, and
your assessment of the impact. We answer as fast as we can, but this is an
after-hours project — no guaranteed response time.

## Scope

We're especially interested in:

- bypassing E2EE, leaks of key material,
- mistakes in key derivation and the separation of HKDF labels,
- impersonating another sender,
- MITM on calls (bypassing the DTLS fingerprint check),
- bypassing authentication (OPAQUE, TOTP),
- panics or memory corruption on data from the network.

Out of scope — because they're documented design decisions, not bugs:

- metadata leaking to the server ([`THREAT_MODEL.md`](docs/THREAT_MODEL.md)),
- revealing the other person's IP address on a direct connection,
- losing history after losing all devices,
- the code-delivery risk of the web client.

If you think one of these decisions is wrong, open a regular issue to discuss it.

## Cryptography

We don't write our own cryptography. We use:

- [OpenMLS](https://openmls.tech/) — MLS / RFC 9420
- [`snow`](https://github.com/mcginty/snow) — the Noise IK handshake in the P2P transport
- `opaque-ke` — password authentication without revealing the password

Pull requests that introduce home-made cryptographic primitives will be rejected.
