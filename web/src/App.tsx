import { useCallback, useEffect, useState } from "react";
import { toast } from "sonner";

import { Czat } from "./Czat";
import { Ikona } from "./Ikony";
import { KodQr } from "./KodQr";
import { Migotanie, WyborJezykaUI, WyborMotywuUI, WzorKropek, ZnakMarki } from "./Wspolne";
import { Button } from "./components/ui/button";
import { Input } from "./components/ui/input";
import {
  confirmRegistration,
  loginStart,
  loginWithTotp,
  refreshSession,
  register,
  webauthnLoginOptions,
  webauthnLoginVerify,
} from "./lib/auth";
import type { LoginSession } from "./lib/auth";
import { Messenger } from "./lib/messenger";
import { pilnujMotywu, wczytajWybor } from "./lib/motyw";
import { useWstecz } from "./lib/nawigacja";
import { pilnujWysokosci } from "./lib/okno";
import { getPasskey, isPasskeySupported } from "./lib/passkey";
import { opisBledu, ustalRozruch } from "./lib/rozruch";
import {
  type Account,
  isInstalled,
  isPersistent,
  kontoZLogowania,
  loadAccount,
  requestPersistence,
  saveAccount,
} from "./lib/vault";
import { t, useJezyk } from "./lib/jezyk";

/** Minimalna długość hasła — ta sama, na którą patrzy przycisk „Załóż konto". */
const MINIMUM_HASLA = 12;

/** Odtwarza albo zakłada `Messenger` po udanym uwierzytelnieniu i zgłasza urządzenie do katalogu. */
async function zakonczLogowanie(konto: Account, token: string): Promise<Messenger> {
  // Trwały magazyn zapewniamy PRZED wygenerowaniem kluczy. Odwrotna kolejność
  // grozi cichą utratą konta na iOS.
  await requestPersistence();
  await saveAccount(konto);

  const messenger =
    (await Messenger.restore(konto, token)) ?? (await Messenger.create(konto, token));

  // Kolejność jest istotna: key packages mają klucz obcy do urządzenia,
  // więc katalog musi je poznać najpierw.
  await messenger.registerDevice();
  await messenger.publishKeyPackages();

  return messenger;
}

/**
 * Interfejs klienta webowego.
 *
 * # Kolejność onboardingu jest wymuszona przez platformę
 *
 * Na iOS klucze wolno wygenerować dopiero po zapewnieniu trwałego magazynu,
 * a trwały magazyn wymaga zainstalowanej aplikacji i zgody na powiadomienia.
 * Odwrócenie tej kolejności naraża użytkownika na ciche skasowanie konta przez
 * system po tygodniu nieużywania — bez możliwości odzyskania historii.
 */

type Ekran =
  | { nazwa: "ladowanie" }
  | { nazwa: "powitanie" }
  | { nazwa: "rejestracja" }
  | { nazwa: "potwierdzenie"; username: string; totpSecret: string; otpauthUri: string }
  | { nazwa: "logowanie" }
  | { nazwa: "drugi-skladnik"; username: string; sesja: LoginSession }
  | { nazwa: "czat"; messenger: Messenger };

/**
 * Tytuł ekranu w pasku — jedno miejsce zamiast napisu wpisanego w każdym.
 *
 * Jeden język naraz, wybrany przełącznikiem (`lib/jezyk.ts`). Wcześniej tytuł
 * stał w dwóch liniach, PL i EN — obejście braku przełącznika, tak jak
 * „Załóż konto · Create account" na przyciskach.
 */
const TYTULY: Partial<Record<Ekran["nazwa"], { pl: string; en: string }>> = {
  rejestracja: { pl: "Nowe konto", en: "New account" },
  potwierdzenie: { pl: "Drugi składnik", en: "Second factor" },
  logowanie: { pl: "Logowanie", en: "Sign in" },
  "drugi-skladnik": { pl: "Kod z authenticatora", en: "Authenticator code" },
};

