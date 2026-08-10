import { useCallback, useEffect, useMemo, useRef, useState } from "react";

import { api } from "./lib/api";
import {
  confirmRegistration,
  loginStart,
  loginWithTotp,
  logout,
  refreshSession,
  register,
  webauthnLoginOptions,
  webauthnLoginVerify,
  webauthnRegisterOptions,
  webauthnRegisterVerify,
} from "./lib/auth";
import { KodQr } from "./KodQr";
import { createPasskey, getPasskey, isPasskeySupported } from "./lib/passkey";
import { OdbierzTutaj, PrzeniesStad } from "./Przeniesienie";
import {
  type PozycjaListy,
  type Wiadomosc,
  kluczRozmowy,
  listaRozmow,
  oznaczPrzeczytane,
  wczytajRozmowe,
  zapiszRozmowe,
} from "./lib/historia";
import { type LicznikProb, poNiepowodzeniu, poSukcesie } from "./lib/koperty";
import { opisBledu, ustalRozruch } from "./lib/rozruch";
import { nazwaRozmowy, znajdzRozmowe1na1 } from "./lib/rozmowy";
import { useWstecz } from "./lib/nawigacja";
import { type StanPolaczenia, polaczZeSkrzynka } from "./lib/polaczenie";
import type { LoginSession } from "./lib/auth";
import { Call } from "./lib/calls";
import type { CallState } from "./lib/calls";
import { Messenger } from "./lib/messenger";
import type { ReceivedAttachment, ReceivedMessage } from "./lib/messenger";
import {
  type Account,
  isInstalled,
  isPersistent,
  kontoZLogowania,
  loadAccount,
  requestPersistence,
  saveAccount,
  wipe,
} from "./lib/vault";

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

export function App() {
  const [ekran, setEkran] = useState<Ekran>({ nazwa: "ladowanie" });
  const [blad, setBlad] = useState<string | null>(null);
  const [trwaly, setTrwaly] = useState(true);

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
      // odświeżającym (`/auth/refresh`) przeżywa odświeżenie strony. Dopiero
      // gdy go nie ma albo wygasł, wracamy do pełnego logowania hasłem+TOTP.
      //
      // Decyzja i obsługa awarii siedzą w `ustalRozruch`, bo ekran
      // „Wczytywanie…" nie ma wyjścia awaryjnego — patrz `rozruch.ts`.
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
      // Wcześniej ratowało nas to, że każde uruchomienie wymuszało logowanie.
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
   * strzałki, gestu i systemowego „wstecz" — patrz `nawigacja.ts`. Rozbicie
   * tego na osobne obsługi kończy się tym, że przycisk systemowy wyrzuca
   * z aplikacji zamiast wrócić o krok.
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

  return (
    <main className="aplikacja">
      <header>
        <h1>mekamb-chat</h1>
        <p className="podtytul">Szyfrowanie end-to-end. Serwer nie widzi treści.</p>
      </header>

      {!trwaly && <OstrzezenieOTrwalosci onOdswiez={() => void isPersistent().then(setTrwaly)} />}
      {blad && (
        <p className="blad" role="alert">
          {blad}
          <button onClick={() => setBlad(null)}>×</button>
        </p>
      )}

      {wEkranieZPowrotem && (
        <header className="pasek-ekranu">
          <button className="wstecz" aria-label="Wróć" onClick={() => history.back()}>
            ←
          </button>
        </header>
      )}

      {ekran.nazwa === "ladowanie" && <p>Wczytywanie…</p>}

      {ekran.nazwa === "powitanie" && (
        <div className="karta">
          <button className="glowny" onClick={() => setEkran({ nazwa: "rejestracja" })}>
            Załóż konto
          </button>
          <button onClick={() => setEkran({ nazwa: "logowanie" })}>Mam już konto</button>
          <PrzyciskPasskey
            onBlad={zglosBlad}
            onGotowe={(messenger) => setEkran({ nazwa: "czat", messenger })}
          />
          <button onClick={() => setEkran({ nazwa: "odbior-przeniesienia" })}>
            Przenoszę konto z innego urządzenia
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
          onGotowe={(username, wynik) =>
            setEkran({ nazwa: "potwierdzenie", username, ...wynik })
          }
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
            onGotowe={(username, sesja) =>
              setEkran({ nazwa: "drugi-skladnik", username, sesja })
            }
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
              Nie mam jeszcze konta
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

      {ekran.nazwa === "czat" && <Czat messenger={ekran.messenger} onBlad={zglosBlad} />}
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
      <strong>Twoje dane mogą zostać skasowane przez system.</strong>
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
          Zabezpiecz dane na tym urządzeniu
        </button>
      )}
    </section>
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
      <h2>Nowe konto</h2>
      <label>
        Nazwa użytkownika
        <input value={username} onChange={(e) => setUsername(e.target.value)} required minLength={3} />
      </label>
      <label>
        Hasło
        <input
          type="password"
          value={haslo}
          onChange={(e) => setHaslo(e.target.value)}
          required
          minLength={12}
        />
      </label>
      <p className="wskazowka">
        Hasło nie opuszcza tego urządzenia. Serwer nigdy go nie zobaczy — ale też nie pomoże Ci go
        odzyskać.
      </p>
      <button className="glowny" disabled={pracuje}>
        {pracuje ? "Zakładam…" : "Załóż konto"}
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
      <h2>Drugi składnik</h2>
      <p>Zeskanuj kod aplikacją authenticator:</p>

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
        Kod z aplikacji
        <input value={kod} onChange={(e) => setKod(e.target.value)} inputMode="numeric" required />
      </label>
      <button className="glowny">Potwierdź</button>
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
      <h2>Logowanie</h2>
      <label>
        Nazwa użytkownika
        <input value={username} onChange={(e) => setUsername(e.target.value)} required />
      </label>
      <label>
        Hasło
        <input type="password" value={haslo} onChange={(e) => setHaslo(e.target.value)} required />
      </label>
      <button className="glowny" disabled={pracuje}>
        {pracuje ? "Sprawdzam…" : "Dalej"}
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
      <h2>Kod z authenticatora</h2>
      <label>
        Kod
        <input value={kod} onChange={(e) => setKod(e.target.value)} inputMode="numeric" required />
      </label>
      <button className="glowny">Zaloguj</button>
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
          // skrzynki i tożsamością w MLS jest nazwa użytkownika. Uzasadnienie
          // przy `kontoZLogowania`.
          const konto = zapisane ?? kontoZLogowania(wynik.username, deviceId);

          onGotowe(await zakonczLogowanie(konto, wynik.token));
        } catch (err) {
          onBlad(err);
        } finally {
          setPracuje(false);
        }
      }}
    >
      {pracuje ? "Loguję…" : "Zaloguj passkeyem"}
    </button>
  );
}

