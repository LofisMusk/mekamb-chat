import type { D1Migration } from "@cloudflare/vitest-pool-workers";

import type { Env as AppEnv } from "../src/env";

// `env` z `cloudflare:test` jest typowane globalnym `Cloudflare.Env`, więc to
// jego rozszerzamy o nasze bindingi. `TEST_MIGRATIONS` jest wstrzykiwane
// wyłącznie w testach przez `vitest.config.ts` i nie istnieje na produkcji.
declare global {
  namespace Cloudflare {
    interface Env extends AppEnv {
      TEST_MIGRATIONS: D1Migration[];
    }
  }
}

export {};
