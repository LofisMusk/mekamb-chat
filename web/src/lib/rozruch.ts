import type { Account } from "./vault";

/**
 * Wybór ekranu pokazywanego po uruchomieniu aplikacji.
 *
 * # Dlaczego to jest osobny moduł, a nie sam efekt w `App`
 *
 * Ekran „Wczytywanie…" nie ma wyjścia awaryjnego: dopóki nikt nie ustawi
 * innego stanu, użytkownik patrzy na niego bez końca. A rzucić może każdy krok
 * startu — IndexedDB bywa niedostępne (tryb prywatny, wyczerpany limit), a
 * `fetch` rzuca `TypeError` nie tylko przy zerwanej sieci, ale też wtedy, gdy
 * odpowiedź nie ma nagłówków CORS albo blokuje ją CSP. Odrzucona obietnica
 * w efekcie Reacta nie robi nic widocznego, więc aplikacja zostawała na
 * „Wczytywanie…" **bez jednego słowa o błędzie**.
 *
 * Zdarzyło się to naprawdę: Worker na produkcji był starszy niż strona i nie
 * odpowiadał nagłówkiem `Access-Control-Allow-Credentials`, którego wymaga
 * `credentials: "include"` w `/auth/refresh`. Przeglądarka odrzuciła żądanie
 * jako `TypeError` — nie `ApiError` — więc wyjątek przeleciał przez cały
 * efekt startowy. Użytkownik zobaczył wieczne „Wczytywanie…" i nic więcej,
 * a diagnoza wymagała zaglądania w nagłówki odpowiedzi serwera.
 *
 * Stąd reguła: rozruch zawsze kończy się jakimś ekranem. Ta funkcja nie rzuca,
 * a błąd zwraca jako tekst do pokazania obok ekranu zastępczego.
 *
 * Wydzielenie z komponentu jest po to, żeby dało się to sprawdzić testem bez
 * DOM-u — awaria polega na tym, czego interfejs *nie* zrobił, a takiej rzeczy
 * nie widać w ręcznym klikaniu.
 */

/** Ekran, od którego zaczyna aplikacja. `blad` niesie powód ekranu zastępczego. */
export type Rozruch =
  | { nazwa: "powitanie"; blad?: string }
  | { nazwa: "logowanie"; blad?: string }
  | { nazwa: "sesja"; konto: Account; token: string };

/** Zależności rozruchu — wstrzykiwane, żeby test nie potrzebował IndexedDB ani sieci. */
export interface ZrodlaRozruchu {
  wczytajKonto: () => Promise<Account | null>;
  odswiezSesje: (deviceId: string) => Promise<{ token: string } | null>;
}

/** Zamienia cokolwiek, co zostało rzucone, w tekst dla użytkownika. */
export function opisBledu(e: unknown): string {
  return e instanceof Error ? e.message : String(e);
}

export async function ustalRozruch({
  wczytajKonto,
  odswiezSesje,
}: ZrodlaRozruchu): Promise<Rozruch> {
  let konto: Account | null;

  try {
    konto = await wczytajKonto();
  } catch (e) {
    // Ekran logowania, a nie powitanie: skarbiec mógł się nie otworzyć mimo
    // istniejącego konta, a powitanie zachęcałoby do założenia drugiego.
    // Logowanie odtwarza to samo konto, więc jest bezpiecznym wyjściem.
    return {
      nazwa: "logowanie",
      blad: `Nie udało się otworzyć magazynu na tym urządzeniu (${opisBledu(e)}). Zaloguj się ponownie.`,
    };
  }

  if (!konto) return { nazwa: "powitanie" };

  try {
    const odswiezony = await odswiezSesje(konto.deviceId);

    // Brak trwałej sesji to zwykły przypadek (pierwsze uruchomienie, długa
    // nieobecność), nie awaria — dlatego bez komunikatu o błędzie.
    return odswiezony
      ? { nazwa: "sesja", konto, token: odswiezony.token }
      : { nazwa: "logowanie" };
  } catch (e) {
    return {
      nazwa: "logowanie",
      blad: `Serwer jest nieosiągalny (${opisBledu(e)}). Zaloguj się, gdy wróci połączenie.`,
    };
  }
}
