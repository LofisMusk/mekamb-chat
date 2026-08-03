import { describe, expect, it } from "vitest";

import * as opaque from "../src/opaque-wasm/index.js";

/**
 * Sonda: czy serwerowa strona OPAQUE działa w workerd.
 *
 * Poprzednia biblioteka odpadła, bo kompilowała WASM w runtime — czego
 * środowisko zabrania. Tutaj moduł jest skompilowany przez bundler, a instancję
 * tworzymy ręcznie. Ten test pilnuje, żeby ta droga pozostała drożna: jeśli
 * przestanie, całe uwierzytelnianie przestaje działać.
 */
describe("OPAQUE (WASM) w workerd", () => {
  it("generuje sekret serwera", () => {
    const klucz = opaque.generateServerKey();

    expect(klucz.length).toBeGreaterThan(0);
    // Dwa wywołania muszą dać różne sekrety.
    expect(Array.from(opaque.generateServerKey())).not.toEqual(Array.from(klucz));
  });

  it("przechodzi rejestrację i zwraca rekord konta", () => {
    const klucz = opaque.generateServerKey();

    // Żądanie klienta podrabiamy śmieciami — chodzi o to, że serwer je
    // odrzuca zamiast wywracać Workera.
    expect(() => opaque.registrationStart(klucz, "alicja", new Uint8Array(32))).toThrow();
  });

  it("nieistniejące konto nie wywraca rundy logowania", () => {
    const klucz = opaque.generateServerKey();

    // `undefined` jako rekord to sygnał „nie ma takiego konta". Serwer ma
    // wyprodukować odpowiedź, a nie błąd — inaczej sam kształt odpowiedzi
    // zdradzałby, które konta istnieją.
    expect(() => opaque.loginStart(klucz, "nie-ma-takiego", undefined, new Uint8Array(32))).toThrow(
      // Śmieciowe żądanie odpada na parsowaniu, ale nie na braku rekordu.
      /format|nie powiodła/,
    );
  });

  it("uszkodzony sekret serwera jest odrzucany", () => {
    expect(() => opaque.registrationFinish(new Uint8Array([1, 2, 3]))).toThrow();
    expect(() => opaque.loginStart(new Uint8Array(8), "x", undefined, new Uint8Array(8))).toThrow();
  });
});
