import type { ReactNode } from "react";

import { SZEROKI, useSzerokosc } from "../../lib/szerokosc";
import { cn } from "./cn";
import { Dialog, DialogContent, DialogDescription, DialogHeader, DialogTitle } from "./dialog";
import { Drawer, DrawerContent, DrawerDescription, DrawerHeader, DrawerTitle } from "./drawer";

/**
 * Jedno okno, dwie postacie: dialog na desktopie, arkusz od dołu na telefonie.
 *
 * # Dlaczego wspólny komponent
 *
 * Bo treść jest ta sama, a różni się tylko to, skąd przychodzi. Dwa osobne
 * komponenty w każdym miejscu użycia rozjeżdżają się przy pierwszej poprawce
 * jednego z nich; tu decyzja „który" zapada raz, po szerokości okna.
 */
export function Arkusz({
  otwarty,
  onZmiana,
  tytul,
  opis,
  children,
  stopka,
  className,
}: {
  otwarty: boolean;
  onZmiana: (otwarty: boolean) => void;
  tytul: string;
  opis?: ReactNode;
  children: ReactNode;
  /** Przyciski na dole — na telefonie przyklejone pod treścią, w zasięgu kciuka. */
  stopka?: ReactNode;
  className?: string;
}) {
  const szeroki = useSzerokosc(SZEROKI);

  // Bez opisu mówimy to Radiksowi wprost; inaczej ostrzega w konsoli, że
  // okno nie ma czym się przedstawić czytnikowi ekranu.
  const bezOpisu = opis ? {} : { "aria-describedby": undefined };

  if (szeroki) {
    return (
      <Dialog open={otwarty} onOpenChange={onZmiana}>
        <DialogContent className={className} {...bezOpisu}>
          <DialogHeader>
            <DialogTitle>{tytul}</DialogTitle>
            {opis && <DialogDescription>{opis}</DialogDescription>}
          </DialogHeader>
          {children}
          {stopka && <div className="flex justify-end gap-2">{stopka}</div>}
        </DialogContent>
      </Dialog>
    );
  }

  return (
    <Drawer open={otwarty} onOpenChange={onZmiana}>
      <DrawerContent {...bezOpisu}>
        <DrawerHeader>
          <DrawerTitle>{tytul}</DrawerTitle>
          {opis && <DrawerDescription>{opis}</DrawerDescription>}
        </DrawerHeader>
        <div className={cn("flex min-h-0 flex-col gap-4 overflow-y-auto px-4 pb-2", className)}>
          {children}
        </div>
        {stopka && <div className="flex flex-col-reverse gap-2 p-4 [&>*]:w-full">{stopka}</div>}
      </DrawerContent>
    </Drawer>
  );
}
