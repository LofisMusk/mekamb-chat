-- Urządzenie osiągalne wyłącznie przez skrzynkę.
--
-- Klient natywny publikuje adres węzła iroh i pozwala łączyć się bezpośrednio.
-- Przeglądarka nie może: sandbox nie wysyła pakietów UDP i nie da się do niej
-- zadzwonić z zewnątrz. Takie urządzenie nie ma adresu i odbiera wyłącznie
-- przez skrzynkę — dlatego te kolumny muszą dopuszczać NULL.
--
-- SQLite nie potrafi zmienić więzów kolumny w miejscu, więc przebudowujemy
-- tabelę. Na tym etapie projektu nie ma jeszcze danych produkcyjnych.

CREATE TABLE devices_new (
  id             TEXT PRIMARY KEY,
  user_id        TEXT NOT NULL REFERENCES users(id) ON DELETE CASCADE,
  mls_public_key BLOB NOT NULL,

  -- NULL dla urządzeń bez własnego adresu (przeglądarka).
  iroh_node_id   TEXT,
  addr_record    TEXT,
  addr_signature BLOB,

  display_name   TEXT,
  created_at     INTEGER NOT NULL,
  last_seen_at   INTEGER NOT NULL
) STRICT;

INSERT INTO devices_new
  SELECT id, user_id, mls_public_key, iroh_node_id, addr_record, addr_signature,
         display_name, created_at, last_seen_at
    FROM devices;

DROP TABLE devices;
ALTER TABLE devices_new RENAME TO devices;

CREATE INDEX idx_devices_user ON devices(user_id);
