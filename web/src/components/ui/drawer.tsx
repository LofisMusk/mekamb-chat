import type { ComponentProps } from "react";
import { Drawer as DrawerPrimitive } from "vaul";

import { cn } from "./cn";

/*
 * Arkusz od dołu (Vaul) — telefon, szerokość < 768 px.
 *
 * Vaul, a nie dialog przyklejony do dołu, bo arkusz ma się dać ZRZUCIĆ
 * kciukiem: przeciągnięcie w dół zamyka go z tą samą fizyką co w systemie.
 * Dialog, który da się zamknąć tylko krzyżykiem, na telefonie jest pułapką.
 *
 * Górne rogi 16 px (`rounded-t-xl`), uchwyt na górze — to on mówi, że arkusz
 * da się ściągnąć, zanim ktokolwiek spróbuje.
 */

export const Drawer = DrawerPrimitive.Root;
export const DrawerTrigger = DrawerPrimitive.Trigger;
export const DrawerClose = DrawerPrimitive.Close;

export function DrawerContent({
  className,
  children,
  ...props
}: ComponentProps<typeof DrawerPrimitive.Content>) {
  return (
    <DrawerPrimitive.Portal>
      <DrawerPrimitive.Overlay className="fixed inset-0 z-50 bg-nakladka" />
      <DrawerPrimitive.Content
        data-slot="drawer-content"
        className={cn(
          "group/arkusz fixed z-50 flex flex-col border-linia bg-karta text-tekst outline-none",
          "data-[vaul-drawer-direction=bottom]:inset-x-0 data-[vaul-drawer-direction=bottom]:bottom-0 data-[vaul-drawer-direction=bottom]:max-h-[calc(var(--wysokosc-okna)-2.5rem)] data-[vaul-drawer-direction=bottom]:rounded-t-xl data-[vaul-drawer-direction=bottom]:border-t data-[vaul-drawer-direction=bottom]:pb-[var(--bezpiecznie-dol)]",
          "data-[vaul-drawer-direction=right]:inset-y-0 data-[vaul-drawer-direction=right]:right-0 data-[vaul-drawer-direction=right]:w-[min(var(--kol-szczegoly),100%)] data-[vaul-drawer-direction=right]:border-l data-[vaul-drawer-direction=right]:pt-[var(--bezpiecznie-gora)] data-[vaul-drawer-direction=right]:pb-[var(--bezpiecznie-dol)]",
          className,
        )}
        {...props}
      >
        <div
          aria-hidden="true"
          className="mx-auto mt-2.5 hidden h-1 w-10 shrink-0 rounded-full bg-wglebienie-mocne group-data-[vaul-drawer-direction=bottom]/arkusz:block"
        />
        {children}
      </DrawerPrimitive.Content>
    </DrawerPrimitive.Portal>
  );
}

export function DrawerHeader({ className, ...props }: ComponentProps<"div">) {
  return <div className={cn("flex flex-col gap-1 px-4 pt-3 pb-2", className)} {...props} />;
}

export function DrawerFooter({ className, ...props }: ComponentProps<"div">) {
  return <div className={cn("mt-auto flex flex-col gap-2 p-4", className)} {...props} />;
}

export function DrawerTitle({ className, ...props }: ComponentProps<typeof DrawerPrimitive.Title>) {
  return (
    <DrawerPrimitive.Title
      className={cn("text-sekcja font-semibold tracking-[-0.02em]", className)}
      {...props}
    />
  );
}

export function DrawerDescription({
  className,
  ...props
}: ComponentProps<typeof DrawerPrimitive.Description>) {
  return <DrawerPrimitive.Description className={cn("text-meta text-tekst-drugi", className)} {...props} />;
}
