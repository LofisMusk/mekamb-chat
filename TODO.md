# TODO

## Znalezione usterki (przegląd kodu, 2026-08-23)

Wszystkie testy przechodzą — `cargo test` (163), `npm test` w `server/` (118),
`npm test` w `web/` (195, dwa pliki nie startują bez zbudowanego WASM) oraz
`cargo clippy` bez ostrzeżeń. Poniższe usterki znalazł przegląd kodu, nie
testy; przy każdej napisane, czym objawia się dla użytkownika, bo prawie
wszystkie **milczą**.

Cztery pierwsze były sprawdzone doświadczalnie testem jednorazowym
(na `workerd`, przez `SELF.fetch` i przez RPC do Durable Objectu), nie tylko
odczytane z kodu.

---

### 1. Kursor skrzynki jest znacznikiem wysokiej wody — pominięta koperta przepada

`server/src/inbox.ts:232` (`flushTo`: `WHERE id > ?`),
`inbox.ts:324` (`MAX(...)`), `inbox.ts:358` (`DELETE FROM queue WHERE id <= ?`)

Klient potwierdza koperty **pojedynczo i nie po kolei**: koperta, której nie
udało się przetworzyć, zostaje nietknięta do ponowienia, a następna — jeśli
przeszła — jest potwierdzana od razu (`web/src/lib/koperty.ts`,
`android/.../Skrzynka.kt:146`). Serwer tymczasem trzyma jedną liczbę na
urządzenie i podnosi ją do `MAX`, a wysyła tylko `id > kursor`. Potwierdzenie
koperty 2 przeskakuje więc kopertę 1 **na zawsze** i dodatkowo kasuje ją
z kolejki dla wszystkich.

Sprawdzone: po `deposit` A (id 1), `deposit` B (id 2) i `acknowledge(2,
"telefon")` — `pendingCountFor("telefon")` daje `0`, a `pendingCount()` daje
`0`. Koperta 1 nie wróci już nigdy.

Skutkiem jest to, że **cała polityka ponawiania z `koperty.ts` i `Skrzynka.kt`
nie działa** — a jej jedynym powodem było to, że koperta potrafi wyprzedzić
commit, który jest jej potrzebny. Zgubiony w ten sposób commit albo welcome to
dokładnie awaria opisana w CLAUDE.md: urządzenie nie dołącza do grupy, nic się
nie odszyfrowuje, nadawca nie widzi błędu.

Do zrobienia: kursor musi przestać być jedną liczbą. Albo tabela
przeczytanych identyfikatorów na urządzenie (`device_reads`, jak mówi
CLAUDE.md), albo kursor plus zbiór dziur poniżej niego. Test regresyjny
w `server/test/inbox.test.ts`: potwierdzenie nowszej koperty **nie może**
usunąć starszej niepotwierdzonej.

### 2. Zalogowane konto nadpisuje wpis cudzego urządzenia w katalogu

`server/src/directory.ts:265` — `ON CONFLICT(id) DO UPDATE` bez warunku na
`user_id`; trasa `POST /devices` w `server/src/index.ts:110`

`registerDevice` bierze właściciela z tokenu (i słusznie), ale przy konflikcie
klucza aktualizuje wiersz **niezależnie od tego, czyj on jest**. Identyfikatory
urządzeń są jawne: `GET /directory/:username` wydaje je bez uwierzytelnienia
każdemu.

Sprawdzone: napastnik z ważnym tokenem własnego konta wysyła `POST /devices`
z `deviceId` ofiary — odpowiedź `200`, `user_id` w wierszu bez zmian, ale
`transport_key` i `transport_addresses` już jego.

Skutek: ruch, który miał iść wprost do telefonu ofiary, idzie pod adres
napastnika. Treści to nie odsłania (MLS), ale dostarczenie **udaje się**, więc
zapasowa droga przez skrzynkę nie włącza się wcale — wiadomości znikają bez
błędu — a napastnik dowiaduje się, kto do ofiary pisze i kiedy. To jest ta
sama dziura, którą przy key packages załatało `urzadzenieNalezyDo`
(`directory.ts:160`), tylko w sąsiedniej trasie.

