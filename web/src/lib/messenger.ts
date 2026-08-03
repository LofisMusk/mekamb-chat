import init, {
  MekambClient,
  decodeEnvelope,
  encodeEnvelope,
  maxAttachmentBytes,
  openAttachment,
  sealAttachment,
} from "../wasm/mekamb_wasm";
import { api } from "./api";
import type { Account } from "./vault";
import { loadSeed, loadState, saveSeed, saveState } from "./vault";

/**
 * Warstwa spinająca kryptografię (WASM) z siecią (skrzynka na Workerze).
 *
 * # Zasada: stan zapisujemy po każdej zmianie
 *
 * MLS jest protokołem z ratchetem — stan przesuwa się przy każdej wysłanej
 * i odebranej wiadomości. Pominięcie zapisu po którejkolwiek operacji oznacza,
 * że po odświeżeniu strony klient wraca do starej epoki i **przestaje
 * odszyfrowywać cokolwiek**. Dlatego zapis jest tu wpleciony w każdą ścieżkę,
 * a nie zostawiony wywołującemu.
 */

let wasmReady: Promise<unknown> | null = null;

/** Ładuje moduł WASM. Powtórne wywołania współdzielą jedną inicjalizację. */
function ensureWasm(): Promise<unknown> {
  wasmReady ??= init();
  return wasmReady;
}

export interface ReceivedAttachment {
  blobId: string;
  key: Uint8Array;
  nonce: Uint8Array;
  mimeType: string;
  sizeBytes: number;
  fileName?: string;
}

export interface ReceivedMessage {
  groupId: Uint8Array;
  senderUserId: string;
  senderDeviceId: string;
  text: string;
  sentAtMs: number;
  messageId: Uint8Array;
  /** Obecne, gdy wiadomość niesie plik zamiast tekstu. */
  attachment?: ReceivedAttachment;
}

export class Messenger {
  private constructor(
    private readonly client: MekambClient,
    readonly account: Account,
    private readonly token: string,
  ) {}

  /** Tworzy nową tożsamość urządzenia i zapisuje ją w magazynie. */
  static async create(account: Account, token: string): Promise<Messenger> {
    await ensureWasm();

    const client = new MekambClient(account.userId, account.deviceId);
    const messenger = new Messenger(client, account, token);

    await saveSeed(client.exportSeed());
    await messenger.persist();

    return messenger;
  }

  /** Odtwarza klienta z magazynu. Zwraca `null`, gdy nie ma czego odtwarzać. */
  static async restore(account: Account, token: string): Promise<Messenger | null> {
    await ensureWasm();

    const seed = await loadSeed();
    const state = await loadState();
    if (!seed || !state) return null;

    const client = MekambClient.restore(account.userId, account.deviceId, seed, state);
    return new Messenger(client, account, token);
  }

  /**
   * Zgłasza urządzenie do katalogu.
   *
   * Bez adresu iroh: przeglądarka nie przyjmuje połączeń przychodzących, więc
   * jest osiągalna wyłącznie przez skrzynkę. Serwer wiąże wpis z kontem na
   * podstawie tokenu, a nie danych z tego żądania.
   */
  async registerDevice(): Promise<void> {
    await api.post(
      "/devices",
      {
        deviceId: this.account.deviceId,
        mlsPublicKey: toBase64(this.client.mlsPublicKey()),
        displayName: "przeglądarka",
      },
      this.token,
    );
  }

  /** Publikuje zapas key packages, żeby dało się nas dodać do grupy offline. */
  async publishKeyPackages(count = 10): Promise<void> {
    const packages: string[] = [];
    for (let i = 0; i < count; i += 1) {
      packages.push(toBase64(this.client.createKeyPackage()));
    }

    // Zapis PRZED wysyłką: klucze prywatne pakietów są już w magazynie i ich
    // utrata oznaczałaby, że nie da się dołączyć do grupy, do której ktoś nas
    // właśnie zaprosił.
    await this.persist();
    await api.post(
      `/key-packages/${encodeURIComponent(this.account.deviceId)}`,
      { keyPackages: packages },
      this.token,
    );
  }

  /**
   * Zakłada rozmowę z drugim użytkownikiem.
   *
   * Commit idzie do `GroupRelay` i dopiero jego potwierdzenie pozwala scalić
   * zmianę lokalnie. Przy odrzuceniu porzucamy commit i zgłaszamy błąd —
   * scalenie na siłę wypchnęłoby nas z grupy.
   */
  async startConversation(peerUsername: string): Promise<Uint8Array> {
    const { devices } = await api.get<{ devices: { deviceId: string }[] }>(
      `/directory/${encodeURIComponent(peerUsername)}`,
    );

    const device = devices[0];
    if (!device) {
      throw new Error(`użytkownik ${peerUsername} nie ma zarejestrowanych urządzeń`);
    }

    const { keyPackage } = await api.post<{ keyPackage: string }>(
      `/key-packages/${encodeURIComponent(device.deviceId)}/claim`,
      {},
    );

    const groupId = this.client.createConversation();
    const pending = this.client.addMember(groupId, fromBase64(keyPackage));

    const epoch = this.client.epoch(groupId);
    const response = await api.post<{ accepted: boolean; epoch: number }>(
      `/groups/${toHex(groupId)}/commit`,
      { epoch: Number(epoch), commit: toBase64(pending.commit) },
    );

    if (!response.accepted) {
      this.client.discardCommit(groupId);
      await this.persist();
      throw new Error("ktoś zmienił grupę w międzyczasie — spróbuj ponownie");
    }

    this.client.confirmCommit(groupId);
    await this.persist();

    if (pending.welcome) {
      const envelope = encodeEnvelope(groupId, "welcome", pending.welcome);
      await api.deposit(peerUsername, envelope);
    }

    return groupId;
  }

