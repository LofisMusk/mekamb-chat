import { AlertDialog as AlertDialogPrimitive } from "radix-ui";
import type { ComponentProps } from "react";

import { wariantyPrzycisku } from "./button";
import { cn } from "./cn";
import { klasyNakladki } from "./dialog";

/*
 * Dialog potwierdzenia (Radix `AlertDialog`).
 *
 * Inny niż zwykły dialog w jednym, ważnym miejscu: klik w tło go NIE zamyka.
 * Pytanie „usunąć bezpowrotnie?" ma dostać odpowiedź, a nie zniknąć od
 * przypadkowego dotknięcia obok. `Escape` znaczy „anuluj" — bezpieczniejsza
 * odpowiedź ma być tą łatwą.
 */

export const AlertDialog = AlertDialogPrimitive.Root;
export const AlertDialogTrigger = AlertDialogPrimitive.Trigger;

export function AlertDialogContent({
  className,
  ...props
}: ComponentProps<typeof AlertDialogPrimitive.Content>) {
  return (
    <AlertDialogPrimitive.Portal>
      <AlertDialogPrimitive.Overlay className={klasyNakladki} />
      <AlertDialogPrimitive.Content
        data-slot="alert-dialog-content"
        className={cn(
          "fixed top-1/2 left-1/2 z-50 grid w-[calc(100%-2rem)] max-w-sm -translate-x-1/2 -translate-y-1/2 gap-4 rounded-lg border border-linia bg-karta p-6 text-tekst shadow-cien duration-[250ms] ease-vaul outline-none",
          "data-[state=open]:animate-in data-[state=open]:fade-in-0 data-[state=open]:zoom-in-[0.97] data-[state=closed]:animate-out data-[state=closed]:fade-out-0 data-[state=closed]:zoom-out-[0.97]",
          className,
        )}
        {...props}
      />
    </AlertDialogPrimitive.Portal>
  );
}

export function AlertDialogHeader({ className, ...props }: ComponentProps<"div">) {
  return <div className={cn("flex flex-col gap-2", className)} {...props} />;
}

export function AlertDialogFooter({ className, ...props }: ComponentProps<"div">) {
  return <div className={cn("flex flex-col-reverse gap-2 sm:flex-row sm:justify-end", className)} {...props} />;
}

export function AlertDialogTitle({
  className,
  ...props
}: ComponentProps<typeof AlertDialogPrimitive.Title>) {
  return (
    <AlertDialogPrimitive.Title
      className={cn("text-sekcja font-semibold tracking-[-0.02em]", className)}
      {...props}
    />
  );
}

export function AlertDialogDescription({
  className,
  ...props
}: ComponentProps<typeof AlertDialogPrimitive.Description>) {
  return (
    <AlertDialogPrimitive.Description
      className={cn("text-meta leading-relaxed text-tekst-drugi", className)}
      {...props}
    />
  );
}

/** Akcja potwierdzająca — domyślnie niszcząca, bo do tego służy ten dialog. */
export function AlertDialogAction({
  className,
  ...props
}: ComponentProps<typeof AlertDialogPrimitive.Action>) {
  return (
    <AlertDialogPrimitive.Action
      className={cn(wariantyPrzycisku({ variant: "destructive" }), className)}
      {...props}
    />
  );
}

export function AlertDialogCancel({
  className,
  ...props
}: ComponentProps<typeof AlertDialogPrimitive.Cancel>) {
  return (
    <AlertDialogPrimitive.Cancel
      className={cn(wariantyPrzycisku({ variant: "outline" }), className)}
      {...props}
    />
  );
}
