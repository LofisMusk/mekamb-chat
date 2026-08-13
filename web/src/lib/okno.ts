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
     * układu — a to zdarza się wtedy, gdy dokument da się przewinąć albo
     * uszczypnąć. Odkąd `body` jest przypięty (`position: fixed`, patrz
     * `styles.css`), dokument nie ma jak się przesunąć i `offsetTop` zostaje
     * zerem poza powiększeniem szczypaniem.
     *
     * Doliczanie go byłoby więc w najlepszym razie zerem, a przy powiększeniu
     * dawałoby powłokę WYŻSZĄ niż ekran — czyli wracałoby dokładnie do usterki,
     * przez którą pole pisania schodziło pod krawędź.
     */
    korzen.style.setProperty(TOKEN, `${widok.height}px`);
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
