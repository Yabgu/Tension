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
// # Why `-O0`
//
// `-O0` is a *choice*: it builds fastest, keeps the artifacts small, and leaves
// the line table unperturbed in the debug builds. It is no longer a workaround
// for the optimizer. The pin at `150a6e97` compiles `async/schedule-order.ts`
// at -O1, -O2 and -O3, and the compiler repo's `tests/async/optimize.js` pins a
// three-line `await` at every level. Before that pin, -O1 aborted in `dce`
// (`BinaryenResumeWithHandlers` built handlers but no sent types) and -O2 in
// `local-cse`; both fixes are in the compiler repo and the Binaryen fork.
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
// Run: node scripts/build-test-programs.mjs [--force] [--debug]
//
// # Two modes, one flag list
//
// `--debug` builds the *same* programs into `build/debug/`, with the program's
// own flags plus `--debug --sourceMap`. Nothing else changes, `-O0` included:
// a debug artifact is for a breakpoint, and -O0 is what keeps its line table
// answering the source it came from. Higher levels do compile with DWARF now —
// `schedule-order` was measured at -O2 with all four `.debug_*` sections — but
// that is a separate choice from the one this script makes.
//
// Who asks for it: `tension-core/tests/debugger.rs`, which sets a source
// breakpoint in a debug artifact under lldb. The release artifacts in
// `build/` stay what every other test runs — a guest built only to be run has
// no use for a line table and no use for a 500 KB source map beside it.

import { execFileSync } from "node:child_process";
import { existsSync, mkdirSync, readdirSync, statSync } from "node:fs";
import { dirname, join, resolve } from "node:path";
import { fileURLToPath } from "node:url";

const here = dirname(fileURLToPath(import.meta.url));
const repo = resolve(here, "..");
const programs = join(repo, "tension-core", "tests", "programs");
const compiler = join(repo, "scripts", "tensionscript.mjs");
const force = process.argv.includes("--force");
const debug = process.argv.includes("--debug");
// Positional names filter the build, so a runner that needs one artifact
// rebuilds one artifact. `runner.mjs` uses this when a program's source is
// newer than its `.wasm`.
const only = process.argv.slice(2).filter((a) => !a.startsWith("--"));
const out = debug ? join(programs, "build", "debug") : join(programs, "build");

/**
 * What a debug build adds to a program's own flags.
 *
 * `--debug` is what asks the compiler for DWARF (`.debug_info`, `.debug_line`,
 * `.debug_abbrev`, `.debug_ranges`) and `--sourceMap` for the `.map` beside the
 * artifact. Both are needed: the host's `--debug` only registers a JIT image,
 * it does not invent a line table (`tension-core/src/debug.rs`).
 */
const DEBUG_FLAGS = ["--debug", "--sourceMap"];

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

/**
 * A program's flag list, by **basename** — the file name without `.ts`.
 *
 * Names are unique across the folders (a build failure says so if not), so a
 * test asks for `guest("main-policy")` and does not care which folder the
 * source lives in. Where a program needs something its folder default does not
 * give it, it is named here.
 */
const PROGRAMS = {
  "count": THREAD_FLAGS,
  "spawn-join": THREAD_FLAGS,
  "spawn-refusals": THREAD_FLAGS,
  "two-workers": THREAD_FLAGS,
  "async-on-main": ASYNC_ON_MAIN_FLAGS,
  "rt-guards": PLAIN_FLAGS,
  "main-policy": ASYNC_ON_MAIN_FLAGS,
  "fallback-loop": ASYNC_ON_MAIN_FLAGS,
  "main-step-replaced": ASYNC_ON_MAIN_FLAGS,
};

/**
 * The default flags for a folder, so a new program in an existing folder needs
 * no entry above. A folder with no default is an error: it would be a program
 * nobody decided how to build.
 */
const FOLDER_FLAGS = {
  "async": ASYNC_ON_MAIN_FLAGS,
  "policy": ASYNC_ON_MAIN_FLAGS,
  "thread": THREAD_FLAGS,
  "mask": THREAD_FLAGS,
  "atomic": THREAD_FLAGS,
};

/** Every `.ts` under `programs/`, as repo-relative paths, sorted. */
function collect(dir, prefix = "") {
  const found = [];
  for (const entry of readdirSync(dir, { withFileTypes: true })) {
    if (entry.name === "build" || entry.name === "node_modules") continue;
    const rel = prefix ? `${prefix}/${entry.name}` : entry.name;
    if (entry.isDirectory()) {
      found.push(...collect(join(dir, entry.name), rel));
    } else if (entry.name.endsWith(".ts")) {
      found.push(rel);
    }
  }
  return found.sort();
}

mkdirSync(out, { recursive: true });
const sources = collect(programs);
if (sources.length === 0) {
  console.error("build-test-programs: no .ts programs under " + programs);
  process.exit(1);
}

/** Name uniqueness is what lets a test ask for a program without a folder. */
const seen = new Map();
for (const rel of sources) {
  const name = rel.split("/").pop().replace(/\.ts$/, "");
  if (seen.has(name)) {
    console.error(
      `build-test-programs: two programs are named "${name}": ` +
      `${seen.get(name)} and ${rel}. Names are the test's handle, so they must be unique.`,
    );
    process.exit(1);
  }
  seen.set(name, rel);
}

let built = 0;
let skipped = 0;
for (const rel of sources) {
  const name = rel.split("/").pop().replace(/\.ts$/, "");
  if (only.length > 0 && !only.includes(name)) continue;
  const folder = rel.includes("/") ? rel.split("/")[0] : "";
  const flags = PROGRAMS[name] ?? FOLDER_FLAGS[folder];
  if (!flags) {
    console.error(
      `build-test-programs: ${rel} has no flag list — add it to PROGRAMS, or give ` +
      `the "${folder}" folder a default in FOLDER_FLAGS`,
    );
    process.exit(1);
  }
  const wasm = join(out, `${name}.wasm`);
  const ts = join(programs, rel);
  if (!force && existsSync(wasm) && statSync(wasm).mtimeMs >= statSync(ts).mtimeMs) {
    ++skipped;
    continue;
  }
  console.log(`build-test-programs: ${rel}${debug ? " (debug)" : ""}`);
  execFileSync(
    process.execPath,
    [compiler, ts, "-o", wasm, ...flags, ...(debug ? DEBUG_FLAGS : [])],
    {
      cwd: programs,
      stdio: "inherit",
    },
  );
  ++built;
}
console.log(
  `build-test-programs: ${built} built, ${skipped} up to date, ${sources.length} total` +
    (debug ? ` — debug artifacts in ${out}` : ""),
);
