import { SELF, env } from "cloudflare:test";
import { describe, expect, it } from "vitest";

import { issueToken } from "../src/crypto";

/**
 * Tokeny doręczeniowe — sealed sender.
 *
 * # Sedno
 *
 * Nadanie do skrzynki nie może zdradzać, KTO nadaje, ale musi dowodzić, że
 * nadający ma do tego prawo. Serwer wydaje token na wartość **oślepioną**, więc
 * przy wydaniu nie widzi, co wydał, a przy realizacji nie widzi, komu.
 *
 * Gdyby którakolwiek z tych własności padła, schemat wyglądałby na sealed
 * sender, nie będąc nim — a to gorsze niż jego brak, bo daje złudzenie ochrony.
 */

async function zalogowany() {
  const userId = crypto.randomUUID();
  const username = `nadawca-${userId.slice(0, 8)}`;

  await env.DB.prepare(
    "INSERT INTO users (id, username, opaque_record, totp_secret_enc, created_at) VALUES (?, ?, '', '', ?)",
  )
    .bind(userId, username, Date.now())
    .run();

  const bearer = await issueToken(env.TOKEN_SIGNING_KEY, {
    userId,
    deviceId: "test",
    expiresAt: Date.now() + 60_000,
  });

  return { username, bearer };
}

function wydaj(bearer: string, blinded: string[]) {
  return SELF.fetch("https://mekamb/tokens/issue", {
    method: "POST",
    headers: { Authorization: `Bearer ${bearer}`, "Content-Type": "application/json" },
    body: JSON.stringify({ blinded }),
  });
}

/** 32 bajty, które NIE są poprawnym punktem grupy — do prób negatywnych. */
const SMIECI = btoa(String.fromCharCode(...new Uint8Array(32).fill(0xff)));

describe("wydawanie tokenów", () => {
  it("klucz publiczny jest dostępny bez logowania", async () => {
    // Klient musi go mieć, zanim cokolwiek weźmie — i musi to być TEN SAM
    // klucz dla wszystkich, inaczej serwer znakowałby użytkowników.
    const odpowiedz = await SELF.fetch("https://mekamb/tokens/key");
    expect(odpowiedz.status).toBe(200);

    const { publicKey } = await odpowiedz.json<{ publicKey: string }>();
    expect(atob(publicKey)).toHaveLength(32);
  });

  it("klucz publiczny nie zmienia się między wywołaniami", async () => {
    const a = await (await SELF.fetch("https://mekamb/tokens/key")).json<{ publicKey: string }>();
    const b = await (await SELF.fetch("https://mekamb/tokens/key")).json<{ publicKey: string }>();

    expect(a.publicKey).toBe(b.publicKey);
  });

  it("wydanie wymaga zalogowania", async () => {
    // To jedyne miejsce, w którym serwer wie, komu wydaje — i musi wiedzieć,
    // bo inaczej nie ma czego limitować.
    const odpowiedz = await SELF.fetch("https://mekamb/tokens/issue", {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({ blinded: [] }),
    });

    expect(odpowiedz.status).toBe(401);
  });

  it("pusta lista jest odrzucana", async () => {
    const { bearer } = await zalogowany();
    expect((await wydaj(bearer, [])).status).toBe(400);
  });

  it("nadmiarowa prośba jest odrzucana", async () => {
    // Bez górnego limitu jedno żądanie wydawałoby zapas na zawsze, a limit
    // wydawania jest jedyną dźwignią przeciw zalewaniu skrzynek.
    const { bearer } = await zalogowany();
    const duzo = Array.from({ length: 51 }, () => SMIECI);

    expect((await wydaj(bearer, duzo)).status).toBe(400);
  });

  it("oślepiona wartość spoza grupy jest odrzucana, a nie wywraca żądania", async () => {
    const { bearer } = await zalogowany();
    expect((await wydaj(bearer, [SMIECI])).status).toBe(400);
  });
});

describe("nadanie z tokenem", () => {
  it("token podrobiony jest odrzucany", async () => {
    const ziarno = btoa(String.fromCharCode(...new Uint8Array(32).fill(7)));

    const odpowiedz = await SELF.fetch("https://mekamb/inbox/ktos", {
      method: "POST",
      headers: { "X-Delivery-Token": `${ziarno}.${SMIECI}` },
      body: new Uint8Array([1, 2, 3]),
    });

    expect(odpowiedz.status).toBe(403);
  });

  it("token o złym kształcie jest odrzucany", async () => {
    const odpowiedz = await SELF.fetch("https://mekamb/inbox/ktos", {
      method: "POST",
      headers: { "X-Delivery-Token": "bez-kropki" },
      body: new Uint8Array([1, 2, 3]),
    });

    expect(odpowiedz.status).toBe(400);
  });

  /*
   * Sedno: bez wymuszania nadanie bez tokenu MUSI przechodzić.
   *
   * Wymuszanie jest osobną decyzją od wydawania, bo między wdrożeniem serwera
   * a aktualizacją klientów musi zmieścić się okno. Gdyby serwer zaczął
   * odmawiać od razu, aktualizacja odcięłaby wszystkich ze starą aplikacją.
   */
  it("bez wymuszania nadanie bez tokenu przechodzi", async () => {
    const odpowiedz = await SELF.fetch("https://mekamb/inbox/odbiorca-bez-tokenu", {
      method: "POST",
      body: new Uint8Array([1, 2, 3]),
    });

    expect(odpowiedz.status).toBe(200);
  });
});

/**
 * Sedno: token jest JEDNORAZOWY.
 *
 * Bez tego jeden wydany token wystarczyłby na dowolną liczbę nadań i cała
 * ochrona przed zalewaniem skrzynek byłaby pozorna. Sprawdzamy to na poziomie
 * magazynu, bo pełne koło wymaga strony klienta — a ta liczy Ristretto, którego
 * w tym środowisku testowym nie ma.
 */
describe("zużycie tokenu", () => {
  it("drugi zapis tego samego ziarna nie przechodzi", async () => {
    const ziarno = crypto.randomUUID();

    const pierwszy = await env.DB.prepare(
      "INSERT OR IGNORE INTO spent_tokens (seed, spent_at) VALUES (?, ?)",
    )
      .bind(ziarno, Date.now())
      .run();

    const drugi = await env.DB.prepare(
      "INSERT OR IGNORE INTO spent_tokens (seed, spent_at) VALUES (?, ?)",
    )
      .bind(ziarno, Date.now())
      .run();

    expect(pierwszy.meta.changes).toBe(1);
    expect(drugi.meta.changes).toBe(0);
  });

  it("tabela zużytych nie ma nic o nadawcy", async () => {
    // Gdyby miała, serwer odzyskałby dokładnie tę informację, którą cały
    // schemat ukrywa — i lepiej byłoby nie mieć go wcale.
    const kolumny = await env.DB.prepare("PRAGMA table_info(spent_tokens)").all<{ name: string }>();
    const nazwy = kolumny.results.map((k) => k.name);

    expect(nazwy).toEqual(["seed", "spent_at"]);
  });
});
