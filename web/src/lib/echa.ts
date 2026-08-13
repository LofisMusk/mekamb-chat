/**
 * Rozpoznawanie własnych kopert wracających z własnej skrzynki.
 *
 * # Dlaczego to musi istnieć
 *
 * Żeby telefon zobaczył wiadomość wysłaną z laptopa, laptop musi wrzucić ją
 * także do **własnej** skrzynki — bo skrzynka adresowana jest nazwą
 * użytkownika, a nie urządzeniem. Nie da się powiedzieć „dostarcz moim innym
 * urządzeniom, ale nie temu". Koperta wraca więc do nadawcy.
 *
 * A nadawca nie potrafi jej odszyfrować: MLS z założenia nie pozwala
 * przetworzyć własnej wiadomości (`process_message` zwraca błąd, rdzeń mapuje
 * go na `MessageRejected`). Bez rozpoznania własnego echa koperta wpadłaby
 * w politykę ponawiania z [`koperty.ts`] i wisiała w kolejce przez trzy
 * połączenia, zanim zostałaby uznana za martwą.
 *
 * # Dlaczego skrót, a nie identyfikator wiadomości
 *
 * `message_id` siedzi **wewnątrz** szyfrogramu, więc jest nieczytelny dokładnie
 * dla tego, kto go potrzebuje. Skrót z bajtów koperty rozpoznaje ją bez
 * zaglądania do środka. Te same bajty idą do wszystkich odbiorców, więc jeden
 * wpis wystarcza na całe rozesłanie.
 *
 * # Dlaczego pamięć, a nie skarbiec
 *
 * Echo wraca w sekundy, a nie po restarcie. Zapis na dysk kosztowałby przy
 * każdej wysyłce, a jego brak niczego nie psuje: po odświeżeniu strony
 * niedokończone echo przejdzie zwykłą ścieżką ponawiania i zostanie
 * potwierdzone jako martwe. Tak samo licznik prób w [`koperty.ts`] celowo
 * zeruje się przy przeładowaniu.
 */

/**
 * Jak długo pamiętamy własną kopertę.
 *
 * Echo z podłączonego gniazda wraca natychmiast, ale koperta nadana tuż przed
 * utratą sieci wróci dopiero przy następnym połączeniu. Dziesięć minut pokrywa
 * ten przypadek, a jednocześnie nie trzyma śmieci przez całą sesję.
 */
const ZYCIE_MS = 10 * 60 * 1000;

/**
 * Ile skrótów trzymamy najwyżej.
 *
 * Bez ograniczenia długa sesja z tysiącami wiadomości rosłaby bez końca.
 * Przekroczenie limitu wyrzuca najstarsze wpisy — a najgorsze, co się wtedy
 * dzieje, to powrót do zachowania sprzed tego modułu.
 */
const LIMIT = 512;

const znane = new Map<string, number>();

/** Skrót koperty, w postaci szesnastkowej. */
async function skrot(koperta: Uint8Array): Promise<string> {
  const bufor = koperta.buffer.slice(
    koperta.byteOffset,
    koperta.byteOffset + koperta.byteLength,
  ) as ArrayBuffer;

  const wynik = new Uint8Array(await crypto.subtle.digest("SHA-256", bufor));

  return Array.from(wynik, (b) => b.toString(16).padStart(2, "0")).join("");
}

/** Usuwa wpisy przeterminowane i nadmiarowe. */
function posprzataj(): void {
  const prog = Date.now() - ZYCIE_MS;

  for (const [klucz, czas] of znane) {
    if (czas < prog) znane.delete(klucz);
  }

  // Mapa zachowuje kolejność wstawiania, więc najstarsze są na początku.
  while (znane.size > LIMIT) {
    const najstarszy = znane.keys().next();
    if (najstarszy.done) break;
    znane.delete(najstarszy.value);
  }
}

/** Zapamiętuje kopertę, którą sami nadajemy. */
export async function zapamietaj(koperta: Uint8Array): Promise<void> {
  znane.set(await skrot(koperta), Date.now());
  posprzataj();
}

/**
 * Czy ta koperta to nasze własne echo.
 *
 * Rozpoznaną kopertę **zapominamy** — wraca dokładnie raz na urządzenie, a to
 * urządzenie właśnie ją dostało. Zostawienie wpisu tylko wydłużałoby życie
 * mapy.
 */
export async function czyWlasna(koperta: Uint8Array): Promise<boolean> {
  const klucz = await skrot(koperta);

  if (!znane.has(klucz)) return false;

  znane.delete(klucz);
  return true;
}

/** Czyści pamięć — przy wylogowaniu i w testach. */
export function zapomnijWszystko(): void {
  znane.clear();
}