export function App() {
  // Subskrypcja języka w korzeniu: zmiana przełącznika przerysowuje całe
  // drzewo, a `t()` w każdym komponencie czyta nowy język przy renderze.
  useJezyk();
  const [ekran, setEkran] = useState<Ekran>({ nazwa: "ladowanie" });
  const [trwaly, setTrwaly] = useState(true);

  /*
   * Motyw włączamy przed czymkolwiek innym.
   *
   * Nasłuch zmian systemu wisi przez całe życie aplikacji, także wtedy, gdy
   * wybrano motyw na sztywno — inaczej przełączenie wyboru na „systemowy"
   * wymagałoby przeładowania strony, żeby zaczęło działać.
   */
  useEffect(() => pilnujMotywu(() => wczytajWybor()), []);

  /*
   * Wysokość widoku razem z klawiaturą — patrz `okno.ts`.
   *
   * Obok motywu, bo to ta sama kategoria: rzecz dotycząca `<html>`, nie
   * poddrzewa Reacta, ustawiana raz na życie aplikacji.
   */
  useEffect(() => pilnujWysokosci(), []);

  useEffect(() => {
    void (async () => {
      try {
        setTrwaly(await isPersistent());
      } catch {
        // Storage API bywa niedostępne (starsze WebView, tryb prywatny).
        // To tylko ostrzeżenie na górze ekranu — nie może zatrzymać startu.
      }

      // Próba cichej trwałej sesji PRZED pokazaniem ekranu logowania: token
      // dostępowy żyje krócej niż tożsamość urządzenia, ale cookie z tokenem
      // odświeżającym (`/auth/refresh`) przeżywa odświeżenie strony.
      const start = await ustalRozruch({
        wczytajKonto: loadAccount,
        odswiezSesje: refreshSession,
      });

      if (start.nazwa !== "sesja") {
        if (start.blad) pokazBlad(start.blad);
        setEkran({ nazwa: start.nazwa });
        return;
      }

      // Ta ścieżka ZASTĘPUJE logowanie, więc musi zrobić dokładnie to samo co
      // ono — łącznie z publikacją key packages. Są JEDNORAZOWE: pominięcie
      // tego kroku sprawia, że zapas wyczerpuje się po kilku rozmowach i nikt
      // nie może już nas dodać do grupy („brak dostępnych key packages").
      try {
        setEkran({ nazwa: "czat", messenger: await zakonczLogowanie(start.konto, start.token) });
      } catch (e) {
        // Sieć mogła paść między odświeżeniem a rejestracją urządzenia.
        // Ekran logowania jest tu bezpiecznym miejscem powrotu — ale z powodem
        // wypisanym wprost, bo inaczej wygląda to na wylogowanie bez przyczyny.
        pokazBlad(t(`Nie udało się przywrócić sesji (${opisBledu(e)}). Zaloguj się ponownie.`, `Couldn't restore the session (${opisBledu(e)}). Please sign in again.`));
        setEkran({ nazwa: "logowanie" });
      }
    })();
  }, []);

  const zglosBlad = useCallback((e: unknown) => pokazBlad(opisBledu(e)), []);

  /*
   * Cofanie się z ekranów, do których się wchodzi.
   *
   * Jedna decyzja „dokąd wraca ten ekran" dla wszystkich trzech dróg wyjścia:
   * strzałki, gestu i systemowego „wstecz". Rozbicie tego na osobne obsługi
   * kończy się tym, że przycisk systemowy wyrzuca z aplikacji zamiast wrócić
   * o krok.
   */
  const wstecz = useCallback(() => {
    setEkran((biezacy) => {
      switch (biezacy.nazwa) {
        case "drugi-skladnik":
          return { nazwa: "logowanie" };

        case "potwierdzenie":
          // Wyjście stąd ma cenę i użytkownik musi ją poznać: konto już
          // istnieje, ale bez potwierdzenia jest bezużyteczne, a jego nazwy
          // nie da się zająć drugi raz (serwer odpowiada „nazwa jest zajęta").
          // Stały identyfikator: w trybie ścisłym React woła tę funkcję dwa
          // razy, a komunikat ma się pokazać raz.
          pokazBlad(
            t("Konto zostało założone, ale niepotwierdzone — bez kodu z authenticatora nie da ", "The account was created but not confirmed — without the authenticator code you can't sign in to it, and its name stays taken. ") +
              t("się na nie zalogować, a jego nazwa pozostaje zajęta.", ""),
            "niepotwierdzone",
          );
          return { nazwa: "logowanie" };

        default:
          return { nazwa: "powitanie" };
      }
    });
  }, []);

  const wEkranieZPowrotem =
    ekran.nazwa === "rejestracja" ||
    ekran.nazwa === "potwierdzenie" ||
    ekran.nazwa === "logowanie" ||
    ekran.nazwa === "drugi-skladnik";

  useWstecz(wEkranieZPowrotem, wstecz, ekran.nazwa);

  // Po zalogowaniu interfejs bierze całą szerokość i ma własny nagłówek —
  // wspólny tytuł nad panelami byłby drugim paskiem bez treści.
  if (ekran.nazwa === "czat") {
    return (
      <main className="aplikacja">
        <Czat messenger={ekran.messenger} onBlad={zglosBlad} />
      </main>
    );
  }

  const tytul = TYTULY[ekran.nazwa];

  return (
    <main className="wejscie">
      {/* Faktura tła, nie obrazek — patrz `WzorKropek`. */}
      <WzorKropek />

      <div className="relative mx-auto flex min-h-full w-full max-w-sm flex-col">
        <div className="flex justify-end">
          <div className="flex items-center gap-2">
            {/* Przełącznik języka PRZED logowaniem — osoba nieznająca angielskiego
                musi dotrzeć do polskiego bez wchodzenia do ustawień. */}
            <WyborJezykaUI />
            <WyborMotywuUI />
          </div>
        </div>

        <div className="flex flex-1 flex-col justify-center gap-6 py-8">
          {/*
            Pod nazwą nie ma podtytułu o szyfrowaniu.

            „Szyfrowanie end-to-end. Serwer nie widzi treści." było obietnicą,
            po której przeczytaniu nikt nie mógł zrobić niczego inaczej — a stało
            na najbardziej eksponowanym miejscu ekranu wejścia. Zdania, które
            zostały w aplikacji, mówią o KONSEKWENCJACH: że historii nie da się
            odzyskać, że rozmówca zna adres IP, że kto zobaczy kod, przejmie konto.
          */}
          <header className="flex flex-col items-center gap-3 text-center">
            <ZnakMarki className="size-12 rounded-lg" />
            <h1 className="text-powitanie">mekamb</h1>
          </header>

          {!trwaly && <OstrzezenieOTrwalosci onOdswiez={() => void isPersistent().then(setTrwaly)} />}

          {wEkranieZPowrotem && tytul && (
            <div className="-mb-2 flex items-center gap-2">
              <Button variant="ghost" size="icon" aria-label={t("Wróć", "Back")} onClick={() => history.back()}>
                <Ikona nazwa="wstecz" rozmiar={18} />
              </Button>
              <span className="flex min-w-0 flex-col">
                <h2 className="text-tytul">{t(tytul.pl, tytul.en)}</h2>
              </span>
            </div>
          )}

          {ekran.nazwa === "ladowanie" && (
            <div className="karta" aria-busy="true">
              <Migotanie className="h-10" opis={t("Wczytywanie…", "Loading…")} />
              <Migotanie className="h-10 opacity-70" opis="" />
            </div>
          )}

          {ekran.nazwa === "powitanie" && (
            <div className="karta">
              <Button onClick={() => setEkran({ nazwa: "rejestracja" })}>
                <Ikona nazwa="dodaj" rozmiar={16} />
                {t("Załóż konto", "Create account")}
              </Button>
              <Button variant="outline" onClick={() => setEkran({ nazwa: "logowanie" })}>
                {t("Mam już konto", "I already have an account")}
              </Button>
              <PrzyciskPasskey
                wariant="ghost"
                onBlad={zglosBlad}
                onGotowe={(messenger) => setEkran({ nazwa: "czat", messenger })}
              />
            </div>
          )}

          {ekran.nazwa === "rejestracja" && (
            <FormularzRejestracji
              onBlad={zglosBlad}
              onGotowe={(username, wynik) => setEkran({ nazwa: "potwierdzenie", username, ...wynik })}
            />
          )}

          {ekran.nazwa === "potwierdzenie" && (
            <PotwierdzenieTotp
              username={ekran.username}
              totpSecret={ekran.totpSecret}
              otpauthUri={ekran.otpauthUri}
              onBlad={zglosBlad}
              onGotowe={(messenger) => setEkran({ nazwa: "czat", messenger })}
            />
          )}

          {ekran.nazwa === "logowanie" && (
            <>
              <FormularzLogowania
                onBlad={zglosBlad}
                onGotowe={(username, sesja) => setEkran({ nazwa: "drugi-skladnik", username, sesja })}
              />

              {/*
                Passkey także tutaj, nie tylko na powitaniu.

                Powitanie widzi się raz — potem urządzenie ma już konto w skarbcu
                i aplikacja startuje wprost na logowaniu. Passkey stał więc na
                ekranie, do którego stały użytkownik nigdy nie wraca: kto raz się
                zalogował, nie miał go już nigdy zobaczyć. Na iPhonie, gdzie sesja
                i tak nie przeżywała zamknięcia aplikacji, znaczyło to hasło i kod
                TOTP przy każdym uruchomieniu.
              */}
              <div className="flex flex-col gap-2">
                <PrzyciskPasskey
                  wariant="outline"
                  onBlad={zglosBlad}
                  onGotowe={(messenger) => setEkran({ nazwa: "czat", messenger })}
                />
                <Button variant="ghost" onClick={() => setEkran({ nazwa: "powitanie" })}>
                  {t("Nie mam jeszcze konta", "I don't have an account yet")}
                </Button>
              </div>
            </>
          )}

          {ekran.nazwa === "drugi-skladnik" && (
            <DrugiSkladnik
              username={ekran.username}
              sesja={ekran.sesja}
              onBlad={zglosBlad}
              onGotowe={(messenger) => setEkran({ nazwa: "czat", messenger })}
            />
          )}
        </div>
      </div>
    </main>
  );
}

