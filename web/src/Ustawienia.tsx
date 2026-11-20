import { type ReactNode, useEffect, useState } from "react";
import { toast } from "sonner";

import { Ikona } from "./Ikony";
import { KodQr } from "./KodQr";
import { Urzadzenia } from "./Parowanie";
import { WyborMotywuUI } from "./Wspolne";
import { ZglosBlad } from "./Zgloszenie";
import {
  AlertDialog,
  AlertDialogAction,
  AlertDialogCancel,
  AlertDialogContent,
  AlertDialogDescription,
  AlertDialogFooter,
  AlertDialogHeader,
  AlertDialogTitle,
  AlertDialogTrigger,
} from "./components/ui/alert-dialog";
import { Awatar } from "./components/ui/avatar";
import { Button } from "./components/ui/button";
import { Input } from "./components/ui/input";
import { Switch } from "./components/ui/switch";
import {
  logout,
  totpChangeConfirm,
  totpChangeOptions,
  totpChangeStartKodem,
  totpChangeStartPasskeyem,
  webauthnRegisterOptions,
  webauthnRegisterVerify,
} from "./lib/auth";
import { type WynikScalania, scalHistorie } from "./lib/historia";
import type { Messenger } from "./lib/messenger";
import { createPasskey, getPasskey, isPasskeySupported } from "./lib/passkey";
import { loadHistory, wipe } from "./lib/vault";
import { exportBackup, importBackup } from "./wasm/mekamb_wasm";

/**
 * Ustawienia — jedna kolumna kart, każda o jednej decyzji.
 *
 * # Dlaczego kolumna, a nie siatka
 *
 * Siatka kart różnej wysokości układała się w schodki: oko skakało między
 * kolumnami, a kolejność czytania zależała od szerokości okna. Kolumna
 * o czytelnej szerokości (~40 rem) ma jedną kolejność na każdym ekranie —
 * od tego, kim jesteś, do tego, jak stąd wyjść.
 */
