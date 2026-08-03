import type { GroupRelay } from "./group";
import type { RateLimiter } from "./ratelimit";
import type { UserInbox } from "./inbox";

export interface Env {
  DB: D1Database;
  ATTACHMENTS: R2Bucket;

  USER_INBOX: DurableObjectNamespace<UserInbox>;
  GROUP_RELAY: DurableObjectNamespace<GroupRelay>;
  RATE_LIMITER: DurableObjectNamespace<RateLimiter>;

  /** Klucz szyfrujący sekrety TOTP w bazie. Ustawiany przez `wrangler secret put`. */
  TOTP_ENCRYPTION_KEY: string;

  /** Klucz podpisujący tokeny dostępowe. */
  TOKEN_SIGNING_KEY: string;

  /**
   * Ziarno OPRF serwera OPAQUE (base64).
   *
   * Zmiana tej wartości unieważnia WSZYSTKIE rejestracje — z niej wyprowadzany
   * jest materiał wiążący hasła użytkowników z tym wdrożeniem.
   */
  OPAQUE_OPRF_SEED: string;

  /** Ziarno klucza AKE serwera OPAQUE (base64). Zmiana też unieważnia konta. */
  OPAQUE_AKE_SEED: string;

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
