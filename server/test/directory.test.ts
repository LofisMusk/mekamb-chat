import { env } from "cloudflare:test";
import { describe, expect, it } from "vitest";

import { availableKeyPackages, consumeKeyPackage, publishKeyPackages } from "../src/directory";

/**
 * Key packages muszą być jednorazowe.
 *
 * Wydanie tego samego dwa razy psuje gwarancje forward secrecy MLS, więc
 * jednokrotność jest wymogiem bezpieczeństwa, a nie higieną danych.
 */

function pakiet(n: number): ArrayBuffer {
  return new TextEncoder().encode(`key-package-${n}`).buffer as ArrayBuffer;
}

/**
 * Zakłada świeże urządzenie o unikalnym identyfikatorze.
 *
 * Baza D1 jest współdzielona w obrębie pliku testowego, więc każdy test musi
 * pracować na własnych wierszach — inaczej kolejność testów wpływa na wynik.
 */
async function nowe_urzadzenie(): Promise<string> {
  const deviceId = crypto.randomUUID();
  const userId = crypto.randomUUID();
  const now = Date.now();

  await env.DB.prepare(
    "INSERT INTO users (id, username, opaque_record, totp_secret_enc, created_at) VALUES (?, ?, '', '', ?)",
  )
    .bind(userId, `nazwa-${userId}`, now)
    .run();

  await env.DB.prepare(
    `INSERT INTO devices
       (id, user_id, mls_public_key, iroh_node_id, addr_record, addr_signature, created_at, last_seen_at)
     VALUES (?, ?, X'00', 'node', '{}', X'00', ?, ?)`,
  )
    .bind(deviceId, userId, now, now)
    .run();

  return deviceId;
}

describe("key packages", () => {
  it("publikacja zwiększa dostępny zapas", async () => {
    const device = await nowe_urzadzenie();
    await publishKeyPackages(env, device, [pakiet(1), pakiet(2), pakiet(3)]);
    expect(await availableKeyPackages(env, device)).toBe(3);
  });

  it("pobranie zmniejsza zapas i zwraca pakiet", async () => {
    const device = await nowe_urzadzenie();
    await publishKeyPackages(env, device, [pakiet(1), pakiet(2)]);

    const pobrany = await consumeKeyPackage(env, device);

    expect(pobrany).not.toBeNull();
    expect(await availableKeyPackages(env, device)).toBe(1);
  });

  it("wyczerpany zapas zwraca null zamiast pakietu", async () => {
    const device = await nowe_urzadzenie();
    await publishKeyPackages(env, device, [pakiet(1)]);

    expect(await consumeKeyPackage(env, device)).not.toBeNull();
    expect(await consumeKeyPackage(env, device)).toBeNull();
  });

  /**
   * Sedno: przy równoległych żądaniach żaden pakiet nie może zostać wydany
   * dwa razy. Gdyby `consumeKeyPackage` był rozbity na SELECT i UPDATE,
   * ten test by go złapał.
   */
  it("równoległe pobrania nie wydają tego samego pakietu dwa razy", async () => {
    const device = await nowe_urzadzenie();
    const ILE = 5;
    await publishKeyPackages(
      env,
      device,
      Array.from({ length: ILE }, (_, i) => pakiet(i)),
    );

    const pobrane = await Promise.all(
      Array.from({ length: 10 }, () => consumeKeyPackage(env, device)),
    );

    const udane = pobrane.filter((p): p is Uint8Array => p !== null);
    expect(udane).toHaveLength(ILE);

    // Żadne dwa pobrania nie mogą zwrócić tej samej zawartości.
    const unikalne = new Set(udane.map((buf) => new TextDecoder().decode(buf)));
    expect(unikalne.size).toBe(ILE);

    expect(await availableKeyPackages(env, device)).toBe(0);
  });

  it("zapasy różnych urządzeń są rozdzielone", async () => {
    const pierwsze = await nowe_urzadzenie();
    const drugie = await nowe_urzadzenie();
    await publishKeyPackages(env, pierwsze, [pakiet(1)]);

    expect(await availableKeyPackages(env, drugie)).toBe(0);
    expect(await consumeKeyPackage(env, drugie)).toBeNull();
    expect(await availableKeyPackages(env, pierwsze)).toBe(1);
  });
});
