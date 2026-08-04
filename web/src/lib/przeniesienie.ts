import { API_URL } from "./api";
import { type Account, loadAccount, loadSeed, loadState, saveAccount, saveSeed, saveState } from "./vault";

/**
 * Przeniesienie konta na inne urządzenie.
 *
 * # Co przenosimy, a czego nie
 *
 * Tożsamość urządzenia i stan MLS — czyli wszystko, co pozwala **kontynuować**
 * rozmowy na nowym urządzeniu. Wcześniejszych wiadomości nie, bo nie ma czego
 * przenosić: klient trzyma je wyłącznie w pamięci karty i traci przy
 * odświeżeniu. Kod przeniesienia nie jest kopią zapasową rozmów i nie wolno go
 * tak przedstawiać.
 *
 * # To jest przeniesienie, nie sklonowanie
 *
 * Po odebraniu zrzutu **stare urządzenie musi przestać być używane**. Dwa
 * urządzenia z tą samą tożsamością MLS współdzielą jeden liść w drzewie grupy;
 * gdy oba zaczną wysyłać, ratchet rozjedzie się i obie strony przestaną się
 * rozszyfrowywać. Nie da się tego wykryć po fakcie ani naprawić, więc interfejs
 * kasuje konto ze źródła zamiast zostawiać decyzję użytkownikowi.
 *
 * # Gdzie jest klucz
 *
 * W kodzie QR, czyli w kanale, którego serwer nie widzi — na ekranie jednego
 * urządzenia, przed aparatem drugiego. Serwer dostaje wyłącznie szyfrogram.
 * Kto zobaczy ten kod, przejmuje konto, więc nie wolno go fotografować ani
 * wysyłać.
 */

/** Prefiks treści kodu QR. */
const SCHEMAT = "mekamb://transfer";

/** Wersja formatu zrzutu. Zmiana układu pól wymaga podniesienia. */
const WERSJA = 1;

export interface KodPrzeniesienia {
  /** Treść do zakodowania w QR. */
  tresc: string;
  /** Po tylu sekundach zrzut przestaje być wydawany. */
  wygasaZa: number;
}

