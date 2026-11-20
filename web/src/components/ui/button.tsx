import { type VariantProps, cva } from "class-variance-authority";
import { Slot } from "radix-ui";
import type { ComponentProps } from "react";

import { cn } from "./cn";

/**
 * Przycisk — cztery role ze specyfikacji, nic ponad nie.
 *
 * - `default` (główny): plama `glowny`. Na ekranie najwyżej JEDNA — to jasność
 *   plamy, a nie kolor, odróżnia akcję główną od drugorzędnej.
 * - `outline`: obrys `linia-mocna`, dla akcji równorzędnych.
 * - `ghost`: bez tła, `wglebienie` pod kursorem. Wszystko w pasku wątku.
 * - `destructive`: alarm jako tekst i obrys, nie plama — czerwona plama
 *   konkurowałaby z akcją główną o uwagę, a kasowanie nie powinno zapraszać.
 *
 * Wysokość 40 px przy myszy, 44 px na dotyku (`pointer-coarse`): cel dotyku
 * poniżej 44 px jest celem, w który się nie trafia.
 */
export const wariantyPrzycisku = cva(
  "inline-flex shrink-0 cursor-pointer items-center justify-center gap-2 whitespace-nowrap rounded-md text-tresc font-medium transition-[background-color,color,border-color,opacity] duration-150 select-none disabled:pointer-events-none disabled:opacity-45 [&_svg]:pointer-events-none [&_svg]:shrink-0",
  {
    variants: {
      variant: {
        default: "bg-glowny text-glowny-tekst hover:bg-glowny/88 active:bg-glowny/80",
        outline:
          "border border-linia-mocna bg-transparent text-tekst hover:bg-wglebienie active:bg-wglebienie-mocne",
        ghost: "text-tekst hover:bg-wglebienie active:bg-wglebienie-mocne",
        destructive:
          "border border-alarm/45 bg-transparent text-alarm hover:bg-alarm-tlo active:bg-alarm-tlo",
        link: "h-auto px-0 text-tekst underline-offset-4 hover:underline",
      },
      size: {
        default: "h-10 px-4 pointer-coarse:h-11",
        sm: "h-9 px-3 text-meta",
        lg: "h-11 px-5",
        icon: "size-10 pointer-coarse:size-11",
        "icon-sm": "size-8",
      },
    },
    defaultVariants: { variant: "default", size: "default" },
  },
);

export function Button({
  className,
  variant,
  size,
  asChild = false,
  type = "button",
  ...props
}: ComponentProps<"button"> & VariantProps<typeof wariantyPrzycisku> & { asChild?: boolean }) {
  const Element = asChild ? Slot.Root : "button";

  return (
    <Element
      data-slot="button"
      // `type="button"` domyślnie: przycisk w formularzu bez typu WYSYŁA
      // formularz, a to zaskakuje przy każdym „Anuluj" stojącym obok „Zapisz".
      // Przycisk wysyłający mówi `type="submit"` jawnie.
      type={asChild ? undefined : type}
      className={cn(wariantyPrzycisku({ variant, size }), className)}
      {...props}
    />
  );
}
