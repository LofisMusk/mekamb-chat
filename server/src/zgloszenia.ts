import { Hono } from "hono";

import type { Env } from "./env";
import { requireAuth } from "./middleware";

/**
 * Zgłoszenia błędów — z aplikacji prosto do issues na GitHubie.
 *
 * # Dlaczego przez serwer, a nie wprost z aplikacji
 *
 * Bo założenie issue wymaga tokenu GitHuba, a token włożony do klienta jest
 * tokenem oddanym każdemu: aplikacja webowa leży w przeglądarce, APK da się
 * rozpakować. Ktokolwiek by go wyjął, mógłby pisać w repozytorium pod naszym
 * kontem. Token zostaje więc na serwerze, a klient prosi o przysługę.
 *
 * # Dlaczego zgłoszenie wymaga zalogowania
 *
 * Nie po to, żeby wiedzieć, kto zgłasza — nazwy użytkownika nie zapisujemy
 * nigdzie w treści (patrz niżej). Po to, żeby ten endpoint nie był otwartą
 * bramką do zakładania issues w cudzym repozytorium przez każdego, kto zna
 * adres. Bez tego pierwszy przechodzący bot zasypałby repozytorium.
 *
 * # Co NIE trafia do zgłoszenia i dlaczego to jest sedno
 *
 * **Issue na GitHubie jest publiczne.** Zgłoszenie błędu w komunikatorze jest
 * więc jedynym miejscem w tej aplikacji, w którym dane użytkownika mogłyby
 * wyjść na otwartą stronę internetową — i to za jego własnym kliknięciem,
 * w chwili, w której jest zirytowany usterką i najmniej skłonny czytać.
 *
 * Dlatego treść zgłoszenia to **wyłącznie** to, co człowiek sam napisał, plus
 * garść danych technicznych, które nie wskazują na osobę. Klient nie ma jak
 * dołączyć niczego więcej, bo serwer bierze tylko te dwa pola i wszystko inne
 * z żądania po prostu wyrzuca. Gdyby zależało to od dyscypliny po stronie
 * klienta, wystarczyłoby jedno przeoczenie w jednej z dwóch aplikacji.
 *
 * Nazwa użytkownika, identyfikator urządzenia, treść wiadomości, nazwy rozmów
 * i identyfikatory grup nie mają tu wstępu w ogóle. Ekran zgłoszenia mówi
 * o tym wprost, zanim ktokolwiek cokolwiek wyśle.
 */

const zgloszenia = new Hono<{ Bindings: Env }>();

/** Repozytorium, do którego idą zgłoszenia, gdy konfiguracja nie mówi inaczej. */
const REPO_DOMYSLNE = "LofisMusk/mekamb-chat";

/**
 * Górna granica opisu.
 *
 * Dość na opowiedzenie, co się stało, i za mało na wklejenie całej rozmowy —
 * co jest tu granicą właściwą, bo issue jest publiczne. Ucinamy zamiast
 * odrzucać: zgłoszenie ucięte jest wciąż użyteczne, a odrzucone przepada razem
 * z tym, co ktoś napisał.
 */
const LIMIT_OPISU = 4_000;

/** Tyle samo powodów co przy opisie, tylko że tu i tak nikt nie pisze więcej. */
const LIMIT_KONTEKSTU = 500;

/**
 * Limit zgłoszeń: trzy na serię, jedno odnawiane co pięć minut.
 *
 * Zgłaszanie błędów jest czynnością rzadką — kto trafi na usterkę, opisze ją
 * raz. Trzy pod rząd starczą na pomyłkę i poprawkę, a nie pozwalają zalać
 * repozytorium z jednego konta.
 */
const KUBELEK = { pojemnosc: 3, naSekunde: 1 / 300 };

interface Zgloszenie {
  opis?: unknown;
  kontekst?: unknown;
}

/** Skraca i przycina tekst od użytkownika; puste zwraca jako pustkę. */
function tekst(wartosc: unknown, limit: number): string {
  return typeof wartosc === "string" ? wartosc.trim().slice(0, limit) : "";
}

/**
 * Tytuł issue z pierwszego wiersza opisu.
 *
 * Osobne pole „tytuł" w formularzu byłoby drugą rzeczą do wymyślenia dla kogoś,
 * kto chce tylko powiedzieć, że coś nie działa. Pierwsze zdanie i tak nim jest.
 */
