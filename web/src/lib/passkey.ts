/**
 * Cienki wrapper na WebAuthn (`navigator.credentials`) — logowanie passkeyem.
 *
 * # Dlaczego to nie jest „kryptografia w TS"
 *
 * Podpis i klucz prywatny nigdy nie opuszczają authenticatora (systemowy
 * menedżer haseł, klucz sprzętowy) — ten plik tylko przekłada opcje z serwera
 * na wywołanie natywnego API przeglądarki i z powrotem jego odpowiedź na JSON
 * do wysłania. Reguła CLAUDE.md „crypto żyje w Rust core" dotyczy kryptografii
 * APLIKACJI (MLS, OPAQUE, koperty) — nie wywołań przeglądarkowego API.
 */

export function isPasskeySupported(): boolean {
  return typeof window !== "undefined" && "PublicKeyCredential" in window;
}

function base64UrlToBytes(value: string): Uint8Array {
  const padded = value.replace(/-/g, "+").replace(/_/g, "/");
  const binary = atob(padded.padEnd(Math.ceil(padded.length / 4) * 4, "="));
  const bytes = new Uint8Array(binary.length);
  for (let i = 0; i < binary.length; i += 1) bytes[i] = binary.charCodeAt(i);
  return bytes;
}

function bytesToBase64Url(bytes: ArrayBuffer): string {
  const arr = new Uint8Array(bytes);
  let binary = "";
  for (const byte of arr) binary += String.fromCharCode(byte);
  return btoa(binary).replace(/\+/g, "-").replace(/\//g, "_").replace(/=+$/, "");
}

export interface PasskeyCredentialDescriptor {
  id: string;
  transports?: AuthenticatorTransport[];
}

export interface PasskeyRegistrationOptions {
  challenge: string;
  rp: { id: string; name: string };
  user: { id: string; name: string; displayName: string };
  pubKeyCredParams: { type: "public-key"; alg: number }[];
  timeout?: number;
  attestation?: AttestationConveyancePreference;
  excludeCredentials?: PasskeyCredentialDescriptor[];
  authenticatorSelection?: AuthenticatorSelectionCriteria;
}

export interface PasskeyAuthenticationOptions {
  challenge: string;
  rpId: string;
  timeout?: number;
  userVerification?: UserVerificationRequirement;
  allowCredentials?: PasskeyCredentialDescriptor[];
}

/** Odpowiedź rejestracji w formacie, jakiego oczekuje `@simplewebauthn/server`. */
export interface PasskeyRegistrationResponse {
  id: string;
  rawId: string;
  type: "public-key";
  clientExtensionResults: AuthenticationExtensionsClientOutputs;
  response: { clientDataJSON: string; attestationObject: string };
}

/** Odpowiedź logowania w formacie, jakiego oczekuje `@simplewebauthn/server`. */
export interface PasskeyAuthenticationResponse {
  id: string;
  rawId: string;
  type: "public-key";
  clientExtensionResults: AuthenticationExtensionsClientOutputs;
  response: {
    clientDataJSON: string;
    authenticatorData: string;
    signature: string;
    userHandle?: string;
  };
}

function toPublicKeyCredentialDescriptors(
  credentials: PasskeyCredentialDescriptor[] | undefined,
): PublicKeyCredentialDescriptor[] | undefined {
  return credentials?.map((c) => ({
    id: base64UrlToBytes(c.id) as BufferSource,
    type: "public-key" as const,
    transports: c.transports,
  }));
}

/** Rejestruje nowy passkey. Wymaga wcześniejszego logowania hasłem+TOTP. */
export async function createPasskey(
  options: PasskeyRegistrationOptions,
): Promise<PasskeyRegistrationResponse> {
  const credential = (await navigator.credentials.create({
    publicKey: {
      challenge: base64UrlToBytes(options.challenge) as BufferSource,
      rp: options.rp,
      user: {
        id: base64UrlToBytes(options.user.id) as BufferSource,
        name: options.user.name,
        displayName: options.user.displayName,
      },
      pubKeyCredParams: options.pubKeyCredParams,
      timeout: options.timeout,
      attestation: options.attestation,
      excludeCredentials: toPublicKeyCredentialDescriptors(options.excludeCredentials),
      authenticatorSelection: options.authenticatorSelection,
    },
  })) as PublicKeyCredential | null;

  if (!credential) {
    throw new Error("rejestracja passkeya została przerwana");
  }

  const response = credential.response as AuthenticatorAttestationResponse;

  return {
    id: credential.id,
    rawId: bytesToBase64Url(credential.rawId),
    type: "public-key",
    clientExtensionResults: credential.getClientExtensionResults(),
    response: {
      clientDataJSON: bytesToBase64Url(response.clientDataJSON),
      attestationObject: bytesToBase64Url(response.attestationObject),
    },
  };
}

/** Loguje przez passkey — discoverable, bez podawania nazwy użytkownika. */
export async function getPasskey(
  options: PasskeyAuthenticationOptions,
): Promise<PasskeyAuthenticationResponse> {
  const credential = (await navigator.credentials.get({
    publicKey: {
      challenge: base64UrlToBytes(options.challenge) as BufferSource,
      rpId: options.rpId,
      timeout: options.timeout,
      userVerification: options.userVerification,
      allowCredentials: toPublicKeyCredentialDescriptors(options.allowCredentials),
    },
  })) as PublicKeyCredential | null;

  if (!credential) {
    throw new Error("logowanie passkeyem zostało przerwane");
  }

  const response = credential.response as AuthenticatorAssertionResponse;

  return {
    id: credential.id,
    rawId: bytesToBase64Url(credential.rawId),
    type: "public-key",
    clientExtensionResults: credential.getClientExtensionResults(),
    response: {
      clientDataJSON: bytesToBase64Url(response.clientDataJSON),
      authenticatorData: bytesToBase64Url(response.authenticatorData),
      signature: bytesToBase64Url(response.signature),
      userHandle: response.userHandle ? bytesToBase64Url(response.userHandle) : undefined,
    },
  };
}
