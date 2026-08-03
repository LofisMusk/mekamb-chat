// Atrapa modułu `crypto` z Node.
//
// `sjcl` (wciągane przez @cloudflare/voprf-ts) próbuje `require('crypto')`
// w bloku try/catch, żeby dobrać źródło entropii do środowiska. Blok jest
// napisany tak, by mógł zawieść — ale bundler rozwiązuje ścieżkę statycznie
// i przewraca się, zanim dojdzie do wykonania.
//
// Pusty obiekt sprawia, że sjcl schodzi na ścieżkę przeglądarkową
// (`crypto.getRandomValues`), czyli dokładnie tę, której chcemy w Workers.
export default {};
