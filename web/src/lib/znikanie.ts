import { kluczRozmowy } from "./historia";
import { loadEphemeral, saveEphemeral } from "./vault";

/**
 * Znikające wiadomości — retencja lokalna per rozmowa.
 *
 * # Co to właściwie robi
 *
 * Ustawiasz na rozmowie czas, po którym jej wiadomości mają zniknąć z TEGO
 * urządzenia. Po jego upływie wiadomość jest usuwana z zaszyfrowanej historii,
 * tak samo jakby nigdy jej nie zapisano.
 *
 * # Dlaczego to jest retencja lokalna, a nie „zniknij drugiej stronie"
 *
 * Historia rozmowy żyje WYŁĄCZNIE na urządzeniu — serwer jej nie ma i mieć nie
 * będzie (patrz [`historia.ts`]). Nie istnieje więc miejsce, z którego dałoby
 * się skasować wiadomość rozmówcy; każdy trzyma własną kopię. „Znikanie" znaczy
 * tu uczciwie tyle, ile może znaczyć: „nie przechowuj tego u mnie dłużej niż X".
 * Uzgodnienie tego z rozmówcą wymagałoby nowego pola w kanale MLS (proto +
 * rdzeń + oba klienty) — to osobna, większa zmiana; tu robimy część, którą da
 * się zrobić w całości po jednej stronie.
 *
 * # Domyślnie wyłączone
 *
 * Rozmowa bez wpisu w tej mapie nie ma znikania — to stan domyślny. Wyłączenie
 * znikania to usunięcie wpisu, nie zapisanie zera.
 */

/** Wersja formatu zapisu. */
const WERSJA = 1;

interface ZapisanyPlik {
  wersja: number;
  /** `groupId` (hex) → ile sekund wiadomość ma przeżyć. */
  rozmowy: Record<string, number>;
}

/** Ustawienia znikania: `groupId` (hex) → sekundy życia wiadomości. */
export type StanZnikania = Record<string, number>;

/**
 * Gotowe długości do wyboru w interfejsie.
 *
 * „Własny" (custom) zostaje osobno w interfejsie — tu są tylko skróty do
 * najczęstszych wartości. Sekundy, bo tego oczekuje odcięcie.
 */
export const PRESETY_ZNIKANIA: { sekundy: number; etykieta: string }[] = [
  { sekundy: 5 * 60, etykieta: "5 minut" },
  { sekundy: 60 * 60, etykieta: "1 godzina" },
  { sekundy: 8 * 60 * 60, etykieta: "8 godzin" },
  { sekundy: 24 * 60 * 60, etykieta: "1 dzień" },
  { sekundy: 7 * 24 * 60 * 60, etykieta: "1 tydzień" },
  { sekundy: 28 * 24 * 60 * 60, etykieta: "4 tygodnie" },
];

/** Jednostki dla pola „własny czas". */
export const JEDNOSTKI_ZNIKANIA: { mnoznik: number; etykieta: string }[] = [
  { mnoznik: 60, etykieta: "minut" },
  { mnoznik: 60 * 60, etykieta: "godzin" },
  { mnoznik: 24 * 60 * 60, etykieta: "dni" },
];

/** Ludzki opis długości znikania — do pokazania w panelu i na liście presetów. */
export function opisZnikania(sekundy: number): string {
  const preset = PRESETY_ZNIKANIA.find((p) => p.sekundy === sekundy);
  if (preset) return preset.etykieta;

  if (sekundy % (24 * 60 * 60) === 0) {
    const dni = sekundy / (24 * 60 * 60);
    return `${dni} ${dni === 1 ? "dzień" : "dni"}`;
  }
  if (sekundy % (60 * 60) === 0) return `${sekundy / (60 * 60)} godz.`;
  if (sekundy % 60 === 0) return `${sekundy / 60} min`;
  return `${sekundy} s`;
}

async function wczytajSurowe(): Promise<StanZnikania> {
  const bajty = await loadEphemeral();
  if (!bajty) return {};

  try {
    const zapis = JSON.parse(new TextDecoder().decode(bajty)) as ZapisanyPlik;
    if (zapis.wersja !== WERSJA) return {};
    return { ...(zapis.rozmowy ?? {}) };
  } catch {
    return {};
  }
}

let kolejka: Promise<unknown> = Promise.resolve();

function zSerializacja<T>(operacja: () => Promise<T>): Promise<T> {
  const wynik = kolejka.then(operacja, operacja);
  kolejka = wynik.catch(() => {});
  return wynik;
}

async function zapisz(stan: StanZnikania): Promise<void> {
  const plik: ZapisanyPlik = { wersja: WERSJA, rozmowy: stan };
  await saveEphemeral(new TextEncoder().encode(JSON.stringify(plik)));
}

/** Wczytuje ustawienia znikania — do zasiania interfejsu przy starcie. */
export async function wczytajZnikanie(): Promise<StanZnikania> {
  return wczytajSurowe();
}

/**
 * Ustawia (albo wyłącza, przez `null`) znikanie dla jednej rozmowy.
 *
 * Zwraca świeży, kompletny stan — interfejs zasiewa nim mapę bez ponownego
 * odczytu.
 */
export async function ustawZnikanie(
  groupId: Uint8Array,
  sekundy: number | null,
): Promise<StanZnikania> {
  return zSerializacja(async () => {
    const stan = await wczytajSurowe();
    const klucz = kluczRozmowy(groupId);
    if (sekundy && sekundy > 0) stan[klucz] = Math.floor(sekundy);
    else delete stan[klucz];
    await zapisz(stan);
    return stan;
  });
}

/** Zapomina ustawienie znikania przy usuwaniu rozmowy, żeby mapa nie puchła. */
export async function zapomnijZnikanie(groupId: Uint8Array): Promise<StanZnikania> {
  return zSerializacja(async () => {
    const stan = await wczytajSurowe();
    delete stan[kluczRozmowy(groupId)];
    await zapisz(stan);
    return stan;
  });
}

/**
 * Zamienia ustawienia znikania na mapę `klucz → najstarsza chwila do zachowania`.
 *
 * Wiadomość z czasem starszym niż zwrócona granica ma zostać usunięta. Funkcja
 * czysta względem zegara: `teraz` podaje wywołujący, żeby dało się to
 * przetestować bez `Date.now`.
 */
export function graniceOdciecia(stan: StanZnikania, teraz: number): Record<string, number> {
  const granice: Record<string, number> = {};
  for (const [klucz, sekundy] of Object.entries(stan)) {
    if (sekundy > 0) granice[klucz] = teraz - sekundy * 1000;
  }
  return granice;
}
