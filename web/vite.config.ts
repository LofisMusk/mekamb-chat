import react from "@vitejs/plugin-react";
import { defineConfig } from "vitest/config";

const API_URL = process.env.VITE_API_URL ?? "http://localhost:8787";

/**
 * Podstawia w CSP konkretny adres backendu.
 *
 * Bez tego trzeba by wpisać blankietowe `https:`, co pozwalałoby wysłać dane
 * pod dowolny adres. Lista z jednym wpisem sprawia, że nawet wstrzyknięty
 * skrypt nie ma dokąd ich wyekspediować.
 */
function cspConnectSrc() {
  const origin = new URL(API_URL).origin;
  const gniazdo = origin.replace(/^http/, "ws");

  return {
    name: "csp-connect-src",
    // Postać obiektowa z `order: "pre"`: podstawienie musi nastąpić zanim Vite
    // przetworzy HTML, inaczej znacznik idzie do przeglądarki z placeholderem.
    transformIndexHtml: {
      order: "pre" as const,
      handler(html: string) {
        return html.replaceAll("%CONNECT_SRC%", `'self' ${origin} ${gniazdo}`);
      },
    },
  };
}

export default defineConfig({
  // GitHub Pages serwuje projekt pod ścieżką repozytorium, nie w korzeniu domeny.
  base: process.env.GITHUB_PAGES === "true" ? "/mekamb-chat/" : "/",
  plugins: [react(), cspConnectSrc()],
  build: {
    target: "es2022",
    // Kryptografia jako osobny fragment: zmiana interfejsu nie unieważnia
    // wtedy 1,3 MB WASM w cache przeglądarki.
    rollupOptions: {
      output: {
        manualChunks: (id) => (id.includes("src/wasm") ? "krypto" : undefined),
      },
    },
  },
  test: { environment: "node" },
});
