import { useState, useEffect } from "react";
import {
  CommandDialog,
  CommandEmpty,
  CommandGroup,
  CommandInput,
  CommandItem,
  CommandList,
  CommandSeparator,
} from "cmdk";
import { t } from "./lib/jezyk";

interface RozmowaOption {
  id: string;
  nazwa: string;
  ostatnia?: string;
}

export function Polecenia({
  otwarte,
  rozmowy,
  onSelectRozmowe,
  onZamknij,
}: {
  otwarte: boolean;
  rozmowy: RozmowaOption[];
  onSelectRozmowe: (id: string) => void;
  onZamknij: () => void;
}) {
  const [query, setQuery] = useState("");

  useEffect(() => {
    if (!otwarte) setQuery("");
  }, [otwarte]);

  const filtrowaneRozmowy = rozmowy.filter((r) =>
    r.nazwa.toLowerCase().includes(query.toLowerCase()) ||
    (r.ostatnia && r.ostatnia.toLowerCase().includes(query.toLowerCase()))
  );

  return (
    <CommandDialog open={otwarte} onOpenChange={(o: boolean) => !o && onZamknij()}>
      <CommandInput
        placeholder={t("Szukaj rozmów...", "Search conversations...")}
        value={query}
        onValueChange={setQuery}
      />
      <CommandList>
        <CommandEmpty>{t("Brak wyników.", "No results.")}</CommandEmpty>

        {filtrowaneRozmowy.length > 0 && (
          <>
            <CommandGroup heading="Rozmowy">
              {filtrowaneRozmowy.slice(0, 15).map((r) => (
                <CommandItem
                  key={r.id}
                  value={r.nazwa}
                  onSelect={() => onSelectRozmowe(r.id)}
                >
                  <span className="pole-polecenia-nazwa">{r.nazwa}</span>
                  {r.ostatnia && (
                    <span className="pole-polecenia-ostatnie">{r.ostatnia}</span>
                  )}
                </CommandItem>
              ))}
            </CommandGroup>
            <CommandSeparator />
          </>
        )}

        <CommandGroup heading="Nawigacja">
          <CommandItem onSelect={() => onZamknij()}>
            {t("Wróć do rozmów", "Back to conversations")}
          </CommandItem>
        </CommandGroup>
      </CommandList>
    </CommandDialog>
  );
}