export function Ustawienia({
  messenger,
  trwaly,
  odczyt,
  mojNick,
  onNick,
  zablokowani,
  nick,
  onOdblokuj,
  onOdczyt,
  onBlad,
}: {
  messenger: Messenger;
  trwaly: boolean;
  odczyt: boolean;
  mojNick: string;
  onNick: (nick: string) => void;
  zablokowani: Set<string>;
  nick: (username: string) => string;
  onOdblokuj: (username: string) => void;
  onOdczyt: (wlaczony: boolean) => void;
  onBlad: (e: unknown) => void;
}) {
  // Pole nicku trzymane lokalnie — zapisujemy dopiero, gdy pole traci fokus
  // albo na Enter, żeby nie rozsyłać metadany po każdym naciśnięciu klawisza.
  const [nickPole, setNickPole] = useState(mojNick);
  useEffect(() => setNickPole(mojNick), [mojNick]);

  const zapiszNick = () => {
    if (nickPole.trim() !== mojNick.trim()) onNick(nickPole);
  };

  return (
    <div className="min-h-0 flex-1 overflow-y-auto">
      <div className="mx-auto flex w-full max-w-[40rem] flex-col gap-4 px-[var(--margines-tresci)] pt-5 pb-10 md:pt-8">
        <header className="mb-1 flex flex-col gap-0.5">
          <h2 className="text-tytul">Ustawienia</h2>
          <span className="text-meta text-tekst-drugi">Konto, urządzenia i wygląd</span>
        </header>

        <div className="karta">
          <div className="flex items-center gap-3">
            <Awatar nazwa={mojNick || messenger.account.username} rozmiar="lg" />
            <span className="flex min-w-0 flex-col">
              <strong className="truncate text-tresc font-semibold">{messenger.account.username}</strong>
              <span className="truncate font-mono text-podpis text-tekst-drugi">
                {messenger.account.deviceId}
              </span>
            </span>
          </div>

          {/*
            Nazwa wyświetlana (nick) — WARSTWA WYŚWIETLANIA, nie tożsamość.
            Adresem skrzynki i tożsamością MLS zostaje nazwa użytkownika wyżej;
            nick to tylko to, jak widzą Cię inni w rozmowach. Zmiana rozsyła się
            współdzieloną metadaną do Twoich rozmów.
          */}
          <label>
            Nazwa wyświetlana
            <Input
              value={nickPole}
              onChange={(e) => setNickPole(e.target.value)}
              onBlur={zapiszNick}
              onKeyDown={(e) => {
                if (e.key === "Enter") {
                  e.preventDefault();
                  zapiszNick();
                  e.currentTarget.blur();
                }
              }}
              placeholder={messenger.account.username}
            />
          </label>
          <p className="wskazowka">
            Tak zobaczą Cię inni w rozmowach. Twoja nazwa użytkownika się nie zmienia — to po niej
            dochodzą wiadomości.
          </p>

          {/*
            Stan konta powiedziany po ludzku.

            Zostaje to, co daje się z czymś zrobić: czy rozmowy są bezpieczne na
            tym urządzeniu i czy w tej chwili cokolwiek dochodzi. Wiersz o pamięci
            pojawia się DOPIERO, gdy jest źle — napis „przyznany" przy działającej
            rzeczy nie mówi nic.
          */}
          <dl className="flex flex-col gap-2 border-t border-linia pt-3">
            {!trwaly && (
              <div className="flex items-center justify-between gap-3">
                <dt className="text-meta text-tekst-drugi">Pamięć</dt>
                <dd className="flex items-center gap-1.5 text-meta text-ostrzezenie">
                  <Ikona nazwa="ostrzezenie" rozmiar={13} />
                  przeglądarka może usunąć rozmowy
                </dd>
              </div>
            )}
          </dl>
        </div>

        <Sekcja tytul="Wygląd">
          <WyborMotywuUI zEtykietami />
        </Sekcja>

        {/*
          Potwierdzenia odczytu w ustawieniach, nie w rozmowie: to decyzja o tym,
          ile o sobie mówisz — dotyczy każdej rozmowy naraz.

          Z opisu zostało jedno zdanie: to, które zmienia decyzję. Reszta
          (opóźnienie, zbiorcza wysyłka) opisywała, JAK to zrobiliśmy.
        */}
        <Sekcja tytul="Prywatność">
          <label className="przelacznik flex cursor-pointer items-center justify-between gap-4">
            <span className="flex flex-col gap-0.5">
              <span className="text-tresc text-tekst">Wysyłaj potwierdzenia odczytu</span>
              <span className="text-meta text-tekst-drugi">
                Kiedy je wyłączysz, przestaniesz też widzieć cudze.
              </span>
            </span>
            <Switch checked={odczyt} onCheckedChange={onOdczyt} />
          </label>
        </Sekcja>

        {/*
          Zablokowani — jedyne miejsce, z którego da się ich odblokować.

          Blokada ukrywa rozmowę z tą osobą, więc panelu uczestników już się nie
          otworzy: gdyby odblokowanie było tylko tam, blokada byłaby pułapką bez
          wyjścia. Karta pojawia się dopiero, gdy jest kogo pokazać.
        */}
        {zablokowani.size > 0 && (
          <Sekcja
            tytul="Zablokowani"
            opis="Nie dostajesz od nich wiadomości ani zaproszeń. Odblokowanie przywraca rozmowy i wszystko, co przyszło w międzyczasie."
          >
            <ul className="flex flex-col gap-1">
              {[...zablokowani]
                .sort((a, b) => a.localeCompare(b))
                .map((osoba) => (
                  <li key={osoba} className="flex items-center gap-3">
                    <Awatar nazwa={nick(osoba)} rozmiar="sm" />
                    <span className="min-w-0 flex-1 truncate text-tresc">{nick(osoba)}</span>
                    <Button variant="ghost" size="sm" onClick={() => onOdblokuj(osoba)}>
                      Odblokuj
                    </Button>
                  </li>
                ))}
            </ul>
          </Sekcja>
        )}

        <Urzadzenia messenger={messenger} onBlad={onBlad} />

        <PasskeyZarzadzanie messenger={messenger} onBlad={onBlad} />

        <ZmianaAuthenticatora messenger={messenger} onBlad={onBlad} />

        <KopiaRozmow onBlad={onBlad} />

        <ZglosBlad token={messenger.accessToken} />

        {/*
          To zdanie ZOSTAJE i zostaje w całości.

          Nie jest opisem mechanizmu — jest jedyną informacją, przez którą ktoś
          może stracić wszystkie swoje rozmowy, jeśli jej nie przeczyta.
        */}
        <Sekcja tytul="Twoje rozmowy">
          <p className="wskazowka-ikona">
            <Ikona nazwa="klucz" rozmiar={14} />
            Są zapisane tylko na tym urządzeniu — nie mamy ich kopii i nie odtworzymy ich nikomu.
            Zanim zmienisz telefon, przenieś konto.
          </p>
        </Sekcja>

        {/*
          Kasowanie w osobnej strefie, na dole i za linią.

          Nieodwracalne obok odwracalnego to zaproszenie do pomyłki — a tej
          pomyłki nie da się cofnąć, bo historii nie ma nigdzie indziej.
        */}
        <section className="mt-4 flex flex-col items-start gap-2 border-t border-linia pt-6">
          <strong className="text-tresc font-semibold">Usunięcie konta z tego urządzenia</strong>
          <p className="wskazowka">Historii nie da się odzyskać — nigdzie jej nie zapisujemy.</p>

          <AlertDialog>
            <AlertDialogTrigger asChild>
              <Button variant="destructive" className="mt-1">
                <Ikona nazwa="wyloguj" rozmiar={16} />
                Usuń konto z tego urządzenia
              </Button>
            </AlertDialogTrigger>
            <AlertDialogContent>
              <AlertDialogHeader>
                <AlertDialogTitle>Usunąć konto z tego urządzenia?</AlertDialogTitle>
                <AlertDialogDescription>
                  Klucze i cała historia rozmów znikną z tej przeglądarki. Historii nie da się
                  odzyskać — nigdzie jej nie zapisujemy.
                </AlertDialogDescription>
              </AlertDialogHeader>
              <AlertDialogFooter>
                <AlertDialogCancel>Anuluj</AlertDialogCancel>
                <AlertDialogAction
                  onClick={async () => {
                    // Najlepszy wysiłek: nawet gdy się nie powiedzie (offline),
                    // lokalne skasowanie musi zajść — użytkownik prosił o usunięcie
                    // danych na TYM urządzeniu, niezależnie od stanu sieci.
                    await logout(messenger.account.deviceId).catch(() => {});
                    await wipe();
                    location.reload();
                  }}
                >
                  <Ikona nazwa="kosz" rozmiar={16} />
                  Usuń konto
                </AlertDialogAction>
              </AlertDialogFooter>
            </AlertDialogContent>
          </AlertDialog>
        </section>
      </div>
    </div>
  );
}

