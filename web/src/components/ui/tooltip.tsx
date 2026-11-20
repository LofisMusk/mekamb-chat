import { Tooltip as TooltipPrimitive } from "radix-ui";
import type { ComponentProps, ReactNode } from "react";

import { cn } from "./cn";

/*
 * Podpowiedź (Radix) — wyłącznie dla kontrolek będących samą ikoną.
 *
 * Ikona bez słowa jest zagadką dla każdego, kto jej jeszcze nie zna; `title`
 * pokazuje się po sekundzie, w kolorach systemu i nigdy przy klawiaturze.
 * Radix pokazuje podpowiedź także przy fokusie z klawiatury — a nazwę dla
 * czytnika ekranu i tak niesie `aria-label` samej kontrolki.
 */

export const TooltipProvider = TooltipPrimitive.Provider;

export function TooltipContent({
  className,
  sideOffset = 6,
  ...props
}: ComponentProps<typeof TooltipPrimitive.Content>) {
  return (
    <TooltipPrimitive.Portal>
      <TooltipPrimitive.Content
        sideOffset={sideOffset}
        className={cn(
          "z-50 rounded-sm bg-glowny px-2 py-1 text-podpis font-medium text-glowny-tekst data-[state=closed]:animate-out data-[state=closed]:fade-out-0 data-[state=delayed-open]:animate-in data-[state=delayed-open]:fade-in-0",
          className,
        )}
        {...props}
      />
    </TooltipPrimitive.Portal>
  );
}

/** Skrót: kontrolka + podpis. Podpis jest nazwą, nie opisem — kilka słów. */
export function Podpowiedz({
  tresc,
  strona = "bottom",
  children,
}: {
  tresc: ReactNode;
  strona?: "top" | "right" | "bottom" | "left";
  children: ReactNode;
}) {
  return (
    <TooltipPrimitive.Root>
      <TooltipPrimitive.Trigger asChild>{children}</TooltipPrimitive.Trigger>
      <TooltipContent side={strona}>{tresc}</TooltipContent>
    </TooltipPrimitive.Root>
  );
}
