import { SELF, env } from "cloudflare:test";
import { describe, expect, it } from "vitest";

import { MAX_ATTACHMENT_BYTES, cleanupOrphanedAttachments } from "../src/attachments";
import { issueToken } from "../src/crypto";

/**
 * Serwer przechowuje wyłącznie szyfrogramy. Te testy pilnują dwóch rzeczy:
 * że nie da się go użyć bez uwierzytelnienia i że limity są egzekwowane
 * zanim cokolwiek trafi do pamięci.
 */

async function token(userId = "alicja"): Promise<string> {
  return issueToken(env.TOKEN_SIGNING_KEY, {
    userId,
    deviceId: "test",
    expiresAt: Date.now() + 60_000,
  });
}

async function wgraj(dane: ArrayBuffer, bearer: string): Promise<Response> {
  return SELF.fetch("https://mekamb/attachments", {
    method: "POST",
    headers: { Authorization: `Bearer ${bearer}` },
    body: dane,
  });
}

function bajty(rozmiar: number): ArrayBuffer {
  return new Uint8Array(rozmiar).fill(0xab).buffer;
}

describe("załączniki", () => {
  it("wgranie i pobranie zwraca dokładnie te same bajty", async () => {
    const bearer = await token();
    const oryginal = new TextEncoder().encode("udawany szyfrogram zdjecia").buffer as ArrayBuffer;

    const wgranie = await wgraj(oryginal, bearer);
    expect(wgranie.status).toBe(200);
    const { blobId, size } = await wgranie.json<{ blobId: string; size: number }>();
    expect(size).toBe(oryginal.byteLength);

    const pobranie = await SELF.fetch(`https://mekamb/attachments/${blobId}`, {
      headers: { Authorization: `Bearer ${bearer}` },
    });

    expect(pobranie.status).toBe(200);
    const odebrane = await pobranie.arrayBuffer();
    expect(new Uint8Array(odebrane)).toEqual(new Uint8Array(oryginal));
  });

  it("identyfikator nadaje serwer, nie klient", async () => {
    const bearer = await token();

    const pierwszy = await (await wgraj(bajty(64), bearer)).json<{ blobId: string }>();
    const drugi = await (await wgraj(bajty(64), bearer)).json<{ blobId: string }>();

    // Identyczna zawartość, różne identyfikatory — klient nie ma wpływu na
    // nazwę, więc nie nadpisze cudzego bloba ani nie zgadnie istniejącego.
    expect(pierwszy.blobId).not.toBe(drugi.blobId);
  });

  it("wgranie bez tokenu jest odrzucane", async () => {
    const odpowiedz = await SELF.fetch("https://mekamb/attachments", {
      method: "POST",
      body: bajty(64),
    });

    expect(odpowiedz.status).toBe(401);
  });

  /**
   * Poufności to nie chroni — bez klucza szyfrogram jest bezużyteczny.
   * Chroni darmowy limit transferu przed obcym ruchem.
   */
  it("pobranie bez tokenu jest odrzucane", async () => {
    const bearer = await token();
    const { blobId } = await (await wgraj(bajty(64), bearer)).json<{ blobId: string }>();

    const odpowiedz = await SELF.fetch(`https://mekamb/attachments/${blobId}`);

    expect(odpowiedz.status).toBe(401);
  });

  it("podrobiony token jest odrzucany", async () => {
    const odpowiedz = await SELF.fetch("https://mekamb/attachments", {
      method: "POST",
      headers: { Authorization: "Bearer nie.jest.prawdziwy" },
      body: bajty(64),
    });

    expect(odpowiedz.status).toBe(401);
  });

  it("wygasły token jest odrzucany", async () => {
    const wygasly = await issueToken(env.TOKEN_SIGNING_KEY, {
      userId: "alicja",
      deviceId: "test",
      expiresAt: Date.now() - 1000,
    });

    expect((await wgraj(bajty(64), wygasly)).status).toBe(401);
  });

  it("pusty załącznik jest odrzucany", async () => {
    expect((await wgraj(new ArrayBuffer(0), await token())).status).toBe(400);
  });

  /**
   * Limit sprawdzany po nagłówku, zanim ciało trafi do pamięci Workera —
   * inaczej odrzucenie kosztowałoby tyle samo co przyjęcie.
   */
  it("zadeklarowany rozmiar ponad limit jest odrzucany od razu", async () => {
    const odpowiedz = await SELF.fetch("https://mekamb/attachments", {
      method: "POST",
      headers: {
        Authorization: `Bearer ${await token()}`,
        "Content-Length": String(MAX_ATTACHMENT_BYTES + 1),
      },
      body: bajty(1024),
    });

    expect(odpowiedz.status).toBe(413);
  });

  it("nieistniejący załącznik daje 404", async () => {
    const odpowiedz = await SELF.fetch(`https://mekamb/attachments/${crypto.randomUUID()}`, {
      headers: { Authorization: `Bearer ${await token()}` },
    });

    expect(odpowiedz.status).toBe(404);
  });

  it("sprzątanie nie rusza świeżych załączników", async () => {
    const bearer = await token();
    const { blobId } = await (await wgraj(bajty(128), bearer)).json<{ blobId: string }>();

    await cleanupOrphanedAttachments(env);

    const pobranie = await SELF.fetch(`https://mekamb/attachments/${blobId}`, {
      headers: { Authorization: `Bearer ${bearer}` },
    });
    expect(pobranie.status).toBe(200);
  });

  it("sprzątanie kasuje przeterminowane załączniki", async () => {
    const bearer = await token();
    const { blobId } = await (await wgraj(bajty(128), bearer)).json<{ blobId: string }>();

    // Cofamy znacznik czasu, udając blob sprzed retencji.
    const obiekt = await env.ATTACHMENTS.get(blobId);
    await env.ATTACHMENTS.put(blobId, await obiekt!.arrayBuffer(), {
      customMetadata: { uploadedAt: "1", uploadedBy: "alicja" },
    });

    const usuniete = await cleanupOrphanedAttachments(env);

    expect(usuniete).toBeGreaterThanOrEqual(1);
    expect(await env.ATTACHMENTS.get(blobId)).toBeNull();
  });
});