/** Karta ustawień z tytułem i opcjonalnym zdaniem pod nim. */
export function Sekcja({
  tytul,
  opis,
  children,
}: {
  tytul: string;
  opis?: ReactNode;
  children?: ReactNode;
}) {
  return (
    <section className="karta">
      <div className="flex flex-col gap-1">
        <h3 className="text-tresc font-semibold tracking-[-0.01em]">{tytul}</h3>
        {opis && <p className="wskazowka">{opis}</p>}
      </div>
      {children}
    </section>
  );
}

/**
 * Eksport i import rozmów do zaszyfrowanego pliku ZIP.
 *
 * # Dlaczego hasło, a nie zwykły plik
 *
 * Historia leży w skarbcu zaszyfrowana kluczem, który nie opuszcza urządzenia.
 * Plik ma dać się otworzyć gdzie indziej, więc chroni go jedyny sekret, który
 * zna człowiek: hasło. Cała ochrona to Argon2id i AES-256-GCM w rdzeniu
 * (`core/src/kopia.rs`) — ten sam kod i ten sam format co na Androidzie, więc
 * plik z telefonu otworzy się w przeglądarce i odwrotnie.
 *
 * # Dlaczego oddajemy klatkę przed liczeniem
 *
 * Argon2id liczy się **synchronicznie** w WASM i na chwilę zamraża wątek. Bez
 * `setTimeout(0)` napis „Pracuję…" nigdy by się nie narysował — przeskoczylibyśmy
 * od kliknięcia wprost do wyniku, a przy sekundzie ciszy wyglądałoby to na
 * zawieszenie.
 */
