/**
 * Trwały magazyn tożsamości i stanu MLS w przeglądarce.
 *
 * # Co tu leży
 *
 * Ziarno urządzenia (32 bajty) i zrzut stanu MLS. Oba zawierają klucze
 * prywatne — kto je ma, ten czyta wszystkie rozmowy. Dlatego nic nie trafia
 * do IndexedDB w postaci jawnej.
 *
 * # Jak są chronione i czego to NIE chroni
 *
 * Dane szyfrujemy AES-GCM kluczem, który jest w IndexedDB jako
 * **nieeksportowalny** `CryptoKey`. Skrypt działający na tej stronie może go
 * użyć, ale nie potrafi go odczytać ani wynieść — więc atak polegający na
 * wyciągnięciu bazy nic nie daje.
 *
 * Czego to nie chroni: atakujący, który uzyska wykonanie kodu na stronie (XSS
 * albo podmieniony deploy), może tym kluczem odszyfrować dane na miejscu.
 * Ograniczenia klienta webowego są opisane w docs/THREAT_MODEL.md; docelowym
 * wzmocnieniem jest rozszerzenie WebAuthn PRF, które wiąże klucz z fizycznym
 * uwierzytelnieniem użytkownika.
 */

const DB_NAME = "mekamb";
const DB_VERSION = 1;
const STORE = "vault";

const KEY_ID = "klucz-szyfrujacy";
const SEED_ID = "ziarno-urzadzenia";
const STATE_ID = "stan-mls";
const ACCOUNT_ID = "konto";
const HISTORY_ID = "historia";

const IV_BYTES = 12;

export interface Account {
  userId: string;
  username: string;
  deviceId: string;
}

function open(): Promise<IDBDatabase> {
  return new Promise((resolve, reject) => {
    const request = indexedDB.open(DB_NAME, DB_VERSION);
    request.onupgradeneeded = () => {
      if (!request.result.objectStoreNames.contains(STORE)) {
        request.result.createObjectStore(STORE);
      }
    };
    request.onsuccess = () => resolve(request.result);
    request.onerror = () => reject(request.error);
  });
}

function tx<T>(mode: IDBTransactionMode, run: (store: IDBObjectStore) => IDBRequest<T>): Promise<T> {
  return open().then(
    (db) =>
      new Promise<T>((resolve, reject) => {
        const request = run(db.transaction(STORE, mode).objectStore(STORE));
        request.onsuccess = () => resolve(request.result);
        request.onerror = () => reject(request.error);
      }),
  );
}

/**
 * Zwraca klucz szyfrujący magazyn, tworząc go przy pierwszym uruchomieniu.
 *
 * `extractable: false` jest tu istotą rzeczy: przeglądarka nie pozwoli
 * wyeksportować materiału klucza żadnym API, nawet naszym własnym kodem.
 */
async function vaultKey(): Promise<CryptoKey> {
  const existing = await tx<CryptoKey | undefined>("readonly", (store) => store.get(KEY_ID));
  if (existing) return existing;

  const key = await crypto.subtle.generateKey({ name: "AES-GCM", length: 256 }, false, [
    "encrypt",
    "decrypt",
  ]);

  await tx("readwrite", (store) => store.put(key, KEY_ID));
  return key;
}

async function encrypt(data: Uint8Array): Promise<ArrayBuffer> {
  const iv = crypto.getRandomValues(new Uint8Array(IV_BYTES));
  const ciphertext = await crypto.subtle.encrypt(
    { name: "AES-GCM", iv },
    await vaultKey(),
    data as BufferSource,
  );

  const packed = new Uint8Array(IV_BYTES + ciphertext.byteLength);
  packed.set(iv);
  packed.set(new Uint8Array(ciphertext), IV_BYTES);
  return packed.buffer;
}

