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
npx wrangler secret put OPAQUE_OPRF_SEED
npx wrangler secret put OPAQUE_AKE_SEED
```

Ziarna OPAQUE muszą mieć **dokładnie 32 bajty**, podane w base64:

```bash
openssl rand -base64 32
```

> **Zmiana `OPAQUE_OPRF_SEED` albo `OPAQUE_AKE_SEED` unieważnia wszystkie konta.**
> Z tych ziaren wyprowadzany jest materiał wiążący hasła użytkowników z tym
> wdrożeniem. Potraktuj je jak dane, których utrata jest nieodwracalna.

### 3. Publikacja

```bash
npx wrangler deploy
```

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

## Wybór biblioteki OPAQUE

Używamy [`@cloudflare/opaque-ts`](https://github.com/cloudflare/opaque-ts),
czystego TypeScriptu.

Pierwotny wybór, `@serenity-kit/opaque`, **nie działa w Workers**: inline'uje
WASM jako base64 i kompiluje go w runtime, co środowisko blokuje
(`Wasm code generation disallowed by embedder`). Sprawdza to
[`test/opaque-probe.test.ts`](test/opaque-probe.test.ts) — gdyby ktoś chciał
wrócić do wariantu z WASM, ten test pokaże, na czym to stanie.

Kosztowne rozciąganie klucza dzieje się po stronie **klienta**; serwer wykonuje
tylko operacje na krzywej eliptycznej, więc limit CPU Workera nie jest zagrożony.
