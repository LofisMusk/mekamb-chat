import { readFileSync } from "node:fs";
import { fileURLToPath } from "node:url";

import { describe, expect, it } from "vitest";

import { kontoZLogowania } from "./vault";

/**
 * Tożsamość konta w sieci.
 *
 * Sedno: `userId` jest jednocześnie adresem skrzynki (`connectInbox`) i nazwą,
 * pod którą widzą nas inni w drzewie MLS. Zapraszający deponuje welcome pod
 * **nazwą użytkownika** z katalogu, bo niczego innego o nas nie wie — więc
 * `userId` musi być tą samą nazwą. Rozjazd oznacza, że welcome trafia do
 * skrzynki, której nikt nie słucha: odbiorca nie dołącza do grupy i nie
 * odszyfrowuje żadnej wiadomości, a nadawca nie widzi przy tym błędu.
 */
describe("konto z logowania", () => {
  it("adresuje skrzynkę nazwą użytkownika, nie identyfikatorem z bazy", () => {
    const konto = kontoZLogowania("ala", "web-1234abcd");

    expect(konto.userId).toBe("ala");
    expect(konto.username).toBe("ala");
    expect(konto.deviceId).toBe("web-1234abcd");
  });

  /// Sedno: serwer zwraca przy logowaniu passkeyem OSOBNY `userId` (UUID
  /// z bazy). Wzięcie go za tożsamość konta było właśnie tą regresją —
  /// przeglądarka nasłuchiwała pod UUID-em, a zaproszenie szło pod nazwę.
  it("nie bierze identyfikatora zwróconego przez serwer", () => {
    const wynikPasskey = {
      userId: "3f2a1b6c-0e4d-4a91-8c5f-7b2d9e10a4c8",
      username: "ala",
    };

    const konto = kontoZLogowania(wynikPasskey.username, "web-1234abcd");

    expect(konto.userId).not.toBe(wynikPasskey.userId);
    expect(konto.userId).toBe(wynikPasskey.username);
  });

  /**
   * Sedno: powyższe sprawdza samą funkcję, ale regresja siedziała w **miejscu
   * wywołania** — ekran logowania budował konto literałem obok niej. Tego nie
   * da się złapać inaczej niż patrząc na źródło, więc patrzymy: konto ma
   * powstawać wyłącznie przez `kontoZLogowania`.
   */
  it("ekran logowania nie składa konta z pominięciem tej funkcji", () => {
    const zrodlo = readFileSync(fileURLToPath(new URL("../App.tsx", import.meta.url)), "utf8");

    expect(zrodlo).not.toMatch(/userId:\s*wynik\.userId/);
    expect(zrodlo).not.toMatch(/\{\s*userId:[^}]*username[^}]*deviceId/);
  });
});
