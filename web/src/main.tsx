import { StrictMode } from "react";
import { createRoot } from "react-dom/client";

// Krój z własnego originu, nie z Google Fonts: CSP nie wpuszcza zewnętrznych
// fontów, a zapytanie do obcego serwera przy każdym starcie mówiłoby mu, kto
// i kiedy otwiera komunikator. Paczka dzieli krój na zakresy znaków, więc
// przeglądarka pobiera tylko te, których strona naprawdę używa.
import "@fontsource-variable/geist";
import "@fontsource-variable/geist-mono";

import { App } from "./App";
import { Awaria } from "./Awaria";
import { Toaster } from "./components/ui/sonner";
import { TooltipProvider } from "./components/ui/tooltip";
import "./styles.css";

createRoot(document.getElementById("root")!).render(
  <StrictMode>
    {/* Zapora na zewnątrz aplikacji: awaria w środku ma dać komunikat,
        a nie puste, ciemne tło — patrz `Awaria.tsx`. */}
    <Awaria>
      {/* Jeden dostawca podpowiedzi na całą aplikację: przejście kursorem
          z ikony na ikonę pokazuje następną od razu, bez ponownego czekania. */}
      <TooltipProvider delayDuration={400} skipDelayDuration={200}>
        <App />
      </TooltipProvider>
      {/* Poza aplikacją, żeby komunikat zgłoszony przy starcie — zanim powstał
          którykolwiek ekran — miał już gdzie się pokazać. */}
      <Toaster />
    </Awaria>
  </StrictMode>,
);

// Service worker daje offline'owy szkielet aplikacji i jest warunkiem
// koniecznym Web Push na iOS. Rejestrujemy go po starcie interfejsu, żeby nie
// opóźniać pierwszego renderu.
if ("serviceWorker" in navigator && import.meta.env.PROD) {
  window.addEventListener("load", () => {
    navigator.serviceWorker
      // `updateViaCache: "none"` znaczy, że sam plik service workera zawsze
      // idzie z sieci. Domyślnie przeglądarka trzyma go do doby — a to on
      // decyduje, jak serwowana jest reszta, więc jego własna nieaktualność
      // potrafi zabetonować całą aplikację.
      .register(`${import.meta.env.BASE_URL}sw.js`, { updateViaCache: "none" })
      .then((rejestracja) => {
        // Sprawdzenie przy każdym uruchomieniu: bez tego nowa wersja czeka do
        // momentu, w którym przeglądarka sama uzna, że warto zajrzeć.
        void rejestracja.update();
      })
      .catch(() => {
        // Brak service workera oznacza brak trybu offline i powiadomień,
        // ale sama aplikacja działa dalej.
      });
  });
}
