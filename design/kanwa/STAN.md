# Stan kanwy

Ten plik mówi, na ile kanwa opisuje aplikację, która naprawdę stoi w repozytorium.
Bez niego pół‑zaktualizowana kanwa jest gorsza niż jawnie przestarzała: opisuje
kontrolki, których nie ma, i nikt nie wie, której części wolno ufać.

Aktualizacja z września 2026. Źródłem prawdy jest `web/src/styles.css` (plus
`web/src/lib/akcent.ts` dla palety akcentów) — kanwa nadąża za arkuszem, nigdy
odwrotnie.

## Przemalowane na aktualny język

Wszystkie sześć artboardów:

| plik | co pokazuje | motyw |
|---|---|---|
| `ListaJasna.dc.html` | lista rozmów na telefonie | jasny (domyślny) |
| `WatekJasny.dc.html` | wątek na telefonie | jasny (domyślny) |
| `Lista.dc.html` | lista rozmów na telefonie | ciemny |
| `Main.dc.html` | wątek na telefonie | ciemny |
| `Desktop.dc.html` | układ trzech paneli, 1440 px | ciemny |
| `Elementy.dc.html` | arkusz elementów: dymki, stany, kompozytor, wiersz listy, tokeny, przyciski, pole, przełącznik, segmenty, akcent | ciemny |

Co się w nich zmieniło względem poprzedniej wersji:

* **Akcent jest wypełnieniem, nie linią.** Znak firmowy, akcja główna i znacznik
  nieprzeczytanych to plamy koloru; wybrany wiersz i aktywna zakładka to pigułki
  podbarwione `--akcent-tlo`. Poprzednia kanwa trzymała obrys i wprost to
  zapisywała w adnotacji — ta reguła została odwrócona i adnotacja też.
* **Markowy cyjan (`#06B6D4` / `#0E7490`) zniknął.** Jest para systemowa iOS:
  `#007AFF` w jasnym, `#0A84FF` w ciemnym. Awatar przestał być obrysowanym
  kółkiem w kolorze marki — to szare kółko z białym inicjałem (`--awatar-tlo`).
* **Neutralne odcienie są z arkusza,** nie ciepłoszare z poprzedniej palety:
  `#000/#1C1C1E/#26262A/#8E8E93` w ciemnym, `#FFF/#F2F2F7/#E9E9EB/#6C6C70`
  w jasnym.
* **Jasny motyw jest pierwszy na kanwie,** bo jest domyślny na obu klientach.
* **Promienie rozdzielone:** pole 10 px, przycisk 12 px, dymek 18 px, wiersz
  listy i karta 14 px. Arkusz elementów pokazuje pole i przycisk obok siebie
  właśnie po to, żeby ta różnica była widoczna, a nie deklarowana.
* **Stan wysyłki jest słowem bez godziny** („Dostarczono", „Przeczytano",
  „Wysyłam", „Nie wysłano") — dokładnie tak, jak zwraca `opisStanu`
  w `web/src/lib/potwierdzenia.ts`. Wcześniej kanwa pisała „Przeczytano 21:20",
  czego klient nie robi: godzina jest wyłącznie na rozdzielaczu.
* **Krój systemowy zamiast Inter** — komunikator ma wyglądać jak reszta telefonu.
* **Wiersz listy stracił kreskę pod spodem,** bo arkusz jej nie rysuje: rozmowy
  rozdziela odstęp i awatar.
* **Nagłówek wątku i listwa pisania nie mają własnego tła.** Token `--pasek`
  istnieje w arkuszu, ale nic nim nie maluje — oba paski stoją na tle strony
  i odcina je sama linia. Dlatego wypadł też z legendy artboardów wątku.

## Czego kanwa nadal NIE pokazuje

To są luki świadome, nie przeoczenia. Każda wymaga osobnej decyzji projektowej,
a nie przemalowania:

1. **Ekranów wejścia nie ma w ogóle.** Zakładanie konta, logowanie, kopia
   zapasowa, parowanie urządzenia, ekran Konta, kod bezpieczeństwa i inspektor
   uczestników istnieją w kliencie i nie mają artboardu. Handoff, z którego
   powstał restyling weba (`Mekamb Web.dc.html`), nigdy nie trafił do repo —
   te ekrany trzeba narysować od zera, razem z ich dwujęzycznymi nagłówkami
   („Załóż konto · Create account"), a to jest robota projektowa, nie
   odświeżenie kolorów.
2. **Desktop jest tylko ciemny,** choć domyślny motyw jest jasny. Jasny wariant
   układu trzech paneli trzeba dorysować; ciemny został, bo to on istniał.
3. **Brakuje stanów pobocznych:** pusty wątek, pusta lista, modal potwierdzenia
   usunięcia, gest przeciągnięcia wiersza z koszem, kebab na desktopie, pasek
   błędu, nakładka zdjęcia na pełny ekran, przełącznik PL/EN. Arkusz elementów
   pokazuje kontrolki, nie wszystkie sytuacje.
4. **Androida kanwa nie opisuje.** Artboardy odwzorowują klienta webowego.
   Znana różnica telefonu: godzina siedzi WEWNĄTRZ dymka, nie ma wyśrodkowanego
   rozdzielacza ani reguły „godzina ciszy". Paleta akcentów jest już wspólna —
   obie strony zalewają przyciemnionym odcieniem (`fill` / `wypelnienie`), więc
   dawny rozjazd kontrastu zniknął. Osobne artboardy dla Androida to mimo to
   osobna decyzja.
5. **Pole szukania w jasnym motywie jest białe na białym.** Arkusz daje mu
   `background: var(--pole)` bez obrysu, a w jasnym motywie `--pole` to biel —
   więc w `ListaJasna.dc.html` widać samą lupę i podpowiedź. Kanwa pokazuje
   STAN FAKTYCZNY, nie poprawkę. Jeżeli to ma być wgłębienie (`#F2F2F7`) albo
   pole z linią, decyzja zapada w arkuszu i wtedy wraca tutaj.
6. **`design/ikony.mjs` ma nieaktualny opis** ikony `ksiezyc`: „Motyw ciemny —
   domyślny w tym systemie". Domyślny jest jasny. Poprawka wymaga
   przegenerowania `web/src/Ikony.tsx` i `android/.../Ikony.kt`
   (`node design/generuj.mjs`), więc nie robimy jej przy okazji kanwy.
7. **Zdjęcie w wątku jest atrapą** — szarym gradientem z ikoną, nie prawdziwym
   kadrem. Wystarcza, żeby pokazać, że obraz JEST dymkiem (ramka 4 px), i nic
   więcej nie obiecuje.

## Zasada

Zmieniasz `web/src/styles.css` albo `PALETA_AKCENTOW` — zmień artboardy w tym
samym kroku i dopisz tu, czego nie zdążyłeś. Kanwa opisująca nieistniejące
kontrolki kosztuje więcej, niż jest warta.
