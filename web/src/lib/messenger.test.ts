import { describe, it, expect } from "vitest";

import { Messenger, type ReceivedMessage } from "./messenger";

/**
 * Broni najważniejszej naprawy DM: `handleEnvelope` szereguje koperty.
 *
 * # Sedno
 *
 * Koperty przychodzą seriami (sygnały rozmowy A/V, kolejne koperty przy wysyłce
 * zdjęcia), a wołający puszcza je BEZ czekania (`void obsluzKoperte(…)`). Każda
 * przesuwa ten sam ratchet MLS i zapisuje stan, więc dwie naraz przeplatały
 * `receive` z zapisem i utrwalały stan STARSZY o epokę niż już potwierdzona
 * operacja — kolejne wiadomości nie odszyfrowywały się już nigdy, bez śladu
 * błędu. Łańcuch obietnic (`lancuchKopert`) ma temu zapobiec: kolejna koperta
 * czeka na poprzednią, a `finally` zwalnia następną nawet gdy ta rzuci.
 *
 * Testujemy samą warstwę szeregującą — przetwarzanie (`przetworzKoperte`)
 * podmieniamy na atrapę, bo prawdziwe wymaga rdzenia MLS w WASM. Instancję
 * budujemy bez prywatnego konstruktora: interesuje nas wyłącznie kontrakt
 * kolejki, nie stan klienta.
 */
describe("szeregowanie kopert w handleEnvelope", () => {
  function pustyMessenger(): Messenger {
    const m = Object.create(Messenger.prototype) as Messenger;
    // Pole-domyślne klasy nie odpala się przy `Object.create`, więc łańcuch
    // trzeba zasiać ręcznie — inaczej pierwsze `await poprzednia` wywala się na
    // `undefined`.
    (m as unknown as { lancuchKopert: Promise<void> }).lancuchKopert = Promise.resolve();
    return m;
  }

  const koperta = (etykieta: string): Uint8Array => new TextEncoder().encode(etykieta);
  const odczytaj = (bytes: Uint8Array): string => new TextDecoder().decode(bytes);

  it("dwie koperty puszczone bez await przetwarzają się PO KOLEI, bez przeplotu", async () => {
    const m = pustyMessenger();
    const zdarzenia: string[] = [];

    let odblokujA!: () => void;
    const bramaA = new Promise<void>((res) => {
      odblokujA = res;
    });

    // Atrapa przetwarzania: A zatrzymuje się w środku (jak `await` na zapisie),
    // B nie ma prawa wejść, dopóki A nie skończy.
    (m as unknown as { przetworzKoperte: (b: Uint8Array) => Promise<ReceivedMessage | null> }).przetworzKoperte =
      async (bytes: Uint8Array): Promise<ReceivedMessage | null> => {
        const etykieta = odczytaj(bytes);
        zdarzenia.push(`wejscie:${etykieta}`);
        if (etykieta === "a") await bramaA;
        zdarzenia.push(`wyjscie:${etykieta}`);
        return null;
      };

    // Dokładnie tak, jak robi to `Czat.tsx`: bez await.
    const pA = m.handleEnvelope(koperta("a"));
    const pB = m.handleEnvelope(koperta("b"));

    // Poczekaj, aż A na pewno weszło i utknęło na bramie. B musi wtedy wciąż
    // czekać w kolejce — nie wolno mu wejść w środek A.
    await new Promise((res) => setTimeout(res, 0));
    expect(zdarzenia).toEqual(["wejscie:a"]);

    odblokujA();
    await Promise.all([pA, pB]);

    // Pełna kolejność: A od początku do końca, dopiero potem B.
    expect(zdarzenia).toEqual(["wejscie:a", "wyjscie:a", "wejscie:b", "wyjscie:b"]);
  });

  it("błąd pierwszej koperty NIE blokuje drugiej — finally zwalnia kolejkę", async () => {
    const m = pustyMessenger();
    const przetworzone: string[] = [];

    (m as unknown as { przetworzKoperte: (b: Uint8Array) => Promise<ReceivedMessage | null> }).przetworzKoperte =
      async (bytes: Uint8Array): Promise<ReceivedMessage | null> => {
        const etykieta = odczytaj(bytes);
        // Rzut w normalnym biegu (powtórka, nieaktualna epoka) — kolejka nie
        // może się przez to zablokować.
        if (etykieta === "zla") throw new Error("nieaktualna epoka");
        przetworzone.push(etykieta);
        return null;
      };

    const pZla = m.handleEnvelope(koperta("zla"));
    const pDobra = m.handleEnvelope(koperta("dobra"));

    await expect(pZla).rejects.toThrow("nieaktualna epoka");
    await expect(pDobra).resolves.toBeNull();

    // Druga przeszła mimo rzutu pierwszej — łańcuch nie został zatruty.
    expect(przetworzone).toEqual(["dobra"]);

    // I kolejna po nich wciąż działa (ogon łańcucha zwolniony, nie odrzucony).
    await expect(m.handleEnvelope(koperta("kolejna"))).resolves.toBeNull();
    expect(przetworzone).toEqual(["dobra", "kolejna"]);
  });
});
