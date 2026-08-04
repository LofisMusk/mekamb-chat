//! Decyzja, co zrobić z kopertą, której nie udało się przetworzyć.
//!
//! # Dlaczego to jest osobno, a nie w komponencie
//!
//! To jedyne miejsce, gdzie klient może **trwale stracić wiadomość** albo
//! wpaść w nieskończoną pętlę. Wpisane w środek `onmessage` było nietestowalne,
//! a rzecz jest zbyt ostra, żeby polegać na tym, że się dobrze przeczyta.

/**
 * Ile razy próbujemy przetworzyć kopertę, zanim uznamy ją za martwą.
 *
 * Więcej niż raz, bo koperta może wyprzedzić commit, który jest jej potrzebny —
 * wtedy druga próba, już po nadejściu commitu, się powiedzie. Potwierdzenie po
 * pierwszym niepowodzeniu kasowałoby takie koperty bezpowrotnie.
 */
export const PROB_PRZED_ODRZUCENIEM = 3;

/**
 * Licznik nieudanych prób per koperta.
 *
 * Trzymany w pamięci, więc przeładowanie strony zeruje próby. To celowe:
 * po przeładowaniu warunki mogą być inne (doszedł brakujący commit), więc
 * koperta zasługuje na kolejne podejście.
 */
export type LicznikProb = Map<string, number>;

/** Co zrobić z kopertą po nieudanym przetworzeniu. */
export type Decyzja =
  /** Zostaw w kolejce — wróci przy następnym połączeniu i spróbujemy znowu. */
  | { rodzaj: "ponow" }
  /** Potwierdź mimo niepowodzenia. Koperta jest martwa i ma zniknąć z kolejki. */
  | { rodzaj: "odrzuc" };

/**
 * Odnotowuje nieudane przetworzenie koperty i mówi, co dalej.
 *
 * Bez potwierdzenia koperta wraca przy **każdym** połączeniu. Koperta, której
 * nigdy nie da się przetworzyć — powtórzona ze skrzynki, z nieaktualnej epoki,
 * spreparowana przez kogoś z sieci — krążyłaby więc bez końca. Po kilku próbach
 * uznajemy ją za martwą i potwierdzamy.
 */
export function poNiepowodzeniu(licznik: LicznikProb, id: string): Decyzja {
  const prob = (licznik.get(id) ?? 0) + 1;

  if (prob >= PROB_PRZED_ODRZUCENIEM) {
    licznik.delete(id);
    return { rodzaj: "odrzuc" };
  }

  licznik.set(id, prob);
  return { rodzaj: "ponow" };
}

/**
 * Kasuje licznik po udanym przetworzeniu.
 *
 * Konieczne, bo bez tego koperta, która przeszła za drugim razem, zostawiałaby
 * po sobie wpis — a identyfikatory kolejki są nadawane po kolei, więc licznik
 * rósłby w nieskończoność przez całe życie połączenia.
 */
export function poSukcesie(licznik: LicznikProb, id: string): void {
  licznik.delete(id);
}
