/**
 * Klient HTTP i WebSocket do Workera.
 *
 * # Transport klienta webowego
 *
 * Klient natywny łączy się z rozmówcami bezpośrednio przez iroh. Przeglądarka
 * **nie może**: sandbox nie pozwala wysyłać pakietów UDP, więc przebicie NAT
 * jest niedostępne, a do przeglądarki nie da się zadzwonić z zewnątrz. Ruch
 * zawsze musi przejść przez jakiegoś pośrednika.
 *
 * Wybieramy **własną skrzynkę na Workerze** zamiast publicznych relayów iroh.
 * Prywatnie wychodzi to na to samo — obie drogi widzą wyłącznie szyfrogram,
 * bo MLS działa pod spodem — ale zamiast ufać cudzej infrastrukturze ufamy
 * własnej, którą użytkownik może sobie postawić sam.
 *
 * Wniosek dla użytkownika: **rozmowa z udziałem przeglądarki nigdy nie jest
 * bezpośrednia.** Interfejs musi to pokazywać, a nie sugerować P2P tam, gdzie
 * go nie ma.
 */

/** Adres backendu. Nadpisywany przez `VITE_API_URL` przy budowaniu. */
export const API_URL = import.meta.env.VITE_API_URL ?? "http://localhost:8787";

export class ApiError extends Error {
  constructor(
    readonly status: number,
    message: string,
  ) {
    super(message);
    this.name = "ApiError";
  }
}

async function request<T>(path: string, init?: RequestInit): Promise<T> {
  const response = await fetch(`${API_URL}${path}`, {
    ...init,
    headers: { "Content-Type": "application/json", ...init?.headers },
  });

  if (!response.ok) {
    const body = (await response.json().catch(() => ({}))) as { error?: string };
    throw new ApiError(response.status, body.error ?? `żądanie nie powiodło się (${response.status})`);
  }

  return response.json() as Promise<T>;
}

export const api = {
  post: <T>(
    path: string,
    body: unknown,
    token?: string,
    opts?: { credentials?: RequestCredentials; signal?: AbortSignal },
  ) =>
    request<T>(path, {
      method: "POST",
      body: JSON.stringify(body),
      headers: token ? { Authorization: `Bearer ${token}` } : {},
      credentials: opts?.credentials,
      signal: opts?.signal,
    }),

  get: <T>(path: string) => request<T>(path),

  /** Zostawia szyfrogram w skrzynce odbiorcy. */
  /**
   * Zostawia kopertę w skrzynce odbiorcy.
   *
   * **Bez tokenu konta i to jest decyzja**: serwer nie ma się dowiadywać, kto
   * do kogo pisze. Prawo do nadania potwierdza token DORĘCZENIOWY — wydany na
   * wartość oślepioną, więc nie do powiązania z kontem (patrz `tokeny.ts`).
   *
   * Brak tokenu nie blokuje wysyłki: dopóki serwer ich nie wymusza, wiadomość
   * jest ważniejsza niż limit nadużyć.
   */
  async deposit(userId: string, envelope: Uint8Array, tokenDoreczenia?: string): Promise<void> {
    const response = await fetch(`${API_URL}/inbox/${encodeURIComponent(userId)}`, {
      method: "POST",
      headers: tokenDoreczenia ? { "X-Delivery-Token": tokenDoreczenia } : undefined,
      body: envelope as BufferSource,
    });

    if (!response.ok) {
      throw new ApiError(response.status, "nie udało się zostawić wiadomości w skrzynce");
    }
  },

  /**
   * Wgrywa zaszyfrowany załącznik i zwraca nadany przez serwer identyfikator.
   *
   * Do serwera trafia wyłącznie szyfrogram — klucz zostaje po tej stronie
   * i pojedzie osobno, wewnątrz wiadomości MLS.
   */
  async uploadAttachment(token: string, ciphertext: Uint8Array): Promise<string> {
    const response = await fetch(`${API_URL}/attachments`, {
      method: "POST",
      headers: { Authorization: `Bearer ${token}` },
      body: ciphertext as BufferSource,
    });

    if (!response.ok) {
      const body = (await response.json().catch(() => ({}))) as { error?: string };
      throw new ApiError(response.status, body.error ?? "nie udało się wgrać załącznika");
    }

    const { blobId } = (await response.json()) as { blobId: string };
    return blobId;
  },

  /** Pobiera szyfrogram załącznika. */
  async downloadAttachment(token: string, blobId: string): Promise<Uint8Array> {
    const response = await fetch(`${API_URL}/attachments/${encodeURIComponent(blobId)}`, {
      headers: { Authorization: `Bearer ${token}` },
    });

    if (!response.ok) {
      throw new ApiError(response.status, "nie udało się pobrać załącznika");
    }

    return new Uint8Array(await response.arrayBuffer());
  },

  /** Otwiera połączenie ze skrzynką. Zaległości przychodzą od razu po podłączeniu. */
  /**
   * Podłącza się do WŁASNEJ skrzynki.
   *
   * Token idzie podprotokołem, nie nagłówkiem: przeglądarkowe `WebSocket` nie
   * pozwala dodać `Authorization`. Zostaje zapytanie w adresie albo
   * `Sec-WebSocket-Protocol` — adresy lądują w logach serwerów pośredniczących
   * i w historii, a token w logu jest tokenem oddanym.
   *
   * Bez tego serwer wpuszczał kogokolwiek do cudzej skrzynki: dało się odebrać
   * zaległe koperty i skasować je potwierdzeniem, zanim dotarły do właściciela.
   */
  connectInbox(userId: string, token: string): WebSocket {
    const url = new URL(`${API_URL}/inbox/${encodeURIComponent(userId)}/connect`);
    url.protocol = url.protocol.replace("http", "ws");

    const socket = new WebSocket(url, [token]);
    socket.binaryType = "arraybuffer";
    return socket;
  },
};

export function base64ToBytes(value: string): Uint8Array {
  const binary = atob(value);
  const bytes = new Uint8Array(binary.length);
  for (let i = 0; i < binary.length; i += 1) {
    bytes[i] = binary.charCodeAt(i);
  }
  return bytes;
}

export function bytesToBase64(bytes: Uint8Array): string {
  // Pętla zamiast `String.fromCharCode(...bytes)`: rozwinięcie dużej tablicy
  // w argumenty wywołania przepełnia stos, a koperty sięgają megabajta.
  let binary = "";
  for (const byte of bytes) {
    binary += String.fromCharCode(byte);
  }
  return btoa(binary);
}
