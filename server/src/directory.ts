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

/** Sprowadza dowolną postać BLOB-a z D1 do bajtów. */
export function toBytes(value: D1Blob): Uint8Array {
  if (value instanceof Uint8Array) return value;
  if (value instanceof ArrayBuffer) return new Uint8Array(value);
  return Uint8Array.from(value);
}

export interface DeviceRecord {
  deviceId: string;
  userId: string;
  mlsPublicKey: D1Blob;
  irohNodeId: string;
  addrRecord: string;
  addrSignature: D1Blob;
  lastSeenAt: number;
}

/** Zwraca wszystkie urządzenia użytkownika wraz z podpisanymi adresami. */
export async function lookupDevices(env: Env, username: string): Promise<DeviceRecord[]> {
  const { results } = await env.DB.prepare(
    `SELECT d.id            AS deviceId,
            d.user_id       AS userId,
            d.mls_public_key AS mlsPublicKey,
            d.iroh_node_id  AS irohNodeId,
            d.addr_record   AS addrRecord,
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
