/**
 * Wybór rozmowy, do której trafia „napisz do tej osoby".
 *
 * # Czemu to musiało powstać
 *
 * Rozpoczęcie rozmowy zawsze zakładało **nową grupę MLS**, więc wpisanie tej
 * samej nazwy drugi raz dawało drugą rozmowę z tą samą osobą. Lista puchła od
 * duplikatów, a historia rozjeżdżała się między nimi: część wiadomości szła do
 * jednej grupy, część do drugiej, i żadna nie pokazywała całości.
 *
 * # Reguła
 *
 * Rozmowa jest tą samą rozmową, gdy jej **skład** to dokładnie dwie osoby: my
 * i ten rozmówca. Sprawdzamy skład z drzewa MLS, a nie zapisaną obok nazwę
 * rozmówcy: nazwa jest etykietą listy, a skład jest faktem. Grupa trzyosobowa,
 * której etykietą jest imię tej osoby, nie jest DM-em i wciągnięcie do niej
 * rozmowy prywatnej pokazałoby ją dwóm dodatkowym osobom.
 *
 * Ta sama reguła obowiązuje w kliencie Androida (`Rozmowy.kt`). Rozjazd
 * znaczyłby, że te same dwa urządzenia inaczej rozstrzygają, czy rozmowa już
 * istnieje.
 */

/** Rozmowa na tyle opisana, żeby dało się rozstrzygnąć, czy to ta sama. */
export interface RozmowaDoWyboru {
  groupId: Uint8Array;
}

/**
 * Nazwa rozmowy — kto w niej jest poza nami.
 *
 * # Czemu to musiało powstać
 *
 * Nazwa brała się ze stanu interfejsu: wpisanej w Kontaktach albo odczytanej
 * z klikniętej pozycji listy. Wiadomość od kogoś, kto założył **nową** grupę,
 * nie przechodziła przez żadne z tych miejsc, więc rozmowa zapisywała się
 * z nazwą pustą — na liście pojawiał się wiersz bez imienia i bez awatara.
 * W gorszym wariancie zostawała nazwa poprzednio otwartej rozmowy, czyli
 * wiadomości od jednej osoby podpisywały się drugą.
 *
 * Skład z drzewa MLS jest jedynym źródłem, które zna każdy sposób powstania
 * rozmowy — bo grupa nie istnieje bez składu.
 */
export function nazwaRozmowy(czlonkowie: readonly string[], ja: string): string {
  const inni = [...new Set(czlonkowie)].filter((osoba) => osoba !== ja);

  // Pusto tylko wtedy, gdy zostaliśmy sami. Wywołujący ma wtedy zostawić to,
  // co już zapisał: stara nazwa jest lepsza niż jej brak.
  return inni.join(", ");
}

/**
 * Znajduje istniejącą rozmowę jeden na jeden z podaną osobą.
 *
 * `czlonkowie` zwraca identyfikatory użytkowników w grupie. Wyjątek dla
 * pojedynczej grupy (stan MLS mógł jej nie mieć, np. na świeżo sparowanym
 * urządzeniu) nie może przerwać szukania — po prostu ta grupa nie pasuje.
 */
export function znajdzRozmowe1na1<T extends RozmowaDoWyboru>(
  rozmowy: readonly T[],
  czlonkowie: (groupId: Uint8Array) => string[],
  ja: string,
  rozmowca: string,
): T | undefined {
  if (rozmowca === ja) return undefined;

  return rozmowy.find((rozmowa) => {
    let sklad: Set<string>;
    try {
      sklad = new Set(czlonkowie(rozmowa.groupId));
    } catch {
      return false;
    }

    return sklad.size === 2 && sklad.has(ja) && sklad.has(rozmowca);
  });
}