/**
 * Komunikat o błędzie jako powiadomienie chwilowe (Sonner).
 *
 * Wcześniej był to pasek nad treścią, który przesuwał cały ekran w dół
 * w chwili, w której coś poszło źle — razem z polem, w które akurat się
 * pisało. Powiadomienie leży NAD układem i niczego nie przesuwa; znika samo,
 * a najechanie kursorem je zatrzymuje, więc dłuższe da się doczytać.
 */
function pokazBlad(tekst: string, id?: string) {
  toast.error(tekst, { id, duration: tekst.length > 90 ? 9000 : 6000 });
}

/**
 * Ostrzeżenie o nietrwałym magazynie.
 *
 * Nie jest to kosmetyka: na iOS dane aplikacji webowej znikają po około
 * tygodniu nieużywania, a razem z nimi możliwość odszyfrowania historii.
 */
function OstrzezenieOTrwalosci({ onOdswiez }: { onOdswiez: () => void }) {
  const zainstalowana = isInstalled();

  // Kolor `ostrzezenie` tylko na ikonie i obrysie: to stan, który wymaga
  // reakcji, ale nie błąd — plama koloru krzyczałaby głośniej niż alarm.
  return (
    <section className="karta border-ostrzezenie/40">
      <strong className="flex items-start gap-2">
        <span className="mt-0.5 text-ostrzezenie">
          <Ikona nazwa="ostrzezenie" rozmiar={16} />
        </span>
        {t("Twoje dane mogą zostać skasowane przez system.", "The system may delete your data.")}
      </strong>
      <p className="wskazowka">
        {t("Historia rozmów jest wyłącznie na tym urządzeniu — serwer jej nie ma, więc nikt jej nie odtworzy.", "Chat history lives only on this device — the server doesn't have it, so no one can restore it.")}
      </p>
      {!zainstalowana ? (
        <p className="wskazowka">
          {t("Na iPhonie: otwórz w Safari, wybierz", "On iPhone: open in Safari, choose")} <em>{t("Udostępnij → Dodaj do ekranu głównego", "Share → Add to Home Screen")}</em>{t(", a potem uruchom aplikację z ikony. Bez tego iOS nie pozwala zabezpieczyć danych.", ", then launch the app from the icon. Without that, iOS won't let the app protect its data.")}
        </p>
      ) : (
        <Button
          variant="outline"
          onClick={async () => {
            // Na iOS `persist()` przechodzi dopiero po zgodzie na powiadomienia.
            if ("Notification" in window) await Notification.requestPermission();
            await requestPersistence();
            onOdswiez();
          }}
        >
          <Ikona nazwa="tarcza" rozmiar={16} />
          {t("Zabezpiecz dane na tym urządzeniu", "Protect the data on this device")}
        </Button>
      )}
    </section>
  );
}

