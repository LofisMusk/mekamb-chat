/**
 * Typy źródła ikon.
 *
 * Osobny plik z deklaracjami, bo źródło jest zwykłym modułem ESM uruchamianym
 * wprost przez `node` — bez kroku kompilacji generator działa jednym poleceniem
 * i bez dokładania zależności tylko po to, by uruchomić TypeScript.
 */

export interface Ikona {
  /** Nazwa w kodzie weba, w camelCase. Zarazem klucz w mapie ścieżek. */
  nazwa: string;
  /** Nazwa w kodzie Androida, w PascalCase — konwencja `object Ikony`. */
  kotlin: string;
  /** Co ikona ZNACZY. Trafia do komentarza w obu wygenerowanych plikach. */
  opis: string;
  /** Ścieżka w notacji SVG na płótnie 24×24. */
  sciezka: string;
}

export declare const GRUBOSC: number;
export declare const PLOTNO: number;
export declare const IKONY: Ikona[];
