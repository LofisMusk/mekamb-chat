import { ToggleGroup as ToggleGroupPrimitive } from "radix-ui";
import type { ComponentProps } from "react";

import { cn } from "./cn";

/**
 * Segment (Radix `ToggleGroup`): tor `wglebienie`, wybrana pozycja to karta.
 *
 * Wybór nie jest plamą `glowny` — segment nie jest akcją, tylko stanem,
 * a plama na ekranie należy do akcji głównej.
 */
export function ToggleGroup({
  className,
  ...props
}: ComponentProps<typeof ToggleGroupPrimitive.Root>) {
  return (
    <ToggleGroupPrimitive.Root
      data-slot="toggle-group"
      className={cn("inline-flex items-center gap-0.5 rounded-md bg-wglebienie p-0.5", className)}
      {...props}
    />
  );
}

export function ToggleGroupItem({
  className,
  ...props
}: ComponentProps<typeof ToggleGroupPrimitive.Item>) {
  return (
    <ToggleGroupPrimitive.Item
      data-slot="toggle-group-item"
      className={cn(
        "inline-flex h-8 min-w-9 flex-1 cursor-pointer items-center justify-center gap-1.5 rounded-sm px-2.5 text-meta font-medium text-tekst-drugi transition-colors duration-150 hover:text-tekst data-[state=on]:bg-karta data-[state=on]:text-tekst data-[state=on]:shadow-cien dark:data-[state=on]:bg-wglebienie-mocne",
        className,
      )}
      {...props}
    />
  );
}