function Czat({ messenger, onBlad }: { messenger: Messenger; onBlad: (e: unknown) => void }) {
  const [wiadomosci, setWiadomosci] = useState<Wiadomosc[]>([]);
  const [tresc, setTresc] = useState("");
  const [rozmowca, setRozmowca] = useState("");
  const [groupId, setGroupId] = useState<Uint8Array | null>(null);
  const [sygnalRozmowy, setSygnalRozmowy] = useState<SygnalRozmowy | null>(null);
  const [stanSieci, setStanSieci] = useState<StanPolaczenia>("laczenie");
  const [galaz, setGalaz] = useState<"rozmowy" | "kontakty" | "konto">("rozmowy");
  const [rozmowy, setRozmowy] = useState<PozycjaListy[]>([]);
  /**
   * Wiadomości w locie — pokazane od razu, jeszcze przed potwierdzeniem.
   *
   * Osobno od historii, a nie z polem stanu w niej: wiadomość, której wysyłka
   * nie dobiegła końca przed zamknięciem karty, ma nieznany los. Zapisana
   * wyglądałaby na wysłaną, a nie wiemy tego — więc nie zapisujemy jej wcale.
   */
  const [wLocie, setWLocie] = useState<{ id: string; tresc: string; blad: boolean }[]>([]);
  const nieprzeczytane = rozmowy.reduce((suma, p) => suma + p.nieprzeczytane, 0);

  /*
   * Nazwa pozycji na liście, z naprawą wstecz.
   *
   * Rozmowy zapisane przed poprawką mają nazwę pustą, a wiersz bez imienia
   * i bez awatara nie mówi nic o tym, z kim się rozmawia. Skład z drzewa MLS
   * odtwarza ją bez pytania serwera o cokolwiek — a gdy i tego nie ma (grupa
   * spoza stanu MLS, np. po przeniesieniu konta), mówimy wprost, że nazwy nie
   * znamy, zamiast pokazywać pusty wiersz.
   */
  const nazwaPozycji = (pozycja: PozycjaListy): string => {
    if (pozycja.rozmowca) return pozycja.rozmowca;

    try {
      const z = nazwaRozmowy(messenger.memberUserIds(pozycja.groupId), messenger.account.userId);
      return z || "rozmowa bez nazwy";
    } catch {
      return "rozmowa bez nazwy";
    }
  };
  /**
   * Ile razy dana koperta odpadła przy przetwarzaniu.
   *
   * Potrzebne, bo koperta bez potwierdzenia wraca przy każdym połączeniu.
   * Bez licznika koperta, której nigdy nie da się przetworzyć — powtórzona
   * albo spreparowana — wracałaby w nieskończoność.
   */
  const nieudane = useRef<LicznikProb>(new Map());

  const dodaj = useCallback((odebrana: ReceivedMessage) => {
    setWiadomosci((poprzednie) => [
      ...poprzednie,
      {
        id: Array.from(odebrana.messageId, (b) => b.toString(16)).join(""),
        autor: odebrana.senderUserId,
        tresc: odebrana.text,
        czas: odebrana.sentAtMs,
        wlasna: false,
        zalacznik: odebrana.attachment,
      },
    ]);
  }, []);

  // Bieżący identyfikator rozmowy dla obsługi koperty. Przez referencję,
  // bo obsługa nie może zależeć od stanu — inaczej każda zmiana rozmowy
  // zrywałaby połączenie.
  const biezacaGrupa = useRef<Uint8Array | null>(null);
  biezacaGrupa.current = groupId;

  const obsluzKoperte = useCallback(
    async (ramkaBuf: ArrayBuffer, potwierdz: (id: bigint) => void) => {
      const ramka = new Uint8Array(ramkaBuf);

      // Pierwsze osiem bajtów to identyfikator wpisu w kolejce serwera.
      const id = new DataView(ramka.buffer, ramka.byteOffset, 8).getBigUint64(0);
      const koperta = ramka.subarray(8);

      try {
        const odebrana = await messenger.handleEnvelope(koperta);

        // Potwierdzamy DOPIERO po przetworzeniu i zapisaniu stanu. Wcześniejsze
        // potwierdzenie kasowałoby kopertę, której jeszcze nie umiemy odtworzyć
        // po odświeżeniu strony — czyli gubiłoby wiadomość bezpowrotnie.
        potwierdz(id);

        if (odebrana?.call) {
          // Sygnalizacja rozmowy nie jest wiadomością do wyświetlenia —
          // trafia do komponentu rozmowy.
          setSygnalRozmowy({ ...odebrana.call, nadawca: odebrana.senderUserId });
          if (!biezacaGrupa.current) setGroupId(odebrana.groupId);
        } else if (odebrana) {
          dodaj(odebrana);
          if (!biezacaGrupa.current) setGroupId(odebrana.groupId);
        }
        poSukcesie(nieudane.current, String(id));
      } catch (err) {
        // Nieudane przetworzenie koperty jest sytuacją SPODZIEWANĄ: powtórzenie
        // ze skrzynki, pakiet z nieaktualnej epoki, dane spreparowane przez
        // kogoś z sieci. Pokazywanie tego użytkownikowi jako błędu straszy go
        // czymś, na co nie ma wpływu i czego nie musi rozumieć.
        console.warn("koperta odrzucona przy przetwarzaniu", err);

        // Bez potwierdzenia koperta wraca przy każdym połączeniu. Po kilku
        // nieudanych próbach uznajemy ją za martwą i potwierdzamy, żeby nie
        // krążyła w nieskończoność — ale dopiero po kilku, bo koperta, która
        // wyprzedziła swój commit, może przejść za drugim razem.
        if (poNiepowodzeniu(nieudane.current, String(id)).rodzaj === "odrzuc") {
          potwierdz(id);
        }
      }
    },
    [messenger, dodaj],
  );

  // Połączenie zależy WYŁĄCZNIE od konta. Wcześniej wisiało na `groupId`
  // i na niememoizowanej funkcji błędu, więc każde przerysowanie zrywało je
  // i otwierało nowe.
  useEffect(() => {
    const polaczenie = polaczZeSkrzynka({
      otworz: () => api.connectInbox(messenger.account.userId),
      naRamke: (ramka, potwierdz) => void obsluzKoperte(ramka, potwierdz),
      naStan: setStanSieci,
    });

    return () => polaczenie.zamknij();
  }, [messenger, obsluzKoperte]);

  /*
   * Oznaczanie przeczytanego.
   *
   * Warunkiem jest OTWARTA rozmowa, nie samo dotarcie wiadomości: licznik ma
   * mówić „nie widziałeś tego", a nie „nie dostałeś tego". Wiadomość, która
   * przyszła do rozmowy oglądanej w innej gałęzi, zostaje nieprzeczytana.
   */
  useEffect(() => {
    if (!groupId || galaz !== "rozmowy" || wiadomosci.length === 0) return;

    const najnowsza = Math.max(...wiadomosci.map((w) => w.czas));
    void oznaczPrzeczytane(groupId, najnowsza)
      .then(() => listaRozmow())
      .then(setRozmowy)
      .catch(() => {
        // Nieudany zapis znacznika nie może wywrócić rozmowy — najwyżej
        // licznik pokaże za dużo, co jest mniejszą szkodą niż pusty ekran.
      });
  }, [groupId, galaz, wiadomosci]);

  // Rozmowy z poprzednich uruchomień — bez tego lista byłaby pusta mimo
  // zapisanej historii.
  useEffect(() => {
    void listaRozmow().then(setRozmowy);
  }, []);

  /*
   * Nazwa rozmowy pochodzi z drzewa MLS, nie ze stanu interfejsu.
   *
   * Wcześniej brała się z tego, co użytkownik wpisał w Kontaktach albo
   * kliknął na liście. Rozmowa założona przez KOGOŚ INNEGO nie przechodzi
   * przez żadne z tych miejsc, więc zapisywała się bez nazwy — na liście
   * pojawiał się wiersz bez imienia i bez awatara. Gorszy wariant: zostawała
   * nazwa poprzednio otwartej rozmowy, więc wiadomości od jednej osoby
   * podpisywały się drugą.
   */
  useEffect(() => {
    if (!groupId) return;

    try {
      const nazwa = nazwaRozmowy(messenger.memberUserIds(groupId), messenger.account.userId);
      // Pusto znaczy „zostaliśmy sami" — wtedy stara nazwa jest lepsza niż żadna.
      if (nazwa) setRozmowca(nazwa);
    } catch {
      // Grupa spoza stanu MLS zostaje z nazwą zapisaną na dysku.
    }
  }, [groupId, messenger]);

  // Historia rozmowy z dysku. Bez tego odświeżenie strony kasowało rozmowę,
  // a odświeżenie było jedynym ratunkiem na zerwane połączenie.
  useEffect(() => {
    if (!groupId) return;
    let aktualne = true;

    void wczytajRozmowe(groupId).then((zapisane) => {
      if (!aktualne || zapisane.length === 0) return;

      // Scalamy z tym, co przyszło w międzyczasie — koperta mogła dotrzeć,
      // zanim odczyt z dysku się skończył.
      setWiadomosci((biezace) => {
        const znane = new Set(biezace.map((w) => w.id));
        return [...zapisane.filter((w) => !znane.has(w.id)), ...biezace].sort(
          (a, b) => a.czas - b.czas,
        );
      });
    });

    return () => {
      aktualne = false;
    };
  }, [groupId]);

  // Zapis po każdej zmianie. Zapisujemy całą rozmowę, bo leży w jednym
  // zaszyfrowanym rekordzie — dopisywanie po jednej wiadomości i tak
  // wymagałoby odczytania oraz przepisania całości.
  useEffect(() => {
    if (!groupId || wiadomosci.length === 0) return;
    void zapiszRozmowe(groupId, rozmowca, wiadomosci)
      // Lista czyta z dysku, więc odświeżamy ją po zapisie, a nie przed.
      .then(() => listaRozmow())
      .then(setRozmowy)
      .catch((err) => {
        console.warn("nie udało się zapisać historii", err);
      });
  }, [groupId, rozmowca, wiadomosci]);

  /*
   * Otwarta rozmowa jest osobnym ekranem, nie doklejką pod listą.
   *
   * Klasa na układzie mówi arkuszowi stylów, że na wąskim ekranie ma pokazać
   * sam wątek. Wyjście z niego idzie przez historię przeglądarki, więc
   * strzałka, gest i systemowe „wstecz" robią dokładnie to samo — patrz
   * `nawigacja.ts`.
   */
  useWstecz(
    galaz === "rozmowy" && groupId !== null,
    () => setGroupId(null),
    groupId ? kluczRozmowy(groupId) : "",
  );

  return (
    <div className={groupId && galaz === "rozmowy" ? "uklad rozmowa-otwarta" : "uklad"}>
      <nav className="sidebar" aria-label="Nawigacja">
        <div className="marka">
          <span className="marka-znak" aria-hidden="true" />
          <span>mekamb</span>
        </div>

        <button
          className={galaz === "rozmowy" ? "galaz aktywna" : "galaz"}
          onClick={() => setGalaz("rozmowy")}
        >
          Rozmowy
          {nieprzeczytane > 0 && <span className="znacznik">{nieprzeczytane}</span>}
        </button>
        <button
          className={galaz === "kontakty" ? "galaz aktywna" : "galaz"}
          onClick={() => setGalaz("kontakty")}
        >
          Kontakty
        </button>
        <button
          className={galaz === "konto" ? "galaz aktywna" : "galaz"}
          onClick={() => setGalaz("konto")}
        >
          Konto
        </button>

        {/* Stan połączenia jest tu istotny, nie ozdobny: przy zerwanej sieci
            wiadomości nie przychodzą, a użytkownik ma prawo wiedzieć dlaczego. */}
        <span className="tryb" title="Przeglądarka nie potrafi łączyć się bezpośrednio">
          {stanSieci === "polaczone" && "przez serwer"}
          {stanSieci === "laczenie" && "łączę…"}
          {stanSieci === "rozlaczone" && "brak połączenia — ponawiam"}
        </span>
      </nav>

      {galaz === "rozmowy" && (
        <aside className="panel-listy" aria-label="Lista rozmów">
          <h2>Rozmowy</h2>
          {rozmowy.length === 0 ? (
            <div className="karta">
              <p>Nie masz jeszcze żadnej rozmowy.</p>
              <p className="wskazowka">
                Zacznij od kontaktu — wystarczy nazwa użytkownika.
                </p>
              </div>
            ) : (
              <ul className="lista-rozmow">
                {rozmowy.map((pozycja) => (
                  <li key={kluczRozmowy(pozycja.groupId)}>
                    <button
                      className="wiersz-rozmowy"
                      onClick={() => {
                        setGroupId(pozycja.groupId);
                        setRozmowca(nazwaPozycji(pozycja));
                      }}
                    >
                      <span className="awatar" aria-hidden="true">
                        {nazwaPozycji(pozycja).slice(0, 1).toUpperCase()}
                      </span>
                      <span className="wiersz-tresc">
                        <span className="wiersz-nazwa">{nazwaPozycji(pozycja)}</span>
                        <span className="wiersz-ostatnia">
                          {pozycja.ostatnia
                            ? (pozycja.ostatnia.wlasna ? "Ty: " : "") + pozycja.ostatnia.tresc
                            : "brak wiadomości"}
                        </span>
                      </span>
                      {pozycja.nieprzeczytane > 0 && (
                        <span className="znacznik">{pozycja.nieprzeczytane}</span>
                      )}
                    </button>
                  </li>
                ))}
              </ul>
            )}
          <p className="wskazowka">Historia jest tylko na tym urządzeniu — serwer jej nie ma.</p>
        </aside>
      )}

      <section className="ekran">
        {galaz === "rozmowy" && !groupId && (
          <p className="pusty-watek">Wybierz rozmowę albo zacznij nową w Kontaktach.</p>
        )}

        {galaz === "rozmowy" && groupId && (
          <div className="watek">
            {/*
              Pasek rozmowy: strzałka wstecz i z kim się rozmawia.

              Na wąskim ekranie rozmowa zajmuje cały widok, więc bez tego nie
              było jak wrócić do listy — wcześniej wątek doklejał się POD listą
              i wyglądał, jakby pozycja się rozwinęła. Na szerokim lista stoi
              obok i strzałka jest zbędna, dlatego chowa ją arkusz stylów.
            */}
            <header className="pasek-watku">
              <button
                className="wstecz"
                aria-label="Wróć do listy rozmów"
                onClick={() => history.back()}
              >
                ←
              </button>
              <span className="pasek-nazwa">{rozmowca}</span>
            </header>

            {/* Rozmowa A/V nad wiadomościami, nie pod nimi: gdy trwa, jest
                najważniejszą rzeczą na ekranie. */}
            <Rozmowa
              messenger={messenger}
              groupId={groupId}
              sygnal={sygnalRozmowy}
              onBlad={onBlad}
            />

      <ol className="wiadomosci">
        {wiadomosci.map((w) => (
          <li key={w.id} className={w.wlasna ? "wlasna" : ""}>
            <span className="autor">{w.autor}</span>
            {w.zalacznik ? (
              <Zalacznik messenger={messenger} zalacznik={w.zalacznik} onBlad={onBlad} />
            ) : (
              <span className="tresc">{w.tresc}</span>
            )}
          </li>
        ))}

        {wLocie.map((w) => (
          <li key={w.id} className={w.blad ? "wlasna nieudana" : "wlasna w-locie"}>
            <span className="tresc">{w.tresc}</span>
            <span className="stan-wysylki">{w.blad ? "nie wysłano" : "wysyłam…"}</span>
          </li>
        ))}
      </ol>

      {groupId && (
        <label className="dolacz-plik">
          <input
            type="file"
            accept="image/*,video/*"
            onChange={async (e) => {
              const plik = e.target.files?.[0];
              // Czyścimy pole od razu, żeby dało się wysłać ten sam plik dwa razy.
              e.target.value = "";
              if (!plik) return;

              // Wgranie pliku trwa dłużej niż tekst — dochodzi czyszczenie
              // metadanych, szyfrowanie i wysyłka. Bez znacznika wygląda to
              // jak zawieszenie.
              const id = crypto.randomUUID();
              setWLocie((p) => [...p, { id, tresc: `wysyłam: ${plik.name}`, blad: false }]);

              try {
                const { stripped } = await messenger.sendFile(groupId, plik);

                // Gdy czyszczenie się nie powiodło, mówimy o tym wprost.
                // Milczenie byłoby wprowadzaniem w błąd: użytkownik ma prawo
                // wiedzieć, że akurat ten plik poszedł z metadanymi.
                const opis = stripped
                  ? `wysłano: ${plik.name}`
                  : `wysłano: ${plik.name} — nie udało się usunąć metadanych`;

                setWiadomosci((p) => [
                  ...p,
                  { id, autor: "Ty", tresc: opis, czas: Date.now(), wlasna: true },
                ]);
                setWLocie((p) => p.filter((w) => w.id !== id));
              } catch (err) {
                setWLocie((p) =>
                  p.map((w) => (w.id === id ? { ...w, tresc: plik.name, blad: true } : w)),
                );
                onBlad(err);
              }
            }}
          />
          Dołącz zdjęcie lub wideo
          <span className="wskazowka-plik">
            Ze zdjęć i nagrań usuwamy lokalizację oraz dane urządzenia
          </span>
        </label>
      )}

      {groupId && (
        <form
          className="pisanie"
          onSubmit={async (e) => {
            e.preventDefault();
            if (!tresc.trim()) return;

            // Wiadomość pojawia się natychmiast ze znacznikiem „wysyłam".
            // Wcześniej przez cały czas wysyłki — a przy nieudanej próbie
            // bezpośredniej to kilka sekund — nie działo się nic i nie było
            // wiadomo, czy cokolwiek poszło.
            const id = crypto.randomUUID();
            const wyslana = tresc;
            setWLocie((p) => [...p, { id, tresc: wyslana, blad: false }]);
            setTresc("");

            try {
              await messenger.sendText(groupId, wyslana);

              setWiadomosci((p) => [
                ...p,
                { id, autor: "Ty", tresc: wyslana, czas: Date.now(), wlasna: true },
              ]);
              setWLocie((p) => p.filter((w) => w.id !== id));
            } catch (err) {
              // Zostaje w locie, oznaczona jako nieudana. Treść nie przepada:
              // zawiodła sieć, nie użytkownik.
              setWLocie((p) => p.map((w) => (w.id === id ? { ...w, blad: true } : w)));
              onBlad(err);
            }
          }}
        >
          <input
            value={tresc}
            onChange={(e) => setTresc(e.target.value)}
            placeholder="Napisz wiadomość"
          />
          <button className="glowny">Wyślij</button>
        </form>
      )}
          </div>
        )}

        {galaz === "kontakty" && (
          <>
            <h2>Kontakty</h2>
            {true && (
        <form
          className="karta"
          onSubmit={async (e) => {
            e.preventDefault();
            try {
              const nazwa = rozmowca.trim();

              // Rozmowa z tą osobą mogła już powstać. Bez tego sprawdzenia
              // każde „rozpocznij rozmowę" zakładało nową grupę MLS, więc
              // lista puchła od duplikatów, a historia rozjeżdżała się między
              // nimi — patrz `rozmowy.ts`.
              const istniejaca = znajdzRozmowe1na1(
                rozmowy,
                (g) => messenger.memberUserIds(g),
                messenger.account.userId,
                nazwa,
              );

              if (istniejaca) {
                setGroupId(istniejaca.groupId);
                setGalaz("rozmowy");
                return;
              }

              setGroupId(await messenger.startConversation(nazwa));
              setGalaz("rozmowy");
            } catch (err) {
              onBlad(err);
            }
          }}
        >
          <label>
            Z kim rozmawiasz
            <input value={rozmowca} onChange={(e) => setRozmowca(e.target.value)} required />
          </label>
          <button className="glowny">Rozpocznij rozmowę</button>
        </form>
      )}

            {/* Katalog nie ma listy do przeglądania i to jest decyzja, nie brak:
                lista wszystkich użytkowników mówiłaby każdemu, kto jest
                w systemie. Rozmowę zaczyna się od nazwy, którą już się zna. */}
            <p className="wskazowka">
              Katalog przechowuje tylko nazwy, urządzenia i key packages.
              Kto z kim rozmawia — nie.
            </p>
          </>
        )}

        {galaz === "konto" && (
          <>
            <h2>Konto</h2>
            <div className="karta">
              <strong>{messenger.account.username}</strong>
              <span className="wskazowka">{messenger.account.deviceId}</span>
            </div>

            <PrzeniesStad token={messenger.accessToken} onBlad={onBlad} />

            <PasskeyZarzadzanie messenger={messenger} onBlad={onBlad} />

            <div className="karta">
              <strong>Klucze na tym urządzeniu</strong>
              <p className="wskazowka">
                Serwer nie ma czego wydać ani zgubić — ale też nie odtworzy niczego,
                gdy stracisz wszystkie urządzenia.
              </p>
            </div>

            <button
              className="rozlacz"
              onClick={async () => {
                if (confirm("Usunąć konto z tego urządzenia? Historii nie da się odzyskać.")) {
                  // Najlepszy wysiłek: nawet gdy się nie powiedzie (offline),
                  // lokalne skasowanie musi zajść — użytkownik prosił o nie
                  // dane na TYM urządzeniu, niezależnie od stanu sieci.
                  await logout(messenger.account.deviceId).catch(() => {});
                  await wipe();
                  location.reload();
                }
              }}
            >
              Usuń konto z tego urządzenia
            </button>
          </>
        )}
      </section>

      {galaz === "rozmowy" && groupId && (
        <aside className="inspektor" aria-label="Uczestnicy i kod bezpieczeństwa">
          <Uczestnicy messenger={messenger} groupId={groupId} onBlad={onBlad} />
        </aside>
      )}
    </div>
  );
}

