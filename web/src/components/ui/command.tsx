import { Command as CommandPrimitive } from "cmdk";
import { Dialog as DialogPrimitive } from "radix-ui";
import type { ComponentProps, ReactNode } from "react";

import { Ikona } from "../../Ikony";
import { cn } from "./cn";
import { klasyNakladki } from "./dialog";

/*
 * Paleta poleceń (cmdk) w dialogu Radix.
 *
 * cmdk daje filtrowanie i nawigację strzałkami po liście, która nie jest
 * prawdziwym fokusem (fokus zostaje w polu szukania) — dzięki temu pisanie
 * i wybieranie dzieją się bez odrywania rąk od klawiatury.
 */

export function Command({ className, ...props }: ComponentProps<typeof CommandPrimitive>) {
  return (
    <CommandPrimitive
      className={cn("flex size-full flex-col overflow-hidden rounded-[inherit] bg-karta text-tekst", className)}
      {...props}
    />
  );
}

export function CommandDialog({
  otwarty,
  onZmiana,
  tytul,
  children,
}: {
  otwarty: boolean;
  onZmiana: (otwarty: boolean) => void;
  tytul: string;
  children: ReactNode;
}) {
  return (
    <DialogPrimitive.Root open={otwarty} onOpenChange={onZmiana}>
      <DialogPrimitive.Portal>
        <DialogPrimitive.Overlay className={klasyNakladki} />
        <DialogPrimitive.Content
          aria-describedby={undefined}
          className={cn(
            // Wyżej niż środek ekranu: lista rośnie W DÓŁ, a pole szukania ma
            // stać w miejscu, kiedy wyników przybywa albo ubywa.
            "fixed top-[12vh] left-1/2 z-50 w-[calc(100%-2rem)] max-w-xl -translate-x-1/2 overflow-hidden rounded-lg border border-linia bg-karta shadow-cien outline-none duration-[250ms] ease-vaul",
            "data-[state=open]:animate-in data-[state=open]:fade-in-0 data-[state=open]:zoom-in-[0.98] data-[state=closed]:animate-out data-[state=closed]:fade-out-0 data-[state=closed]:zoom-out-[0.98]",
          )}
        >
          <DialogPrimitive.Title className="tylko-dla-czytnika">{tytul}</DialogPrimitive.Title>
          {children}
        </DialogPrimitive.Content>
      </DialogPrimitive.Portal>
    </DialogPrimitive.Root>
  );
}

export function CommandInput({ className, ...props }: ComponentProps<typeof CommandPrimitive.Input>) {
  return (
    <div className="flex h-12 items-center gap-2.5 border-b border-linia px-4 text-tekst-drugi">
      <Ikona nazwa="szukaj" rozmiar={16} />
      <CommandPrimitive.Input
        className={cn(
          "h-full w-full min-w-0 bg-transparent text-tresc text-tekst outline-none placeholder:text-tekst-trzeci",
          className,
        )}
        {...props}
      />
    </div>
  );
}

export function CommandList({ className, ...props }: ComponentProps<typeof CommandPrimitive.List>) {
  return (
    <CommandPrimitive.List
      className={cn("max-h-[min(24rem,60vh)] scroll-py-1 overflow-x-hidden overflow-y-auto p-1", className)}
      {...props}
    />
  );
}

export function CommandEmpty(props: ComponentProps<typeof CommandPrimitive.Empty>) {
  return <CommandPrimitive.Empty className="py-8 text-center text-meta text-tekst-drugi" {...props} />;
}

export function CommandGroup({ className, ...props }: ComponentProps<typeof CommandPrimitive.Group>) {
  return (
    <CommandPrimitive.Group
      className={cn(
        "overflow-hidden p-1 text-tekst [&_[cmdk-group-heading]]:px-2 [&_[cmdk-group-heading]]:pt-1.5 [&_[cmdk-group-heading]]:pb-1 [&_[cmdk-group-heading]]:text-podpis [&_[cmdk-group-heading]]:font-medium [&_[cmdk-group-heading]]:text-tekst-drugi",
        className,
      )}
      {...props}
    />
  );
}

export function CommandSeparator({ className, ...props }: ComponentProps<typeof CommandPrimitive.Separator>) {
  return <CommandPrimitive.Separator className={cn("-mx-1 h-px bg-linia", className)} {...props} />;
}

export function CommandItem({ className, ...props }: ComponentProps<typeof CommandPrimitive.Item>) {
  return (
    <CommandPrimitive.Item
      className={cn(
        "relative flex min-h-10 cursor-pointer items-center gap-3 rounded-sm px-2 text-tresc outline-none select-none data-[disabled=true]:pointer-events-none data-[disabled=true]:opacity-50 data-[selected=true]:bg-wglebienie [&_.ikona]:text-tekst-drugi",
        className,
      )}
      {...props}
    />
  );
}

/** Skrót klawiszowy po prawej stronie pozycji albo w podpowiedzi. */
export function Klawisz({ className, ...props }: ComponentProps<"kbd">) {
  return (
    <kbd
      className={cn(
        "ml-auto inline-flex h-5 min-w-5 items-center justify-center rounded-sm border border-linia px-1 font-sans text-[11px] font-medium text-tekst-drugi",
        className,
      )}
      {...props}
    />
  );
}
