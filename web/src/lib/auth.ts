import init, {
  opaqueLoginFinish,
  opaqueLoginStart,
  opaqueRegisterFinish,
  opaqueRegisterStart,
} from "../wasm/mekamb_wasm";
import { api, base64ToBytes, bytesToBase64 } from "./api";

/**
 * Rejestracja i logowanie po stronie przeglądarki.
 *
 * # Hasło nie opuszcza tej maszyny
 *
 * OPAQUE wykonuje kosztowną część obliczeń tutaj, u klienta, i wysyła na serwer
 * wyłącznie ślepe wartości. Serwer nigdy nie widzi hasła — ani przy rejestracji,
 * ani przy logowaniu — więc nie ma czego z niego wyciec.
 *
 * # Ten sam kod co na serwerze
 *
 * Kryptografia pochodzi z `mekamb-opaque` (Rust, RFC 9807) skompilowanego do
 * WebAssembly — z tego samego modułu, który obsługuje MLS. Serwer używa tego
 * samego kodu, więc zgodność wynika z konstrukcji.
 */

let wasmReady: Promise<unknown> | null = null;

function ensureWasm(): Promise<unknown> {
  wasmReady ??= init();
  return wasmReady;
}

export interface RegistrationResult {
  /** Sekret do wpisania w aplikacji authenticator. Pokazywany dokładnie raz. */
  totpSecret: string;
  /** URI `otpauth://` do wyrenderowania jako kod QR. */
  otpauthUri: string;
}

/** Zakłada konto. Nieaktywne aż do [`confirmRegistration`]. */
export async function register(
  username: string,
  password: string,
): Promise<RegistrationResult> {
  await ensureWasm();

  const start = opaqueRegisterStart(password);

  const { registrationResponse } = await api.post<{ registrationResponse: string }>(
    "/auth/register/start",
    { username, registrationRequest: bytesToBase64(start.request) },
  );

  const finish = opaqueRegisterFinish(
    start.state,
    password,
    username,
    base64ToBytes(registrationResponse),
  );

  // `export_key` to klucz wyprowadzony z hasła, nieznany serwerowi. Nadaje się
  // do szyfrowania kopii zapasowych, których serwer ma nie umieć odczytać —
  // na razie go nie używamy, ale świadomie nigdzie nie wysyłamy.
  void finish.export_key;

  return api.post<RegistrationResult>("/auth/register/finish", {
    username,
    registrationRecord: bytesToBase64(finish.upload),
  });
}

/** Aktywuje konto pierwszym kodem z authenticatora. */
export async function confirmRegistration(username: string, code: string): Promise<void> {
  await api.post("/auth/register/confirm", { username, code });
}

export interface LoginSession {
  loginId: string;
  username: string;
}

/**
 * Przeprowadza wymianę OPAQUE i zatrzymuje się przed drugim składnikiem.
 *
 * Błędne hasło wykrywa **klient**, a nie serwer — dlatego rzucamy tu wyjątek,
 * zanim cokolwiek pójdzie dalej.
 */
export async function loginStart(username: string, password: string): Promise<LoginSession> {
  await ensureWasm();

  const start = opaqueLoginStart(password);

  const { loginId, ke2 } = await api.post<{ loginId: string; ke2: string }>("/auth/login/start", {
    username,
    ke1: bytesToBase64(start.request),
  });

  let finish;
  try {
    finish = opaqueLoginFinish(start.state, password, username, base64ToBytes(ke2));
  } catch {
    // To samo dla złego hasła i nieistniejącego konta — serwer celowo nie
    // pozwala ich odróżnić, więc komunikat też nie może.
    throw new Error("nieprawidłowa nazwa użytkownika lub hasło");
  }

  await api.post("/auth/login/finish", {
    loginId,
    username,
    ke3: bytesToBase64(finish.finalization),
  });

  return { loginId, username };
}

export interface AccessToken {
  token: string;
  expiresAt: number;
}

/** Kończy logowanie kodem TOTP i odbiera token dostępowy. */
export async function loginWithTotp(
  session: LoginSession,
  code: string,
  deviceId: string,
): Promise<AccessToken> {
  return api.post<AccessToken>("/auth/login/totp", {
    loginId: session.loginId,
    code,
    deviceId,
  });
}
