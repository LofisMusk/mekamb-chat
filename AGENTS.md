# mekamb-chat agent guide

End-to-end encrypted chat: P2P Rust core, Cloudflare Workers server, React PWA web client, Kotlin Android app.

## Architecture boundaries

```
core/        — Rust crypto + MLS group state (single source of truth for protocol logic)
opaque/      — Rust OPAQUE auth (RFC 9807)
transport/   — Rust UDP+STUN+Noise P2P transport
server/      — TypeScript on Cloudflare Workers; coordination only, not E2E participant
web/         — React PWA using WASM bindings
android/     — Kotlin client using UniFFI bindings
```

**Convention:** Protocol logic and crypto live in `core/` (Rust). Never duplicate in TypeScript or Kotlin.

## Toolchain requirements

- Rust: version 1.85+, Edition 2024, Cargo Resolver v3
- Node.js >= 18 required for npm workspaces (`npm run test:workspace`)
- Android: cargo-ndk + UniFFI must match versions in CI to verify bindings

## Key commands by component

### Rust (core, opaque, transport)

```bash
cargo fmt --all --check          # format validation
cargo clippy --all-targets --all-features  # linting; CI fails on any warning
cargo test -p mekamb-core qr     # specific crate's tests only
cargo check -p mekamb-core --target wasm32-unknown-unknown  # WASM compatibility (fails if blocking alloc() used)
```

CI sets `RUSTFLAGS=-D warnings` — warnings are errors in CI.

### Server (`server/`)

```bash
cd server && npm test            # Vitest with workerd runtime
npx wrangler dev                 # local dev environment
npx wrangler deploy              # production deployment
npx wrangler d1 migrations apply mekamb --local   # apply DB migrations locally
```

Server is TypeScript on Cloudflare Workers; tests run against `@cloudflare/vitest-pool-workers`.

### Web client (`web/`)

```bash
cd web && npm run build          # MUST be called first: builds WASM, typechecks, bundles
npm test                         # Vitest; requires successful build for WASM imports
npx vitest run src/lib/qr.test.ts    # specific test file only
VITE_API_URL=https://... npx vite --port 5174   # dev server with custom API URL
```

**Important:** Web tests depend on WASM bindings; `npm run build` must be called before running tests. Build fails if Rust compilation errors exist.

### Android (`android/`)

```bash
cd android && ./gradlew assembleDebug               # debug build
./gradlew testDebugUnitTest                         # unit tests only
./gradlew assembleRelease -Pabi=arm64-v8a,armeabi-v7a   # release with specific ABIs
```

## Protocol quirks (span multiple files)

- **Envelope format version** must be bumped on both web AND Android simultaneously to avoid cross-client breaks
- **HKDF labels are frozen** — changing them invalidates all existing device keys
- **Mailbox addressed by username**, not DB UUID, throughout the system
- Transport addresses verified via signatures before use
- Envelopes acked only after MLS state persisted
- Ack marks read for one device only, not entire account

## Code conventions

- **Polish identifiers**: code, comments, and UI strings are in Polish (not English)
- TypeScript: strict mode with `verbatimModuleSyntax`; no ESLint/Prettier — relies on TS compiler errors
- Icons generated from single source: `node design/generuj.mjs` to regenerate all assets

## Testing gotchas

- Rust crypto tests include edge cases and performance benchmarks — can be slow
- Server tests run in workerd runtime; mocking network requires careful setup for WebSockets and timers
- Web tests require successful build before running (WASM dependencies)
- Android unit tests only cover app logic, not binding integration

## Deployment flow

1. Web: `gh-pages` via GitHub Actions (`deploy-pages.yml`); requires `VITE_API_URL`
2. Server: Cloudflare Workers via `wrangler deploy` (`deploy-server.yml`)
3. Android: Signed APKs released on tags via `release-android.yml`

All three components must be deployed together for breaking protocol changes.
