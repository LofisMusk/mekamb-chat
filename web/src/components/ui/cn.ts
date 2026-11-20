import { type ClassValue, clsx } from "clsx";
import { extendTailwindMerge } from "tailwind-merge";

/**
 * Sklejanie klas z rozstrzyganiem konfliktów Tailwinda.
 *
 * # Dlaczego nie samo `clsx`
 *
 * Komponent ma domyślne klasy, a miejsce użycia nadpisuje część z nich
 * (`className="h-9"` przy domyślnym `h-10`). Bez `twMerge` obie zostają
 * w atrybucie i wygrywa ta, która stoi później w ARKUSZU — czyli przypadek,
 * a nie miejsce użycia.
 *
 * Własne rozmiary tekstu (`text-tresc`, `text-meta`…), promienie i cień trzeba
 * zgłosić jawnie: `twMerge` nie zna naszego `@theme` i wziąłby rozmiar za
 * kolor, a wtedy `text-meta text-tekst-drugi` traciłby jedno z dwojga.
 */
const scal = extendTailwindMerge({
  extend: {
    theme: {
      text: ["podpis", "meta", "tresc", "sekcja", "tytul", "powitanie"],
      radius: ["pole", "babel"],
      shadow: ["cien"],
    },
  },
});

export function cn(...klasy: ClassValue[]) {
  return scal(clsx(klasy));
}
