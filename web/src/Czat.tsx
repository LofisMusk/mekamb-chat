import { useCallback, useEffect, useMemo, useRef, useState } from "react";

import { Ikona, type NazwaIkony } from "./Ikony";
import { Rozmowa, type SygnalRozmowy, type ZadanieRozmowy } from "./Rozmowa";
import { Uczestnicy } from "./Uczestnicy";
import { Zalacznik } from "./Zalacznik";
import { Pusto, WyborMotywuUI, ZnakMarki } from "./Wspolne";
import { Urzadzenia } from "./Parowanie";
import { ZglosBlad } from "./Zgloszenie";
import { api } from "./lib/api";
import {
  logout,
  totpChangeConfirm,
  totpChangeOptions,
  totpChangeStartKodem,
  totpChangeStartPasskeyem,
  webauthnRegisterOptions,
  webauthnRegisterVerify,
} from "./lib/auth";
import { KodQr } from "./KodQr";
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
  zapewnijRozmowe,
  zapiszRozmowe,
} from "./lib/historia";
import {
  type ZapisNazw,
  ustawMojNick,
  ustawNazweGrupy,
  ustawNick,
  wczytajNazwy,
} from "./lib/nazwy";
import {
  wczytajProsby,
  zaakceptuj as zaakceptujProsbe,
  zainicjuj as zainicjujProsby,
  zapomnij as zapomnijProsbe,
} from "./lib/prosby";
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
import { createPasskey, getPasskey, isPasskeySupported } from "./lib/passkey";
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
 * Pełna data i godzina — do `title` dymka.
 *
 * Rozdzielacz mówi, kiedy zaczął się kawałek rozmowy; to mówi, kiedy padło
 * TO zdanie. Nie zajmuje ani jednego piksela, dopóki ktoś nie zapyta.
 */
const PELNA_GODZINA = new Intl.DateTimeFormat(undefined, {
  dateStyle: "medium",
  timeStyle: "short",
});

