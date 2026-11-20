# mekamb-chat — backend

Cloudflare Workers. License **AGPL-3.0** ([`LICENSE-AGPL`](LICENSE-AGPL)) — anyone
who runs their own instance has to publish their changes. In a messenger a swapped
server is a real attack vector, so its code must be verifiable.

## What this server does and doesn't do

It is **supporting infrastructure, not a party to the conversation**. In the
typical case messages bypass it — they go directly between devices.

| Does | Doesn't |
|---|---|
| Orders MLS commits | Decrypt anything |
| Stores ciphertext for offline devices | Store conversation history |
| Hands out key packages and device addresses | Act as a trusted source for those addresses — clients verify the signatures |
| Authenticates access to the infrastructure | See the password (OPAQUE) or unlock messages |

## Running

```bash
npm install
npm test
```

The tests run on `workerd` — the same engine as production, so Durable Object
guarantees are checked for real, not against a mock.

## Deployment

### 1. Database

```bash
npx wrangler d1 create mekamb
```

Put the returned `database_id` into [`wrangler.jsonc`](wrangler.jsonc), then:

```bash
npx wrangler d1 migrations apply mekamb --remote
```

### 2. Secrets

**None of them may end up in the repository.**

```bash
npx wrangler secret put TOTP_ENCRYPTION_KEY
npx wrangler secret put TOKEN_SIGNING_KEY
npx wrangler secret put OPAQUE_SERVER_KEY
```

The OPAQUE secret has a specific structure — it isn't just a random string. The
library generates it:

```bash
cargo run -q -p mekamb-opaque --bin genkey
```

> **Changing `OPAQUE_SERVER_KEY` invalidates every account.** The material that
> binds users' passwords to this deployment is derived from it. Treat it as data
> whose loss is irreversible.

Delivery tokens are configured with `DELIVERY_TOKEN_KEY` (issuing) and
`DELIVERY_TOKEN_REQUIRED` (enforcing). They're separate on purpose: a server that
starts refusing untokened deposits the moment it's deployed cuts off every client
that hasn't updated yet.

### 3. Publishing

[`deploy-server.yml`](../.github/workflows/deploy-server.yml) deploys on every
merge to `main`. It needs the `CLOUDFLARE_API_TOKEN` secret (and
`CLOUDFLARE_ACCOUNT_ID` when the token has access to several Cloudflare accounts)
in Settings → Secrets and variables → Actions.

By hand — the first time and in an emergency:

```bash
npx wrangler d1 migrations apply mekamb --remote
npx wrangler deploy
```

> **The server has to be deployed together with the clients.** The web client
> publishes itself on every merge, the APK is built on a tag — and a Worker
> deployed "whenever someone remembered" fell behind a contract that kept changing
> on the client side. That's how issue #18 happened: the deployed Worker required
> a field in the epoch claim that clients no longer sent, so **you couldn't add a
> contact or start a conversation**, and the message talked about a "non-empty
> member list".
>
> A quick check whether the current version is live:
>
> ```bash
> curl -s -o /dev/null -w '%{http_code}\n' "$API_URL/tokens/key"   # 404 = old Worker
> ```

## Authentication

Three rounds. The password never leaves the device in any form.

```
registration:  register/start → register/finish → register/confirm (TOTP code)
sign-in:       login/start    → login/finish    → login/totp       (token)
```

A few decisions that are easy to "fix" by mistake:

- **Signing in with a non-existent name goes down the same path** as a real one,
  with a dummy record. A shortcut here would bring back the ability to check which
  accounts exist.
- **A TOTP code used once doesn't work again** within the same time window.
  Consequence: after activating an account you have to wait for a new code, up to
  30 seconds. RFC 6238 §5.2 requires this.
- **Sign-in sessions are single-use** — consumed by `DELETE ... RETURNING`, so
  parallel requests can't use the same record twice.

## OPAQUE: one implementation, four platforms

The cryptography lives in [`opaque/`](../opaque) (Rust, RFC 9807). The server uses
it through WebAssembly, the browser through WebAssembly, Android and iOS through
UniFFI.

That isn't an aesthetic choice, it's the conclusion of a failed attempt. The server
used to have a TypeScript implementation (`@cloudflare/opaque-ts`), which
implements **draft-irtf-cfrg-opaque-07** from 2021. A native client would have had
to use the Rust one, which implements **RFC 9807**. The message format changed
between the draft and the RFC, so those two implementations would never have talked
to each other — not "less securely", just a sign-in that never succeeds.

### How WASM works in Workers at all

The environment forbids **compiling** WebAssembly at runtime — that's what an
earlier attempt with a library inlining WASM as base64 failed on. What is allowed
is importing a module compiled by the bundler and instantiating it by hand;
[`src/opaque-wasm/index.js`](src/opaque-wasm/index.js) does that.

The distinction matters: the ban is on generating code, not on running code
prepared in advance.

### Regenerating the module

After changes in `opaque/`:

```bash
cargo build -p mekamb-opaque-wasm --target wasm32-unknown-unknown --release
wasm-bindgen target/wasm32-unknown-unknown/release/mekamb_opaque_wasm.wasm \
  --out-dir server/src/opaque-wasm --target bundler --no-typescript
```

`index.js` and `index.d.ts` are written by hand and **are not overwritten** —
`wasm-bindgen` doesn't know about them.
