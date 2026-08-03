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
 * Nie odszyfrowuje commitów i nie potrafi tego zrobić. Widzi nieprzezroczysty
 * bajtowy blob oraz numer epoki, który nadawca deklaruje. Rozstrzyga wyłącznie
 * kolejność — nie treść.
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
        CREATE TABLE IF NOT EXISTS members (
          user_id TEXT PRIMARY KEY
        );
      `);
    });
  }

  /** Bieżąca epoka grupy. Grupa dopiero zakładana jest w epoce 0. */
  epoch(): number {
    const row = this.ctx.storage.sql
      .exec<{ value: number }>("SELECT value FROM state WHERE key = 'epoch'")
      .toArray()[0];
    return row?.value ?? 0;
  }

  members(): string[] {
    return this.ctx.storage.sql
      .exec<{ user_id: string }>("SELECT user_id FROM members")
      .toArray()
      .map((row) => row.user_id);
  }

  /**
   * Przyjmuje commit, jeśli nadawca pracował na aktualnej epoce.
   *
   * Zwraca `accepted: false` wraz z bieżącą epoką, gdy ktoś inny był szybszy.
   * Klient ma wtedy porzucić swój commit (`discard_pending_commit`), przetworzyć
   * cudzy i spróbować ponownie — nigdy nie scalać commitu, którego ten obiekt
   * nie przyjął.
   */
  async submitCommit(
    expectedEpoch: number,
    commit: ArrayBuffer,
  ): Promise<{ accepted: true; epoch: number } | { accepted: false; epoch: number }> {
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

    await this.fanOut(commit);

    return { accepted: true, epoch: next };
  }

  /**
   * Aktualizuje listę członków po zaakceptowanym commicie.
   *
   * Serwer potrzebuje jej wyłącznie do routingu — żeby wiedzieć, do czyich
   * skrzynek rozesłać commit. Nie wynika z niej nic o treści rozmowy.
   */
  async setMembers(userIds: string[]): Promise<void> {
    this.ctx.storage.sql.exec("DELETE FROM members");
    for (const userId of userIds) {
      this.ctx.storage.sql.exec("INSERT INTO members (user_id) VALUES (?)", userId);
    }
  }

  /** Rozsyła commit do skrzynek wszystkich członków grupy. */
  private async fanOut(commit: ArrayBuffer): Promise<void> {
    const members = this.members();

    await Promise.all(
      members.map(async (userId) => {
        const id = this.env.USER_INBOX.idFromName(userId);
        await this.env.USER_INBOX.get(id).deposit(commit);
      }),
    );
  }
}
