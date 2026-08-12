# Model zagrożeń

Dokument mówi wprost, przed czym mekamb-chat chroni, a przed czym **nie**.
Komunikator, który obiecuje więcej, niż daje, jest gorszy od takiego, który nie
obiecuje nic — użytkownik podejmuje decyzje na podstawie tych obietnic.

## Co jest chronione

| Zasób | Ochrona |
|---|---|
| Treść wiadomości | E2EE przez MLS. Serwer i relaye widzą wyłącznie szyfrogram |
| Treść załączników | AES-256-GCM po stronie klienta, świeży klucz na plik; klucz podróżuje w kanale MLS |
| Nazwa pliku i jego typ | Podróżują w kanale MLS. Serwer widzi wyłącznie nieprzezroczysty blob |
| Lokalizacja i dane aparatu w zdjęciach | Usuwane przed zaszyfrowaniem, domyślnie (EXIF, XMP, IPTC, chunki tekstowe PNG) |
| Lokalizacja i dane urządzenia w wideo | Usuwane z MP4 i MOV, razem ze ścieżkami metadanych czasowych (trasy GPS z kamer sportowych) |
| Media rozmów | WebRTC P2P, odcisk DTLS uwierzytelniony przez MLS i weryfikowany przed zestawieniem połączenia |
| Historia rozmów | Tylko na urządzeniach. Serwer nie ma czego wydać ani zgubić |
| Tożsamość nadawcy | Credential MLS weryfikowany kryptograficznie |
| Kto co odebrał i przeczytał | Potwierdzenia idą jako wiadomości MLS — serwer widzi szyfrogram. Nie niosą znacznika czasu odczytu, bo ten w ogóle nie istnieje w protokole |
| Hasło | OPAQUE — serwer nie widzi go nawet w pamięci |
| Wsteczna poufność | Ratchet MLS: przejęcie klucza nie odsłania wcześniejszych wiadomości |
| Przyszła poufność | Aktualizacje epok odcinają atakującego po usunięciu z grupy |

## Czego NIE chronimy

Ta lista jest ważniejsza od poprzedniej.

### Metadane

Serwer widzi i może logować:

- kto ma konto i kiedy się loguje,
- które urządzenia należą do którego użytkownika,
- **do czyjej** skrzynki trafia koperta — skrzynka nazywa się nazwą
  użytkownika i inaczej nie dałoby się jej doręczyć,
- adres IP nadawcy: `POST /inbox/:userId` jest celowo **nieuwierzytelniony**,
  więc serwer nie poznaje tożsamości nadającego, ale widzi połączenie,
- kiedy i ile bajtów trafia do skrzynki offline,
- **rozmiar każdego załącznika**.

Serwer **przestał** widzieć identyfikator rozmowy. Koperta niosła go jawnie do
wersji 2 formatu — wystarczało to, żeby powiązać koperty w rozmowy i zbudować
graf bez odszyfrowania choćby bajtu. Dziś koperta niesie losową sól i znacznik
z niej wyprowadzony, inny dla każdej koperty (`core/src/envelope.rs`). Obiekt
porządkujący epoki nazywa się osobno wyprowadzoną wartością, więc identyfikator
rozmowy nie dociera do serwera żadną drogą.

Zostaje `kind` koperty: serwer widzi, że ktoś kogoś właśnie dodaje do grupy,
choć nie wie do której. Odbiorca musi to wiedzieć, zanim będzie miał czym
cokolwiek dopasować.

Serwer **przestał** widzieć skład grupy. `GroupRelay` trzymał listę członków, bo
sam rozsyłał commity — była to jedyna struktura mówiąca mu wprost „kto z kim
rozmawia". Dziś rozsyła nadawca, który skład zna z drzewa MLS, a relay zajmuje
tylko kolejne epoki przy nieprzezroczystym identyfikatorze. Skład nadal daje się
zgrubnie odtworzyć z tego, kto do czyich skrzynek nadaje — ale nie leży już
gotowy w bazie.

Ostatni punkt jest istotniejszy, niż wygląda: sam rozmiar sporo mówi o rodzaju
pliku — zdjęcie z telefonu, zrzut ekranu i krótkie wideo mają wyraźnie różne
rzędy wielkości. Ukrycie tego wymagałoby dopełniania plików do stałych progów,
co przy wideo oznaczałoby przesyłanie wielokrotnie większej ilości danych.
Świadomie tego nie robimy.

Serwer **nie** widzi treści ani — przy działającym P2P — samych wiadomości.

### Nadawca przy zostawianiu koperty

Nadanie do skrzynki **nie wymaga tokenu** i nie jest to przeoczenie: serwer
z założenia nie ma się dowiadywać, kto do kogo pisze. Tożsamość nadawcy jest
uwierzytelniona kryptograficznie **wewnątrz** MLS, gdzie serwer jej nie widzi.

