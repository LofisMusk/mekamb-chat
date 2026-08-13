/**
 * Rzeczywista wysokość widoku, z klawiaturą włącznie.
 *
 * # Dlaczego `100dvh` nie wystarcza
 *
 * `dvh` rozwiązuje jeden problem — chowający się pasek adresu — i o klawiaturze
 * nie wie nic. Na iOS otwarcie klawiatury nie zmienia ani `dvh`, ani `svh`:
 * zmniejsza się wyłącznie `visualViewport`, a układ strony zostaje taki, jaki
 * był. Powłoka czatu wysoka na `100dvh` chowa więc dolne 300 px pod klawiaturą,
 * a że nic się nie przewija, pole pisania po prostu znika w chwili, w której
 * zaczyna się go używać.
 *
 * Dlatego wysokość jest tokenem (`--wysokosc-okna`), a nie stałą: arkusz mówi,
 * co z niej wynika, a ten moduł podaje liczbę.
 *
 * # Dlaczego nie ma tego w komponencie
 *
 * Bo dotyczy `<html>`, a nie żadnego poddrzewa Reacta — tak samo jak motyw
 * (`motyw.ts`). Zdarzenia `visualViewport` sypią się przy każdej klatce
 * przewijania i przerysowywanie przez nie drzewa Reacta byłoby płaceniem
 * kilkuset renderów za jedną liczbę w CSS.
 */

/** Nazwa tokenu, którego używa arkusz. */
const TOKEN = "--wysokosc-okna";

/**
 * Ustawia token i pilnuje go do odwołania.
 *
 * Zwraca funkcję odpinającą. Bez `visualViewport` (starsze przeglądarki,
 * środowisko testowe) nie robi nic i zostawia `100dvh` z arkusza — to gorsze
 * przybliżenie, ale nigdy nie jest WIĘKSZE niż ekran, więc najwyżej zostaje
 * pasek tła, a nie treść pod krawędzią.
 *
 * # Dlaczego to jeszcze COFA przewinięcie
 *
 * Bo `position: fixed` na `body` nie wystarcza na iOS. Wchodząc w pole tekstowe
 * Safari samo przewija **widok układu**, żeby wsunąć pole nad klawiaturę —
 * i robi to niezależnie od tego, czy dokument ma obszar przewijania, czy nie.
 * Powłoka przypięta do widoku jedzie razem z nim.
 *
 * Widać było dokładnie to: po dotknięciu pola pisania cała aplikacja uciekała
 * w górę. Pasek zakładek (Rozmowy · Kontakty · Konto), który należy do DOŁU
 * ekranu, lądował pod paskiem stanu, a w miejscu rozmowy zostawał czarny
 * prostokąt. Wiadomości nie było gdzie przeczytać w chwili, w której się na nie
 * odpisuje.
 *
 * Więc przy każdym drgnięciu widoku wracamy na zero. To jedyny moment, w którym
 * wolno tak zrobić: skoro powłoka ma dokładnie wysokość widoku wizualnego, nie
 * ma NIC, do czego trzeba by przewinąć — każde przewinięcie jest tu z definicji
 * cudzą decyzją, a nie użytkownika.
 *
 * Powiększenie szczypaniem jest wyjątkiem i zostaje nietknięte: wtedy
 * przewijanie jest jedynym sposobem obejrzenia strony, a odbieranie go byłoby
 * odbieraniem dostępności komuś, kto z niej korzysta.
 */
export function pilnujWysokosci(okno: Window = window): () => void {
  const widok = okno.visualViewport;
  if (!widok) return () => {};

  const korzen = okno.document.documentElement;

  const odswiez = () => {
    /*
     * Sama `height`, bez doliczania `offsetTop`.
     *
     * `offsetTop` mówi, o ile widok wizualny jest przesunięty w obrębie widoku
     * układu. Doliczanie go dawałoby powłokę WYŻSZĄ niż ekran — czyli wracałoby
     * dokładnie do usterki, przez którą pole pisania schodziło pod krawędź.
     */
    korzen.style.setProperty(TOKEN, `${widok.height}px`);

    /*
     * Skala mówi, czy to Safari przewinęło, czy użytkownik powiększył.
     *
     * Przy `scale === 1` strona jest w naturalnym powiększeniu i nie ma czego
     * przewijać: każde przesunięcie jest wtedy tym, które Safari zrobiło samo
     * przy wejściu w pole. Powyżej jedynki użytkownik ogląda powiększony
     * fragment i przewijanie jest jedynym sposobem dojścia do reszty — wtedy
     * ręce precz.
     */
    if (widok.scale > 1) return;

    if (okno.scrollY !== 0 || okno.scrollX !== 0) okno.scrollTo(0, 0);

    // Safari bywa niezgodne samo ze sobą: `scrollY` potrafi już pokazywać zero,
    // gdy element przewijany dokumentu wciąż jest przesunięty.
    const przewijany = okno.document.scrollingElement;
    if (przewijany && przewijany.scrollTop !== 0) przewijany.scrollTop = 0;
  };

  odswiez();
  widok.addEventListener("resize", odswiez);
  widok.addEventListener("scroll", odswiez);

  return () => {
    widok.removeEventListener("resize", odswiez);
    widok.removeEventListener("scroll", odswiez);
    korzen.style.removeProperty(TOKEN);
  };
}