/** Bajty → base64url, bez wypełniania. */
function doBase64url(bajty: Uint8Array): string {
  let binarne = "";
  for (const bajt of bajty) binarne += String.fromCharCode(bajt);
  return btoa(binarne).replace(/\+/g, "-").replace(/\//g, "_").replace(/=+$/, "");
}

function zBase64url(tekst: string): Uint8Array<ArrayBuffer> {
  const uzupelnione = tekst.replace(/-/g, "+").replace(/_/g, "/");
  const binarne = atob(uzupelnione + "=".repeat((4 - (uzupelnione.length % 4)) % 4));
  const bajty = new Uint8Array(new ArrayBuffer(binarne.length));
  for (let i = 0; i < binarne.length; i++) bajty[i] = binarne.charCodeAt(i);
  return bajty;
}

/**
 * Składa zrzut skarbca.
 *
 * Każde pole poprzedzone długością. Bez tego granice między ziarnem a stanem
 * byłyby domyślne, a pomyłka o jeden bajt dałaby zrzut, który wygląda na
 * poprawny i nie działa.
 */
function zloz(konto: Account, ziarno: Uint8Array, stan: Uint8Array): Uint8Array<ArrayBuffer> {
  const nazwa = new TextEncoder().encode(JSON.stringify(konto));
  const czesci = [nazwa, ziarno, stan];

  const rozmiar = 1 + czesci.reduce((suma, c) => suma + 4 + c.length, 0);
  const wynik = new Uint8Array(new ArrayBuffer(rozmiar));
  const widok = new DataView(wynik.buffer);

  wynik[0] = WERSJA;
  let pozycja = 1;
  for (const czesc of czesci) {
    widok.setUint32(pozycja, czesc.length);
    wynik.set(czesc, pozycja + 4);
    pozycja += 4 + czesc.length;
  }
  return wynik;
}

function rozloz(zrzut: Uint8Array): { konto: Account; ziarno: Uint8Array; stan: Uint8Array } {
  if (zrzut.length < 1 || zrzut[0] !== WERSJA) {
    throw new Error("zrzut pochodzi z innej wersji aplikacji");
  }

  const widok = new DataView(zrzut.buffer, zrzut.byteOffset, zrzut.byteLength);
  const czesci: Uint8Array[] = [];
  let pozycja = 1;

  for (let i = 0; i < 3; i++) {
    if (pozycja + 4 > zrzut.length) throw new Error("zrzut jest uszkodzony");
    const dlugosc = widok.getUint32(pozycja);
    if (pozycja + 4 + dlugosc > zrzut.length) throw new Error("zrzut jest uszkodzony");
    czesci.push(zrzut.subarray(pozycja + 4, pozycja + 4 + dlugosc));
    pozycja += 4 + dlugosc;
  }

  const [nazwa, ziarno, stan] = czesci as [Uint8Array, Uint8Array, Uint8Array];
  return {
    konto: JSON.parse(new TextDecoder().decode(nazwa)) as Account,
    ziarno,
    stan,
  };
}

/**
 * Przygotowuje przeniesienie: szyfruje skarbiec i wysyła na serwer.
 *
 * Zwraca treść do pokazania jako kod QR. Klucz jest w tej treści — serwer go
 * nie dostaje i nie ma jak odczytać wysłanego zrzutu.
 */
export async function przygotujPrzeniesienie(token: string): Promise<KodPrzeniesienia> {
  const konto = await loadAccount();
  const ziarno = await loadSeed();
  const stan = await loadState();

  if (!konto || !ziarno || !stan) {
    throw new Error("na tym urządzeniu nie ma pełnego konta do przeniesienia");
  }

  const zrzut = zloz(konto, ziarno, stan);

  // Świeży klucz na każde przeniesienie. Wyprowadzanie go z czegoś stałego
  // sprawiłoby, że jeden podejrzany kod QR otwiera wszystkie przyszłe.
  const klucz = crypto.getRandomValues(new Uint8Array(32));
  const nonce = crypto.getRandomValues(new Uint8Array(12));
  const id = crypto.getRandomValues(new Uint8Array(16));

  const szyfrogram = await crypto.subtle.encrypt(
    { name: "AES-GCM", iv: nonce },
    await crypto.subtle.importKey("raw", klucz, "AES-GCM", false, ["encrypt"]),
    zrzut,
  );

  // Nonce przed szyfrogramem — odbiorca musi go mieć przed odszyfrowaniem,
  // a w kodzie QR nie ma na niego miejsca obok klucza.
  const ladunek = new Uint8Array(new ArrayBuffer(nonce.length + szyfrogram.byteLength));
  ladunek.set(nonce);
  ladunek.set(new Uint8Array(szyfrogram), nonce.length);

  const identyfikator = doBase64url(id);
  const odpowiedz = await fetch(`${API_URL}/transfer/${identyfikator}`, {
    method: "PUT",
    headers: {
      authorization: `Bearer ${token}`,
      "content-type": "application/octet-stream",
    },
    body: ladunek.buffer,
  });

  if (!odpowiedz.ok) {
    throw new Error("nie udało się przygotować przeniesienia");
  }

  const { wygasaZa } = (await odpowiedz.json()) as { wygasaZa: number };

  return {
    tresc: `${SCHEMAT}?i=${identyfikator}&k=${doBase64url(klucz)}`,
    wygasaZa,
  };
}

/**
 * Odbiera przeniesienie i zapisuje konto na tym urządzeniu.
 *
 * `kod` to treść zeskanowana z QR albo przepisana ręcznie. Po powodzeniu
 * urządzenie ma tożsamość źródła — od tej chwili źródła nie wolno używać.
 */
export async function odbierzPrzeniesienie(kod: string): Promise<Account> {
  const oczyszczony = kod.trim();
  if (!oczyszczony.startsWith(`${SCHEMAT}?`)) {
    throw new Error("to nie jest kod przeniesienia konta");
  }

  const parametry = new URLSearchParams(oczyszczony.slice(`${SCHEMAT}?`.length));
  const identyfikator = parametry.get("i");
  const kluczBase64 = parametry.get("k");

  if (!identyfikator || !kluczBase64) {
    throw new Error("kod przeniesienia jest niekompletny");
  }

  const odpowiedz = await fetch(`${API_URL}/transfer/${identyfikator}`);
  if (!odpowiedz.ok) {
    // Zrzut jest jednorazowy i żyje kwadrans, więc to najczęstszy błąd —
    // komunikat ma od razu mówić, co zrobić.
    throw new Error("kod wygasł albo został już użyty; wygeneruj nowy na starym urządzeniu");
  }

  const ladunek = new Uint8Array(await odpowiedz.arrayBuffer());
  if (ladunek.length <= 12) throw new Error("zrzut jest uszkodzony");

  const klucz = zBase64url(kluczBase64);
  const zrzut = new Uint8Array(
    await crypto.subtle.decrypt(
      { name: "AES-GCM", iv: ladunek.subarray(0, 12) },
      await crypto.subtle.importKey("raw", klucz, "AES-GCM", false, ["decrypt"]),
      ladunek.subarray(12),
    ),
  );

  const { konto, ziarno, stan } = rozloz(zrzut);

  // Kolejność ma znaczenie: konto na końcu. To ono decyduje, czy aplikacja
  // uzna urządzenie za skonfigurowane, więc zapisane jako pierwsze zostawiłoby
  // przy przerwanym zapisie konto bez kluczy — czyli stan nie do naprawienia.
  await saveSeed(ziarno);
  await saveState(stan);
  await saveAccount(konto);

  return konto;
}
