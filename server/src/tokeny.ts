import * as opaque from "./opaque-wasm/index.js";

import type { Env } from "./env";

/**
 * Tokeny doręczeniowe — sealed sender po stronie serwera.
 *
 * # Po co to jest
 *
 * Zostawienie koperty w cudzej skrzynce jest **nieuwierzytelnione** i to jest
 * decyzja: serwer nie ma się dowiadywać, kto do kogo pisze. Ceną było to, że
 * nadawać może każdy, więc każdy może zalewać cudzą skrzynkę.
 *
 * Token doręczeniowy dowodzi „mam prawo nadać", nie mówiąc „jestem tym
 * kontem". Serwer wydaje go na wartość **oślepioną**, więc przy wydaniu nie
 * widzi, co wydał, a przy realizacji nie widzi, komu. Kryptografia siedzi
 * w `opaque/src/tokeny.rs` — tutaj jest wyłącznie polityka i magazyn.
 *
 * # Czego tu celowo nie ma
 *
 * Żadnego powiązania tokenu z kontem. Ani przy wydaniu, ani w tabeli zużytych.
 * Gdyby się pojawiło, serwer odzyskałby dokładnie tę informację, którą cały
 * schemat ukrywa — i lepiej byłoby wtedy nie mieć go wcale, bo dawałby złudzenie
 * ochrony.
 */

/**
 * Ile tokenów wolno wydać na jedno żądanie.
 *
 * Klient bierze zapas naraz, bo każde pójście po token jest żądaniem
 * uwierzytelnionym — czyli takim, które serwer wiąże z kontem. Im rzadziej,
 * tym mniej jest do skorelowania z nadaniami.
 */
export const MAX_TOKENOW_NA_RAZ = 50;

/** Jak długo trzymamy ślad po zużytym tokenie. */
const OKNO_ZUZYCIA_MS = 30 * 24 * 60 * 60 * 1000;

function kluczWydawania(env: Env): Uint8Array {
  const surowy = env.DELIVERY_TOKEN_KEY;
  if (!surowy) {
    throw new Error("brak DELIVERY_TOKEN_KEY — tokeny doręczeniowe nie są skonfigurowane");
  }
  return Uint8Array.from(atob(surowy), (z) => z.charCodeAt(0));
}

/** Czy wdrożenie ma skonfigurowane tokeny. */
export function tokenyWlaczone(env: Env): boolean {
  return Boolean(env.DELIVERY_TOKEN_KEY);
}

/**
 * Klucz publiczny do opublikowania klientom.
 *
 * Musi być ten sam dla wszystkich i klient MUSI go sprawdzać w dowodzie.
 * Wydawanie różnych kluczy różnym osobom to atak znakujący: serwer rozpoznałby
 * przy realizacji, czyj był token, i anonimowość zniknęłaby bez śladu.
 */
export function kluczPubliczny(env: Env): Uint8Array {
  return opaque.tokenPublicKey(kluczWydawania(env));
}

/** Wydaje tokeny na oślepione wartości klienta. */
export function wydaj(env: Env, oslepione: Uint8Array[]): opaque.TokenIssued[] {
  const klucz = kluczWydawania(env);
  return oslepione.map((wartosc) => opaque.tokenIssue(klucz, wartosc));
}

export type WynikRealizacji = "ok" | "nieprawidlowy" | "zuzyty";

/**
 * Sprawdza i zużywa token.
 *
 * Kolejność jest istotna: najpierw kryptografia, potem zapis. Odwrotna
 * pozwalałaby zapełnić tabelę zużytych zmyślonymi ziarnami bez posiadania
 * choćby jednego prawdziwego tokenu.
 */
export async function zrealizuj(
  env: Env,
  ziarno: Uint8Array,
  odslonione: Uint8Array,
): Promise<WynikRealizacji> {
  let poprawny = false;
  try {
    poprawny = opaque.tokenVerify(kluczWydawania(env), ziarno, odslonione);
  } catch {
    // Dane z sieci są wrogie z założenia: zły rozmiar albo punkt spoza grupy
    // kończy się odrzuceniem, nie wywróceniem żądania.
    return "nieprawidlowy";
  }

  if (!poprawny) return "nieprawidlowy";

  const klucz = [...ziarno].map((b) => b.toString(16).padStart(2, "0")).join("");

  // Wstawienie JEST sprawdzeniem podwójnego wydania: klucz główny odrzuca
  // duplikat atomowo. Odczyt i zapis w dwóch krokach zostawiałyby okno, w które
  // wchodzi każde dwa równoległe nadania tym samym tokenem.
  const wynik = await env.DB.prepare(
    "INSERT OR IGNORE INTO spent_tokens (seed, spent_at) VALUES (?, ?)",
  )
    .bind(klucz, Date.now())
    .run();

  return wynik.meta.changes === 1 ? "ok" : "zuzyty";
}

/** Kasuje ślady starsze niż okno zużycia. Wołane z tego samego crona co reszta. */
export async function posprzataj(env: Env): Promise<void> {
  await env.DB.prepare("DELETE FROM spent_tokens WHERE spent_at < ?")
    .bind(Date.now() - OKNO_ZUZYCIA_MS)
    .run();
}
