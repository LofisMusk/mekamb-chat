import init, {
  MekambClient,
  decodeEnvelope,
  canStripMetadata,
  encodeEnvelope,
  relayId,
  maxAttachmentBytes,
  openAttachment,
  sealAttachment,
  stripMetadata,
} from "../wasm/mekamb_wasm";
import { api } from "./api";
import { czyWlasna, zapamietaj } from "./echa";
import { naglowekTokenu, uzupelnij, wezToken } from "./tokeny";
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
  /** Adresat sygnału. Puste = dla wszystkich. */
  target: string;
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
  /** Obecne, gdy wiadomość jest potwierdzeniem dostarczenia albo odczytu. */
  receipt?: ReceivedReceipt;
}

/**
 * Potwierdzenie odebrane kanałem MLS.
 *
 * Nie niesie chwili odczytu — ta informacja świadomie nie istnieje w protokole.
 * Nasz zegar mówi tylko, kiedy potwierdzenie DOTARŁO, a to i tak jest o losowy
 * czas późniejsze od odczytu (patrz `potwierdzenia.ts`).
 */
export interface ReceivedReceipt {
  kind: "delivered" | "read";
  /** Identyfikatory potwierdzanych wiadomości, szesnastkowo — jak w historii. */
  messageIds: string[];
}

/** Długość identyfikatora wiadomości w bajtach. Musi zgadzać się z rdzeniem. */
export const DLUGOSC_ID = 16;

/**
 * Identyfikator wiadomości jako tekst.
 *
 * `padStart` jest tu konieczny, a nie kosmetyczny: bez niego bajt 0x0A daje
 * „a" zamiast „0a", więc zapisu nie da się jednoznacznie odczytać z powrotem
 * na bajty. Dopóki identyfikator służył tylko za klucz Reacta, nikt tego nie
 * zauważył — potwierdzenia muszą go odwrócić, więc musi być odwracalny.
 */
export function idWiadomosci(bajty: Uint8Array): string {
  return Array.from(bajty, (b) => b.toString(16).padStart(2, "0")).join("");
}

/** Skleja identyfikatory w jedną tablicę bajtów — takiej oczekuje rdzeń. */
export function sklejIdentyfikatory(identyfikatory: readonly string[]): Uint8Array {
  const bajty = new Uint8Array(identyfikatory.length * DLUGOSC_ID);

  identyfikatory.forEach((id, n) => {
    for (let i = 0; i < DLUGOSC_ID; i++) {
      bajty[n * DLUGOSC_ID + i] = parseInt(id.slice(i * 2, i * 2 + 2), 16) || 0;
    }
  });

  return bajty;
}

/** Rozcina sklejone identyfikatory z powrotem na teksty. */
export function rozetnijIdentyfikatory(bajty: Uint8Array): string[] {
  const identyfikatory: string[] = [];

  for (let n = 0; n + DLUGOSC_ID <= bajty.length; n += DLUGOSC_ID) {
    identyfikatory.push(idWiadomosci(bajty.subarray(n, n + DLUGOSC_ID)));
  }

  return identyfikatory;
}

/**
 * Skleja key packages, każdy poprzedzony swoją długością (u32 big-endian).
 *
 * Identyfikatory wyżej mają stałą długość, więc wystarczało je zestawić obok
 * siebie. Key packages nie mają, a `wasm_bindgen` nie przenosi tablicy tablic
 * bajtów — stąd długość z przodu, dokładnie tak samo jak w zrzucie
 * przeniesienia konta. Rozcina to `rozetnij_pakiety` w rdzeniu.
 */
export function sklejPakiety(pakiety: readonly Uint8Array[]): Uint8Array<ArrayBuffer> {
  const rozmiar = pakiety.reduce((suma, p) => suma + 4 + p.length, 0);
  const wynik = new Uint8Array(new ArrayBuffer(rozmiar));
  const widok = new DataView(wynik.buffer);

  let pozycja = 0;
  for (const pakiet of pakiety) {
    widok.setUint32(pozycja, pakiet.length);
    wynik.set(pakiet, pozycja + 4);
    pozycja += 4 + pakiet.length;
  }

  return wynik;
}

export class Messenger {
  private constructor(
    private readonly client: MekambClient,
    readonly account: Account,
    private token: string,
  ) {}

  /** Token dostępowy — potrzebny warstwie rozmów do pobrania adresów TURN. */
  get accessToken(): string {
    return this.token;
  }

