import { Hono } from "hono";

import type { Env } from "./env";
import { requireAuth } from "./middleware";

/**
 * Przechowywanie załączników w R2.
 *
 * # Co serwer tu widzi
 *
 * Nieprzezroczysty szyfrogram, jego rozmiar i czas wgrania. Klucz podróżuje
 * wewnątrz wiadomości MLS i nigdy nie przechodzi przez ten kod — nie ma tu
 * endpointu, który mógłby go przyjąć, i to jest zamierzone.
 *
 * # Dlaczego pobieranie wymaga zalogowania, skoro plik jest zaszyfrowany
 *
 * Poufności to nie chroni — bez klucza szyfrogram jest bezużyteczny. Chroni
 * przed czymś innym: bez uwierzytelnienia dowolna osoba mogłaby zaciągać
 * gigabajty z naszego darmowego limitu i zbierać metadane o rozmiarach plików.
 */

/** Górny limit załącznika. Musi zgadzać się z `MAX_ATTACHMENT_BYTES` w Rust. */
export const MAX_ATTACHMENT_BYTES = 25 * 1024 * 1024;

/**
 * Po ilu dniach osierocony blob jest kasowany.
 *
 * „Osierocony" znaczy: wgrany, ale nieodebrany przez nikogo. Serwer nie wie,
 * czy ktoś zamierza go jeszcze pobrać, bo nie zna treści wiadomości — dlatego
 * termin jest hojny i zgodny z retencją skrzynki.
 */
export const ATTACHMENT_RETENTION_DAYS = 30;

const attachments = new Hono<{
  Bindings: Env;
  Variables: { userId: string; deviceId: string | null };
}>();

/**
 * Wgrywa zaszyfrowany załącznik.
 *
 * Identyfikator nadaje **serwer**, a nie klient. Pozwolenie klientowi na wybór
 * nazwy pozwalałoby nadpisać cudzy blob albo zgadywać istniejące.
 */
/**
 * Sprawdza, czy magazyn załączników jest podłączony.
 *
 * Bez tego wywołanie na niepodłączonym bindingu kończyłoby się błędem
 * wewnętrznym, a użytkownik zobaczyłby „coś poszło nie tak" zamiast informacji,
 * że ta funkcja po prostu nie jest jeszcze włączona.
 */
attachments.use("*", async (c, next) => {
  if (!c.env.ATTACHMENTS) {
    return c.json(
      { error: "załączniki nie są jeszcze włączone na tym wdrożeniu" },
      503,
    );
  }
  await next();
});

attachments.post("/", requireAuth, async (c) => {
  const deklarowany = Number(c.req.header("Content-Length") ?? "0");

  // Odrzucamy po nagłówku, zanim cokolwiek wczytamy — inaczej limit
  // sprawdzalibyśmy dopiero po ściągnięciu całości do pamięci Workera.
  if (deklarowany > MAX_ATTACHMENT_BYTES) {
    return c.json({ error: "załącznik przekracza limit rozmiaru" }, 413);
  }

  const ciphertext = await c.req.arrayBuffer();

  if (ciphertext.byteLength === 0) {
    return c.json({ error: "pusty załącznik" }, 400);
  }
  // Nagłówek mógł kłamać, więc rozmiar sprawdzamy też po odczycie.
  if (ciphertext.byteLength > MAX_ATTACHMENT_BYTES) {
    return c.json({ error: "załącznik przekracza limit rozmiaru" }, 413);
  }

  const blobId = crypto.randomUUID();

  await c.env.ATTACHMENTS!.put(blobId, ciphertext, {
    customMetadata: {
      // Wyłącznie do sprzątania. Nie zapisujemy tu nazwy pliku ani typu:
      // to metadane treści, a te mają zostać w kanale MLS.
      uploadedAt: String(Date.now()),
      uploadedBy: c.get("userId"),
    },
  });

  return c.json({ blobId, size: ciphertext.byteLength });
});

/** Pobiera zaszyfrowany załącznik. */
attachments.get("/:blobId", requireAuth, async (c) => {
  const obiekt = await c.env.ATTACHMENTS!.get(c.req.param("blobId"));

  if (obiekt === null) {
    return c.json({ error: "nie ma takiego załącznika" }, 404);
  }

  return new Response(obiekt.body, {
    headers: {
      // Zawsze `octet-stream`: serwer nie zna prawdziwego typu pliku, a
      // zgadywanie go i tak nie miałoby sensu, bo to szyfrogram. Prawdziwy
      // typ jest uwierzytelniony w kanale MLS.
      "Content-Type": "application/octet-stream",
      "Content-Length": String(obiekt.size),
      "Cache-Control": "private, max-age=31536000, immutable",
    },
  });
});

/**
 * Kasuje osierocone bloby. Wołane z wyzwalacza cron.
 *
 * Zwraca liczbę usuniętych obiektów — przydatne w logach, bo nagły skok
 * oznacza zwykle błąd po stronie klienta, a nie normalne sprzątanie.
 */
export async function cleanupOrphanedAttachments(env: Env): Promise<number> {
  if (!env.ATTACHMENTS) return 0;

  const prog = Date.now() - ATTACHMENT_RETENTION_DAYS * 24 * 60 * 60 * 1000;

  let usuniete = 0;
  let kursor: string | undefined;

  do {
    const lista = await env.ATTACHMENTS!.list({ cursor: kursor, include: ["customMetadata"] });

    const doUsuniecia = lista.objects
      .filter((obiekt) => Number(obiekt.customMetadata?.uploadedAt ?? 0) < prog)
      .map((obiekt) => obiekt.key);

    if (doUsuniecia.length > 0) {
      await env.ATTACHMENTS!.delete(doUsuniecia);
      usuniete += doUsuniecia.length;
    }

    kursor = lista.truncated ? lista.cursor : undefined;
  } while (kursor);

  return usuniete;
}

export default attachments;
