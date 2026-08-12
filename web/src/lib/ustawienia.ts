/**
 * Ustawienia prywatności trzymane na urządzeniu.
 *
 * # Dlaczego to nie jedzie na serwer
 *
 * Bo serwer nie ma prawa wiedzieć, czy wysyłasz potwierdzenia odczytu — sama
 * ta informacja jest metadaną o Tobie. Ustawienie dotyczy tego urządzenia
 * i nigdzie się nie zgłasza.
 */

const KLUCZ_ODCZYT = "mekamb.potwierdzenia-odczytu";

/**
 * Czy wysyłamy potwierdzenia odczytu.
 *
 * Domyślnie tak — z opóźnieniem i w paczkach, więc chwila odczytu i tak nie
 * wychodzi (patrz `potwierdzenia.ts`). Kto chce, wyłącza.
 *
 * **Wyłączenie działa w obie strony**: nie wysyłamy i nie pokazujemy cudzych.
 * To decyzja lokalna, nie wymuszona protokołem — druga strona nadal może
 * potwierdzenia wysyłać, my ich po prostu nie użyjemy. Pokazywanie cudzych
 * odczytów komuś, kto własnych nie oddaje, byłoby jednostronną wymianą.
 */
export function odczytWlaczony(magazyn: Pick<Storage, "getItem"> = localStorage): boolean {
  try {
    return magazyn.getItem(KLUCZ_ODCZYT) !== "nie";
  } catch {
    // Prywatne okno bez dostępu do magazynu. Domyślne „tak" jest tu zgodne
    // z tym, czego użytkownik nie zmieniał.
    return true;
  }
}

export function ustawOdczyt(
  wlaczony: boolean,
  magazyn: Pick<Storage, "setItem"> = localStorage,
): void {
  try {
    magazyn.setItem(KLUCZ_ODCZYT, wlaczony ? "tak" : "nie");
  } catch {
    // Ustawienie zadziała do końca sesji i tyle.
  }
}
