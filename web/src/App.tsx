import { useCallback, useEffect, useRef, useState } from "react";

import { api } from "./lib/api";
import { confirmRegistration, loginStart, loginWithTotp, register } from "./lib/auth";
import type { LoginSession } from "./lib/auth";
import { Messenger } from "./lib/messenger";
import type { ReceivedAttachment, ReceivedMessage } from "./lib/messenger";
import {
  isInstalled,
  isPersistent,
  loadAccount,
  requestPersistence,
  saveAccount,
  wipe,
} from "./lib/vault";

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

interface Wiadomosc {
  id: string;
  autor: string;
  tresc: string;
  czas: number;
  wlasna: boolean;
  zalacznik?: ReceivedAttachment;
}

export function App() {
  const [ekran, setEkran] = useState<Ekran>({ nazwa: "ladowanie" });
  const [blad, setBlad] = useState<string | null>(null);
  const [trwaly, setTrwaly] = useState(true);

  useEffect(() => {
    void (async () => {
      setTrwaly(await isPersistent());

      const konto = await loadAccount();
      // Token żyje krócej niż tożsamość urządzenia, więc po jego wygaśnięciu
      // trzeba przejść logowanie od nowa — klucze i historia zostają na miejscu.
      setEkran(konto ? { nazwa: "logowanie" } : { nazwa: "powitanie" });
    })();
  }, []);

  const zglosBlad = (e: unknown) => setBlad(e instanceof Error ? e.message : String(e));

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

      {ekran.nazwa === "ladowanie" && <p>Wczytywanie…</p>}

      {ekran.nazwa === "powitanie" && (
        <div className="karta">
          <button className="glowny" onClick={() => setEkran({ nazwa: "rejestracja" })}>
            Załóż konto
          </button>
          <button onClick={() => setEkran({ nazwa: "logowanie" })}>Mam już konto</button>
        </div>
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
        <FormularzLogowania
          onBlad={zglosBlad}
          onGotowe={(username, sesja) =>
            setEkran({ nazwa: "drugi-skladnik", username, sesja })
          }
        />
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
      <p>Dodaj ten sekret w aplikacji authenticator:</p>
      <code className="sekret">{totpSecret}</code>
      <p className="wskazowka">
        <a href={otpauthUri}>Otwórz w aplikacji authenticator</a>
      </p>
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

          // Trwały magazyn zapewniamy PRZED wygenerowaniem kluczy. Odwrotna
          // kolejność grozi cichą utratą konta na iOS.
          await requestPersistence();

          // Konto istniejące odtwarzamy razem z jego wcześniejszym deviceId —
          // nowy identyfikator przy każdym logowaniu zostawiałby w katalogu
          // stos martwych urządzeń, do których nikt się nie dodzwoni.
          const zapisane = await loadAccount();
          const konto = zapisane ?? { userId: username, username, deviceId };
          await saveAccount(konto);

          const messenger =
            (await Messenger.restore(konto, token)) ?? (await Messenger.create(konto, token));

          // Kolejność jest istotna: key packages mają klucz obcy do urządzenia,
          // więc katalog musi je poznać najpierw.
          await messenger.registerDevice();
          await messenger.publishKeyPackages();

          onGotowe(messenger);
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

function Czat({ messenger, onBlad }: { messenger: Messenger; onBlad: (e: unknown) => void }) {
  const [wiadomosci, setWiadomosci] = useState<Wiadomosc[]>([]);
  const [tresc, setTresc] = useState("");
  const [rozmowca, setRozmowca] = useState("");
  const [groupId, setGroupId] = useState<Uint8Array | null>(null);
  const gniazdo = useRef<WebSocket | null>(null);

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

  useEffect(() => {
    const socket = api.connectInbox(messenger.account.userId);
    gniazdo.current = socket;

    socket.onmessage = async (event) => {
      const ramka = new Uint8Array(event.data as ArrayBuffer);

      // Pierwsze osiem bajtów to identyfikator wpisu w kolejce serwera.
      const id = new DataView(ramka.buffer, ramka.byteOffset, 8).getBigUint64(0);
      const koperta = ramka.subarray(8);

      try {
        const odebrana = await messenger.handleEnvelope(koperta);

        // Potwierdzamy DOPIERO po przetworzeniu i zapisaniu stanu. Wcześniejsze
        // potwierdzenie kasowałoby kopertę, której jeszcze nie umiemy odtworzyć
        // po odświeżeniu strony — czyli gubiłoby wiadomość bezpowrotnie.
        socket.send(`ack:${id}`);

        if (odebrana) {
          dodaj(odebrana);
          if (!groupId) setGroupId(odebrana.groupId);
        }
      } catch (err) {
        // Bez potwierdzenia koperta zostaje w kolejce i wróci przy następnym
        // połączeniu — błąd przetwarzania nie może kasować danych.
        onBlad(err);
      }
    };

    return () => socket.close();
  }, [messenger, dodaj, onBlad, groupId]);

  return (
    <section className="czat">
      <div className="pasek">
        <span className="tryb" title="Przeglądarka nie potrafi łączyć się bezpośrednio">
          przez serwer
        </span>
        <button
          className="wyloguj"
          onClick={async () => {
            if (confirm("Usunąć konto z tego urządzenia? Historii nie da się odzyskać.")) {
              await wipe();
              location.reload();
            }
          }}
        >
          Usuń z urządzenia
        </button>
      </div>

      {!groupId && (
        <form
          className="karta"
          onSubmit={async (e) => {
            e.preventDefault();
            try {
              setGroupId(await messenger.startConversation(rozmowca));
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

              try {
                await messenger.sendFile(groupId, plik, [rozmowca]);
                setWiadomosci((p) => [
                  ...p,
                  {
                    id: crypto.randomUUID(),
                    autor: "Ty",
                    tresc: `wysłano: ${plik.name}`,
                    czas: Date.now(),
                    wlasna: true,
                  },
                ]);
              } catch (err) {
                onBlad(err);
              }
            }}
          />
          Dołącz zdjęcie lub wideo
        </label>
      )}

      {groupId && (
        <form
          className="pisanie"
          onSubmit={async (e) => {
            e.preventDefault();
            if (!tresc.trim()) return;
            try {
              await messenger.sendText(groupId, tresc, [rozmowca]);
              setWiadomosci((p) => [
                ...p,
                {
                  id: crypto.randomUUID(),
                  autor: "Ty",
                  tresc,
                  czas: Date.now(),
                  wlasna: true,
                },
              ]);
              setTresc("");
            } catch (err) {
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
    </section>
  );
}

/**
 * Odszyfrowany załącznik.
 *
 * Deszyfrowanie odkładamy do momentu wyświetlenia: przy wielu plikach w oknie
 * jednoczesne trzymanie wszystkich w pamięci szybko wyczerpałoby ją na telefonie.
 */
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

  useEffect(() => {
    // Adres `blob:` wskazuje na odszyfrowane dane w pamięci karty. Bez
    // zwolnienia zostaje tam do jej zamknięcia.
    return () => {
      if (url) URL.revokeObjectURL(url);
    };
  }, [url]);

  const rozmiarMb = (zalacznik.sizeBytes / 1024 / 1024).toFixed(1);
  const obraz = zalacznik.mimeType.startsWith("image/");
  const wideo = zalacznik.mimeType.startsWith("video/");

  if (!url) {
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
  if (wideo) return <video className="zalacznik" src={url} controls />;

  return (
    <a className="zalacznik-pobierz" href={url} download={zalacznik.fileName ?? "zalacznik"}>
      Pobierz {zalacznik.fileName ?? "plik"}
    </a>
  );
}
