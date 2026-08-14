import { useCallback, useEffect, useMemo, useRef, useState } from "react";

import { Ikona, type NazwaIkony } from "./Ikony";
import { Rozmowa, type SygnalRozmowy, type ZadanieRozmowy } from "./Rozmowa";
import { Uczestnicy } from "./Uczestnicy";
import { Zalacznik } from "./Zalacznik";
import { Pusto, WyborMotywuUI, ZnakMarki } from "./Wspolne";
import { Urzadzenia } from "./Parowanie";
import { PrzeniesStad } from "./Przeniesienie";
import { ZglosBlad } from "./Zgloszenie";
import { api } from "./lib/api";
import { logout, webauthnRegisterOptions, webauthnRegisterVerify } from "./lib/auth";
import {
  type PozycjaListy,
  type Wiadomosc,
  type ZapisRozmowy,
  dopiszWiadomosc,
  kluczRozmowy,
  listaRozmow,
  oznaczPrzeczytane,
  usunRozmowe,
  wczytajRozmowe,
  zapiszRozmowe,
} from "./lib/historia";
import { type LicznikProb, poNiepowodzeniu, poSukcesie } from "./lib/koperty";
import { filtrujRozmowy } from "./lib/lista";
import { type Messenger, type ReceivedMessage, idWiadomosci } from "./lib/messenger";
import {
  type StanWiadomosci,
  Zbieracz,
  losoweOpoznienie,
  opisStanu,
  stanZPotwierdzenia,
  wyzszyStan,
} from "./lib/potwierdzenia";
import { odczytWlaczony, ustawOdczyt } from "./lib/ustawienia";
import { useWstecz } from "./lib/nawigacja";
import { createPasskey, isPasskeySupported } from "./lib/passkey";
import { type StanPolaczenia, polaczZeSkrzynka } from "./lib/polaczenie";
import { nazwaRozmowy, znajdzRozmowe1na1 } from "./lib/rozmowy";
import { isPersistent, wipe } from "./lib/vault";
import { ulozWatek } from "./lib/watek";

/**
 * Godzina wiadomości — bez daty.
 *
 * Dzień rozdziela osobna etykieta w wątku; w dymku liczy się „o której",
 * a data powtarzana przy każdej wiadomości jest szumem.
 */
const GODZINA = new Intl.DateTimeFormat(undefined, { hour: "2-digit", minute: "2-digit" });

function godzina(czas: number): string {
  return GODZINA.format(new Date(czas));
}

/**
 * Jak wiadomość brzmi na liście rozmów.
 *
 * Załącznik nie ma treści do zacytowania, a od kiedy własne zdjęcie jest
 * zdjęciem (a nie napisem „wysłano: kot.jpg"), wiersz listy zostawał pusty.
 * Rodzaj pliku mówi tyle, ile da się powiedzieć jednym słowem — nazwy pliku
 * świadomie nie pokazujemy, bo bywa nią data i model aparatu.
 */
function zapowiedz(w: Wiadomosc): string {
  if (w.rozmowa) {
    if (w.rozmowa.sekundy === undefined) return "Nieodebrana rozmowa";
    return w.rozmowa.wideo ? "Rozmowa wideo" : "Rozmowa głosowa";
  }

  if (w.tresc) return w.tresc;
  if (!w.zalacznik) return "";

  if (w.zalacznik.mimeType.startsWith("image/")) return "Zdjęcie";
  if (w.zalacznik.mimeType.startsWith("video/")) return "Nagranie";
  return "Plik";
}

type Galaz = "rozmowy" | "kontakty" | "konto";

/** Wiadomość, której wysyłka jeszcze trwa albo się nie powiodła. */
interface WLocie {
  id: string;
  tresc: string;
  czas: number;
  blad: boolean;
}

/** Jak stan sieci brzmi i wygląda. Jedno miejsce, bo pojawia się w trzech. */
function opisSieci(stan: StanPolaczenia): { ikona: NazwaIkony; tekst: string; uwaga: boolean } {
  switch (stan) {
    case "polaczone":
      return { ikona: "przezSerwer", tekst: "przez serwer", uwaga: false };
    case "laczenie":
      return { ikona: "zegar", tekst: "łączę…", uwaga: false };
    case "rozlaczone":
      return { ikona: "brakSieci", tekst: "brak połączenia — ponawiam", uwaga: true };
  }
}

