-- Trwała sesja: token odświeżający w httpOnly cookie, żeby klient webowy nie
-- musiał przechodzić OPAQUE+TOTP przy każdym odświeżeniu strony.
--
-- Jeden aktywny token na urządzenie: `UNIQUE(device_id)` + rotacja przy każdym
-- użyciu (nowy token nadpisuje wiersz starego). Dzięki temu powtórne użycie
-- skradzionego, już zrotowanego tokenu po prostu nie znajduje pasującego
-- wiersza — nie trzeba osobnej detekcji powtórzenia.
--
-- `device_id` NIE ma więzu REFERENCES do `devices`: token dostępowy (a więc
-- i refresh) powstaje w `/auth/login/totp`, ZANIM klient zdąży zarejestrować
-- urządzenie przez `POST /devices` (patrz `App.tsx` — rejestracja idzie po
-- zapisaniu konta i odtworzeniu `Messenger`). Wymaganie istniejącego wiersza
-- `devices` w tym miejscu zrywałoby pierwsze logowanie na nowym urządzeniu.
--
-- Przechowujemy HASH tokenu, nie sam token — wyciek bazy nie daje wtedy
-- gotowej sesji, tak samo jak przy sekretach TOTP (`encryptSecret`).
CREATE TABLE refresh_tokens (
  id         TEXT PRIMARY KEY,
  user_id    TEXT NOT NULL REFERENCES users(id) ON DELETE CASCADE,
  device_id  TEXT NOT NULL,
  token_hash TEXT NOT NULL,
  created_at INTEGER NOT NULL,
  expires_at INTEGER NOT NULL,
  UNIQUE(device_id)
) STRICT;

CREATE INDEX idx_refresh_tokens_expiry ON refresh_tokens(expires_at);
