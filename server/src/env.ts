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
}

/** Ile dni koperta czeka w skrzynce, zanim zostanie usunięta. */
export const MAILBOX_RETENTION_DAYS = 30;

/** Górny limit rozmiaru koperty — musi zgadzać się z `MAX_ENVELOPE_BYTES` w Rust. */
export const MAX_ENVELOPE_BYTES = 1024 * 1024;
