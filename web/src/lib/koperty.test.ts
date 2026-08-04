import { describe, expect, it } from "vitest";

import {
  PROB_PRZED_ODRZUCENIEM,
  type LicznikProb,
  poNiepowodzeniu,
  poSukcesie,
} from "./koperty";

function licznik(): LicznikProb {
  return new Map();
}

describe("koperta po nieudanym przetworzeniu", () => {
  /// Sedno pierwszej połowy: koperta nie może zostać skasowana za pierwszym
  /// razem, bo mogła tylko wyprzedzić commit, który jest jej potrzebny.
  it("pierwsza nieudana próba zostawia kopertę w kolejce", () => {
    expect(poNiepowodzeniu(licznik(), "7")).toEqual({ rodzaj: "ponow" });
  });

  /// Sedno drugiej połowy: koperta, której nigdy nie da się przetworzyć,
  /// musi w końcu zniknąć z kolejki — inaczej wraca przy każdym połączeniu.
  it("po ustalonej liczbie prób koperta jest odrzucana", () => {
    const l = licznik();

    for (let i = 1; i < PROB_PRZED_ODRZUCENIEM; i++) {
      expect(poNiepowodzeniu(l, "7")).toEqual({ rodzaj: "ponow" });
    }

    expect(poNiepowodzeniu(l, "7")).toEqual({ rodzaj: "odrzuc" });
  });

  it("koperta krąży dokładnie tyle razy, ile wynosi limit", () => {
    const l = licznik();
    let obiegi = 0;

    while (poNiepowodzeniu(l, "7").rodzaj === "ponow") {
      obiegi++;
      expect(obiegi).toBeLessThan(100); // zabezpieczenie przed pętlą bez końca
    }

    expect(obiegi).toBe(PROB_PRZED_ODRZUCENIEM - 1);
  });

  /// Koperty są liczone osobno — jedna uszkodzona nie może wypchnąć zdrowej.
  it("próby jednej koperty nie wpływają na inne", () => {
    const l = licznik();

    for (let i = 0; i < PROB_PRZED_ODRZUCENIEM; i++) {
      poNiepowodzeniu(l, "uszkodzona");
    }

    expect(poNiepowodzeniu(l, "zdrowa")).toEqual({ rodzaj: "ponow" });
  });

  /// Koperta, która przeszła za drugim razem, zaczyna od zera przy kolejnym
  /// niepowodzeniu — inaczej pojedyncze potknięcia sumowałyby się przez całe
  /// życie połączenia i w końcu skasowałyby dobrą wiadomość.
  it("udane przetworzenie zeruje licznik", () => {
    const l = licznik();

    poNiepowodzeniu(l, "7");
    poNiepowodzeniu(l, "7");
    poSukcesie(l, "7");

    expect(poNiepowodzeniu(l, "7")).toEqual({ rodzaj: "ponow" });
  });

  /// Identyfikatory kolejki rosną bez końca, więc wpisy muszą znikać —
  /// zarówno po sukcesie, jak i po odrzuceniu.
  it("licznik nie rośnie w nieskończoność", () => {
    const l = licznik();

    for (let id = 0; id < 500; id++) {
      poNiepowodzeniu(l, String(id));
      poSukcesie(l, String(id));
    }

    for (let id = 500; id < 1000; id++) {
      for (let i = 0; i < PROB_PRZED_ODRZUCENIEM; i++) {
        poNiepowodzeniu(l, String(id));
      }
    }

    expect(l.size).toBe(0);
  });
});