/** Dodawanie passkeya do konta — punkt wejścia do rejestracji, nie logowania. */
function PasskeyZarzadzanie({
  messenger,
  onBlad,
}: {
  messenger: Messenger;
  onBlad: (e: unknown) => void;
}) {
  const [pracuje, setPracuje] = useState(false);
  const [zarejestrowano, setZarejestrowano] = useState(false);

  if (!isPasskeySupported()) return null;

  return (
    <div className="karta">
      <strong>Passkey</strong>
      <p className="wskazowka">
        Zaloguj się odciskiem palca, PIN-em albo kluczem sprzętowym — zamiast wpisywać hasło
        i kod za każdym razem.
      </p>
      <button
        disabled={pracuje || zarejestrowano}
        onClick={async () => {
          setPracuje(true);
          try {
            const opcje = await webauthnRegisterOptions(messenger.accessToken);
            const odpowiedz = await createPasskey(opcje);
            await webauthnRegisterVerify(messenger.accessToken, odpowiedz);
            setZarejestrowano(true);
          } catch (err) {
            onBlad(err);
          } finally {
            setPracuje(false);
          }
        }}
      >
        {zarejestrowano ? "Passkey dodany" : pracuje ? "Dodaję…" : "Dodaj passkey"}
      </button>
    </div>
  );
}

