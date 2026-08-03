import { Hono } from "hono";
import { cors } from "hono/cors";

import attachments, { cleanupOrphanedAttachments } from "./attachments";
import auth from "./auth";
import {
  availableKeyPackages,
  consumeKeyPackage,
  lookupDevices,
  publishKeyPackages,
  registerDevice,
  toBytes,
} from "./directory";
import { MAX_ENVELOPE_BYTES, type Env } from "./env";
import { requireAuth } from "./middleware";

export { GroupRelay } from "./group";
export { RateLimiter } from "./ratelimit";
export { UserInbox } from "./inbox";

const app = new Hono<{ Bindings: Env }>();

// Kontrola źródła. Lista pochodzi z konfiguracji, bo adres klienta zmienia się
// między środowiskami, a wpisanie `*` otworzyłoby API na wywołania z dowolnej
// strony odwiedzonej przez użytkownika.
app.use("*", async (c, next) =>
  cors({
    origin: (origin) => {
      const dozwolone = (c.env.ALLOWED_ORIGINS ?? "")
        .split(",")
        .map((o) => o.trim())
        .filter(Boolean);
      return dozwolone.includes(origin) ? origin : null;
    },
    allowMethods: ["GET", "POST", "OPTIONS"],
    allowHeaders: ["Content-Type", "Authorization"],
    maxAge: 86_400,
  })(c, next),
);

app.route("/auth", auth);
app.route("/attachments", attachments);

/**
 * Limit prób logowania.
 *
 * 5 prób w serii, uzupełniane po jednej na 30 sekund. Wystarczy na pomyłkę
 * w haśle albo przepisanie kodu TOTP, a odbiera sens zgadywaniu.
 */
const LOGIN_BUCKET = { capacity: 5, refillPerSecond: 1 / 30 };

app.get("/health", (c) => c.json({ ok: true }));

/**
 * Katalog: adresy urządzeń użytkownika.
 *
 * Zwracane rekordy są podpisane kluczem MLS urządzenia. **Klient musi
 * zweryfikować podpis** przed użyciem adresu — ta odpowiedź pochodzi z serwera,
 * a serwer nie jest zaufanym źródłem.
 */
app.get("/directory/:username", async (c) => {
  const devices = await lookupDevices(c.env, c.req.param("username"));

  if (devices.length === 0) {
    // Ta sama odpowiedź dla „nie ma takiego konta" i „konto bez urządzeń".
    // Rozróżnienie pozwalałoby sprawdzać, czy dana nazwa jest zajęta.
    return c.json({ devices: [] });
  }

  return c.json({
    devices: devices.map((device) => ({
      deviceId: device.deviceId,
      irohNodeId: device.irohNodeId,
      addrRecord: device.addrRecord,
      // `null` oznacza urządzenie bez własnego adresu — osiągalne tylko przez
      // skrzynkę. Klient musi to rozróżnić, żeby nie próbował się dodzwaniać.
      addrSignature: toBase64OrNull(toBytes(device.addrSignature)),
      mlsPublicKey: toBase64OrNull(toBytes(device.mlsPublicKey)),
      lastSeenAt: device.lastSeenAt,
    })),
  });
});

/**
 * Rejestruje urządzenie zalogowanego użytkownika.
 *
 * Wywoływane po każdym logowaniu — odświeża też adres, bo ten zmienia się
 * przy każdej zmianie sieci.
 */
app.post("/devices", requireAuth, async (c) => {
  const body = await c.req.json<{
    deviceId: string;
    mlsPublicKey: string;
    irohNodeId?: string;
    addrRecord?: string;
    addrSignature?: string;
    displayName?: string;
  }>();

  if (!body.deviceId || !body.mlsPublicKey) {
    return c.json({ error: "brak deviceId albo klucza publicznego" }, 400);
  }

  await registerDevice(c.env, {
    deviceId: body.deviceId,
    // Właściciela bierzemy z TOKENU, nie z ciała żądania. Zaufanie temu, co
    // przysłał klient, pozwoliłoby dopisać urządzenie do cudzego konta.
    userId: c.get("userId"),
    mlsPublicKey: new Uint8Array(fromBase64(body.mlsPublicKey)),
    irohNodeId: body.irohNodeId ?? null,
    addrRecord: body.addrRecord ?? null,
    addrSignature: body.addrSignature ? new Uint8Array(fromBase64(body.addrSignature)) : null,
    displayName: body.displayName ?? null,
  });

  return c.json({ ok: true });
});

/** Pobiera jednorazowy key package, żeby dodać urządzenie do grupy. */
app.post("/key-packages/:deviceId/claim", async (c) => {
  const blob = await consumeKeyPackage(c.env, c.req.param("deviceId"));

  if (blob === null) {
    return c.json({ error: "brak dostępnych key packages" }, 409);
  }

  return c.json({ keyPackage: toBase64(blob) });
});

/** Publikuje zapas key packages. */
app.post("/key-packages/:deviceId", requireAuth, async (c) => {
  const body = await c.req.json<{ keyPackages: string[] }>();

  if (!Array.isArray(body.keyPackages) || body.keyPackages.length === 0) {
    return c.json({ error: "oczekiwano niepustej listy key packages" }, 400);
  }

  const deviceId = c.req.param("deviceId");
  const published = await publishKeyPackages(
    c.env,
    deviceId,
    body.keyPackages.map(fromBase64),
  );

  return c.json({ published, available: await availableKeyPackages(c.env, deviceId) });
});

