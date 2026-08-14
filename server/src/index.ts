import { Hono } from "hono";
import { cors } from "hono/cors";

import attachments, { cleanupOrphanedAttachments } from "./attachments";
import auth from "./auth";
import calls from "./calls";
import {
  availableKeyPackages,
  consumeKeyPackage,
  lookupDevices,
  publishKeyPackages,
  registerDevice,
  toBytes,
  urzadzenieNalezyDo,
  usernameFor,
  usunUrzadzenie,
} from "./directory";
import { MAX_ENVELOPE_BYTES, type Env } from "./env";
import transfer, { cleanupExpiredTransfers } from "./transfer";
import {
  MAX_TOKENOW_NA_RAZ,
  kluczPubliczny,
  posprzataj as posprzatajTokeny,
  tokenyWlaczone,
  wydaj,
  zrealizuj,
} from "./tokeny";
import { requireAuth } from "./middleware";
import { verifyToken } from "./crypto";
import zgloszenia from "./zgloszenia";

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
    // PUT jest tu potrzebny dla przeniesienia konta. Jego brak nie objawia
    // się błędem serwera, tylko „Failed to fetch" w przeglądarce — żądanie
    // ginie na preflighcie i nigdy nie dociera do kodu.
    allowMethods: ["GET", "POST", "PUT", "DELETE", "OPTIONS"],
    allowHeaders: ["Content-Type", "Authorization"],
    // Wymagane, żeby przeglądarka wysyłała i przyjmowała httpOnly cookie
    // tokenu odświeżającego (`/auth/refresh`). Bez tego `Set-Cookie` z
    // odpowiedzi jest po cichu ignorowany przy żądaniach cross-origin.
    credentials: true,
    maxAge: 86_400,
  })(c, next),
);

app.route("/auth", auth);
app.route("/attachments", attachments);
app.route("/calls", calls);
app.route("/transfer", transfer);
app.route("/zgloszenia", zgloszenia);

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
      transportKey: device.transportKey,
      transportAddresses: device.transportAddresses,
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
    transportKey?: string;
    transportAddresses?: string;
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
    transportKey: body.transportKey ?? null,
    transportAddresses: body.transportAddresses ?? null,
    addrSignature: body.addrSignature ? new Uint8Array(fromBase64(body.addrSignature)) : null,
    displayName: body.displayName ?? null,
  });

  return c.json({ ok: true });
});

/**
 * Wykreśla urządzenie z katalogu.
 *
 * # To nie odbiera dostępu do rozmów
 *
 * Skład grupy żyje w drzewie MLS, którego serwer nie zna. Dostęp odbiera
 * klient, commitem usuwającym liść — ta trasa tylko sprawia, że nikt już tego
 * urządzenia nigdzie nie doda. Wywołana sama, zostawiłaby zgubiony sprzęt
 * czytającym wszystko, co przyjdzie.
 */
app.delete("/devices/:deviceId", requireAuth, async (c) => {
  const usuniete = await usunUrzadzenie(c.env, c.req.param("deviceId"), c.get("userId"));

  if (!usuniete) {
    // Ten sam komunikat co przy cudzym urządzeniu — rozróżnienie mówiłoby
    // pytającemu, które identyfikatory istnieją.
    return c.json({ error: "to nie jest Twoje urządzenie" }, 403);
  }

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

  // Sam ważny token nie wystarcza: bez tego sprawdzenia każde zalogowane konto
  // wstrzykiwałoby key packages pod CUDZY identyfikator urządzenia.
  if (!(await urzadzenieNalezyDo(c.env, deviceId, c.get("userId")))) {
    // Ten sam komunikat co przy nieistniejącym urządzeniu: rozróżnienie
    // mówiłoby pytającemu, które identyfikatory istnieją.
    return c.json({ error: "to nie jest Twoje urządzenie" }, 403);
  }

  const published = await publishKeyPackages(
    c.env,
    deviceId,
    body.keyPackages.map(fromBase64),
  );

  return c.json({ published, available: await availableKeyPackages(c.env, deviceId) });
});

/**
 * Zajmuje kolejną epokę grupy.
 *
 * Odpowiedź 409 nie jest błędem klienta — znaczy „ktoś był pierwszy".
 * Klient ma porzucić swój commit, przetworzyć cudzy i spróbować ponownie.
 *
 * # Czego tu już nie ma
 *
 * Samego commitu i listy członków. Serwer rozstrzyga wyłącznie KOLEJNOŚĆ,
 * a rozesłanie commitu do skrzynek robi nadawca — skład grupy zna z drzewa
 * MLS, więc serwer nie ma powodu go poznawać. Wcześniej ta trasa była jedynym
 * miejscem, w którym serwer dostawał gotową listę „kto z kim rozmawia".
 */
