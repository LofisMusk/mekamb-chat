import { SELF, env } from "cloudflare:test";
import { describe, expect, it } from "vitest";

import {
  availableKeyPackages,
  consumeKeyPackage,
  lookupDevices,
  publishKeyPackages,
} from "../src/directory";
import { issueToken } from "../src/crypto";

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
       (id, user_id, mls_public_key, transport_key, transport_addresses, addr_signature, created_at, last_seen_at)
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

/**
 * Kolejność urządzeń w katalogu.
 *
 * Sedno: `addMember` w obu klientach bierze z tej listy PIERWSZY wpis
 * i pod niego pobiera key package. Stare wpisy urządzeń nigdy nie znikają
 * (nowa przeglądarka albo wyczyszczone dane witryny to nowe `device_id`), więc
 * bez sortowania zaproszenie trafiało do dawno martwego urządzenia — a wtedy
 * odbiorca nie dołączał do grupy i „wiadomości nie dochodziły" bez żadnego
 * błędu po stronie nadawcy.
 */
describe("katalog urządzeń", () => {
  it("zwraca ostatnio używane urządzenie jako pierwsze", async () => {
    const userId = crypto.randomUUID();
    const username = `nazwa-${userId}`;
    const teraz = Date.now();

    await env.DB.prepare(
      "INSERT INTO users (id, username, opaque_record, totp_secret_enc, created_at) VALUES (?, ?, '', '', ?)",
    )
      .bind(userId, username, teraz)
      .run();

    // Kolejność WSTAWIANIA jest odwrotna do kolejności użycia: martwe
    // urządzenie zakładamy pierwsze, dokładnie tak jak dzieje się to
    // w praktyce po przesiadce na inną przeglądarkę.
    const martwe = "web-stare";
    const zywe = "web-biezace";

    for (const [deviceId, lastSeen] of [
      [martwe, teraz - 30 * 24 * 60 * 60 * 1000],
      [zywe, teraz],
    ] as const) {
      await env.DB.prepare(
        `INSERT INTO devices
           (id, user_id, mls_public_key, transport_key, transport_addresses,
            addr_signature, created_at, last_seen_at)
         VALUES (?, ?, X'00', NULL, NULL, NULL, ?, ?)`,
      )
        .bind(deviceId, userId, teraz, lastSeen)
        .run();
    }

    const urzadzenia = await lookupDevices(env, username);

    expect(urzadzenia).toHaveLength(2);
    expect(urzadzenia[0]!.deviceId).toBe(zywe);
  });
});

/**
 * Kto może publikować key packages pod danym urządzeniem.
 *
 * # Sedno
 *
 * `POST /key-packages/:deviceId` sprawdzał wyłącznie, że wołający ma WAŻNY
 * token — nie że `:deviceId` jest jego. Każde zalogowane konto mogło więc
 * wstrzykiwać pakiety pod cudzy identyfikator: zapchać komuś zapas albo
 * podmienić go na pakiety, których nikt nie odbierze. Przed najgorszym
 * ratowała walidacja u dodającego klienta, ale sam katalog stał otworem.
 *
 * Przy parowaniu drugiego urządzenia przestaje to być teoretyczne, bo cała
 * ścieżka opiera się na pobraniu key package po `deviceId`.
 */
