import init, {
  opaqueLoginFinish,
  opaqueLoginStart,
  opaqueRegisterFinish,
  opaqueRegisterStart,
} from "../wasm/mekamb_wasm";
import { api, ApiError, base64ToBytes, bytesToBase64 } from "./api";
import type {
  PasskeyAuthenticationOptions,
  PasskeyAuthenticationResponse,
  PasskeyRegistrationOptions,
  PasskeyRegistrationResponse,
} from "./passkey";

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

/**
 * Kończy logowanie kodem TOTP i odbiera token dostępowy.
 *
 * `credentials: "include"` jest tu konieczne — inaczej przeglądarka po cichu
 * odrzuca `Set-Cookie` z odpowiedzi, bo API stoi pod innym originem niż
 * aplikacja. Bez tego trwała sesja (patrz [`refreshSession`]) nigdy by się
 * nie włączyła.
 */
export async function loginWithTotp(
  session: LoginSession,
  code: string,
  deviceId: string,
): Promise<AccessToken> {
  return api.post<AccessToken>(
    "/auth/login/totp",
    { loginId: session.loginId, code, deviceId },
    undefined,
    { credentials: "include" },
  );
}

// ---------------------------------------------------------------------------
// Trwała sesja
// ---------------------------------------------------------------------------

/**
 * Ile czekamy na odpowiedź serwera przy starcie.
 *
 * `fetch` sam z siebie nie ma limitu czasu, a to żądanie blokuje pierwszy
 * ekran aplikacji — serwer, który przyjmuje połączenie i milczy, zawiesiłby
 * ją na „Wczytywanie…" bez końca. Lepiej po dziesięciu sekundach pokazać
 * logowanie i powód.
 */
const LIMIT_ODSWIEZENIA_MS = 10_000;

/**
 * Wymienia trwałą sesję (httpOnly cookie) na nowy token dostępowy.
 *
 * Wywoływane przy starcie aplikacji zamiast wymuszać ekran logowania —
 * patrz `App.tsx`. Zwraca `null` zamiast rzucać, gdy sesji nie ma albo
 * wygasła: to jest oczekiwany, częsty przypadek (pierwsze uruchomienie, długa
 * nieobecność), nie błąd do zgłoszenia użytkownikowi.
 *
 * Awaria sieci to co innego niż brak sesji, więc leci dalej jako wyjątek —
 * obsługuje ją `ustalRozruch` (`rozruch.ts`), zamieniając na ekran logowania
 * z komunikatem.
 */
export async function refreshSession(deviceId: string): Promise<AccessToken | null> {
  try {
    return await api.post<AccessToken>("/auth/refresh", { deviceId }, undefined, {
      credentials: "include",
      signal: AbortSignal.timeout(LIMIT_ODSWIEZENIA_MS),
    });
  } catch (err) {
    if (err instanceof ApiError) return null;
    throw err;
  }
}

/** Kasuje trwałą sesję — wywoływane przy jawnym wylogowaniu. */
export async function logout(deviceId: string): Promise<void> {
  await api.post("/auth/logout", { deviceId }, undefined, { credentials: "include" });
}

// ---------------------------------------------------------------------------
// Logowanie passkeyem
// ---------------------------------------------------------------------------

/** Opcje rejestracji passkeya. Wymaga istniejącej sesji (`requireAuth` po stronie serwera). */
export async function webauthnRegisterOptions(
  token: string,
): Promise<PasskeyRegistrationOptions> {
  return api.post<PasskeyRegistrationOptions>("/auth/webauthn/register/options", {}, token);
}

/** Zapisuje nowo utworzony passkey na koncie. */
export async function webauthnRegisterVerify(
  token: string,
  response: PasskeyRegistrationResponse,
  nazwa?: string,
): Promise<void> {
  await api.post("/auth/webauthn/register/verify", { response, nazwa }, token);
}

/** Opcje logowania passkeyem — bez podawania nazwy użytkownika. */
export async function webauthnLoginOptions(): Promise<PasskeyAuthenticationOptions> {
  return api.post<PasskeyAuthenticationOptions>("/auth/webauthn/login/options", {});
}

export interface PasskeyLoginResult extends AccessToken {
  userId: string;
  username: string;
}

/**
 * Kończy logowanie passkeyem. Tak jak [`loginWithTotp`], wymaga
 * `credentials: "include"`, żeby serwer mógł ustawić trwałą sesję.
 */
export async function webauthnLoginVerify(
  response: PasskeyAuthenticationResponse,
  deviceId: string,
): Promise<PasskeyLoginResult> {
  return api.post<PasskeyLoginResult>(
    "/auth/webauthn/login/verify",
    { response, deviceId },
    undefined,
    { credentials: "include" },
  );
}
