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
| Media rozmów | WebRTC P2P, odcisk DTLS uwierzytelniony przez MLS |
| Historia rozmów | Tylko na urządzeniach. Serwer nie ma czego wydać ani zgubić |
| Tożsamość nadawcy | Credential MLS weryfikowany kryptograficznie |
| Hasło | OPAQUE — serwer nie widzi go nawet w pamięci |
| Wsteczna poufność | Ratchet MLS: przejęcie klucza nie odsłania wcześniejszych wiadomości |
| Przyszła poufność | Aktualizacje epok odcinają atakującego po usunięciu z grupy |

## Czego NIE chronimy

Ta lista jest ważniejsza od poprzedniej.

### Metadane

Serwer widzi i może logować:

- kto ma konto i kiedy się loguje,
- które urządzenia należą do którego użytkownika,
- kto jest członkiem której grupy (przez commity),
- kiedy i ile bajtów trafia do skrzynki offline,
- **rozmiar każdego załącznika**.

Ostatni punkt jest istotniejszy, niż wygląda: sam rozmiar sporo mówi o rodzaju
pliku — zdjęcie z telefonu, zrzut ekranu i krótkie wideo mają wyraźnie różne
rzędy wielkości. Ukrycie tego wymagałoby dopełniania plików do stałych progów,
co przy wideo oznaczałoby przesyłanie wielokrotnie większej ilości danych.
Świadomie tego nie robimy.

Serwer **nie** widzi treści ani — przy działającym P2P — samych wiadomości.

Ukrycie metadanych wymagałoby sealed sender albo miksowania ruchu. Poza
zakresem wersji 1.

### Adres IP przed rozmówcami

**Połączenie bezpośrednie ujawnia Twoje IP osobie, z którą rozmawiasz.** To
świadoma decyzja projektowa, cena P2P.

Odwrotność klasycznego modelu: serwer pośredniczący akurat ukrywałby IP.
Interfejs musi pokazywać, czy rozmowa idzie bezpośrednio, czy przez relay,
i pozwalać wymusić relay.

### Relaye

Relay iroh (publiczne n0 albo TURN Cloudflare) widzi IP i wzorce ruchu obu
stron. Nie widzi treści — wiadomości są zaszyfrowane MLS **pod** szyfrowaniem
QUIC/TLS.

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
