# Protokół mekamb-chat, wersja 1

Dokument normatywny. Implementacja w innym języku powinna dać się napisać
wyłącznie na jego podstawie.

## 1. Fundamenty

| Warstwa | Wybór |
|---|---|
| Kryptografia grup | MLS, RFC 9420 (OpenMLS) |
| Ciphersuite | `MLS_128_DHKEMX25519_AES128GCM_SHA256_Ed25519` (0x0001) |
| Transport | własny: UDP + STUN + Noise IK, skrzynka jako fallback |
| Ładunek aplikacyjny | protobuf, [`proto/chat.proto`](../proto/chat.proto) |
| Uwierzytelnienie do infrastruktury | OPAQUE (RFC 9807) + TOTP (RFC 6238) |

Ciphersuite jest obowiązkowy w RFC 9420, więc protokół pozostaje
interoperacyjny z innymi implementacjami MLS.

## 2. Tożsamość i wyprowadzanie kluczy

Urządzenie przechowuje **jedno** 32-bajtowe ziarno. Wszystkie klucze powstają
z niego przez HKDF-SHA256, bez soli, z rozłącznymi etykietami:

```
klucz_podpisu_mls = HKDF-SHA256(ikm = ziarno, info = "mekamb-chat/v1/mls-signature", L = 32)
klucz_transportu  = HKDF-SHA256(ikm = ziarno, info = "mekamb-chat/v1/iroh-node",     L = 32)
```

> Etykieta transportu nosi historyczną nazwę `iroh-node`. **Nie wolno jej
> zmienić**: wszystkim istniejącym urządzeniom zmieniłby się klucz pod ręką.
> Etykiety są niezmienne z założenia — zmiana schematu wymaga nowej wersji.

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

### Dodawanie osoby do rozmowy

Ta sama ścieżka obsługuje założenie DM-a i rozbudowę grupy — bo DM to grupa
o rozmiarze 2.

```
1. Pobierz key package urządzenia dodawanej osoby
2. Przygotuj commit (stage_add_member)
3. Wyślij do GroupRelay: { epoka, koperta z commitem, NOWY skład }
4a. Przyjęty  → scal lokalnie, wyślij Welcome nowej osobie
4b. Odrzucony → porzuć commit; cudzy commit dotrze skrzynką, po nim ponów
```

`GroupRelay` rozsyła kopertę pozostałym członkom **z pominięciem nadawcy**:
ten scalił commit u siebie, a przetworzenie własnego commitu w MLS kończy się
błędem.

Skład aktualizowany jest **po** przyjęciu commitu. Przy odrzuceniu lista zostaje
nietknięta, więc nieudana próba nie psuje routingu grupy. Nadawcę serwer bierze
z tokenu, a nie z ciała żądania — inaczej dałoby się wykluczyć z rozsyłki
dowolną osobę i po cichu odciąć ją od grupy.

**Nowa osoba nie widzi wcześniejszych wiadomości.** To wynika wprost z MLS:
dołącza w bieżącej epoce i nie ma materiału klucza z poprzednich. Zamierzone.

## 4. Podział ruchu

To jest sedno architektury.

| Rodzaj | Kanał | Dlaczego |
|---|---|---|
| Wiadomości aplikacyjne | własny transport P2P | Przemienne w obrębie epoki, nie wymagają porządku |
| Media rozmów | WebRTC P2P | Wolumen i opóźnienia |
| Sygnalizacja rozmów | kanał MLS | Musi być uwierzytelniona |
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

### Transport P2P

| Warstwa | Rozwiązanie |
|---|---|
| Gniazdo | UDP |
| Poznanie własnego adresu | STUN (RFC 5389) |
| Zestawienie połączenia | jednoczesne pakiety, przebijanie NAT |
| Szyfrowanie i uwierzytelnienie | Noise IK (`Noise_IK_25519_ChaChaPoly_BLAKE2s`) |

Wzorzec **IK** jest wybrany celowo: inicjator zna z góry statyczny klucz
odpowiadającego — bierze go z katalogu. Jeśli katalog skłamał, **handshake nie
przejdzie**, więc serwer nie podstawi się w środek połączenia.

Druga warstwa szyfrowania nie dubluje MLS. MLS chroni treść; Noise chroni
**kopertę**, która musi być czytelna dla odbiorcy przed odszyfrowaniem, a więc
niesie `group_id` jawnie. Bez Noise obserwator sieci odtworzyłby graf rozmów.