export function Czat({ messenger, onBlad }: { messenger: Messenger; onBlad: (e: unknown) => void }) {
  const [wiadomosci, setWiadomosci] = useState<Wiadomosc[]>([]);
  const [tresc, setTresc] = useState("");
  const [rozmowca, setRozmowca] = useState("");
  const [groupId, setGroupId] = useState<Uint8Array | null>(null);
  const [sygnalRozmowy, setSygnalRozmowy] = useState<SygnalRozmowy | null>(null);
  const [stanSieci, setStanSieci] = useState<StanPolaczenia>("laczenie");
  const [galaz, setGalaz] = useState<Galaz>("rozmowy");
  const [rozmowy, setRozmowy] = useState<PozycjaListy[]>([]);
  const [szukane, setSzukane] = useState("");

  /*
   * Wyzwalacz rozmowy A/V.
   *
   * Przyciski „Zadzwoń" i „Wideo" stoją w nagłówku wątku, a rozmową zarządza
   * komponent niżej. Zamiast przekazywać w dół funkcję, przekazujemy DANE:
   * licznik zmienia się przy każdym kliknięciu, więc powtórne wybranie tego
   * samego trybu też jest zauważone.
   */
  const [zadanieRozmowy, setZadanieRozmowy] = useState<ZadanieRozmowy | null>(null);

  /*
   * Grupa, w której toczy się rozmowa A/V — osobno od tej otwartej na ekranie.
   *
   * To dwie różne rzeczy i wcześniej były jedną. Rozmowa przychodząca musi
   * dojść niezależnie od tego, co użytkownik ma akurat przed sobą: może być
   * w innym wątku, w Kontaktach albo na Koncie. Sklejenie ich znaczyło albo
   * gubienie połączeń, albo przerzucanie kogoś do innej rozmowy w chwili,
   * w której ktoś zadzwonił.
   */
  const [grupaRozmowy, setGrupaRozmowy] = useState<Uint8Array | null>(null);

  /** Czy rozmowa A/V zajmuje ekran — wtedy reszty układu nie ma. */
  const [rozmowaNaEkranie, setRozmowaNaEkranie] = useState(false);

  /*
   * Inspektor: na szerokim ekranie otwarty od razu, na wąskim schowany.
   *
   * Szerokość czytamy RAZ, przy pierwszym złożeniu, i to jest jedyne miejsce
   * w tym pliku, gdzie w ogóle o nią pytamy. Wolno tu, bo to nie jest stan
   * wyliczany z szerokości — to stan przełączany przez użytkownika, któremu
   * szerokość podpowiada tylko wartość POCZĄTKOWĄ. Przełącznik listy i wątku
   * jest inny i dlatego siedzi w arkuszu: tam stan musiałby gonić za każdym
   * obrotem telefonu.
   *
   * Wcześniej to pole było zawsze `false`, a na szerokim ekranie panel i tak
   * się pokazywał, bo arkusz trzymał go jako stałą kolumnę. Krzyżyk nie miał
   * więc czego zamknąć.
   */
  const [inspektorOtwarty, setInspektorOtwarty] = useState(
    () => typeof matchMedia === "function" && matchMedia("(min-width: 78.01rem)").matches,
  );

  /*
   * Trwałość magazynu pokazujemy w panelu konta, a nie tylko w ostrzeżeniu
   * na górze: ostrzeżenie znika po jej przyznaniu, a wtedy nie ma już gdzie
   * sprawdzić, czy naprawdę jest przyznana.
   */
  const [trwaly, setTrwaly] = useState(true);
  useEffect(() => {
    void isPersistent().then(setTrwaly).catch(() => {});
  }, []);

  /**
   * Wiadomości w locie — pokazane od razu, jeszcze przed potwierdzeniem.
   *
   * Osobno od historii, a nie z polem stanu w niej: wiadomość, której wysyłka
   * nie dobiegła końca przed zamknięciem karty, ma nieznany los. Zapisana
   * wyglądałaby na wysłaną, a nie wiemy tego — więc nie zapisujemy jej wcale.
   */
  const [wLocie, setWLocie] = useState<WLocie[]>([]);
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
  const nazwaPozycji = useCallback(
    (pozycja: PozycjaListy): string => {
      if (pozycja.rozmowca) return pozycja.rozmowca;

      try {
        const z = nazwaRozmowy(messenger.memberUserIds(pozycja.groupId), messenger.account.userId);
        return z || "rozmowa bez nazwy";
      } catch {
        return "rozmowa bez nazwy";
      }
    },
    [messenger],
  );

  const widoczne = useMemo(
    () => filtrujRozmowy(rozmowy, szukane, nazwaPozycji),
    [rozmowy, szukane, nazwaPozycji],
  );

  /**
   * Ile razy dana koperta odpadła przy przetwarzaniu.
   *
   * Potrzebne, bo koperta bez potwierdzenia wraca przy każdym połączeniu.
   * Bez licznika koperta, której nigdy nie da się przetworzyć — powtórzona
   * albo spreparowana — wracałaby w nieskończoność.
   */
  const nieudane = useRef<LicznikProb>(new Map());

  /*
   * Zbieracz potwierdzeń i jego zegar.
   *
   * Przez referencję, nie przez stan: dołożenie potwierdzenia nie ma
   * przerysowywać ekranu, a przerysowanie nie ma resetować odliczania.
   * Powód opóźnienia i losowości siedzi w `potwierdzenia.ts`.
   */
  const zbieracz = useRef(new Zbieracz());
  const zegarPotwierdzen = useRef<ReturnType<typeof setTimeout> | null>(null);

  const [odczyt, setOdczyt] = useState(() => odczytWlaczony());

  /** Rozmowy po kluczu — potwierdzenie musi wrócić do właściwej grupy. */
  const grupyPoKluczu = useRef(new Map<string, Uint8Array>());

  const zaplanujWysylke = useCallback(() => {
    if (zegarPotwierdzen.current !== null) return;

    zegarPotwierdzen.current = setTimeout(() => {
      zegarPotwierdzen.current = null;

      for (const paczka of zbieracz.current.zabierz()) {
        const groupId = grupyPoKluczu.current.get(paczka.kluczRozmowy);
        if (!groupId) continue;

        // Nieudane potwierdzenie przepada i to jest w porządku: ptaszek jest
        // wygodą, a nie treścią. Ponawianie w kółko dokładałoby kopert do
        // ruchu, czyli dokładnie tego, co ten mechanizm ma ograniczać.
        void messenger.sendReceipt(groupId, paczka.rodzaj, paczka.identyfikatory).catch(() => {});
      }
    }, losoweOpoznienie());
  }, [messenger]);

  // Zegar nie może przeżyć komponentu — inaczej wysyłka trafia w messengera,
  // którego nikt już nie używa.
  useEffect(() => () => {
    if (zegarPotwierdzen.current !== null) clearTimeout(zegarPotwierdzen.current);
  }, []);

  // Bieżący identyfikator rozmowy dla obsługi koperty. Przez referencję,
  // bo obsługa nie może zależeć od stanu — inaczej każda zmiana rozmowy
  // zrywałaby połączenie.
  const biezacaGrupa = useRef<Uint8Array | null>(null);
  biezacaGrupa.current = groupId;

  /**
   * Nazwa rozmowy odtworzona ze składu grupy MLS.
   *
   * Potrzebna, gdy wiadomość przychodzi do rozmowy spoza ekranu: zapis na dysk
   * musi wiedzieć, czyj to wątek, a jedynym źródłem prawdy o nazwie jest drzewo
   * MLS. Brak zwracamy jako `undefined`, żeby zapis nie skasował nazwy
   * zachowanej wcześniej.
   */
  const nazwaGrupy = useCallback(
    (groupId: Uint8Array): string | undefined => {
      try {
        return nazwaRozmowy(messenger.memberUserIds(groupId), messenger.account.userId) || undefined;
      } catch {
        return undefined;
      }
    },
    [messenger],
  );

  /**
   * Przełączenie rozmowy czyści wiadomości w TYM SAMYM zdarzeniu.
   *
   * Bez tego `groupId` zmieniał się o jeden render wcześniej niż `wiadomosci`,
   * więc efekt zapisujący zdążył zrzucić wiadomości poprzedniej rozmowy pod
   * identyfikator nowej — świeżo otwarty wątek „dziedziczył" cudzą historię.
   * Pusty stan wychodzi też na dobre licznikowi i zapisowi: oba mają warunek
   * „są jakieś wiadomości", więc na pustce nie robią nic.
   */
  const otworzRozmowe = useCallback((docelowa: Uint8Array | null) => {
    setGroupId(docelowa);
    setWiadomosci([]);
    setWLocie([]);
  }, []);

  const dodaj = useCallback(
    (odebrana: ReceivedMessage) => {
      /*
       * Wiadomość z DRUGIEGO WŁASNEGO urządzenia jest nasza.
       *
       * Odkąd wysyłamy także do własnej skrzynki, telefon dostaje to, co
       * napisaliśmy na laptopie. Bez tego sprawdzenia stanęłoby to po lewej
       * stronie, podpisane naszym własnym identyfikatorem, jak wypowiedź obcej
       * osoby. Rozstrzyga `sender_user_id` z credentiala MLS — jedyne
       * wiarygodne źródło, bo pola spoza kanału MLS można podmienić.
       */
      const wlasna = odebrana.senderUserId === messenger.account.userId;

      const wiadomosc: Wiadomosc = {
        id: idWiadomosci(odebrana.messageId),
        autor: wlasna ? "Ty" : odebrana.senderUserId,
        tresc: odebrana.text,
        czas: odebrana.sentAtMs,
        wlasna,
        zalacznik: odebrana.attachment,
      };

      /*
       * Wiadomość trafia do SWOJEJ rozmowy, nie do tej otwartej na ekranie.
       *
       * Wcześniej dopisywała się do wątku akurat widocznego bez patrzenia na
       * grupę — więc świeżo założona rozmowa pokazywała wiadomości kogoś
       * zupełnie innego, a nadawca, którego wątku nikt nie oglądał, nie
       * pojawiał się na liście wcale (trzeba było najpierw do niego napisać,
       * żeby się w ogóle pokazał). Android robił to poprawnie od dawna
       * (`ChatViewModel`), web nie.
       */
      if (biezacaGrupa.current && kluczRozmowy(biezacaGrupa.current) === kluczRozmowy(odebrana.groupId)) {
        // Otwarty wątek: dopisujemy do stanu, a na dysk zrzuca to efekt
        // czuwający nad `wiadomosci` — drugi zapis stąd byłby zapisem tej samej
        // rozmowy naraz.
        setWiadomosci((poprzednie) => [...poprzednie, wiadomosc]);
      } else {
        // Rozmowa spoza ekranu: prosto na dysk i odświeżenie listy, żeby wiersz
        // i licznik nieprzeczytanych urosły nawet wtedy, gdy nikt tego wątku
        // nie ogląda.
        void dopiszWiadomosc(odebrana.groupId, nazwaGrupy(odebrana.groupId), wiadomosc)
          .then(() => listaRozmow())
          .then(setRozmowy)
          .catch(() => {
            // Nieudany zapis nie może wywrócić odbioru — wiadomość jest już
            // odszyfrowana, a jej kopia na dysku to mniejsza sprawa niż
            // zerwana pętla odbierająca.
          });
      }

      const klucz = kluczRozmowy(odebrana.groupId);
      grupyPoKluczu.current.set(klucz, odebrana.groupId);

      // Za własną wiadomość nie potwierdzamy dostarczenia. Rozmówca dostałby
      // „dostarczono" na wiadomość, której nie wysłał — bezużyteczny ruch,
      // który przy okazji zdradza, ile mamy urządzeń.
      if (wlasna) return;

      /*
       * Dostarczenie potwierdzamy przy odbiorze, a nie przy pokazaniu.
       *
       * „Dostarczono" jest twierdzeniem o kopercie, nie o uwadze odbiorcy —
       * i tak nie dokłada osobnego zdarzenia w czasie, bo koperta i tak
       * właśnie przyszła.
       */
      zbieracz.current.dodaj(klucz, "delivered", idWiadomosci(odebrana.messageId));
      zaplanujWysylke();
    },
    [messenger, zaplanujWysylke, nazwaGrupy],
  );

  /**
   * Przenosi znacznik przeczytania z drugiego własnego urządzenia.
   *
   * Chwilę bierzemy z najnowszej **wymienionej** wiadomości, a nie z `Date.now()`:
   * potwierdzenia wychodzą z losowym opóźnieniem do 30 s, więc „teraz"
   * oznaczyłoby jako przeczytane także to, co przyszło w międzyczasie.
   */
  const przenieRoznacznikOdczytu = useCallback(
    async (groupId: Uint8Array, identyfikatory: string[]) => {
      const zbior = new Set(identyfikatory);
      const zapisane = await wczytajRozmowe(groupId);

      let najnowsza = 0;
      for (const w of zapisane) {
        if (zbior.has(w.id) && w.czas > najnowsza) najnowsza = w.czas;
      }

      if (najnowsza === 0) return;

      await oznaczPrzeczytane(groupId, najnowsza);
      setRozmowy(await listaRozmow());
    },
    [],
  );

  /**
   * Nanosi potwierdzenie na własne wiadomości.
   *
   * # Dlaczego to sięga na DYSK, a nie tylko do stanu ekranu
   *
   * Bo potwierdzenie przychodzi RAZ i nie powtórzy się nigdy. Wcześniej ta
   * funkcja zmieniała wyłącznie `wiadomosci`, czyli wątek otwarty w tej chwili —
   * a potwierdzenie przychodzi po losowym opóźnieniu do trzydziestu sekund,
   * więc trafiało zwykle w moment, w którym użytkownik patrzył już na coś
   * innego. Wtedy przepadało bez śladu: dymek zostawał przy „wysłano" na stałe,
   * bo drugiej szansy nie ma.
   *
   * Otwarta rozmowa dostaje nowy stan od razu (widać go bez czekania) i tak samo
   * ląduje na dysku. Każda inna jest tylko przepisywana.
   */
  const nanieStan = useCallback(
    (groupId: Uint8Array, identyfikatory: string[], stan: StanWiadomosci) => {
      const zbior = new Set(identyfikatory);

      const podnies = (lista: Wiadomosc[]): Wiadomosc[] =>
        lista.map((w) =>
          w.wlasna && zbior.has(w.id) ? { ...w, stan: wyzszyStan(w.stan ?? "wyslane", stan) } : w,
        );

      if (biezacaGrupa.current && kluczRozmowy(biezacaGrupa.current) === kluczRozmowy(groupId)) {
        // Zapis na dysk robi tu efekt czuwający nad `wiadomosci` — dopisywanie
        // go drugi raz oznaczałoby dwa zapisy tej samej rozmowy naraz.
        setWiadomosci(podnies);
        return;
      }

      void wczytajRozmowe(groupId)
        .then((zapisane) => {
          if (zapisane.length === 0) return;
          return zapiszRozmowe(groupId, undefined, podnies(zapisane)).then(() => listaRozmow());
        })
        .then((pozycje) => {
          if (pozycje) setRozmowy(pozycje);
        })
        .catch(() => {
          // Nieudany zapis ptaszka nie może wywrócić odbierania. Ptaszek jest
          // wygodą, koperta — treścią.
        });
    },
    [],
  );

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

        if (odebrana?.receipt) {
          /*
           * Potwierdzenie nie jest wiadomością do pokazania — zmienia stan
           * dymków, które już są na ekranie.
           *
           * Cudze potwierdzenia odczytu ignorujemy, gdy własnych nie wysyłamy:
           * jednostronna wymiana byłaby korzystaniem z czegoś, czego się nie
           * oddaje. Dostarczenie zostaje — nie mówi nic o niczyjej uwadze.
           */
          if (odebrana.senderUserId === messenger.account.userId) {
            // Potwierdzenie od nas samych nie mówi nic o rozmówcy, za to mówi
            // wszystko o drugim naszym urządzeniu: przeczytane na telefonie ma
            // znaczyć przeczytane również tutaj.
            if (odebrana.receipt.kind === "read") {
              void przenieRoznacznikOdczytu(odebrana.groupId, odebrana.receipt.messageIds);
            }
          } else if (odebrana.receipt.kind === "delivered" || odczytRef.current) {
            nanieStan(
              odebrana.groupId,
              odebrana.receipt.messageIds,
              stanZPotwierdzenia(odebrana.receipt.kind),
            );
          }
        } else if (odebrana?.call) {
          /*
           * Sygnalizacja rozmowy nie jest wiadomością do wyświetlenia — trafia
           * do ekranu rozmowy.
           *
           * Grupa rozmowy jest ZAWSZE ta z koperty, także wtedy, gdy otwarty
           * jest inny wątek albo zupełnie inna gałąź. Wcześniej ustawiał ją
           * tylko warunek „jeśli nic nie jest otwarte", więc telefon dzwoniący
           * w czasie czytania innej rozmowy nie dzwonił nigdzie: sygnał szedł
           * do komponentu przypiętego do CUDZEJ grupy, który go odrzucał jako
           * nieswój — i nikt się nie dowiadywał, że ktoś dzwonił.
           */
          setGrupaRozmowy(odebrana.groupId);
          setSygnalRozmowy({ ...odebrana.call, nadawca: odebrana.senderUserId });
        } else if (odebrana) {
          dodaj(odebrana);
          if (!biezacaGrupa.current) otworzRozmowe(odebrana.groupId);
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
    [messenger, dodaj, nanieStan, przenieRoznacznikOdczytu, otworzRozmowe],
  );

  // Ustawienie przez referencję: obsługa koperty nie może zależeć od stanu,
  // bo każda zmiana zależności zrywałaby i otwierała połączenie na nowo.
  const odczytRef = useRef(odczyt);
  odczytRef.current = odczyt;

  // Połączenie zależy WYŁĄCZNIE od konta. Wcześniej wisiało na `groupId`
  // i na niememoizowanej funkcji błędu, więc każde przerysowanie zrywało je
  // i otwierało nowe.
  useEffect(() => {
    const polaczenie = polaczZeSkrzynka({
      otworz: () => api.connectInbox(messenger.account.userId, messenger.accessToken),
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

    /*
     * Potwierdzenie odczytu wychodzi z tego samego warunku co licznik:
     * rozmowa musi być OTWARTA. „Przeczytane" ma znaczyć „widziałeś", a nie
     * „dostałeś" — inaczej byłoby drugim potwierdzeniem dostarczenia.
     *
     * Wysyłamy tylko wtedy, gdy użytkownik na to pozwala. Wyłączenie działa
     * w obie strony: kto nie oddaje, ten nie dostaje (patrz `ustawienia.ts`).
     */
    if (odczyt) {
      const klucz = kluczRozmowy(groupId);
      grupyPoKluczu.current.set(klucz, groupId);

      let cokolwiek = false;
      for (const w of wiadomosci) {
        if (w.wlasna) continue;
        zbieracz.current.dodaj(klucz, "read", w.id);
        cokolwiek = true;
      }

      if (cokolwiek) zaplanujWysylke();
    }

    const najnowsza = Math.max(...wiadomosci.map((w) => w.czas));
    void oznaczPrzeczytane(groupId, najnowsza)
      .then(() => listaRozmow())
      .then(setRozmowy)
      .catch(() => {
        // Nieudany zapis znacznika nie może wywrócić rozmowy — najwyżej
        // licznik pokaże za dużo, co jest mniejszą szkodą niż pusty ekran.
      });
  }, [groupId, galaz, wiadomosci, odczyt, zaplanujWysylke]);

  /*
   * Rozmowy z poprzednich uruchomień.
   *
   * Nie tylko do listy: rdzeń po odtworzeniu ma pełny stan MLS na dysku, ale
   * pustą listę OTWARTYCH rozmów. Bez `otworzZnaneRozmowy` po odświeżeniu karty
   * nie dałoby się ani nic wysłać, ani odebrać — koperty przestałyby pasować do
   * czegokolwiek.
   */
  useEffect(() => {
    void listaRozmow().then((pozycje) => {
      messenger.otworzZnaneRozmowy(pozycje.map((p) => p.groupId));
      setRozmowy(pozycje);
    });
  }, [messenger]);

  /*
   * Nazwa rozmowy pochodzi z drzewa MLS, nie ze stanu interfejsu.
   *
   * Wcześniej brała się z tego, co użytkownik wpisał w Kontaktach albo
   * kliknął na liście. Rozmowa założona przez KOGOŚ INNEGO nie przechodzi
   * przez żadne z tych miejsc, więc zapisywała się bez nazwy — na liście
   * pojawiał się wiersz bez imienia i bez awatara.
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
      if (!aktualne) return;

      // Scalamy z tym, co przyszło w międzyczasie — koperta mogła dotrzeć,
      // zanim odczyt z dysku się skończył. Pusty wynik też nanosimy: świeżo
      // otwarta rozmowa bez zapisów na dysku ma zacząć od pustki, a nie zostać
      // przy wiadomościach, które `otworzRozmowe` już wyczyściło.
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
   * strzałka, gest i systemowe „wstecz" robią dokładnie to samo.
   */
  useWstecz(
    galaz === "rozmowy" && groupId !== null,
    () => otworzRozmowe(null),
    groupId ? kluczRozmowy(groupId) : "",
  );

  // Inspektor otwarty jako panel też ma wyjść na „wstecz" — inaczej systemowy
  // przycisk zamyka rozmowę spod panelu, który został na wierzchu.
  useWstecz(inspektorOtwarty, () => setInspektorOtwarty(false), "inspektor");

  const rozpocznijZ = async (nazwa: string) => {
    try {
      // Rozmowa z tą osobą mogła już powstać. Bez tego sprawdzenia każde
      // „rozpocznij rozmowę" zakładało nową grupę MLS, więc lista puchła od
      // duplikatów, a historia rozjeżdżała się między nimi.
      const istniejaca = znajdzRozmowe1na1(
        rozmowy,
        (g) => messenger.memberUserIds(g),
        messenger.account.userId,
        nazwa,
      );

      otworzRozmowe(istniejaca ? istniejaca.groupId : await messenger.startConversation(nazwa));
      setGalaz("rozmowy");
    } catch (err) {
      onBlad(err);
    }
  };

  /*
   * Ekran rozmowy A/V stoi PONAD układem, a nie w środku wątku.
   *
   * Składnik rysuje się zawsze — to on wie, czy jest co pokazywać, i mówi to
   * przez `onAktywnosc`. Odmontowywanie go, gdy nie ma rozmowy, kasowałoby
   * kolejkę sygnałów i trwającą negocjację przy każdym przejściu między
   * gałęziami.
   *
   * Grupa: ta z sygnału, a gdy dzwonimy sami — ta otwarta. Bez żadnej z nich
   * nie ma do kogo dzwonić i składnik nie ma czego rysować.
   */
  const grupaDlaRozmowy = grupaRozmowy ?? groupId;

  const ekranRozmowy = grupaDlaRozmowy && (
    <Rozmowa
      messenger={messenger}
      groupId={grupaDlaRozmowy}
      sygnal={sygnalRozmowy}
      zadanie={zadanieRozmowy}
      onAktywnosc={setRozmowaNaEkranie}
      onZdarzenie={(zapis) => {
        /*
         * Ślad po rozmowie trafia do WĄTKU, w którym się odbyła.
         *
         * Gdy rozmowa toczyła się w innej grupie niż otwarta, dopisanie go do
         * `wiadomosci` wstawiłoby zdarzenie do cudzej historii — i tam
         * zostałoby zapisane na dysku. Do stanu ekranu dokładamy je więc tylko
         * wtedy, gdy to naprawdę ta sama rozmowa.
         */
        const wpis: Wiadomosc = {
          id: crypto.randomUUID(),
          autor: zapis.wychodzaca ? "Ty" : rozmowca,
          tresc: "",
          czas: Date.now(),
          wlasna: zapis.wychodzaca,
          rozmowa: zapis,
        };

        if (groupId && kluczRozmowy(groupId) === kluczRozmowy(grupaDlaRozmowy)) {
          setWiadomosci((p) => [...p, wpis]);
        } else {
          // Cudzy wątek dopisujemy prosto na dysk i odświeżamy listę: nie ma go
          // na ekranie, więc nie ma czego przerysować poza wierszem listy.
          void wczytajRozmowe(grupaDlaRozmowy)
            .then((zapisane) => zapiszRozmowe(grupaDlaRozmowy, undefined, [...zapisane, wpis]))
            .then(() => listaRozmow())
            .then(setRozmowy)
            .catch(() => {});
        }
      }}
      onBlad={onBlad}
    />
  );

  return (
    <div className={groupId && galaz === "rozmowy" ? "uklad rozmowa-otwarta" : "uklad"}>
      {/*
        Ekran rozmowy A/V zostaje PIERWSZYM dzieckiem tego samego korzenia,
        także w trakcie rozmowy. Wcześniej trwająca rozmowa zwracała osobny
        korzeń (`<>…</>`), więc React odmontowywał `Rozmowa` i montował ją od
        nowa przy każdym wejściu i wyjściu — a świeży komponent zgłaszał
        `call = null`, czyli `onAktywnosc(false)`, co przełączało korzeń z
        powrotem i pętliło przemontowania: obraz migotał, a negocjacja
        startowała w kółko. Ekran rozmowy i tak przykrywa wszystko
        (`position: fixed`), więc resztę układu chowamy pod nim, nie ruszając
        miejsca `Rozmowa` w drzewie.
      */}
      {ekranRozmowy}

      {!rozmowaNaEkranie && (
        <>
          <Nawigacja
            galaz={galaz}
            onGalaz={setGalaz}
            nieprzeczytane={nieprzeczytane}
            stanSieci={stanSieci}
          />

          {galaz === "rozmowy" && (
        <PanelListy
          rozmowy={widoczne}
          wszystkich={rozmowy.length}
          szukane={szukane}
          onSzukane={setSzukane}
          nazwaPozycji={nazwaPozycji}
          otwarta={groupId}
          onOtworz={(pozycja) => {
            otworzRozmowe(pozycja.groupId);
            setRozmowca(nazwaPozycji(pozycja));
          }}
          onUsun={(pozycja) => {
            // Usunięcie z listy zamyka też wątek, jeśli akurat jest otwarty —
            // inaczej ekran zostałby przy rozmowie, której nie ma już na dysku.
            if (groupId && kluczRozmowy(groupId) === kluczRozmowy(pozycja.groupId)) {
              otworzRozmowe(null);
            }
            void usunRozmowe(pozycja.groupId)
              .then(() => listaRozmow())
              .then(setRozmowy)
              .catch((err) => onBlad(err));
          }}
        />
      )}

      <section className="ekran">
        {galaz === "rozmowy" && !groupId && (
          <Pusto
            ikona="rozmowy"
            tytul="Wybierz rozmowę"
            wskazowka="Albo zacznij nową w Kontaktach — wystarczy nazwa użytkownika."
          />
        )}

        {galaz === "rozmowy" && groupId && (
          <Watek
            messenger={messenger}
            groupId={groupId}
            rozmowca={rozmowca}
            wiadomosci={wiadomosci}
            wLocie={wLocie}
            setWiadomosci={setWiadomosci}
            setWLocie={setWLocie}
            tresc={tresc}
            setTresc={setTresc}
            stanSieci={stanSieci}
            // Dzwonimy z otwartego wątku, więc rozmowa toczy się w JEGO grupie.
            // Bez tego ekran rozmowy zostałby przy grupie z poprzedniego
            // połączenia przychodzącego.
            setZadanieRozmowy={(z) => {
              setGrupaRozmowy(groupId);
              setZadanieRozmowy(z);
            }}
            inspektorOtwarty={inspektorOtwarty}
            setInspektorOtwarty={setInspektorOtwarty}
            onBlad={onBlad}
          />
        )}

        {galaz === "kontakty" && <Kontakty onRozpocznij={rozpocznijZ} />}

        {galaz === "konto" && (
          <Konto
            messenger={messenger}
            stanSieci={stanSieci}
            trwaly={trwaly}
            odczyt={odczyt}
            onOdczyt={(wlaczony) => {
              ustawOdczyt(wlaczony);
              setOdczyt(wlaczony);
            }}
            onBlad={onBlad}
          />
        )}
      </section>

      {galaz === "rozmowy" && groupId && (
        <aside
          className={inspektorOtwarty ? "inspektor otwarty" : "inspektor"}
          aria-label="Uczestnicy i kod bezpieczeństwa"
        >
          <div className="pasek-ekranu">
            <h2>Rozmowa</h2>
            <button
              className="ikonowy"
              aria-label="Zamknij panel"
              onClick={() => setInspektorOtwarty(false)}
            >
              <Ikona nazwa="zamknij" rozmiar={16} />
            </button>
          </div>

          <Uczestnicy messenger={messenger} groupId={groupId} onBlad={onBlad} />
        </aside>
      )}
        </>
      )}
    </div>
  );
}

/** Panel boczny — na wąskim ekranie ten sam kod ląduje na dole. */
function Nawigacja({
  galaz,
  onGalaz,
  nieprzeczytane,
  stanSieci,
}: {
  galaz: Galaz;
  onGalaz: (g: Galaz) => void;
  nieprzeczytane: number;
  stanSieci: StanPolaczenia;
}) {
  const galezie: { klucz: Galaz; ikona: NazwaIkony; etykieta: string }[] = [
    { klucz: "rozmowy", ikona: "rozmowy", etykieta: "Rozmowy" },
    { klucz: "kontakty", ikona: "kontakty", etykieta: "Kontakty" },
    { klucz: "konto", ikona: "konto", etykieta: "Konto" },
  ];

  const siec = opisSieci(stanSieci);

  return (
    <nav className="sidebar" aria-label="Nawigacja">
      <div className="marka">
        <ZnakMarki />
        <span>mekamb</span>
      </div>

      {galezie.map((g) => (
        <button
          key={g.klucz}
          className={galaz === g.klucz ? "galaz aktywna" : "galaz"}
          aria-current={galaz === g.klucz ? "page" : undefined}
          onClick={() => onGalaz(g.klucz)}
        >
          <Ikona nazwa={g.ikona} rozmiar={18} />
          {g.etykieta}
          {g.klucz === "rozmowy" && nieprzeczytane > 0 && (
            <span className="znacznik">{nieprzeczytane}</span>
          )}
        </button>
      ))}

      <div className="stopka-sidebara">
        {/* Stan połączenia jest tu istotny, nie ozdobny: przy zerwanej sieci
            wiadomości nie przychodzą, a użytkownik ma prawo wiedzieć dlaczego. */}
        <span
          className={siec.uwaga ? "tryb uwaga" : "tryb"}
          title="Wiadomości idą przez serwer — nie da się inaczej w przeglądarce."
        >
          <Ikona nazwa={siec.ikona} rozmiar={13} />
          {siec.tekst}
        </span>

        <WyborMotywuUI />
      </div>
    </nav>
  );
}

function PanelListy({
  rozmowy,
  wszystkich,
  szukane,
  onSzukane,
  nazwaPozycji,
  otwarta,
  onOtworz,
  onUsun,
}: {
  rozmowy: PozycjaListy[];
  wszystkich: number;
  szukane: string;
  onSzukane: (s: string) => void;
  nazwaPozycji: (p: PozycjaListy) => string;
  otwarta: Uint8Array | null;
  onOtworz: (p: PozycjaListy) => void;
  onUsun: (p: PozycjaListy) => void;
}) {
  const kluczOtwartej = otwarta ? kluczRozmowy(otwarta) : null;

  return (
    <aside className="panel-listy" aria-label="Lista rozmów">
      <div className="panel-listy-naglowek">
        <h2>Rozmowy</h2>
      </div>

      {/* Szukanie pojawia się dopiero, gdy jest w czym szukać — pole nad pustą
          listą jest obietnicą bez pokrycia. */}
      {wszystkich > 0 && (
        <div className="szukanie">
          <Ikona nazwa="szukaj" rozmiar={15} />
          <input
            type="search"
            value={szukane}
            onChange={(e) => onSzukane(e.target.value)}
            placeholder="Szukaj"
            aria-label="Szukaj rozmowy"
          />
        </div>
      )}

      {wszystkich === 0 ? (
        <Pusto
          ikona="rozmowy"
          tytul="Nie masz jeszcze żadnej rozmowy"
          wskazowka="Zacznij od kontaktu — wystarczy nazwa użytkownika."
        />
      ) : rozmowy.length === 0 ? (
        <Pusto ikona="szukaj" tytul="Nic nie pasuje" wskazowka="Szukamy po nazwie i po ostatniej wiadomości." />
      ) : (
        <ul className="lista-rozmow">
          {rozmowy.map((pozycja) => {
            const klucz = kluczRozmowy(pozycja.groupId);

            return (
              <WierszRozmowy
                key={klucz}
                pozycja={pozycja}
                nazwa={nazwaPozycji(pozycja)}
                otwarta={klucz === kluczOtwartej}
                onOtworz={() => onOtworz(pozycja)}
                onUsun={() => onUsun(pozycja)}
              />
            );
          })}
        </ul>
      )}

    </aside>
  );
}

/**
 * Wiersz listy rozmów z gestem „przeciągnij w lewo, żeby usunąć".
 *
 * # Dlaczego gest, a nie widoczny przycisk
 *
 * Kasowanie jest nieodwracalne (historia jest tylko tutaj), więc nie ma być
 * pod ręką na jedno dotknięcie obok „otwórz". Gest wymaga świadomego ruchu,
 * a przycisk „Usuń" spod spodu daje jeszcze chwilę na wycofanie się — puszczenie
 * palca przed progiem cofa wiersz na miejsce.
 *
 * Gest liczy się jako poziomy dopiero, gdy przesunięcie w bok wyraźnie wygrywa
 * z pionowym; inaczej każde przewinięcie listy kciukiem odsłaniałoby kosze.
 */
function WierszRozmowy({
  pozycja,
  nazwa,
  otwarta,
  onOtworz,
  onUsun,
}: {
  pozycja: PozycjaListy;
  nazwa: string;
  otwarta: boolean;
  onOtworz: () => void;
  onUsun: () => void;
}) {
  // Ile odsłonić pod wierszem i od którego progu puszczenie palca kasuje.
  const SZEROKOSC_AKCJI = 88;
  const PROG_USUNIECIA = 64;

  const [przesuniecie, setPrzesuniecie] = useState(0);
  const [odsloniete, setOdsloniete] = useState(false);
  const start = useRef<{ x: number; y: number } | null>(null);
  const kierunek = useRef<"nieznany" | "poziomy" | "pionowy">("nieznany");

  const zakonczGest = () => {
    // Za progiem kasujemy; bliżej — chowamy albo zostawiamy odsłonięty przycisk.
    if (przesuniecie <= -PROG_USUNIECIA) {
      onUsun();
      setPrzesuniecie(0);
      setOdsloniete(false);
    } else if (przesuniecie <= -SZEROKOSC_AKCJI / 2) {
      setPrzesuniecie(-SZEROKOSC_AKCJI);
      setOdsloniete(true);
    } else {
      setPrzesuniecie(0);
      setOdsloniete(false);
    }
    start.current = null;
    kierunek.current = "nieznany";
  };

  return (
    <li className="pozycja-rozmowy">
      <button
        type="button"
        className="wiersz-usun"
        aria-label={`Usuń rozmowę z ${nazwa}`}
        onClick={onUsun}
        tabIndex={odsloniete ? 0 : -1}
      >
        <Ikona nazwa="kosz" rozmiar={20} />
        <span>Usuń</span>
      </button>

      <button
        className={otwarta ? "wiersz-rozmowy otwarta" : "wiersz-rozmowy"}
        style={{
          transform: `translateX(${przesuniecie}px)`,
          transition: start.current ? "none" : "transform .18s ease",
        }}
        onClick={() => {
          // Odsłonięty kosz przechwytuje dotknięcie na schowanie, a nie na
          // wejście do rozmowy — inaczej „cofnięcie" gestu otwierałoby wątek.
          if (odsloniete) {
            setPrzesuniecie(0);
            setOdsloniete(false);
            return;
          }
          onOtworz();
        }}
        onTouchStart={(e) => {
          const t = e.touches[0];
          if (!t) return;
          start.current = { x: t.clientX, y: t.clientY };
          kierunek.current = "nieznany";
        }}
        onTouchMove={(e) => {
          const t = e.touches[0];
          if (!start.current || !t) return;
          const dx = t.clientX - start.current.x;
          const dy = t.clientY - start.current.y;

          if (kierunek.current === "nieznany") {
            if (Math.abs(dx) < 8 && Math.abs(dy) < 8) return;
            // Pionowy gest zostaje przewijaniem listy — wiersza nie ruszamy.
            kierunek.current = Math.abs(dx) > Math.abs(dy) ? "poziomy" : "pionowy";
          }
          if (kierunek.current !== "poziomy") return;

          const bazowe = odsloniete ? -SZEROKOSC_AKCJI : 0;
          // Tylko w lewo, z lekkim oporem za odsłoniętą szerokością.
          setPrzesuniecie(Math.max(-SZEROKOSC_AKCJI - 24, Math.min(0, bazowe + dx)));
        }}
        onTouchEnd={zakonczGest}
        onTouchCancel={zakonczGest}
      >
        <span className="awatar" aria-hidden="true">
          {nazwa.slice(0, 1)}
        </span>

        <span className="wiersz-tresc">
          <span className="wiersz-gora">
            <span className="wiersz-nazwa">{nazwa}</span>
            {pozycja.ostatnia && <span className="wiersz-czas">{godzina(pozycja.ostatnia.czas)}</span>}
          </span>

          <span className="wiersz-ostatnia">
            {pozycja.ostatnia?.zalacznik && <Ikona nazwa="spinacz" rozmiar={13} />}
            <span className="tekst">
              {pozycja.ostatnia
                ? (pozycja.ostatnia.wlasna ? "Ty: " : "") + zapowiedz(pozycja.ostatnia)
                : "brak wiadomości"}
            </span>
          </span>
        </span>

        {pozycja.nieprzeczytane > 0 && <span className="znacznik">{pozycja.nieprzeczytane}</span>}
      </button>
    </li>
  );
}

/** Otwarta rozmowa: nagłówek, wiadomości, pole pisania. */
function Watek({
  messenger,
  groupId,
  rozmowca,
  wiadomosci,
  wLocie,
  setWiadomosci,
  setWLocie,
  tresc,
  setTresc,
  stanSieci,
  setZadanieRozmowy,
  inspektorOtwarty,
  setInspektorOtwarty,
  onBlad,
}: {
  messenger: Messenger;
  groupId: Uint8Array;
  rozmowca: string;
  wiadomosci: Wiadomosc[];
  wLocie: WLocie[];
  setWiadomosci: React.Dispatch<React.SetStateAction<Wiadomosc[]>>;
  setWLocie: React.Dispatch<React.SetStateAction<WLocie[]>>;
  tresc: string;
  setTresc: (t: string) => void;
  stanSieci: StanPolaczenia;
  setZadanieRozmowy: (z: ZadanieRozmowy) => void;
  inspektorOtwarty: boolean;
  setInspektorOtwarty: (o: boolean | ((o: boolean) => boolean)) => void;
  onBlad: (e: unknown) => void;
}) {
  const lista = useRef<HTMLOListElement | null>(null);
  const pole = useRef<HTMLTextAreaElement | null>(null);
  const siec = opisSieci(stanSieci);

  /*
   * Wiadomości w locie idą przez ten sam układ co reszta.
   *
   * Rysowane osobno pod listą wypadały spod rozdzielacza dnia i nie sklejały
   * się z poprzednim dymkiem — wysłanie wiadomości rozbijało blok, który po
   * potwierdzeniu z powrotem się zrastał. Widać było skok.
   */
  const wszystkie = useMemo(
    () => [
      ...wiadomosci,
      ...wLocie.map((w) => ({ id: w.id, autor: "Ty", tresc: w.tresc, czas: w.czas, wlasna: true })),
    ],
    [wiadomosci, wLocie],
  );

  const stanyWysylki = useMemo(() => new Map(wLocie.map((w) => [w.id, w])), [wLocie]);
  const uklad = useMemo(() => ulozWatek(wszystkie, Date.now()), [wszystkie]);

  /*
   * Zjazd na dół po nowej wiadomości.
   *
   * Tylko wtedy, gdy użytkownik już był na dole. Przewijanie do dołu komuś,
   * kto czyta starszą część rozmowy, wyrywa mu tekst sprzed oczu — a nowa
   * wiadomość i tak zostanie zauważona, bo lista ma znacznik.
   */
  const naDole = useRef(true);
  useEffect(() => {
    const el = lista.current;
    if (el && naDole.current) el.scrollTop = el.scrollHeight;
  }, [uklad.length]);

  // Pole rośnie z treścią. Wysokość zerujemy przed odczytem `scrollHeight`,
  // bo inaczej pole raz urośnięte nigdy już nie zmaleje.
  useEffect(() => {
    const el = pole.current;
    if (!el) return;

    el.style.height = "auto";
    el.style.height = `${el.scrollHeight}px`;
  }, [tresc]);

  const wyslij = async () => {
    if (!tresc.trim()) return;

    // Wiadomość pojawia się natychmiast ze znacznikiem „wysyłam". Wcześniej
    // przez cały czas wysyłki — a przy nieudanej próbie bezpośredniej to kilka
    // sekund — nie działo się nic i nie było wiadomo, czy cokolwiek poszło.
    //
    // Identyfikator „w locie" jest tymczasowy i służy tylko do znalezienia tego
    // dymka po powrocie z wysyłki. Do historii trafia identyfikator Z RDZENIA:
    // potwierdzenia drugiej strony wskazują wiadomości właśnie po nim, więc
    // zapisanie własnego UUID-a znaczyłoby ptaszek, który nigdy się nie zmieni.
    const id = crypto.randomUUID();
    const wyslana = tresc;
    setWLocie((p) => [...p, { id, tresc: wyslana, czas: Date.now(), blad: false }]);
    setTresc("");

    try {
      const messageId = await messenger.sendText(groupId, wyslana);

      setWiadomosci((p) => [
        ...p,
        { id: messageId, autor: "Ty", tresc: wyslana, czas: Date.now(), wlasna: true },
      ]);
      setWLocie((p) => p.filter((w) => w.id !== id));
    } catch (err) {
      // Zostaje w locie, oznaczona jako nieudana. Treść nie przepada:
      // zawiodła sieć, nie użytkownik.
      setWLocie((p) => p.map((w) => (w.id === id ? { ...w, blad: true } : w)));
      onBlad(err);
    }
  };

  return (
    <div className="watek">
      <header className="pasek-watku">
        {/* Na wąskim ekranie rozmowa zajmuje cały widok, więc bez tego nie ma
            jak wrócić do listy. Na szerokim lista stoi obok i strzałka jest
            zbędna — chowa ją arkusz stylów. */}
        <button
          className="ikonowy wstecz"
          aria-label="Wróć do listy rozmów"
          onClick={() => history.back()}
        >
          <Ikona nazwa="wstecz" rozmiar={18} />
        </button>

        <span className="awatar" aria-hidden="true">
          {rozmowca.slice(0, 1)}
        </span>

        <span className="pasek-tozsamosc">
          <span className="pasek-nazwa">{rozmowca}</span>
          {/* Droga dostarczania przy nazwie, nie w ustawieniach: „przez serwer"
              to zdanie o tym, kto widzi metadane. */}
          <span className={siec.uwaga ? "pasek-meta uwaga" : "pasek-meta"}>
            <Ikona nazwa={siec.ikona} rozmiar={12} />
            {siec.tekst}
          </span>
        </span>

        <div className="akcje-watku">
          <button
            className="ikonowy"
            title="Zadzwoń"
            onClick={() => setZadanieRozmowy({ wideo: false, n: Date.now() })}
          >
            <Ikona nazwa="sluchawka" rozmiar={18} etykieta="Zadzwoń" />
          </button>
          <button
            className="ikonowy"
            title="Rozmowa z obrazem"
            onClick={() => setZadanieRozmowy({ wideo: true, n: Date.now() })}
          >
            <Ikona nazwa="kamera" rozmiar={18} etykieta="Rozmowa z obrazem" />
          </button>
          <button
            className={inspektorOtwarty ? "ikonowy aktywny" : "ikonowy"}
            title="Uczestnicy i kod bezpieczeństwa"
            aria-pressed={inspektorOtwarty}
            onClick={() => setInspektorOtwarty((o) => !o)}
          >
            <Ikona nazwa="osoby" rozmiar={18} etykieta="Uczestnicy i kod bezpieczeństwa" />
          </button>
        </div>
      </header>

      {/* Rozmowy A/V tu NIE MA — jest osobnym ekranem ponad układem (`Czat`).
          Ślad po niej idzie do tej samej listy co wiadomości: rozmowa
          i wiadomość dzieją się w tej samej osi czasu i mają się w niej
          przeplatać. */}

      <ol
        className="wiadomosci"
        ref={lista}
        onScroll={(e) => {
          const el = e.currentTarget;
          naDole.current = el.scrollHeight - el.scrollTop - el.clientHeight < 80;
        }}
      >
        {/* W `<ol>` wolno stać tylko elementom `<li>` — pusty stan też. */}
        {uklad.length === 0 && (
          <li className="pusto-watku">
            <Pusto ikona="rozmowy" tytul="Tu jeszcze nic nie ma" wskazowka="Napisz pierwszy." />
          </li>
        )}

        {uklad.map((pozycja) =>
          pozycja.rodzaj === "dzien" ? (
            <li key={pozycja.klucz} className="dzien">
              {pozycja.etykieta}
            </li>
          ) : (
            pozycja.wiadomosc.rozmowa ? (
              <ZdarzenieRozmowy
                key={pozycja.klucz}
                wiadomosc={pozycja.wiadomosc}
                rozmowa={pozycja.wiadomosc.rozmowa}
              />
            ) : (
              <Dymek
                key={pozycja.klucz}
                messenger={messenger}
                wiadomosc={pozycja.wiadomosc}
                ciag={pozycja.ciag}
                stan={stanyWysylki.get(pozycja.wiadomosc.id)}
                onBlad={onBlad}
              />
            )
          ),
        )}
      </ol>

      <form
        className="pisanie"
        onSubmit={(e) => {
          e.preventDefault();
          void wyslij();
        }}
      >
        <DolaczPlik
          messenger={messenger}
          groupId={groupId}
          setWiadomosci={setWiadomosci}
          setWLocie={setWLocie}
          onBlad={onBlad}
        />

        <textarea
          ref={pole}
          rows={1}
          value={tresc}
          onChange={(e) => setTresc(e.target.value)}
          placeholder="Napisz wiadomość"
          aria-label="Treść wiadomości"
          onKeyDown={(e) => {
            /*
             * Enter wysyła, Shift+Enter łamie wiersz.
             *
             * Odwrotnie niż w formularzu, bo to pole rozmowy: wysłanie jest tu
             * czynnością wykonywaną co kilkanaście sekund, a nowy akapit —
             * rzadko. Wymuszanie kliknięcia w przycisk przy każdej wiadomości
             * jest kosztem płaconym setki razy dziennie.
             */
            if (e.key === "Enter" && !e.shiftKey && !e.nativeEvent.isComposing) {
              e.preventDefault();
              void wyslij();
            }
          }}
        />

        <button className="wyslij" disabled={!tresc.trim()} title="Wyślij">
          <Ikona nazwa="wyslij" rozmiar={18} etykieta="Wyślij" />
        </button>
      </form>

      {/* Obietnica przed wysłaniem, nie po. Po fakcie nie daje już wyboru. */}
      <p className="wskazowka-plik">
        <Ikona nazwa="tarcza" rozmiar={12} />
        Ze zdjęć i nagrań usuwamy lokalizację oraz dane urządzenia przed wysłaniem.
      </p>
    </div>
  );
}

/**
 * Ślad po rozmowie A/V w wątku.
 *
 * # Dlaczego to nie jest dymek
 *
 * Bo nikt tego nie powiedział. Dymek — z bokiem, ogonkiem i godziną przy
 * własnej krawędzi — mówi „ta osoba napisała to zdanie". Rozmowa się wydarzyła,
 * a nie została wysłana, więc stoi na środku, tak samo jak rozdzielacz dnia.
 *
 * Ikona jest DOKŁADNIE ta, którą się w tę rozmowę weszło: słuchawka przy
 * głosowej, kamera przy wideo. Inny piktogram w podsumowaniu niż na przycisku
 * kazałby się domyślać, że to o tym samym.
 */
function ZdarzenieRozmowy({
  wiadomosc,
  rozmowa,
}: {
  wiadomosc: Wiadomosc;
  rozmowa: ZapisRozmowy;
}) {
  const odbyta = rozmowa.sekundy !== undefined;

  // Nieodebrana wychodząca to „nikt nie odebrał", przychodząca — „nie odebrałeś".
  // To dwie różne rzeczy i tylko druga jest czymś, co się przegapiło.
  const opis = odbyta
    ? `${rozmowa.wideo ? "Rozmowa wideo" : "Rozmowa głosowa"} · ${trwanieRozmowy(rozmowa.sekundy ?? 0)}`
    : rozmowa.wychodzaca
      ? "Nikt nie odebrał"
      : `Nieodebrana rozmowa ${rozmowa.wideo ? "wideo" : "głosowa"}`;

  return (
    <li className={odbyta ? "zdarzenie" : "zdarzenie nieodebrane"}>
      <Ikona nazwa={rozmowa.wideo ? "kamera" : "sluchawka"} rozmiar={14} />
      <span>{opis}</span>
      <span className="czas-zdarzenia">{godzina(wiadomosc.czas)}</span>
    </li>
  );
}

/** Czas trwania jako `m:ss`; godziny dopiero wtedy, gdy są. */
function trwanieRozmowy(sekundy: number): string {
  const s = Math.max(0, Math.floor(sekundy));
  const minuty = Math.floor(s / 60);
  const reszta = String(s % 60).padStart(2, "0");

  if (minuty < 60) return `${minuty}:${reszta}`;
  return `${Math.floor(minuty / 60)}:${String(minuty % 60).padStart(2, "0")}:${reszta}`;
}

function Dymek({
  messenger,
  wiadomosc,
  ciag,
  stan,
  onBlad,
}: {
  messenger: Messenger;
  wiadomosc: Wiadomosc;
  ciag: boolean;
  stan?: WLocie;
  onBlad: (e: unknown) => void;
}) {
  const klasy = ["", wiadomosc.wlasna ? "wlasna" : "", ciag ? "ciag" : ""];
  if (stan) klasy.push(stan.blad ? "nieudana" : "w-locie");

  /*
   * Jeden stan zamiast trzech warunków rozsypanych po JSX.
   *
   * Wysyłka w locie ma pierwszeństwo nad zapisanym stanem: dopóki nie wróciło
   * potwierdzenie wysłania, potwierdzenia odczytu nie ma prawa być.
   */
  const stanWysylki = stan
    ? stan.blad
      ? "nieudana"
      : "w-locie"
    : (wiadomosc.stan ?? "wyslane");

  const opis = opisStanu(stanWysylki);

  return (
    <li className={klasy.join(" ").trim()}>
      {/* Autor tylko na początku bloku i tylko przy cudzych — przy własnych
          mówi to strona dymka, a powtórzony przy każdej wiadomości jest szumem. */}
      {!wiadomosc.wlasna && !ciag && <span className="autor">{wiadomosc.autor}</span>}

      {/*
        Załącznik i treść mogą stać w jednym dymku.

        Wcześniej było to „albo — albo", więc wiadomość z obrazem nie miała jak
        nieść zdania o tym, że z tego pliku nie udało się usunąć metadanych.
        Zdanie przepadało albo zajmowało miejsce obrazu.
      */}
      {wiadomosc.zalacznik && (
        <Zalacznik messenger={messenger} zalacznik={wiadomosc.zalacznik} onBlad={onBlad} />
      )}
      {wiadomosc.tresc && <span className="tresc">{wiadomosc.tresc}</span>}

      <span className={stanWysylki === "przeczytane" ? "stopka-dymka przeczytana" : "stopka-dymka"}>
        {godzina(wiadomosc.czas)}
        {wiadomosc.wlasna && <Ikona nazwa={opis.ikona} rozmiar={13} etykieta={opis.etykieta} />}
      </span>
    </li>
  );
}

/**
 * Spinacz przy polu, nie prostokąt nad nim.
 *
 * Wielki obszar „Dołącz zdjęcie lub wideo" zajmował tyle miejsca co dwie
 * wiadomości i podpowiadał, że załącznik jest głównym sposobem pisania.
 */
function DolaczPlik({
  messenger,
  groupId,
  setWiadomosci,
  setWLocie,
  onBlad,
}: {
  messenger: Messenger;
  groupId: Uint8Array;
  setWiadomosci: React.Dispatch<React.SetStateAction<Wiadomosc[]>>;
  setWLocie: React.Dispatch<React.SetStateAction<WLocie[]>>;
  onBlad: (e: unknown) => void;
}) {
  return (
    <label className="dolacz-plik" title="Dołącz zdjęcie lub wideo">
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
          setWLocie((p) => [
            ...p,
            { id, tresc: `wysyłam: ${plik.name}`, czas: Date.now(), blad: false },
          ]);

          try {
            const { stripped, messageId, zalacznik } = await messenger.sendFile(groupId, plik);

            /*
             * Własne zdjęcie jest ZDJĘCIEM, nie napisem „wysłano: kot.jpg".
             *
             * Tak było wcześniej i wyglądało na uszkodzoną wiadomość: druga
             * strona widziała obraz, nadawca nazwę pliku. Opis załącznika wraca
             * teraz z `sendFile`, więc własny dymek rysuje ten sam składnik co
             * cudzy i odszyfrowuje ten sam szyfrogram.
             *
             * Treść zostaje pusta, gdy wszystko poszło dobrze. Nieudane
             * czyszczenie metadanych mówimy wprost — użytkownik ma prawo
             * wiedzieć, że akurat ten plik poszedł ze współrzędnymi, i jest to
             * jedyna rzecz, z którą może coś zrobić.
             */
            setWiadomosci((p) => [
              ...p,
              {
                id: messageId,
                autor: "Ty",
                tresc: stripped ? "" : "nie udało się usunąć metadanych z tego pliku",
                czas: Date.now(),
                wlasna: true,
                zalacznik,
              },
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
      <Ikona nazwa="spinacz" rozmiar={18} />
      <span className="tylko-dla-czytnika">Dołącz zdjęcie lub wideo</span>
    </label>
  );
}

/**
 * Rozpoczęcie rozmowy z nazwy użytkownika.
 *
 * Katalog nie ma listy do przeglądania i to jest decyzja, nie brak: lista
 * wszystkich użytkowników mówiłaby każdemu, kto jest w systemie.
 */
function Kontakty({ onRozpocznij }: { onRozpocznij: (nazwa: string) => void }) {
  const [nazwa, setNazwa] = useState("");

  return (
    <>
      <header className="naglowek-konta">
        <h2>Nowa rozmowa</h2>
        <p className="wskazowka">Rozmowę zaczyna się od nazwy, którą już się zna.</p>
      </header>

      <div className="siatka-konta">
        <form
          className="karta"
          onSubmit={(e) => {
            e.preventDefault();
            if (nazwa.trim()) onRozpocznij(nazwa.trim());
          }}
        >
          <label>
            Z kim chcesz rozmawiać
            <input value={nazwa} onChange={(e) => setNazwa(e.target.value)} required />
          </label>

          <button className="glowny" disabled={!nazwa.trim()}>
            <Ikona nazwa="rozmowy" rozmiar={16} />
            Rozpocznij rozmowę
          </button>
        </form>
      </div>
    </>
  );
}

function Konto({
  messenger,
  stanSieci,
  trwaly,
  odczyt,
  onOdczyt,
  onBlad,
}: {
  messenger: Messenger;
  stanSieci: StanPolaczenia;
  trwaly: boolean;
  odczyt: boolean;
  onOdczyt: (wlaczony: boolean) => void;
  onBlad: (e: unknown) => void;
}) {
  const siec = opisSieci(stanSieci);

  return (
    <>
      <header className="naglowek-konta">
        <h2>Konto</h2>
      </header>

      <div className="siatka-konta">
        <div className="karta">
          <div className="tozsamosc">
            <span className="awatar" aria-hidden="true">
              {messenger.account.username.slice(0, 1)}
            </span>
            <span>
              <strong>{messenger.account.username}</strong>
              <span className="wskazowka">{messenger.account.deviceId}</span>
            </span>
          </div>

          {/*
            Stan konta powiedziany po ludzku.

            „Trwały magazyn: nieprzyznany" i „Aplikacja zainstalowana: nie" to
            były odpowiedzi na pytania, których nikt nie zadał — nazwy
            wewnętrznych mechanizmów przepisane wprost na ekran. Zostaje to,
            co daje się z czymś zrobić: czy rozmowy są bezpieczne na tym
            urządzeniu i czy w tej chwili cokolwiek dochodzi.

            Wiersz o pamięci pojawia się DOPIERO, gdy jest źle. Napis
            „przyznany" przy działającej rzeczy nie mówi nic; ostrzeżenie
            o tym, że przeglądarka może skasować rozmowy, mówi bardzo dużo —
            i wtedy trzeba je przeczytać.
          */}
          <dl className="stan-konta">
            <div>
              <dt>Wiadomości</dt>
              <dd className={siec.uwaga ? "uwaga" : undefined}>
                <Ikona nazwa={siec.ikona} rozmiar={13} />
                {stanSieci === "polaczone"
                  ? "dochodzą"
                  : stanSieci === "laczenie"
                    ? "łączę…"
                    : "brak połączenia"}
              </dd>
            </div>

            {!trwaly && (
              <div>
                <dt>Pamięć</dt>
                <dd className="uwaga">
                  <Ikona nazwa="ostrzezenie" rozmiar={13} />
                  przeglądarka może usunąć rozmowy
                </dd>
              </div>
            )}
          </dl>
        </div>

        {/*
          Potwierdzenia odczytu w panelu konta, nie w ustawieniach rozmowy.

          To decyzja o tym, ile o sobie mówisz — dotyczy każdej rozmowy naraz,
          więc miejscem jest konto, a nie pojedynczy wątek.
        */}
        {/*
          Z opisu zostało jedno zdanie: to, które zmienia decyzję.
          Reszta — opóźnienie, zbiorcza wysyłka, „moment wysłania koperty" —
          opisywała, JAK to zrobiliśmy. Kto to czyta, nie ma z tego czego
          wybrać, a słowo „koperta" znaczy coś tylko dla nas.
        */}
        <div className="karta">
          <strong>Potwierdzenia odczytu</strong>

          <label className="przelacznik">
            <input
              type="checkbox"
              checked={odczyt}
              onChange={(e) => onOdczyt(e.target.checked)}
            />
            <span>Wysyłaj potwierdzenia odczytu</span>
          </label>

          <p className="wskazowka">
            Kiedy je wyłączysz, przestaniesz też widzieć cudze.
          </p>
        </div>

        {/* Bez opisu: przełącznik z trzema podpisanymi opcjami mówi wszystko,
            co da się o nim powiedzieć. */}
        <div className="karta">
          <strong>Wygląd</strong>
          <WyborMotywuUI />
        </div>

        <Urzadzenia messenger={messenger} onBlad={onBlad} />

        <PrzeniesStad token={messenger.accessToken} onBlad={onBlad} />

        <PasskeyZarzadzanie messenger={messenger} onBlad={onBlad} />

        <ZglosBlad token={messenger.accessToken} />

        {/*
          To zdanie ZOSTAJE i zostaje w całości.

          Nie jest opisem mechanizmu — jest jedyną informacją, przez którą ktoś
          może stracić wszystkie swoje rozmowy, jeśli jej nie przeczyta. Skrócone
          do „rozmowy są zapisane lokalnie" nie mówi już, co z tego wynika ani co
          zrobić, zanim będzie za późno.
        */}
        <div className="karta">
          <strong>Twoje rozmowy</strong>
          <p className="wskazowka-ikona">
            <Ikona nazwa="klucz" rozmiar={14} />
            Są zapisane tylko na tym urządzeniu — nie mamy ich kopii i nie
            odtworzymy ich nikomu. Zanim zmienisz telefon, przenieś konto.
          </p>
        </div>
      </div>

      {/*
        Kasowanie w osobnej strefie, na dole i za linią.

        Nieodwracalne obok odwracalnego to zaproszenie do pomyłki — a tej
        pomyłki nie da się cofnąć, bo historii nie ma nigdzie indziej.
      */}
      <section className="strefa-kasowania">
        <strong>Usunięcie konta z tego urządzenia</strong>
        <p className="wskazowka">Historii nie da się odzyskać — nigdzie jej nie zapisujemy.</p>

        <button
          className="niszczacy"
          onClick={async () => {
            if (confirm("Usunąć konto z tego urządzenia? Historii nie da się odzyskać.")) {
              // Najlepszy wysiłek: nawet gdy się nie powiedzie (offline),
              // lokalne skasowanie musi zajść — użytkownik prosił o usunięcie
              // danych na TYM urządzeniu, niezależnie od stanu sieci.
              await logout(messenger.account.deviceId).catch(() => {});
              await wipe();
              location.reload();
            }
          }}
        >
          <Ikona nazwa="kosz" rozmiar={16} />
          Usuń konto z tego urządzenia
        </button>
      </section>
    </>
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
        <Ikona nazwa={zarejestrowano ? "wyslane" : "blokada"} rozmiar={16} />
        {zarejestrowano ? "Passkey dodany" : pracuje ? "Dodaję…" : "Dodaj passkey"}
      </button>
    </div>
  );
}
