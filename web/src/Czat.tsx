import { useCallback, useEffect, useMemo, useRef, useState } from "react";

import { Ikona, type NazwaIkony } from "./Ikony";
import { NowaGrupa, NowyCzat, PanelListy } from "./ListaRozmow";
import { Polecenia } from "./Polecenia";
import { Rozmowa, type SygnalRozmowy, type ZadanieRozmowy } from "./Rozmowa";
import { Uczestnicy } from "./Uczestnicy";
import { Ustawienia } from "./Ustawienia";
import { Watek } from "./Watek";
import { Pusto, ZnakMarki, Znacznik } from "./Wspolne";
import { Arkusz } from "./components/ui/arkusz";
import { Button } from "./components/ui/button";
import { cn } from "./components/ui/cn";
import { api } from "./lib/api";
import {
  type PozycjaListy,
  type Wiadomosc,
  dopiszWiadomosc,
  kluczRozmowy,
  listaRozmow,
  oznaczPrzeczytane,
  przytnijZnikajace,
  usunRozmowe,
  wczytajRozmowe,
  zapewnijRozmowe,
  zapiszRozmowe,
} from "./lib/historia";
import {
  odblokuj as odblokujUzytkownika,
  wczytajBlokady,
  zablokuj as zablokujUzytkownika,
} from "./lib/blokady";
import {
  graniceOdciecia,
  ustawZnikanie,
  wczytajZnikanie,
  zapomnijZnikanie,
} from "./lib/znikanie";
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
import { t } from "./lib/jezyk";
import { type LicznikProb, poNiepowodzeniu, poSukcesie } from "./lib/koperty";
import { filtrujRozmowy } from "./lib/lista";
import { type Messenger, type ReceivedMessage, idWiadomosci } from "./lib/messenger";
import {
  type StanWiadomosci,
  Zbieracz,
  losoweOpoznienie,
  stanZPotwierdzenia,
  wyzszyStan,
} from "./lib/potwierdzenia";
import { odczytWlaczony, ustawOdczyt } from "./lib/ustawienia";
import { useWstecz } from "./lib/nawigacja";
import { polaczZeSkrzynka } from "./lib/polaczenie";
import { nazwaRozmowy, znajdzRozmowe1na1 } from "./lib/rozmowy";
import { KOLUMNA_SZCZEGOLOW, useSzerokosc } from "./lib/szerokosc";
import { isPersistent } from "./lib/vault";

type Galaz = "rozmowy" | "konto";

/** Wiadomość, której wysyłka jeszcze trwa albo się nie powiodła. */
interface WLocie {
  id: string;
  tresc: string;
  czas: number;
  blad: boolean;
}