async function decrypt(packed: ArrayBuffer): Promise<Uint8Array> {
  const bytes = new Uint8Array(packed);
  const plaintext = await crypto.subtle.decrypt(
    { name: "AES-GCM", iv: bytes.slice(0, IV_BYTES) },
    await vaultKey(),
    bytes.slice(IV_BYTES),
  );
  return new Uint8Array(plaintext);
}

export async function saveSeed(seed: Uint8Array): Promise<void> {
  // Szyfrowanie musi zakończyć się PRZED otwarciem transakcji: IndexedDB
  // wymaga wartości synchronicznie, a transakcja z oczekiwaniem na obietnicę
  // zamyka się sama, zanim zdążymy cokolwiek zapisać.
  const packed = await encrypt(seed);
  await tx("readwrite", (store) => store.put(packed, SEED_ID));
}

export async function saveState(state: Uint8Array): Promise<void> {
  const packed = await encrypt(state);
  await tx("readwrite", (store) => store.put(packed, STATE_ID));
}

export async function loadSeed(): Promise<Uint8Array | null> {
  const packed = await tx<ArrayBuffer | undefined>("readonly", (store) => store.get(SEED_ID));
  return packed ? decrypt(packed) : null;
}

export async function loadState(): Promise<Uint8Array | null> {
  const packed = await tx<ArrayBuffer | undefined>("readonly", (store) => store.get(STATE_ID));
  return packed ? decrypt(packed) : null;
}

/**
 * Historia rozmów — szyfrowana tak samo jak reszta skarbca.
 *
 * Serwer jej nie ma i mieć nie będzie. Trafia w całości do zrzutu przy
 * przeniesieniu konta, więc rośnie razem z nim — stąd limit po stronie
 * [`historia.ts`].
 */
export async function saveHistory(history: Uint8Array): Promise<void> {
  const packed = await encrypt(history);
  await tx("readwrite", (store) => store.put(packed, HISTORY_ID));
}

export async function loadHistory(): Promise<Uint8Array | null> {
  const packed = await tx<ArrayBuffer | undefined>("readonly", (store) => store.get(HISTORY_ID));
  return packed ? decrypt(packed) : null;
}

export async function saveAccount(account: Account): Promise<void> {
  await tx("readwrite", (store) => store.put(account, ACCOUNT_ID));
}

export async function loadAccount(): Promise<Account | null> {
  const account = await tx<Account | undefined>("readonly", (store) => store.get(ACCOUNT_ID));
  return account ?? null;
}

/** Kasuje wszystko. Po tym kroku historia rozmów jest nie do odzyskania. */
export async function wipe(): Promise<void> {
  await tx("readwrite", (store) => store.clear());
}

/**
 * Prosi system o trwałe przechowywanie danych.
 *
 * # Dlaczego to nie jest opcjonalne
 *
 * iOS kasuje magazyn aplikacji webowej po około siedmiu dniach nieużywania.
 * Utrata stanu MLS oznacza utratę możliwości odszyfrowania historii — dane
 * przepadają nieodwracalnie, bo serwer ich nie ma.
 *
 * Haczyk: na iOS ta prośba przechodzi **wyłącznie** dla aplikacji dodanej do
 * ekranu głównego i dopiero po zgodzie na powiadomienia. Stąd kolejność
 * onboardingu wymuszona w interfejsie.
 */
export async function requestPersistence(): Promise<boolean> {
  if (!navigator.storage?.persist) return false;
  if (await navigator.storage.persisted()) return true;
  return navigator.storage.persist();
}

/** Czy magazyn jest chroniony przed automatycznym czyszczeniem. */
export async function isPersistent(): Promise<boolean> {
  return (await navigator.storage?.persisted?.()) ?? false;
}

/** Czy aplikacja działa jako zainstalowana PWA (warunek Web Push na iOS). */
export function isInstalled(): boolean {
  return (
    window.matchMedia("(display-mode: standalone)").matches ||
    // Safari na iOS wystawia własną, niestandardową flagę.
    (navigator as { standalone?: boolean }).standalone === true
  );
}
