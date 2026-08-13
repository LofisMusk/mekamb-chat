import { PairingKeys } from "../wasm/mekamb_wasm";
import type { Messenger } from "./messenger";

/**
 * Parowanie drugiego urządzenia.
 *
 * # Czym to się różni od przeniesienia konta
 *
 * [`przeniesienie.ts`] **kopiuje ziarno**, więc oba urządzenia dzielą jeden
 * liść MLS i jeden ratchet — rozjeżdżają się nieodwracalnie i dlatego źródło
 * jest kasowane. To jest przeniesienie, nie sklonowanie, i tak ma zostać:
 * służy do przesiadki na inny sprzęt.
 *
 * Parowanie działa odwrotnie. Nowe urządzenie ma **własne ziarno** — dostaje je
 * przy zwykłym logowaniu, bo `Messenger.create` losuje je zawsze — i wchodzi do
 * rozmów jako osobny członek MLS, przez commit. Oba urządzenia działają dalej,
 * równolegle.
 *
 * # Dlaczego samo logowanie nie wystarcza
 *
 * Gdyby zalogowanie się wprowadzało urządzenie do wszystkich rozmów, hasło
 * stawałoby się kluczem do historii. Serwer nie może tego rozstrzygnąć, bo nie
 * wie nawet, do jakich rozmów należymy: `GroupRelay` nazywa się osobno
 * wyprowadzonym identyfikatorem, a jego konstruktor kasuje tabelę składu.
 * Zgodę musi więc podpisać urządzenie **już zaufane**, a kod QR jest dowodem,
 * że stoimy przy nim fizycznie.
 *
 * # Kierunek kodu nie jest dowolny
 *
 * Kod pokazuje **nowe** urządzenie, a stare go skanuje. Klucz efemeryczny
 * wychodzi więc z tego urządzenia, które będzie *odbierać* historię — a nie
 * z tego, które ją nadaje. Ktoś, kto sfilmuje ekran nadajnika przez całą
 * transmisję, ma wszystkie ramki i nadal nie ma czym ich odszyfrować.
 */

const SCHEMAT = "mekamb://parowanie";

/** Bajty → base64url, bez wypełniania. Tak samo jak w `przeniesienie.ts`. */
function doBase64url(bajty: Uint8Array): string {
  return btoa(String.fromCharCode(...bajty))
    .replace(/\+/g, "-")
    .replace(/\//g, "_")
    .replace(/=+$/, "");
}

function zBase64url(tekst: string): Uint8Array {
  const uzupelniony = tekst.replace(/-/g, "+").replace(/_/g, "/");
  const surowe = atob(uzupelniony.padEnd(Math.ceil(uzupelniony.length / 4) * 4, "="));
  return Uint8Array.from(surowe, (z) => z.charCodeAt(0));
}

/** Co niesie kod pokazany przez nowe urządzenie. */
export interface ZaproszenieParowania {
  /** Identyfikator nowego urządzenia — po nim stare pobierze jego key package. */
  deviceId: string;
  /** Efemeryczny klucz publiczny X25519 nowego urządzenia. */
  kluczPubliczny: Uint8Array;
}

/**
 * Buduje treść kodu QR pokazywanego przez nowe urządzenie.
 *
 * Nazwy użytkownika w kodzie **nie ma**: stare urządzenie zna ją i tak, bo
 * paruje z własnym kontem. Wstawienie jej tutaj tylko wywiesiłoby ją na ekranie
 * dla każdego, kto stoi obok.
 */
export function zbudujZaproszenie(deviceId: string, kluczPubliczny: Uint8Array): string {
  return `${SCHEMAT}?d=${encodeURIComponent(deviceId)}&k=${doBase64url(kluczPubliczny)}`;
}

/** Odczytuje kod zeskanowany przez stare urządzenie. Zwraca `null`, gdy to nie ten kod. */
export function odczytajZaproszenie(tekst: string): ZaproszenieParowania | null {
  const oczyszczony = tekst.trim();
  if (!oczyszczony.startsWith(`${SCHEMAT}?`)) return null;

  const parametry = new URLSearchParams(oczyszczony.slice(`${SCHEMAT}?`.length));
  const deviceId = parametry.get("d");
  const klucz = parametry.get("k");
  if (!deviceId || !klucz) return null;

  let kluczPubliczny: Uint8Array;
  try {
    kluczPubliczny = zBase64url(klucz);
  } catch {
    return null;
  }

  // Długość sprawdzamy tutaj, a nie dopiero w rdzeniu: „to nie jest kod
  // parowania" i „kod parowania jest uszkodzony" to dla kogoś stojącego
  // z dwoma urządzeniami różne komunikaty.
  if (kluczPubliczny.length !== 32) return null;

  return { deviceId, kluczPubliczny };
}

/** Nowa para kluczy dla urządzenia, które właśnie się paruje. */
export function nowaPara(): PairingKeys {
  return new PairingKeys();
}

/** Jak idzie wprowadzanie urządzenia do rozmów. */
export interface PostepParowania {
  zrobione: number;
  wszystkich: number;
  /** Rozmowy, do których nie udało się dodać — z powodem. */
  pominiete: { groupId: Uint8Array; powod: string }[];
}

/**
 * Wprowadza nowe urządzenie do wszystkich znanych rozmów.
 *
 * # Dlaczego po kolei, a nie równolegle
 *
 * Każda rozmowa to osobny commit i osobne zajęcie epoki w `GroupRelay`.
 * Równoległe wysyłanie ścigałoby się o epoki samo ze sobą i część commitów
 * wracałaby z 409 bez żadnego powodu poza naszym własnym pośpiechem.
 *
 * # Dlaczego jedna nieudana rozmowa nie przerywa reszty
 *
 * Bo przerwanie zostawia konto sparowane w połowie — część rozmów widoczna na
 * nowym urządzeniu, część nie — i nic tego nie naprawia poza powtórzeniem
 * całości. Lepiej dodać, co się da, i **powiedzieć wprost**, czego się nie
 * udało: powtórne parowanie pominie te, które już przeszły.
 */
export async function wprowadzDoRozmow(
  messenger: Messenger,
  deviceId: string,
  rozmowy: Uint8Array[],
  naPostep?: (postep: PostepParowania) => void,
): Promise<PostepParowania> {
  const postep: PostepParowania = { zrobione: 0, wszystkich: rozmowy.length, pominiete: [] };

  for (const groupId of rozmowy) {
    try {
      await messenger.dodajWlasneUrzadzenie(groupId, deviceId);
      postep.zrobione += 1;
    } catch (blad) {
      postep.pominiete.push({
        groupId,
        powod: blad instanceof Error ? blad.message : String(blad),
      });
    }

    naPostep?.({ ...postep, pominiete: [...postep.pominiete] });
  }

  return postep;
}
