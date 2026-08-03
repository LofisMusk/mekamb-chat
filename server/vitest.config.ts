import { cloudflareTest, readD1Migrations } from "@cloudflare/vitest-pool-workers";
import { defineConfig } from "vitest/config";

// Testy działają na `workerd` — tym samym silniku co produkcja. Durable Objects,
// D1 i hibernacja WebSocketów zachowują się jak na Cloudflare, więc nie testujemy
// atrapy, tylko realne zachowanie.

// Migracje czytamy tutaj, bo kod testów działa wewnątrz workerd i nie ma dostępu
// do systemu plików. Wstrzykujemy je jako binding i stosujemy w pliku setup.
const migrations = await readD1Migrations("./migrations");

export default defineConfig({
  plugins: [
    cloudflareTest({
      wrangler: { configPath: "./wrangler.jsonc" },
      miniflare: {
        bindings: { TEST_MIGRATIONS: migrations },
      },
    }),
  ],
  test: {
    setupFiles: ["./test/setup.ts"],
  },
});
