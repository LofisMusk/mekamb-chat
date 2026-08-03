/**
 * Typy dla modułu OPAQUE w WebAssembly.
 *
 * Pisane ręcznie, bo `glue.js` re-eksportuje wybrane funkcje z kodu
 * wygenerowanego przez wasm-bindgen — a ten nie wie o naszym opakowaniu.
 */

/** Losuje nowy sekret serwera. **Zmiana unieważnia wszystkie konta.** */
export function generateServerKey(): Uint8Array;

export function registrationStart(
  serverKey: Uint8Array,
  username: string,
  request: Uint8Array,
): Uint8Array;

export function registrationFinish(upload: Uint8Array): Uint8Array;

export interface LoginStart {
  /** Do odesłania klientowi. */
  response: Uint8Array;
  /** Stan między rundami. **Sekret** — trzymać po stronie serwera. */
  state: Uint8Array;
}

/**
 * Runda 1 logowania.
 *
 * `record` jako `undefined` znaczy „nie ma takiego konta" — biblioteka
 * produkuje wtedy odpowiedź nieodróżnialną od prawdziwej.
 */
export function loginStart(
  serverKey: Uint8Array,
  username: string,
  record: Uint8Array | undefined,
  request: Uint8Array,
): LoginStart;

export function loginFinish(
  state: Uint8Array,
  username: string,
  finalization: Uint8Array,
): Uint8Array;

// --- strona klienta: tylko do testów ---

export interface ClientStart {
  request: Uint8Array;
  state: Uint8Array;
}

export function clientRegisterStart(password: string): ClientStart;

export function clientRegisterFinish(
  state: Uint8Array,
  password: string,
  username: string,
  response: Uint8Array,
): Uint8Array;

export function clientLoginStart(password: string): ClientStart;

export function clientLoginFinish(
  state: Uint8Array,
  password: string,
  username: string,
  response: Uint8Array,
): Uint8Array;
