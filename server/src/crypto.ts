/**
 * Prymitywy pomocnicze: szyfrowanie sekretów w spoczynku i podpisywanie tokenów.
 *
 * Wszystko opiera się na Web Crypto. Nie ma tu żadnej własnej kryptografii —
 * tylko standardowe konstrukcje złożone z gotowych prymitywów.
 */

const AES_IV_BYTES = 12;

/** Wyprowadza klucz AES-GCM z sekretu tekstowego z Workers Secrets. */
async function aesKey(secret: string): Promise<CryptoKey> {
  const digest = await crypto.subtle.digest("SHA-256", new TextEncoder().encode(secret));
  return crypto.subtle.importKey("raw", digest, { name: "AES-GCM" }, false, [
    "encrypt",
    "decrypt",
  ]);
}

/**
 * Szyfruje sekret do postaci przechowywanej w bazie.
 *
 * Dotyczy przede wszystkim sekretów TOTP: sam wyciek bazy nie wystarcza wtedy
 * do generowania kodów drugiego składnika — potrzebny jest jeszcze klucz
 * z Workers Secrets, który w bazie nie leży.
 */
export async function encryptSecret(key: string, plaintext: string): Promise<string> {
  const iv = crypto.getRandomValues(new Uint8Array(AES_IV_BYTES));
  const ciphertext = await crypto.subtle.encrypt(
    { name: "AES-GCM", iv },
    await aesKey(key),
    new TextEncoder().encode(plaintext),
  );

  const packed = new Uint8Array(iv.length + ciphertext.byteLength);
  packed.set(iv);
  packed.set(new Uint8Array(ciphertext), iv.length);

  return bytesToBase64(packed);
}

/** Odszyfrowuje sekret zapisany przez [`encryptSecret`]. */
export async function decryptSecret(key: string, packed: string): Promise<string> {
  const bytes = base64ToBytes(packed);
  const iv = bytes.slice(0, AES_IV_BYTES);
  const ciphertext = bytes.slice(AES_IV_BYTES);

  const plaintext = await crypto.subtle.decrypt(
    { name: "AES-GCM", iv },
    await aesKey(key),
    ciphertext,
  );

  return new TextDecoder().decode(plaintext);
}

/** Ładunek tokenu dostępowego. */
export interface TokenPayload {
  userId: string;
  deviceId: string | null;
  /** Czas wygaśnięcia, epoka uniksowa w milisekundach. */
  expiresAt: number;
}

/**
 * Wystawia podpisany token dostępowy.
 *
 * Token jest **nieszyfrowany** — jego zawartość to identyfikatory, które
 * serwer i tak zna. Podpis chroni przed podmianą, nie przed odczytem.
 */
export async function issueToken(key: string, payload: TokenPayload): Promise<string> {
  const body = bytesToBase64Url(new TextEncoder().encode(JSON.stringify(payload)));
  const signature = await hmac(key, body);
  return `${body}.${signature}`;
}

/**
 * Weryfikuje token i zwraca jego ładunek, albo `null`.
 *
 * Porównanie podpisu jest stałoczasowe: zwykłe `===` na łańcuchach kończy się
 * na pierwszej różnicy, co daje mierzalny wyciek pozwalający dobierać podpis
 * bajt po bajcie.
 */
export async function verifyToken(key: string, token: string): Promise<TokenPayload | null> {
  const separator = token.lastIndexOf(".");
  if (separator <= 0) return null;

  const body = token.slice(0, separator);
  const signature = token.slice(separator + 1);

  const expected = await hmac(key, body);
  if (!constantTimeEquals(signature, expected)) return null;

  let payload: TokenPayload;
  try {
    payload = JSON.parse(new TextDecoder().decode(base64UrlToBytes(body))) as TokenPayload;
  } catch {
    return null;
  }

  if (typeof payload.expiresAt !== "number" || payload.expiresAt < Date.now()) {
    return null;
  }

  return payload;
}

async function hmac(key: string, message: string): Promise<string> {
  const cryptoKey = await crypto.subtle.importKey(
    "raw",
    new TextEncoder().encode(key),
    { name: "HMAC", hash: "SHA-256" },
    false,
    ["sign"],
  );

  const signature = await crypto.subtle.sign("HMAC", cryptoKey, new TextEncoder().encode(message));
  return bytesToBase64Url(new Uint8Array(signature));
}

/** Porównanie odporne na atak czasowy. */
export function constantTimeEquals(a: string, b: string): boolean {
  if (a.length !== b.length) return false;

  let diff = 0;
  for (let i = 0; i < a.length; i += 1) {
    diff |= a.charCodeAt(i) ^ b.charCodeAt(i);
  }
  return diff === 0;
}

export function bytesToBase64(bytes: Uint8Array): string {
  let binary = "";
  for (const byte of bytes) {
    binary += String.fromCharCode(byte);
  }
  return btoa(binary);
}

export function base64ToBytes(value: string): Uint8Array {
  const binary = atob(value);
  const bytes = new Uint8Array(binary.length);
  for (let i = 0; i < binary.length; i += 1) {
    bytes[i] = binary.charCodeAt(i);
  }
  return bytes;
}

function bytesToBase64Url(bytes: Uint8Array): string {
  return bytesToBase64(bytes).replace(/\+/g, "-").replace(/\//g, "_").replace(/=+$/, "");
}

function base64UrlToBytes(value: string): Uint8Array {
  const padded = value.replace(/-/g, "+").replace(/_/g, "/");
  return base64ToBytes(padded.padEnd(Math.ceil(padded.length / 4) * 4, "="));
}