function KopiaRozmow({ onBlad }: { onBlad: (e: unknown) => void }) {
  const [hasloEksport, setHasloEksport] = useState("");
  const [hasloImport, setHasloImport] = useState("");
  const [plik, setPlik] = useState<File | null>(null);
  const [komunikat, setKomunikat] = useState<string | null>(null);
  const [pracuje, setPracuje] = useState(false);

  const eksportuj = async () => {
    if (!hasloEksport || pracuje) return;
    setPracuje(true);
    setKomunikat(null);
    try {
      await new Promise((r) => setTimeout(r, 0));
      const jawne = (await loadHistory()) ?? new Uint8Array(0);
      const zip = exportBackup(hasloEksport, jawne);

      // Pobranie pliku: obiektowy URL na Blobie i klik w ukryty link. Anchor
      // z `download` to jedyna droga, którą przeglądarka odda plik bez serwera.
      const url = URL.createObjectURL(new Blob([zip as BlobPart], { type: "application/zip" }));
      const a = document.createElement("a");
      a.href = url;
      a.download = "rozmowy-mekamb.zip";
      a.click();
      URL.revokeObjectURL(url);

      setHasloEksport("");
      toast.success("Wyeksportowano rozmowy do pliku.");
    } catch (e) {
      onBlad(e);
    } finally {
      setPracuje(false);
    }
  };

  const importuj = async () => {
    if (!plik || !hasloImport || pracuje) return;
    setPracuje(true);
    setKomunikat(null);
    try {
      await new Promise((r) => setTimeout(r, 0));
      const bajty = new Uint8Array(await plik.arrayBuffer());

      let jawne: Uint8Array;
      try {
        jawne = importBackup(hasloImport, bajty);
      } catch {
        // Złe hasło i uszkodzony plik dają ten sam komunikat: obie odpowiedzi
        // znaczą „tego pliku nie otworzysz tym hasłem".
        setKomunikat("Nie udało się zaimportować: złe hasło albo uszkodzony plik.");
        return;
      }

      const wynik: WynikScalania | null = await scalHistorie(jawne);
      if (wynik) {
        toast.success(`Zaimportowano: ${wynik.rozmow} rozmów, ${wynik.wiadomosci} nowych wiadomości.`);
        setHasloImport("");
        setPlik(null);
      } else {
        setKomunikat("Plik nie zawiera czytelnej historii.");
      }
    } catch (e) {
      onBlad(e);
    } finally {
      setPracuje(false);
    }
  };

  return (
    <Sekcja
      tytul="Kopia rozmów"
      opis="Wyeksportuj rozmowy do pliku ZIP chronionego hasłem albo wczytaj je z takiego pliku. Import dokłada rozmowy do istniejących, nie kasuje ich. Plik chroni wyłącznie hasło — zapomnianego nie da się obejść."
    >
      <div className="flex flex-col gap-2">
        <label>
          Hasło do eksportu
          <Input type="password" value={hasloEksport} onChange={(e) => setHasloEksport(e.target.value)} />
        </label>
        <Button variant="outline" disabled={!hasloEksport || pracuje} onClick={eksportuj} className="self-start">
          <Ikona nazwa="pobierz" rozmiar={16} />
          {pracuje ? "Pracuję…" : "Eksportuj rozmowy"}
        </Button>
      </div>

      <div className="flex flex-col gap-2 border-t border-linia pt-3">
        <label>
          Plik kopii
          <Input
            type="file"
            accept=".zip,application/zip"
            onChange={(e) => setPlik(e.target.files?.[0] ?? null)}
          />
        </label>
        <label>
          Hasło pliku
          <Input type="password" value={hasloImport} onChange={(e) => setHasloImport(e.target.value)} />
        </label>
        <Button
          variant="outline"
          disabled={!plik || !hasloImport || pracuje}
          onClick={importuj}
          className="self-start"
        >
          {pracuje ? "Pracuję…" : "Importuj rozmowy"}
        </Button>
      </div>

      {komunikat && <p className="wskazowka uwaga">{komunikat}</p>}
    </Sekcja>
  );
}

/**
 * Zmiana aplikacji authenticator (drugiego składnika).
 *
 * # Dlaczego najpierw ponowne uwierzytelnienie
 *
 * Podmiana authenticatora przejmuje logowanie na stałe, więc nie może wystarczyć
 * otwarta sesja — przejęte, odblokowane urządzenie ma otwartą sesję. Zanim
 * serwer wyda nowy sekret, żąda świeżego dowodu: passkeya albo aktualnego kodu
 * ze starego authenticatora.
 *
 * # Dlaczego stary działa aż do potwierdzenia
 *
 * Nowy sekret jest OCZEKUJĄCY, dopóki użytkownik nie wpisze pierwszego kodu
 * z nowej aplikacji. Gdyby aktywował się od razu po pokazaniu QR, zamknięcie
 * karty w pół drogi zostawiłoby konto bez żadnego działającego authenticatora.
 */
