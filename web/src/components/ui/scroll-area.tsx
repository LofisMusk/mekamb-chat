import { ScrollArea as ScrollAreaPrimitive } from "radix-ui";
import type { ComponentProps } from "react";

import { cn } from "./cn";

/**
 * Obszar przewijania (Radix) z cienkim paskiem, który pojawia się dopiero
 * przy przewijaniu.
 *
 * Pod spodem zostaje natywne przewijanie (pęd na iPhonie, kółko myszy,
 * klawiatura) — Radix podmienia wyłącznie pasek. Systemowy w motywie ciemnym
 * był jasną kreską przez całą kolumnę.
 */
export function ScrollArea({
  className,
  children,
  ...props
}: ComponentProps<typeof ScrollAreaPrimitive.Root>) {
  return (
    <ScrollAreaPrimitive.Root
      data-slot="scroll-area"
      className={cn("relative min-h-0 overflow-hidden", className)}
      {...props}
    >
      <ScrollAreaPrimitive.Viewport className="size-full rounded-[inherit] [&>div]:block!">
        {children}
      </ScrollAreaPrimitive.Viewport>
      <ScrollAreaPrimitive.Scrollbar
        orientation="vertical"
        className="flex w-2 touch-none p-px transition-colors select-none"
      >
        <ScrollAreaPrimitive.Thumb className="relative flex-1 rounded-full bg-linia-mocna" />
      </ScrollAreaPrimitive.Scrollbar>
      <ScrollAreaPrimitive.Corner />
    </ScrollAreaPrimitive.Root>
  );
}
