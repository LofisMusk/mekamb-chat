import { DurableObject } from "cloudflare:workers";

import type { Env } from "./env";

/**
 * `GroupRelay` — autorytatywna kolejność commitów MLS.
 *
 * # Po co to w ogóle istnieje
 *
 * Wiadomości aplikacyjne są w obrębie epoki przemienne, więc mogą lecieć wprost
 * między urządzeniami i ten obiekt ich nie widzi. **Commity** są inne: każdy
 * podnosi epokę grupy o jeden. Jeśli Alice i Bob jednocześnie kogoś dodadzą,
 * powstaną dwa różne commity dla tej samej epoki — i bez rozstrzygnięcia, który
 * jest pierwszy, grupa rozpadłaby się na dwie niezgodne gałęzie.
 *
 * Durable Object jest **jednowątkowy i jedyny w swoim rodzaju** dla danego
 * identyfikatora. Dwa równoległe żądania są tu obsługiwane po kolei, nie
 * współbieżnie, więc porównanie epoki i jej zwiększenie są niepodzielne bez
 * żadnych blokad. To jedyny powód, dla którego ta część systemu nie jest P2P.
 *
 * # Czego ten obiekt NIE robi
 *
 * Nie odszyfrowuje commitów i nie potrafi tego zrobić. Rozstrzyga wyłącznie
 * kolejność — nie treść.
 *
 * **Nie zna też składu grupy.** Wcześniej trzymał listę członków, bo sam
 * rozsyłał commity do ich skrzynek — i była to jedyna w systemie struktura
 * mówiąca serwerowi, kto z kim rozmawia. Dziś rozsyła nadawca, który skład
 * i tak zna z drzewa MLS; serwer widzi tylko rosnący licznik przy
 * nieprzezroczystym identyfikatorze. Nie widzi nawet samego commitu: ten idzie
 * do skrzynek osobnym żądaniem, nie tędy.
 */
export class GroupRelay extends DurableObject<Env> {
  constructor(ctx: DurableObjectState, env: Env) {
    super(ctx, env);

    ctx.blockConcurrencyWhile(async () => {
      this.ctx.storage.sql.exec(`
        CREATE TABLE IF NOT EXISTS state (
          key   TEXT PRIMARY KEY,
          value INTEGER NOT NULL
        );
      `);

      // Skład grupy leżał tu do wersji, która przeniosła rozsyłkę do nadawcy.
      // Kasujemy go, bo dane, których nie potrzebujemy, a które trzymamy, są
      // po prostu wyciekiem czekającym na okazję.
      this.ctx.storage.sql.exec("DROP TABLE IF EXISTS members");
    });
  }

  /** Bieżąca epoka grupy. Grupa dopiero zakładana jest w epoce 0. */
  epoch(): number {
    const row = this.ctx.storage.sql
      .exec<{ value: number }>("SELECT value FROM state WHERE key = 'epoch'")
      .toArray()[0];
    return row?.value ?? 0;
  }

  /**
   * Zajmuje kolejną epokę, jeśli nadawca pracował na aktualnej.
   *
   * Zwraca `accepted: false` wraz z bieżącą epoką, gdy ktoś inny był szybszy.
   * Klient ma wtedy porzucić swój commit (`discard_pending_commit`), przetworzyć
   * cudzy i spróbować ponownie — nigdy nie scalać commitu, którego ten obiekt
   * nie przyjął.
   *
   * # Dlaczego nie przechodzi tędy sam commit
   *
   * Bo nie musi. Ten obiekt rozstrzyga wyłącznie kolejność, a rozesłanie
   * commitu do skrzynek robi nadawca — zna skład grupy z drzewa MLS, więc
   * serwer nie ma powodu go znać. Przepuszczanie koperty tędy dawało serwerowi
   * dokładnie jedno: listę osób w rozmowie.
   */
  claimEpoch(
    expectedEpoch: number,
  ): { accepted: true; epoch: number } | { accepted: false; epoch: number } {
    const current = this.epoch();

    // Sedno całego mechanizmu. Sprawdzenie i zwiększenie epoki zachodzą w tym
    // samym, niepodzielnym wykonaniu — obiekt nie obsłuży w tym czasie innego
    // żądania, więc nie ma tu wyścigu do wygrania.
    if (expectedEpoch !== current) {
      return { accepted: false, epoch: current };
    }

    const next = current + 1;
    this.ctx.storage.sql.exec(
      "INSERT INTO state (key, value) VALUES ('epoch', ?) ON CONFLICT(key) DO UPDATE SET value = ?",
      next,
      next,
    );

    return { accepted: true, epoch: next };
  }
}