/**
 * Siła hasła — trzy kreski i zdanie, ile brakuje.
 *
 * Świadomie nie udaje pomiaru entropii: jedyne, co naprawdę sprawdzamy, to
 * dwanaście znaków, więc pasek mówiący „średnie" przy haśle „aaaaaaaaaaaa"
 * byłby wprowadzaniem w błąd. Widać, ile brakuje, zanim przycisk odmówi.
 *
 * Ten sam próg i ta sama postać co na Androidzie (`EkranyWejscia.kt`).
 */
function SilaHasla({ haslo }: { haslo: string }) {
  const wypelnione =
    haslo.length >= MINIMUM_HASLA ? 3 : haslo.length >= (MINIMUM_HASLA * 2) / 3 ? 2 : haslo ? 1 : 0;

  const wystarczy = haslo.length >= MINIMUM_HASLA;

  return (
    <div className="sila-hasla">
      {[0, 1, 2].map((i) => (
        <span key={i} className={i < wypelnione ? "kreska pelna" : "kreska"} />
      ))}
      <span className={wystarczy ? "opis wystarczy" : "opis"}>
        {wystarczy ? "wystarczy" : t(`min. ${MINIMUM_HASLA} znaków`, `min. ${MINIMUM_HASLA} characters`)}
      </span>
    </div>
  );
}

