import { describe, expect, it } from "vitest";

import { WYSCIG, odmowaRelaya } from "./relay";

/**
 * Sedno: odmowa, po której commit zostaje przygotowany, psuje CAŁĄ rozmowę —
 * nie tylko dodawanie osoby. Te testy pilnują, kiedy commit ma zostać
 * porzucony, bo pomyłka w tę stronę jest niewidoczna od razu: objawia się
 * dopiero przy następnej wysłanej wiadomości.
 *
 * Niepusty wynik znaczy „porzuć commit i powiedz to użytkownikowi", `null` —
 * „nie ruszaj stanu MLS".
 */
describe("odmowa relaya", () => {
  it("wyścig porzuca commit", () => {
    // 409 znaczy „ktoś był pierwszy": epoka jest zajęta cudzym commitem,
    // a nasz nie ma już szans i musi zniknąć.
    expect(odmowaRelaya(409)).toBe(WYSCIG);
  });

  it("serwer w innej wersji porzuca commit", () => {
    // Tak wyglądała usterka #18: wdrożony Worker wymagał pól, których klient
    // już nie wysyła, i odpowiadał 400. Żądanie nie doszło do relaya, więc
    // epoka jest nietknięta — nasz commit ma zostać porzucony.
    expect(odmowaRelaya(400)).not.toBeNull();
    expect(odmowaRelaya(404)).not.toBeNull();
    expect(odmowaRelaya(400)).toMatch(/starszej wersji/);
  });

  it("wygasła sesja mówi o logowaniu, nie o wersji serwera", () => {
    // Inne wyjście dla użytkownika, więc nie może chować się pod komunikatem
    // o starym serwerze — po nim nikt nie wpadnie, że wystarczy się zalogować.
    expect(odmowaRelaya(401)).toMatch(/zaloguj/i);
    expect(odmowaRelaya(403)).toMatch(/zaloguj/i);
    expect(odmowaRelaya(400)).not.toMatch(/zaloguj/i);
  });

  it("awaria serwera nie rozstrzyga niczego", () => {
    // 5xx nie mówi, czy relay zdążył zająć epokę. Porzucenie commitu byłoby
    // zgadywaniem, a zgadnięcie źle rozjeżdża epokę z resztą grupy na stałe.
    expect(odmowaRelaya(500)).toBeNull();
    expect(odmowaRelaya(502)).toBeNull();
    expect(odmowaRelaya(503)).toBeNull();
  });

  it("żaden komunikat nie mówi językiem serwera", () => {
    // Ekran dostaje zdanie, z którym użytkownik może coś zrobić. „Epoka",
    // „commit" i „relay" nie należą do jego świata.
    for (const status of [400, 401, 403, 404, 409]) {
      const komunikat = odmowaRelaya(status) ?? "";
      expect(komunikat.length).toBeGreaterThan(0);
      expect(komunikat).not.toMatch(/epok|commit|relay|MLS/i);
    }
  });
});