Do zrobienia: `... DO UPDATE SET ... WHERE devices.user_id = excluded.user_id`,
albo sprawdzenie `urzadzenieNalezyDo` przed zapisem, gdy wiersz już istnieje.

### 3. Podpis rekordu adresowego nie jest ani składany, ani sprawdzany

`server/src/index.ts:77` („**Klient musi zweryfikować podpis**"),
`server/src/directory.ts:6`

Kolumna `addr_signature` istnieje, komentarze w dwóch miejscach opisują ją jako
jedyny powód, dla którego serwer nie musi być zaufanym źródłem adresów —
a `grep` po `addrSignature` w `web/src/` i `android/app/src/main/` **nie
znajduje ani jednego użycia**. Android czyta z odpowiedzi katalogu wyłącznie
`transportKey` i `transportAddresses` (`Api.kt:220-228`) i podaje je wprost do
`tryDirectDelivery` (`Messenger.kt:641`). Żaden klient tego pola też nie wysyła
przy rejestracji (`Api.kt:171`, `web/src/lib/messenger.ts:228`).

Czyli deklarowana ochrona przed podstawieniem adresu przez serwer nie istnieje
nigdzie poza komentarzem — i to ona miała ograniczać skutki usterki nr 2.

Do zrobienia: podpisywać rekord adresowy kluczem MLS urządzenia w rdzeniu
(`core`, przez oba bindingi — to materiał kryptograficzny) i odrzucać
w kliencie rekord bez pasującego podpisu. Do tego czasu zapisać w
`docs/THREAT_MODEL.md`, że adresy transportowe pochodzą od serwera na wiarę.

### 4. `POST /auth/logout` kasuje cudzą trwałą sesję bez żadnego uwierzytelnienia

`server/src/auth.ts:447`

Trasa nie ma `requireAuth`, nie sprawdza tokenu odświeżającego i kasuje
`refresh_tokens WHERE device_id = ?` po samym identyfikatorze z ciała żądania.
Android nawet **wysyła** ten token (`Api.kt:159`), tylko serwer go nie czyta.

Sprawdzone: `POST /auth/logout` z samym `deviceId`, bez nagłówków — `200`,
wiersz skasowany.

Identyfikatory urządzeń są jawne (`GET /directory/:username`), więc jest to
celowane wylogowywanie dowolnej osoby: przy każdym starcie aplikacji zamiast
cichego odświeżenia sesji dostaje pełne OPAQUE + TOTP.

Do zrobienia: kasować wiersz dopiero po dopasowaniu `token_hash` z ciała
żądania albo z ciasteczka — tak samo jak robi to `/auth/refresh:415`.

### 5. `POST /internal/rate-limit/:key` jest publiczny i jest martwym kodem

`server/src/index.ts:418`

Nazwa mówi „internal", ale to zwykła trasa Hono bez `requireAuth` — a jedyny
globalny middleware to CORS, który nie dotyczy `curl`-a. Kubełki mają
przewidywalne klucze: `login:<nazwa>`, `totp:<loginId>`, `refresh:<deviceId>`
(`auth.ts:215,313,412`).

Sprawdzone: sześć nieuwierzytelnionych żądań pod `login:ofiara-x` i kolejne
dostaje `429`. Pojemność to 5, uzupełnianie 1 na 30 s — utrzymanie blokady
kosztuje dwa żądania na minutę.

Przy okazji: **nikt tej trasy nie woła.** `auth.ts:70` i `webauthn.ts:57`
sięgają do Durable Objectu wprost przez binding. Trasa jest pozostałością.

Do zrobienia: usunąć trasę razem z `LOGIN_BUCKET` w `index.ts:70` (kopia tej
z `auth.ts:52`).

### 6. Włączenie tokenów doręczeniowych zerwie zmiany składu grupy

`web/src/lib/messenger.ts:416` i `:422`,
`android/.../Messenger.kt:306`

`DELIVERY_TOKEN_REQUIRED=true` sprawia, że `POST /inbox/:userId` bez nagłówka
odpowiada `401` (`index.ts:335`). Zwykłe wiadomości token dostają
(`messenger.ts:586`, `Messenger.kt:650`), ale rozsyłka commitu — nie. W webie
nie dostaje go także **welcome** (`:422`), bo idzie osobnym wywołaniem, a nie
przez `wyslij`, jak na Androidzie.

Skutek po włączeniu wymuszania: dodanie kogokolwiek do rozmowy i usunięcie
urządzenia kończą się błędem, a w webie zaproszenie nie dochodzi w ogóle —
znowu awaria „welcome nigdy nie dotarł" z CLAUDE.md. Dziś nie widać tego
wcale, bo wymuszanie jest wyłączone; zobaczy to dopiero ten, kto je włączy.

Do zrobienia: przepuścić obie ścieżki przez to samo miejsce co zwykłą
wiadomość (`rozeslij` / `wyslij`), żeby token brał się z jednego kodu. Test
z `DELIVERY_TOKEN_REQUIRED=true` przechodzący pełne dodanie członka.

### 7. Web: gniazdo skrzynki otwiera się, zanim rozmowy zostaną otwarte

`web/src/Czat.tsx:518` (efekt łączenia) kontra `web/src/Czat.tsx:578`
(`listaRozmow().then(... otworzZnaneRozmowy ...)`)

React wykonuje efekty w kolejności deklaracji, więc połączenie rusza pierwsze,
a lista rozmów wczytuje się z IndexedDB równolegle. Koperta z zaległości, która
dotrze w tym oknie, nie dopasuje się do żadnej otwartej rozmowy —
`matchEnvelope` zwraca `null`, `handleEnvelope` zwraca `null`
(`messenger.ts:757`), a `obsluzKoperte` traktuje `null` jak **sukces**
i potwierdza (`Czat.tsx:446`). Koperta znika bezpowrotnie.

Android robi to odwrotnie i poprawnie: `otworzZnaneRozmowy` przed
`Rdzen.podepnij` (`ChatViewModel.kt:376` i `:682`) — z komentarzem mówiącym
dokładnie, dlaczego kolejność jest istotna.

Do zrobienia: otworzyć znane rozmowy, zanim powstanie połączenie (jeden efekt
albo brama na stanie). Przy okazji warto rozdzielić „koperta nie dla mnie" od
„jeszcze nie umiem jej dopasować" — dziś oba znaczą `null` i oba kończą się
potwierdzeniem.

### 8. Identyfikator urządzenia z zapytania przeżywa, gdy token go nie niesie

`server/src/index.ts:397-400`

Komentarz mówi: „Identyfikator urządzenia bierzemy z PODPISANEGO tokenu, nigdy
z zapytania". Kod ustawia parametr **tylko wtedy**, gdy `payload.deviceId` nie
jest puste, a adres pochodzi z `new URL(c.req.url)` — czyli razem z tym, co
przysłał klient. Token bez urządzenia powstaje normalną drogą:
`auth.ts:364` ma `deviceId: body.deviceId ?? null`.

Podszycie ogranicza się do własnej skrzynki (kontrola właściciela
z `index.ts:385` zostaje), ale to wystarczy, żeby przesunąć kursor **innego
swojego urządzenia** i zabrać mu zaległości — a przy `urzadzenie === null`
potwierdzenie wraca do dawnego `DELETE` (`inbox.ts:314`) i kasuje kopertę
wszystkim urządzeniom konta.

Do zrobienia: `adres.searchParams.delete("urzadzenie")` bezwarunkowo, dopiero
potem `set` z tokenu.

### 9. Android: potwierdzenia w grupie idą do jednego uczestnika

`android/.../ChatViewModel.kt:275` — `sendReceipt(..., odbiorca)`

Przeniesione z sekcji „Nadal nieruszone" poniżej, bo to usterka, a nie brak
funkcji. Web wysyła potwierdzenie do wszystkich skrzynek rozmowy
(`messenger.ts:807` przez `rozeslij`), Android do pierwszego uczestnika.
W rozmowie dwuosobowej bez znaczenia, w grupowej ptaszek zmienia się jednej
osobie.

### 10. Podtrzymanie nie wykrywa martwego gniazda

`web/src/lib/polaczenie.ts:121`, `android/.../Skrzynka.kt:269`

Obie strony wysyłają `ping` co 30 s, ale **żadna nie sprawdza, czy przyszedł
`pong`**. `socket.send` na gnieździe, którego druga strona już nie istnieje,
kończy się powodzeniem — bajty trafiają do bufora. Połączenie w połowie
zerwane (uśpiony NAT, przełączenie sieci bez `close`) nie wywoła więc ani
`onclose`, ani `onFailure`, a ponowienie wisi na tych zdarzeniach. Objaw:
„wiadomości przychodzą dopiero po przeładowaniu" — dokładnie to, co ten moduł
miał naprawić.

Do zrobienia: licznik nieodebranych `pong` i jawne `close()` po dwóch–trzech.

### 11. Service worker trzyma niezahaszowane zasoby bez terminu ważności

`web/public/sw.js:76`

Dokument idzie z sieci i to jest naprawione. Ale druga gałąź jest
„najpierw dysk" dla **wszystkich** pozostałych zasobów z własnego origin, nie
tylko tych z haszem w nazwie — a `web/public/manifest.webmanifest` hasza nie
ma. Raz zapisany zostaje do ręcznej zmiany `CACHE` (`sw.js:14`). Skutek jest
drobny (ikony, nazwa aplikacji przy instalacji), ale to ten sam mechanizm, co
przy `index.html`.

Do zrobienia: „najpierw dysk" zawęzić do ścieżek z haszem (`/assets/`),
resztę obsłużyć „z sieci, dysk jako zapas".

---


## Zrobione na gałęzi `todo-fixes`

UI:
    Android:
        - [x] aplikacja traciła połączenie z serwerem po zamknięciu
              → klient przeniesiony do `Rdzen` (żyje z procesem), a `UslugaNasluchu`
                (pierwszoplanowa) trzyma proces przy życiu. To NIE jest push —
                push wymaga przepuszczenia sygnału przez serwery Google.

        - [x] dzwonienie crashowało aplikację
              → `EglBase.create()` wykonywało się przed
                `PeerConnectionFactory.initialize`, czyli przed załadowaniem
                biblioteki natywnej. Dodatkowo zestawienie rozmowy jest
                w `runCatching`: zajęty mikrofon ma być komunikatem, nie awarią.

        - [x] baner dzwonienia i powiadomienia o wiadomościach
              → trzy kanały (wiadomości / połączenia / działanie w tle), dzwonek
                z `res/raw/mekamb_ring.mp3`, baner przez `setFullScreenIntent`.
                W powiadomieniu NIE MA treści wiadomości — widać je na
                zablokowanym ekranie.

    iOS:
        - [x] webapp wypychała treść w górę przy pisaniu
              → `position: fixed` nie wystarcza: Safari samo przewija widok
                układu, żeby wsunąć pole nad klawiaturę. Powłoka wraca na zero
                przy każdym drgnięciu widoku (`lib/okno.ts`). Powiększenie
                szczypaniem zostaje nietknięte.

        - [x] margines za duży, niedopasowany do telefonu
              → margines zszedł z powłoki na panele i skaluje się szerokością
                ekranu (`--margines-tresci`, `clamp` na `vw`). Tła pasków sięgają
                teraz krawędzi, odsunięty jest sam tekst.

    General:
        - [x] znaczki pokazywały tylko „wysłane"
              → Android: zegar potwierdzeń czekał w `viewModelScope` przez losowe
                3–30 s, więc odłożenie telefonu anulowało wysyłkę PRZED nadaniem;
                teraz czeka w zakresie procesu. Web: potwierdzenie do rozmowy
                spoza ekranu przepadało — teraz trafia na dysk.

        - [x] teksty w języku deweloperów
              → z ustawień wyglądu zniknął cały opis, z potwierdzeń odczytu
                zostało jedno zdanie (to, które zmienia decyzję). „Trwały
                magazyn", „koperta", „Notifications & transport" i dwujęzyczne
                doklejki zniknęły. Zostały ostrzeżenia, po których da się zrobić
                coś inaczej.

        - [x] ekran dzwonienia nałożony na czat
              → rozmowa jest osobnym ekranem ponad układem. Przy okazji: jako
                pasek w wątku pojawiała się tylko w otwartej rozmowie, więc
                telefon dzwoniący podczas czytania innego wątku nie dzwonił nigdzie.

        - [x] dzwonienie nie działało
              → ta sama usterka w obu klientach: sygnały przychodzące PRZED
                odebraniem były wyrzucane. Dzwoniący nadaje kandydatów ICE zaraz
                po złożeniu oferty, czyli przez całe dzwonienie — wszyscy oni
                przepadali, a po odebraniu zostawało połączenie znające adresy
                jednej strony. Teraz czekają w kolejce.

        - [x] przycisk zgłaszania błędów → issues na GitHubie
              → przez serwer (`server/src/zgloszenia.ts`), bo token GitHuba
                w kliencie jest tokenem oddanym każdemu. Treść składa SERWER
                z dwóch pól — nazwa użytkownika, identyfikator urządzenia
                i cokolwiek z rozmów nie mają jak tam trafić. Test to sprawdza.

## Do włączenia przed użyciem zgłoszeń

Zgłoszenia wymagają sekretu na Workerze — bez niego przycisk mówi wprost,
że na tym serwerze nie działają, zamiast udawać, że coś wysłał:

```bash
cd server
npx wrangler secret put GITHUB_TOKEN     # uprawnienie: zapis do issues w TYM repozytorium
# opcjonalnie, gdy repozytorium ma być inne niż LofisMusk/mekamb-chat:
npx wrangler secret put GITHUB_REPO
```

Token o szerszym zakresie daje przy tym samym pożytku dostęp do kodu.

## Do włączenia, żeby backend wdrażał się sam

Zgłoszenie #18 („nie da się dodać kontaktu") nie było usterką w kodzie: pod
`API_URL` stał Worker starszy niż klienci i odrzucał zajęcie epoki, bo wymagał
listy członków, której klienci — po przeniesieniu rozsyłki do nadawcy — już nie
wysyłają. Klient webowy wdraża się sam przy każdym scaleniu, APK powstaje przy
etykiecie, a Worker szedł na produkcję tylko wtedy, gdy ktoś pamiętał.

Nowy przebieg `deploy-server.yml` robi to przy każdym scaleniu do `main`, ale
potrzebuje sekretu (Settings → Secrets and variables → Actions):

```bash
CLOUDFLARE_API_TOKEN     # szablon „Edit Cloudflare Workers" + uprawnienie do D1
CLOUDFLARE_ACCOUNT_ID    # tylko gdy konto ma dostęp do kilku kont Cloudflare
```

Zanim to nastąpi, produkcję odblokowuje ręczne wdrożenie:

```bash
cd server
npx wrangler d1 migrations apply mekamb --remote   # najpierw baza: nowy kod czyta spent_tokens
npx wrangler deploy
```

Sprawdzenie, czy pod adresem stoi aktualna wersja — `404` znaczy stary Worker:

```bash
curl -s -o /dev/null -w '%{http_code}\n' https://mekamb.grubyogon10.workers.dev/tokens/key
```

## Nadal nieruszone

- Push notifications (wymaga `google-services.json`). Usługa pierwszoplanowa
  pokrywa ten sam przypadek kosztem baterii i bez oddawania metadanych Google.
- Skanowanie kodów QR aparatem w aplikacji na Androidzie — kod zeskanowany
  aparatem systemowym przychodzi intencją `mekamb://`.
- Potwierdzenia w rozmowie grupowej idą tylko do pierwszego uczestnika —
  przeniesione wyżej, do usterki nr 9: to nie brak funkcji, tylko rozjazd
  między klientami przy tej samej obietnicy w interfejsie.
