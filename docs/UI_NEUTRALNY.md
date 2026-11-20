# System wizualny „Neutralny" — specyfikacja wspólna dla web, Android i iOS

Ten dokument jest **normatywny dla wyglądu**. Zastępuje Nocturne (cyjan jako
linia) i wariant „Mekamb Mobile" (kolorowy akcent jako plama). Każdy klient
implementuje te same role pod tymi samymi nazwami — zmiana wyglądu to zmiana
tokenów tutaj i na trzech platformach, nie dobieranie odcieni od nowa.

## Dlaczego neutralny

Komunikator, którego sednem jest to, *czego nie widać* (szyfrowanie, brak
metadanych), nie potrzebuje marki krzyczącej kolorem. Neutralna skala szarości
(baza „neutral" z shadcn/ui) robi trzy rzeczy naraz:

- kontrast bierze się z jasności, więc działa tak samo w obu motywach i dla osób
  z zaburzeniami widzenia barw;
- kolor zostaje zarezerwowany dla **stanów** (błąd, zweryfikowano, ostrzeżenie) —
  gdy pojawia się czerwień, coś naprawdę jest nie tak;
- trzy platformy łatwiej utrzymać w zgodzie, bo nie ma odcienia akcentu, który
  na każdym ekranie trzeba osobno dostrajać pod kontrast (patrz historia
  `#06B6D4` → `#0891B2` → `#0E7490` w Nocturne).

Odrzucona alternatywa: zostawić akcent jako opcję użytkownika na wszystkich
platformach. Android ją ma (osiem kolorów) i może ją zachować jako preferencję,
ale **domyślny jest „Neutralny"**, a web i iOS na razie nie mają wyboru.

## Główna zasada

**Akcja główna jest wypełniona kolorem `glowny` (prawie czerń w jasnym, prawie
biel w ciemnym). Na ekranie jest najwyżej jedna taka akcja.** Reszta to
przyciski obrysowane (`linia`) albo „duchy" (bez tła, tło `wglebienie` przy
najechaniu). To odwraca zasadę Nocturne świadomie: w neutralnej palecie
obrys nie odróżnia akcji głównej od drugorzędnej, bo nie ma koloru, który
by ją wyróżnił — robi to jasność plamy.

Dymek własnej wiadomości jest wypełniony tym samym `glowny`; dymek rozmówcy
— `wglebienie`. Autor jest rozpoznawalny po jasności, nie po stronie.
**Dlatego w wątku nie ma żadnej innej plamy `glowny`** poza strzałką wysyłania
(która tworzy właśnie taki dymek). Przyciski połączenia, wideo, uczestników są
duchami.

## Tokeny kolorów (role)

| Rola | Jasny | Ciemny | Do czego |
|---|---|---|---|
| `tlo` | `#FFFFFF` | `#0A0A0A` | tło aplikacji |
| `karta` | `#FFFFFF` | `#171717` | karty, panele, arkusze, popovery |
| `wglebienie` | `#F5F5F5` | `#262626` | pola tekstowe, dymek rozmówcy, hover, tor segmentu |
| `wglebienie-mocne` | `#E5E5E5` | `#404040` | wciśnięty stan, aktywny element listy |
| `tekst` | `#0A0A0A` | `#FAFAFA` | tekst główny |
| `tekst-drugi` | `#737373` | `#A3A3A3` | podpisy, podgląd wiadomości, godziny (≥ 4,5:1) |
| `tekst-trzeci` | `#A3A3A3` | `#737373` | wyłącznie dekoracyjne/nieistotne (placeholder) |
| `linia` | `#E5E5E5` | `#FFFFFF1A` (biel 10%) | obramowania, separatory |
| `linia-mocna` | `#D4D4D4` | `#FFFFFF26` (biel 15%) | obramowanie pola z fokusem, przycisk obrysowany |
| `pierscien` | `#A3A3A3` | `#737373` | pierścień fokusu (2px, offset 2px) |
| `glowny` | `#171717` | `#E5E5E5` | akcja główna, dymek własny, znacznik nieprzeczytanych |
| `glowny-tekst` | `#FAFAFA` | `#171717` | tekst na `glowny` |
| `alarm` | `#DC2626` | `#F87171` | błąd, akcja niszcząca (tekst/obrys) |
| `alarm-tlo` | `#FEF2F2` | `#450A0A` | tło komunikatu błędu |
| `sukces` | `#16A34A` | `#4ADE80` | „zweryfikowano", „połączono" |
| `ostrzezenie` | `#D97706` | `#FBBF24` | wersja testowa, niezweryfikowany klucz |
| `nakladka` | `#000000 / 40%` | `#000000 / 60%` | tło pod arkuszem/dialogiem |

Dymki: `babel` = `wglebienie` + `tekst`; `babel-wlasny` = `glowny` + `glowny-tekst`.
Znacznik nieprzeczytanych: `glowny` + `glowny-tekst`, pigułka.

## Typografia

- Web: **Geist** (zmienna, z pakietu `@fontsource-variable/geist`, serwowana z
  własnego originu — CSP nie pozwala na zewnętrzne fonty), mono: Geist Mono dla
  kodów bezpieczeństwa i odcisków.
- iOS: SF Pro (systemowy), SF Mono dla kodów. Android: systemowy (Roboto),
  monospace dla kodów.
