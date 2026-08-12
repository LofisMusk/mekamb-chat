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
        // R2 jest w konfiguracji produkcyjnej zakomentowane, dopóki nie zostanie
        // włączone na koncie Cloudflare. Testy i tak muszą sprawdzać załączniki,
        // a miniflare symuluje kubełek bez sięgania po prawdziwy R2.
        r2Buckets: ["ATTACHMENTS"],

        bindings: {
          TEST_MIGRATIONS: migrations,

          // Sekrety testowe. Na produkcji ustawiane przez `wrangler secret put`
          // i nigdy nietrzymane w repozytorium — patrz README serwera.
          TOTP_ENCRYPTION_KEY: "testowy-klucz-szyfrowania-totp",
          TOKEN_SIGNING_KEY: "testowy-klucz-podpisu-tokenow",
          // Sekret serwera OPAQUE wygenerowany raz i przypięty, żeby konta
          // zakładane w testach dawały się w nich zalogować.
          OPAQUE_SERVER_KEY:
            "SjEx2h2qb2r14pDqmG/ljG4FzQBMAuZ7sMGibfK2KjI8LBEx+SinI/dekSRoxIiwNaVnbXREud1Rk86b5jeO+4pCXg4nBhD8zdjjEGp42tt3gHC9Q1vaNcxE5OMVIWUJdinK/KSSqBEo3zGbHJmZWbYzMAP0p18FGieTJuB/RXk=",

          // Klucz wydawania tokenów doręczeniowych: 32 bajty skalara Ristretto,
          // przypięty tak samo jak sekret OPAQUE. Wymuszanie jest w testach
          // WYŁĄCZONE, bo domyślne wdrożenie też je ma wyłączone — włącza się
          // je dopiero wtedy, gdy klienty umieją brać tokeny.
          DELIVERY_TOKEN_KEY: "mdLiOxwVngJb1ZE64FuXJ65NBPhO/MF2xFL8IP8wYAw=",

          // WebAuthn potrzebuje `origin`/`rpID` przy weryfikacji ceremonii —
          // testy podpisują odpowiedzi authenticatora pod ten sam origin.
          ALLOWED_ORIGINS: "https://mekamb.test",
          WEBAUTHN_RP_ID: "mekamb.test",
          WEBAUTHN_RP_NAME: "mekamb-chat (testy)",
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
  },
});
