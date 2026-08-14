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
const REFRESH_ID = "token-odswiezajacy";

const IV_BYTES = 12;

export interface Account {
  userId: string;
  username: string;
  deviceId: string;
}

/**
 * Składa konto na podstawie tego, co zwróciło logowanie.
 *
 * # Dlaczego `userId` to nazwa użytkownika, a nie identyfikator z serwera
 *
 * `userId` nie jest tu wewnętrznym kluczem bazy — jest **adresem skrzynki**
 * i **tożsamością w drzewie MLS**. Trafia w trzy miejsca, które muszą się
 * zgadzać co do jednego znaku:
 *
 * 1. `connectInbox(account.userId)` — pod tą nazwą nasłuchujemy,
 * 2. `new MekambClient(account.userId, …)` — pod tą nazwą widzą nas inni
 *    w grupie (`members()` zwraca `user_id:device_id`),
 * 3. `addMember` rozmówcy — welcome deponuje pod **nazwą użytkownika**
 *    z katalogu, bo tylko ją zna, zanim nas do grupy doda.
 *
 * Punkt 3 przesądza sprawę: nazwa użytkownika to jedyny identyfikator, który
 * strona zapraszająca ma w ręku. Ta sama konwencja obowiązuje w kliencie
 * Androida (`Vault.kt`: `userId get() = username`) i w formacie zrzutu przy
 * przenoszeniu konta, więc nie da się jej zmienić po jednej stronie.
 *
 * Ta funkcja istnieje, żeby obie ścieżki logowania — TOTP i passkey — nie
 * mogły się co do tego rozjechać. Rozjechały się już raz: passkey zapisywał
 * tu `userId` z serwera (UUID), więc świeżo zalogowana przeglądarka
 * nasłuchiwała pod UUID-em, a zaproszenie szło pod nazwę użytkownika. Welcome
 * nie dochodził, odbiorca nie dołączał do grupy i **żadna wiadomość nie była
 * odszyfrowywana** — a nadawca nie widział przy tym błędu.
 */
export function kontoZLogowania(username: string, deviceId: string): Account {
  return { userId: username, username, deviceId };
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
 * Serwer jej nie ma i mieć nie będzie. Trafia w całości do transferu optycznego
 * przy parowaniu, więc rośnie razem z nim — stąd limit po stronie
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

/**
 * Token trwałej sesji — szyfrowany tak samo jak reszta skarbca.
 *
 * # Dlaczego nie zostaje w cookie
 *
 * Strona stoi na `github.io`, a API na `workers.dev`, więc dla przeglądarki
 * to cookie **trzeciej strony**. Safari blokuje takie cookie domyślnie, a na
 * iOS Safari jest jedynym silnikiem — więc `Set-Cookie` z serwera po prostu
 * znikało i iPhone wylogowywał się przy każdym zamknięciu aplikacji. Na
 * desktopie ta sama ścieżka działała bez zarzutu, więc usterki nie było widać
 * stamtąd, skąd się ją pisze.
 *
 * Czym to płacimy, opisuje `server/src/session.ts`: token przestaje być
 * `httpOnly`. W tym magazynie leży już ziarno urządzenia i stan MLS, więc
 * skrypt wstrzyknięty na stronę i tak ma wszystko (docs/THREAT_MODEL.md) —
 * a bez tego iPhone nie ma trwałej sesji w ogóle.
 */
export async function saveRefreshToken(token: string): Promise<void> {
  const packed = await encrypt(new TextEncoder().encode(token));
  await tx("readwrite", (store) => store.put(packed, REFRESH_ID));
}

export async function loadRefreshToken(): Promise<string | null> {
  const packed = await tx<ArrayBuffer | undefined>("readonly", (store) => store.get(REFRESH_ID));
  if (!packed) return null;

  // Uszkodzony albo niepełny wpis nie może wywrócić startu — brak tokenu
  // znaczy tyle, co ekran logowania.
  return await decrypt(packed)
    .then((bytes) => new TextDecoder().decode(bytes))
    .catch(() => null);
}

/** Kasuje token trwałej sesji — przy wylogowaniu i po jego odrzuceniu przez serwer. */
export async function clearRefreshToken(): Promise<void> {
  await tx("readwrite", (store) => store.delete(REFRESH_ID));
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