**Nie ma przekaźnika.** Przy symetrycznym NAT po obu stronach przebicie się nie
uda i wchodzi skrzynka. Własny relay wymagałby serwera z UDP, a architektura
stoi na Cloudflare Workers, które UDP nie obsługują.

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

### Metadane zdjęć

Ze zdjęć usuwamy metadane **przed** zaszyfrowaniem, domyślnie i bez pytania.

Powód jest prosty: EXIF w zdjęciu z telefonu niesie współrzędne GPS
z dokładnością do kilku metrów, model aparatu i czas wykonania. Szyfrowanie nie
pomaga na dane, które sami umieszczamy w środku szyfrogramu — docierają do
odbiorcy razem z obrazem i mogą powędrować dalej.

Czyszczenie przepisuje strukturę pliku, przepuszczając wyłącznie fragmenty
potrzebne do wyświetlenia. **Piksele zostają bit w bit takie same** — inaczej
niż przy przekodowaniu, które kosztowałoby jakość.

| Format | Zostaje | Wylatuje |
|---|---|---|
| JPEG | JFIF, profil ICC, tablice i nagłówki ramki | APP1 (EXIF, XMP), APP13 (IPTC), komentarze, reszta APPn |
| PNG | chunki krytyczne, barwy, APNG | `tEXt`, `zTXt`, `iTXt`, `eXIf`, `tIME` |

Obie listy są **listami dozwolonych**, nie zakazanych. Przy odwrotnym podejściu
każdy nowy, nieznany typ segmentu przechodziłby domyślnie — czyli dokładnie ten
przypadek, którego chcemy uniknąć.

### Metadane wideo (MP4, MOV)

Kontenery ISO BMFF czyścimy inaczej niż obrazy, i to jest istotne.

MP4 trzyma w tablicach `stco` i `co64` **bezwzględne offsety** do danych obrazu
w `mdat`. Wycięcie czegokolwiek przed `mdat` przesunęłoby wszystko, co jest za
nim, a tablice wskazywałyby w próżnię — plik przestałby się odtwarzać.

Dlatego boksy z metadanymi **nadpisujemy typem `free` i zerujemy ich
zawartość**. Rozmiar zostaje ten sam, więc żaden offset się nie zmienia,
a odtwarzacze pomijają `free` z definicji.

| Poziom | Zostaje | Wylatuje |
|---|---|---|
| najwyższy | `ftyp`, `moov`, `mdat`, `moof`, `mfra`, `sidx` | `uuid` (XMP), `meta`, `free` |
| `moov` | `mvhd`, `trak`, `mvex`, `iods` | `udta` (GPS, model), `meta`, `uuid` |
| `trak` | `tkhd`, `mdia`, `edts`, `tref` | `udta`, `meta`, `uuid` |

Osobno wykrywamy **ścieżki z metadanymi czasowymi**: `trak`, którego
`mdia/hdlr` ma typ `meta` lub `mebx`. Formalnie to zwykła ścieżka, więc lista
dozwolonych by jej nie odsiała — a kamery sportowe zapisują tam pełny przebieg
trasy GPS, czyli największy możliwy wyciek.

Zerujemy zawartość, a nie tylko przestawiamy typ boksu: same przestawienie
zostawiłoby współrzędne w pliku, tyle że w miejscu pomijanym przez odtwarzacz.
Pierwsze lepsze narzędzie do odzyskiwania danych by je znalazło.

Koszt: plik nie chudnie. To rozsądna cena za pewność, że nagranie nadal działa.

**Nieudane czyszczenie nie blokuje wysyłki.** Plik w nietypowym wariancie
kontenera lepiej dostarczyć niż odrzucić — pod warunkiem, że interfejs powie,
iż akurat ten poszedł z metadanymi.

## 7. Safety number

Kod do porównania poza aplikacją, liczony wyłącznie z tożsamości uczestników.

```
material = "mekamb-chat/v1/safety-number"
         || dla każdego uczestnika (posortowanych, bez duplikatów):
              len(identity) || identity || len(signature_key) || signature_key

digest = SHA-512(material)
powtórz 5200 razy:  digest = SHA-512(digest || etykieta)

kod = 12 grup po 5 cyfr, każda z kolejnych 5 bajtów skrótu modulo 100000
```

Decyzje, które są tu istotne:

- **Sortowanie i deduplikacja.** Bez nich dwie osoby w tej samej rozmowie
  zobaczyłyby różne kody i porównanie nigdy by się nie udało.
- **Prefiksy długości.** Bez nich dałoby się przesunąć granicę między nazwą
  a kluczem i spreparować inny skład dający ten sam kod.
