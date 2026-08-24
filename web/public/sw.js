// Service worker: offline'owy szkielet aplikacji i odbiór powiadomień.
//
// UWAGA CO DO PRYWATNOŚCI: ładunek powiadomienia jest WYŁĄCZNIE budzący.
// Nie ma w nim nadawcy, treści ani identyfikatora grupy — dostawca push
// (Apple, Google) jest stroną trzecią i nie może się z niego niczego dowiedzieć.
// Po wybudzeniu klient sam pobiera dane ze swojej skrzynki.

/**
 * Nazwa pamięci podręcznej.
 *
 * Podniesiona z `v1`, żeby wyrzucić zapisy sprzed naprawy: tamta wersja
 * zapisała `index.html` i serwowała go już zawsze z dysku.
 */
const CACHE = "mekamb-v2";

self.addEventListener("install", (event) => {
  self.skipWaiting();
  event.waitUntil(caches.open(CACHE));
});

self.addEventListener("activate", (event) => {
  event.waitUntil(
    caches
      .keys()
      .then((names) => Promise.all(names.filter((n) => n !== CACHE).map((n) => caches.delete(n))))
      .then(() => self.clients.claim()),
  );
});

/**
 * # Dokument z sieci, zasoby z dysku
 *
 * Poprzednia wersja brała z dysku WSZYSTKO, łącznie z `index.html`. Raz
 * zapisany dokument wskazywał na ten sam, zahaszowany plik JavaScriptu już na
 * zawsze — a że jego też brała z dysku, aplikacja nigdy się nie aktualizowała.
 * Każde wdrożenie było niewidoczne dla kogokolwiek, kto raz ją otworzył.
 *
 * Teraz dokument idzie z sieci, a z dysku tylko wtedy, gdy sieci nie ma. Pliki
 * z haszem w nazwie zostają na dysku, bo ich zawartość nie może się zmienić —
 * zmiana zawartości daje nową nazwę. Wszystko pozostałe idzie ścieżką
 * dokumentu: „najpierw dysk" dla pliku bez hasza przypina go na zawsze.
 */
function jestDokumentem(request) {
  return (
    request.mode === "navigate" ||
    request.destination === "document" ||
    new URL(request.url).pathname.endsWith("/")
  );
}

/**
 * Czy nazwa pliku niesie hasz zawartości.
 *
 * Tylko takie wolno brać „najpierw z dysku": zmiana zawartości daje nową
 * nazwę, więc zapis nigdy się nie zestarzeje. Wcześniej ta gałąź obejmowała
 * WSZYSTKO poza dokumentem, a więc także `manifest.webmanifest` i inne pliki
 * z `public/`, które hasza nie mają — raz zapisane zostawały do ręcznej zmiany
 * `CACHE`. To ten sam mechanizm, przez który aplikacja nie aktualizowała się
 * wcale, tylko o klasę mniej dotkliwy.
 *
 * Vite wstawia hasz w nazwę plików z `assets/`, w postaci `nazwa-a1b2c3d4.js`.
 */
function maHaszWNazwie(url) {
  return /-[0-9a-zA-Z_]{8,}\.[a-z0-9]+$/.test(new URL(url).pathname);
}

self.addEventListener("fetch", (event) => {
  const request = event.request;

  // Cachujemy wyłącznie własne zasoby statyczne. Ruch do API nigdy nie trafia
  // do cache — to szyfrogramy, których nie ma po co duplikować na dysku.
  if (request.method !== "GET" || new URL(request.url).origin !== self.location.origin) {
    return;
  }

  if (jestDokumentem(request)) {
    event.respondWith(
      fetch(request)
        .then((response) => {
          if (response.ok) {
            const copy = response.clone();
            caches.open(CACHE).then((cache) => cache.put(request, copy));
          }
          return response;
        })
        // Bez sieci pokazujemy ostatnią znaną wersję — to jedyny powód,
        // dla którego dokument w ogóle trafia na dysk.
        .catch(() => caches.match(request).then((cached) => cached ?? Response.error())),
    );
    return;
  }

  // Pliki z haszem: najpierw dysk. Ich zawartość nie może się zmienić.
  if (maHaszWNazwie(request.url)) {
    event.respondWith(
      caches.match(request).then(
        (cached) =>
          cached ??
          fetch(request).then((response) => {
            if (response.ok) {
              const copy = response.clone();
              caches.open(CACHE).then((cache) => cache.put(request, copy));
            }
            return response;
          }),
      ),
    );
    return;
  }

  // Reszta — jak dokument: z sieci, a dysk jako zapas na brak sieci.
  event.respondWith(
    fetch(request)
      .then((response) => {
        if (response.ok) {
          const copy = response.clone();
          caches.open(CACHE).then((cache) => cache.put(request, copy));
        }
        return response;
      })
      .catch(() => caches.match(request).then((cached) => cached ?? Response.error())),
  );
});

self.addEventListener("push", (event) => {
  // Celowo nie czytamy `event.data`: ładunek nie zawiera niczego wrażliwego,
  // a treść pokazujemy dopiero po pobraniu i odszyfrowaniu przez aplikację.
  event.waitUntil(
    self.registration.showNotification("mekamb-chat", {
      body: "Masz nowe wiadomości",
      tag: "mekamb-nowe",
    }),
  );
});

self.addEventListener("notificationclick", (event) => {
  event.notification.close();
  event.waitUntil(self.clients.openWindow(self.registration.scope));
});
