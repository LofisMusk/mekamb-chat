import type { ComponentProps } from "react";

import { cn } from "./cn";

/**
 * Pole tekstowe: `wglebienie` bez obramowania, obrys `linia-mocna` dopiero
 * przy fokusie.
 *
 * Obramowanie w spoczynku dawało ekran pełen prostokątów, z których żaden nie
 * mówił, który jest aktywny. Wgłębienie mówi „tu się pisze", a obrys przy
 * fokusie — „tu piszesz teraz".
 */
export const klasyPola =
  "w-full min-w-0 rounded-md border border-transparent bg-wglebienie px-3 text-tresc text-tekst transition-[border-color] duration-150 placeholder:text-tekst-trzeci focus-visible:border-linia-mocna disabled:cursor-not-allowed disabled:opacity-50";

export function Input({ className, type, ...props }: ComponentProps<"input">) {
  return (
    <input
      type={type}
      data-slot="input"
      className={cn(
        klasyPola,
        "h-10 pointer-coarse:h-11",
        "file:mr-3 file:h-full file:border-0 file:bg-transparent file:text-meta file:font-medium file:text-tekst",
        type === "file" && "py-2 text-meta text-tekst-drugi",
        className,
      )}
      {...props}
    />
  );
}

export function Textarea({ className, ...props }: ComponentProps<"textarea">) {
  return (
    <textarea
      data-slot="textarea"
      className={cn(klasyPola, "min-h-20 resize-y py-2", className)}
      {...props}
    />
  );
}