- **Powtórzone haszowanie.** Kod ma ~200 bitów, czyli mniej niż klucz — atak
  polega na szukaniu innej pary kluczy dającej ten sam wynik. Iteracje mnożą
  koszt takiego poszukiwania. Domieszka etykiety w każdej rundzie wymusza
  przejście całego łańcucha zamiast zrównoleglenia.
- **Klucze z drzewa MLS, nie z katalogu.** Gdyby serwer podstawił cudze
  urządzenie, znalazłoby się ono w drzewie i zmieniło kod. Odczyt z katalogu
  pozwalałby serwerowi pokazać jedno, a wprowadzić do grupy co innego.

Kod zmienia się przy każdej zmianie składu rozmowy — uczestnicy mają wtedy
porównać go ponownie.

## 8. Rozmowy audio/wideo

WebRTC, topologia mesh, maksymalnie 4 uczestników. Bez serwera mediów.

Sygnalizacja (`CallSignalBody`) idzie **kanałem MLS**. Dzięki temu odcisk DTLS
jest uwierzytelniony kryptograficznie: podmiot kontrolujący warstwę transportową
nie podstawi się w środek połączenia, bo nie sfałszuje wiadomości MLS.

### Weryfikacja odcisku

```
1. Dzwoniący tworzy ofertę SDP
2. Wyciąga z niej własny odcisk DTLS
3. Wysyła SDP i odcisk RAZEM, wewnątrz wiadomości MLS
4. Odbiorca porównuje odcisk z SDP z tym z kanału MLS
5a. Zgodne     → zestawia połączenie
5b. Niezgodne  → zrywa, BEZ pytania użytkownika
```

Trzy szczegóły, które decydują o skuteczności:

- **Sprawdzamy wszystkie odciski w SDP, nie pierwszy.** SDP może nieść odcisk
  na poziomie sesji i osobne dla każdej ścieżki mediów. Wystarczyłoby dopisać
  drugą ścieżkę z własnym odciskiem, gdyby sprawdzać tylko pierwszy.
- **Weryfikacja poprzedza ustawienie opisu zdalnego.** Odwrotna kolejność
  tworzyłaby — choćby na moment — połączenie z niezweryfikowaną stroną.
- **Tylko SHA-256.** Lista dozwolonych z jedną pozycją nie pozwala zejść
  na algorytm, dla którego kolizję da się znaleźć.

**Niezgodność odcisku DTLS = natychmiastowe zerwanie połączenia, bez pytania
użytkownika.** Pytanie w tym miejscu oznaczałoby przerzucenie decyzji
kryptograficznej na osobę, która nie ma jak jej ocenić — a odpowiedź „tak"
byłaby najczęstsza.

### Adres IP a droga połączenia

Połączenie bezpośrednie ujawnia adres IP rozmówcy. Przy przejściu przez TURN
adres widzi przekaźnik zamiast rozmówcy. Interfejs pokazuje, która droga jest
w użyciu — milczenie sugerowałoby, że nie ujawnia się nic.

- STUN: `stun.cloudflare.com`
- TURN: Cloudflare Realtime, poświadczenia krótkożyjące wydawane przez Worker

Limit 4 osób wynika z pasma: przy 5 uczestnikach każdy wysyła 4 strumienie
w górę, co przekracza możliwości typowego łącza domowego.

## 9. Uwierzytelnienie do infrastruktury

```
rejestracja:  register/start → register/finish → register/confirm
              (OPAQUE)         (konto pending,    (kod z authenticatora
                                sekret TOTP)       aktywuje konto)

logowanie:    login/start    → login/finish    → login/totp
              (OPAQUE runda 1) (OPAQUE runda 2)  (drugi składnik → token)
```

**Serwer i wszystkie klienty używają tej samej implementacji** — `opaque-ke`
w Rust, wystawionej przez WebAssembly (Worker, przeglądarka) i UniFFI (Android).

Dwie niezależne implementacje tego samego protokołu nie są zgodne na poziomie
bajtów tylko dlatego, że obie „robią OPAQUE". Sprawdziliśmy to na własnej
skórze: implementacja TypeScript realizowała draft-07, rustowa RFC 9807, a między
nimi zmienił się format komunikatów. Wspólny kod usuwa całą klasę problemów.

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

## 10. Wersjonowanie

Każda koperta niesie wersję protokołu. Odbiorca odrzuca nieznaną wersję główną
zamiast zgadywać — czytelny błąd jest lepszy niż ciche błędne parsowanie.

Zmiany łamiące zgodność wymagają podniesienia `PAYLOAD_VERSION` oraz nowych
etykiet HKDF.
