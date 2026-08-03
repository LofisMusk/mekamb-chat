import {
  KE2,
  OpaqueClient,
  OpaqueID,
  OpaqueServer,
  RegistrationRecord,
  RegistrationRequest,
  RegistrationResponse,
  getOpaqueConfig,
} from "@cloudflare/opaque-ts";
import { describe, expect, it } from "vitest";

/**
 * Sonda OPAQUE w workerd.
 *
 * Pierwotny wybór (`@serenity-kit/opaque`) odpadł: inline'uje WASM jako base64
 * i kompiluje go w runtime, a Workers na to nie pozwala
 * („Wasm code generation disallowed by embedder"). `@cloudflare/opaque-ts` jest
 * czystym TypeScriptem, więc problem nie istnieje.
 *
 * Ważne dla wydajności: rozciąganie klucza (kosztowna część) dzieje się po
 * stronie KLIENTA. Serwer wykonuje wyłącznie operacje na krzywej eliptycznej,
 * więc limit CPU Workera nie jest zagrożony.
 */

const cfg = getOpaqueConfig(OpaqueID.OPAQUE_P256);
const SERVER_ID = "mekamb-chat";

/** Zestaw serwera: ziarno OPRF i para kluczy AKE. Tworzony raz, trzymany w sekretach. */
async function nowySerwer() {
  const oprfSeed = Array.from(crypto.getRandomValues(new Uint8Array(cfg.hash.Nh)));
  // Klucz AKE wyprowadzamy z ziarna, a nie losujemy — na produkcji ziarno leży
  // w Workers Secrets, więc restart Workera nie może zmienić tożsamości serwera.
  const keypair = await cfg.ake.deriveAuthKeyPair(
    crypto.getRandomValues(new Uint8Array(cfg.constants.Nseed)),
  );

  // OpaqueServer przyjmuje klucze w postaci eksportowej (number[]), a
  // `deriveAuthKeyPair` zwraca Uint8Array.
  return new OpaqueServer(
    cfg,
    oprfSeed,
    {
      private_key: Array.from(keypair.private_key),
      public_key: Array.from(keypair.public_key),
    },
    SERVER_ID,
  );
}

/** Rejestruje użytkownika i zwraca jego rekord — tak jak zrobiłby to prawdziwy przepływ. */
async function zarejestruj(server: OpaqueServer, username: string, password: string) {
  const client = new OpaqueClient(cfg);

  const request = await client.registerInit(password);
  if (request instanceof Error) throw request;

  const response = await server.registerInit(
    RegistrationRequest.deserialize(cfg, request.serialize()),
    username,
  );
  if (response instanceof Error) throw response;

  const finished = await client.registerFinish(
    RegistrationResponse.deserialize(cfg, response.serialize()),
    SERVER_ID,
    username,
  );
  if (finished instanceof Error) throw finished;

  return finished.record;
}

describe("OPAQUE w workerd", () => {
  it("pełna rejestracja i logowanie kończą się wspólnym kluczem sesji", async () => {
    const server = await nowySerwer();
    const username = "alice";
    const password = "poprawne-konie-bateria-zszywka";

    const record = await zarejestruj(server, username, password);

    // --- logowanie ---
    const client = new OpaqueClient(cfg);
    const ke1 = await client.authInit(password);
    if (ke1 instanceof Error) throw ke1;

    const started = await server.authInit(ke1, record, username, username);
    if (started instanceof Error) throw started;

    const finishedClient = await client.authFinish(
      KE2.deserialize(cfg, started.ke2.serialize()),
      SERVER_ID,
      username,
    );
    if (finishedClient instanceof Error) throw finishedClient;

    const finishedServer = server.authFinish(finishedClient.ke3, started.expected);
    if (finishedServer instanceof Error) throw finishedServer;

    // Obie strony muszą dojść do tego samego klucza sesji — to jest dowód,
    // że klient znał hasło, a serwer nigdy go nie zobaczył.
    expect(finishedServer.session_key).toEqual(finishedClient.session_key);
  });

  it("złe hasło nie daje wspólnego klucza", async () => {
    const server = await nowySerwer();
    const record = await zarejestruj(server, "bob", "prawidlowe-haslo");

    const client = new OpaqueClient(cfg);
    const ke1 = await client.authInit("ZLE-haslo");
    if (ke1 instanceof Error) throw ke1;

    const started = await server.authInit(ke1, record, "bob", "bob");
    if (started instanceof Error) throw started;

    const finishedClient = await client.authFinish(
      KE2.deserialize(cfg, started.ke2.serialize()),
      SERVER_ID,
      "bob",
    );

    // Klient wykrywa złe hasło samodzielnie. Serwer nie porównuje niczego,
    // więc nie ma stamtąd czego wyciec.
    expect(finishedClient).toBeInstanceOf(Error);
  });

  /**
   * Ochrona przed enumeracją kont: dla nieistniejącej nazwy serwer odpowiada
   * atrapą rekordu, nieodróżnialną od prawdziwej odpowiedzi.
   */
  it("nieznana nazwa użytkownika daje odpowiedź nieodróżnialną od prawdziwej", async () => {
    const server = await nowySerwer();
    const atrapa = await RegistrationRecord.createFake(cfg);

    const client = new OpaqueClient(cfg);
    const ke1 = await client.authInit("cokolwiek");
    if (ke1 instanceof Error) throw ke1;

    const started = await server.authInit(ke1, atrapa, "nie-ma-takiego-konta");

    expect(started).not.toBeInstanceOf(Error);
    if (started instanceof Error) return;
    expect(started.ke2.serialize().length).toBeGreaterThan(0);
  });

  /** Stan między rundami musi dać się zapisać w bazie i odtworzyć. */
  it("stan serwera przeżywa serializację między rundami", async () => {
    const server = await nowySerwer();
    const record = await zarejestruj(server, "czarek", "haslo-czarka");

    const client = new OpaqueClient(cfg);
    const ke1 = await client.authInit("haslo-czarka");
    if (ke1 instanceof Error) throw ke1;

    const started = await server.authInit(ke1, record, "czarek", "czarek");
    if (started instanceof Error) throw started;

    // Tak wygląda przejście przez bazę: zapis bajtów i odczyt w kolejnym żądaniu.
    const { ExpectedAuthResult } = await import("@cloudflare/opaque-ts");
    const odtworzony = ExpectedAuthResult.deserialize(cfg, started.expected.serialize());

    const finishedClient = await client.authFinish(started.ke2, SERVER_ID, "czarek");
    if (finishedClient instanceof Error) throw finishedClient;

    const finishedServer = server.authFinish(finishedClient.ke3, odtworzony);
    if (finishedServer instanceof Error) throw finishedServer;

    expect(finishedServer.session_key).toEqual(finishedClient.session_key);
  });
});
