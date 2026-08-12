import { useCallback, useEffect, useState } from "react";

import { Czat } from "./Czat";
import { Ikona } from "./Ikony";
import { KodQr } from "./KodQr";
import { OdbierzTutaj } from "./Przeniesienie";
import { PasekBledu, WyborMotywuUI, ZnakMarki } from "./Wspolne";
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
  | { nazwa: "odbior-przeniesienia" }
  | { nazwa: "drugi-skladnik"; username: string; sesja: LoginSession }
  | { nazwa: "czat"; messenger: Messenger };

/**
 * Tytuł ekranu w pasku — jedno miejsce zamiast napisu wpisanego w każdym.
 *
 * Dwujęzycznie: polski wiodący, angielski drugą linią. To konwencja z projektu,
 * ta sama co w `NaglowekEkranu` na Androidzie — polski jest pierwszy, angielski
 * towarzyszy nagłówkom i głównym akcjom. Tekstów pomocniczych nie dotyczy: tam
 * druga wersja jest szumem, a nie ułatwieniem.
 */
const TYTULY: Partial<Record<Ekran["nazwa"], { pl: string; en: string }>> = {
  rejestracja: { pl: "Nowe konto", en: "New account" },
  potwierdzenie: { pl: "Drugi składnik", en: "Second factor" },
  logowanie: { pl: "Logowanie", en: "Sign in" },
  "drugi-skladnik": { pl: "Kod z authenticatora", en: "Authenticator code" },
  "odbior-przeniesienia": { pl: "Przeniesienie konta", en: "Account transfer" },
};

