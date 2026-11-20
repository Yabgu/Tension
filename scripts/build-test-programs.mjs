#!/usr/bin/env node
// Build every test program in `tension-core/tests/programs/` with the
// repository's vendored compiler.
//
// One recipe, two callers: `node scripts/build-test-programs.mjs` by hand, and
// any `tension-core/tests/*.rs` that runs a program when its `.wasm` is missing
// or older than its `.ts`. A flag list copied into a Rust test would be the
// drift this repository refuses, and the flag that matters most is the one a
// copy would drop: **`--optimizeLevel 0`**.
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
// # Why a table, not one flag list
//
// The programs prove different ABIs. The thread programs are a shared-memory
// build and must carry the thread flags; `async-on-main` is one store with the
// stackful backend; `rt-guards` is an ordinary guest that must **not** import a
// session. A single list would either give the guards a session they are
// testing the absence of, or give the thread programs no shared memory. So each
// program names its own flags here, once, in the file both the human and the
// test call.
//
// Run: node scripts/build-test-programs.mjs [--force]

import { execFileSync } from "node:child_process";
import { existsSync, mkdirSync, readdirSync, statSync } from "node:fs";
import { dirname, join, resolve } from "node:path";
import { fileURLToPath } from "node:url";

const here = dirname(fileURLToPath(import.meta.url));
const repo = resolve(here, "..");
const programs = join(repo, "tension-core", "tests", "programs");
const out = join(programs, "build");
const compiler = join(repo, "scripts", "tensionscript.mjs");
const force = process.argv.includes("--force");

/**
 * The flags every thread program is built with.
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
const THREAD_FLAGS = [
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

/**
 * The stackful single-store program. `--exportStart __start` makes the boot body
 * an export the host calls (the Tension convention), rather than a start
 * section that would run before the host has verified anything.
 */
const ASYNC_ON_MAIN_FLAGS = [
  "--runtime", "incremental",
  "--target", "release",
  "--enable", "stack-switching",
  "--exportStart", "__start",
  "--optimizeLevel", "0",
];

/**
 * An ordinary guest: no shared memory, no stack switching, no session config.
 * The guards it exercises are the framework's behaviour when no session is
 * open, so importing one would defeat the test.
 */
const PLAIN_FLAGS = [
  "--runtime", "incremental",
  "--target", "release",
  "--optimizeLevel", "0",
];

const PROGRAMS = {
  "count": THREAD_FLAGS,
  "spawn-join": THREAD_FLAGS,
  "spawn-refusals": THREAD_FLAGS,
  "two-workers": THREAD_FLAGS,
  "async-on-main": ASYNC_ON_MAIN_FLAGS,
  "rt-guards": PLAIN_FLAGS,
};

mkdirSync(out, { recursive: true });
const sources = readdirSync(programs).filter((name) => name.endsWith(".ts")).sort();
if (sources.length === 0) {
  console.error("build-test-programs: no .ts programs in " + programs);
  process.exit(1);
}

let built = 0;
let skipped = 0;
for (const source of sources) {
  const name = source.replace(/\.ts$/, "");
  const flags = PROGRAMS[name];
  if (!flags) {
    console.error(
      `build-test-programs: ${source} has no entry in PROGRAMS — add its flag list ` +
      `to this file rather than copying one into a test`,
    );
    process.exit(1);
  }
  const wasm = join(out, `${name}.wasm`);
  const ts = join(programs, source);
  if (!force && existsSync(wasm) && statSync(wasm).mtimeMs >= statSync(ts).mtimeMs) {
    ++skipped;
    continue;
  }
  console.log(`build-test-programs: ${source}`);
  execFileSync(process.execPath, [compiler, ts, "-o", wasm, ...flags], {
    cwd: programs,
    stdio: "inherit",
  });
  ++built;
}
console.log(
  `build-test-programs: ${built} built, ${skipped} up to date, ${sources.length} total`,
);
