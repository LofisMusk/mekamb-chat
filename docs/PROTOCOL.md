# Protokół mekamb-chat, wersja 1

Dokument normatywny. Implementacja w innym języku powinna dać się napisać
wyłącznie na jego podstawie.

## 1. Fundamenty

| Warstwa | Wybór |
|---|---|
| Kryptografia grup | MLS, RFC 9420 (OpenMLS) |
| Ciphersuite | `MLS_128_DHKEMX25519_AES128GCM_SHA256_Ed25519` (0x0001) |
| Transport | iroh 1.0 — QUIC z przebijaniem NAT, relay jako fallback |
| Ładunek aplikacyjny | protobuf, [`proto/chat.proto`](../proto/chat.proto) |
| Uwierzytelnienie do infrastruktury | OPAQUE + TOTP (RFC 6238) |

Ciphersuite jest obowiązkowy w RFC 9420, więc protokół pozostaje
interoperacyjny z innymi implementacjami MLS.

## 2. Tożsamość i wyprowadzanie kluczy

Urządzenie przechowuje **jedno** 32-bajtowe ziarno. Wszystkie klucze powstają
z niego przez HKDF-SHA256, bez soli, z rozłącznymi etykietami:

```
klucz_podpisu_mls = HKDF-SHA256(ikm = ziarno, info = "mekamb-chat/v1/mls-signature", L = 32)
klucz_wezla_iroh  = HKDF-SHA256(ikm = ziarno, info = "mekamb-chat/v1/iroh-node",     L = 32)
```

Oba są 32-bajtowymi ziarnami Ed25519; klucz publiczny wyprowadza się standardowo.

**Etykiety są rozłączne celowo.** `NodeId` iroh i klucz podpisu MLS to obie pary
Ed25519, więc kusi użycie jednej. Ten sam klucz w dwóch protokołach otwiera drogę
do przeniesienia podpisu między kontekstami. Rozdzielenie kosztuje jedno
wywołanie HKDF.

**Etykiety są wersjonowane i niezmienne.** Zmiana schematu wyprowadzania wymaga
nowej etykiety (`/v2/`), nigdy modyfikacji istniejącej — inaczej urządzeniom
zmieniłyby się klucze pod ręką i wypadłyby ze wszystkich grup.

Wyprowadzanie jest deterministyczne: import ziarna z kopii zapasowej odtwarza
dokładnie tę samą tożsamość.

### Credential

Credential MLS jest typu `BasicCredential`, a jego zawartość to:

```
user_id ":" device_id
```

Oba pola: niepuste, UTF-8, **bez dwukropka**. Zakaz dwukropka jest wymogiem
bezpieczeństwa, nie kosmetyką — bez niego `user_id` = `"alice:telefon"`
pozwalałby podszyć się pod inną parę użytkownik-urządzenie.

Odbiorca ustala autora wyłącznie na podstawie credentiala zweryfikowanego przez
MLS. Żadne pole spoza kanału MLS nie jest źródłem prawdy o nadawcy.

## 3. Rozmowy

**DM to grupa MLS o rozmiarze 2.** Nie ma osobnej ścieżki kryptograficznej dla
rozmów prywatnych i grupowych.

Parametry grupy — identyczne przy zakładaniu i dołączaniu:

- `padding_size` = 256 bajtów. MLS szyfruje treść, ale nie ukrywa jej długości;
  dopełnienie zaciera różnicę między „ok" a dłuższą wypowiedzią.
- `use_ratchet_tree_extension` = `true`. Drzewo ratchetu podróżuje w wiadomości
  zamiast być pobierane osobno — konieczne w architekturze P2P-first, gdzie
  serwer bywa nieosiągalny.

### Key packages

Każde urządzenie publikuje zapas key packages, które pozwalają dodać je do grupy
gdy jest offline (odpowiednik prekeys w Signalu).

Key package jest **jednorazowy**. Serwer musi egzekwować jednokrotne wydanie —
ponowne użycie psuje gwarancje forward secrecy.

