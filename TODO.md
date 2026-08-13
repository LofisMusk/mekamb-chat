# TODO

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

## Nadal nieruszone

- Push notifications (wymaga `google-services.json`). Usługa pierwszoplanowa
  pokrywa ten sam przypadek kosztem baterii i bez oddawania metadanych Google.
- Skanowanie kodów QR aparatem w aplikacji na Androidzie — kod zeskanowany
  aparatem systemowym przychodzi intencją `mekamb://`.
- Potwierdzenia w rozmowie grupowej idą tylko do pierwszego uczestnika
  (`sendReceipt(..., odbiorca)` w `ChatViewModel`). W rozmowie dwuosobowej
  to bez znaczenia, w grupowej ptaszek zobaczy jedna osoba.
