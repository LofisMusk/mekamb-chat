import { SELF, env } from "cloudflare:test";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";

import { issueToken } from "../src/crypto";

/**
 * Sedno: issue na GitHubie jest PUBLICZNE.
 *
 * To jedyne miejsce w tej aplikacji, w którym cokolwiek użytkownika może wyjść
 * na otwartą stronę internetową — i dzieje się to za jego własnym kliknięciem,
 * w chwili, w której jest zirytowany usterką. Dlatego treść zgłoszenia składa
 * SERWER z dwóch pól, zamiast przepisywać cokolwiek z żądania: gdyby zależało
 * to od dyscypliny klienta, wystarczyłoby jedno przeoczenie w jednej z dwóch
 * aplikacji, żeby nazwa użytkownika albo fragment rozmowy trafiły na GitHuba.
 *
 * Testy sprawdzają to na podstawionym `fetch`, bo prawdziwego GitHuba w CI
 * nie ma — a interesuje nas dokładnie to, CO byśmy do niego wysłali.
 */

/** Pola, które klient mógłby podrzucić, a które nie mają prawa nigdzie wyjść. */
const PODRZUCONE = {
  username: "alicja",
  deviceId: "urzadzenie-7",
  groupId: "0123456789abcdef",
  wiadomosci: ["do zobaczenia o 18", "jestem pod domem"],
  title: "tytuł spreparowany przez klienta",
  labels: ["security"],
};

async function token(userId = "alicja"): Promise<string> {
  return issueToken(env.TOKEN_SIGNING_KEY, {
    userId,
    deviceId: "test",
    expiresAt: Date.now() + 60_000,
  });
}

/** Co poszło do GitHuba przy ostatnim zgłoszeniu. */
let wyslane: { url: string; body: Record<string, unknown> } | null = null;

const prawdziwyFetch = globalThis.fetch;

beforeEach(() => {
  wyslane = null;
  (env as Record<string, unknown>).GITHUB_TOKEN = "token-testowy";

  vi.stubGlobal("fetch", async (wejscie: RequestInfo | URL, init?: RequestInit) => {
    const url = typeof wejscie === "string" ? wejscie : wejscie.toString();

    // Żądania do samego Workera muszą iść dalej — podstawiamy tylko GitHuba.
    if (!url.startsWith("https://api.github.com/")) {
      return prawdziwyFetch(wejscie as RequestInfo, init);
    }

    wyslane = { url, body: JSON.parse(String(init?.body ?? "{}")) };
    return new Response(JSON.stringify({ number: 42, html_url: `${url}/42` }), { status: 201 });
  });
});

afterEach(() => {
  vi.unstubAllGlobals();
  delete (env as Record<string, unknown>).GITHUB_TOKEN;
});

async function zglos(cialo: unknown, bearer?: string): Promise<Response> {
  return SELF.fetch("https://mekamb/zgloszenia", {
    method: "POST",
    headers: {
      "Content-Type": "application/json",
      ...(bearer ? { Authorization: `Bearer ${bearer}` } : {}),
    },
    body: JSON.stringify(cialo),
  });
}

describe("zgłoszenia błędów", () => {
  it("zakłada issue i oddaje jego numer", async () => {
    const odpowiedz = await zglos({ opis: "Nie działa dzwonienie" }, await token("zg1"));

    expect(odpowiedz.status).toBe(200);
    await expect(odpowiedz.json()).resolves.toMatchObject({ numer: 42 });
    expect(wyslane?.url).toContain("/repos/");
  });

  /*
   * To jest ten test. Klient podrzuca wszystko, czym mógłby zdradzić
   * użytkownika; do GitHuba ma pójść wyłącznie to, co człowiek napisał sam.
   */
  it("nie wynosi niczego poza opisem i kontekstem", async () => {
    await zglos(
      { opis: "Aplikacja gaśnie przy dzwonieniu", kontekst: "iPhone 13, Safari", ...PODRZUCONE },
      await token("zg2"),
    );

    const wyslanyTekst = JSON.stringify(wyslane?.body);

    for (const zakazane of [
      PODRZUCONE.username,
      PODRZUCONE.deviceId,
      PODRZUCONE.groupId,
      ...PODRZUCONE.wiadomosci,
    ]) {
      expect(wyslanyTekst).not.toContain(zakazane);
    }

    expect(wyslane?.body.body).toContain("Aplikacja gaśnie przy dzwonieniu");
    expect(wyslane?.body.body).toContain("iPhone 13, Safari");
  });

  /*
   * Tytuł i etykiety też układa serwer. Klient, który mógłby je podać, mógłby
   * napisać na GitHubie cokolwiek — łącznie z treścią, której nie widać
   * w formularzu zgłoszenia.
   */
  it("tytuł i etykiety układa serwer, nie klient", async () => {
    await zglos({ opis: "Pierwszy wiersz\ndrugi wiersz", ...PODRZUCONE }, await token("zg3"));

    expect(wyslane?.body.title).toBe("Pierwszy wiersz");
    expect(wyslane?.body.labels).toEqual(["z aplikacji"]);
  });

  /*
   * Bez zalogowania endpoint byłby otwartą bramką do zakładania issues
   * w naszym repozytorium przez każdego, kto zna adres.
   */
  it("odmawia bez tokenu dostępowego", async () => {
    const odpowiedz = await zglos({ opis: "cokolwiek" });

    expect(odpowiedz.status).toBe(401);
    expect(wyslane).toBeNull();
  });

  it("odmawia pustemu zgłoszeniu, zamiast zakładać puste issue", async () => {
    const odpowiedz = await zglos({ opis: "   " }, await token("zg4"));

    expect(odpowiedz.status).toBe(400);
    expect(wyslane).toBeNull();
  });

  /*
   * Wdrożenie bez tokenu jest poprawnym stanem — ale musi powiedzieć wprost,
   * że nie wysłało, zamiast potwierdzić przyjęcie zgłoszenia, które nigdzie
   * nie poszło.
   */
  it("mówi wprost, gdy serwer nie ma skonfigurowanych zgłoszeń", async () => {
    delete (env as Record<string, unknown>).GITHUB_TOKEN;

    const odpowiedz = await zglos({ opis: "coś nie działa" }, await token("zg5"));

    expect(odpowiedz.status).toBe(503);
    expect(wyslane).toBeNull();
  });
});