Skoro jednak nadawać może każdy, każdy mógłby zalewać cudzą skrzynkę. Broni
przed tym **token doręczeniowy**: serwer wydaje go na wartość *oślepioną*, więc
przy wydaniu nie widzi, co wydał, a przy realizacji nie widzi, komu
(`opaque/src/tokeny.rs`). Nadający dowodzi „mam prawo nadać", nie mówiąc
„jestem tym kontem".

Klient sprawdza dowód, że serwer użył swojego opublikowanego klucza. Bez tego
złośliwy serwer **znakowałby** użytkowników — wydawałby każdemu tokeny innym
kluczem i rozpoznawał przy realizacji, czyj był token. Klucz jest dodatkowo
przypinany przy pierwszym pobraniu, więc podstawienie go pod jedną osobę
wymaga zmiany u wszystkich naraz.

Token jest jednorazowy: tabela `spent_tokens` odrzuca powtórzenie atomowo,
kluczem głównym. Nie ma w niej nic o nadawcy i nie może się pojawić.

Czego to **nie** ukrywa: adresu IP nadającego i tego, że w danej chwili ktoś
nadał do konkretnej skrzynki. Zapas tokenów bierze się z góry i rzadko, żeby
uwierzytelnione pobranie nie sąsiadowało w czasie z nadaniem — ale korelacja
po IP zostaje. Na to potrzeba miksowania ruchu, którego nie mamy.

Odbiór jest odwrotnie — **wymaga tokenu i to właściciela skrzynki**. Trasa
`GET /inbox/:userId/connect` nie miała żadnego uwierzytelnienia: ktokolwiek znał
nazwę użytkownika, mógł podłączyć się do cudzej skrzynki i potwierdzeniem
`ack:<id>` skasować koperty, zanim dotarły do właściciela — wiadomość przepadała
bez śladu, a nadawca nie widział błędu. Pilnują tego teraz testy
w `server/test/inbox.test.ts`.

Ukrycie pozostałych metadanych wymagałoby miksowania ruchu i dopełniania.
Poza zakresem wersji 1.

### Chwila odczytu

Potwierdzenia dostarczenia i odczytu są zaszyfrowane, więc serwer nie wie, CO
jest w kopercie. Wie natomiast, **kiedy** koperta poszła — a potwierdzenie
wysłane natychmiast po przeczytaniu byłoby odczytywalne z samego ruchu:
„urządzenie B nadało coś cztery sekundy po wiadomości od A".

Dlatego klienty **zbierają** potwierdzenia i wysyłają je paczką po **losowym**
opóźnieniu do 30 sekund (`web/src/lib/potwierdzenia.ts`,
`android/.../Potwierdzenia.kt`). Losowym, nie stałym: stałe opóźnienie tylko
przesuwa korelację, zamiast ją zrywać. Jedna koperta na wiele wiadomości ukrywa
też, ile ich odczytano.

To **ogranicza** wyciek, a nie usuwa go. Obserwator widzący cały ruch nadal wie,
że w oknie 30 sekund coś poszło. Kto tego nie chce, wyłącza potwierdzenia
odczytu w ustawieniach — wtedy nie wysyła ich wcale (i symetrycznie nie widzi
cudzych). Potwierdzenia **dostarczenia** zostają: powstają przy odbiorze
koperty, więc nie dokładają zdarzenia w innym momencie niż i tak nastąpiło.

Sam ładunek potwierdzenia nie niesie znacznika czasu i test w
`core/src/framing.rs` tego pilnuje — gdyby ktoś go dopisał, opóźnianie wysyłki
przestałoby cokolwiek dawać.

### Adres IP przed rozmówcami

**Połączenie bezpośrednie ujawnia Twoje IP osobie, z którą rozmawiasz.** To
świadoma decyzja projektowa, cena P2P.

Odwrotność klasycznego modelu: serwer pośredniczący akurat ukrywałby IP.
Interfejs musi pokazywać, czy rozmowa idzie bezpośrednio, czy przez relay,
i pozwalać wymusić relay.

### Relaye

Nie mamy przekaźnika dla wiadomości: przy symetrycznym NAT ruch idzie przez
skrzynkę na serwerze, a ta widzi wyłącznie szyfrogram.

Serwery STUN widzą, że dany adres IP zapytał o swój adres publiczny — tyle
samo, co każdy router po drodze. **Nie muszą być zaufane**: gdyby skłamały,
połączenie bezpośrednie po prostu by się nie zestawiło.

TURN Cloudflare, używany wyłącznie do rozmów audio/wideo, widzi IP i wolumen
ruchu obu stron. Nie widzi mediów — te są zaszyfrowane DTLS-SRTP.

### Nietypowe warianty kontenerów

Czyszczenie metadanych obejmuje JPEG, PNG, MP4 i MOV. Plik w wariancie, którego
parser nie rozpozna, **przechodzi bez zmian** — świadomie, bo zablokowanie
wysyłki byłoby gorsze niż dostarczenie pliku z metadanymi. Interfejs mówi
wtedy wprost, że czyszczenie się nie powiodło.

Formaty spoza tej listy (HEIC, WebP, AVI) nie są czyszczone wcale.

### Ile plików i jak dużych

