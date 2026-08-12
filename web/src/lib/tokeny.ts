import { tokenBlind, tokenUnblind } from "../wasm/mekamb_wasm";
import { api, base64ToBytes, bytesToBase64 } from "./api";

/**
 * Portfel tokenów doręczeniowych.
 *
 * # Po co to jest
 *
 * Zostawienie koperty w cudzej skrzynce jest nieuwierzytelnione, bo serwer nie
 * ma się dowiadywać, kto do kogo pisze. Ceną było to, że nadawać może każdy —
 * więc każdy może zalewać cudzą skrzynkę. Token doręczeniowy dowodzi „mam prawo
 * nadać", nie mówiąc „jestem tym kontem".
 *
 * # Dlaczego zapas, a nie token na żądanie
 *
 * Bo pójście po token jest żądaniem **uwierzytelnionym** — serwer wiąże je
 * z kontem. Branie jednego przed każdą wiadomością dałoby serwerowi ciąg
 * „konto A poprosiło o token, sekundę później ktoś nadał do skrzynki B", czyli
 * dokładnie to powiązanie, które ten schemat usuwa.
 *
 * Zapas bierzemy rzadko i z góry, a wydajemy pojedynczo i w oderwaniu od chwili
 * pobrania.
 *
 * # Dlaczego to nie leży w skarbcu
 *
 * Bo token nie jest sekretem tożsamości: jego utrata nie odsłania niczego,
 * a odzyskanie go nie daje dostępu do konta. Kosztuje jedno pobranie zapasu.
 */

const KLUCZ_ZAPAS = "mekamb.tokeny";
const KLUCZ_PUBLICZNY = "mekamb.tokeny.klucz";

/** Ile bierzemy naraz. Serwer i tak nie wyda więcej na jedno żądanie. */
export const ZAPAS_DOCELOWY = 50;

/** Poniżej tego progu dobieramy. Zapas ma się kończyć przed, a nie w trakcie. */
export const PROG_DOBRANIA = 10;

export interface Token {
  seed: string;
  unblinded: string;
}

function wczytaj(magazyn: Pick<Storage, "getItem">): Token[] {
  try {
    const surowe = magazyn.getItem(KLUCZ_ZAPAS);
    const zapas: unknown = surowe ? JSON.parse(surowe) : [];
    return Array.isArray(zapas) ? (zapas as Token[]) : [];
  } catch {
    // Uszkodzony zapis znaczy pusty zapas — dobierzemy nowy. Token jest
    // wygodą, nie danymi, więc nie ma tu czego ratować.
    return [];
  }
}

function zapisz(tokeny: Token[], magazyn: Pick<Storage, "setItem">): void {
  try {
    magazyn.setItem(KLUCZ_ZAPAS, JSON.stringify(tokeny));
  } catch {
    // Brak magazynu (prywatne okno) znaczy zapas na jedną sesję.
  }
}

/**
 * Wyjmuje jeden token z zapasu.
 *
 * Zwraca `null`, gdy zapasu nie ma — wołający ma wtedy nadać bez tokenu.
 * To celowe: dopóki serwer nie wymusza tokenów, brak zapasu nie może blokować
 * wysyłania wiadomości. Wiadomość jest ważniejsza niż limit nadużyć.
 */
export function wezToken(magazyn: Pick<Storage, "getItem" | "setItem"> = localStorage): Token | null {
  const zapas = wczytaj(magazyn);
  const token = zapas.shift();
  if (!token) return null;

  zapisz(zapas, magazyn);
  return token;
}

/** Ile tokenów zostało. */
export function ileTokenow(magazyn: Pick<Storage, "getItem"> = localStorage): number {
  return wczytaj(magazyn).length;
}

/**
 * Postać nagłówka `X-Delivery-Token`.
 *
 * Dwa pola rozdzielone kropką, tak jak czyta je serwer. Wydzielone, żeby
 * kształt istniał w jednym miejscu po obu stronach granicy.
 */
export function naglowekTokenu(token: Token): string {
  return `${token.seed}.${token.unblinded}`;
}

/**
 * Dobiera zapas, jeśli zszedł poniżej progu.
 *
 * Cicha przy każdym niepowodzeniu: brak tokenów nie może zatrzymać wysyłania,
 * a wdrożenie bez skonfigurowanych tokenów odpowiada 503 i to jest poprawny
 * stan, nie awaria.
 */
export async function uzupelnij(
  token: string,
  magazyn: Pick<Storage, "getItem" | "setItem"> = localStorage,
): Promise<void> {
  if (wczytaj(magazyn).length > PROG_DOBRANIA) return;

  try {
    const { publicKey } = await api.get<{ publicKey: string }>("/tokens/key");

    /*
     * Klucz publiczny przypinamy przy pierwszym pobraniu.
     *
     * Serwer, który wydaje różnym osobom tokeny różnymi kluczami, ZNAKUJE je —
     * przy nadaniu rozpoznaje, czyj był token. Dowód w `tokenUnblind` wykrywa
     * użycie innego klucza niż podany, ale nie wykryje, że sam klucz jest
     * podstawiony pod nas. Przypięcie zamienia atak z niewidocznego w taki,
     * który wymaga zmiany klucza u wszystkich naraz.
     */
    const przypiety = magazyn.getItem(KLUCZ_PUBLICZNY);
    if (przypiety && przypiety !== publicKey) {
      console.warn("klucz wydawania tokenów się zmienił — zapas nieuzupełniony");
      return;
    }
    if (!przypiety) magazyn.setItem(KLUCZ_PUBLICZNY, publicKey);

    const proby = Array.from({ length: ZAPAS_DOCELOWY }, () => tokenBlind());

    const { tokens } = await api.post<{
      tokens: { evaluated: string; challenge: string; response: string }[];
    }>("/tokens/issue", { blinded: proby.map((p) => bytesToBase64(p.blinded)) }, token);

    const klucz = base64ToBytes(publicKey);
    const nowe: Token[] = [];

    tokens.forEach((wydany, n) => {
      const proba = proby[n];
      if (!proba) return;

      // Dowód sprawdza `tokenUnblind`. Odrzucony token pomijamy zamiast
      // wywracać całe uzupełnienie: jeden zły nie może kosztować pozostałych.
      try {
        const gotowy = tokenUnblind(
          proba.seed,
          proba.blinder,
          proba.blinded,
          base64ToBytes(wydany.evaluated),
          base64ToBytes(wydany.challenge),
          base64ToBytes(wydany.response),
          klucz,
        );

        nowe.push({
          seed: bytesToBase64(gotowy.seed),
          unblinded: bytesToBase64(gotowy.unblinded),
        });
      } catch (err) {
        console.warn("serwer nie dowiódł, że użył swojego klucza", err);
      }
    });

    if (nowe.length > 0) zapisz([...wczytaj(magazyn), ...nowe], magazyn);
  } catch {
    // Wdrożenie bez tokenów albo brak sieci. Nadawanie idzie dalej bez nich.
  }
}
