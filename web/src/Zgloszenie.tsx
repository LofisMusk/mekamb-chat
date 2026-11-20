import { useState } from "react";

import { Ikona } from "./Ikony";
import { api } from "./lib/api";
import { t } from "./lib/jezyk";

/**
 * Zgłoszenie błędu — z konta prosto do issues na GitHubie.
 *
 * # Dlaczego mówimy wprost, że to jest publiczne
 *
 * Bo jest. Issue trafia na otwartą stronę internetową, którą przeczyta
 * ktokolwiek — i to jedyne miejsce w tej aplikacji, gdzie coś od użytkownika
 * wychodzi na zewnątrz jawnie. Napisanie tego dopiero w potwierdzeniu byłoby
 * napisaniem po fakcie; ostrzeżenie ma wartość tylko wtedy, gdy stoi PRZED
 * polem, w które się pisze.
 *
 * Serwer i tak nie przepuści niczego poza tymi dwoma polami (`zgloszenia.ts`),
 * ale to jest zabezpieczenie przed nami — przed tym, żebyśmy kiedyś czegoś nie
 * dołożyli po cichu. Przed wklejeniem czegoś we własną treść nie zabezpieczy
 * nikogo, bo to decyzja piszącego. Stąd zdanie na ekranie.
 *
 * # Dlaczego kontekst wypełnia się sam, a mimo to jest widoczny
 *
 * Bo „iPhone; Safari 17" nie jest czymś, co ktokolwiek chce przepisywać
 * z ustawień telefonu, a bez tego połowa zgłoszeń jest nie do odtworzenia.
 * Ale skoro to i tak pójdzie na publiczną stronę, użytkownik ma prawo zobaczyć,
 * co dokładnie — i wyczyścić to pole, jeśli mu się nie podoba. Pole edytowalne
 * jest tu jedyną uczciwą formą zgody.
 */

/**
 * Co wiemy o urządzeniu, nie pytając o nic identyfikującego.
 *
 * `userAgent` bywa długi i sam w sobie potrafi wyróżnić przeglądarkę spośród
 * innych, więc nie idzie w całość. Bierzemy z niego to, co pomaga odtworzyć
 * usterkę — system i silnik — i rozmiar okna, bo połowa zgłoszeń o układ
 * dotyczy konkretnego rozmiaru ekranu.
 */
function kontekstUrzadzenia(): string {
  const czesci: string[] = [];

  const ua = navigator.userAgent;
  const system = /iPhone|iPad|Android|Macintosh|Windows|Linux/.exec(ua)?.[0];
  const silnik = /(Firefox|Edg|Chrome|Version)\/(\d+)/.exec(ua);

  if (system) czesci.push(system);
  if (silnik) czesci.push(`${silnik[1] === "Version" ? "Safari" : silnik[1]} ${silnik[2]}`);

  czesci.push(`${window.innerWidth}×${window.innerHeight}`);
  return czesci.join(", ");
}

export function ZglosBlad({ token }: { token: string }) {
  const [otwarte, setOtwarte] = useState(false);
  const [opis, setOpis] = useState("");
  const [kontekst, setKontekst] = useState(kontekstUrzadzenia);
  const [wysylam, setWysylam] = useState(false);

  /*
   * Wynik jako jedna wartość, nie jako trzy niezależne flagi.
   *
   * „Wysłano" i „nie udało się" wykluczają się nawzajem, a trzymane osobno
   * potrafią być prawdziwe naraz — wtedy ekran pokazuje potwierdzenie i błąd
   * jednocześnie.
   */
  const [wynik, setWynik] = useState<{ udane: boolean; tekst: string } | null>(null);

  const wyslij = async () => {
    if (!opis.trim() || wysylam) return;

    setWysylam(true);
    setWynik(null);

    try {
      const { numer } = await api.post<{ numer?: number }>(
        "/zgloszenia",
        { opis, kontekst },
        token,
      );

      setWynik({
        udane: true,
        tekst: numer ? t(`Wysłane — zgłoszenie nr ${numer}. Dziękujemy.`, `Sent — report no. ${numer}. Thank you.`) : t("Wysłane. Dziękujemy.", "Sent. Thank you."),
      });
      setOpis("");
    } catch (err) {
      // Treść zostaje w polu: zawiodła sieć, nie użytkownik, a przepisywanie
      // opisu od nowa jest karą za cudzą usterkę.
      setWynik({
        udane: false,
        tekst: err instanceof Error ? err.message : t("Nie udało się wysłać.", "Couldn't send."),
      });
    } finally {
      setWysylam(false);
    }
  };

  if (!otwarte) {
    return (
      <div className="karta">
        <strong>{t("Coś nie działa?", "Something not working?")}</strong>
        <p className="wskazowka">{t("Napisz nam o tym — poprawimy.", "Tell us about it — we'll fix it.")}</p>
        <button onClick={() => setOtwarte(true)}>
          <Ikona nazwa="ostrzezenie" rozmiar={16} />
          {t("Zgłoś błąd", "Report a bug")}
        </button>
      </div>
    );
  }

  return (
    <form
      className="karta"
      onSubmit={(e) => {
        e.preventDefault();
        void wyslij();
      }}
    >
      <strong>{t("Zgłoś błąd", "Report a bug")}</strong>

      {/* Przed polem, nie po nim — patrz komentarz na górze pliku. */}
      <p className="wskazowka-ikona">
        <Ikona nazwa="info" rozmiar={14} />
        {t("Zgłoszenie trafia na publiczną stronę projektu, gdzie każdy może je przeczytać. Nie wysyłamy Twojej nazwy ani niczego z rozmów — ale nie wpisuj tu rzeczy, których nie chcesz pokazać.", "Reports go to the project's public page, where anyone can read them. We don't send your name or anything from your conversations — but don't write anything here you don't want to show.")}
      </p>

      <label>
        {t("Co się stało?", "What happened?")}
        <textarea
          rows={4}
          value={opis}
          onChange={(e) => setOpis(e.target.value)}
          placeholder={t("Np. aplikacja gaśnie, kiedy odbieram połączenie.", "E.g. the app closes when I answer a call.")}
          required
        />
      </label>

      <label>
        {t("Urządzenie i przeglądarka", "Device and browser")}
        <input value={kontekst} onChange={(e) => setKontekst(e.target.value)} />
      </label>

      {wynik && (
        <p className={wynik.udane ? "wskazowka" : "wskazowka uwaga"}>{wynik.tekst}</p>
      )}

      <div className="rzad-przyciskow">
        <button className="glowny" disabled={!opis.trim() || wysylam}>
          <Ikona nazwa="wyslij" rozmiar={16} />
          {wysylam ? t("Wysyłam…", "Sending…") : t("Wyślij", "Send")}
        </button>
        <button
          type="button"
          onClick={() => {
            setOtwarte(false);
            setWynik(null);
          }}
        >
          {t("Anuluj", "Cancel")}
        </button>
      </div>
    </form>
  );
}