Serwer nie wie, **co** przechowuje, ale wie **ile** i **jak długo**. Bloby
nieodebrane przez 30 dni są kasowane, bo serwer nie ma jak stwierdzić, czy ktoś
jeszcze po nie sięgnie — nie zna treści wiadomości, które się do nich odwołują.

### Dostawcy push

FCM i Web Push to usługi zewnętrzne. Dlatego ładunek powiadomienia jest
**wyłącznie budzący**: bez nadawcy, bez treści, bez identyfikatora grupy.
Klient po wybudzeniu sam pobiera dane.

### Urządzenie przejęte przez atakującego

Kompromitacja urządzenia to koniec gry dla tego urządzenia. Klucze w magazynie
są szyfrowane (Android Keystore / WebAuthn PRF), ale odblokowana aplikacja ma
dostęp do własnej historii. E2EE nie chroni przed atakującym po Twojej stronie
ekranu.

### Kod dostarczany przez przeglądarkę

Klient webowy pobiera kod kryptograficzny przy każdym wejściu. Złośliwy lub
przejęty deploy może wykraść klucze, a użytkownik tego nie zauważy.

To **fundamentalnie słabsza** gwarancja niż w aplikacji natywnej, instalowanej
raz i podpisanej. Ograniczamy ryzyko powtarzalnymi buildami i publikowanymi
hashami, ale nie da się go usunąć. Użytkownik o najwyższych wymaganiach powinien
korzystać z klienta natywnego.

## Przeciwnicy

### Pasywny obserwator sieci

**Powstrzymany co do treści.** Widzi, że ruch istnieje, i szacuje jego wolumen.
Dopełnienie do 256 bajtów zaciera długości wiadomości.

### Złośliwy serwer

**Powstrzymany co do treści.** Nie odczyta wiadomości i nie sfałszuje autora.

Może natomiast: odmówić usługi, opóźniać lub gubić wiadomości ze skrzynki,
zbierać metadane oraz **podmienić key package albo rekord katalogowy**, próbując
podstawić własne urządzenie do grupy.

Ostatni atak wykrywa **safety number** — liczony z kluczy tożsamości
w drzewie MLS, więc podstawienie cudzego urządzenia go zmienia. Kod jest
widoczny w interfejsie przy każdej rozmowie.

Ochrona działa **tylko wtedy, gdy uczestnicy faktycznie porównają kod innym
kanałem** — na żywo, telefonicznie, przez wideo. Porównanie przez sam
komunikator nic nie daje, bo to dokładnie ten kanał, któremu nie ufamy.
Aplikacja może kod pokazać i wytłumaczyć; nie może wymusić porównania.

### Aktywny atakujący w sieci

**Powstrzymany.** Modyfikacja szyfrogramu jest wykrywana (AEAD), a odcisk DTLS
przenoszony kanałem MLS blokuje MITM na rozmowach.

### Członek grupy

**Nie jest powstrzymany i nie może być.** Każdy członek czyta wiadomości grupy
i może je skopiować. Usunięcie odcina go od przyszłych wiadomości (nowa epoka),
ale nie od tych, które już widział.

### Przymus fizyczny

Nie jest w modelu. Brak trybu zaprzeczalnego i ukrytych sejfów.

## Znane ryzyka operacyjne

| Ryzyko | Skutek | Reakcja |
|---|---|---|
| iOS kasuje magazyn PWA po ~7 dniach | Utrata stanu MLS = utrata historii | Wymuszona kolejność onboardingu, `navigator.storage.persist()`, eksport tożsamości, ostrzeżenie przy starcie |
| Utrata wszystkich urządzeń | Trwała utrata historii | Zamierzone. Komunikowane przy rejestracji |
| Rozjazd wersji protokołu | Brak możliwości rozmowy | Wersja w każdej kopercie, jawne odrzucenie nieznanej |
| Wyczerpanie key packages | Nie da się dodać offline'owego urządzenia | Klient uzupełnia zapas przy każdym logowaniu |

## Uwaga implementacyjna: wrogie dane wejściowe

Wszystko, co przychodzi z sieci, jest wrogie z założenia. Parsery mają zwracać
błąd, nigdy panikować.

OpenMLS 0.8 zawiera `debug_assert!(false, "Ciphertext decryption failed")`
w ścieżce deszyfrowania. Dla biblioteki testowanej na poprawnych wektorach to
sensowna asercja; dla komunikatora nie — u nas nieudane deszyfrowanie jest
normalnym skutkiem zmodyfikowanego pakietu. W buildzie release funkcja i tak
zwraca `AeadError`; problemem jest wyłącznie panika w debug, przez którą
pojedynczy wrogi pakiet wywracałby aplikację deweloperską.

Dlatego `Cargo.toml` wyłącza `debug-assertions` **punktowo dla pakietu
`openmls`**, zachowując je w kodzie własnym. Test
`zmodyfikowany_szyfrogram_jest_odrzucany` pilnuje, żeby zachowanie pozostało
poprawne.

## Zgłaszanie podatności

Patrz [`SECURITY.md`](../SECURITY.md).
