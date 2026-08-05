-- Logowanie passkeyem (WebAuthn) jako dodatkowa metoda obok OPAQUE+TOTP.
--
-- Rejestrowane klucze są discoverable/resident (`residentKey: 'required'`),
-- więc logowanie nie wymaga wpisania nazwy użytkownika — stąd
-- `webauthn_challenges.user_id` bywa NULL: przy logowaniu jeszcze nie wiemy,
-- kto się loguje, dopóki authenticator nie wskaże credentiala.

-- Zarejestrowane klucze publiczne passkey. `device_id` jest tu wyłącznie
-- informacyjny (bez REFERENCES) z tego samego powodu co w
-- `refresh_tokens.device_id`: rejestracja passkeya nie musi zachodzić po
-- rejestracji urządzenia w `devices`.
CREATE TABLE webauthn_credentials (
  id           TEXT PRIMARY KEY,  -- credential ID, base64url
  user_id      TEXT NOT NULL REFERENCES users(id) ON DELETE CASCADE,
  device_id    TEXT NOT NULL,
  public_key   BLOB NOT NULL,     -- klucz publiczny COSE
  sign_count   INTEGER NOT NULL,
  transports   TEXT,              -- JSON, informacyjne
  nazwa        TEXT,              -- etykieta ustawiana przez użytkownika
  created_at   INTEGER NOT NULL,
  last_used_at INTEGER
) STRICT;

CREATE INDEX idx_webauthn_credentials_user ON webauthn_credentials(user_id);

-- Stan wyzwania (challenge) między rundami ceremonii WebAuthn — Worker jest
-- bezstanowy, więc `challenge` musi gdzieś przeczekać, tak jak
-- `login_sessions` dla OPAQUE.
CREATE TABLE webauthn_challenges (
  id         TEXT PRIMARY KEY,
  user_id    TEXT REFERENCES users(id) ON DELETE CASCADE,
  challenge  TEXT NOT NULL,
  typ        TEXT NOT NULL,  -- 'rejestracja' | 'logowanie'
  expires_at INTEGER NOT NULL
) STRICT;

CREATE INDEX idx_webauthn_challenges_expiry ON webauthn_challenges(expires_at);
