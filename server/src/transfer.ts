import { Hono } from "hono";

import type { Env } from "./env";
import { requireAuth } from "./middleware";

/**
 * Przeniesienie konta na inne urządzenie.
 *
 * # Co tu leży
 *
 * Zaszyfrowany zrzut skarbca: tożsamość urządzenia i stan MLS. Klucz **nie
 * przechodzi przez serwer** — jest w kodzie QR, który użytkownik pokazuje
 * z ekranu na ekran. Serwer widzi wyłącznie szyfrogram i nie ma go czym
 * otworzyć.
 *
 * # Dlaczego odbiór jest bez uwierzytelnienia
 *
 * Bo urządzenie odbierające jeszcze nie ma konta — właśnie po to przychodzi.
 * Zabezpieczeniem jest nieodgadywalny identyfikator (16 bajtów losowych)
 * i szyfrowanie ładunku. Serwer, który wyda zrzut komukolwiek, nie wyda niczego
 * czytelnego.
 *
 * # Jednorazowość i krótki czas życia
 *
 * Zrzut kasuje się przy pierwszym odczycie i wygasa po kwadransie. To
 * najostrzejsza część tej funkcji: leży tu **wszystko, czym jest konto**, więc
 * okno, w którym da się to przechwycić, ma być jak najkrótsze. Kwadrans
 * wystarcza na zeskanowanie kodu, a nie wystarcza na nic innego.
 */
const transfer = new Hono<{ Bindings: Env; Variables: { userId: string } }>();

/** Po tylu sekundach zrzut przestaje być wydawany. */
const ZYCIE_SEKUND = 15 * 60;

/**
 * Górny limit rozmiaru zrzutu.
 *
 * Stan MLS rośnie z liczbą rozmów i urządzeń. 8 MB to zapas na długie
 * użytkowanie, a jednocześnie granica, powyżej której ktoś próbowałby użyć
 * tego jako darmowego magazynu.
 */
const MAX_BAJTOW = 8 * 1024 * 1024;

/** Identyfikator z kodu QR: 16 bajtów w base64url, czyli 22 znaki. */
const POPRAWNY_ID = /^[A-Za-z0-9_-]{22}$/;

transfer.put("/:id", requireAuth, async (c) => {
  const id = c.req.param("id");
  if (!POPRAWNY_ID.test(id)) {
    return c.json({ error: "nieprawidłowy identyfikator przeniesienia" }, 400);
  }
  if (!c.env.ATTACHMENTS) {
    return c.json({ error: "magazyn niedostępny" }, 503);
  }

  const szyfrogram = await c.req.arrayBuffer();
  if (szyfrogram.byteLength === 0 || szyfrogram.byteLength > MAX_BAJTOW) {
    return c.json({ error: "zrzut ma nieprawidłowy rozmiar" }, 400);
  }

  await c.env.ATTACHMENTS.put(`transfer/${id}`, szyfrogram, {
    customMetadata: {
      // Data ważności, nie data zapisu: sprawdzenie ma być porównaniem, a nie
      // liczeniem, żeby pomyłka w arytmetyce nie przedłużyła życia zrzutu.
      wygasa: String(Date.now() + ZYCIE_SEKUND * 1000),
    },
  });

  return c.json({ ok: true, wygasaZa: ZYCIE_SEKUND });
});

/**
 * Odbiór zrzutu. Bez uwierzytelnienia — patrz komentarz na górze pliku.
 *
 * Kasowanie następuje przed odesłaniem treści. Odwrotna kolejność zostawiłaby
 * zrzut na serwerze, gdyby odesłanie się nie powiodło, a lepiej żeby
 * użytkownik wygenerował nowy kod, niż żeby stary czekał na kogoś innego.
 */
transfer.get("/:id", async (c) => {
  const id = c.req.param("id");
  if (!POPRAWNY_ID.test(id)) {
    return c.json({ error: "nieprawidłowy identyfikator przeniesienia" }, 400);
  }
  if (!c.env.ATTACHMENTS) {
    return c.json({ error: "magazyn niedostępny" }, 503);
  }

  const klucz = `transfer/${id}`;
  const obiekt = await c.env.ATTACHMENTS.get(klucz);

  // Ten sam komunikat dla „nie ma", „wygasło" i „już odebrane". Rozróżnianie
  // ich powiedziałoby zgadującemu identyfikatory, że trafił w istniejący.
  if (!obiekt) return c.json({ error: "zrzut niedostępny" }, 404);

  const wygasa = Number(obiekt.customMetadata?.wygasa ?? 0);
  if (!wygasa || Date.now() > wygasa) {
    await c.env.ATTACHMENTS.delete(klucz);
    return c.json({ error: "zrzut niedostępny" }, 404);
  }

  await c.env.ATTACHMENTS.delete(klucz);

  return new Response(await obiekt.arrayBuffer(), {
    headers: {
      "content-type": "application/octet-stream",
      // Zrzut jest jednorazowy — pośrednik, który by go zapamiętał, zostawiłby
      // kopię konta w cache.
      "cache-control": "no-store",
    },
  });
});

export default transfer;

/**
 * Kasuje zrzuty, po które nikt nie przyszedł.
 *
 * Odbiór kasuje zrzut sam, więc zostają tu wyłącznie porzucone — ktoś
 * wygenerował kod i nie zeskanował. Bez sprzątania leżałyby bez końca.
 */
export async function cleanupExpiredTransfers(env: Env): Promise<number> {
  if (!env.ATTACHMENTS) return 0;

  let usuniete = 0;
  let kursor: string | undefined;

  do {
    const lista = await env.ATTACHMENTS.list({
      prefix: "transfer/",
      cursor: kursor,
      include: ["customMetadata"],
    });

    for (const obiekt of lista.objects) {
      const wygasa = Number(obiekt.customMetadata?.wygasa ?? 0);
      if (!wygasa || Date.now() > wygasa) {
        await env.ATTACHMENTS.delete(obiekt.key);
        usuniete++;
      }
    }

    kursor = lista.truncated ? lista.cursor : undefined;
  } while (kursor);

  return usuniete;
}
