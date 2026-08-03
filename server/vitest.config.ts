import { cloudflareTest, readD1Migrations } from "@cloudflare/vitest-pool-workers";
import { defineConfig } from "vitest/config";

// Testy działają na `workerd` — tym samym silniku co produkcja. Durable Objects,
// D1 i hibernacja WebSocketów zachowują się jak na Cloudflare, więc nie testujemy
// atrapy, tylko realne zachowanie.

// Migracje czytamy tutaj, bo kod testów działa wewnątrz workerd i nie ma dostępu
// do systemu plików. Wstrzykujemy je jako binding i stosujemy w pliku setup.
const migrations = await readD1Migrations("./migrations");

export default defineConfig({
  resolve: {
    alias: {
      // Patrz komentarz w test/stubs/node-crypto.js. Nasz własny kod nigdy nie
      // importuje gołego `crypto` — używa globalnego Web Crypto — więc ten
      // alias nie ma jak wpłynąć na nic poza sjcl.
      crypto: "./test/stubs/node-crypto.js",
    },
  },
  plugins: [
    cloudflareTest({
      wrangler: { configPath: "./wrangler.jsonc" },
      miniflare: {
        bindings: {
          TEST_MIGRATIONS: migrations,

          // Sekrety testowe. Na produkcji ustawiane przez `wrangler secret put`
          // i nigdy nietrzymane w repozytorium — patrz README serwera.
          TOTP_ENCRYPTION_KEY: "testowy-klucz-szyfrowania-totp",
          TOKEN_SIGNING_KEY: "testowy-klucz-podpisu-tokenow",
          // Dokładnie 32 bajty w base64 — krótsze ziarno odrzuca sama biblioteka.
          OPAQUE_OPRF_SEED: "bWVrYW1iLXRlc3Qtb3ByZi1zZWVkLTAxMjM0NTY3ODk=",
          OPAQUE_AKE_SEED: "bWVrYW1iLXRlc3QtYWtlLXNlZWQtMDEyMzQ1Njc4OTA=",
        },
      },
    }),
  ],
  test: {
    setupFiles: ["./test/setup.ts"],

    // `@cloudflare/voprf-ts` zawiera sjcl w postaci CommonJS. Transformacja
    // ESM w Vite wywraca się na jego `module.exports = ...`, choć produkcyjny
    // bundler (esbuild w wranglerze) radzi sobie z tym bez problemu.
    // Prebundlujemy te zależności esbuildem, żeby testy widziały ten sam
    // kształt modułu co produkcja.
    deps: {
      optimizer: {
        ssr: {
          enabled: true,
          include: ["@cloudflare/opaque-ts", "@cloudflare/voprf-ts"],
        },
      },
    },
  },
});
