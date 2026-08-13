import { readFileSync } from "node:fs";
import { fileURLToPath } from "node:url";
import { dirname, join } from "node:path";

import { describe, expect, it } from "vitest";

/**
 * Strona dymka nie może zależeć od kolejności reguł w arkuszu.
 *
 * # Czemu ten test istnieje
 *
 * Reguła ogólna dymka (`.wiadomosci li:not(…)`) i reguła własnej wiadomości
 * (`.wiadomosci li.wlasna`) ustawiają te same własności: wyrównanie, tło,
 * promienie. Dopóki ta druga jest CO NAJMNIEJ tak szczegółowa, wygrywa i własne
 * wiadomości stoją po prawej. Gdy pierwsza ją przeskoczy, wszystkie dymki
 * ustawiają się po lewej i tracą swój kolor — a reguła `.wlasna` wygląda przy
 * tym na nietkniętą, więc szuka się przyczyny wszędzie indziej.
 *
 * Zdarzyło się to przy dokładaniu śladu po rozmowie: `:not(.dzien)` urosło do
 * `:not(.dzien):not(.zdarzenie)`, czyli o jedną klasę w wadze. Poprawką jest
 * jeden `:not` z listą — `:not(.dzien, .zdarzenie)` — którego waga to waga
 * najcięższego argumentu, a nie ich suma.
 *
 * Okiem tego nie widać w kodzie; widać dopiero na zrzucie ekranu.
 */

const ARKUSZ = readFileSync(
  join(dirname(fileURLToPath(import.meta.url)), "..", "styles.css"),
  "utf8",
);

/**
 * Waga selektora jako `[identyfikatory, klasy, elementy]`.
 *
 * Liczy tyle, ile trzeba dla selektorów z tego arkusza: klasy, elementy
 * i `:not()`. Zgodnie ze specyfikacją `:not()` waży tyle, co jego najcięższy
 * argument — i to jest dokładnie ta reguła, której pilnuje ten plik.
 */
function waga(selektor: string): [number, number, number] {
  let reszta = selektor;
  const zNotow: [number, number, number] = [0, 0, 0];

  /*
   * Maksimum WEWNĄTRZ jednego `:not()`, suma MIĘDZY kolejnymi.
   *
   * To jest cała różnica, o którą chodzi: `:not(a, b)` waży tyle co cięższe
   * z dwojga, a `:not(a):not(b)` tyle co oba razem. Liczenie maksimum przez
   * wszystkie wystąpienia naraz zrównałoby jedno z drugim i test przestałby
   * cokolwiek sprawdzać.
   */
  reszta = reszta.replace(/:not\(([^)]*)\)/g, (_, srodek: string) => {
    let najciezszy: [number, number, number] = [0, 0, 0];

    for (const argument of srodek.split(",")) {
      const w = waga(argument.trim());
      if (mniejsza(najciezszy, w)) najciezszy = w;
    }

    for (let i = 0; i < 3; i++) zNotow[i] = (zNotow[i] ?? 0) + (najciezszy[i] ?? 0);
    return " ";
  });

  const klasy = (reszta.match(/\.[a-z0-9_-]+/gi) ?? []).length;
  const identyfikatory = (reszta.match(/#[a-z0-9_-]+/gi) ?? []).length;
  const elementy = (reszta.match(/(^|[\s>+~])[a-z][a-z0-9]*/gi) ?? []).length;

  return [
    identyfikatory + (zNotow[0] ?? 0),
    klasy + (zNotow[1] ?? 0),
    elementy + (zNotow[2] ?? 0),
  ];
}

/** Czy `a` jest mniej szczegółowa niż `b`. */
function mniejsza(a: [number, number, number], b: [number, number, number]): boolean {
  for (let i = 0; i < 3; i++) {
    if ((a[i] ?? 0) !== (b[i] ?? 0)) return (a[i] ?? 0) < (b[i] ?? 0);
  }
  return false;
}

/**
 * Wszystkie reguły arkusza jako pary selektor–treść.
 *
 * Szukanie po samej deklaracji nie wystarcza i jest to pułapka, w którą ten
 * test wpadł przy pierwszym podejściu: `align-self: flex-start` występuje
 * w arkuszu kilka razy, a pierwsze trafienie to `.ostrzezenie button` — czyli
 * test porównywał wagi dwóch niezwiązanych ze sobą reguł i przechodził także
 * wtedy, gdy usterka była na miejscu.
 */
function reguly(): { selektor: string; tresc: string }[] {
  const bezKomentarzy = ARKUSZ.replace(/\/\*[\s\S]*?\*\//g, "");
  const znalezione: { selektor: string; tresc: string }[] = [];

  for (const [, selektor, tresc] of bezKomentarzy.matchAll(/([^{}]+)\{([^{}]*)\}/g)) {
    znalezione.push({
      selektor: (selektor ?? "").replace(/\s+/g, " ").trim(),
      tresc: tresc ?? "",
    });
  }

  return znalezione;
}

/** Selektor reguły dotyczącej dymków, która ustawia podaną deklarację. */
function selektorDymka(deklaracja: string): string {
  const pasujace = reguly().filter(
    (r) => r.selektor.startsWith(".wiadomosci li") && r.tresc.includes(deklaracja),
  );

  expect(pasujace, `żadna reguła dymka nie ustawia ${deklaracja}`).not.toHaveLength(0);
  return pasujace[0]!.selektor;
}

describe("strony dymków", () => {
  it("reguła własnej wiadomości nie jest lżejsza od ogólnej", () => {
    const ogolna = selektorDymka("align-self: flex-start;");
    const wlasna = selektorDymka("align-self: flex-end;");

    // Sedno: to porównanie, a nie kolejność w pliku, decyduje o tym, po której
    // stronie stoi własna wiadomość.
    expect(
      mniejsza(waga(wlasna), waga(ogolna)),
      `„${wlasna}" (${waga(wlasna)}) przegrywa z „${ogolna}" (${waga(ogolna)}) — ` +
        "własne wiadomości ustawią się po lewej i stracą swój kolor",
    ).toBe(false);
  });

  it("wyliczanie wagi zna regułę :not z listą", () => {
    // Dwa `:not` sumują się…
    expect(waga(".wiadomosci li:not(.dzien):not(.zdarzenie)")).toEqual([0, 3, 1]);
    // …a jeden `:not` z listą waży tyle, co jego najcięższy argument.
    expect(waga(".wiadomosci li:not(.dzien, .zdarzenie)")).toEqual([0, 2, 1]);
    // Tyle samo, co reguła własnej wiadomości — i dlatego wygrywa ta późniejsza.
    expect(waga(".wiadomosci li.wlasna")).toEqual([0, 2, 1]);
  });
});
