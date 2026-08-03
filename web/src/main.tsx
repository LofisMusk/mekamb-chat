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
    navigator.serviceWorker.register(`${import.meta.env.BASE_URL}sw.js`).catch(() => {
      // Brak service workera oznacza brak trybu offline i powiadomień,
      // ale sama aplikacja działa dalej.
    });
  });
}