describe("właściciel urządzenia", () => {
  async function konto(): Promise<{ userId: string; deviceId: string; token: string }> {
    const userId = crypto.randomUUID();
    const deviceId = crypto.randomUUID();
    const now = Date.now();

    await env.DB.prepare(
      "INSERT INTO users (id, username, opaque_record, totp_secret_enc, created_at) VALUES (?, ?, '', '', ?)",
    )
      .bind(userId, `nazwa-${userId}`, now)
      .run();

    await env.DB.prepare(
      `INSERT INTO devices
         (id, user_id, mls_public_key, transport_key, transport_addresses, addr_signature, created_at, last_seen_at)
       VALUES (?, ?, X'00', 'node', '{}', X'00', ?, ?)`,
    )
      .bind(deviceId, userId, now, now)
      .run();

    const token = await issueToken(env.TOKEN_SIGNING_KEY, {
      userId,
      deviceId,
      expiresAt: Date.now() + 60_000,
    });

    return { userId, deviceId, token };
  }

  function publikuj(deviceId: string, token: string) {
    return SELF.fetch(`https://mekamb/key-packages/${deviceId}`, {
      method: "POST",
      headers: { Authorization: `Bearer ${token}`, "Content-Type": "application/json" },
      body: JSON.stringify({ keyPackages: [btoa("pakiet")] }),
    });
  }

  it("właściciel publikuje pod swoim urządzeniem", async () => {
    const { deviceId, token } = await konto();

    expect((await publikuj(deviceId, token)).status).toBe(200);
  });

  /** Najważniejszy przypadek: napastnik MA własne konto i własny ważny token. */
  it("cudzy token nie publikuje pod cudzym urządzeniem", async () => {
    const ofiara = await konto();
    const napastnik = await konto();

    expect((await publikuj(ofiara.deviceId, napastnik.token)).status).toBe(403);
    expect(await availableKeyPackages(env, ofiara.deviceId)).toBe(0);
  });

  it("nieistniejące urządzenie odpowiada tak samo jak cudze", async () => {
    const { token } = await konto();

    // Rozróżnienie mówiłoby pytającemu, które identyfikatory istnieją.
    expect((await publikuj(crypto.randomUUID(), token)).status).toBe(403);
  });
});

/**
 * Wykreślanie urządzenia z katalogu.
 *
 * # Czego ta trasa NIE robi
 *
 * Nie odbiera dostępu do rozmów — skład grupy żyje w drzewie MLS, którego
 * serwer nie zna. To robi klient commitem. Ta trasa tylko sprawia, że nikt już
 * tego urządzenia nigdzie nie doda; wywołana sama, zostawiłaby zgubiony sprzęt
 * czytającym wszystko, co przyjdzie.
 */
describe("wykreślenie urządzenia", () => {
  async function konto(): Promise<{ deviceId: string; token: string }> {
    const userId = crypto.randomUUID();
    const deviceId = crypto.randomUUID();
    const now = Date.now();

    await env.DB.prepare(
      "INSERT INTO users (id, username, opaque_record, totp_secret_enc, created_at) VALUES (?, ?, '', '', ?)",
    )
      .bind(userId, `nazwa-${userId}`, now)
      .run();

    await env.DB.prepare(
      `INSERT INTO devices
         (id, user_id, mls_public_key, transport_key, transport_addresses, addr_signature, created_at, last_seen_at)
       VALUES (?, ?, X'00', 'node', '{}', X'00', ?, ?)`,
    )
      .bind(deviceId, userId, now, now)
      .run();

    const token = await issueToken(env.TOKEN_SIGNING_KEY, {
      userId,
      deviceId,
      expiresAt: Date.now() + 60_000,
    });

    return { deviceId, token };
  }

  function usun(deviceId: string, token: string) {
    return SELF.fetch(`https://mekamb/devices/${deviceId}`, {
      method: "DELETE",
      headers: { Authorization: `Bearer ${token}` },
    });
  }

  it("właściciel wykreśla swoje urządzenie", async () => {
    const { deviceId, token } = await konto();

    expect((await usun(deviceId, token)).status).toBe(200);
  });

  /**
   * Zapas zostawiony po skasowanym urządzeniu byłby wydawany każdemu, kto
   * o niego poprosi, i wprowadzałby do rozmów liść, którego nikt już nie
   * obsłuży.
   */
  it("zabiera ze sobą zapas key packages", async () => {
    const { deviceId, token } = await konto();
    await publishKeyPackages(env, deviceId, [pakiet(1), pakiet(2)]);
    expect(await availableKeyPackages(env, deviceId)).toBe(2);

    await usun(deviceId, token);

    expect(await consumeKeyPackage(env, deviceId)).toBeNull();
  });

  it("cudze urządzenie zostaje nietknięte", async () => {
    const ofiara = await konto();
    const napastnik = await konto();

    expect((await usun(ofiara.deviceId, napastnik.token)).status).toBe(403);
    expect(await lookupDevices(env, `nazwa-x`)).toEqual([]);
    // Urządzenie ofiary nadal przyjmuje key packages, czyli nadal istnieje.
    await publishKeyPackages(env, ofiara.deviceId, [pakiet(9)]);
    expect(await availableKeyPackages(env, ofiara.deviceId)).toBe(1);
  });
});
