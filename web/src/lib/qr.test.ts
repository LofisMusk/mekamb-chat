import jsQR from "jsqr";
import QRCode from "qrcode";
import { describe, expect, it } from "vitest";

import { qrMatrix, qrMatrixZMaska, qrSvgPath } from "./qr";

/**
 * Weryfikacja **niezależnym dekoderem**, nie tym samym kodem w drugą stronę.
 *
 * Własny dekoder powtarzałby własne błędy: kod z odwróconą maską albo złą
 * informacją o formacie przeszedłby taki test i został odrzucony dopiero przez
 * aparat użytkownika. `jsqr` to osobna implementacja i jest zależnością
 * wyłącznie testową — do przeglądarki nie trafia.
 */
function odczytaj(tekst: string): string | null {
  const m = qrMatrix(tekst);
  const SKALA = 4;
  const MARGINES = 4 * SKALA;
  const bok = m.length * SKALA + MARGINES * 2;

  // jsqr oczekuje RGBA. Zaczynamy od bieli, żeby margines był jasny.
  const piksele = new Uint8ClampedArray(bok * bok * 4).fill(255);

  for (let y = 0; y < m.length; y++) {
    for (let x = 0; x < m.length; x++) {
      if (!m[y]?.[x]) continue;
      for (let dy = 0; dy < SKALA; dy++) {
        for (let dx = 0; dx < SKALA; dx++) {
          const px = MARGINES + x * SKALA + dx;
          const py = MARGINES + y * SKALA + dy;
          const i = (py * bok + px) * 4;
          piksele[i] = piksele[i + 1] = piksele[i + 2] = 0;
        }
      }
    }
  }

  return jsQR(piksele, bok, bok)?.data ?? null;
}

/** Macierz z niezależnego generatora, przy narzuconej masce. */
function referencja(tekst: string, maska: number): boolean[][] {
  // Wymuszony pojedynczy segment bajtowy. Domyślnie `qrcode` dzieli treść na
  // segmenty i przełącza tryby, żeby wyszło krócej — przy adresie `otpauth://`
  // zapisałby sekret z wielkich liter trybem alfanumerycznym. To też poprawny
  // kod QR, tylko inny, a porównanie ma wykrywać błędy, nie różnice strategii.
  const qr = QRCode.create([{ data: new TextEncoder().encode(tekst), mode: "byte" }], {
    errorCorrectionLevel: "M",
    maskPattern: maska as QRCode.QRCodeMaskPattern,
  });
  const bok = qr.modules.size;
  const dane = qr.modules.data;

  return Array.from({ length: bok }, (_, y) =>
    Array.from({ length: bok }, (_, x) => Boolean(dane[y * bok + x])),
  );
}

/**
 * Porównanie moduł po module z osobną implementacją.
 *
 * # Po co, skoro dekoder już przechodzi
 *
 * Bo dekoder jest zbyt wyrozumiały. Korekcja błędów poziomu M naprawia
 * kilkanaście procent uszkodzonych bajtów, więc kod z **realnym** błędem
 * konstrukcyjnym nadal się odczytuje — sprawdzone: wersja pomijająca kolumnę
 * taktującą i wersja z niepoprawnym wypełnieniem przechodziły test dekodera
 * bez zająknięcia. Test przez dekoder wyłapuje tylko katastrofy.
 *
 * Ścisła równość zjada cały zapas korekcji zamiast go wydawać, więc każdy
 * pojedynczy przestawiony moduł jest widoczny od razu.
 *
 * Wymaga trybu bajtowego po obu stronach: `qrcode` wybiera tryb najkrótszy,
 * więc treści z samych wielkich liter i cyfr zakodowałby alfanumerycznie.
 * Wszystkie ładunki tutaj mają małe litery, co ten tryb wyklucza.
 */
