import { Switch as SwitchPrimitive } from "radix-ui";
import type { ComponentProps } from "react";

import { cn } from "./cn";

/**
 * Przełącznik (Radix). Włączony = tor `glowny`, wyłączony = `wglebienie-mocne`.
 *
 * Zastąpił systemowe pole wyboru: to mówiło „zaznacz", a ustawienie mówi
 * „włącz". Radix zostawia rolę `switch`, klawiaturę i stan dla czytnika.
 */
export function Switch({ className, ...props }: ComponentProps<typeof SwitchPrimitive.Root>) {
  return (
    <SwitchPrimitive.Root
      data-slot="switch"
      className={cn(
        "peer inline-flex h-6 w-10 shrink-0 cursor-pointer items-center rounded-full border border-transparent p-0.5 transition-colors duration-150 disabled:cursor-not-allowed disabled:opacity-50 data-[state=checked]:bg-glowny data-[state=unchecked]:bg-wglebienie-mocne",
        className,
      )}
      {...props}
    >
      <SwitchPrimitive.Thumb
        className={cn(
          "pointer-events-none block size-[18px] rounded-full shadow-cien ring-0 transition-transform duration-150 ease-vaul data-[state=checked]:translate-x-4 data-[state=checked]:bg-glowny-tekst data-[state=unchecked]:translate-x-0 data-[state=unchecked]:bg-tlo",
        )}
      />
    </SwitchPrimitive.Root>
  );
}
