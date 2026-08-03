import {
  KE2,
  OpaqueClient,
  OpaqueID,
  RegistrationResponse,
  getOpaqueConfig,
} from "@cloudflare/opaque-ts";

import { api, base64ToBytes, bytesToBase64 } from "./api";

/**
 * Rejestracja i logowanie po stronie przeglądarki.
 *
 * # Hasło nie opuszcza tej maszyny
 *
 * OPAQUE wykonuje kosztowne rozciąganie klucza tutaj, u klienta, i wysyła
 * na serwer wyłącznie ślepe wartości. Serwer nigdy nie widzi hasła — ani
 * w chwili rejestracji, ani logowania — więc nie ma czego z niego wyciec.
 */

const cfg = getOpaqueConfig(OpaqueID.OPAQUE_P256);

/** Musi zgadzać się z `SERVER_IDENTITY` w server/src/auth.ts. */
const SERVER_IDENTITY = "mekamb-chat";

export interface RegistrationResult {
  /** Sekret do wpisania w aplikacji authenticator. Pokazywany dokładnie raz. */
  totpSecret: string;
  /** URI `otpauth://` do wyrenderowania jako kod QR. */
  otpauthUri: string;
}

/**
 * Zakłada konto. Po tym kroku konto jest nieaktywne aż do [`confirmRegistration`].
 */
export async function register(
  username: string,
  password: string,
): Promise<RegistrationResult> {
  const client = new OpaqueClient(cfg);

  const request = await client.registerInit(password);
  if (request instanceof Error) throw request;

  const { registrationResponse } = await api.post<{ registrationResponse: string }>(
    "/auth/register/start",
    {
      username,
      registrationRequest: bytesToBase64(Uint8Array.from(request.serialize())),
    },
  );

  const finished = await client.registerFinish(
    RegistrationResponse.deserialize(cfg, Array.from(base64ToBytes(registrationResponse))),
    SERVER_IDENTITY,
    username,
  );
  if (finished instanceof Error) throw finished;

  return api.post<RegistrationResult>("/auth/register/finish", {
    username,
    registrationRecord: bytesToBase64(Uint8Array.from(finished.record.serialize())),
  });
}

/** Aktywuje konto pierwszym kodem z authenticatora. */
export async function confirmRegistration(username: string, code: string): Promise<void> {
  await api.post("/auth/register/confirm", { username, code });
}

export interface LoginSession {
  loginId: string;
}

/**
 * Przeprowadza wymianę OPAQUE i zatrzymuje się przed drugim składnikiem.
 *
 * Błędne hasło wykrywa **klient**, a nie serwer — dlatego rzucamy tu wyjątek,
 * zanim cokolwiek pójdzie dalej.
 */
export async function loginStart(username: string, password: string): Promise<LoginSession> {
  const client = new OpaqueClient(cfg);

  const ke1 = await client.authInit(password);
  if (ke1 instanceof Error) throw ke1;

  const { loginId, ke2 } = await api.post<{ loginId: string; ke2: string }>("/auth/login/start", {
    username,
    ke1: bytesToBase64(Uint8Array.from(ke1.serialize())),
  });

  const finished = await client.authFinish(
    KE2.deserialize(cfg, Array.from(base64ToBytes(ke2))),
    SERVER_IDENTITY,
    username,
  );

  if (finished instanceof Error) {
    // To samo dla złego hasła i nieistniejącego konta — serwer celowo nie
    // pozwala ich odróżnić, więc komunikat też nie może.
    throw new Error("nieprawidłowa nazwa użytkownika lub hasło");
  }

  await api.post("/auth/login/finish", {
    loginId,
    ke3: bytesToBase64(Uint8Array.from(finished.ke3.serialize())),
  });

  return { loginId };
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