function Zalacznik({
  messenger,
  zalacznik,
  onBlad,
}: {
  messenger: Messenger;
  zalacznik: ReceivedAttachment;
  onBlad: (e: unknown) => void;
}) {
  const [url, setUrl] = useState<string | null>(null);
  const [pobiera, setPobiera] = useState(false);

  const obraz = zalacznik.mimeType.startsWith("image/");
  const wideo = zalacznik.mimeType.startsWith("video/");
  const media = obraz || wideo;

  /*
   * Zdjęcia i nagrania odszyfrowują się same.
   *
   * Wcześniej każde wymagało kliknięcia i wyglądało jak odnośnik do pliku —
   * a zdjęcie w rozmowie ma być zdjęciem, nie zadaniem do wykonania.
   * Deszyfrowanie dzieje się lokalnie, więc jedynym kosztem jest pobranie
   * szyfrogramu, które i tak nastąpiłoby po kliknięciu.
   *
   * Pozostałe pliki zostają za przyciskiem: dokumentu i tak nie ma jak pokazać
   * w wątku, a pobieranie ich w tle byłoby ruchem, o który nikt nie prosił.
   */
  useEffect(() => {
    if (!media) return;
    let aktualne = true;

    setPobiera(true);
    messenger
      .openAttachmentUrl(zalacznik)
      .then((adres) => {
        if (aktualne) setUrl(adres);
        // Karta mogła zniknąć w trakcie — wtedy zwalniamy od razu, bo
        // sprzątanie po odmontowanym komponencie już nie nastąpi.
        else URL.revokeObjectURL(adres);
      })
      .catch(onBlad)
      .finally(() => {
        if (aktualne) setPobiera(false);
      });

    return () => {
      aktualne = false;
    };
  }, [messenger, zalacznik, media, onBlad]);

  useEffect(() => {
    // Adres `blob:` wskazuje na odszyfrowane dane w pamięci karty. Bez
    // zwolnienia zostaje tam do jej zamknięcia.
    return () => {
      if (url) URL.revokeObjectURL(url);
    };
  }, [url]);

  const rozmiarMb = (zalacznik.sizeBytes / 1024 / 1024).toFixed(1);

  if (!url) {
    if (media) {
      return (
        <span className="zalacznik-czeka">
          {pobiera ? "Odszyfrowuję…" : "nie udało się odszyfrować"}
        </span>
      );
    }

    return (
      <button
        className="zalacznik-pobierz"
        disabled={pobiera}
        onClick={async () => {
          setPobiera(true);
          try {
            setUrl(await messenger.openAttachmentUrl(zalacznik));
          } catch (err) {
            onBlad(err);
          } finally {
            setPobiera(false);
          }
        }}
      >
        {pobiera ? "Odszyfrowuję…" : `${zalacznik.fileName ?? "załącznik"} · ${rozmiarMb} MB`}
      </button>
    );
  }

  if (obraz) return <img className="zalacznik" src={url} alt={zalacznik.fileName ?? "załącznik"} />;
  if (wideo) return <video className="zalacznik" src={url} controls playsInline />;

  return (
    <a className="zalacznik-pobierz" href={url} download={zalacznik.fileName ?? "zalacznik"}>
      Pobierz {zalacznik.fileName ?? "plik"}
    </a>
  );
}

