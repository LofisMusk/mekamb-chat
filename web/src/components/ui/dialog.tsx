import { Dialog as DialogPrimitive } from "radix-ui";
import type { ComponentProps } from "react";

import { Ikona } from "../../Ikony";
import { cn } from "./cn";

/*
 * Dialog (Radix) — okno na środku ekranu dla szerokości ≥ 768 px.
 *
 * Na telefonie tę samą treść niesie arkusz od dołu (`Arkusz` w `arkusz.tsx`):
 * dialog na środku wąskiego ekranu stoi poza zasięgiem kciuka.
 *
 * Radix daje za darmo pułapkę fokusu, `Escape`, powrót fokusu do przycisku,
 * który otworzył okno, i blokadę przewijania pod spodem — każdą z tych rzeczy
 * własne okna w tym kodzie robiły osobno albo wcale.
 */

export const Dialog = DialogPrimitive.Root;
export const DialogTrigger = DialogPrimitive.Trigger;
export const DialogClose = DialogPrimitive.Close;
export const DialogPortal = DialogPrimitive.Portal;

/** Nakładka `--nakladka`: 40% czerni w jasnym, 60% w ciemnym. Samo przenikanie. */
export const klasyNakladki =
  "fixed inset-0 z-50 bg-nakladka data-[state=open]:animate-in data-[state=open]:fade-in-0 data-[state=closed]:animate-out data-[state=closed]:fade-out-0";

export function DialogOverlay({ className, ...props }: ComponentProps<typeof DialogPrimitive.Overlay>) {
  return (
    <DialogPrimitive.Overlay
      data-slot="dialog-overlay"
      className={cn(klasyNakladki, className)}
      {...props}
    />
  );
}

export function DialogContent({
  className,
  children,
  bezZamykania = false,
  ...props
}: ComponentProps<typeof DialogPrimitive.Content> & { bezZamykania?: boolean }) {
  return (
    <DialogPortal>
      <DialogOverlay />
      <DialogPrimitive.Content
        data-slot="dialog-content"
        className={cn(
          "fixed top-1/2 left-1/2 z-50 grid max-h-[calc(var(--wysokosc-okna)-2rem)] w-[calc(100%-2rem)] max-w-md -translate-x-1/2 -translate-y-1/2 gap-4 overflow-y-auto rounded-lg border border-linia bg-karta p-6 text-tekst shadow-cien duration-[250ms] ease-vaul outline-none",
          "data-[state=open]:animate-in data-[state=open]:fade-in-0 data-[state=open]:zoom-in-[0.97] data-[state=closed]:animate-out data-[state=closed]:fade-out-0 data-[state=closed]:zoom-out-[0.97]",
          className,
        )}
        {...props}
      >
        {children}
        {!bezZamykania && (
          <DialogPrimitive.Close
            className="absolute top-3 right-3 grid size-8 cursor-pointer place-items-center rounded-sm text-tekst-drugi transition-colors hover:bg-wglebienie hover:text-tekst"
            aria-label="Zamknij"
          >
            <Ikona nazwa="zamknij" rozmiar={16} />
          </DialogPrimitive.Close>
        )}
      </DialogPrimitive.Content>
    </DialogPortal>
  );
}

export function DialogHeader({ className, ...props }: ComponentProps<"div">) {
  return <div data-slot="dialog-header" className={cn("flex flex-col gap-1.5 pr-8", className)} {...props} />;
}

export function DialogFooter({ className, ...props }: ComponentProps<"div">) {
  return (
    <div
      data-slot="dialog-footer"
      className={cn("flex flex-col-reverse gap-2 sm:flex-row sm:justify-end", className)}
      {...props}
    />
  );
}

export function DialogTitle({ className, ...props }: ComponentProps<typeof DialogPrimitive.Title>) {
  return (
    <DialogPrimitive.Title
      data-slot="dialog-title"
      className={cn("text-sekcja font-semibold tracking-[-0.02em]", className)}
      {...props}
    />
  );
}

export function DialogDescription({
  className,
  ...props
}: ComponentProps<typeof DialogPrimitive.Description>) {
  return (
    <DialogPrimitive.Description
      data-slot="dialog-description"
      className={cn("text-meta text-tekst-drugi", className)}
      {...props}
    />
  );
}
