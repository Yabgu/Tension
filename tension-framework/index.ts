/**
 * Tension framework — guest SDK for TensionCore.
 *
 * Two surfaces, one ABI:
 *  - AssemblyScript ("wasmscript"): the real implementation lives in
 *    `assembly/`, compiled by `asc` into the game's wasm. The game imports the
 *    `std:tension/io` host functions through these bindings.
 *  - TypeScript: the same API is declared here as plain TypeScript so game
 *    authors get typing/IntelliSense when writing in TS.
 *
 * The web (host) never sees this package; it only links the `tension::io`
 * imports the compiled module declares.
 */

export { print, readLine, argCount, arg } from "./assembly/io";