## 4. Podział ruchu

To jest sedno architektury.

| Rodzaj | Kanał | Dlaczego |
|---|---|---|
| Wiadomości aplikacyjne | iroh P2P | Przemienne w obrębie epoki, nie wymagają porządku |
| Media rozmów | WebRTC P2P | Wolumen i opóźnienia |
| Sygnalizacja rozmów | kanał MLS przez iroh | Musi być uwierzytelniona |
| Commity MLS | `GroupRelay` (Durable Object) | Wymagają jednego autorytatywnego porządku |
| Wiadomości do offline'owych | `UserInbox` (Durable Object) | Ktoś musi je przechować |

### Doręczanie przez skrzynkę wymaga potwierdzenia

Koperta trafia do kolejki **zawsze**, także wtedy, gdy odbiorca ma otwarte
połączenie. Wysyłka w gniazdo jest przyspieszeniem, nie doręczeniem: `send`
kończy się powodzeniem, gdy bajty trafią do bufora, a nie gdy klient je
przetworzy i zapisze.

Wpis znika z kolejki dopiero po potwierdzeniu (`ack:<id>`), które klient wysyła
**po** utrwaleniu stanu MLS. Bez tego wystarczyłoby zamknąć kartę między
odebraniem a zapisem, żeby wiadomość przepadła — nadawca miałby ją za
dostarczoną i nikt by jej nie powtórzył.

Ceną jest możliwość otrzymania tej samej koperty dwa razy. To nieszkodliwe:
`message_id` pozwala odsiać duplikat.

### Cykl życia commitu

Commit zmienia epokę, więc dwa równoległe commity muszą zostać rozstrzygnięte.
Rozstrzyga `GroupRelay`, bo Durable Object jest jednowątkowy.

```
1. Klient przygotowuje commit          → stage_add_member / stage_remove_member
2. Wysyła go do GroupRelay
3a. Relay potwierdza (był pierwszy)    → confirm_pending_commit  → epoka +1
3b. Relay odrzuca (ktoś go ubiegł)     → discard_pending_commit  → epoka bez zmian,
                                          przetwórz cudzy commit i ponów
```

**Commit nie jest scalany przed potwierdzeniem.** Scalenie od razu przy
odrzuceniu zostawiłoby klienta w epoce, której reszta grupy nie zna — czyli poza
rozmową.

## 5. Ładunek aplikacyjny

Pełna definicja: [`proto/chat.proto`](../proto/chat.proto). Ładunek **zawsze**
podróżuje wewnątrz wiadomości aplikacyjnej MLS.

Odbiorca odrzuca ładunek, gdy:
- `protocol_version` ≠ 1,
- `body` jest puste (nierozpoznany wariant `oneof`),
- `message_id` nie ma dokładnie 16 bajtów.

`sent_at_ms` to **deklaracja nadawcy**, nie fakt — nadawca może wpisać dowolną
wartość. Do porządkowania w interfejsie należy używać kolejności odbioru,
a znacznika wyłącznie do wyświetlenia.

## 6. Załączniki

Plik jest szyfrowany **przed** wysłaniem na serwer, świeżym kluczem AES-256-GCM.

```
1. Klient losuje klucz (32 B) i nonce (12 B)
2. Szyfruje plik; `mime_type` wchodzi do danych uwierzytelnionych (AAD)
3. Wgrywa SAM SZYFROGRAM na serwer → dostaje `blob_id`
4. Wysyła `AttachmentBody` z kluczem, nonce'em, typem i nazwą — kanałem MLS
```

Właściwości, które ta konstrukcja musi zachować:

- **Świeży klucz na każdy plik.** Powtórzenie pary (klucz, nonce) w AES-GCM nie
  osłabia szyfru „trochę" — pozwala odzyskać strumień klucza i sfałszować
  dowolną wiadomość. Losowanie klucza per plik usuwa tę możliwość z definicji,
  zamiast polegać na poprawnym liczeniu licznika.
