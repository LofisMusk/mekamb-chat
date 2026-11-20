import { Avatar as AvatarPrimitive } from "radix-ui";

import { cn } from "./cn";

const ROZMIARY = {
  xs: "size-7 text-[11px]",
  sm: "size-8 text-podpis",
  md: "size-10 text-meta",
  lg: "size-12 text-tresc",
  xl: "size-20 text-[28px]",
} as const;

/**
 * Awatar: inicjał na `wglebienie-mocne`, okrąg.
 *
 * Bez kolorów przypisanych osobom: kolor w tej palecie jest zarezerwowany dla
 * stanów, a „zielony Adam" obok „zielonego: zweryfikowano" mówiłby dwie różne
 * rzeczy tym samym językiem. Zdjęć nie ma, bo nie ma ich gdzie trzymać —
 * serwer nie przechowuje niczego, co da się obejrzeć.
 */
export function Awatar({
  nazwa,
  rozmiar = "md",
  className,
}: {
  nazwa: string;
  rozmiar?: keyof typeof ROZMIARY;
  className?: string;
}) {
  return (
    <AvatarPrimitive.Root
      aria-hidden="true"
      className={cn("relative flex shrink-0 overflow-hidden rounded-full", ROZMIARY[rozmiar], className)}
    >
      <AvatarPrimitive.Fallback className="flex size-full items-center justify-center rounded-full bg-wglebienie-mocne font-medium text-tekst uppercase leading-none">
        {inicjal(nazwa)}
      </AvatarPrimitive.Fallback>
    </AvatarPrimitive.Root>
  );
}

/** Pierwszy znak NAZWY, a nie pierwszy kod UTF-16 — „Łukasz" i emoji też. */
function inicjal(nazwa: string): string {
  const [pierwszy] = Array.from(nazwa.trim());
  return pierwszy ?? "?";
}
