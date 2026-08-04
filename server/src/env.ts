import type { GroupRelay } from "./group";
import type { RateLimiter } from "./ratelimit";
import type { UserInbox } from "./inbox";

export interface Env {
  DB: D1Database;
  /**
   * Kubełek na zaszyfrowane załączniki.
   *
   * Opcjonalny: R2 wymaga jednorazowej aktywacji w panelu Cloudflare, więc
   * wdrożenie bez niego jest poprawnym stanem. Endpointy załączników sprawdzają
   * obecność bindingu i zwracają czytelny błąd, zamiast wywracać się na
   * `undefined`.
   */
  ATTACHMENTS?: R2Bucket;

  USER_INBOX: DurableObjectNamespace<UserInbox>;
  GROUP_RELAY: DurableObjectNamespace<GroupRelay>;
  RATE_LIMITER: DurableObjectNamespace<RateLimiter>;

  /** Klucz szyfrujący sekrety TOTP w bazie. Ustawiany przez `wrangler secret put`. */
  TOTP_ENCRYPTION_KEY: string;

  /** Klucz podpisujący tokeny dostępowe. */
  TOKEN_SIGNING_KEY: string;

  /**
   * Sekret serwera OPAQUE (base64), wygenerowany przez `generateServerKey`.
   *
   * Zmiana tej wartości unieważnia WSZYSTKIE konta — z niej wyprowadzany jest
   * materiał wiążący hasła użytkowników z tym wdrożeniem. Traktować jak dane,
   * których utrata jest nieodwracalna.
   */
  OPAQUE_SERVER_KEY: string;

  /**
   * Wspólny sekret serwera TURN. Opcjonalny.
   *
   * Bez niego rozmowy działają przez samo STUN — nie uda się tylko połączenie
   * między dwiema stronami za restrykcyjnym NAT-em.
   */
  TURN_SHARED_SECRET?: string;

  /** Adres serwera TURN, np. `turn:turn.example.org:3478`. Opcjonalny. */
  TURN_URL?: string;

  /**
   * Lista źródeł, którym wolno wołać to API, rozdzielona przecinkami.
   *
   * Świadomie lista, a nie `*`. Klient webowy stoi pod innym adresem niż API
   * (GitHub Pages kontra workers.dev), więc cross-origin jest tu normalnym
   * przypadkiem — a to znaczy, że kontrola źródła jest jedyną barierą przed
   * wołaniem tego API z dowolnej cudzej strony.
   */
  ALLOWED_ORIGINS: string;
}

/** Ile dni koperta czeka w skrzynce, zanim zostanie usunięta. */
export const MAILBOX_RETENTION_DAYS = 30;

/** Górny limit rozmiaru koperty — musi zgadzać się z `MAX_ENVELOPE_BYTES` w Rust. */
export const MAX_ENVELOPE_BYTES = 1024 * 1024;
