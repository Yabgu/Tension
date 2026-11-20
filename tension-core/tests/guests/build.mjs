#!/usr/bin/env node
// Build every guest in this directory with the repository's vendored compiler.
//
// One recipe, two callers: `node tension-core/tests/guests/build.mjs` by hand,
// and `tension-core/tests/threads.rs` when a `.wasm` is missing or older than
// its `.ts`. A flag list copied into the Rust test would be the drift this
// repository refuses, and the flag that matters most is the one a copy would
// drop: **`--optimizeLevel 0`**.
//
// # Why `-O0`, and what it is not
//
// The pinned compiler (0.14.1 at `03e0507b`) aborts inside Binaryen — 
// `Assertion failed: index < usedElements` in `mixed_arena.h` — for any program
// that combines `--enable stack-switching` with `optimizeLevel >= 1`. Measured
// on a three-line fixture (`async function leaf()`, one `await`, one `return`),
// so it is the optimizer's handling of the continuation types, not anything
// these guests do. `-O0` compiles and runs the same programs; the finding is
// reported in the milestone's notes, and this comment is the place a future
// reader finds out why the flag is here rather than in a commit message.
//
// Run: node build.mjs [--force]

import { execFileSync } from "node:child_process";
import { existsSync, mkdirSync, readdirSync, statSync } from "node:fs";
import { dirname, join, resolve } from "node:path";
import { fileURLToPath } from "node:url";

const here = dirname(fileURLToPath(import.meta.url));
const repo = resolve(here, "..", "..", "..");
const out = join(here, "build");
const compiler = join(repo, "scripts", "tensionscript.mjs");
const force = process.argv.includes("--force");

/**
 * The flags every thread guest is built with.
 *
 *   --sharedMemory        a shared linear memory, and the two host imports
 *   --importMemory        the memory is the host's, not the module's
 *   --enable threads      atomics; implied by --sharedMemory, stated anyway
 *   --enable stack-switching  a `$starts` table to serve requests from
 *   --runtime incremental     the default allocator, as every example uses
 *   --maximumMemory 256   a shared memory cannot grow its reservation, so both
 *                         bounds are fixed; 256 pages is 16 MiB, enough for two
 *                         1 MiB worker arenas plus main's 4 MiB
 *   --optimizeLevel 0     see the header
 */
const FLAGS = [
  "--runtime", "incremental",
  "--target", "release",
  "--sharedMemory",
  "--importMemory",
  "--initialMemory", "2",
  "--maximumMemory", "256",
  "--enable", "threads",
  "--enable", "stack-switching",
  "--optimizeLevel", "0",
];

mkdirSync(out, { recursive: true });
const sources = readdirSync(here).filter((name) => name.endsWith(".ts")).sort();
if (sources.length === 0) {
  console.error("build: no .ts guests in " + here);
  process.exit(1);
}

let built = 0;
let skipped = 0;
for (const source of sources) {
  const name = source.replace(/\.ts$/, "");
  const wasm = join(out, `${name}.wasm`);
  const ts = join(here, source);
  if (!force && existsSync(wasm) && statSync(wasm).mtimeMs >= statSync(ts).mtimeMs) {
    ++skipped;
    continue;
  }
  console.log(`build: ${source}`);
  execFileSync(process.execPath, [compiler, ts, "-o", wasm, ...FLAGS], {
    cwd: here,
    stdio: "inherit",
  });
  ++built;
}
console.log(`build: ${built} built, ${skipped} up to date, ${sources.length} total`);
