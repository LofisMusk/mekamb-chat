# Polityka bezpieczeństwa

## Status projektu

**mekamb-chat jest w budowie i nie przeszedł niezależnego audytu.**

Nie należy go używać tam, gdzie ujawnienie treści miałoby poważne konsekwencje.
Do takich zastosowań istnieją komunikatory po audycie — Signal.

## Znane zgłoszenia audytu

`cargo audit` zgłasza dziewięć pozycji, wszystkie wyciszone w
[`.cargo/audit.toml`](.cargo/audit.toml) z uzasadnieniem. Poniżej ocena — jawnie,
bo wyciszenie bez uzasadnienia jest gorsze niż brak audytu.

### Faktycznie w drzewie zależności

`libcrux-sha3` i `libcrux-secrets` wchodzą przez `hpke-rs` → `openmls_rust_crypto`.
Trzy zgłoszenia (RUSTSEC-2026-0207, -0208, -0212), wszystkie o wysokiej wadze,
wszystkie dotyczą **SHA3 i SHAKE**.

Nasz ciphersuite to `MLS_128_DHKEMX25519_AES128GCM_SHA256_Ed25519` — X25519,
AES-128-GCM, SHA-256, Ed25519. **SHA3 ani SHAKE nie występują na tej ścieżce.**

To ocena oparta na wyborze ciphersuite, nie na prześledzeniu kodu `hpke-rs`.
Gdyby ktoś zmienił ciphersuite na wariant z SHA3, ocena przestaje obowiązywać.

Poprawki istnieją (`libcrux-sha3` ≥ 0.0.10, `libcrux-secrets` ≥ 0.0.6), ale
`hpke-rs` przypina starsze wersje. **Do usunięcia z listy wyciszeń, gdy hpke-rs
zaktualizuje libcrux.**

### Poza drzewem

`libcrux-aesgcm` i `libcrux-chacha20poly1305` figurują w `Cargo.lock`, ale
`cargo tree` pokazuje **zero wystąpień** — nie trafiają do żadnego builda.
To pozostałość rozwiązywania zależności opcjonalnych.

### Zależności JavaScriptu

Audyt npm blokuje wyłącznie na **zależnościach produkcyjnych** — tych, które
trafiają do użytkownika. Tam jest ich zero.

Narzędzia budowania i testów są sprawdzane osobno, informacyjnie: `wrangler`
i `miniflare` ciągną `undici` z otwartymi zgłoszeniami, a jedyna poprawka
proponowana przez npm to cofnięcie wranglera do starszej wersji. Te zależności
nie działają ani na serwerze produkcyjnym (Worker chodzi na runtime Cloudflare,
nie na undici), ani u użytkownika.

### Niekonserwowane

`instant` i `proc-macro-error2` to ostrzeżenia o braku konserwacji, nie
podatności. Oba wchodzą przez narzędzia budowania.

## Zgłaszanie podatności

Podatności prosimy zgłaszać przez **GitHub Security Advisories** w tym
repozytorium (zakładka Security → Report a vulnerability). Kanał jest prywatny
do czasu wydania poprawki.

Prosimy **nie** zakładać publicznych zgłoszeń dla problemów bezpieczeństwa.

W zgłoszeniu przydatne są: opis, kroki odtworzenia, wersja i platforma oraz ocena
wpływu. Odpowiadamy najszybciej jak się da, ale to projekt prowadzony po
godzinach — bez gwarancji czasu reakcji.

## Zakres

Interesują nas zwłaszcza:

- obejście E2EE, wycieki materiału klucza,
- błędy w wyprowadzaniu kluczy i rozdzielaniu etykiet HKDF,
- podszycie się pod innego nadawcę,
- MITM na rozmowach (obejście weryfikacji odcisku DTLS),
- obejście uwierzytelnienia (OPAQUE, TOTP),
- panika lub uszkodzenie pamięci przy danych z sieci.

Poza zakresem — bo są udokumentowanymi decyzjami projektowymi, nie błędami:

- wyciek metadanych do serwera ([`THREAT_MODEL.md`](docs/THREAT_MODEL.md)),
- ujawnienie IP rozmówcy przy połączeniu bezpośrednim,
- utrata historii po utracie wszystkich urządzeń,
- ryzyko dostarczania kodu w kliencie webowym.

Jeśli uważasz, że któraś z tych decyzji jest błędna, załóż zwykłe zgłoszenie do
dyskusji.

## Kryptografia

Nie piszemy własnej kryptografii. Używamy:

- [OpenMLS](https://openmls.tech/) — MLS / RFC 9420
- [iroh](https://iroh.computer/) — transport QUIC
- `opaque-ke` — uwierzytelnienie hasłem bez ujawniania hasła

Pull requesty wprowadzające własne prymitywy kryptograficzne będą odrzucane.