function FormularzRejestracji({
  onGotowe,
  onBlad,
}: {
  onGotowe: (username: string, wynik: { totpSecret: string; otpauthUri: string }) => void;
  onBlad: (e: unknown) => void;
}) {
  const [username, setUsername] = useState("");
  const [haslo, setHaslo] = useState("");
  const [pracuje, setPracuje] = useState(false);

  return (
    <form
      className="karta"
      onSubmit={async (e) => {
        e.preventDefault();
        setPracuje(true);
        try {
          onGotowe(username, await register(username, haslo));
        } catch (err) {
          onBlad(err);
        } finally {
          setPracuje(false);
        }
      }}
    >
      <label>
        {t("Nazwa użytkownika", "Username")}
        <Input
          value={username}
          onChange={(e) => setUsername(e.target.value)}
          required
          minLength={3}
          autoComplete="username"
        />
      </label>

      <label>
        {t("Hasło", "Password")}
        <Input
          type="password"
          value={haslo}
          onChange={(e) => setHaslo(e.target.value)}
          required
          minLength={MINIMUM_HASLA}
          autoComplete="new-password"
        />
      </label>

      <SilaHasla haslo={haslo} />

      {/* Zostaje sama konsekwencja. „Serwer nigdy go nie zobaczy" było
          pochwałą, „nie da się go odzyskać" jest powodem, żeby je zapisać. */}
      <p className="wskazowka-ikona">
        <Ikona nazwa="klucz" rozmiar={14} />
        {t("Tego hasła nie da się odzyskać ani zresetować. Zapisz je w menedżerze haseł, zanim przejdziesz dalej.", "This password can't be recovered or reset. Save it in a password manager before you continue.")}
      </p>

      <Button type="submit" disabled={pracuje}>
        {pracuje ? t("Zakładam…", "Creating…") : t("Załóż konto", "Create account")}
      </Button>
    </form>
  );
}

