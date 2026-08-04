import type { Env } from "./env";

/**
 * Katalog urządzeń i key packages.
 *
 * # Serwer nie jest zaufanym źródłem adresów
 *
 * Rekord adresowy jest przechowywany razem z podpisem złożonym kluczem MLS
 * urządzenia. Serwer tego podpisu nie weryfikuje i nie musi — robi to **klient**
 * przed użyciem adresu. Gdyby serwer podstawił własny adres, podpis by się nie
 * zgadzał i klient odrzuciłby rekord.
 *
 * Ten moduł celowo nie zawiera weryfikacji podpisu: kod działający na serwerze
 * nie może być podstawą zaufania do danych, które serwer sam wydaje.
 */

/**
 * Postać, w jakiej D1 zwraca kolumny BLOB.
 *
 * Wbrew intuicji **nie** jest to `ArrayBuffer` — sterownik oddaje zwykłą
 * tablicę liczb. Bez normalizacji `btoa(String.fromCharCode(...new Uint8Array(x)))`
 * cicho produkuje śmieci albo rzuca wyjątkiem dopiero na produkcji.
 */
type D1Blob = ArrayBuffer | Uint8Array | number[];

/**
 * Sprowadza dowolną postać BLOB-a z D1 do bajtów.
 *
 * Przyjmuje `null`, bo urządzenia bez własnego adresu (przeglądarka) mają
 * puste kolumny adresowe — to poprawny stan, nie brak danych.
 */
export function toBytes(value: D1Blob | null | undefined): Uint8Array | null {
  if (value === null || value === undefined) return null;
  if (value instanceof Uint8Array) return value;
  if (value instanceof ArrayBuffer) return new Uint8Array(value);
  return Uint8Array.from(value);
}

export interface DeviceRecord {
  deviceId: string;
  userId: string;
  mlsPublicKey: D1Blob;
  /** Klucz publiczny transportu (base64). `null` = tylko skrzynka. */
  transportKey: string | null;
  /** Adresy rozdzielone przecinkami. `null` = tylko skrzynka. */
  transportAddresses: string | null;
  addrSignature: D1Blob | null;
  lastSeenAt: number;
}

/** Zwraca wszystkie urządzenia użytkownika wraz z podpisanymi adresami. */
export async function lookupDevices(env: Env, username: string): Promise<DeviceRecord[]> {
  const { results } = await env.DB.prepare(
    `SELECT d.id            AS deviceId,
            d.user_id       AS userId,
            d.mls_public_key AS mlsPublicKey,
            d.transport_key       AS transportKey,
            d.transport_addresses AS transportAddresses,
            d.addr_signature AS addrSignature,
            d.last_seen_at  AS lastSeenAt
       FROM devices d
       JOIN users u ON u.id = d.user_id
      WHERE u.username = ?`,
  )
    .bind(username)
    .all<DeviceRecord>();

  return results;
}

/**
 * Wydaje jeden niezużyty key package i od razu oznacza go jako zużyty.
 *
 * # Dlaczego to jedno zapytanie, a nie SELECT plus UPDATE
 *
 * Key package jest jednorazowy: dwukrotne wydanie tego samego psuje gwarancje
 * forward secrecy MLS. Rozbicie na `SELECT` i `UPDATE` otwiera okno, w którym
 * dwa równoległe żądania dostaną ten sam wiersz.
 *
 * `UPDATE ... RETURNING` z podzapytaniem wybierającym kandydata wykonuje się
 * w SQLite niepodzielnie, więc wiersz może zostać przejęty dokładnie raz.
 *
 * Zwraca `null`, gdy zapas się wyczerpał — klient uzupełnia go przy każdym
 * logowaniu, ale przy intensywnym dodawaniu do grup może się skończyć.
 */
export async function consumeKeyPackage(
  env: Env,
  deviceId: string,
): Promise<Uint8Array | null> {
  const row = await env.DB.prepare(
    `UPDATE key_packages
        SET consumed_at = ?
      WHERE id = (
              SELECT id FROM key_packages
               WHERE device_id = ? AND consumed_at IS NULL
               ORDER BY created_at
               LIMIT 1
            )
      RETURNING blob`,
  )
    .bind(Date.now(), deviceId)
    .first<{ blob: D1Blob }>();

  return row === null ? null : toBytes(row.blob);
}

/** Liczba niezużytych key packages — klient uzupełnia zapas, gdy spadnie. */
export async function availableKeyPackages(env: Env, deviceId: string): Promise<number> {
  const row = await env.DB.prepare(
    "SELECT COUNT(*) AS n FROM key_packages WHERE device_id = ? AND consumed_at IS NULL",
  )
    .bind(deviceId)
    .first<{ n: number }>();

  return row?.n ?? 0;
}

/** Publikuje zapas key packages dla urządzenia. */
export async function publishKeyPackages(
  env: Env,
  deviceId: string,
  packages: ArrayBuffer[],
): Promise<number> {
  const now = Date.now();

  const statements = packages.map((blob) =>
    env.DB.prepare(
      "INSERT INTO key_packages (id, device_id, blob, created_at) VALUES (?, ?, ?, ?)",
    ).bind(crypto.randomUUID(), deviceId, blob, now),
  );

  await env.DB.batch(statements);
  return packages.length;
}

/**
 * Rejestruje urządzenie użytkownika albo odświeża jego wpis.
 *
 * Klucz transportowy i adresy są opcjonalne: przeglądarka nie ma własnego
 * adresu, bo sandbox nie pozwala jej przyjmować połączeń. Takie urządzenie
 * odbiera wyłącznie przez skrzynkę i to jest poprawny, zamierzony stan — a nie
 * brak konfiguracji.
 */
export async function registerDevice(
  env: Env,
  device: {
    deviceId: string;
    userId: string;
    mlsPublicKey: Uint8Array;
    transportKey?: string | null;
    transportAddresses?: string | null;
    addrSignature?: Uint8Array | null;
    displayName?: string | null;
  },
): Promise<void> {
  const now = Date.now();

  await env.DB.prepare(
    `INSERT INTO devices
       (id, user_id, mls_public_key, transport_key, transport_addresses, addr_signature,
        display_name, created_at, last_seen_at)
     VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?)
     ON CONFLICT(id) DO UPDATE SET
       mls_public_key       = excluded.mls_public_key,
       transport_key        = excluded.transport_key,
       transport_addresses  = excluded.transport_addresses,
       addr_signature = excluded.addr_signature,
       last_seen_at   = excluded.last_seen_at`,
  )
    .bind(
      device.deviceId,
      device.userId,
      device.mlsPublicKey,
      device.transportKey ?? null,
      device.transportAddresses ?? null,
      device.addrSignature ?? null,
      device.displayName ?? null,
      now,
      now,
    )
    .run();
}