export function App() {
  const [ekran, setEkran] = useState<Ekran>({ nazwa: "ladowanie" });
  const [blad, setBlad] = useState<string | null>(null);
  const [trwaly, setTrwaly] = useState(true);

  /*
   * Motyw włączamy przed czymkolwiek innym.
   *
   * Nasłuch zmian systemu wisi przez całe życie aplikacji, także wtedy, gdy
   * wybrano motyw na sztywno — inaczej przełączenie wyboru na „systemowy"
   * wymagałoby przeładowania strony, żeby zaczęło działać.
   */
  useEffect(() => pilnujMotywu(() => wczytajWybor()), []);

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
        if (start.blad) setBlad(start.blad);
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
        setBlad(`Nie udało się przywrócić sesji (${opisBledu(e)}). Zaloguj się ponownie.`);
        setEkran({ nazwa: "logowanie" });
      }
    })();
  }, []);

  const zglosBlad = (e: unknown) => setBlad(opisBledu(e));

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
          setBlad(
            "Konto zostało założone, ale niepotwierdzone — bez kodu z authenticatora nie da " +
              "się na nie zalogować, a jego nazwa pozostaje zajęta.",
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
    ekran.nazwa === "drugi-skladnik" ||
    ekran.nazwa === "odbior-przeniesienia";

  useWstecz(wEkranieZPowrotem, wstecz, ekran.nazwa);

  // Po zalogowaniu interfejs bierze całą szerokość i ma własny nagłówek —
  // wspólny tytuł nad panelami byłby drugim paskiem bez treści.
  if (ekran.nazwa === "czat") {
    return (
      <main className="aplikacja">
        {blad && <PasekBledu tekst={blad} onZamknij={() => setBlad(null)} />}
        <Czat messenger={ekran.messenger} onBlad={zglosBlad} />
      </main>
    );
  }

  return (
    <main className="aplikacja">
      <header className="naglowek-wejscia">
        <ZnakMarki />
        <span className="tresc">
          <h1>mekamb</h1>
          <p className="podtytul">Szyfrowanie end-to-end. Serwer nie widzi treści.</p>
        </span>
        <WyborMotywuUI />
      </header>

      {!trwaly && <OstrzezenieOTrwalosci onOdswiez={() => void isPersistent().then(setTrwaly)} />}
      {blad && <PasekBledu tekst={blad} onZamknij={() => setBlad(null)} />}

      {wEkranieZPowrotem && (
        <div className="pasek-ekranu">
          <button className="ikonowy" aria-label="Wróć" onClick={() => history.back()}>
            <Ikona nazwa="wstecz" rozmiar={18} />
          </button>
          <span className="tytul-ekranu">
            <h2>{TYTULY[ekran.nazwa]?.pl}</h2>
            <span className="podtytul-en">{TYTULY[ekran.nazwa]?.en}</span>
          </span>
        </div>
      )}

      {ekran.nazwa === "ladowanie" && (
        <div className="karta">
          <p className="wskazowka-ikona">
            <Ikona nazwa="zegar" rozmiar={14} />
            Wczytywanie…
          </p>
        </div>
      )}

      {ekran.nazwa === "powitanie" && (
        <div className="karta">
          <button className="glowny" onClick={() => setEkran({ nazwa: "rejestracja" })}>
            <Ikona nazwa="dodaj" rozmiar={16} />
            Załóż konto · Create account
          </button>
          <button onClick={() => setEkran({ nazwa: "logowanie" })}>Mam już konto · Sign in</button>
          <PrzyciskPasskey
            onBlad={zglosBlad}
            onGotowe={(messenger) => setEkran({ nazwa: "czat", messenger })}
          />
          <button onClick={() => setEkran({ nazwa: "odbior-przeniesienia" })}>
            <Ikona nazwa="kodQr" rozmiar={16} />
            Przenoszę konto z innego urządzenia · Transfer
          </button>
        </div>
      )}

      {ekran.nazwa === "odbior-przeniesienia" && (
        <OdbierzTutaj
          // Po odebraniu przeładowujemy stronę zamiast przechodzić dalej
          // w miejscu: skarbiec zmienił się pod spodem, a wszystko, co go już
          // wczytało, trzymałoby stan poprzedniego konta.
          onGotowe={() => location.reload()}
          onAnuluj={() => setEkran({ nazwa: "powitanie" })}
          onBlad={zglosBlad}
        />
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
          onGotowe={() => setEkran({ nazwa: "logowanie" })}
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
          <div className="karta">
            <PrzyciskPasskey
              onBlad={zglosBlad}
              onGotowe={(messenger) => setEkran({ nazwa: "czat", messenger })}
            />
            <button onClick={() => setEkran({ nazwa: "powitanie" })}>
              Nie mam jeszcze konta · Create account
            </button>
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
    </main>
  );
}

/**
 * Ostrzeżenie o nietrwałym magazynie.
 *
 * Nie jest to kosmetyka: na iOS dane aplikacji webowej znikają po około
 * tygodniu nieużywania, a razem z nimi możliwość odszyfrowania historii.
 */
function OstrzezenieOTrwalosci({ onOdswiez }: { onOdswiez: () => void }) {
  const zainstalowana = isInstalled();

  return (
    <section className="ostrzezenie">
      <strong>
        <Ikona nazwa="ostrzezenie" rozmiar={14} /> Twoje dane mogą zostać skasowane przez system.
      </strong>
      <p>
        Historia rozmów jest wyłącznie na tym urządzeniu — serwer jej nie ma, więc nikt jej nie
        odtworzy.
      </p>
      {!zainstalowana ? (
        <p>
          Na iPhonie: otwórz w Safari, wybierz <em>Udostępnij → Dodaj do ekranu głównego</em>,
          a potem uruchom aplikację z ikony. Bez tego iOS nie pozwala zabezpieczyć danych.
        </p>
      ) : (
        <button
          onClick={async () => {
            // Na iOS `persist()` przechodzi dopiero po zgodzie na powiadomienia.
            if ("Notification" in window) await Notification.requestPermission();
            await requestPersistence();
            onOdswiez();
          }}
        >
          <Ikona nazwa="tarcza" rozmiar={16} />
          Zabezpiecz dane na tym urządzeniu
        </button>
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
        {wystarczy ? "wystarczy" : `min. ${MINIMUM_HASLA} znaków`}
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
        Nazwa użytkownika · Username
        <input
          value={username}
          onChange={(e) => setUsername(e.target.value)}
          required
          minLength={3}
          autoComplete="username"
        />
      </label>

      <label>
        Hasło · Password
        <input
          type="password"
          value={haslo}
          onChange={(e) => setHaslo(e.target.value)}
          required
          minLength={MINIMUM_HASLA}
          autoComplete="new-password"
        />
      </label>

      <SilaHasla haslo={haslo} />

      <p className="wskazowka-ikona">
        <Ikona nazwa="klucz" rozmiar={14} />
        Hasło nie opuszcza tego urządzenia. Serwer nigdy go nie zobaczy — ale też nie pomoże Ci
        go odzyskać.
      </p>

      <button className="glowny" disabled={pracuje}>
        {pracuje ? "Zakładam…" : "Załóż konto · Create account"}
      </button>
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
  onGotowe: () => void;
  onBlad: (e: unknown) => void;
}) {
  const [kod, setKod] = useState("");

  return (
    <form
      className="karta"
      onSubmit={async (e) => {
        e.preventDefault();
        try {
          await confirmRegistration(username, kod);
          onGotowe();
        } catch (err) {
          onBlad(err);
        }
      }}
    >
      <p className="wskazowka">Zeskanuj kod aplikacją authenticator:</p>

      <KodQr tresc={otpauthUri} opis="Kod QR do dodania konta w aplikacji authenticator" />

      {/* Trzy drogi, bo żadna nie działa wszędzie: kod QR wymaga drugiego
          urządzenia, odnośnik działa tylko na tym samym telefonie, a sekret
          przepisany ręcznie działa zawsze i jest ostatnią deską ratunku. */}
      <p className="wskazowka">
        Na tym samym telefonie: <a href={otpauthUri}>otwórz w aplikacji authenticator</a>.
      </p>

      <details className="sekret-recznie">
        <summary>Albo wpisz sekret ręcznie</summary>
        <code className="sekret">{totpSecret}</code>
      </details>

      <label>
        Kod z aplikacji · Code
        <input
          value={kod}
          onChange={(e) => setKod(e.target.value)}
          inputMode="numeric"
          autoComplete="one-time-code"
          required
        />
      </label>

      <button className="glowny">Potwierdź · Confirm</button>

      <p className="wskazowka">
        Po potwierdzeniu ten kod jest już zużyty — do logowania poczekaj na następny.
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
        Nazwa użytkownika · Username
        <input
          value={username}
          onChange={(e) => setUsername(e.target.value)}
          required
          autoComplete="username"
        />
      </label>

      <label>
        Hasło · Password
        <input
          type="password"
          value={haslo}
          onChange={(e) => setHaslo(e.target.value)}
          required
          autoComplete="current-password"
        />
      </label>

      <button className="glowny" disabled={pracuje}>
        {pracuje ? "Sprawdzam…" : "Dalej · Continue"}
      </button>
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
        Kod · Code
        <input
          value={kod}
          onChange={(e) => setKod(e.target.value)}
          inputMode="numeric"
          autoComplete="one-time-code"
          required
        />
      </label>

      <button className="glowny">Zaloguj · Sign in</button>
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
  onGotowe,
  onBlad,
}: {
  onGotowe: (m: Messenger) => void;
  onBlad: (e: unknown) => void;
}) {
  const [pracuje, setPracuje] = useState(false);

  if (!isPasskeySupported()) return null;

  return (
    <button
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
      {pracuje ? "Loguję…" : "Zaloguj passkeyem · Passkey"}
    </button>
  );
}