export function Czat({ messenger, onBlad }: { messenger: Messenger; onBlad: (e: unknown) => void }) {
  const [wiadomosci, setWiadomosci] = useState<Wiadomosc[]>([]);
  const [tresc, setTresc] = useState("");
  const [rozmowca, setRozmowca] = useState("");
  const [groupId, setGroupId] = useState<Uint8Array | null>(null);
  const [sygnalRozmowy, setSygnalRozmowy] = useState<SygnalRozmowy | null>(null);

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
   const [poleceniaOtwarte, setPoleceniaOtwarte] = useState(false);
  const [nowyCzat, setNowyCzat] = useState(false);
  const [nowaGrupa, setNowaGrupa] = useState(false);
  // Szczegóły jako kolumna tylko tam, gdzie zmieszczą się obok wątku;
  // węższe okno dostaje je w arkuszu.
  const szczegolyWKolumnie = useSzerokosc(KOLUMNA_SZCZEGOLOW);

   useEffect(() => {
     function skrot(e: KeyboardEvent) {
       if ((e.metaKey || e.ctrlKey) && e.key.toLowerCase() === "k") {
         e.preventDefault();
         setPoleceniaOtwarte((p) => !p);
       }
     }
     document.addEventListener("keydown", skrot);
     return () => document.removeEventListener("keydown", skrot);
   }, []);
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
   * Zablokowane nazwy użytkowników i ustawienia znikania per rozmowa.
   *
   * Oba są lokalne i zaszyfrowane (patrz `blokady.ts`, `znikanie.ts`). Blokadę
   * czytamy też przez referencję, bo obsługa koperty nie może zależeć od stanu —
   * inaczej każda zmiana blokad zrywałaby połączenie ze skrzynką.
   */
  const [zablokowani, setZablokowani] = useState<Set<string>>(new Set());
  const zablokowaniRef = useRef(zablokowani);
  zablokowaniRef.current = zablokowani;
  const [znikanie, setZnikanie] = useState<Record<string, number>>({});

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
      return pozycja.rozmowca || t("rozmowa bez nazwy", "unnamed conversation");
    },
    [etykietaGrupy],
  );

  /*
   * Rozmowy dzielą się na zaakceptowane i prośby. Prośba to rozmowa obecna
   * w historii, ale spoza zbioru zaakceptowanych — trafia do osobnej sekcji,
   * nie między rozmowy, i nie podbija licznika nieprzeczytanych.
   */
  /*
   * Czy rozmowa jest w całości z osobami zablokowanymi.
   *
   * Ukrywamy DM z zablokowanym i grupę złożoną z samych zablokowanych — ale nie
   * grupę, w której zablokowany jest JEDNYM z uczestników: chcesz w niej zostać,
   * po prostu nie chcesz widzieć jego wiadomości (to odsiewa `dodaj`). Rozmowa
   * bez stanu MLS albo „sam ze sobą" nie ma kogo blokować, więc zostaje.
   */
  const czyCalaZablokowana = useCallback(
    (groupId: Uint8Array): boolean => {
      if (zablokowani.size === 0) return false;
      try {
        const inni = messenger
          .memberUserIds(groupId)
          .filter((osoba) => osoba !== messenger.account.userId);
        return inni.length > 0 && inni.every((osoba) => zablokowani.has(osoba));
      } catch {
        return false;
      }
    },
    [zablokowani, messenger],
  );

  const zaakceptowaneRozmowy = useMemo(
    () =>
      rozmowy.filter(
        (p) => zaakceptowane.has(kluczRozmowy(p.groupId)) && !czyCalaZablokowana(p.groupId),
      ),
    [rozmowy, zaakceptowane, czyCalaZablokowana],
  );
  const prosby = useMemo(
    () =>
      rozmowy.filter(
        (p) => !zaakceptowane.has(kluczRozmowy(p.groupId)) && !czyCalaZablokowana(p.groupId),
      ),
    [rozmowy, zaakceptowane, czyCalaZablokowana],
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
   * Usuwa wiadomości, które przeżyły swój czas znikania.
   *
   * Liczy granice z bieżących ustawień i tnie zaszyfrowaną historię. Dla rozmowy
   * otwartej na ekranie odejmuje przycięte też ze stanu — inaczej zniknęłyby
   * z dysku, ale zostały na oczach do następnego wejścia. Wołane przy starcie,
   * co minutę i zaraz po zmianie ustawienia, żeby skrócenie czasu działało od
   * razu, a nie dopiero przy kolejnym tiku.
   */
  const przytnijTeraz = useCallback(async () => {
    const granice = graniceOdciecia(znikanie, Date.now());
    const zmieniono = await przytnijZnikajace(granice);
    if (zmieniono) setRozmowy(await listaRozmow());

    const otwarta = biezacaGrupa.current;
    if (otwarta) {
      const granica = granice[kluczRozmowy(otwarta)];
      if (granica !== undefined) setWiadomosci((p) => p.filter((w) => w.czas >= granica));
    }
  }, [znikanie]);

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

      /*
       * Zablokowanego nadawcę pomijamy tuż po rozpoznaniu, kto pisze.
       *
       * Kopertę i tak odszyfrowaliśmy — inaczej nie poznalibyśmy nadawcy
       * z credentiala MLS, a tylko on jest wiarygodny. Ale dalej nie idzie:
       * wiadomość nie dopisuje się do żadnej rozmowy, nie podbija licznika
       * i nie wysyłamy za nią potwierdzenia dostarczenia. W grupie blokujemy
       * po nadawcy, nie po całej rozmowie — reszta grupy pisze dalej.
       */
      if (!wlasna && zablokowaniRef.current.has(odebrana.senderUserId)) return;

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

      // Zaproszenie od samych zablokowanych nie zakłada nawet prośby — dołączyć
      // do grupy MLS musimy (Welcome już przetworzony), ale nie pokazujemy jej.
      if (inni.length > 0 && inni.every((osoba) => zablokowaniRef.current.has(osoba))) return;

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
          // Zablokowany nadawca nie dopisuje wiadomości ANI nie otwiera rozmowy:
          // bez tego jego wiadomość, choć niepokazana, wskoczyłaby na ekran jako
          // świeżo otwarty wątek. `dodaj` też go pomija, ale otwarcie jest tutaj.
          const zablokowanyNadawca =
            odebrana.senderUserId !== messenger.account.userId &&
            zablokowaniRef.current.has(odebrana.senderUserId);
          if (!zablokowanyNadawca) {
            dodaj(odebrana);
            if (!biezacaGrupa.current) otworzRozmowe(odebrana.groupId);
          }
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

  // Blokady i ustawienia znikania z dysku — zasiane raz przy starcie.
  useEffect(() => {
    let aktualne = true;
    void wczytajBlokady().then((b) => aktualne && setZablokowani(new Set(b)));
    void wczytajZnikanie().then((z) => aktualne && setZnikanie({ ...z }));
    return () => {
      aktualne = false;
    };
  }, []);

  /*
   * Zamiatanie znikających wiadomości: raz przy zmianie ustawień i dalej co
   * minutę. Minuta wystarcza — znikanie jest o retencji, nie o sekundach; a przy
   * zmianie ustawienia tniemy od razu, żeby świeżo skrócony czas zadziałał
   * natychmiast, zamiast czekać na tik.
   */
  useEffect(() => {
    void przytnijTeraz();
    const tik = setInterval(() => void przytnijTeraz(), 60_000);
    return () => clearInterval(tik);
  }, [przytnijTeraz]);

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

  /** Blokuje osobę po nazwie użytkownika. Filtrowanie robią listy i `dodaj`. */
  const zablokuj = async (username: string) => {
    try {
      setZablokowani(new Set(await zablokujUzytkownika(username)));
    } catch (err) {
      onBlad(err);
    }
  };

  /** Zdejmuje blokadę — rozmowy i wiadomości tej osoby wracają. */
  const odblokuj = async (username: string) => {
    try {
      setZablokowani(new Set(await odblokujUzytkownika(username)));
    } catch (err) {
      onBlad(err);
    }
  };

  /**
   * Ustawia (albo wyłącza, przez `null`) znikanie dla rozmowy.
   *
   * Samo przycięcie odpala efekt zamiatania: zmiana `znikanie` odtwarza
   * `przytnijTeraz`, a ten jest zależnością efektu, więc tnie od razu ze świeżymi
   * granicami — nie trzeba tu wołać go ręcznie (i tak zamknąłby się nad starą
   * mapą z domknięcia).
   */
  const zmienZnikanie = async (grupa: Uint8Array, sekundy: number | null) => {
    try {
      setZnikanie({ ...(await ustawZnikanie(grupa, sekundy)) });
    } catch (err) {
      onBlad(err);
    }
  };

  /**
   * Dodaje osobę do istniejącej rozmowy — rozbudowa grupy (albo DM → grupa).
   *
   * Rzuca dalej, żeby panel zostawił pole otwarte przy błędzie (np. brak
   * urządzeń albo wolnych key packages); użytkownik widzi powód przez `onBlad`.
   * Nick niesiemy metadaną, żeby nowy uczestnik od razu zobaczył nas tak, jak
   * chcemy.
   */
  const dodajOsobe = async (grupa: Uint8Array, username: string) => {
    try {
      await messenger.addMember(grupa, username);
      if (mojNick.trim()) {
        await messenger.sendMetadata(grupa, { displayName: mojNick.trim() }).catch(() => {});
      }
      setRozmowy(await listaRozmow());
    } catch (err) {
      onBlad(err);
      throw err;
    }
  };

  /**
   * Opuszcza grupę — wychodzi z MLS i kasuje ją lokalnie.
   *
   * Ta sama droga co odrzucenie prośby (`opuscGrupe` wysyła propozycję
   * SelfRemove, pozostający ją zamknie), plus sprzątanie lokalnych ustawień tej
   * rozmowy. Wyjście jest best-effort: gdyby rozesłanie nie przeszło (offline),
   * i tak chowamy rozmowę u siebie.
   */
  const opuscGrupe = async (grupa: Uint8Array) => {
    try {
      if (groupId && kluczRozmowy(groupId) === kluczRozmowy(grupa)) {
        otworzRozmowe(null);
      }
      await messenger.opuscGrupe(grupa).catch((err) => onBlad(err));
      await zapomnijProsbe(grupa);
      setZnikanie({ ...(await zapomnijZnikanie(grupa)) });
      await usunRozmowe(grupa);
      setRozmowy(await listaRozmow());
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

  const nazwaOtwartej = groupId ? etykietaGrupy(groupId) || rozmowca : "";

  return (
    <div
      className="uklad"
      data-galaz={galaz}
      data-watek={groupId && galaz === "rozmowy" ? "otwarty" : undefined}
      data-szczegoly={groupId && galaz === "rozmowy" && szczegolyWKolumnie && inspektorOtwarty ? "kolumna" : undefined}
    >
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

      <Polecenia
        otwarte={poleceniaOtwarte}
        rozmowy={widoczne.map((p) => ({
          id: kluczRozmowy(p.groupId),
          nazwa: nazwaPozycji(p),
          ostatnia: p.ostatnia?.tresc || "",
        }))}
        onSelectRozmowe={(id) => {
          const pozycja = rozmowy.find((p) => kluczRozmowy(p.groupId) === id);
          if (pozycja) {
            setGalaz("rozmowy");
            otworzRozmowe(pozycja.groupId);
            setRozmowca(nazwaPozycji(pozycja));
          }
          setPoleceniaOtwarte(false);
        }}
        onZamknij={() => setPoleceniaOtwarte(false)}
      />

      {!rozmowaNaEkranie && (
        <>
          <Szyna galaz={galaz} onGalaz={setGalaz} nieprzeczytane={nieprzeczytane} />

          {galaz === "rozmowy" && (
            <PanelListy
              rozmowy={widoczne}
              prosby={prosby}
              wszystkich={zaakceptowaneRozmowy.length}
              szukane={szukane}
              onSzukane={setSzukane}
              nazwaPozycji={nazwaPozycji}
              otwarta={groupId}
              onNowyCzat={() => setNowyCzat(true)}
              onNowaGrupa={() => setNowaGrupa(true)}
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
                void zapomnijZnikanie(pozycja.groupId).then((z) => setZnikanie({ ...z }));
                void zapomnijProsbe(pozycja.groupId)
                  .then(() => usunRozmowe(pozycja.groupId))
                  .then(() => listaRozmow())
                  .then(setRozmowy)
                  .catch((err) => onBlad(err));
              }}
            />
          )}

          <main className="ekran">
            {galaz === "rozmowy" && !groupId && (
              <Pusto
                ikona="rozmowy"
                tytul={t("Wybierz rozmowę", "Pick a conversation")}
                wskazowka={t(
                  "Albo zacznij nową — „Nowy czat” wymaga tylko nazwy użytkownika.",
                  "Or start a new one — “New chat” only needs a username.",
                )}
                className="flex-1"
              />
            )}

            {galaz === "rozmowy" && groupId && (
              <Watek
                messenger={messenger}
                groupId={groupId}
                rozmowca={nazwaOtwartej}
                nick={nick}
                wiadomosci={wiadomosci}
                wLocie={wLocie}
                setWiadomosci={setWiadomosci}
                setWLocie={setWLocie}
                tresc={tresc}
                setTresc={setTresc}
                // Dzwonimy z otwartego wątku, więc rozmowa toczy się w JEGO grupie.
                // Bez tego ekran rozmowy zostałby przy grupie z poprzedniego
                // połączenia przychodzącego.
                setZadanieRozmowy={(z) => {
                  setGrupaRozmowy(groupId);
                  setZadanieRozmowy(z);
                }}
                szczegolyOtwarte={inspektorOtwarty}
                setSzczegolyOtwarte={setInspektorOtwarty}
                onBlad={onBlad}
              />
            )}

            {galaz === "konto" && (
              <Ustawienia
                messenger={messenger}
                trwaly={trwaly}
                odczyt={odczyt}
                mojNick={mojNick}
                onNick={zmienMojNick}
                zablokowani={zablokowani}
                nick={nick}
                onOdblokuj={(username) => void odblokuj(username)}
                onOdczyt={(wlaczony) => {
                  ustawOdczyt(wlaczony);
                  setOdczyt(wlaczony);
                }}
                onBlad={onBlad}
              />
            )}
          </main>

          {/*
            Szczegóły rozmowy: na szerokim ekranie stała kolumna, na węższym
            arkusz — ten sam komponent, inna oprawa. Kolumna wisi na atrybucie
            `data-szczegoly` korzenia, żeby siatka wiedziała, że ma czwartą.
          */}
          {galaz === "rozmowy" && groupId && szczegolyWKolumnie && inspektorOtwarty && (
            <aside className="szczegoly" aria-label={t("Szczegóły rozmowy", "Conversation details")}>
              <div className="flex h-14 shrink-0 items-center justify-between border-b border-linia px-4">
                <h2 className="text-tresc font-semibold tracking-[-0.01em]">{t("Rozmowa", "Conversation")}</h2>
                <Button
                  variant="ghost"
                  size="icon"
                  aria-label={t("Zamknij panel", "Close panel")}
                  onClick={() => setInspektorOtwarty(false)}
                >
                  <Ikona nazwa="zamknij" rozmiar={16} />
                </Button>
              </div>
              <div className="min-h-0 flex-1 overflow-y-auto">{szczegoly(groupId)}</div>
            </aside>
          )}

          {galaz === "rozmowy" && groupId && !szczegolyWKolumnie && (
            <Arkusz
              otwarty={inspektorOtwarty}
              onZmiana={setInspektorOtwarty}
              tytul={nazwaOtwartej || t("Rozmowa", "Conversation")}
            >
              {szczegoly(groupId)}
            </Arkusz>
          )}

          <NowyCzat
            otwarty={nowyCzat}
            onZmiana={setNowyCzat}
            onZacznij={(nazwa) => {
              setNowyCzat(false);
              void rozpocznijZ(nazwa);
            }}
          />
          <NowaGrupa
            otwarty={nowaGrupa}
            onZmiana={setNowaGrupa}
            kontakty={kontakty}
            nick={nick}
            onUtworz={(osoby, nazwa) => {
              setNowaGrupa(false);
              void utworzGrupe(osoby, nazwa);
            }}
          />
        </>
      )}
    </div>
  );

  /** Skład, nazwa grupy, blokady, znikanie i kod bezpieczeństwa otwartej rozmowy. */
  function szczegoly(id: Uint8Array) {
    return (
      <Uczestnicy
        messenger={messenger}
        groupId={id}
        nazwaGrupy={nazwyGrup[kluczRozmowy(id)] ?? ""}
        onZmienNazweGrupy={(nazwa) => void zmienNazweGrupy(id, nazwa)}
        nick={nick}
        zablokowani={zablokowani}
        onZablokuj={(username) => void zablokuj(username)}
        onOdblokuj={(username) => void odblokuj(username)}
        onDodajOsobe={(username) => dodajOsobe(id, username)}
        onOpuscGrupe={() => void opuscGrupe(id)}
        znikanieSekundy={znikanie[kluczRozmowy(id)] ?? null}
        onZnikanie={(sekundy) => void zmienZnikanie(id, sekundy)}
      />
    );
  }
}