function PotwierdzenieTotp({
  username,
  totpSecret,
  otpauthUri,
  onGotowe,
  onBlad,
}: {
  username: string;
  totpSecret: string;
  otpauthUri: string;
  onGotowe: (m: Messenger) => void;
  onBlad: (e: unknown) => void;
}) {
  const [kod, setKod] = useState("");

  return (
    <form
      className="karta"
      onSubmit={async (e) => {
        e.preventDefault();
        try {
          // Potwierdzenie kodem to ten sam drugi składnik co logowanie, więc
          // confirm zwraca token dostępowy — wchodzimy prosto na czat, dokładnie
          // ścieżką passkey: nowe urządzenie, konto z samej nazwy + deviceId.
          const deviceId = `web-${crypto.randomUUID().slice(0, 8)}`;
          const { token } = await confirmRegistration(username, kod, deviceId);
          const konto = kontoZLogowania(username, deviceId);
          onGotowe(await zakonczLogowanie(konto, token));
        } catch (err) {
          onBlad(err);
        }
      }}
    >
      <p className="wskazowka">{t("Zeskanuj kod aplikacją authenticator:", "Scan the code with an authenticator app:")}</p>

      <KodQr tresc={otpauthUri} opis={t("Kod QR do dodania konta w aplikacji authenticator", "QR code for adding the account to an authenticator app")} />

      {/* Trzy drogi, bo żadna nie działa wszędzie: kod QR wymaga drugiego
          urządzenia, odnośnik działa tylko na tym samym telefonie, a sekret
          przepisany ręcznie działa zawsze i jest ostatnią deską ratunku. */}
      <p className="wskazowka">
        {t("Na tym samym telefonie:", "On this same phone:")} <a href={otpauthUri}>{t("otwórz w aplikacji authenticator", "open in the authenticator app")}</a>.
      </p>

      <details className="sekret-recznie">
        <summary>{t("Albo wpisz sekret ręcznie", "Or enter the secret manually")}</summary>
        <code className="sekret">{totpSecret}</code>
      </details>

      <label>
        {t("Kod z aplikacji", "Code from the app")}
        <Input
          className="font-mono tracking-[0.2em]"
          value={kod}
          onChange={(e) => setKod(e.target.value)}
          inputMode="numeric"
          autoComplete="one-time-code"
          required
        />
      </label>

      <Button type="submit">{t("Potwierdź", "Confirm")}</Button>

      <p className="wskazowka">
        {t("Po potwierdzeniu ten kod jest już zużyty — do logowania poczekaj na następny.", "Once confirmed, this code is used up — wait for the next one to sign in.")}
      </p>
    </form>
  );
}

function FormularzLogowania({
  onGotowe,
  onBlad,
}: {
  onGotowe: (username: string, sesja: LoginSession) => void;
  onBlad: (e: unknown) => void;
}) {
  const [username, setUsername] = useState("");
  const [haslo, setHaslo] = useState("");
  const [pracuje, setPracuje] = useState(false);

  return (
    <form
      className="karta"
      onSubmit={async (e) => {
        e.preventDefault();
        setPracuje(true);
        try {
          onGotowe(username, await loginStart(username, haslo));
        } catch (err) {
          onBlad(err);
        } finally {
          setPracuje(false);
        }
      }}
    >
      <label>
        {t("Nazwa użytkownika", "Username")}
        <Input
          value={username}
          onChange={(e) => setUsername(e.target.value)}
          required
          autoComplete="username"
        />
      </label>

      <label>
        {t("Hasło", "Password")}
        <Input
          type="password"
          value={haslo}
          onChange={(e) => setHaslo(e.target.value)}
          required
          autoComplete="current-password"
        />
      </label>

      <Button type="submit" disabled={pracuje}>
        {pracuje ? t("Sprawdzam…", "Checking…") : t("Dalej", "Continue")}
      </Button>
    </form>
  );
}