/**
 * Lista uczestników i dodawanie kolejnych.
 *
 * Skład bierzemy z drzewa MLS, nie z własnej listy w interfejsie — to jedyne
 * miejsce, które wie, kto naprawdę jest w grupie po wszystkich commitach.
 * Własna lista rozjechałaby się przy pierwszej zmianie zrobionej przez kogoś
 * innego.
 */
function Uczestnicy({
  messenger,
  groupId,
  onBlad,
}: {
  messenger: Messenger;
  groupId: Uint8Array;
  onBlad: (e: unknown) => void;
}) {
  const [rozwiniete, setRozwiniete] = useState(false);
  const [nowy, setNowy] = useState("");
  const [dodaje, setDodaje] = useState(false);
  // Licznik wymusza odczytanie składu na nowo po każdej udanej zmianie.
  const [odswiezenie, setOdswiezenie] = useState(0);

  const osoby = useMemo(
    () => messenger.memberUserIds(groupId),
    // eslint-disable-next-line react-hooks/exhaustive-deps
    [messenger, groupId, odswiezenie],
  );

  return (
    <section className="uczestnicy">
      <button className="uczestnicy-naglowek" onClick={() => setRozwiniete((r) => !r)}>
        {osoby.length === 2 ? "Rozmowa prywatna" : `Grupa · ${osoby.length} osób`}
        {" "}
        <span className="wskazowka">{rozwiniete ? "▾" : "▸"}</span>
      </button>

      {rozwiniete && (
        <>
          <ul className="lista-osob">
            {osoby.map((osoba) => (
              <li key={osoba}>{osoba}</li>
            ))}
          </ul>

          <form
            className="dodaj-osobe"
            onSubmit={async (e) => {
              e.preventDefault();
              if (!nowy.trim()) return;

              setDodaje(true);
              try {
                await messenger.addMember(groupId, nowy.trim());
                setNowy("");
                setOdswiezenie((n) => n + 1);
              } catch (err) {
                onBlad(err);
              } finally {
                setDodaje(false);
              }
            }}
          >
            <input
              value={nowy}
              onChange={(e) => setNowy(e.target.value)}
              placeholder="Nazwa użytkownika"
            />
            <button disabled={dodaje}>{dodaje ? "Dodaję…" : "Dodaj"}</button>
          </form>

          <p className="wskazowka">
            Nowa osoba zobaczy wiadomości wysłane od momentu dołączenia. Wcześniejszych
            nie da się jej pokazać i jest to zamierzone.
          </p>

          <SafetyNumber messenger={messenger} groupId={groupId} odswiezenie={odswiezenie} />
        </>
      )}
    </section>
  );
}

