import { useMemo } from "react";

import { qrSvgPath } from "./lib/qr";

/**
 * Kod QR jako SVG.
 *
 * Rysowany jedną ścieżką zamiast tysiącem prostokątów: przy wersji 10 to 3249
 * modułów, a tyle elementów DOM zauważalnie zwalnia telefon.
 *
 * `shape-rendering="crispEdges"` jest konieczne — domyślne wygładzanie rozmywa
 * krawędzie modułów i przy małych rozmiarach czytniki gubią kod.
 */
export function KodQr({ tresc, opis }: { tresc: string; opis: string }) {
  const kod = useMemo(() => {
    try {
      return qrSvgPath(tresc);
    } catch {
      // Za długa treść nie może wywrócić ekranu — obok kodu zawsze jest
      // wersja tekstowa i ona wystarcza.
      return null;
    }
  }, [tresc]);

  if (!kod) return null;

  return (
    <svg
      className="kod-qr"
      viewBox={`0 0 ${kod.rozmiar} ${kod.rozmiar}`}
      shapeRendering="crispEdges"
      role="img"
      aria-label={opis}
    >
      {/* Jasne tło jest częścią kodu, nie ozdobą: czytnik potrzebuje kontrastu,
          a przy ciemnym motywie strony samo przezroczyste tło go nie daje. */}
      <rect width={kod.rozmiar} height={kod.rozmiar} fill="#fff" />
      <path d={kod.d} fill="#000" />
    </svg>
  );
}
