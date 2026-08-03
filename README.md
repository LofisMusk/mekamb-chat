# mekamb-chat

Otwartoźródłowy komunikator z szyfrowaniem end-to-end i architekturą **P2P-first**.

> **Status: w budowie, bez audytu.** Nie używaj tam, gdzie ujawnienie treści
> miałoby poważne konsekwencje. Patrz [`SECURITY.md`](SECURITY.md).

## Założenia

- **Każda rozmowa zaszyfrowana E2EE** — MLS (RFC 9420), bez własnej kryptografii
- **Ruch bezpośrednio między urządzeniami** — iroh przebija NAT w ~90–95% przypadków
- **DM-y i grupy** — DM to po prostu grupa MLS o rozmiarze 2
- **Zdjęcia i wideo** — szyfrowane osobnym kluczem na plik, serwer widzi tylko bajty
- **Rozmowy audio i wideo** — WebRTC mesh do 4 osób, bez serwera mediów
- **Logowanie: nazwa + hasło + kod TOTP** — hasło przez OPAQUE, więc serwer go nie widzi
- **Klucze tylko na urządzeniu** — serwer nie ma czego wydać ani zgubić
- **Zero kosztów hostingu** — darmowe tiery Cloudflare, GitHub Pages i relayów iroh

## Architektura w skrócie

Serwer jest infrastrukturą pomocniczą, nie pośrednikiem w rozmowie.

| Rodzaj ruchu | Kanał |
|---|---|
| Wiadomości, media rozmów | Bezpośrednio między urządzeniami (iroh, WebRTC) |
| Commity MLS (zmiany składu grupy) | `GroupRelay` — jedyny punkt ustalający kolejność |
| Wiadomości do offline'owych | `UserInbox` |
| Katalog, key packages, push | Worker + D1 |

Uzasadnienie podziału i pełny opis: [`docs/PROTOCOL.md`](docs/PROTOCOL.md).
Co jest chronione, a co **nie**: [`docs/THREAT_MODEL.md`](docs/THREAT_MODEL.md).

## Klienci

| Platforma | Technologia | Dystrybucja |
|---|---|---|
| Android | Kotlin + Compose, rdzeń przez UniFFI | Podpisany APK w Releases |
| iOS, desktop, przeglądarka | PWA, rdzeń przez WebAssembly | GitHub Pages |

Na iOS świadomie nie ma aplikacji natywnej: darmowe Apple ID nie daje dostępu do
APNs, więc sideloadowana apka nie dostarczałaby powiadomień. PWA dodana do ekranu
głównego **ma** Web Push (Safari 16.4+) — na darmowej ścieżce daje więcej niż
wersja natywna.

## Struktura

```
core/       Rust — kryptografia: tożsamość, MLS, framing, koperty
core/bindings/  WASM (przeglądarka) i UniFFI (Android) — jeden rdzeń, dwa wiązania
transport/  Rust — sieć P2P: iroh QUIC, koperty, wybór drogi dostarczenia
server/     Cloudflare Workers — auth, katalog, skrzynka, kolejność commitów
web/        PWA (iOS, desktop)
android/    Kotlin
docs/       Protokół i model zagrożeń
proto/      Normatywny format wiadomości
```

Kryptografia jest napisana **raz**, w Rust. Interfejs użytkownika jest natywny,
warstwa bezpieczeństwa nie — dwie równoległe implementacje MLS rozjechałyby się
w najwrażliwszym miejscu systemu.

`core` i `transport` są rozdzielone celowo: rdzeń kryptograficzny buduje się pod
WASM bez żadnego toolchainu C, a ciężka zależność sieciowa nie obciąża kodu,
który potrzebuje wyłącznie MLS.

## Budowanie

Wymagane: Rust 1.85+.

```bash
cargo test
```

Uruchomienie całości lokalnie (backend + klient webowy):

```bash
cd server && npx wrangler d1 migrations apply mekamb --local && npx wrangler dev
```

```bash
cd web && npm run dev
```

Sprawdzenie rdzenia pod przeglądarkę — działa wszędzie, bez dodatkowych narzędzi:

```bash
cargo check -p mekamb-core --target wasm32-unknown-unknown
```

Transport pod WASM wymaga clanga potrafiącego celować w wasm32 (systemowy clang
na macOS tego nie umie — potrzebny LLVM np. z Homebrew). CI sprawdza to
na Linuksie:

```bash
CC_wasm32_unknown_unknown=clang AR_wasm32_unknown_unknown=llvm-ar cargo check -p mekamb-transport --target wasm32-unknown-unknown
```

## Postęp

- [x] **Faza 0** — szkielet repozytorium, CI, dokumentacja protokołu
- [x] **Faza 1** — rdzeń: tożsamość, wyprowadzanie kluczy, grupy MLS, framing
- [x] **Faza 2** — transport iroh: koperty, wysyłka P2P, fallback na skrzynkę
- [x] **Faza 3** — backend: Durable Objects, katalog, OPAQUE + TOTP
- [x] **Faza 4** — PWA: rejestracja, logowanie, DM tekstowy, deploy na Pages
- [~] **Faza 5** — Android: bindingi UniFFI, transport P2P, UI (zostaje logowanie)
- [x] **Faza 6** — załączniki: zdjęcia i wideo szyfrowane end-to-end
- [ ] Fazy 7–11 — grupy wieloosobowe, rozmowy, multi-device, hardening

## Licencja

- `core/`, `web/`, `android/` — Apache-2.0 ([`LICENSE-APACHE`](LICENSE-APACHE))
- `server/` — AGPL-3.0 ([`server/LICENSE-AGPL`](server/LICENSE-AGPL))

AGPL na serwerze wymusza publikację modyfikacji przez każdego, kto postawi własną
instancję. W komunikatorze podmieniony serwer to realny wektor ataku, więc jego
kod powinien dać się zweryfikować.
