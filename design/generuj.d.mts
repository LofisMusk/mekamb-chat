/**
 * Typy generatora.
 *
 * Osobny plik z deklaracjami z tego samego powodu co przy źródle: generator
 * jest zwykłym modułem ESM, żeby dało się go uruchomić samym `node`, bez
 * dokładania uruchamiacza TypeScriptu do zależności.
 */

/** Ścieżka do wygenerowanego komponentu weba. */
export declare const SCIEZKA_WEB: string;

/** Ścieżka do wygenerowanego zestawu Androida. */
export declare const SCIEZKA_ANDROID: string;

/** Treść, jaką generator wypisałby do `web/src/Ikony.tsx`. */
export declare function zrodloWeb(): string;

/** Treść, jaką generator wypisałby do `android/.../Ikony.kt`. */
export declare function zrodloAndroid(): string;

/** Czy plik na dysku zgadza się z podaną treścią. */
export declare function zgodne(sciezka: string, oczekiwane: string): boolean;
