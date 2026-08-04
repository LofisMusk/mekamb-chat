import { useCallback, useEffect, useMemo, useRef, useState } from "react";

import { api } from "./lib/api";
import { confirmRegistration, loginStart, loginWithTotp, register } from "./lib/auth";
import { KodQr } from "./KodQr";
import { OdbierzTutaj, PrzeniesStad } from "./Przeniesienie";
import { type Wiadomosc, wczytajRozmowe, zapiszRozmowe } from "./lib/historia";
import { type LicznikProb, poNiepowodzeniu, poSukcesie } from "./lib/koperty";
import { type StanPolaczenia, polaczZeSkrzynka } from "./lib/polaczenie";
import type { LoginSession } from "./lib/auth";
import { Call } from "./lib/calls";
import type { CallState } from "./lib/calls";
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
  | { nazwa: "odbior-przeniesienia" }
  | { nazwa: "drugi-skladnik"; username: string; sesja: LoginSession }
  | { nazwa: "czat"; messenger: Messenger };

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
  const [sygnalRozmowy, setSygnalRozmowy] = useState<SygnalRozmowy | null>(null);
  const [stanSieci, setStanSieci] = useState<StanPolaczenia>("laczenie");
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
    void zapiszRozmowe(groupId, wiadomosci).catch((err) => {
      console.warn("nie udało się zapisać historii", err);
    });
  }, [groupId, wiadomosci]);

  return (
    <section className="czat">
      <div className="pasek">
        {/* Stan połączenia jest tu istotny, nie ozdobny: przy zerwanej sieci
            wiadomości nie przychodzą, a użytkownik ma prawo wiedzieć dlaczego. */}
        <span className="tryb" title="Przeglądarka nie potrafi łączyć się bezpośrednio">
          {stanSieci === "polaczone" && "przez serwer"}
          {stanSieci === "laczenie" && "łączę…"}
          {stanSieci === "rozlaczone" && "brak połączenia — ponawiam"}
        </span>
        <PrzeniesStad token={messenger.accessToken} onBlad={onBlad} />
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

      {groupId && <Uczestnicy messenger={messenger} groupId={groupId} onBlad={onBlad} />}

      {groupId && (
        <Rozmowa
          messenger={messenger}
          groupId={groupId}
          sygnal={sygnalRozmowy}
          onBlad={onBlad}
        />
      )}

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
                const { stripped } = await messenger.sendFile(groupId, plik);

                // Gdy czyszczenie się nie powiodło, mówimy o tym wprost.
                // Milczenie byłoby wprowadzaniem w błąd: użytkownik ma prawo
                // wiedzieć, że akurat ten plik poszedł z metadanymi.
                const opis = stripped
                  ? `wysłano: ${plik.name}`
                  : `wysłano: ${plik.name} — nie udało się usunąć metadanych`;

                setWiadomosci((p) => [
                  ...p,
                  {
                    id: crypto.randomUUID(),
                    autor: "Ty",
                    tresc: opis,
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
            try {
              await messenger.sendText(groupId, tresc);
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