- **Typ pliku jest uwierzytelniony.** `mime_type` trafia do AAD, więc podmiana
  deklarowanego typu unieważnia szyfrogram. Bez tego pośrednik mógłby podać
  wideo jako obraz i skierować je do innego dekodera niż zamierzony.
- **Nazwa pliku i typ nie trafiają na serwer.** Są metadanymi treści, więc
  zostają w kanale MLS. R2 przechowuje wyłącznie bajty i czas wgrania.
- **Limit 25 MB.** Mieści zdjęcia i krótkie wideo bez przesyłania
  wieloczęściowego. Większe pliki wymagałyby wysyłki prosto do R2 z pominięciem
  Workera — to osobna funkcja, nie zmiana stałej.

Serwer nadaje `blob_id` sam. Pozwolenie klientowi na wybór nazwy umożliwiałoby
nadpisanie cudzego bloba albo zgadywanie istniejących.

## 7. Rozmowy audio/wideo

WebRTC, topologia mesh, maksymalnie 4 uczestników. Bez serwera mediów.

Sygnalizacja (`CallSignalBody`) idzie **kanałem MLS**. Dzięki temu odcisk DTLS
jest uwierzytelniony kryptograficznie: podmiot kontrolujący warstwę transportową
nie podstawi się w środek połączenia, bo nie sfałszuje wiadomości MLS.

**Niezgodność odcisku DTLS = natychmiastowe zerwanie połączenia, bez pytania
użytkownika.** Pytanie w tym miejscu oznaczałoby przerzucenie decyzji
kryptograficznej na osobę, która nie ma jak jej ocenić.

- STUN: `stun.cloudflare.com`
- TURN: Cloudflare Realtime, poświadczenia krótkożyjące wydawane przez Worker

Limit 4 osób wynika z pasma: przy 5 uczestnikach każdy wysyła 4 strumienie
w górę, co przekracza możliwości typowego łącza domowego.

## 8. Uwierzytelnienie do infrastruktury

```
rejestracja:  register/start → register/finish → register/confirm
              (OPAQUE)         (konto pending,    (kod z authenticatora
                                sekret TOTP)       aktywuje konto)

logowanie:    login/start    → login/finish    → login/totp
              (OPAQUE runda 1) (OPAQUE runda 2)  (drugi składnik → token)
```

Właściwości, które ta ścieżka musi zachować:

- **Serwer nie widzi hasła** ani w chwili rejestracji, ani logowania. Z rekordu
  w bazie nie da się prowadzić ataku słownikowego offline — inaczej niż z hasha.
- **Nieistniejąca nazwa użytkownika przechodzi tę samą ścieżkę** co istniejąca,
  z atrapą rekordu (`RegistrationRecord.createFake`). Bez tego kształt lub czas
  odpowiedzi zdradzałby, które konta istnieją.
- **Kod TOTP jest jednorazowy w swoim oknie.** Zapisujemy numer ostatnio użytego
  okna i odrzucamy wszystko, co nie jest późniejsze (RFC 6238 §5.2). Skutek
  widoczny dla użytkownika: po aktywacji konta trzeba poczekać na nowy kod.
- **Sesja logowania jest jednorazowa** — konsumowana niepodzielnie przez
  `DELETE ... RETURNING`.

**Hasło i TOTP nie odblokowują wiadomości.** Autoryzują wyłącznie dostęp do
infrastruktury: skrzynki offline, katalogu i publikowania key packages. Klucze
wiadomości nigdy nie opuszczają urządzenia, więc przejęcie konta nie daje
dostępu do historii.

## 9. Wersjonowanie

Każda koperta niesie wersję protokołu. Odbiorca odrzuca nieznaną wersję główną
zamiast zgadywać — czytelny błąd jest lepszy niż ciche błędne parsowanie.

Zmiany łamiące zgodność wymagają podniesienia `PAYLOAD_VERSION` oraz nowych
etykiet HKDF.
