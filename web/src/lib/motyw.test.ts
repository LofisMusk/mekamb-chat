import { readFileSync } from "node:fs";
import { fileURLToPath } from "node:url";
import { dirname, join } from "node:path";

import { describe, expect, it } from "vitest";

import { TLO, rozwin, wczytajWybor, zapiszWybor, zastosuj } from "./motyw";

const ARKUSZ = readFileSync(
  join(dirname(fileURLToPath(import.meta.url)), "..", "styles.css"),
  "utf8",
);

/** Deklaracje z bloku zaczynającego się podanym selektorem, znormalizowane. */
function deklaracje(selektor: string): string[] {
  const poczatek = ARKUSZ.indexOf(selektor);
  expect(poczatek, `nie ma bloku ${selektor}`).toBeGreaterThan(-1);

  const otwarcie = ARKUSZ.indexOf("{", poczatek);
  const zamkniecie = ARKUSZ.indexOf("}", otwarcie);

  return ARKUSZ.slice(otwarcie + 1, zamkniecie)
    // Komentarze wylatują: inaczej doklejają się do następnej deklaracji
    // i „--tlo" przestaje zaczynać się od myślników.
    .replace(/\/\*[\s\S]*?\*\//g, "")
    .split(";")
    .map((d) => d.trim().replace(/\s+/g, " "))
    .filter(Boolean);
}

/*
 * Sedno: paleta jasna jest w arkuszu dwa razy, więc musi być pilnowana.
 *
 * Powtórzenie nie jest niedopatrzeniem — polityka bezpieczeństwa treści nie
 * dopuszcza skryptów inline, więc przed startem skryptu motyw może wybrać tylko
 * `@media (prefers-color-scheme)`. Reguły z warunkiem `@media` nie da się scalić
 * z regułą po atrybucie, a bez tej pierwszej użytkownik z jasnym systemem widzi
 * ciemny błysk przy każdym uruchomieniu.
 *
 * Ceną jest kopia, której nikt nie zauważy okiem: różnica jednego odcienia
 * między „motyw wybrany ręcznie" a „motyw z systemu" nie rzuca się w oczy,
 * dopóki ktoś nie postawi obok siebie dwóch urządzeń.
 */
describe("paleta jasna", () => {
  it("obie kopie są identyczne", () => {
    expect(deklaracje(':root:not([data-motyw])')).toEqual(deklaracje(':root[data-motyw="jasny"]'));
  });

  it("każda rola z motywu ciemnego ma odpowiednik w jasnym", () => {
    // Rola bez odpowiednika nie jest błędem składni — dziedziczy wartość
    // z motywu ciemnego, więc w jasnym zostaje ciemna plama w jednym miejscu.
    const role = (bloki: string[]) =>
      bloki.filter((d) => d.startsWith("--")).map((d) => d.split(":")[0]);

    const ciemny = role(deklaracje(":root {"));
    const jasny = role(deklaracje(':root[data-motyw="jasny"]'));

    expect(jasny.sort()).toEqual(ciemny.sort());
  });
});

/*
 * Sedno: kolor paska systemowego pochodzi z tej samej wartości co tło.
 *
 * `theme-color` ustawiamy z JavaScriptu, a `--tlo` z arkusza. Rozjazd widać
 * jako ciemną belkę nad jasną aplikacją — na iPhonie w trybie PWA na całą
 * szerokość ekranu.
 */
describe("kolor tła", () => {
  it("zgadza się z arkuszem", () => {
    expect(deklaracje(":root {")).toContain(`--tlo: ${TLO.ciemny}`);
    expect(deklaracje(':root[data-motyw="jasny"]')).toContain(`--tlo: ${TLO.jasny}`);
  });
});

describe("rozwinięcie wyboru", () => {
  it("wybór jawny nie zależy od systemu", () => {
    expect(rozwin("ciemny", true)).toBe("ciemny");
    expect(rozwin("jasny", false)).toBe("jasny");
  });

  it("wybór „za systemem” idzie za systemem", () => {
    expect(rozwin("auto", true)).toBe("jasny");
    expect(rozwin("auto", false)).toBe("ciemny");
  });
});

describe("zapamiętany wybór", () => {
  function magazyn(wartosc: string | null) {
    return { getItem: () => wartosc };
  }

  it("czyta zapisany wybór", () => {
    expect(wczytajWybor(magazyn("jasny"))).toBe("jasny");
    expect(wczytajWybor(magazyn("auto"))).toBe("auto");
  });

  it("cokolwiek innego znaczy ciemny", () => {
    // Wartość spoza zbioru bierze się z ręcznej edycji albo starszego wydania.
    // Ciemny jest domyślny w tym systemie, więc to bezpieczny powrót.
    expect(wczytajWybor(magazyn(null))).toBe("ciemny");
    expect(wczytajWybor(magazyn("niebieski"))).toBe("ciemny");
  });

  it("brak dostępu do magazynu nie wywraca startu", () => {
    // Prywatne okno Safari potrafi rzucić przy samym odczycie. Motyw jest
    // ustawieniem kosmetycznym — nie może zatrzymać uruchomienia aplikacji.
    const rzucajacy = {
      getItem() {
        throw new Error("brak dostępu");
      },
      setItem() {
        throw new Error("brak dostępu");
      },
    };

    expect(wczytajWybor(rzucajacy)).toBe("ciemny");
    expect(() => zapiszWybor("jasny", rzucajacy)).not.toThrow();
  });
});

describe("zastosowanie motywu", () => {
  it("ustawia atrybut, schemat kolorów i kolor paska systemowego", () => {
    const meta = { content: "", setAttribute(_: string, v: string) { this.content = v; } };
    const dokument = {
      documentElement: { dataset: {} as Record<string, string>, style: { colorScheme: "" } },
      querySelector: () => meta,
    } as unknown as Document;

    zastosuj("jasny", dokument);

    expect(dokument.documentElement.dataset.motyw).toBe("jasny");
    expect(dokument.documentElement.style.colorScheme).toBe("light");
    expect(meta.content).toBe(TLO.jasny);
  });
});
