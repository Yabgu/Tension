/**
 * TensionCore guest SDK — TypeScript declarations for AssemblyScript game
 * sources.
 *
 * The implementation is AssemblyScript: `assembly/index.ts` re-exports the
 * `tension::io` bindings from `assembly/io.ts`, compiled into the game's
 * wasm by `asc`. This file only describes the surface so editors and other
 * tooling can type game sources; there is no second, runnable surface.
 */

export declare function write(text: string): void;
export declare function print(text: string): void;
export declare function readLine(): string | null;
export declare function argCount(): i32;
export declare function arg(i: i32): string;
