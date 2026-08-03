// Instancjonowanie modułu OPAQUE w Workers.
//
// Import `.wasm` daje tu skompilowany `WebAssembly.Module`, a nie gotową
// instancję — bundler nie robi tego kroku za nas. Tworzymy ją sami, co jest
// dozwolone: moduł jest już skompilowany, więc nie zachodzi generowanie kodu
// w runtime, którego środowisko zabrania.
//
// To był warunek całego przejścia na wspólną implementację OPAQUE; poprzednia
// biblioteka odpadła właśnie dlatego, że kompilowała WASM w locie.
import * as glue from "./mekamb_opaque_wasm_bg.js";
import modul from "./mekamb_opaque_wasm_bg.wasm";

const instancja = new WebAssembly.Instance(modul, {
  "./mekamb_opaque_wasm_bg.js": glue,
});

glue.__wbg_set_wasm(instancja.exports);

// `start` ustawia czytelne komunikaty panik — bez tego błąd w Rust objawia się
// jako "unreachable executed" bez śladu, skąd przyszedł.
instancja.exports.__wbindgen_start();

export const {
  generateServerKey,
  registrationStart,
  registrationFinish,
  loginStart,
  loginFinish,
} = glue;

// Strona klienta — wyłącznie dla testów, żeby dało się przejść pełną rundę
// protokołu prawdziwym klientem zamiast atrapy. Produkcyjny kod serwera
// nie ma powodu ich wołać.
export const {
  clientRegisterStart,
  clientRegisterFinish,
  clientLoginStart,
  clientLoginFinish,
} = glue;
