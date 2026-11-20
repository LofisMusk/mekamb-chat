import { SELF, env } from "cloudflare:test";
import { afterEach, describe, expect, it } from "vitest";

import { base64ToBytes, bytesToBase64 } from "../src/crypto";
import * as opaque from "../src/opaque-wasm/index.js";

/**
 * Tryb deweloperski: rozluźnienia dla testów, wszystkie za flagą TRYB_DEWELOPERSKI.
 *
 * Sedno tych testów: flaga naprawdę COŚ zmienia (2FA znika, /dev/seed działa),
 * a jednocześnie NIE otwiera furtki, której nie chcemy — złe hasło wciąż nie
 * wchodzi, bo OPAQUE nie jest omijane, oraz poza trybem dev endpointy /dev są
 * niewidoczne. Dzięki temu przypadkowe wdrożenie tego kodu na produkcję z
 * nieustawioną flagą jest bezpieczne.
 */

async function post(sciezka: string, body: unknown): Promise<Response> {
  return SELF.fetch(`https://mekamb${sciezka}`, {
    method: "POST",
    headers: { "Content-Type": "application/json" },
    body: JSON.stringify(body),
  });
}

/** Pełna runda logowania seeded konta; `code` to dowolny kod TOTP. */
async function zaloguj(username: string, password: string, code: string): Promise<Response> {
  const start = opaque.clientLoginStart(password);

  const startRes = await post("/auth/login/start", {
    username,
    ke1: bytesToBase64(start.request),
  });
  expect(startRes.status).toBe(200);
  const { loginId, ke2 } = await startRes.json<{ loginId: string; ke2: string }>();

  const finalization = opaque.clientLoginFinish(start.state, password, username, base64ToBytes(ke2));

  const finishRes = await post("/auth/login/finish", {
    loginId,
    username,
    ke3: bytesToBase64(finalization),
  });
  expect(finishRes.status).toBe(200);

  return post("/auth/login/totp", { loginId, code });
}

// Flaga jest globalna dla środowiska Workera, więc czyścimy ją po każdym teście,
// żeby jeden przypadek nie wyciekał trybu dev do następnego.
afterEach(() => {
  delete env.TRYB_DEWELOPERSKI;
});

describe("tryb deweloperski", () => {
  it("poza trybem dev endpointy /dev są niewidoczne (404)", async () => {
    const status = await SELF.fetch("https://mekamb/dev/status");
    expect(status.status).toBe(404);

    const seed = await post("/dev/seed", {});
    expect(seed.status).toBe(404);
  });

  it("sieje konta testowe, które logują się z pominięciem 2FA (dowolny kod)", async () => {
    env.TRYB_DEWELOPERSKI = "true";

    const seedRes = await post("/dev/seed", {});
    expect(seedRes.status).toBe(200);
    const { konta, haslo } = await seedRes.json<{ konta: string[]; haslo: string }>();
    expect(konta).toContain("test1");
    expect(haslo).toBe("test1234");

    // Dowolny kod TOTP przechodzi — drugi składnik jest pominięty.
    const login = await zaloguj("test1", "test1234", "000000");
    expect(login.status).toBe(200);
    const { token } = await login.json<{ token: string }>();
    expect(token).toBeTruthy();
  });

  it("złe hasło wciąż jest odrzucane — dev pomija 2FA, ale nie OPAQUE", async () => {
    env.TRYB_DEWELOPERSKI = "true";
    await post("/dev/seed", {});

    // Klient z błędnym hasłem nie zwaliduje odpowiedzi serwera — to samo OPAQUE
    // co w produkcji, tryb dev go nie osłabia.
    const start = opaque.clientLoginStart("nie-to-haslo");
    const startRes = await post("/auth/login/start", {
      username: "test1",
      ke1: bytesToBase64(start.request),
    });
    expect(startRes.status).toBe(200);
    const { ke2 } = await startRes.json<{ ke2: string }>();

    expect(() =>
      opaque.clientLoginFinish(start.state, "nie-to-haslo", "test1", base64ToBytes(ke2)),
    ).toThrow();
  });

  it("seed jest idempotentny — wolno go wołać wielokrotnie", async () => {
    env.TRYB_DEWELOPERSKI = "true";

    const pierwszy = await post("/dev/seed", {});
    const drugi = await post("/dev/seed", {});
    expect(pierwszy.status).toBe(200);
    expect(drugi.status).toBe(200);

    // Po dwóch siewach konto nadal jedno i sprawne (logowanie działa).
    const login = await zaloguj("test2", "test1234", "123456");
    expect(login.status).toBe(200);
  });
});
