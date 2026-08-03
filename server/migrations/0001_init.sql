-- Schemat D1: wyłącznie metadane kont.
--
-- Czego tu NIE MA i nigdy nie będzie: treści wiadomości, kluczy prywatnych,
-- historii rozmów. Serwer nie ma czego wydać ani zgubić.

CREATE TABLE users (
  id              TEXT PRIMARY KEY,
  username        TEXT NOT NULL UNIQUE,

  -- Rekord OPAQUE. Nie jest hashem hasła — z samego rekordu nie da się
  -- prowadzić ataku słownikowego offline tak jak z hasha.
  opaque_record   TEXT NOT NULL,

  -- Sekret TOTP zaszyfrowany kluczem z Workers Secrets. Wyciek samej bazy
  -- nie wystarcza wtedy do generowania kodów drugiego składnika.
  totp_secret_enc TEXT NOT NULL,

  created_at      INTEGER NOT NULL
) STRICT;

CREATE TABLE devices (
  id             TEXT PRIMARY KEY,
  user_id        TEXT NOT NULL REFERENCES users(id) ON DELETE CASCADE,

  -- Klucz publiczny podpisu MLS. Na jego podstawie liczony jest safety number.
  mls_public_key BLOB NOT NULL,

  -- Adres węzła iroh (JSON) wraz z podpisem kluczem MLS urządzenia.
  --
  -- Podpis jest tu kluczowy: bez niego serwer mógłby podstawić własny adres
  -- i przechwytywać połączenia. Klient MUSI zweryfikować podpis przed użyciem
  -- adresu — serwer nie jest zaufanym źródłem.
  iroh_node_id   TEXT NOT NULL,
  addr_record    TEXT NOT NULL,
  addr_signature BLOB NOT NULL,

  display_name   TEXT,
  created_at     INTEGER NOT NULL,
  last_seen_at   INTEGER NOT NULL
) STRICT;

CREATE INDEX idx_devices_user ON devices(user_id);

-- Key packages pozwalają dodać urządzenie do grupy, gdy jest offline
-- (odpowiednik prekeys w Signalu).
--
-- Każdy jest JEDNORAZOWY. Wydanie tego samego dwa razy psuje gwarancje forward
-- secrecy, więc jednokrotność egzekwuje serwer — patrz `consumeKeyPackage`.
CREATE TABLE key_packages (
  id          TEXT PRIMARY KEY,
  device_id   TEXT NOT NULL REFERENCES devices(id) ON DELETE CASCADE,
  blob        BLOB NOT NULL,
  created_at  INTEGER NOT NULL,
  consumed_at INTEGER
) STRICT;

-- Indeks częściowy: interesują nas wyłącznie niezużyte pakiety.
CREATE INDEX idx_key_packages_available
  ON key_packages(device_id)
  WHERE consumed_at IS NULL;

-- Rejestr grup. Serwer zna SKŁAD grupy (bo przez niego idą commity),
-- ale nie zna treści rozmów. Wyciek metadanych opisany w THREAT_MODEL.md.
CREATE TABLE group_members (
  group_id  TEXT NOT NULL,
  user_id   TEXT NOT NULL REFERENCES users(id) ON DELETE CASCADE,
  joined_at INTEGER NOT NULL,
  PRIMARY KEY (group_id, user_id)
) STRICT;

CREATE INDEX idx_group_members_user ON group_members(user_id);