/**
 * Kod bezpieczeństwa rozmowy.
 *
 * # Po co to jest widoczne
 *
 * Szyfrowanie chroni przed podsłuchem, ale nie przed serwerem, który podstawi
 * cudze urządzenie do rozmowy — wiadomości byłyby wtedy szyfrowane poprawnie,
 * tylko do niego. Ten kod liczy się wyłącznie z kluczy uczestników, więc
 * podmiana któregokolwiek go zmienia.
 *
 * Porównanie musi odbyć się **innym kanałem** niż ta aplikacja: na żywo,
 * telefonicznie, przez wideo. Porównanie przez sam komunikator nie ma sensu,
 * bo to dokładnie ten kanał, któremu nie ufamy.
 */
function SafetyNumber({
  messenger,
  groupId,
  odswiezenie,
}: {
  messenger: Messenger;
  groupId: Uint8Array;
  odswiezenie: number;
}) {
  const [pokazany, setPokazany] = useState(false);

  const kod = useMemo(
    () => {
      try {
        return messenger.safetyNumber(groupId);
      } catch {
        return null;
      }
    },
    // eslint-disable-next-line react-hooks/exhaustive-deps
    [messenger, groupId, odswiezenie],
  );

  if (!kod) return null;

  return (
    <section className="safety">
      <button className="safety-przelacz" onClick={() => setPokazany((p) => !p)}>
        {pokazany ? "Ukryj kod bezpieczeństwa" : "Pokaż kod bezpieczeństwa"}
      </button>

      {pokazany && (
        <>
          <code className="safety-kod">{kod}</code>
          <p className="wskazowka">
            Porównaj ten kod z rozmówcą <strong>innym kanałem</strong> — na żywo albo
            telefonicznie. Jeśli się zgadza, nikt nie podstawił się w środek rozmowy.
            Porównanie przez tę aplikację nic nie daje: to właśnie ten kanał sprawdzamy.
          </p>
          <p className="wskazowka">
            Kod zmienia się przy każdej zmianie składu rozmowy i przy dołączeniu nowego
            urządzenia — wtedy trzeba porównać go ponownie.
          </p>
        </>
      )}
    </section>
  );
}