app.post("/groups/:groupId/commit", requireAuth, async (c) => {
  const body = await c.req.json<{ epoch: number }>();

  if (typeof body.epoch !== "number" || !Number.isInteger(body.epoch) || body.epoch < 0) {
    return c.json({ error: "nieprawidłowy numer epoki" }, 400);
  }

  const groupId = c.req.param("groupId");
  const relay = c.env.GROUP_RELAY.get(c.env.GROUP_RELAY.idFromName(groupId));

  const result = await relay.claimEpoch(body.epoch);

  if (!result.accepted) {
    return c.json(
      { accepted: false, epoch: result.epoch, reason: "epoka nieaktualna — ktoś był pierwszy" },
      409,
    );
  }

  return c.json({ accepted: true, epoch: result.epoch });
});

/**
 * Klucz publiczny wydawania tokenów doręczeniowych.
 *
 * Nieuwierzytelniony i **musi** być ten sam dla wszystkich: klient sprawdza nim
 * dowód serwera. Wydawanie różnych kluczy różnym osobom to atak znakujący —
 * serwer rozpoznawałby przy realizacji, czyj był token.
 */
app.get("/tokens/key", (c) => {
  if (!tokenyWlaczone(c.env)) {
    return c.json({ error: "tokeny doręczeniowe nie są skonfigurowane" }, 503);
  }

  return c.json({ publicKey: toBase64(kluczPubliczny(c.env)) });
});

/**
 * Wydaje tokeny doręczeniowe na oślepione wartości klienta.
 *
 * To JEDYNE miejsce, w którym serwer wie, komu wydaje — i właśnie dlatego nie
 * widzi tu, co wydaje: wartości są oślepione. Przy nadaniu będzie odwrotnie.
 */
app.post("/tokens/issue", requireAuth, async (c) => {
  if (!tokenyWlaczone(c.env)) {
    return c.json({ error: "tokeny doręczeniowe nie są skonfigurowane" }, 503);
  }

  const body = await c.req.json<{ blinded?: string[] }>();

  if (!Array.isArray(body.blinded) || body.blinded.length === 0) {
    return c.json({ error: "oczekiwano niepustej listy oślepionych wartości" }, 400);
  }
  if (body.blinded.length > MAX_TOKENOW_NA_RAZ) {
    return c.json({ error: `naraz można wydać najwyżej ${MAX_TOKENOW_NA_RAZ} tokenów` }, 400);
  }

  try {
    const wydane = wydaj(c.env, body.blinded.map(fromBase64).map((b) => new Uint8Array(b)));

    return c.json({
      tokens: wydane.map((t) => ({
        evaluated: toBase64(t.evaluated),
        challenge: toBase64(t.challenge),
        response: toBase64(t.response),
      })),
    });
  } catch {
    // Oślepiona wartość spoza grupy albo o złym rozmiarze.
    return c.json({ error: "nieprawidłowa oślepiona wartość" }, 400);
  }
});

/**
 * Zostawia kopertę dla odbiorcy, którego nie udało się osiągnąć bezpośrednio.
 *
 * # Dlaczego nie ma tu tokenu konta
 *
 * Bo serwer nie ma się dowiadywać, kto do kogo pisze. Tożsamość nadawcy jest
 * uwierzytelniona **wewnątrz** MLS, gdzie serwer jej nie widzi.
 *
 * Prawo do nadania potwierdza token DORĘCZENIOWY: wydany na wartość oślepioną,
 * więc nie do powiązania z kontem, któremu go wydano. Patrz `tokeny.ts`.
 */
app.post("/inbox/:userId", async (c) => {
  const envelope = await c.req.arrayBuffer();

  if (envelope.byteLength === 0) {
    return c.json({ error: "pusta koperta" }, 400);
  }
  if (envelope.byteLength > MAX_ENVELOPE_BYTES) {
    return c.json({ error: "koperta przekracza limit rozmiaru" }, 413);
  }

  /*
   * Token idzie nagłówkiem, nie w ciele: ciało jest surową kopertą i nie ma
   * w niej miejsca na cokolwiek naszego.
   *
   * Wymuszanie jest osobną decyzją od samego wydawania (patrz `env.ts`): między
   * wdrożeniem serwera a aktualizacją klientów musi zmieścić się okno, w którym
   * nadanie bez tokenu jeszcze przechodzi. Inaczej aktualizacja serwera odcina
   * wszystkich ze starą wersją aplikacji.
   */
  const naglowek = c.req.header("X-Delivery-Token");
  const wymagany = c.env.DELIVERY_TOKEN_REQUIRED === "true";

  if (naglowek) {
    const czesci = naglowek.split(".");
    if (czesci.length !== 2 || !czesci[0] || !czesci[1]) {
      return c.json({ error: "nieprawidłowy token doręczeniowy" }, 400);
    }

    const wynik = await zrealizuj(
      c.env,
      new Uint8Array(fromBase64(czesci[0])),
      new Uint8Array(fromBase64(czesci[1])),
    );

    if (wynik !== "ok") {
      // Ten sam kod dla „podrobiony" i „już użyty": rozróżnienie mówiłoby
      // pytającemu, czy trafił w prawdziwy token.
      return c.json({ error: "token doręczeniowy odrzucony" }, 403);
    }
  } else if (wymagany) {
    return c.json({ error: "wymagany token doręczeniowy" }, 401);
  }

  const userId = c.req.param("userId");
  const inbox = c.env.USER_INBOX.get(c.env.USER_INBOX.idFromName(userId));
  const result = await inbox.deposit(envelope);

  return c.json(result);
});

