# mekamb-chat — backend

Cloudflare Workers. Licencja **AGPL-3.0** ([`LICENSE-AGPL`](LICENSE-AGPL)) — kto
postawi własną instancję, musi opublikować swoje zmiany. W komunikatorze
podmieniony serwer to realny wektor ataku, więc jego kod ma dać się zweryfikować.

## Co ten serwer robi, a czego nie

Jest **infrastrukturą pomocniczą, nie pośrednikiem w rozmowie**. W typowym
przypadku wiadomości go omijają — idą wprost między urządzeniami przez iroh.

| Robi | Nie robi |
|---|---|
| Ustala kolejność commitów MLS | Nie odszyfrowuje niczego |
| Przechowuje szyfrogramy dla offline'owych | Nie przechowuje historii rozmów |
| Wydaje key packages i adresy urządzeń | Nie jest zaufanym źródłem tych adresów — podpisy weryfikuje klient |
| Uwierzytelnia dostęp do infrastruktury | Nie widzi hasła (OPAQUE) i nie odblokowuje wiadomości |

## Uruchomienie

```bash
npm install
npm test
```

Testy działają na `workerd` — tym samym silniku co produkcja, więc gwarancje
Durable Objects są sprawdzane realnie, a nie na atrapie.

## Wdrożenie

### 1. Baza

```bash
npx wrangler d1 create mekamb
```

Zwrócony `database_id` wpisz do [`wrangler.jsonc`](wrangler.jsonc), a potem:

```bash
npx wrangler d1 migrations apply mekamb --remote
```

### 2. Sekrety

**Żaden z nich nie może trafić do repozytorium.**

```bash
npx wrangler secret put TOTP_ENCRYPTION_KEY
npx wrangler secret put TOKEN_SIGNING_KEY
npx wrangler secret put OPAQUE_SERVER_KEY
```

Sekret OPAQUE ma określoną strukturę — nie jest to zwykły losowy ciąg. Generuje
go biblioteka:

```bash
cargo run -q -p mekamb-opaque --bin genkey
```

> **Zmiana `OPAQUE_SERVER_KEY` unieważnia wszystkie konta.** Z niego wyprowadzany
> jest materiał wiążący hasła użytkowników z tym wdrożeniem. Potraktuj go jak
> dane, których utrata jest nieodwracalna.

### 3. Publikacja

Wdrożeniem zajmuje się [`deploy-server.yml`](../.github/workflows/deploy-server.yml)
przy każdym scaleniu do `main`. Potrzebuje sekretu `CLOUDFLARE_API_TOKEN`
(i `CLOUDFLARE_ACCOUNT_ID`, gdy konto ma dostęp do kilku kont Cloudflare)
w Settings → Secrets and variables → Actions.

Ręcznie — na pierwszy raz i w awarii:

```bash
npx wrangler d1 migrations apply mekamb --remote
npx wrangler deploy
```

> **Serwer musi wdrażać się razem z klientami.** Klient webowy publikuje się sam
> przy każdym scaleniu, APK powstaje przy etykiecie — a Worker wdrażany „gdy
> ktoś pamiętał" zostawał w tyle za kontraktem, który zmieniał się po stronie
> klienta. Tak powstało zgłoszenie #18: wdrożony Worker wymagał w zajęciu epoki
> pola, którego klienci już nie wysyłali, więc **nie dało się dodać kontaktu ani
> założyć rozmowy**, a komunikat mówił o „niepustej liście członków".
>
> Szybkie sprawdzenie, czy pod adresem stoi aktualna wersja:
>
> ```bash
> curl -s -o /dev/null -w '%{http_code}\n' "$API_URL/tokens/key"   # 404 = stary Worker
> ```

## Uwierzytelnianie

Trzy rundy. Hasło nie opuszcza urządzenia w żadnej postaci.

```
rejestracja:  register/start → register/finish → register/confirm (kod TOTP)
logowanie:    login/start    → login/finish    → login/totp       (token)
```

Kilka decyzji, które łatwo omyłkowo „poprawić":

- **Logowanie nieistniejącą nazwą przechodzi tę samą ścieżkę** co prawdziwe,
  z atrapą rekordu. Skrót w tym miejscu przywróciłby możliwość sprawdzania,
  które konta istnieją.
- **Kod TOTP użyty raz nie działa ponownie** w tym samym oknie czasowym.
  Skutek: po aktywacji konta trzeba poczekać na nowy kod, do 30 sekund.
  Tego wymaga RFC 6238 §5.2.
- **Sesje logowania są jednorazowe** — konsumowane przez `DELETE ... RETURNING`,
  więc równoległe żądania nie użyją tego samego rekordu dwa razy.

## OPAQUE: jedna implementacja, trzy platformy

Kryptografia siedzi w [`opaque/`](../opaque) (Rust, RFC 9807). Serwer używa jej
przez WebAssembly, przeglądarka przez WebAssembly, Android przez UniFFI.

To nie jest wybór estetyczny, tylko wniosek z nieudanej próby. Wcześniej serwer
miał implementację w TypeScripcie (`@cloudflare/opaque-ts`), która realizuje
**draft-irtf-cfrg-opaque-07** z 2021 roku. Klient natywny musiałby użyć rustowej,
realizującej **RFC 9807**. Między draftem a RFC zmienił się format komunikatów,
więc te dwie implementacje nigdy by się nie dogadały — nie „mniej bezpiecznie",
tylko logowanie, które nigdy nie przechodzi.

### Jak WASM w ogóle działa w Workers

Środowisko zabrania **kompilowania** WebAssembly w runtime — na tym poległa
wcześniejsza próba z biblioteką inline'ującą WASM jako base64. Wolno natomiast
zaimportować moduł skompilowany przez bundler i utworzyć instancję ręcznie;
robi to [`src/opaque-wasm/index.js`](src/opaque-wasm/index.js).

Rozróżnienie jest istotne: zakaz dotyczy generowania kodu, a nie uruchamiania
kodu przygotowanego wcześniej.

### Regeneracja modułu

Po zmianach w `opaque/`:

```bash
cargo build -p mekamb-opaque-wasm --target wasm32-unknown-unknown --release
wasm-bindgen target/wasm32-unknown-unknown/release/mekamb_opaque_wasm.wasm \
  --out-dir server/src/opaque-wasm --target bundler --no-typescript
```

Plik `index.js` i `index.d.ts` są pisane ręcznie i **nie są nadpisywane** —
`wasm-bindgen` o nich nie wie.
