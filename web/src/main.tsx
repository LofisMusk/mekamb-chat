import { StrictMode } from "react";
import { createRoot } from "react-dom/client";

import { App } from "./App";
import "./styles.css";

createRoot(document.getElementById("root")!).render(
  <StrictMode>
    <App />
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
