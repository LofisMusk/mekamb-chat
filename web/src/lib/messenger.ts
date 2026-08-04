import init, {
  MekambClient,
  decodeEnvelope,
  canStripMetadata,
  encodeEnvelope,
  maxAttachmentBytes,
  openAttachment,
  sealAttachment,
  stripMetadata,
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

export interface ReceivedCallSignal {
  kind: string;
  callId: Uint8Array;
  payload: string;
  /** Odcisk DTLS **uwierzytelniony przez MLS**. */
  dtlsFingerprint: string;
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
  /** Obecne, gdy wiadomość niesie sygnalizację rozmowy. */
  call?: ReceivedCallSignal;
}

export class Messenger {
  private constructor(
    private readonly client: MekambClient,
    readonly account: Account,
    private readonly token: string,
  ) {}

  /** Token dostępowy — potrzebny warstwie rozmów do pobrania adresów TURN. */
  get accessToken(): string {
    return this.token;
  }

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

  /** Zakłada rozmowę i wprowadza do niej pierwszą osobę. */
  async startConversation(peerUsername: string): Promise<Uint8Array> {
    const groupId = this.client.createConversation();
    await this.addMember(groupId, peerUsername);
    return groupId;
  }

  /**
   * Dodaje osobę do rozmowy.
   *
   * Ta sama ścieżka obsługuje założenie DM-a i rozbudowę grupy — bo DM to
   * grupa o rozmiarze 2 i nie ma powodu, żeby istniały dwa różne przepływy.
   *
   * Commit idzie do `GroupRelay`, który rozstrzyga kolejność i rozsyła go
   * pozostałym członkom. Dopiero jego potwierdzenie pozwala scalić zmianę
   * lokalnie: scalenie na siłę zostawiłoby nas w epoce, której reszta grupy
   * nie zna, czyli poza rozmową.
   */
  async addMember(groupId: Uint8Array, username: string): Promise<void> {
    const { devices } = await api.get<{ devices: { deviceId: string }[] }>(
      `/directory/${encodeURIComponent(username)}`,
    );

    const device = devices[0];
    if (!device) {
      throw new Error(`użytkownik ${username} nie ma zarejestrowanych urządzeń`);
    }

    const { keyPackage } = await api.post<{ keyPackage: string }>(
      `/key-packages/${encodeURIComponent(device.deviceId)}/claim`,
      {},
      this.token,
    );

    const pending = this.client.addMember(groupId, fromBase64(keyPackage));

    // Skład PO commicie: nowa osoba musi znaleźć się na liście, do której
    // relay rozsyła, inaczej nie dostanie kolejnych commitów.
    const czlonkowie = [...this.memberUserIds(groupId), username];

    const epoch = this.client.epoch(groupId);
    const response = await api.post<{ accepted: boolean; epoch: number }>(
      `/groups/${toHex(groupId)}/commit`,
      {
        epoch: Number(epoch),
        envelope: toBase64(encodeEnvelope(groupId, "commit", pending.commit)),
        members: czlonkowie,
      },
      this.token,
    );

    if (!response.accepted) {
      // Ktoś był szybszy. Porzucamy własny commit; jego commit dotrze do nas
      // skrzynką i po jego przetworzeniu można spróbować ponownie.
      this.client.discardCommit(groupId);
      await this.persist();
      throw new Error("ktoś zmienił grupę w międzyczasie — spróbuj ponownie");
    }

    this.client.confirmCommit(groupId);
    await this.persist();

    if (pending.welcome) {
      await api.deposit(username, encodeEnvelope(groupId, "welcome", pending.welcome));
    }
  }

  /**
   * Nazwy użytkowników w rozmowie, bez duplikatów.
   *
   * MLS zwraca `user_id:device_id`, bo członkiem grupy jest **urządzenie**,
   * nie osoba. Do routingu potrzebujemy osób — jedna osoba z trzema
   * urządzeniami ma jedną skrzynkę.
   */
  memberUserIds(groupId: Uint8Array): string[] {
    const osoby = this.client
      .members(groupId)
      .map((wpis) => wpis.split(":")[0] ?? wpis);

    return [...new Set(osoby)];
  }

  /** Uczestnicy rozmowy poza nami — odbiorcy wysyłanych wiadomości. */
  private recipients(groupId: Uint8Array): string[] {
    return this.memberUserIds(groupId).filter((osoba) => osoba !== this.account.userId);
  }

  /**
   * Szyfruje i wysyła wiadomość tekstową do całej rozmowy.
   *
   * Odbiorców bierzemy z drzewa MLS, a nie z interfejsu: to jedyne miejsce,
   * które wie, kto **naprawdę** jest w grupie po wszystkich commitach.
   */
  async sendText(groupId: Uint8Array, text: string): Promise<void> {
    const ciphertext = this.client.sendText(groupId, text, Date.now());

    // Ratchet przesunął się już przy szyfrowaniu — zapis musi nastąpić nawet
    // wtedy, gdy wysyłka po nim zawiedzie.
    await this.persist();

    await this.rozeslij(groupId, encodeEnvelope(groupId, "application", ciphertext));
  }

  /** Rozsyła gotową kopertę do wszystkich uczestników poza nami. */
  private async rozeslij(groupId: Uint8Array, envelope: Uint8Array): Promise<void> {
    await Promise.all(this.recipients(groupId).map((userId) => api.deposit(userId, envelope)));
  }

  /**
   * Wysyła plik: szyfruje, wgrywa szyfrogram, a klucz wysyła kanałem MLS.
   *
   * Kolejność jest istotna. Szyfrujemy PRZED wgraniem, więc serwer nigdy nie
   * widzi zawartości — nawet przez chwilę. Klucz idzie osobną drogą i nigdy
   * nie przechodzi przez endpoint załączników.
   */
  async sendFile(groupId: Uint8Array, file: File): Promise<{ stripped: boolean }> {
    if (file.size > maxAttachmentBytes()) {
      throw new Error(
        `plik ma ${Math.round(file.size / 1024 / 1024)} MB, limit to ` +
          `${Math.round(maxAttachmentBytes() / 1024 / 1024)} MB`,
      );
    }

    // Typ pliku bierzemy z przeglądarki, ale trafia on do danych
    // uwierzytelnionych — odbiorca odrzuci plik, jeśli ktoś go po drodze podmieni.
    const mimeType = file.type || "application/octet-stream";
    const surowe = new Uint8Array(await file.arrayBuffer());

    // Metadane usuwamy PRZED zaszyfrowaniem. Dane włożone do środka szyfrogramu
    // docierają do odbiorcy dokładnie tak samo jak treść — a stamtąd mogą
    // powędrować dalej razem z plikiem. Zdjęcie i nagranie z telefonu niosą
    // współrzędne GPS z dokładnością do kilku metrów.
    //
    // Nieudane czyszczenie NIE blokuje wysyłki: plik w nietypowym wariancie
    // kontenera lepiej dostarczyć niż odrzucić. Wywołujący dowiaduje się
    // z `stripped`, czy się powiodło, i może to pokazać użytkownikowi.
    // Typ szerszy niż `surowe`: wasm-bindgen zwraca bufor bez zawężenia do
    // ArrayBuffer, a oba warianty są tu równie dobre.
    let plaintext: Uint8Array<ArrayBufferLike> = surowe;
    let stripped = false;

    if (canStripMetadata(mimeType)) {
      try {
        plaintext = stripMetadata(surowe, mimeType);
        stripped = true;
      } catch {
        // Parser nie rozpoznał tego wariantu kontenera.
      }
    }

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

    await this.rozeslij(groupId, encodeEnvelope(groupId, "application", ciphertext));

    return { stripped };
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

    // Commit zmienia skład grupy i epokę. Przetwarzamy go tą samą ścieżką co
    // wiadomość — `receive` rozpoznaje rodzaj sam.
    if (envelope.kind === "commit") {
      this.client.receive(envelope.group_id, envelope.payload);
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
      call: incoming.call
        ? {
            kind: incoming.call.kind,
            callId: incoming.call.call_id,
            payload: incoming.call.payload,
            dtlsFingerprint: incoming.call.dtls_fingerprint,
          }
        : undefined,
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

  /**
   * Wysyła sygnalizację rozmowy kanałem MLS.
   *
   * Odcisk DTLS idzie tędy, a nie w SDP — dzięki temu jest uwierzytelniony
   * kryptograficznie i kontrolujący sygnalizację nie podstawi się w środek.
   */
  async sendCallSignal(
    groupId: Uint8Array,
    kind: "offer" | "answer" | "ice" | "hangup",
    callId: Uint8Array,
    payload: string,
    dtlsFingerprint: string,
  ): Promise<void> {
    const ciphertext = this.client.sendCallSignal(
      groupId,
      kind,
      callId,
      payload,
      dtlsFingerprint,
      Date.now(),
    );

    await this.persist();
    await this.rozeslij(groupId, encodeEnvelope(groupId, "application", ciphertext));
  }

  /**
   * Safety number rozmowy — kod do porównania z rozmówcą innym kanałem.
   *
   * Liczony z kluczy tożsamości w drzewie MLS, więc podstawienie cudzego
   * urządzenia przez serwer zmienia wynik. To jedyne, co odróżnia „szyfrowane"
   * od „szyfrowane do właściwej osoby".
   */
  safetyNumber(groupId: Uint8Array): string {
    return this.client.safetyNumber(groupId);
  }

  /** Odcisk tego urządzenia. */
  deviceFingerprint(): string {
    return this.client.deviceFingerprint();
  }

  /** Bieżąca epoka rozmowy — rośnie z każdą zmianą składu. */
  epoch(groupId: Uint8Array): number {
    return Number(this.client.epoch(groupId));
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