function tytul(opis: string): string {
  const pierwszy = opis.split("\n")[0]?.trim() ?? "";
  const skrocony = pierwszy.length > 80 ? `${pierwszy.slice(0, 77)}…` : pierwszy;
  return skrocony || "Zgłoszenie z aplikacji";
}

zgloszenia.post("/", requireAuth, async (c) => {
  const token = c.env.GITHUB_TOKEN;

  if (!token) {
    // Brak konfiguracji nie jest awarią serwera — to wdrożenie bez zgłoszeń.
    // Klient ma o tym powiedzieć wprost, zamiast udawać, że wysłał.
    return c.json({ error: "zgłoszenia nie są skonfigurowane na tym serwerze" }, 503);
  }

  const cialo = await c.req.json<Zgloszenie>().catch(() => ({}) as Zgloszenie);
  const opis = tekst(cialo.opis, LIMIT_OPISU);
  const kontekst = tekst(cialo.kontekst, LIMIT_KONTEKSTU);

  if (!opis) return c.json({ error: "puste zgłoszenie" }, 400);

  /*
   * Limit PO sprawdzeniu treści, nie przed.
   *
   * Kubełek liczy trzy zgłoszenia na pięć minut, a odrzucone zgłoszenie nie
   * dociera nigdzie i niczego nie kosztuje — poza tym jednym żądaniem. Gdyby
   * zużywało slot, wysłanie pustego formularza dwa razy z rzędu zamykałoby
   * drogę na kwadrans komuś, kto właśnie próbuje opisać usterkę. Ochroną przed
   * zalewem jest to, że issue zakłada wyłącznie zgłoszenie z treścią.
   */
  const uzytkownik = c.get("userId");
  const limiter = c.env.RATE_LIMITER.get(c.env.RATE_LIMITER.idFromName(`zgloszenia:${uzytkownik}`));
  const wynik = await limiter.consume(
    `zgloszenia:${uzytkownik}`,
    KUBELEK.pojemnosc,
    KUBELEK.naSekunde,
  );

  if (!wynik.allowed) {
    return c.json({ error: "zbyt wiele zgłoszeń" }, 429, {
      "Retry-After": String(Math.ceil(wynik.retryAfterMs / 1000)),
    });
  }

  /*
   * Treść składana TUTAJ, z dwóch pól, a nie przepisywana z żądania.
   *
   * To jest miejsce, w którym „nie wynosimy danych użytkownika" przestaje być
   * obietnicą, a staje się właściwością kodu: cokolwiek klient by dołożył do
   * żądania, nie ma jak trafić do publicznego issue, bo nikt tego stąd nie
   * czyta.
   */
  const body = [
    opis,
    "",
    "---",
    kontekst ? `Wersja i urządzenie: ${kontekst}` : "Wersja i urządzenie: nie podano",
    "",
    "_Zgłoszone z aplikacji. Zgłaszający jest anonimowy — nie przekazujemy nazwy" +
      " użytkownika ani niczego z rozmów._",
  ].join("\n");

  const repo = c.env.GITHUB_REPO ?? REPO_DOMYSLNE;

  const odpowiedz = await fetch(`https://api.github.com/repos/${repo}/issues`, {
    method: "POST",
    headers: {
      Authorization: `Bearer ${token}`,
      Accept: "application/vnd.github+json",
      "Content-Type": "application/json",
      // GitHub odrzuca żądania bez nagłówka `User-Agent` z kodem 403.
      "User-Agent": "mekamb-chat",
    },
    body: JSON.stringify({ title: tytul(opis), body, labels: ["z aplikacji"] }),
  }).catch(() => null);

  if (!odpowiedz?.ok) {
    // Powodu z GitHuba nie przekazujemy dalej: bywa w nim nazwa repozytorium
    // i zakres tokenu, a użytkownik i tak nie ma z tym co zrobić.
    return c.json({ error: "nie udało się wysłać zgłoszenia" }, 502);
  }

  const utworzone = (await odpowiedz.json()) as { number?: number; html_url?: string };
  return c.json({ numer: utworzone.number, adres: utworzone.html_url });
});

export default zgloszenia;