function ZmianaAuthenticatora({
  messenger,
  onBlad,
}: {
  messenger: Messenger;
  onBlad: (e: unknown) => void;
}) {
  type Etap =
    | { nazwa: "spoczynek" }
    | { nazwa: "reauth" }
    | { nazwa: "nowy"; totpSecret: string; otpauthUri: string };

  const [etap, setEtap] = useState<Etap>({ nazwa: "spoczynek" });
  const [staryKod, setStaryKod] = useState("");
  const [nowyKod, setNowyKod] = useState("");
  const [pracuje, setPracuje] = useState(false);

  const token = messenger.accessToken;

  const zaczniPasskeyem = async () => {
    setPracuje(true);
    try {
      const opcje = await totpChangeOptions(token);
      const odpowiedz = await getPasskey(opcje);
      const nowy = await totpChangeStartPasskeyem(token, odpowiedz);
      setEtap({ nazwa: "nowy", ...nowy });
    } catch (err) {
      onBlad(err);
    } finally {
      setPracuje(false);
    }
  };

  const zaczniKodem = async (e: React.FormEvent) => {
    e.preventDefault();
    setPracuje(true);
    try {
      const nowy = await totpChangeStartKodem(token, staryKod.trim());
      setStaryKod("");
      setEtap({ nazwa: "nowy", ...nowy });
    } catch (err) {
      onBlad(err);
    } finally {
      setPracuje(false);
    }
  };

  const potwierdz = async (e: React.FormEvent) => {
    e.preventDefault();
    setPracuje(true);
    try {
      await totpChangeConfirm(token, nowyKod.trim());
      setNowyKod("");
      setEtap({ nazwa: "spoczynek" });
      toast.success("Authenticator zmieniony. Od teraz loguj się kodami z nowej aplikacji.");
    } catch (err) {
      onBlad(err);
    } finally {
      setPracuje(false);
    }
  };

  return (
    <Sekcja
      tytul="Aplikacja authenticator"
      opis={
        etap.nazwa === "spoczynek"
          ? "Zmieniasz telefon albo aplikację? Podłącz nowy authenticator — najpierw potwierdzisz, że to Ty."
          : etap.nazwa === "reauth"
            ? "Potwierdź, że to Ty — passkeyem albo aktualnym kodem ze starego authenticatora."
            : undefined
      }
    >
      {etap.nazwa === "spoczynek" && (
        <Button variant="outline" className="self-start" onClick={() => setEtap({ nazwa: "reauth" })}>
          <Ikona nazwa="klucz" rozmiar={16} />
          Zmień authenticator
        </Button>
      )}

      {etap.nazwa === "reauth" && (
        <>
          {isPasskeySupported() && (
            <Button variant="outline" className="self-start" disabled={pracuje} onClick={zaczniPasskeyem}>
              <Ikona nazwa="blokada" rozmiar={16} />
              {pracuje ? "Czekam…" : "Potwierdź passkeyem"}
            </Button>
          )}

          <form onSubmit={zaczniKodem} className="flex flex-col gap-2">
            <label>
              Kod ze starego authenticatora
              <Input
                className="font-mono tracking-[0.2em]"
                value={staryKod}
                onChange={(e) => setStaryKod(e.target.value)}
                inputMode="numeric"
                autoComplete="one-time-code"
                required
              />
            </label>
            <div className="flex gap-2">
              <Button type="submit" variant="outline" disabled={pracuje}>
                Dalej
              </Button>
              <Button variant="ghost" onClick={() => setEtap({ nazwa: "spoczynek" })}>
                Anuluj
              </Button>
            </div>
          </form>
        </>
      )}

      {etap.nazwa === "nowy" && (
        <>
          <p className="wskazowka">
            Zeskanuj w <strong>nowej</strong> aplikacji authenticator, potem wpisz jej pierwszy kod.
            Stary authenticator działa aż do potwierdzenia.
          </p>

          <KodQr tresc={etap.otpauthUri} opis="Kod QR nowego authenticatora" />

          <details className="sekret-recznie">
            <summary>Albo wpisz sekret ręcznie</summary>
            <code className="sekret mt-2">{etap.totpSecret}</code>
          </details>

          <form onSubmit={potwierdz} className="flex flex-col gap-2">
            <label>
              Kod z nowej aplikacji
              <Input
                className="font-mono tracking-[0.2em]"
                value={nowyKod}
                onChange={(e) => setNowyKod(e.target.value)}
                inputMode="numeric"
                autoComplete="one-time-code"
                required
              />
            </label>
            <div className="flex gap-2">
              <Button type="submit" variant="outline" disabled={pracuje}>
                {pracuje ? "Potwierdzam…" : "Potwierdź zmianę"}
              </Button>
              <Button variant="ghost" onClick={() => setEtap({ nazwa: "spoczynek" })}>
                Anuluj
              </Button>
            </div>
          </form>
        </>
      )}
    </Sekcja>
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
    <Sekcja
      tytul="Passkey"
      opis="Zaloguj się odciskiem palca, PIN-em albo kluczem sprzętowym — zamiast wpisywać hasło i kod za każdym razem."
    >
      <Button
        variant="outline"
        className="self-start"
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
        <Ikona nazwa={zarejestrowano ? "wyslane" : "blokada"} rozmiar={16} />
        {zarejestrowano ? "Passkey dodany" : pracuje ? "Dodaję…" : "Dodaj passkey"}
      </Button>
    </Sekcja>
  );
}