describe("zgodność z niezależnym generatorem", () => {
  const LADUNKI = [
    "mekamb",
    "otpauth://totp/mekamb-chat:produkcja?secret=SQ6LUXSL2N74M7D56G7OSZYQHJJ5U55F&issuer=mekamb-chat",
    "mekamb://transfer?i=vX3kQ9pLmN2rT7wYbC4dEg&k=n8Kp2mQ7vR4tY6uI9oP1aS3dF5gH7jK0lZ8xC2vB4nM",
    "a".repeat(150),
  ];

  for (const ladunek of LADUNKI) {
    for (let maska = 0; maska < 8; maska++) {
      it(`„${ladunek.slice(0, 24)}…" maska ${maska}`, () => {
        expect(qrMatrixZMaska(ladunek, maska)).toEqual(referencja(ladunek, maska));
      });
    }
  }
});

describe("kod QR", () => {
  it("krótki tekst wraca bez zmian", () => {
    expect(odczytaj("mekamb")).toBe("mekamb");
  });

  /// Realny ładunek pierwszego zastosowania.
  it("adres otpauth jest odczytywalny", () => {
    const uri =
      "otpauth://totp/mekamb-chat:produkcja?secret=SQ6LUXSL2N74M7D56G7OSZYQHJJ5U55F&issuer=mekamb-chat";
    expect(odczytaj(uri)).toBe(uri);
  });

  /// Realny ładunek drugiego zastosowania — przeniesienie konta.
  it("kod przeniesienia konta jest odczytywalny", () => {
    const kod =
      "mekamb://transfer?i=vX3kQ9pLmN2rT7wYbC4dEg&k=n8Kp2mQ7vR4tY6uI9oP1aS3dF5gH7jK0lZ8xC2vB4nM&f=12345 67890 12345 67890";
    expect(odczytaj(kod)).toBe(kod);
  });

  /// Każda wersja ma inny układ wzorów wyrównania, a od siódmej dochodzi blok
  /// informacji o wersji. Błąd w którymkolwiek psuje tylko część zakresu, więc
  /// pojedynczy rozmiar niczego nie dowodzi.
  it("wszystkie obsługiwane wersje dekodują się poprawnie", () => {
    const rozmiary = new Set<number>();

    for (let dlugosc = 1; dlugosc <= 200; dlugosc += 7) {
      const tekst = "A".repeat(dlugosc);
      expect(odczytaj(tekst), `długość ${dlugosc}`).toBe(tekst);
      rozmiary.add(qrMatrix(tekst).length);
    }

    // Wersje 1–10 to boki od 21 do 57 modułów.
    expect(Math.min(...rozmiary)).toBe(21);
    expect(Math.max(...rozmiary)).toBe(57);
    expect(rozmiary.size).toBeGreaterThanOrEqual(8);
  });

  /// Bajty spoza ASCII zajmują w UTF-8 więcej miejsca, niż wynika z długości
  /// napisu — pomylenie jednego z drugim przepełnia kod.
  it("znaki spoza ASCII przechodzą", () => {
    const tekst = "zażółć gęślą jaźń — ĄĆĘŁŃÓŚŹŻ";
    expect(odczytaj(tekst)).toBe(tekst);
  });

  it("dane za duże są odrzucane, a nie obcinane", () => {
    expect(() => qrMatrix("A".repeat(300))).toThrow(/nie mieszczą się/);
  });

  it("ścieżka SVG ma cichy margines po obu stronach", () => {
    const { d, rozmiar } = qrSvgPath("mekamb");

    expect(rozmiar).toBe(qrMatrix("mekamb").length + 8);
    expect(d.length).toBeGreaterThan(0);
    // Żaden moduł nie może wejść w margines ani wyjść poza obszar.
    for (const [, x, y] of d.matchAll(/M(\d+) (\d+)h/g)) {
      expect(Number(x)).toBeGreaterThanOrEqual(4);
      expect(Number(y)).toBeGreaterThanOrEqual(4);
      expect(Number(x)).toBeLessThan(rozmiar - 4);
      expect(Number(y)).toBeLessThan(rozmiar - 4);
    }
  });
});