/**
 * Szyna nawigacji: znak, Rozmowy, Ustawienia. Motyw i język są w ustawieniach —
 * segment trzech przycisków nie mieści się w kolumnie szerokości ikony.
 *
 * Na desktopie wąska kolumna z ikonami; na telefonie arkusz stylów przenosi ją
 * na dół jako pasek pod kciukiem. Aktywna gałąź to `tekst` na `wglebienie`,
 * nieaktywna `tekst-drugi` — bez kolorowej pigułki, kolor jest dla stanów.
 */
function Szyna({
  galaz,
  onGalaz,
  nieprzeczytane,
}: {
  galaz: Galaz;
  onGalaz: (g: Galaz) => void;
  nieprzeczytane: number;
}) {
  const galezie: { klucz: Galaz; ikona: NazwaIkony; etykieta: string }[] = [
    { klucz: "rozmowy", ikona: "rozmowy", etykieta: t("Rozmowy", "Chats") },
    { klucz: "konto", ikona: "suwaki", etykieta: t("Ustawienia", "Settings") },
  ];

  return (
    <nav className="szyna" aria-label={t("Nawigacja", "Navigation")}>
      <ZnakMarki className="mb-3 hidden size-8 md:block" />
      {galezie.map((g) => {
        const aktywna = galaz === g.klucz;
        return (
          <button
            key={g.klucz}
            type="button"
            title={g.etykieta}
            aria-current={aktywna ? "page" : undefined}
            onClick={() => onGalaz(g.klucz)}
            className={cn(
              "relative flex flex-col items-center gap-0.5 rounded-m px-3 py-1.5 text-[11px] font-medium transition-colors md:size-11 md:justify-center md:p-0",
              aktywna ? "bg-wglebienie text-tekst" : "text-tekst-drugi hover:bg-wglebienie hover:text-tekst",
            )}
          >
            <Ikona nazwa={g.ikona} rozmiar={20} />
            <span className="md:sr-only">{g.etykieta}</span>
            {g.klucz === "rozmowy" && nieprzeczytane > 0 && (
              <Znacznik liczba={nieprzeczytane} className="absolute -top-0.5 right-1 md:-right-1" />
            )}
          </button>
        );
      })}
    </nav>
  );
}
