import { ContextMenu as ContextMenuPrimitive, DropdownMenu as DropdownMenuPrimitive } from "radix-ui";
import type { ComponentProps } from "react";

import { cn } from "./cn";

/*
 * Menu rozwijane (kebab) i kontekstowe (prawy przycisk) — Radix.
 *
 * Oba dzielą wygląd, bo to ta sama rzecz otwarta inną drogą: lista czynności
 * na karcie `karta`, z obrysem `linia` i cieniem tylko w jasnym. Pozycja
 * niszcząca jest tekstem `alarm`, nie czerwonym tłem.
 *
 * Własne menu w tym kodzie było absolutnie pozycjonowanym `div`-em i ucinał je
 * `overflow: hidden` wiersza listy. Radix rysuje menu w portalu, więc nie ma
 * już przodka, który mógłby je przyciąć.
 */

const klasyMenu =
  "z-50 min-w-44 overflow-hidden rounded-md border border-linia bg-karta p-1 text-tekst shadow-cien data-[state=open]:animate-in data-[state=open]:fade-in-0 data-[state=open]:zoom-in-[0.97] data-[state=closed]:animate-out data-[state=closed]:fade-out-0 data-[state=closed]:zoom-out-[0.97]";

const klasyPozycji =
  "relative flex cursor-pointer items-center gap-2.5 rounded-sm px-2.5 py-2 text-meta outline-none select-none data-[disabled]:pointer-events-none data-[disabled]:opacity-50 data-[highlighted]:bg-wglebienie data-[variant=destructive]:text-alarm data-[variant=destructive]:data-[highlighted]:bg-alarm-tlo [&_svg]:shrink-0";

export const DropdownMenu = DropdownMenuPrimitive.Root;
export const DropdownMenuTrigger = DropdownMenuPrimitive.Trigger;

export function DropdownMenuContent({
  className,
  sideOffset = 6,
  ...props
}: ComponentProps<typeof DropdownMenuPrimitive.Content>) {
  return (
    <DropdownMenuPrimitive.Portal>
      <DropdownMenuPrimitive.Content
        sideOffset={sideOffset}
        className={cn(klasyMenu, className)}
        {...props}
      />
    </DropdownMenuPrimitive.Portal>
  );
}

export function DropdownMenuItem({
  className,
  variant,
  ...props
}: ComponentProps<typeof DropdownMenuPrimitive.Item> & { variant?: "destructive" }) {
  return (
    <DropdownMenuPrimitive.Item
      data-variant={variant}
      className={cn(klasyPozycji, className)}
      {...props}
    />
  );
}

export function DropdownMenuLabel({
  className,
  ...props
}: ComponentProps<typeof DropdownMenuPrimitive.Label>) {
  return (
    <DropdownMenuPrimitive.Label
      className={cn("px-2.5 py-1.5 text-podpis font-medium text-tekst-drugi", className)}
      {...props}
    />
  );
}

export function DropdownMenuSeparator({
  className,
  ...props
}: ComponentProps<typeof DropdownMenuPrimitive.Separator>) {
  return <DropdownMenuPrimitive.Separator className={cn("-mx-1 my-1 h-px bg-linia", className)} {...props} />;
}

export const ContextMenu = ContextMenuPrimitive.Root;
export const ContextMenuTrigger = ContextMenuPrimitive.Trigger;

export function ContextMenuContent({
  className,
  ...props
}: ComponentProps<typeof ContextMenuPrimitive.Content>) {
  return (
    <ContextMenuPrimitive.Portal>
      <ContextMenuPrimitive.Content className={cn(klasyMenu, className)} {...props} />
    </ContextMenuPrimitive.Portal>
  );
}

export function ContextMenuItem({
  className,
  variant,
  ...props
}: ComponentProps<typeof ContextMenuPrimitive.Item> & { variant?: "destructive" }) {
  return (
    <ContextMenuPrimitive.Item data-variant={variant} className={cn(klasyPozycji, className)} {...props} />
  );
}
