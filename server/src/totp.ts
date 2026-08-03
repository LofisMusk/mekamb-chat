import { Secret, TOTP } from "otpauth";

/**
 * Drugi składnik logowania: kod z aplikacji authenticator (RFC 6238).
 *
 * # Co TOTP tu chroni, a czego nie
 *
 * Chroni **dostęp do infrastruktury**: skrzynki offline, katalogu, publikowania
 * key packages. **Nie** odblokowuje wiadomości — klucze do nich nigdy nie
 * opuszczają urządzenia. Przejęcie hasła i kodu TOTP daje wejście na konto,
 * ale nie daje historii rozmów, bo serwer jej nie ma.
 */

const ISSUER = "mekamb-chat";
const PERIOD_SECONDS = 30;
const DIGITS = 6;

/**
 * Tolerancja przesunięcia zegara, w oknach.
 *
 * 1 oznacza akceptację kodu z okna poprzedniego, bieżącego i następnego,
 * czyli ±30 sekund. Większa wartość ułatwia życie użytkownikom z rozjechanym
 * zegarem, ale proporcjonalnie zwiększa liczbę kodów akceptowanych w danej
 * chwili — czyli ułatwia też zgadywanie.
 */
const WINDOW = 1;

function totpFor(secretBase32: string): TOTP {
  return new TOTP({
    issuer: ISSUER,
    algorithm: "SHA1",
    digits: DIGITS,
    period: PERIOD_SECONDS,
    secret: Secret.fromBase32(secretBase32),
  });
}

/** Losuje nowy sekret TOTP w base32. */
export function generateSecret(): string {
  return new Secret({ size: 20 }).base32;
}

/** Buduje URI `otpauth://`, z którego klient rysuje kod QR. */
export function provisioningUri(secretBase32: string, username: string): string {
  const totp = new TOTP({
    issuer: ISSUER,
    label: username,
    algorithm: "SHA1",
    digits: DIGITS,
    period: PERIOD_SECONDS,
    secret: Secret.fromBase32(secretBase32),
  });

  return totp.toString();
}

export interface TotpResult {
  valid: boolean;
  /**
   * Numer okna czasowego, w którym kod był poprawny.
   *
   * Zapisywany w bazie, żeby ten sam kod nie zadziałał drugi raz.
   */
  counter: number | null;
}

/**
 * Sprawdza kod i zwraca okno, do którego należał.
 *
 * # Dlaczego samo „kod się zgadza" nie wystarcza
 *
 * Kod jest ważny przez całe swoje okno, więc podsłuchany da się odtworzyć
 * w ciągu kilkudziesięciu sekund. Zwracamy numer okna, a wywołujący odrzuca
 * kod, jeśli to okno już zostało wykorzystane — patrz [`isReplay`].
 */
export function verifyCode(secretBase32: string, code: string): TotpResult {
  // Kod ma dokładnie tyle cyfr, ile trzeba. Odsiewanie śmieci przed
  // wywołaniem biblioteki oszczędza pracy przy zalewie żądań.
  if (!/^\d{6}$/.test(code)) {
    return { valid: false, counter: null };
  }

  const totp = totpFor(secretBase32);

  // `validate` zwraca przesunięcie względem bieżącego okna albo null.
  const delta = totp.validate({ token: code, window: WINDOW });
  if (delta === null) {
    return { valid: false, counter: null };
  }

  const currentCounter = Math.floor(Date.now() / 1000 / PERIOD_SECONDS);
  return { valid: true, counter: currentCounter + delta };
}

/** Czy to okno czasowe zostało już użyte. */
export function isReplay(counter: number, lastUsedCounter: number | null): boolean {
  return lastUsedCounter !== null && counter <= lastUsedCounter;
}