/**
 * Zgłasza commit do rozstrzygnięcia kolejności.
 *
 * Odpowiedź 409 nie jest błędem klienta — znaczy „ktoś był pierwszy".
 * Klient ma porzucić swój commit, przetworzyć cudzy i spróbować ponownie.
 */
app.post("/groups/:groupId/commit", requireAuth, async (c) => {
  const body = await c.req.json<{ epoch: number; envelope: string; members: string[] }>();

  if (typeof body.epoch !== "number" || !Number.isInteger(body.epoch) || body.epoch < 0) {
    return c.json({ error: "nieprawidłowy numer epoki" }, 400);
  }
  if (!Array.isArray(body.members) || body.members.length === 0) {
    return c.json({ error: "oczekiwano niepustej listy członków" }, 400);
  }

  const envelope = fromBase64(body.envelope);
  if (envelope.byteLength > MAX_ENVELOPE_BYTES) {
    return c.json({ error: "commit przekracza limit rozmiaru" }, 413);
  }

  const groupId = c.req.param("groupId");
  const relay = c.env.GROUP_RELAY.get(c.env.GROUP_RELAY.idFromName(groupId));

  // Nadawcę bierzemy z TOKENU. Gdyby pochodził z ciała żądania, dałoby się
  // wykluczyć z rozsyłki dowolną osobę i po cichu odciąć ją od grupy.
  const result = await relay.submitCommit(body.epoch, envelope, body.members, c.get("userId"));

  if (!result.accepted) {
    return c.json(
      { accepted: false, epoch: result.epoch, reason: "epoka nieaktualna — ktoś był pierwszy" },
      409,
    );
  }

  return c.json({ accepted: true, epoch: result.epoch });
});

/** Zostawia kopertę dla odbiorcy, którego nie udało się osiągnąć bezpośrednio. */
app.post("/inbox/:userId", async (c) => {
  const envelope = await c.req.arrayBuffer();

  if (envelope.byteLength === 0) {
    return c.json({ error: "pusta koperta" }, 400);
  }
  if (envelope.byteLength > MAX_ENVELOPE_BYTES) {
    return c.json({ error: "koperta przekracza limit rozmiaru" }, 413);
  }

  const userId = c.req.param("userId");
  const inbox = c.env.USER_INBOX.get(c.env.USER_INBOX.idFromName(userId));
  const result = await inbox.deposit(envelope);

  return c.json(result);
});

/** Podłącza urządzenie do własnej skrzynki przez WebSocket. */
app.get("/inbox/:userId/connect", async (c) => {
  const userId = c.req.param("userId");
  const inbox = c.env.USER_INBOX.get(c.env.USER_INBOX.idFromName(userId));
  return inbox.fetch(c.req.raw);
});

/** Sprawdza limit prób — wołane przez ścieżkę logowania. */
app.post("/internal/rate-limit/:key", async (c) => {
  const key = c.req.param("key");
  const limiter = c.env.RATE_LIMITER.get(c.env.RATE_LIMITER.idFromName(key));
  const result = await limiter.consume(key, LOGIN_BUCKET.capacity, LOGIN_BUCKET.refillPerSecond);

  if (!result.allowed) {
    return c.json({ error: "zbyt wiele prób" }, 429, {
      "Retry-After": String(Math.ceil(result.retryAfterMs / 1000)),
    });
  }

  return c.json({ allowed: true });
});

/**
 * Kodowanie base64 bez rozwijania tablicy w argumenty wywołania.
 *
 * `String.fromCharCode(...bajty)` przy dużym ładunku przepełnia stos —
 * a nasze koperty sięgają megabajta. Pętla jest brzydsza i nie ma tej granicy.
 */
function toBase64(bytes: Uint8Array): string {
  let binary = "";
  for (const byte of bytes) {
    binary += String.fromCharCode(byte);
  }
  return btoa(binary);
}

function toBase64OrNull(bytes: Uint8Array | null): string | null {
  return bytes === null ? null : toBase64(bytes);
}

function fromBase64(value: string): ArrayBuffer {
  const binary = atob(value);
  const bytes = new Uint8Array(binary.length);
  for (let i = 0; i < binary.length; i += 1) {
    bytes[i] = binary.charCodeAt(i);
  }
  return bytes.buffer;
}

/**
 * Wyzwalacz cron: sprzątanie osieroconych załączników.
 *
 * Skrzynki czyszczą się same alarmami Durable Objects; R2 nie ma takiego
 * mechanizmu, więc potrzebuje osobnego przebiegu.
 */
export default {
  fetch: app.fetch,

  async scheduled(_event: ScheduledController, env: Env, ctx: ExecutionContext): Promise<void> {
    ctx.waitUntil(
      cleanupOrphanedAttachments(env).then((usuniete) => {
        if (usuniete > 0) {
          console.log(`sprzątanie R2: usunięto ${usuniete} osieroconych załączników`);
        }
      }),
    );
  },
};