/**
 * Podłącza urządzenie do **własnej** skrzynki przez WebSocket.
 *
 * # Czemu to musiało powstać
 *
 * Ta trasa nie miała żadnego uwierzytelnienia. Jedynym globalnym middleware
 * jest CORS, a CORS nie jest kontrolą dostępu — nie dotyczy `curl`-a ani
 * klienta natywnego. Ktokolwiek znał nazwę użytkownika, mógł podłączyć się do
 * cudzej skrzynki, odebrać zaległe koperty i wysłać `ack:<id>`, **kasując je
 * z kolejki, zanim dotarły do właściciela**. Wiadomość przepadała bez śladu,
 * a nadawca nie widział żadnego błędu.
 *
 * # Dlaczego token idzie podprotokołem, a nie nagłówkiem
 *
 * Bo przeglądarkowe `WebSocket` nie pozwala dodać nagłówka `Authorization`.
 * Zostaje zapytanie w adresie albo `Sec-WebSocket-Protocol`. Wybieramy to
 * drugie: adresy lądują w logach serwerów pośredniczących i w historii, a token
 * w logu jest tokenem oddanym.
 *
 * # Dlaczego przeliczamy nazwę
 *
 * Skrzynka nazywa się NAZWĄ UŻYTKOWNIKA, a token niesie wewnętrzny UUID konta.
 * Porównanie bez przeliczenia nigdy by się nie zgodziło i odcięłoby wszystkich
 * od własnych skrzynek — ten sam rozjazd, który raz już zepsuł doręczanie.
 */
app.get("/inbox/:userId/connect", async (c) => {
  const token = c.req.header("Sec-WebSocket-Protocol");
  if (!token) {
    return c.json({ error: "brak tokenu dostępowego" }, 401);
  }

  const payload = await verifyToken(c.env.TOKEN_SIGNING_KEY, token);
  if (!payload) {
    return c.json({ error: "token jest nieważny" }, 401);
  }

  const wlasciciel = await usernameFor(c.env, payload.userId);
  const skrzynka = c.req.param("userId");

  if (wlasciciel === null || wlasciciel !== skrzynka) {
    // Ten sam komunikat co przy braku konta: rozróżnienie „nie ma takiego
    // konta" od „to nie Twoja skrzynka" mówiłoby pytającemu, kto istnieje.
    return c.json({ error: "to nie jest Twoja skrzynka" }, 403);
  }

  const inbox = c.env.USER_INBOX.get(c.env.USER_INBOX.idFromName(skrzynka));

  // Identyfikator urządzenia bierzemy z PODPISANEGO tokenu, nigdy z zapytania:
  // inaczej ktokolwiek podszyłby się pod cudzy kursor i potwierdzał koperty
  // w jego imieniu. Skrzynka używa go do osobnego kursora na urządzenie —
  // patrz `UserInbox.acknowledge`.
  const adres = new URL(c.req.url);
  if (payload.deviceId) {
    adres.searchParams.set("urzadzenie", payload.deviceId);
  }

  const odpowiedz = await inbox.fetch(new Request(adres, c.req.raw));

  // Przeglądarka zrywa połączenie, jeśli serwer nie potwierdzi wybranego
  // podprotokołu. Odsyłamy dokładnie to, co przyszło.
  const naglowki = new Headers(odpowiedz.headers);
  naglowki.set("Sec-WebSocket-Protocol", token);

  return new Response(odpowiedz.body, {
    status: odpowiedz.status,
    statusText: odpowiedz.statusText,
    headers: naglowki,
    webSocket: odpowiedz.webSocket,
  });
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
 * Wyzwalacz cron: sprzątanie R2.
 *
 * Skrzynki czyszczą się same alarmami Durable Objects; R2 nie ma takiego
 * mechanizmu, więc potrzebuje osobnego przebiegu. Dotyczy to osieroconych
 * załączników i porzuconych zrzutów przeniesienia — te drugie kasują się przy
 * odbiorze, więc zostają tylko takie, po które nikt nie przyszedł.
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

    // Ślady po zużytych tokenach rosną z każdą wysłaną wiadomością.
    if (tokenyWlaczone(env)) ctx.waitUntil(posprzatajTokeny(env));

    ctx.waitUntil(
      cleanupExpiredTransfers(env).then((usuniete) => {
        if (usuniete > 0) {
          console.log(`sprzątanie R2: usunięto ${usuniete} porzuconych zrzutów przeniesienia`);
        }
      }),
    );
  },
};
