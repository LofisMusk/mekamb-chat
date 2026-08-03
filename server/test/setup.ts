import { applyD1Migrations, env } from "cloudflare:test";

// Schemat wgrywany jest z tych samych plików migracji co na produkcji — testy
// nie mają własnej, rozjeżdżającej się kopii schematu.
await applyD1Migrations(env.DB, env.TEST_MIGRATIONS);
