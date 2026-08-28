# TODO — zrobione

Wszystkie punkty wdrożone na obu klientach (web = klient wiodący; Android =
parytet, gdzie funkcja ma sens na telefonie). Web: typecheck + 230 testów +
`vite build` przechodzą. Android: `compileDebugKotlin` + `testDebugUnitTest`
przechodzą.

1. ✅ **Opuszczanie grup.** Rdzeń miał `opuscGrupe` (propozycja SelfRemove) już
   wcześniej — brakowało wejścia w interfejsie. Web: przycisk „Opuść grupę" w
   panelu uczestników (tylko grupy) + potwierdzenie. Android: to samo w
   `EkranUczestnikow` + `AlertDialog`.

2. ✅ **Glitch UI.** Menu kebaba na liście rozmów było przycinane przez
   `overflow: hidden` wiersza (potrzebne dla gestu przeciągnięcia). Otwarte menu
   dostaje teraz `overflow: visible` i wyższy `z-index`
   (`.pozycja-rozmowy.menu-otwarte`). Dotyczy tylko weba.

3. ✅ **Blokowanie użytkowników.** Nowy lokalny, zaszyfrowany moduł blokad
   (`blokady.ts` / `Blokady.kt`). Blokada po nazwie użytkownika: odsiewa
   wiadomości i zaproszenia zablokowanego, ukrywa DM/grupę złożoną z samych
   zablokowanych. Blokada przy osobie w panelu uczestników; odblokowanie w
   ustawieniach konta (jedyne miejsce, bo DM się chowa).

4. ✅ **Znikające wiadomości (custom, domyślnie wyłączone).** Nowy moduł
   (`znikanie.ts` / `Znikanie.kt`): retencja LOKALNA per rozmowa — presety +
   własny czas, zamiatanie co minutę i przy zmianie ustawienia. Świadomie nie
   kasuje rozmówcy (historia żyje u każdego osobno) — opisane wprost w panelu.

5. ✅ **Dodawanie osób do istniejących grup.** Web: „Dodaj osobę" w panelu
   uczestników → `addMember`. Android: `dodajCzlonka` był już w
   `EkranUczestnikow`.

6. ✅ **Kliknięcie w zdjęcie → pełny ekran.** Web: nakładka (lightbox) w
   `Zalacznik.tsx`. Android: `Dialog` na pełny ekran w `PodgladZalacznika`.

7. ✅ **Ctrl+V zdjęcia → załącz i wyślij.** Web: `onPaste` w polu pisania
   wyławia obraz ze schowka i wysyła go tą samą drogą co spinacz (`wyslijPlik`).
   Na Androidzie ten idiom nie występuje — załączniki idą przez arkusz.