/** Sygnalizacja odebrana kanałem MLS, przekazana do komponentu rozmowy. */
interface SygnalRozmowy {
  kind: string;
  callId: Uint8Array;
  payload: string;
  dtlsFingerprint: string;
  /** Adresat — w rozmowie mesh każda para negocjuje osobno. */
  target: string;
  nadawca: string;
}

/**
 * Rozmowa audio i wideo — dwuosobowa albo grupowa.
 *
 * # Co widzi użytkownik i dlaczego
 *
 * Przy każdym uczestniku pokazujemy **drogę połączenia**: „bezpośrednio" znaczy,
 * że media idą wprost — i że ta osoba zna wtedy Twój adres IP. „Przez
 * przekaźnik" znaczy, że adres widzi serwer TURN. Milczenie sugerowałoby,
 * że nie ujawnia się nic.
 *
 * Rozmowa grupowa to topologia mesh: każda para ma osobne połączenie i osobne
 * zaufanie. Zerwanie jednego przez niezgodny odcisk certyfikatu nie kończy
 * rozmowy z pozostałymi.
 */
function Rozmowa({
  messenger,
  groupId,
  sygnal,
  onBlad,
}: {
  messenger: Messenger;
  groupId: Uint8Array;
  sygnal: SygnalRozmowy | null;
  onBlad: (e: unknown) => void;
}) {
  const [call, setCall] = useState<Call | null>(null);
  const [stan, setStan] = useState<CallState | null>(null);
  const [przychodzace, setPrzychodzace] = useState<SygnalRozmowy | null>(null);
  const strumienie = useRef(new Map<string, MediaStream>());
  const [wersjaStrumieni, setWersjaStrumieni] = useState(0);

  const zapamietajStrumien = useCallback((username: string, stream: MediaStream) => {
    strumienie.current.set(username, stream);
    setWersjaStrumieni((n) => n + 1);
  }, []);

  useEffect(() => {
    if (!sygnal) return;

    // Oferta, gdy nie mamy jeszcze rozmowy — to zaproszenie przychodzące.
    if (sygnal.kind === "offer" && !call) {
      setPrzychodzace(sygnal);
      return;
    }

    void call
      ?.przyjmijSygnal(
        sygnal.nadawca,
        sygnal.kind,
        sygnal.callId,
        sygnal.payload,
        sygnal.dtlsFingerprint,
        sygnal.target,
      )
      .catch(onBlad);
  }, [sygnal, call, onBlad]);

  const zadzwon = async (wideo: boolean) => {
    try {
      setCall(
        await Call.rozpocznij(
          messenger,
          groupId,
          messenger.accessToken,
          wideo,
          setStan,
          zapamietajStrumien,
        ),
      );
    } catch (err) {
      onBlad(err);
    }
  };

  const odbierz = async (wideo: boolean) => {
    if (!przychodzace) return;
    const zaproszenie = przychodzace;
    setPrzychodzace(null);

    try {
      const nowa = await Call.odbierz(
        messenger,
        groupId,
        messenger.accessToken,
        zaproszenie.callId,
        wideo,
        setStan,
        zapamietajStrumien,
      );
      setCall(nowa);

      // Ofertę, która nas obudziła, trzeba przetworzyć po zestawieniu rozmowy.
      await nowa.przyjmijSygnal(
        zaproszenie.nadawca,
        zaproszenie.kind,
        zaproszenie.callId,
        zaproszenie.payload,
        zaproszenie.dtlsFingerprint,
        zaproszenie.target,
      );
    } catch (err) {
      // Najczęstsza przyczyna: odcisk certyfikatu nie zgadza się z tym,
      // który przyszedł zaszyfrowanym kanałem.
      onBlad(err);
    }
  };

  const rozlacz = () => {
    call?.zakoncz();
    setCall(null);
    setStan(null);
    strumienie.current.clear();
  };

  if (przychodzace) {
    return (
      <section className="rozmowa">
        <strong>Połączenie przychodzące od {przychodzace.nadawca}</strong>
        <div className="rozmowa-przyciski">
          <button className="glowny" onClick={() => void odbierz(false)}>
            Odbierz
          </button>
          <button onClick={() => void odbierz(true)}>Odbierz z obrazem</button>
          <button className="rozlacz" onClick={() => setPrzychodzace(null)}>
            Odrzuć
          </button>
        </div>
      </section>
    );
  }

  if (!call) {
    return (
      <section className="rozmowa">
        <div className="rozmowa-przyciski">
          <button onClick={() => void zadzwon(false)}>Zadzwoń</button>
          <button onClick={() => void zadzwon(true)}>Wideo</button>
        </div>
      </section>
    );
  }

  return (
    <section className="rozmowa">
      <div className="rozmowa-pasek">
        <span>{stan?.uczestnicy.length ?? 0} rozmówców</span>
        <button className="rozlacz" onClick={rozlacz}>
          Rozłącz
        </button>
      </div>

      <ul className="rozmowa-lista">
        {stan?.uczestnicy.map((uczestnik) => (
          <li key={uczestnik.username}>
            <span>{uczestnik.username}</span>
            <span className="tryb" title="Bezpośrednio: rozmówca zna Twój adres IP. Przez przekaźnik: zna go serwer TURN.">
              {uczestnik.odrzuconyOdcisk && "zerwane — obcy certyfikat"}
              {!uczestnik.odrzuconyOdcisk && uczestnik.faza === "laczenie" && "łączę…"}
              {!uczestnik.odrzuconyOdcisk &&
                uczestnik.faza === "trwa" &&
                (uczestnik.droga === "relay" ? "przez przekaźnik" : "bezpośrednio")}
              {!uczestnik.odrzuconyOdcisk && uczestnik.faza === "zakonczona" && "rozłączony"}
            </span>
          </li>
        ))}
      </ul>

      {call.wideo &&
        [...strumienie.current.entries()].map(([username, stream]) => (
          <WideoUczestnika key={`${username}-${wersjaStrumieni}`} stream={stream} />
        ))}

      {!call.wideo &&
        [...strumienie.current.entries()].map(([username, stream]) => (
          <AudioUczestnika key={`${username}-${wersjaStrumieni}`} stream={stream} />
        ))}
    </section>
  );
}

/** Obraz jednego uczestnika. */
function WideoUczestnika({ stream }: { stream: MediaStream }) {
  const ref = useRef<HTMLVideoElement | null>(null);

  useEffect(() => {
    if (ref.current) ref.current.srcObject = stream;
  }, [stream]);

  return <video ref={ref} autoPlay playsInline className="rozmowa-wideo" />;
}

/** Dźwięk jednego uczestnika — bez elementu nie byłoby go słychać. */
function AudioUczestnika({ stream }: { stream: MediaStream }) {
  const ref = useRef<HTMLAudioElement | null>(null);

  useEffect(() => {
    if (ref.current) ref.current.srcObject = stream;
  }, [stream]);

  return <audio ref={ref} autoPlay />;
}