function pelnaGodzina(czas: number): string {
  return PELNA_GODZINA.format(new Date(czas));
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

type Galaz = "rozmowy" | "konto";

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

  /**
   * Czy rozmowy z dysku są już otwarte w rdzeniu.
   *
   * Brama dla połączenia ze skrzynką: koperta, która przyjdzie przed
   * otwarciem rozmów, nie pasuje do niczego i zostaje potwierdzona jako
   * pusta — czyli przepada. Szczegóły przy efekcie łączenia.
   */
  const [rozmowyOtwarte, setRozmowyOtwarte] = useState(false);
  const [galaz, setGalaz] = useState<Galaz>("rozmowy");
  const [rozmowy, setRozmowy] = useState<PozycjaListy[]>([]);
  const [szukane, setSzukane] = useState("");

  /*
   * Współdzielone nazwy: nazwy grup (po kluczu grupy) i nicki (po nazwie
   * użytkownika), plus własny nick. WARSTWA WYŚWIETLANIA — tożsamością w MLS
   * i adresem skrzynki zostaje nazwa użytkownika. Zasiewane z dysku przy
   * starcie, aktualizowane metadaną z rdzenia (patrz `naMetadane`).
   */
  const [nicki, setNicki] = useState<Record<string, string>>({});
  const [nazwyGrup, setNazwyGrup] = useState<Record<string, string>>({});
  const [mojNick, setMojNick] = useState("");

  /*
   * Zbiór zaakceptowanych rozmów (klucze grup). Rozmowa w historii, ale spoza
   * tego zbioru, jest PROŚBĄ — pokazywaną osobno, nie między rozmowami.
   */
  const [zaakceptowane, setZaakceptowane] = useState<Set<string>>(new Set());

  /*
   * Obsługa dołączenia do nowej rozmowy (Welcome) czyta bieżący zbiór
   * zaakceptowanych przez referencję: wołanie zwrotne z messengera ustawiamy
   * raz i nie chcemy go przepinać przy każdej zmianie zbioru.
   */
  const zaakceptowaneRef = useRef(zaakceptowane);
  zaakceptowaneRef.current = zaakceptowane;

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
  // Licznik liczy TYLKO rozmowy zaakceptowane — prośba nie ma prawa udawać
  // „nowej wiadomości", bo to jest dokładnie ta zapora, o którą chodzi.
  const nieprzeczytane = rozmowy.reduce(
    (suma, p) => (zaakceptowane.has(kluczRozmowy(p.groupId)) ? suma + p.nieprzeczytane : suma),
    0,
  );

  /*
   * Nazwa pozycji na liście, z naprawą wstecz.
   *
   * Rozmowy zapisane przed poprawką mają nazwę pustą, a wiersz bez imienia
   * i bez awatara nie mówi nic o tym, z kim się rozmawia. Skład z drzewa MLS
   * odtwarza ją bez pytania serwera o cokolwiek — a gdy i tego nie ma (grupa
   * spoza stanu MLS, np. na świeżo sparowanym urządzeniu), mówimy wprost, że
   * nazwy nie znamy, zamiast pokazywać pusty wiersz.
   */
  /**
   * Nick rozmówcy, jeśli go znamy — inaczej surowa nazwa użytkownika.
   *
   * Nick jest WYŁĄCZNIE warstwą wyświetlania: pod spodem zostaje nazwa
   * użytkownika, bo to ona jest tożsamością MLS i adresem skrzynki.
   */
  const nick = useCallback(
    (username: string): string => nicki[username]?.trim() || username,
    [nicki],
  );

  /**
   * Etykieta rozmowy: nazwa grupy, a gdy jej nie ma — sklejone nicki uczestników.
   *
   * Nazwa grupy (współdzielona metadana) wygrywa nad sklejaniem nazw. Bez niej
   * wracamy do składu z drzewa MLS, ale każdą osobę pokazujemy jej nickiem,
   * jeśli go znamy. Pusto znaczy „sami" albo „grupa bez stanu MLS".
   */
  const etykietaGrupy = useCallback(
    (groupId: Uint8Array): string => {
      const nazwa = nazwyGrup[kluczRozmowy(groupId)];
      if (nazwa && nazwa.trim()) return nazwa.trim();

      try {
        const inni = messenger
          .memberUserIds(groupId)
          .filter((osoba) => osoba !== messenger.account.userId);
        if (inni.length === 0) return "";
        return inni.map(nick).join(", ");
      } catch {
        return "";
      }
    },
    [nazwyGrup, nick, messenger],
  );

  const nazwaPozycji = useCallback(
    (pozycja: PozycjaListy): string => {
      const etykieta = etykietaGrupy(pozycja.groupId);
      if (etykieta) return etykieta;
      // Grupa bez stanu MLS: zostaje surowa nazwa zapisana na dysku.
      return pozycja.rozmowca || "rozmowa bez nazwy";
    },
    [etykietaGrupy],
  );

  /*
   * Rozmowy dzielą się na zaakceptowane i prośby. Prośba to rozmowa obecna
   * w historii, ale spoza zbioru zaakceptowanych — trafia do osobnej sekcji,
   * nie między rozmowy, i nie podbija licznika nieprzeczytanych.
   */
  const zaakceptowaneRozmowy = useMemo(
    () => rozmowy.filter((p) => zaakceptowane.has(kluczRozmowy(p.groupId))),
    [rozmowy, zaakceptowane],
  );
  const prosby = useMemo(
    () => rozmowy.filter((p) => !zaakceptowane.has(kluczRozmowy(p.groupId))),
    [rozmowy, zaakceptowane],
  );

  const widoczne = useMemo(
    () => filtrujRozmowy(zaakceptowaneRozmowy, szukane, nazwaPozycji),
    [zaakceptowaneRozmowy, szukane, nazwaPozycji],
  );

  /*
   * Kontakty = osoby z Twoich zaakceptowanych rozmów, bez duplikatów.
   *
   * To z nich „Nowa grupa" pozwala wybrać uczestników. Katalog nie ma listy do
   * przeglądania (to decyzja, nie brak), więc jedyni ludzie, których możemy
   * podpowiedzieć, to ci, z którymi już rozmawiamy.
   */
  const kontakty = useMemo(() => {
    const zbior = new Set<string>();
    for (const p of zaakceptowaneRozmowy) {
      try {
        for (const osoba of messenger.memberUserIds(p.groupId)) {
          if (osoba !== messenger.account.userId) zbior.add(osoba);
        }
      } catch {
        // Rozmowa bez stanu MLS nie wnosi kontaktów.
      }
    }
    return [...zbior].sort((a, b) => a.localeCompare(b));
  }, [zaakceptowaneRozmowy, messenger]);

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

  /**
   * Nanosi odebraną metadaną na mapy nazw — nazwa grupy i/lub nick nadawcy.
   *
   * Metadana NIE jest dymkiem: aktualizuje wyłącznie warstwę wyświetlania
   * i utrwala ją na dysku. `undefined` w polu znaczy „nadawca nie ruszał",
   * więc pomijamy je; `""` znaczy „wyczyścił" i wtedy kasujemy wpis (brak nazwy
   * to powrót do zachowania domyślnego).
   *
   * Własny nick z DRUGIEGO urządzenia trafia w `mojNick`, nie w mapę cudzych:
   * to ta sama osoba, więc ma się zsynchronizować, a nie pojawić jako obcy
   * kontakt.
   */
  const naMetadane = useCallback(
    (groupId: Uint8Array, senderUserId: string, metadata: { groupName?: string; displayName?: string }) => {
      if (metadata.groupName !== undefined) {
        void ustawNazweGrupy(groupId, metadata.groupName || undefined)
          .then((z) => setNazwyGrup({ ...z.grupy }))
          .catch(() => {});
      }

      if (metadata.displayName !== undefined) {
        if (senderUserId === messenger.account.userId) {
          void ustawMojNick(metadata.displayName)
            .then((z) => setMojNick(z.mojNick))
            .catch(() => {});
        } else {
          void ustawNick(senderUserId, metadata.displayName || undefined)
            .then((z) => setNicki({ ...z.nicki }))
            .catch(() => {});
        }
      }
    },
    [messenger],
  );

  /**
   * Dołączenie do NOWEJ rozmowy przez Welcome — rozstrzyga: prośba czy wprost.
   *
   * Kontakt = osoba, z którą mamy już rozmowę ZAAKCEPTOWANĄ. Jeśli którykolwiek
   * z uczestników nowej grupy jest kontaktem, rozmowa wchodzi wprost; inaczej
   * ląduje w prośbach. Rozmowę, którą zakładamy sami, akceptuje ścieżka jej
   * tworzenia — tu obsługujemy wyłącznie zaproszenia od innych.
   *
   * Zbiór zaakceptowanych czytamy przez referencję, bo wołanie zwrotne jest
   * przypięte do messengera raz i nie goni za każdą zmianą zbioru.
   */
  const obsluzDolaczenie = useCallback(
    async (groupId: Uint8Array, czlonkowie: string[]) => {
      const ja = messenger.account.userId;
      const inni = czlonkowie.filter((osoba) => osoba !== ja);

      const accepted = zaakceptowaneRef.current;
      const pozycje = await listaRozmow();
      const kontakty = new Set<string>();
      for (const p of pozycje) {
        if (!accepted.has(kluczRozmowy(p.groupId))) continue;
        try {
          for (const osoba of messenger.memberUserIds(p.groupId)) {
            if (osoba !== ja) kontakty.add(osoba);
          }
        } catch {
          // Rozmowa bez stanu MLS nie wnosi kontaktów — pomijamy.
        }
      }

      const jestKontaktem = inni.some((osoba) => kontakty.has(osoba));

      // Wiersz musi powstać nawet pusty, inaczej prośba nie ma się gdzie
      // pokazać (lista rośnie z historii, a Welcome nie niesie wiadomości).
      // Nazwę zapisujemy SUROWĄ — nick jest tylko warstwą wyświetlania.
      await zapewnijRozmowe(groupId, inni.join(", ") || undefined);

      if (jestKontaktem) {
        const stan = await zaakceptujProsbe(groupId);
        setZaakceptowane(new Set(stan.zaakceptowane));
      }

      setRozmowy(await listaRozmow());
    },
    [messenger],
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

        if (odebrana?.metadata) {
          /*
           * Metadana nie jest wiadomością do pokazania — aktualizuje nazwy
           * (grupy i nicki), a nie treść wątku. Rozpoznajemy ją po obecności
           * pola i tu jej ścieżka się kończy: żadnego dymka, licznika ani
           * potwierdzenia dostarczenia.
           */
          naMetadane(odebrana.groupId, odebrana.senderUserId, odebrana.metadata);
        } else if (odebrana?.receipt) {
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
    [messenger, dodaj, nanieStan, przenieRoznacznikOdczytu, otworzRozmowe, naMetadane],
  );

  // Ustawienie przez referencję: obsługa koperty nie może zależeć od stanu,
  // bo każda zmiana zależności zrywałaby i otwierała połączenie na nowo.
  const odczytRef = useRef(odczyt);
  odczytRef.current = odczyt;

  /*
   * Połączenie zależy WYŁĄCZNIE od konta — wcześniej wisiało na `groupId`
   * i na niememoizowanej funkcji błędu, więc każde przerysowanie zrywało je
   * i otwierało nowe.
   *
   * # Dlaczego czeka na `rozmowyOtwarte`
   *
   * Bo serwer wysyła zaległości natychmiast po podłączeniu, a rozmowy wczytują
   * się z IndexedDB osobno. React wykonuje efekty w kolejności deklaracji, więc
   * gniazdo ruszało PIERWSZE — a koperta, która dotarła w tym oknie, nie
   * pasowała do żadnej otwartej rozmowy. `matchEnvelope` zwracał wtedy `null`,
   * `handleEnvelope` też, a to jest ścieżka SUKCESU: koperta była potwierdzana
   * i znikała bezpowrotnie. Android robi to w dobrej kolejności od początku
   * (`ChatViewModel.otworzZnaneRozmowy` przed `Rdzen.podepnij`).
   */
  useEffect(() => {
    if (!rozmowyOtwarte) return;

    const polaczenie = polaczZeSkrzynka({
      otworz: () => api.connectInbox(messenger.account.userId, messenger.accessToken),
      naRamke: (ramka, potwierdz) => void obsluzKoperte(ramka, potwierdz),
      naStan: setStanSieci,
    });

    return () => polaczenie.zamknij();
  }, [messenger, obsluzKoperte, rozmowyOtwarte]);

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
   *
   * Musi się to zdarzyć ZANIM powstanie połączenie ze skrzynką, dlatego stąd
   * wychodzi `rozmowyOtwarte` — patrz efekt łączenia niżej.
   */
  useEffect(() => {
    let aktualne = true;

    void listaRozmow().then(async (pozycje) => {
      if (!aktualne) return;
      messenger.otworzZnaneRozmowy(pozycje.map((p) => p.groupId));
      setRozmowy(pozycje);

      // Zbiór zaakceptowanych: przy pierwszym starcie zasiewamy go wszystkimi
      // dotychczasowymi rozmowami, żeby żadna sprzed wdrożenia próśb nie
      // wyglądała nagle jak prośba. Potem świeża rozmowa spoza zbioru jest już
      // prawdziwą prośbą.
      let stan = await wczytajProsby();
      if (!stan.zainicjowano) {
        stan = await zainicjujProsby(pozycje.map((p) => kluczRozmowy(p.groupId)));
      }
      if (aktualne) setZaakceptowane(new Set(stan.zaakceptowane));

      setRozmowyOtwarte(true);
    });

    return () => {
      aktualne = false;
      setRozmowyOtwarte(false);
    };
  }, [messenger]);

  // Wołanie zwrotne dołączenia: messenger nie wie, czy nowa rozmowa to prośba,
  // czy kontakt — my to rozstrzygamy. Ustawiamy je raz i zdejmujemy przy
  // odmontowaniu, żeby nie trafiało w komponent, którego już nie ma.
  useEffect(() => {
    messenger.naDolaczenie = (groupId, czlonkowie) => void obsluzDolaczenie(groupId, czlonkowie);
    return () => {
      messenger.naDolaczenie = null;
    };
  }, [messenger, obsluzDolaczenie]);

  // Współdzielone nazwy z dysku — zasiane raz przy starcie, dalej aktualizowane
  // metadaną z rdzenia.
  useEffect(() => {
    let aktualne = true;
    void wczytajNazwy().then((z: ZapisNazw) => {
      if (!aktualne) return;
      setNazwyGrup({ ...z.grupy });
      setNicki({ ...z.nicki });
      setMojNick(z.mojNick);
    });
    return () => {
      aktualne = false;
    };
  }, []);

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

      if (istniejaca) {
        setZaakceptowane(new Set((await zaakceptujProsbe(istniejaca.groupId)).zaakceptowane));
        otworzRozmowe(istniejaca.groupId);
        setGalaz("rozmowy");
        return;
      }

      const groupId = await messenger.startConversation(nazwa);
      // Rozmowa zakładana samodzielnie jest zaakceptowana z definicji.
      setZaakceptowane(new Set((await zaakceptujProsbe(groupId)).zaakceptowane));
      // Nick niesiemy od razu, żeby druga strona zobaczyła nas tak, jak chcemy.
      if (mojNick.trim()) {
        await messenger.sendMetadata(groupId, { displayName: mojNick.trim() }).catch(() => {});
      }
      otworzRozmowe(groupId);
      setRozmowy(await listaRozmow());
      setGalaz("rozmowy");
    } catch (err) {
      onBlad(err);
    }
  };

  /**
   * Zakłada grupę i wprowadza do niej wybrane osoby, po czym nadaje jej nazwę.
   *
   * Pierwsza osoba zakłada rozmowę (`startConversation` tworzy grupę i dodaje
   * ją jednym ruchem), reszta dochodzi kolejnymi `addMember` — każdy z nich
   * dokłada WSZYSTKIE urządzenia danej osoby jednym commitem (inwariant z
   * rdzenia, nie obchodzimy go). Nazwa i nasz nick idą jedną metadaną.
   */
  const utworzGrupe = async (osoby: string[], nazwaGrupy: string) => {
    const [pierwszy, ...reszta] = osoby;
    if (!pierwszy) return;

    try {
      const groupId = await messenger.startConversation(pierwszy);
      for (const osoba of reszta) {
        await messenger.addMember(groupId, osoba);
      }

      const nazwa = nazwaGrupy.trim();
      if (nazwa || mojNick.trim()) {
        await messenger.sendMetadata(groupId, {
          groupName: nazwa || undefined,
          displayName: mojNick.trim() || undefined,
        });
      }
      if (nazwa) {
        setNazwyGrup({ ...(await ustawNazweGrupy(groupId, nazwa)).grupy });
      }

      setZaakceptowane(new Set((await zaakceptujProsbe(groupId)).zaakceptowane));
      otworzRozmowe(groupId);
      // Etykieta wątku: nazwa grupy, a bez niej surowe nazwy uczestników
      // (nick nałoży `etykietaGrupy` przy renderze).
      setRozmowca(nazwa || osoby.join(", "));
      setRozmowy(await listaRozmow());
      setGalaz("rozmowy");
    } catch (err) {
      onBlad(err);
    }
  };

  /** Przyjmuje prośbę: rozmowa staje się zwykłą i nadawca staje się kontaktem. */
  const przyjmijProsbe = async (pozycja: PozycjaListy) => {
    try {
      setZaakceptowane(new Set((await zaakceptujProsbe(pozycja.groupId)).zaakceptowane));
      otworzRozmowe(pozycja.groupId);
      setRozmowca(nazwaPozycji(pozycja));
    } catch (err) {
      onBlad(err);
    }
  };

  /**
   * Odrzuca prośbę: NAPRAWDĘ wychodzi z grupy MLS i kasuje ją lokalnie.
   *
   * „Wypisz mnie", nie tylko „nie chcę tego widzieć": `opuscGrupe` wysyła
   * propozycję SelfRemove, a pozostający ją zamknie, więc nadawca dowiaduje się,
   * że go nie ma. Wyjście jest best-effort — gdyby rozesłanie nie przeszło
   * (offline), i tak ukrywamy prośbę, żeby nie wracała na oczy; wtedy nasz liść
   * zostaje w grupie do następnej okazji, ale z listy prośba znika.
   */
  const odrzucProsbe = async (pozycja: PozycjaListy) => {
    try {
      if (groupId && kluczRozmowy(groupId) === kluczRozmowy(pozycja.groupId)) {
        otworzRozmowe(null);
      }
      await messenger.opuscGrupe(pozycja.groupId).catch((err) => onBlad(err));
      await zapomnijProsbe(pozycja.groupId);
      await usunRozmowe(pozycja.groupId);
      setRozmowy(await listaRozmow());
    } catch (err) {
      onBlad(err);
    }
  };

  /** Zmienia (albo czyści) nazwę grupy i rozsyła ją współdzieloną metadaną. */
  const zmienNazweGrupy = async (grupa: Uint8Array, nazwa: string) => {
    try {
      await messenger.sendMetadata(grupa, { groupName: nazwa.trim() });
      setNazwyGrup({ ...(await ustawNazweGrupy(grupa, nazwa.trim() || undefined)).grupy });
      setRozmowy(await listaRozmow());
    } catch (err) {
      onBlad(err);
    }
  };

  /**
   * Zmienia własny nick i rozsyła go do wszystkich zaakceptowanych rozmów.
   *
   * Wybór: rozsyłamy OD RAZU do istniejących rozmów (proste i przewidywalne),
   * a nowe rozmowy dostają nick w chwili założenia. Do próśb nie wysyłamy nic —
   * nie ogłaszamy się komuś, z kim jeszcze nie zgodziliśmy się rozmawiać.
   */
  const zmienMojNick = async (nowy: string) => {
    try {
      setMojNick((await ustawMojNick(nowy)).mojNick);
      const nick = nowy.trim();
      for (const p of zaakceptowaneRozmowy) {
        await messenger.sendMetadata(p.groupId, { displayName: nick }).catch(() => {});
      }
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
          prosby={prosby}
          wszystkich={zaakceptowaneRozmowy.length}
          szukane={szukane}
          onSzukane={setSzukane}
          nazwaPozycji={nazwaPozycji}
          otwarta={groupId}
          onNowyCzat={rozpocznijZ}
          onNowaGrupa={utworzGrupe}
          kontakty={kontakty}
          nick={nick}
          onPrzyjmij={przyjmijProsbe}
          onOdrzuc={odrzucProsbe}
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
            void zapomnijProsbe(pozycja.groupId)
              .then(() => usunRozmowe(pozycja.groupId))
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
            wskazowka="Albo zacznij nową — „Nowy czat” wymaga tylko nazwy użytkownika."
          />
        )}

        {galaz === "rozmowy" && groupId && (
          <Watek
            messenger={messenger}
            groupId={groupId}
            rozmowca={etykietaGrupy(groupId) || rozmowca}
            nick={nick}
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

        {galaz === "konto" && (
          <Konto
            messenger={messenger}
            stanSieci={stanSieci}
            trwaly={trwaly}
            odczyt={odczyt}
            mojNick={mojNick}
            onNick={zmienMojNick}
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

          <Uczestnicy
            messenger={messenger}
            groupId={groupId}
            nazwaGrupy={nazwyGrup[kluczRozmowy(groupId)] ?? ""}
            onZmienNazweGrupy={(nazwa) => void zmienNazweGrupy(groupId, nazwa)}
            nick={nick}
            onBlad={onBlad}
          />
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
  prosby,
  wszystkich,
  szukane,
  onSzukane,
  nazwaPozycji,
  otwarta,
  onNowyCzat,
  onNowaGrupa,
  kontakty,
  nick,
  onPrzyjmij,
  onOdrzuc,
  onOtworz,
  onUsun,
}: {
  rozmowy: PozycjaListy[];
  prosby: PozycjaListy[];
  wszystkich: number;
  szukane: string;
  onSzukane: (s: string) => void;
  nazwaPozycji: (p: PozycjaListy) => string;
  otwarta: Uint8Array | null;
  onNowyCzat: (nazwa: string) => void;
  onNowaGrupa: (osoby: string[], nazwa: string) => void;
  kontakty: string[];
  nick: (username: string) => string;
  onPrzyjmij: (p: PozycjaListy) => void;
  onOdrzuc: (p: PozycjaListy) => void;
  onOtworz: (p: PozycjaListy) => void;
  onUsun: (p: PozycjaListy) => void;
}) {
  const kluczOtwartej = otwarta ? kluczRozmowy(otwarta) : null;

  // Rozmowa czekająca na potwierdzenie usunięcia — jedno pytanie dla wszystkich
  // dróg (gest, przycisk spod wiersza, kebab). Usuwamy dopiero po „Usuń".
  const [doUsuniecia, setDoUsuniecia] = useState<PozycjaListy | null>(null);
  // Który wiersz ma otwarte menu kebaba (po kluczu). Naraz najwyżej jeden.
  const [menuKlucz, setMenuKlucz] = useState<string | null>(null);

  // Który sposób rozpoczęcia rozmowy jest otwarty: pole „Nowy czat”, okno
  // „Nowa grupa", albo żaden.
  const [zaczyn, setZaczyn] = useState<"czat" | "grupa" | null>(null);
  const [nowaNazwa, setNowaNazwa] = useState("");

  return (
    <aside className="panel-listy" aria-label="Lista rozmów">
      <div className="panel-listy-naglowek">
        <h2>Rozmowy</h2>
      </div>

      {/*
        Dwa wejścia zamiast zakładki Kontakty: „Nowy czat” (nazwa użytkownika →
        rozmowa jeden na jeden) i „Nowa grupa" (wybór osób). To akcje, więc
        zostają OBRYSOWANE — reguła Nocturne: akcent jest linią, nie plamą.
      */}
      <div className="zaczyn-rozmowy">
        {zaczyn === "czat" ? (
          <form
            className="nowy-czat"
            onSubmit={(e) => {
              e.preventDefault();
              if (nowaNazwa.trim()) {
                onNowyCzat(nowaNazwa.trim());
                setNowaNazwa("");
                setZaczyn(null);
              }
            }}
          >
            <input
              autoFocus
              value={nowaNazwa}
              onChange={(e) => setNowaNazwa(e.target.value)}
              placeholder="Nazwa użytkownika"
              aria-label="Nazwa użytkownika, z którym zacząć rozmowę"
            />
            <button className="ikonowy glowny" disabled={!nowaNazwa.trim()} aria-label="Zacznij">
              <Ikona nazwa="wyslij" rozmiar={16} />
            </button>
            <button
              type="button"
              className="ikonowy"
              aria-label="Anuluj"
              onClick={() => {
                setNowaNazwa("");
                setZaczyn(null);
              }}
            >
              <Ikona nazwa="zamknij" rozmiar={16} />
            </button>
          </form>
        ) : (
          <button className="glowny" onClick={() => setZaczyn("czat")}>
            <Ikona nazwa="dodaj" rozmiar={16} />
            Nowy czat
          </button>
        )}

        <button className="grupa-przycisk" onClick={() => setZaczyn("grupa")}>
          <Ikona nazwa="osoby" rozmiar={16} />
          Nowa grupa
        </button>
      </div>

      {zaczyn === "grupa" && (
        <NowaGrupa
          kontakty={kontakty}
          nick={nick}
          onAnuluj={() => setZaczyn(null)}
          onUtworz={(osoby, nazwa) => {
            setZaczyn(null);
            onNowaGrupa(osoby, nazwa);
          }}
        />
      )}

      {/* Prośby — nad rozmowami, zwijane, z licznikiem. Osobno, żeby nieproszona
          rozmowa nigdy nie mieszała się z prawdziwymi. */}
      {prosby.length > 0 && (
        <Prosby prosby={prosby} nazwaPozycji={nazwaPozycji} onPrzyjmij={onPrzyjmij} onOdrzuc={onOdrzuc} />
      )}

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
        prosby.length > 0 ? null : (
          <Pusto
            ikona="rozmowy"
            tytul="Nie masz jeszcze żadnej rozmowy"
            wskazowka="Zacznij od „Nowy czat” — wystarczy nazwa użytkownika."
          />
        )
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
                menuOtwarte={klucz === menuKlucz}
                onMenu={() => setMenuKlucz((biezacy) => (biezacy === klucz ? null : klucz))}
                onOtworz={() => onOtworz(pozycja)}
                // Każda droga usuwania prowadzi przez potwierdzenie, nie kasuje wprost.
                onUsun={() => {
                  setMenuKlucz(null);
                  setDoUsuniecia(pozycja);
                }}
              />
            );
          })}
        </ul>
      )}

      {doUsuniecia && (
        <PotwierdzenieUsuniecia
          nazwa={nazwaPozycji(doUsuniecia)}
          onAnuluj={() => setDoUsuniecia(null)}
          onUsun={() => {
            const cel = doUsuniecia;
            setDoUsuniecia(null);
            onUsun(cel);
          }}
        />
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
  menuOtwarte,
  onMenu,
  onOtworz,
  onUsun,
}: {
  pozycja: PozycjaListy;
  nazwa: string;
  otwarta: boolean;
  menuOtwarte: boolean;
  onMenu: () => void;
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

  const odslania = przesuniecie !== 0 || odsloniete;

  return (
    <li className={odslania ? "pozycja-rozmowy odslania" : "pozycja-rozmowy"}>
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

      {/*
        Kebab i jego menu — droga do usunięcia na desktopie, gdzie gestu nie ma.
        Kebab jest rodzeństwem wiersza (a nie dzieckiem), bo przycisk w przycisku
        jest niepoprawny. Menu zamyka klik obok (`zaslona-menu`) albo wybór akcji.
      */}
      <button
        type="button"
        className={menuOtwarte ? "wiersz-kebab aktywny" : "wiersz-kebab"}
        aria-label={`Więcej — rozmowa z ${nazwa}`}
        aria-haspopup="menu"
        aria-expanded={menuOtwarte}
        onClick={onMenu}
      >
        <Ikona nazwa="wiecej" rozmiar={18} />
      </button>

      {menuOtwarte && (
        <>
          <button
            type="button"
            className="zaslona-menu"
            aria-label="Zamknij menu"
            onClick={onMenu}
          />
          <div className="menu-rozmowy" role="menu">
            <button type="button" role="menuitem" onClick={onUsun}>
              <Ikona nazwa="kosz" rozmiar={16} />
              Usuń rozmowę
            </button>
          </div>
        </>
      )}
    </li>
  );
}

/**
 * Modal potwierdzający usunięcie rozmowy.
 *
 * Kasowanie jest nieodwracalne — historia żyje wyłącznie na tym urządzeniu —
 * więc żadna droga (gest, przycisk, kebab) nie usuwa wprost; wszystkie kończą
 * tutaj. `Escape` i klik w tło znaczą „anuluj", bo bezpieczniejsza odpowiedź
 * ma być tą łatwą.
 */
function PotwierdzenieUsuniecia({
  nazwa,
  onAnuluj,
  onUsun,
}: {
  nazwa: string;
  onAnuluj: () => void;
  onUsun: () => void;
}) {
  useEffect(() => {
    const naKlawisz = (e: KeyboardEvent) => {
      if (e.key === "Escape") onAnuluj();
    };
    window.addEventListener("keydown", naKlawisz);
    return () => window.removeEventListener("keydown", naKlawisz);
  }, [onAnuluj]);

  return (
    <div
      className="nakladka-modal"
      role="dialog"
      aria-modal="true"
      aria-label={`Usunąć rozmowę z ${nazwa}`}
      onClick={onAnuluj}
    >
      <div className="modal-karta" onClick={(e) => e.stopPropagation()}>
        <h3>Usunąć rozmowę z {nazwa}?</h3>
        <p>
          Historia tej rozmowy jest tylko na tym urządzeniu — serwer jej nie ma,
          więc po usunięciu nikt jej nie odtworzy.
        </p>
        <div className="modal-przyciski">
          <button type="button" onClick={onAnuluj}>
            Anuluj
          </button>
          <button type="button" className="niszczacy" onClick={onUsun} autoFocus>
            <Ikona nazwa="kosz" rozmiar={16} />
            Usuń
          </button>
        </div>
      </div>
    </div>
  );
}

/** Otwarta rozmowa: nagłówek, wiadomości, pole pisania. */
function Watek({
  messenger,
  groupId,
  rozmowca,
  nick,
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
  nick: (username: string) => string;
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

        {/* Awatar i nazwa w jednym pudełku, bo na wąskim ekranie stają
            w kolumnie na środku paska, a na szerokim obok siebie po lewej.
            Rozstrzyga o tym arkusz stylów — tu jest tylko to, co niezmienne:
            że to jedna rzecz, „z kim rozmawiam". */}
        <span className="pasek-kto">
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
          pozycja.rodzaj === "rozdzielacz" ? (
            /* Dzień wytłuszczony, godzina zwykła — jedno zdanie, nie dwie
               etykiety. Godziny nie ma już w dymkach, więc to jedyne miejsce
               w wątku, które odpowiada na pytanie „kiedy". */
            <li key={pozycja.klucz} className="rozdzielacz">
              <strong>{pozycja.etykieta}</strong> {godzina(pozycja.czas)}
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
                nick={nick}
                ciag={pozycja.ciag}
                ogon={pozycja.ogon}
                ostatniaWlasna={pozycja.ostatniaWlasna}
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

        {/*
          Pole i strzałka są JEDNYM przedmiotem.
          Przycisk stojący obok pola czyta się jak osobna kontrolka, którą
          trzeba znaleźć; wsunięty w prawy koniec pola jest końcem tej samej
          czynności — dopisujesz zdanie i wypychasz je tym samym gestem.
        */}
        <div className="pole-pisania">
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
        </div>
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
  nick,
  ciag,
  ogon,
  ostatniaWlasna,
  stan,
  onBlad,
}: {
  messenger: Messenger;
  wiadomosc: Wiadomosc;
  nick: (username: string) => string;
  ciag: boolean;
  ogon: boolean;
  ostatniaWlasna: boolean;
  stan?: WLocie;
  onBlad: (e: unknown) => void;
}) {
  const klasy = ["", wiadomosc.wlasna ? "wlasna" : "", ciag ? "ciag" : "", ogon ? "ogon" : ""];
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

  /*
   * Stan wysyłki pod ostatnim własnym dymkiem, nie w każdym.
   *
   * Ptaszek przy każdej własnej wiadomości to kolumna powtórzonego „wysłano",
   * a odpowiada on na pytanie zadawane o JEDNĄ wiadomość — tę ostatnią.
   * Wyjątkiem są stany, z którymi trzeba coś zrobić: „wysyłam" i „nie wysłano"
   * pokazujemy zawsze, bo milczenie przy nich znaczyłoby „doszło".
   */
  const zeStanem =
    wiadomosc.wlasna && (ostatniaWlasna || stanWysylki === "w-locie" || stanWysylki === "nieudana");

  return (
    <>
    {/* Godzina wyszła z dymka na rozdzielacz, ale nie przepadła — `title`
        odpowiada na „a ta konkretna o której?" bez zajmowania wiersza. */}
    <li className={klasy.join(" ").trim()} title={pelnaGodzina(wiadomosc.czas)}>
      {/* Autor tylko na początku bloku i tylko przy cudzych — przy własnych
          mówi to strona dymka, a powtórzony przy każdej wiadomości jest szumem. */}
      {!wiadomosc.wlasna && !ciag && <span className="autor">{nick(wiadomosc.autor)}</span>}

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
    </li>

    {zeStanem && (
      <li
        className={
          stanWysylki === "nieudana" ? "stan-wysylki nieudany" : "stan-wysylki"
        }
      >
        {duzaLitera(opis.etykieta)}
      </li>
    )}
    </>
  );
}

/** Pierwsza litera wielka — opisy stanów są zdaniem, nie etykietą w tabeli. */
function duzaLitera(tekst: string): string {
  return tekst.charAt(0).toUpperCase() + tekst.slice(1);
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
 * Sekcja próśb o rozmowę — zwijana, z licznikiem, nad listą rozmów.
 *
 * # Po co osobno
 *
 * Nieproszona rozmowa nie ma prawa wpaść między prawdziwe ani udawać „nowej
 * wiadomości" — to jest cała zapora. Każda prośba niesie podgląd i dwie decyzje:
 * „Przyjmij" (staje się zwykłą rozmową, nadawca staje się kontaktem) albo
 * „Odrzuć" (znika lokalnie).
 *
 * Domyślnie zwinięta: prośby są sygnałem, że ktoś czeka, a nie treścią, którą
 * czyta się co chwilę.
 */
function Prosby({
  prosby,
  nazwaPozycji,
  onPrzyjmij,
  onOdrzuc,
}: {
  prosby: PozycjaListy[];
  nazwaPozycji: (p: PozycjaListy) => string;
  onPrzyjmij: (p: PozycjaListy) => void;
  onOdrzuc: (p: PozycjaListy) => void;
}) {
  const [rozwinięte, setRozwiniete] = useState(false);

  return (
    <section className="prosby" aria-label="Prośby o rozmowę">
      <button
        type="button"
        className="prosby-naglowek"
        aria-expanded={rozwinięte}
        onClick={() => setRozwiniete((r) => !r)}
      >
        <Ikona nazwa="rozwin" rozmiar={14} klasa={rozwinięte ? "obrocona" : undefined} />
        <span className="prosby-tytul">Prośby o rozmowę</span>
        <span className="znacznik">{prosby.length}</span>
      </button>

      {rozwinięte && (
        <ul className="lista-prosb">
          {prosby.map((pozycja) => {
            const nazwa = nazwaPozycji(pozycja);
            return (
              <li key={kluczRozmowy(pozycja.groupId)} className="prosba">
                <span className="awatar maly" aria-hidden="true">
                  {nazwa.slice(0, 1)}
                </span>
                <span className="prosba-tresc">
                  <span className="prosba-nazwa">{nazwa}</span>
                  <span className="prosba-podglad">
                    {pozycja.ostatnia ? zapowiedz(pozycja.ostatnia) : "chce zacząć rozmowę"}
                  </span>
                </span>
                <span className="prosba-akcje">
                  <button
                    type="button"
                    className="ikonowy glowny"
                    aria-label={`Przyjmij prośbę od ${nazwa}`}
                    title="Przyjmij"
                    onClick={() => onPrzyjmij(pozycja)}
                  >
                    <Ikona nazwa="dodaj" rozmiar={16} />
                  </button>
                  <button
                    type="button"
                    className="ikonowy"
                    aria-label={`Odrzuć prośbę od ${nazwa}`}
                    title="Odrzuć"
                    onClick={() => onOdrzuc(pozycja)}
                  >
                    <Ikona nazwa="zamknij" rozmiar={16} />
                  </button>
                </span>
              </li>
            );
          })}
        </ul>
      )}
    </section>
  );
}

/**
 * Zakładanie grupy: wybór osób z kontaktów plus dodanie po nazwie.
 *
 * Kontakty to osoby, z którymi już rozmawiamy — katalog nie ma listy do
 * przeglądania (decyzja, nie brak). Kogoś spoza tej listy dodaje się po nazwie
 * użytkownika, tak samo jak w „Nowym czacie". Nazwa grupy jest opcjonalna:
 * bez niej wątek pokazuje sklejone nazwy uczestników, dokładnie jak dotąd.
 */
function NowaGrupa({
  kontakty,
  nick,
  onAnuluj,
  onUtworz,
}: {
  kontakty: string[];
  nick: (username: string) => string;
  onAnuluj: () => void;
  onUtworz: (osoby: string[], nazwa: string) => void;
}) {
  const [wybrani, setWybrani] = useState<Set<string>>(new Set());
  const [poNazwie, setPoNazwie] = useState("");
  const [nazwaGrupy, setNazwaGrupy] = useState("");
  // Osoby dodane po nazwie, spoza listy kontaktów.
  const [dodatkowi, setDodatkowi] = useState<string[]>([]);

  const przelacz = (osoba: string) =>
    setWybrani((zbior) => {
      const kolejny = new Set(zbior);
      if (kolejny.has(osoba)) kolejny.delete(osoba);
      else kolejny.add(osoba);
      return kolejny;
    });

  const dodajPoNazwie = () => {
    const nazwa = poNazwie.trim();
    if (!nazwa) return;
    setPoNazwie("");
    // Kontakt z listy → po prostu go zaznacz; ktoś spoza → dołóż jako dodatkowy.
    if (kontakty.includes(nazwa)) {
      setWybrani((zbior) => new Set(zbior).add(nazwa));
    } else {
      setDodatkowi((lista) => (lista.includes(nazwa) ? lista : [...lista, nazwa]));
    }
  };

  const wszyscy = [...new Set([...wybrani, ...dodatkowi])];

  return (
    <div className="nakladka-modal" role="dialog" aria-modal="true" aria-label="Nowa grupa" onClick={onAnuluj}>
      <div className="modal-karta nowa-grupa" onClick={(e) => e.stopPropagation()}>
        <h3>Nowa grupa</h3>

        <label className="pole-nazwy-grupy">
          Nazwa grupy (opcjonalnie)
          <input
            value={nazwaGrupy}
            onChange={(e) => setNazwaGrupy(e.target.value)}
            placeholder="np. Ekipa z Bydgoszczy"
          />
        </label>

        {kontakty.length > 0 && (
          <fieldset className="wybor-osob">
            <legend>Z kim rozmawiasz</legend>
            <ul>
              {kontakty.map((osoba) => (
                <li key={osoba}>
                  <label className="osoba-wybor">
                    <input
                      type="checkbox"
                      checked={wybrani.has(osoba)}
                      onChange={() => przelacz(osoba)}
                    />
                    <span className="awatar maly" aria-hidden="true">
                      {nick(osoba).slice(0, 1)}
                    </span>
                    <span className="kto">{nick(osoba)}</span>
                  </label>
                </li>
              ))}
            </ul>
          </fieldset>
        )}

        <form
          className="dodaj-po-nazwie"
          onSubmit={(e) => {
            e.preventDefault();
            dodajPoNazwie();
          }}
        >
          <label>
            Dodaj po nazwie
            <span className="pole-z-przyciskiem">
              <input
                value={poNazwie}
                onChange={(e) => setPoNazwie(e.target.value)}
                placeholder="Nazwa użytkownika"
              />
              <button type="submit" className="ikonowy" disabled={!poNazwie.trim()} aria-label="Dodaj">
                <Ikona nazwa="dodaj" rozmiar={16} />
              </button>
            </span>
          </label>
        </form>

        {dodatkowi.length > 0 && (
          <ul className="dodani-po-nazwie" aria-label="Dodani po nazwie">
            {dodatkowi.map((osoba) => (
              <li key={osoba}>
                <span className="kto">{nick(osoba)}</span>
                <button
                  type="button"
                  className="ikonowy"
                  aria-label={`Usuń ${osoba} z grupy`}
                  onClick={() => setDodatkowi((lista) => lista.filter((o) => o !== osoba))}
                >
                  <Ikona nazwa="zamknij" rozmiar={14} />
                </button>
              </li>
            ))}
          </ul>
        )}

        <div className="modal-przyciski">
          <button type="button" onClick={onAnuluj}>
            Anuluj
          </button>
          <button
            type="button"
            className="glowny"
            disabled={wszyscy.length === 0}
            onClick={() => onUtworz(wszyscy, nazwaGrupy)}
          >
            <Ikona nazwa="osoby" rozmiar={16} />
            Utwórz grupę
          </button>
        </div>
      </div>
    </div>
  );
}

function Konto({
  messenger,
  stanSieci,
  trwaly,
  odczyt,
  mojNick,
  onNick,
  onOdczyt,
  onBlad,
}: {
  messenger: Messenger;
  stanSieci: StanPolaczenia;
  trwaly: boolean;
  odczyt: boolean;
  mojNick: string;
  onNick: (nick: string) => void;
  onOdczyt: (wlaczony: boolean) => void;
  onBlad: (e: unknown) => void;
}) {
  const siec = opisSieci(stanSieci);
  // Pole nicku trzymane lokalnie — zapisujemy dopiero, gdy pole traci fokus
  // albo na Enter, żeby nie rozsyłać metadany po każdym naciśnięciu klawisza.
  const [nickPole, setNickPole] = useState(mojNick);
  useEffect(() => setNickPole(mojNick), [mojNick]);

  const zapiszNick = () => {
    if (nickPole.trim() !== mojNick.trim()) onNick(nickPole);
  };

  return (
    <>
      <header className="naglowek-konta">
        <h2>Konto</h2>
      </header>

      <div className="siatka-konta">
        <div className="karta">
          <div className="tozsamosc">
            <span className="awatar" aria-hidden="true">
              {(mojNick || messenger.account.username).slice(0, 1)}
            </span>
            <span>
              <strong>{messenger.account.username}</strong>
              <span className="wskazowka">{messenger.account.deviceId}</span>
            </span>
          </div>

          {/*
            Nazwa wyświetlana (nick) — WARSTWA WYŚWIETLANIA, nie tożsamość.
            Adresem skrzynki i tożsamością MLS zostaje nazwa użytkownika wyżej;
            nick to tylko to, jak widzą Cię inni w rozmowach. Zmiana rozsyła się
            współdzieloną metadaną do Twoich rozmów.
          */}
          <label className="pole-nicku">
            Nazwa wyświetlana
            <input
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
              aria-label="Nazwa wyświetlana"
            />
          </label>
          <p className="wskazowka">
            Tak zobaczą Cię inni w rozmowach. Twoja nazwa użytkownika się nie
            zmienia — to po niej dochodzą wiadomości.
          </p>

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

        <PasskeyZarzadzanie messenger={messenger} onBlad={onBlad} />

        <ZmianaAuthenticatora messenger={messenger} onBlad={onBlad} />

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
  const [gotowe, setGotowe] = useState(false);

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
      setGotowe(true);
    } catch (err) {
      onBlad(err);
    } finally {
      setPracuje(false);
    }
  };

  return (
    <div className="karta">
      <strong>Aplikacja authenticator</strong>

      {etap.nazwa === "spoczynek" && (
        <>
          <p className="wskazowka">
            Zmieniasz telefon albo aplikację? Podłącz nowy authenticator — najpierw
            potwierdzisz, że to Ty.
          </p>
          {gotowe && (
            <p className="wskazowka-ikona">
              <Ikona nazwa="wyslane" rozmiar={14} />
              Authenticator zmieniony. Od teraz loguj się kodami z nowej aplikacji.
            </p>
          )}
          <button
            onClick={() => {
              setGotowe(false);
              setEtap({ nazwa: "reauth" });
            }}
          >
            Zmień authenticator
          </button>
        </>
      )}

      {etap.nazwa === "reauth" && (
        <>
          <p className="wskazowka">
            Potwierdź, że to Ty — passkeyem albo aktualnym kodem ze starego authenticatora.
          </p>

          {isPasskeySupported() && (
            <button disabled={pracuje} onClick={zaczniPasskeyem}>
              <Ikona nazwa="blokada" rozmiar={16} />
              {pracuje ? "Czekam…" : "Potwierdź passkeyem"}
            </button>
          )}

          <form onSubmit={zaczniKodem}>
            <label>
              Kod ze starego authenticatora
              <input
                value={staryKod}
                onChange={(e) => setStaryKod(e.target.value)}
                inputMode="numeric"
                autoComplete="one-time-code"
                required
              />
            </label>
            <button className="glowny" disabled={pracuje}>
              Dalej
            </button>
          </form>

          <button onClick={() => setEtap({ nazwa: "spoczynek" })}>Anuluj</button>
        </>
      )}

      {etap.nazwa === "nowy" && (
        <>
          <p className="wskazowka">
            Zeskanuj w <strong>nowej</strong> aplikacji authenticator, potem wpisz jej pierwszy
            kod. Stary authenticator działa aż do potwierdzenia.
          </p>

          <KodQr tresc={etap.otpauthUri} opis="Kod QR nowego authenticatora" />

          <details className="sekret-recznie">
            <summary>Albo wpisz sekret ręcznie</summary>
            <code className="sekret">{etap.totpSecret}</code>
          </details>

          <form onSubmit={potwierdz}>
            <label>
              Kod z nowej aplikacji
              <input
                value={nowyKod}
                onChange={(e) => setNowyKod(e.target.value)}
                inputMode="numeric"
                autoComplete="one-time-code"
                required
              />
            </label>
            <button className="glowny" disabled={pracuje}>
              {pracuje ? "Potwierdzam…" : "Potwierdź zmianę"}
            </button>
          </form>

          <button onClick={() => setEtap({ nazwa: "spoczynek" })}>Anuluj</button>
        </>
      )}
    </div>
  );
}

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