- Skala (pt/sp/px): 12 podpis · 13 meta · 15 treść (dymek, lista) · 17 nagłówek
  sekcji/nawigacji · 22 tytuł ekranu · 28 tytuł powitania. Wagi: 400 / 500 / 600.
  Tytuły ekranów 600 z `letter-spacing` −0,02em.

## Kształt i odstępy

- Promienie: `promien-s` 6, `promien-m` 10 (przyciski, pola, karty), `promien-l` 14
  (arkusze, dialogi — górne rogi arkusza 16), `promien-babel` 18, pigułka 999.
- Odstępy: skala 4 — 4, 8, 12, 16, 24, 32. Margines treści 16 na telefonie, 24 na desktopie.
- Cele dotyku ≥ 44×44.
- Cienie: jasny `0 1px 2px #0000000D` dla kart unoszących się (popover, menu,
  toast); ciemny — brak cienia, zamiast niego obrys `linia`.

## Anatomia dymków (bez zmian względem obecnego weba)

Jeden promień dla wszystkich dymków; seria z jednej strony trzymana odstępem
2px, między seriami 12px; ogonek tylko na ostatnim dymku serii. Godzina na
wyśrodkowanym separatorze („Dziś 08:42") przy zmianie dnia i po godzinie ciszy.
Stan doręczenia słowem pod ostatnią własną wiadomością („dostarczono",
„przeczytano"), w `tekst-drugi`, 12.

## Wzorce komponentów i ich odpowiedniki na platformach

| Wzorzec | Web | Android (Compose) | iOS (SwiftUI) |
|---|---|---|---|
| Przyciski: główny / obrysowany / duch / niszczący | shadcn `Button` (warianty `default`/`outline`/`ghost`/`destructive`) | własne `PrzyciskGlowny`/`PrzyciskObrys`/`PrzyciskDuch` na tokenach | własne `ButtonStyle` na tokenach |
| Powiadomienie chwilowe (toast) | **Sonner**, góra-środek na telefonie, dół-prawo na desktopie | własny toast u góry (nie Material `Snackbar`), ten sam wygląd: karta + linia + cień | nakładka u góry, `.transition(.move(edge: .top))` |
| Arkusz od dołu (akcje, załączniki, szczegóły) | **Vaul** `Drawer` na szerokości < 768px; na desktopie Radix `Dialog` | `ModalBottomSheet` z uchwytem, tło `karta` | `.sheet` z `.presentationDetents` i `.presentationDragIndicator(.visible)` |
| Dialog potwierdzenia | Radix `AlertDialog` | `AlertDialog` przestylowany tokenami | `.confirmationDialog` / `.alert` |
| Menu kontekstowe / kebab | Radix `DropdownMenu` / `ContextMenu` | `DropdownMenu` przestylowany | `Menu` / `.contextMenu` |
| Paleta poleceń / szukanie | **cmdk** (`⌘K`/`Ctrl+K`): rozmowy, akcje, ustawienia | pole szukania u góry listy | `.searchable` na liście |
| Liczniki (nieprzeczytane, uczestnicy) | **NumberFlow** | `AnimatedContent` z przesunięciem pionowym | `.contentTransition(.numericText())` |
| Podpowiedź (tooltip) | Radix `Tooltip` | brak (długie przytrzymanie → opis) | brak |
| Przełącznik / segment | Radix `Switch` / `ToggleGroup` | `Switch` / własny segment | `Toggle` / `Picker(.segmented)` |
| Awatar | inicjały na `wglebienie-mocne`, okrąg | to samo | to samo |
| Tło ekranu powitania | delikatny wzór kropek (Magic UI *Dot Pattern*) w `linia` | `Canvas` z kropkami | `Canvas` z kropkami |

Biblioteki „galeryjne" (Magic UI, Aceternity, 21st.dev, Beautiful UI, RareUI)
służą jako źródło **pojedynczych, stonowanych** wzorców kopiowanych do repo
(kropki w tle powitania, delikatny shimmer przy ładowaniu). Żadnych gradientów,
neonów ani animowanych obramowań — to łamałoby neutralność.

## Układ

- **Telefon** (< 768px, oraz Android/iOS): lista rozmów → wątek jako osobny
  ekran ze stosu nawigacji. Dolny pasek: Rozmowy · Ustawienia (iOS `TabView`,
  Android `NavigationBar` przestylowany: aktywna ikona `tekst`, nieaktywna
  `tekst-drugi`, bez kolorowej pigułki).
- **Desktop** (≥ 1024px): trzy kolumny — wąska szyna nawigacji (64) · lista
  rozmów (320) · wątek; panel szczegółów rozmowy (uczestnicy, kod
  bezpieczeństwa) jako czwarta kolumna (360) albo arkusz z prawej.
- Nagłówek wątku: awatar + nazwa + podtytuł (`tekst-drugi`), po prawej duchy:
  połączenie, wideo, szczegóły.
- Pole pisania: `wglebienie`, promień 20, bez obramowania; obok strzałka
  wysyłania jako okrąg `glowny` 36×36 (jedyna plama w wątku).

## Ruch

150 ms dla stanów (hover, wciśnięcie), 250 ms dla wejść (arkusz, toast),
krzywa `cubic-bezier(0.32, 0.72, 0, 1)` (jak w Vaul). `prefers-reduced-motion` /
„Ogranicz ruch" wyłącza przesunięcia, zostawia przenikanie.