function DrugiSkladnik({
  username,
  sesja,
  onGotowe,
  onBlad,
}: {
  username: string;
  sesja: LoginSession;
  onGotowe: (m: Messenger) => void;
  onBlad: (e: unknown) => void;
}) {
  const [kod, setKod] = useState("");

  return (
    <form
      className="karta"
      onSubmit={async (e) => {
        e.preventDefault();
        try {
          const deviceId = `web-${crypto.randomUUID().slice(0, 8)}`;
          const { token } = await loginWithTotp(sesja, kod, deviceId);

          // Konto istniejące odtwarzamy razem z jego wcześniejszym deviceId —
          // nowy identyfikator przy każdym logowaniu zostawiałby w katalogu
          // stos martwych urządzeń, do których nikt się nie dodzwoni.
          const zapisane = await loadAccount();
          const konto = zapisane ?? kontoZLogowania(username, deviceId);

          onGotowe(await zakonczLogowanie(konto, token));
        } catch (err) {
          onBlad(err);
        }
      }}
    >
      <label>
        {t("Kod", "Code")}
        <Input
          className="font-mono tracking-[0.2em]"
          value={kod}
          onChange={(e) => setKod(e.target.value)}
          inputMode="numeric"
          autoComplete="one-time-code"
          required
        />
      </label>

      <Button type="submit">{t("Zaloguj", "Sign in")}</Button>
    </form>
  );
}

/**
 * Logowanie passkeyem — jednym kliknięciem, bez wpisywania nazwy użytkownika,
 * hasła ani kodu TOTP.
 *
 * # Discoverable, więc bez pola na nazwę użytkownika
 *
 * Passkeye rejestrowane są jako resident credentials (patrz
 * `webauthnRegisterOptions` po stronie serwera) — authenticator sam wie, kim
 * jest właściciel, więc przeglądarka pyta o to użytkownika swoim natywnym UI.
 *
 * Znika, gdy przeglądarka nie wspiera WebAuthn — nie ma sensu pokazywać
 * przycisku, który i tak zawsze zawiedzie.
 */
function PrzyciskPasskey({
  wariant,
  onGotowe,
  onBlad,
}: {
  wariant: "outline" | "ghost";
  onGotowe: (m: Messenger) => void;
  onBlad: (e: unknown) => void;
}) {
  const [pracuje, setPracuje] = useState(false);

  if (!isPasskeySupported()) return null;

  return (
    <Button
      variant={wariant}
      disabled={pracuje}
      onClick={async () => {
        setPracuje(true);
        try {
          const opcje = await webauthnLoginOptions();
          const odpowiedz = await getPasskey(opcje);

          // Zapisane lokalnie urządzenie ma pierwszeństwo — passkey nie daje
          // dostępu do skarbca innej przeglądarki, więc logowanie na obcym
          // profilu i tak nie odtworzy tu historii ani kluczy.
          const zapisane = await loadAccount();
          const deviceId = zapisane?.deviceId ?? `web-${crypto.randomUUID().slice(0, 8)}`;

          const wynik = await webauthnLoginVerify(odpowiedz, deviceId);

          // `wynik.userId` (UUID z bazy) celowo NIE trafia do konta — adresem
          // skrzynki i tożsamością w MLS jest nazwa użytkownika.
          const konto = zapisane ?? kontoZLogowania(wynik.username, deviceId);

          onGotowe(await zakonczLogowanie(konto, wynik.token));
        } catch (err) {
          onBlad(err);
        } finally {
          setPracuje(false);
        }
      }}
    >
      <Ikona nazwa="blokada" rozmiar={16} />
      {pracuje ? t("Loguję…", "Signing in…") : t("Zaloguj passkeyem", "Sign in with a passkey")}
    </Button>
  );
}