  /**
   * Podmienia token po cichym odświeżeniu sesji (`refreshSession`).
   *
   * Nie trzeba przy tym przebudowywać `MekambClient` — ziarno i stan MLS
   * się nie zmieniają, zmienia się tylko to, czym uwierzytelniamy żądania
   * do sieci.
   */
  setAccessToken(token: string): void {
    this.token = token;
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
   * Otwiera rozmowy zapisane na dysku.
   *
   * # Czemu to musiało powstać
   *
   * Stan MLS przeżywał odświeżenie karty w magazynie, ale lista OTWARTYCH
   * rozmów powstawała wyłącznie przy zakładaniu grupy albo przyjmowaniu
   * zaproszenia. Po odświeżeniu klient miał pełny stan na dysku i pustą listę —
   * każde wysłanie i odebranie kończyło się „nie ma takiej rozmowy w tym
   * kliencie".
   *
   * Identyfikatory znamy z własnej historii, więc otwieramy je sami. Rozmowa
   * bez stanu MLS (np. po przeniesieniu konta) po prostu się nie otworzy —
   * zostaje w historii do czytania i tyle.
   */
  otworzZnaneRozmowy(groupIds: readonly Uint8Array[]): void {
    for (const groupId of groupIds) {
      try {
        this.client.openConversation(groupId);
      } catch {
        // Uszkodzony wpis nie może zablokować pozostałych rozmów.
      }
    }
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
   * Dodaje osobę do rozmowy — ze **wszystkimi** jej urządzeniami.
   *
   * Ta sama ścieżka obsługuje założenie DM-a i rozbudowę grupy — bo DM to
   * grupa o rozmiarze 2 i nie ma powodu, żeby istniały dwa różne przepływy.
   *
   * Commit idzie do `GroupRelay`, który rozstrzyga kolejność i rozsyła go
   * pozostałym członkom. Dopiero jego potwierdzenie pozwala scalić zmianę
   * lokalnie: scalenie na siłę zostawiłoby nas w epoce, której reszta grupy
   * nie zna, czyli poza rozmową.
   *
   * # Czemu wszystkie urządzenia, a nie pierwsze
   *
   * Członkiem grupy MLS jest **urządzenie**, nie osoba. Wcześniej braliśmy
   * `devices[0]`, więc do rozmowy wchodziło wyłącznie ostatnio widziane
   * urządzenie odbiorcy — na pozostałych nie pojawiało się nic i **nadawca nie
   * widział przy tym żadnego błędu**. Jedno konto na kilku urządzeniach nie
   * mogło zadziałać, dopóki to tu wyglądało tak, jak wyglądało.
   *
   * Wszystkie urządzenia idą **jednym** commitem: każdy kolejny to osobna
   * epoka do uzgodnienia z relayem, a odrzucenie tej drugiej zostawiłoby konto
   * dodane w połowie — część urządzeń w grupie, część poza nią.
   */
  async addMember(groupId: Uint8Array, username: string): Promise<void> {
    const { devices } = await api.get<{ devices: { deviceId: string }[] }>(
      `/directory/${encodeURIComponent(username)}`,
    );

    if (devices.length === 0) {
      throw new Error(`użytkownik ${username} nie ma zarejestrowanych urządzeń`);
    }

    const pakiety = await this.pobierzPakiety(devices);
    if (pakiety.length === 0) {
      // Wszystkie urządzenia bez wolnych key packages. Dodanie „zera osób"
      // zajęłoby epokę bez żadnej zmiany składu, więc lepiej powiedzieć wprost.
      throw new Error(
        `żadne urządzenie użytkownika ${username} nie ma wolnych key packages — ` +
          `niech otworzy aplikację i spróbuj ponownie`,
      );
    }

    await this.wprowadzCzlonkow(groupId, pakiety, username);
  }

  /**
   * Wprowadza WŁASNE, świeżo sparowane urządzenie do rozmowy.
   *
   * # Czemu nie zwykłe `addMember` z własną nazwą
   *
   * Bo tamto pobiera z katalogu **wszystkie** urządzenia i dodaje je hurtem —
   * łącznie z tymi, które już w grupie są. MLS odrzuciłby taki commit, a przy
   * kilku rozmowach zostawiłby konto dodane w połowie.
   *
   * Urządzenie już będące w grupie pomijamy po cichu: przy powtórzonym
   * parowaniu albo wznowieniu po zerwaniu to jest normalny stan, nie awaria.
   */
  async dodajWlasneUrzadzenie(groupId: Uint8Array, deviceId: string): Promise<void> {
    const tozsamosc = `${this.account.userId}:${deviceId}`;
    if (this.client.members(groupId).includes(tozsamosc)) return;

    const pakiety = await this.pobierzPakiety([{ deviceId }]);
    if (pakiety.length === 0) {
      throw new Error(
        "nowe urządzenie nie ma wolnych key packages — otwórz na nim aplikację i spróbuj ponownie",
      );
    }

    // Welcome idzie na NASZĄ nazwę: nowe urządzenie dzieli z nami skrzynkę.
    await this.wprowadzCzlonkow(groupId, pakiety, this.account.userId);
  }

  /**
   * Zajmuje epokę, scala commit i rozsyła go — wspólne dla obu dróg dodawania.
   */
  private async wprowadzCzlonkow(
    groupId: Uint8Array,
    pakiety: Uint8Array[],
    username: string,
  ): Promise<void> {
    const pending = this.client.addMembers(groupId, sklejPakiety(pakiety));

    /*
     * Do serwera idzie sam numer epoki.
     *
     * Ani commit, ani skład grupy — serwer rozstrzyga wyłącznie KOLEJNOŚĆ.
     * Wcześniej dostawał jedno i drugie, bo sam rozsyłał commity, i była to
     * jedyna w systemie struktura mówiąca mu wprost, kto z kim rozmawia.
     */
    const epoch = this.client.epoch(groupId);
    const response = await api.post<{ accepted: boolean; epoch: number }>(
      // Adres relaya jest OSOBNO wyprowadzony, nie jest identyfikatorem
      // rozmowy: serwer widzi go w adresie żądania, a z niego nie da się
      // policzyć znaczników kopert.
      `/groups/${relayId(groupId)}/commit`,
      { epoch: Number(epoch) },
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

    /*
     * Rozsyłamy commit sami — po zajęciu epoki, nie przed.
     *
     * Kolejność ma znaczenie: rozesłanie przed potwierdzeniem oznaczałoby
     * wysłanie commitu, który relay może odrzucić, a odbiorcy nie mają jak
     * cofnąć tego, co już przetworzyli.
     *
     * Skład bierzemy PO scaleniu, bez nowej osoby: ona dostaje `welcome`,
     * a commitu wprowadzającego ją do grupy nie potrafi przetworzyć.
     */
    const koperta = encodeEnvelope(groupId, "commit", pending.commit);
    await zapamietaj(koperta);

    /*
     * Nowa osoba commitu nie dostaje — dla niej jest `welcome`.
     *
     * Wyjątkiem jest dodawanie WŁASNEGO urządzenia: nowy członek dzieli wtedy
     * skrzynkę z nami, więc pominięcie jej odcięłoby od commitu nasze
     * pozostałe urządzenia i zostałyby w starej epoce. Nowe urządzenie ten
     * commit po prostu odrzuci — nie zna jeszcze tej rozmowy, więc znacznik
     * koperty nie pasuje do niczego i `matchEnvelope` zwraca `null`.
     */
    const wlasneUrzadzenie = username === this.account.userId;
    await Promise.all(
      this.skrzynkiRozmowy(groupId)
        .filter((osoba) => wlasneUrzadzenie || osoba !== username)
        .map((osoba) => api.deposit(osoba, koperta)),
    );

    if (pending.welcome) {
      const zaproszenie = encodeEnvelope(groupId, "welcome", pending.welcome);
      await zapamietaj(zaproszenie);
      await api.deposit(username, zaproszenie);
    }
  }

  /**
   * Pobiera po jednym key package na urządzenie.
   *
   * Urządzenie bez wolnego zapasu **pomijamy zamiast przerywać całość**.
   * Zapas bywa wyczerpany zupełnie normalnie: jest jednorazowy, a uzupełnia go
   * dopiero właściciel, gdy otworzy aplikację. Przerwanie dodawania oznaczałoby,
   * że jeden zapomniany laptop blokuje rozmowę na wszystkich pozostałych
   * urządzeniach — a to gorsze niż dołączenie go później.
   *
   * Pominięte urządzenie po prostu nie widzi tej rozmowy, dopóki ktoś nie doda
   * go ponownie. Interfejs musi to umieć pokazać, bo inaczej wygląda jak awaria.
   */
  private async pobierzPakiety(
    devices: readonly { deviceId: string }[],
  ): Promise<Uint8Array[]> {
    const wyniki = await Promise.allSettled(
      devices.map((device) =>
        api.post<{ keyPackage: string }>(
          `/key-packages/${encodeURIComponent(device.deviceId)}/claim`,
          {},
          this.token,
        ),
      ),
    );

    return wyniki
      .filter((wynik) => wynik.status === "fulfilled")
      .map((wynik) => fromBase64(wynik.value.keyPackage));
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

  /**
   * Skrzynki, do których trafia to, co wysyłamy — **łącznie z naszą własną**.
   *
   * # Dlaczego wysyłamy też do siebie
   *
   * Bez tego wiadomość wysłana z laptopa nie istnieje dla telefonu. Cudze
   * wiadomości docierały na wszystkie urządzenia od zawsze, bo skrzynka jest
   * wspólna — brakowało wyłącznie echa własnych, i to ono sprawiało, że dwa
   * urządzenia widziały dwie różne historie tej samej rozmowy.
   *
   * Koperta wraca wtedy także do nadawcy, który nie potrafi jej odszyfrować
   * (MLS nie pozwala przetworzyć własnej wiadomości). Rozpoznaje ją
   * [`echa.ts`] i potwierdza bez przetwarzania.
   */
  private skrzynkiRozmowy(groupId: Uint8Array): string[] {
    return this.memberUserIds(groupId);
  }

  /**
   * Szyfruje i wysyła wiadomość tekstową do całej rozmowy.
   *
   * Odbiorców bierzemy z drzewa MLS, a nie z interfejsu: to jedyne miejsce,
   * które wie, kto **naprawdę** jest w grupie po wszystkich commitach.
   */
  async sendText(groupId: Uint8Array, text: string): Promise<string> {
    const wyslana = this.client.sendText(groupId, text, Date.now());

    // Ratchet przesunął się już przy szyfrowaniu — zapis musi nastąpić nawet
    // wtedy, gdy wysyłka po nim zawiedzie.
    await this.persist();

    await this.rozeslij(groupId, encodeEnvelope(groupId, "application", wyslana.ciphertext));

    // Identyfikator z rdzenia, nie własny UUID: potwierdzenia drugiej strony
    // wskazują wiadomości właśnie po nim. Zapisanie własnego znaczyłoby, że
    // ptaszek nigdy się nie zmieni, a nikt nie wiedziałby dlaczego.
    return idWiadomosci(wyslana.message_id);
  }

  /**
   * Rozsyła gotową kopertę do wszystkich uczestników poza nami.
   *
   * Każde nadanie zużywa osobny token doręczeniowy — ten sam użyty dwa razy
   * zostałby odrzucony przy drugim, a jeden na całą grupę wiązałby odbiorców
   * ze sobą po stronie serwera.
   */
  private async rozeslij(groupId: Uint8Array, envelope: Uint8Array): Promise<void> {
    // Zapamiętanie MUSI wyprzedzić nadanie: przy podłączonym gnieździe echo
    // wraca natychmiast i zdążyłoby przyjść przed wpisem do mapy.
    await zapamietaj(envelope);

    await Promise.all(
      this.skrzynkiRozmowy(groupId).map((userId) => {
        const token = wezToken();
        return api.deposit(userId, envelope, token ? naglowekTokenu(token) : undefined);
      }),
    );

    // Uzupełnianie PO wysyłce, nie przed: pobranie zapasu jest żądaniem
    // uwierzytelnionym, więc trzymamy je z dala od chwili nadania.
    void uzupelnij(this.token);
  }

  /**
   * Wysyła plik: szyfruje, wgrywa szyfrogram, a klucz wysyła kanałem MLS.
   *
   * Kolejność jest istotna. Szyfrujemy PRZED wgraniem, więc serwer nigdy nie
   * widzi zawartości — nawet przez chwilę. Klucz idzie osobną drogą i nigdy
   * nie przechodzi przez endpoint załączników.
   */
  /*
   * Zwracamy też OPIS załącznika, a nie samo `messageId`.
   *
   * Bez niego nadawca nie widział własnego zdjęcia. Wątek rysuje obraz tylko
   * wtedy, gdy wiadomość ma pole `zalacznik`, a to pole miały wyłącznie
   * wiadomości PRZYCHODZĄCE — własna zostawała napisem „wysłano: zdjęcie.jpg".
   * Klucz i tak powstaje tutaj, więc nie ma powodu go gubić: ten sam opis
   * trafia do historii i po odświeżeniu karty zdjęcie wciąż się odszyfrowuje.
   */
  async sendFile(
    groupId: Uint8Array,
    file: File,
  ): Promise<{ stripped: boolean; messageId: string; zalacznik: ReceivedAttachment }> {
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

    const wyslana = this.client.sendAttachment(
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

    await this.rozeslij(groupId, encodeEnvelope(groupId, "application", wyslana.ciphertext));

    return {
      stripped,
      messageId: idWiadomosci(wyslana.message_id),
      zalacznik: {
        blobId,
        key: sealed.key,
        nonce: sealed.nonce,
        mimeType,
        sizeBytes: file.size,
        fileName: file.name || undefined,
      },
    };
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
    /*
     * Własne echo odsiewamy PRZED czymkolwiek innym.
     *
     * Wysyłamy także do własnej skrzynki, żeby wiadomość z laptopa dotarła na
     * telefon — więc koperta wraca do nadawcy, a MLS nie pozwala przetworzyć
     * własnej wiadomości. Bez tego wpadłaby w ponawianie z `koperty.ts`
     * i wisiała w kolejce przez trzy połączenia.
     */
    if (await czyWlasna(bytes)) return null;

    const envelope = decodeEnvelope(bytes);

    if (envelope.kind === "welcome") {
      /*
       * Zaproszenie trafia do całej skrzynki, więc przy kilku własnych
       * urządzeniach dostaną je także te, które już są w grupie.
       *
       * Dawniej nieudane `joinFromWelcome` znaczyło realną awarię i miało
       * prawo przejść ścieżką ponawiania. Odkąd jedna osoba ma wiele urządzeń,
       * powtórka jest normalna — ale zostawiamy ślad w konsoli, bo
       * niedoręczone zaproszenie zepsuło już kiedyś doręczanie po cichu
       * i nie chcemy drugi raz zgadywać.
       */
      try {
        this.client.joinFromWelcome(envelope.payload);
      } catch (blad) {
        console.warn("zaproszenie odrzucone (zapewne już jesteśmy w grupie)", blad);
        return null;
      }
      await this.persist();
      return null;
    }

    /*
     * Rozmowę rozpoznajemy po znaczniku, nie z koperty.
     *
     * Koperta nie niesie identyfikatora rozmowy — niosła go do wersji 2
     * formatu i było to jedyne, czego serwer potrzebował, żeby zbudować graf
     * rozmów z samego ruchu. Dopasowanie robi rdzeń: klucz routingu wyprowadza
     * się z identyfikatora, a ten nie opuszcza rdzenia w postaci nadającej się
     * do policzenia znacznika.
     *
     * Brak dopasowania jest SPODZIEWANY: koperta powtórzona, spreparowana albo
     * dla rozmowy, której stanu jeszcze nie mamy. Wywołujący traktuje `null`
     * jak każdą inną kopertę bez treści.
     */
    const groupId = this.client.matchEnvelope(bytes);
    if (!groupId) return null;

    // Commit zmienia skład grupy i epokę. Przetwarzamy go tą samą ścieżką co
    // wiadomość — `receive` rozpoznaje rodzaj sam.
    if (envelope.kind === "commit") {
      this.client.receive(groupId, envelope.payload);
      await this.persist();
      return null;
    }

    const incoming = this.client.receive(groupId, envelope.payload);
    await this.persist();

    if (incoming.kind !== "message") return null;

    return {
      groupId,
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
            target: incoming.call.target,
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
      receipt:
        incoming.receipt && incoming.receipt.kind !== "nieznany"
          ? {
              kind: incoming.receipt.kind as "delivered" | "read",
              messageIds: rozetnijIdentyfikatory(incoming.receipt.message_ids),
            }
          : undefined,
    };
  }

  /**
   * Wysyła paczkę potwierdzeń.
   *
   * Idzie tą samą drogą co wiadomość, więc serwer widzi wyłącznie szyfrogram.
   * **Chwili** wysyłki to nie ukrywa — o to dba wołający, który zbiera
   * potwierdzenia i opóźnia wysyłkę o losowy czas (`potwierdzenia.ts`).
   */
  async sendReceipt(
    groupId: Uint8Array,
    kind: "delivered" | "read",
    messageIds: string[],
  ): Promise<void> {
    if (messageIds.length === 0) return;

    const ciphertext = this.client.sendReceipt(
      groupId,
      kind,
      sklejIdentyfikatory(messageIds),
      Date.now(),
    );

    // Ratchet przesunął się już przy szyfrowaniu — zapis musi nastąpić nawet
    // wtedy, gdy wysyłka po nim zawiedzie.
    await this.persist();

    await this.rozeslij(groupId, encodeEnvelope(groupId, "application", ciphertext));
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
    target = "",
  ): Promise<void> {
    const ciphertext = this.client.sendCallSignal(
      groupId,
      kind,
      callId,
      payload,
      dtlsFingerprint,
      target,
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