  /** Szyfruje i wysyła wiadomość tekstową. */
  async sendText(groupId: Uint8Array, text: string, recipients: string[]): Promise<void> {
    const ciphertext = this.client.sendText(groupId, text, Date.now());

    // Ratchet przesunął się już przy szyfrowaniu — zapis musi nastąpić nawet
    // wtedy, gdy wysyłka po nim zawiedzie.
    await this.persist();

    const envelope = encodeEnvelope(groupId, "application", ciphertext);
    await Promise.all(recipients.map((userId) => api.deposit(userId, envelope)));
  }

  /**
   * Wysyła plik: szyfruje, wgrywa szyfrogram, a klucz wysyła kanałem MLS.
   *
   * Kolejność jest istotna. Szyfrujemy PRZED wgraniem, więc serwer nigdy nie
   * widzi zawartości — nawet przez chwilę. Klucz idzie osobną drogą i nigdy
   * nie przechodzi przez endpoint załączników.
   */
  async sendFile(
    groupId: Uint8Array,
    file: File,
    recipients: string[],
  ): Promise<void> {
    if (file.size > maxAttachmentBytes()) {
      throw new Error(
        `plik ma ${Math.round(file.size / 1024 / 1024)} MB, limit to ` +
          `${Math.round(maxAttachmentBytes() / 1024 / 1024)} MB`,
      );
    }

    // Typ pliku bierzemy z przeglądarki, ale trafia on do danych
    // uwierzytelnionych — odbiorca odrzuci plik, jeśli ktoś go po drodze podmieni.
    const mimeType = file.type || "application/octet-stream";
    const plaintext = new Uint8Array(await file.arrayBuffer());

    const sealed = sealAttachment(plaintext, mimeType);
    const blobId = await api.uploadAttachment(this.token, sealed.ciphertext);

    const ciphertext = this.client.sendAttachment(
      groupId,
      blobId,
      sealed.key,
      sealed.nonce,
      mimeType,
      file.size,
      file.name || undefined,
      Date.now(),
    );

    // Ratchet przesunął się przy szyfrowaniu wiadomości.
    await this.persist();

    const envelope = encodeEnvelope(groupId, "application", ciphertext);
    await Promise.all(recipients.map((userId) => api.deposit(userId, envelope)));
  }

  /**
   * Pobiera i odszyfrowuje załącznik, zwracając adres nadający się do
   * wyświetlenia.
   *
   * Deszyfrowanie dzieje się w pamięci przeglądarki; `blob:` wskazuje na dane,
   * które nigdy nie trafiły na dysk w postaci jawnej. Wywołujący musi zwolnić
   * adres przez `URL.revokeObjectURL`, inaczej odszyfrowany plik zostaje
   * w pamięci do końca życia karty.
   */
  async openAttachmentUrl(attachment: ReceivedAttachment): Promise<string> {
    const ciphertext = await api.downloadAttachment(this.token, attachment.blobId);

    const plaintext = openAttachment(
      ciphertext,
      attachment.key,
      attachment.nonce,
      attachment.mimeType,
    );

    return URL.createObjectURL(new Blob([plaintext as BlobPart], { type: attachment.mimeType }));
  }

  /**
   * Przetwarza kopertę odebraną ze skrzynki.
   *
   * Zwraca `null`, gdy koperta nie była wiadomością do wyświetlenia — na
   * przykład niosła commit albo zaproszenie do grupy.
   */
  async handleEnvelope(bytes: Uint8Array): Promise<ReceivedMessage | null> {
    const envelope = decodeEnvelope(bytes);

    if (envelope.kind === "welcome") {
      this.client.joinFromWelcome(envelope.payload);
      await this.persist();
      return null;
    }

    const incoming = this.client.receive(envelope.group_id, envelope.payload);
    await this.persist();

    if (incoming.kind !== "message") return null;

    return {
      groupId: envelope.group_id,
      senderUserId: incoming.sender_user_id,
      senderDeviceId: incoming.sender_device_id,
      text: incoming.text,
      sentAtMs: incoming.sent_at_ms,
      messageId: incoming.message_id,
      attachment: incoming.attachment
        ? {
            blobId: incoming.attachment.blob_id,
            key: incoming.attachment.key,
            nonce: incoming.attachment.nonce,
            mimeType: incoming.attachment.mime_type,
            sizeBytes: incoming.attachment.size_bytes,
            fileName: incoming.attachment.file_name,
          }
        : undefined,
    };
  }

  /** Identyfikatory `user_id:device_id` członków rozmowy. */
  members(groupId: Uint8Array): string[] {
    return this.client.members(groupId);
  }

  /** Zapisuje stan MLS. Wołane po każdej operacji zmieniającej ratchet. */
  private async persist(): Promise<void> {
    await saveState(this.client.exportState());
  }
}

function toBase64(bytes: Uint8Array): string {
  let binary = "";
  for (const byte of bytes) binary += String.fromCharCode(byte);
  return btoa(binary);
}

function fromBase64(value: string): Uint8Array {
  const binary = atob(value);
  const bytes = new Uint8Array(binary.length);
  for (let i = 0; i < binary.length; i += 1) bytes[i] = binary.charCodeAt(i);
  return bytes;
}

function toHex(bytes: Uint8Array): string {
  return Array.from(bytes, (b) => b.toString(16).padStart(2, "0")).join("");
}
