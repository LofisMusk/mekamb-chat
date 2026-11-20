import type { CSSProperties } from "react";
import { Toaster as Sonner } from "sonner";

import { SZEROKI, useSzerokosc } from "../../lib/szerokosc";

/**
 * Powiadomienia chwilowe (Sonner).
 *
 * Góra-środek na telefonie — dół ekranu zajmuje kciuk i pole pisania, więc
 * komunikat od dołu przykrywałby dokładnie to, czego się w tej chwili używa.
 * Dół-prawo na desktopie, gdzie nie przykrywa niczego.
 *
 * Wygląd ze specyfikacji: karta + linia + cień (w ciemnym bez cienia). Błąd
 * nie dostaje czerwonego tła — tylko ikonę i obrys w kolorze alarmu.
 *
 * Komunikat znika sam po kilku sekundach, a najechanie kursorem go zatrzymuje:
 * dłuższy da się doczytać, krótki schodzi z drogi bez klikania krzyżyka.
 */
export function Toaster() {
  const szeroki = useSzerokosc(SZEROKI);

  return (
    <Sonner
      position={szeroki ? "bottom-right" : "top-center"}
      // Motywu nie przekazujemy: kolory biorą się z tokenów, które same
      // przełączają się z motywem aplikacji.
      theme="system"
      closeButton
      duration={6000}
      offset={szeroki ? 24 : { top: "calc(var(--bezpiecznie-gora) + 12px)" }}
      mobileOffset={{ top: "calc(var(--bezpiecznie-gora) + 12px)", left: 16, right: 16 }}
      style={
        {
          "--normal-bg": "var(--karta)",
          "--normal-text": "var(--tekst)",
          "--normal-border": "var(--linia)",
          "--error-bg": "var(--karta)",
          "--error-text": "var(--tekst)",
          "--error-border": "color-mix(in srgb, var(--alarm) 45%, transparent)",
          "--success-bg": "var(--karta)",
          "--success-text": "var(--tekst)",
          "--success-border": "var(--linia)",
          "--border-radius": "var(--promien-m)",
          fontFamily: "var(--font-sans)",
        } as CSSProperties
      }
      toastOptions={{
        classNames: {
          toast: "shadow-cien! text-meta!",
          description: "text-tekst-drugi!",
          error: "[&_[data-icon]]:text-alarm!",
          success: "[&_[data-icon]]:text-sukces!",
          closeButton: "bg-karta! border-linia! text-tekst-drugi! hover:text-tekst!",
        },
      }}
    />
  );
}
