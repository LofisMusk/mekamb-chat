import { type ReactNode, useEffect, useState } from "react";
import { toast } from "sonner";

import { Ikona } from "./Ikony";
import { KodQr } from "./KodQr";
import { Urzadzenia } from "./Parowanie";
import { WyborJezykaUI, WyborMotywuUI } from "./Wspolne";
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
import { t } from "./lib/jezyk";

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
          <h2 className="text-tytul">{t("Ustawienia", "Settings")}</h2>
          <span className="text-meta text-tekst-drugi">{t("Konto, urządzenia i wygląd", "Account, devices and appearance")}</span>
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
            {t("Nazwa wyświetlana", "Display name")}
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
            {t("Tak zobaczą Cię inni w rozmowach. Twoja nazwa użytkownika się nie zmienia — to po niej dochodzą wiadomości.", "This is how others see you in conversations. Your username doesn't change — messages reach you by it.")}
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
                <dt className="text-meta text-tekst-drugi">{t("Pamięć", "Storage")}</dt>
                <dd className="flex items-center gap-1.5 text-meta text-ostrzezenie">
                  <Ikona nazwa="ostrzezenie" rozmiar={13} />
                  {t("przeglądarka może usunąć rozmowy", "the browser may delete your conversations")}
                </dd>
              </div>
            )}
          </dl>
        </div>

        <Sekcja tytul={t("Wygląd", "Appearance")}>
          <WyborMotywuUI zEtykietami />
        </Sekcja>

        <Sekcja tytul={t("Język", "Language")}>
          <WyborJezykaUI className="w-full" />
        </Sekcja>

        {/*
          Potwierdzenia odczytu w ustawieniach, nie w rozmowie: to decyzja o tym,
          ile o sobie mówisz — dotyczy każdej rozmowy naraz.

          Z opisu zostało jedno zdanie: to, które zmienia decyzję. Reszta
          (opóźnienie, zbiorcza wysyłka) opisywała, JAK to zrobiliśmy.
        */}
        <Sekcja tytul={t("Prywatność", "Privacy")}>
          <label className="przelacznik flex cursor-pointer items-center justify-between gap-4">
            <span className="flex flex-col gap-0.5">
              <span className="text-tresc text-tekst">{t("Wysyłaj potwierdzenia odczytu", "Send read receipts")}</span>
              <span className="text-meta text-tekst-drugi">
                {t("Kiedy je wyłączysz, przestaniesz też widzieć cudze.", "When you turn them off, you also stop seeing other people's.")}
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
            tytul={t("Zablokowani", "Blocked")}
            opis={t("Nie dostajesz od nich wiadomości ani zaproszeń. Odblokowanie przywraca rozmowy i wszystko, co przyszło w międzyczasie.", "You don't get messages or invitations from them. Unblocking restores the conversations and everything that arrived in the meantime.")}
          >
            <ul className="flex flex-col gap-1">
              {[...zablokowani]
                .sort((a, b) => a.localeCompare(b))
                .map((osoba) => (
                  <li key={osoba} className="flex items-center gap-3">
                    <Awatar nazwa={nick(osoba)} rozmiar="sm" />
                    <span className="min-w-0 flex-1 truncate text-tresc">{nick(osoba)}</span>
                    <Button variant="ghost" size="sm" onClick={() => onOdblokuj(osoba)}>
                      {t("Odblokuj", "Unblock")}
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
        <Sekcja tytul={t("Twoje rozmowy", "Your conversations")}>
          <p className="wskazowka-ikona">
            <Ikona nazwa="klucz" rozmiar={14} />
            {t("Są zapisane tylko na tym urządzeniu — nie mamy ich kopii i nie odtworzymy ich nikomu. Zanim zmienisz telefon, przenieś konto.", "They're stored only on this device — we don't have a copy and can't restore them for anyone. Move your account before you change phones.")}
          </p>
        </Sekcja>

        {/*
          Kasowanie w osobnej strefie, na dole i za linią.

          Nieodwracalne obok odwracalnego to zaproszenie do pomyłki — a tej
          pomyłki nie da się cofnąć, bo historii nie ma nigdzie indziej.
        */}
        <section className="mt-4 flex flex-col items-start gap-2 border-t border-linia pt-6">
          <strong className="text-tresc font-semibold">{t("Usunięcie konta z tego urządzenia", "Removing the account from this device")}</strong>
          <p className="wskazowka">{t("Historii nie da się odzyskać — nigdzie jej nie zapisujemy.", "History can't be recovered — we don't store it anywhere.")}</p>

          <AlertDialog>
            <AlertDialogTrigger asChild>
              <Button variant="destructive" className="mt-1">
                <Ikona nazwa="wyloguj" rozmiar={16} />
                {t("Usuń konto z tego urządzenia", "Remove account from this device")}
              </Button>
            </AlertDialogTrigger>
            <AlertDialogContent>
              <AlertDialogHeader>
                <AlertDialogTitle>{t("Usunąć konto z tego urządzenia?", "Remove the account from this device?")}</AlertDialogTitle>
                <AlertDialogDescription>
                  {t("Klucze i cała historia rozmów znikną z tej przeglądarki. Historii nie da się odzyskać — nigdzie jej nie zapisujemy.", "Keys and the entire chat history will disappear from this browser. History can't be recovered — we don't store it anywhere.")}
                </AlertDialogDescription>
              </AlertDialogHeader>
              <AlertDialogFooter>
                <AlertDialogCancel>{t("Anuluj", "Cancel")}</AlertDialogCancel>
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
                  {t("Usuń konto", "Remove account")}
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
      toast.success(t("Wyeksportowano rozmowy do pliku.", "Conversations exported to a file."));
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
        setKomunikat(t("Nie udało się zaimportować: złe hasło albo uszkodzony plik.", "Import failed: wrong password or a damaged file."));
        return;
      }

      const wynik: WynikScalania | null = await scalHistorie(jawne);
      if (wynik) {
        toast.success(t(`Zaimportowano: ${wynik.rozmow} rozmów, ${wynik.wiadomosci} nowych wiadomości.`, `Imported: ${wynik.rozmow} conversations, ${wynik.wiadomosci} new messages.`));
        setHasloImport("");
        setPlik(null);
      } else {
        setKomunikat(t("Plik nie zawiera czytelnej historii.", "The file contains no readable history."));
      }
    } catch (e) {
      onBlad(e);
    } finally {
      setPracuje(false);
    }
  };

  return (
    <Sekcja
      tytul={t("Kopia rozmów", "Conversation backup")}
      opis={t("Wyeksportuj rozmowy do pliku ZIP chronionego hasłem albo wczytaj je z takiego pliku. Import dokłada rozmowy do istniejących, nie kasuje ich. Plik chroni wyłącznie hasło — zapomnianego nie da się obejść.", "Export your conversations to a password-protected ZIP file or load them from one. Importing adds conversations to the existing ones and doesn't delete anything. Only the password protects the file — a forgotten one can't be bypassed.")}
    >
      <div className="flex flex-col gap-2">
        <label>
          {t("Hasło do eksportu", "Export password")}
          <Input type="password" value={hasloEksport} onChange={(e) => setHasloEksport(e.target.value)} />
        </label>
        <Button variant="outline" disabled={!hasloEksport || pracuje} onClick={eksportuj} className="self-start">
          <Ikona nazwa="pobierz" rozmiar={16} />
          {pracuje ? t("Pracuję…", "Working…") : t("Eksportuj rozmowy", "Export conversations")}
        </Button>
      </div>

      <div className="flex flex-col gap-2 border-t border-linia pt-3">
        <label>
          {t("Plik kopii", "Backup file")}
          <Input
            type="file"
            accept=".zip,application/zip"
            onChange={(e) => setPlik(e.target.files?.[0] ?? null)}
          />
        </label>
        <label>
          {t("Hasło pliku", "File password")}
          <Input type="password" value={hasloImport} onChange={(e) => setHasloImport(e.target.value)} />
        </label>
        <Button
          variant="outline"
          disabled={!plik || !hasloImport || pracuje}
          onClick={importuj}
          className="self-start"
        >
          {pracuje ? t("Pracuję…", "Working…") : t("Importuj rozmowy", "Import conversations")}
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
      toast.success(t("Authenticator zmieniony. Od teraz loguj się kodami z nowej aplikacji.", "Authenticator changed. From now on, sign in with codes from the new app."));
    } catch (err) {
      onBlad(err);
    } finally {
      setPracuje(false);
    }
  };

  return (
    <Sekcja
      tytul={t("Aplikacja authenticator", "Authenticator app")}
      opis={
        etap.nazwa === "spoczynek"
          ? t("Zmieniasz telefon albo aplikację? Podłącz nowy authenticator — najpierw potwierdzisz, że to Ty.", "Changing your phone or app? Connect a new authenticator — first you'll confirm it's you.")
          : etap.nazwa === "reauth"
            ? t("Potwierdź, że to Ty — passkeyem albo aktualnym kodem ze starego authenticatora.", "Confirm it's you — with a passkey or a current code from the old authenticator.")
            : undefined
      }
    >
      {etap.nazwa === "spoczynek" && (
        <Button variant="outline" className="self-start" onClick={() => setEtap({ nazwa: "reauth" })}>
          <Ikona nazwa="klucz" rozmiar={16} />
          {t("Zmień authenticator", "Change authenticator")}
        </Button>
      )}

      {etap.nazwa === "reauth" && (
        <>
          {isPasskeySupported() && (
            <Button variant="outline" className="self-start" disabled={pracuje} onClick={zaczniPasskeyem}>
              <Ikona nazwa="blokada" rozmiar={16} />
              {pracuje ? t("Czekam…", "Waiting…") : t("Potwierdź passkeyem", "Confirm with passkey")}
            </Button>
          )}

          <form onSubmit={zaczniKodem} className="flex flex-col gap-2">
            <label>
              {t("Kod ze starego authenticatora", "Code from the old authenticator")}
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
                {t("Dalej", "Continue")}
              </Button>
              <Button variant="ghost" onClick={() => setEtap({ nazwa: "spoczynek" })}>
                {t("Anuluj", "Cancel")}
              </Button>
            </div>
          </form>
        </>
      )}

      {etap.nazwa === "nowy" && (
        <>
          <p className="wskazowka">
            {t("Zeskanuj w", "Scan it in")} <strong>nowej</strong> {t("aplikacji authenticator, potem wpisz jej pierwszy kod. Stary authenticator działa aż do potwierdzenia.", "your authenticator app, then enter its first code. The old authenticator keeps working until you confirm.")}
          </p>

          <KodQr tresc={etap.otpauthUri} opis={t("Kod QR nowego authenticatora", "QR code for the new authenticator")} />

          <details className="sekret-recznie">
            <summary>{t("Albo wpisz sekret ręcznie", "Or enter the secret manually")}</summary>
            <code className="sekret mt-2">{etap.totpSecret}</code>
          </details>

          <form onSubmit={potwierdz} className="flex flex-col gap-2">
            <label>
              {t("Kod z nowej aplikacji", "Code from the new app")}
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
                {pracuje ? t("Potwierdzam…", "Confirming…") : t("Potwierdź zmianę", "Confirm change")}
              </Button>
              <Button variant="ghost" onClick={() => setEtap({ nazwa: "spoczynek" })}>
                {t("Anuluj", "Cancel")}
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
      tytul={t("Passkey", "Passkey")}
      opis={t("Zaloguj się odciskiem palca, PIN-em albo kluczem sprzętowym — zamiast wpisywać hasło i kod za każdym razem.", "Sign in with your fingerprint, PIN or a hardware key — instead of typing the password and code every time.")}
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
        {zarejestrowano ? t("Passkey dodany", "Passkey added") : pracuje ? t("Dodaję…", "Adding…") : t("Dodaj passkey", "Add passkey")}
      </Button>
    </Sekcja>
  );
}
