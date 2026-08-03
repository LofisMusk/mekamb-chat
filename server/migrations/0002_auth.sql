-- Uwierzytelnianie: stan sesji logowania, aktywacja konta, ochrona przed
-- powtórzeniem kodu TOTP.

-- Konto powstaje jako `pending` i staje się `active` dopiero po potwierdzeniu
-- pierwszego kodu z authenticatora.
--
-- Bez tego kroku użytkownik, który nie zeskanował QR, zostawałby z kontem,
-- do którego nigdy się nie zaloguje — a odzyskanie go wymagałoby furtki
-- po stronie serwera, której świadomie nie chcemy mieć.
ALTER TABLE users ADD COLUMN status TEXT NOT NULL DEFAULT 'pending';

-- Licznik ostatnio użytego okna TOTP.
--
-- Bez niego podsłuchany kod działa przez cały swój ~30-sekundowy okres
-- ważności i da się go odtworzyć. Odrzucamy każdy kod z okna, które już
-- zostało wykorzystane.
ALTER TABLE users ADD COLUMN totp_last_counter INTEGER;

-- Stan serwera OPAQUE między rundami logowania.
--
-- Protokół wymaga dwóch podróży, a Worker jest bezstanowy, więc `expected`
-- musi gdzieś przeczekać. Rekord jest JEDNORAZOWY i krótkotrwały.
CREATE TABLE login_sessions (
  id         TEXT PRIMARY KEY,

  -- NULL, gdy nazwa użytkownika nie istnieje.
  --
  -- Sesję zakładamy również dla nieznanej nazwy, bo inaczej sam fakt jej
  -- braku (inny kształt odpowiedzi, inny czas) zdradzałby, które konta
  -- istnieją — a to niweczyłoby ochronę, którą daje OPAQUE.
  user_id    TEXT REFERENCES users(id) ON DELETE CASCADE,

  -- `ExpectedAuthResult` w base64.
  expected   TEXT NOT NULL,

  -- 'awaiting-opaque' → 'awaiting-totp'
  stage      TEXT NOT NULL,

  created_at INTEGER NOT NULL,
  expires_at INTEGER NOT NULL
) STRICT;

CREATE INDEX idx_login_sessions_expiry ON login_sessions(expires_at);
