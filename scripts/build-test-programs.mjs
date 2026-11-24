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
import { existsSync, mkdirSync, readFileSync, readdirSync, statSync, writeFileSync } from "node:fs";
import { dirname, join, resolve } from "node:path";
import { fileURLToPath } from "node:url";

import { compilerIdentity, readBuildRecord, writeBuildRecord } from "./lib/toolchain.mjs";
import { PROGRAM_ALIASES } from "./lib/program-aliases.mjs";

const here = dirname(fileURLToPath(import.meta.url));
const repo = resolve(here, "..");
const programs = join(repo, "tension-core", "tests", "programs");
const compiler = join(repo, "scripts", "tensionscript.mjs");
const force = process.argv.includes("--force");
const debug = process.argv.includes("--debug");
// **`--optimize=<n>` builds the same programs at a different level.** The
// default lists all end in `--optimizeLevel 0`, which is the level the suite
// runs; this lets one test ask "does the artifact survive optimization?" without
// a second copy of any flag list. The override replaces the level, it does not
// add one, and the output lands in its own directory so it cannot overwrite the
// artifact every other test resolves by name.
const optimizeArg = process.argv.find((a) => a.startsWith("--optimize="));
const optimize = optimizeArg ? Number(optimizeArg.slice("--optimize=".length)) : null;
if (optimizeArg && !Number.isInteger(optimize)) {
  console.error(`build-test-programs: ${optimizeArg} is not an integer level`);
  process.exit(1);
}
// Positional names filter the build, so a runner that needs one artifact
// rebuilds one artifact. `runner.mjs` uses this when a program's source is
// newer than its `.wasm`.
const only = process.argv.slice(2).filter((a) => !a.startsWith("--"));
const out = debug
  ? join(programs, "build", "debug")
  : optimize !== null
    ? join(programs, "build", `o${optimize}`)
    : join(programs, "build");

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
 * The wake proof's flags: `THREAD_FLAGS` **minus `--enable stack-switching`**.
 *
 * The difference is the point of the program. `wake-on-worker` parks on a real
 * `await` under the **Promise** backend, so its shell is the one that runs
 * without stack switching — which is what lets the guard run on any engine, and
 * in a CI job that has no reason to care which backend is present. Built with
 * `THREAD_FLAGS` it would measure the stackful shell instead and the test would
 * be asserting a different mechanism under the same name.
 */
const WAKE_FLAGS = [
  "--runtime", "incremental",
  "--target", "release",
  "--sharedMemory",
  "--importMemory",
  "--initialMemory", "2",
  "--maximumMemory", "256",
  "--enable", "threads",
  "--optimizeLevel", "0",
];

/**
 * **The fiber backend's guest** (DL36, and DL37 for the second half): the thread
 * flags, `--stackful-backend=fiber`, and **no `--enable stack-switching`**.
 *
 * The two backends are not interchangeable — a fiber guest calls the host to
 * suspend and a continuation guest suspends in wasm — so the artifact records
 * which one built it (`tension.stackful-backend`) and the host refuses a
 * mismatched pairing by name.
 *
 * The flag is withheld **deliberately**, because the artifact proves it is not
 * needed: a fiber build's suspension is a call, so it declares no continuation
 * type and no tag, and this list being `THREAD_FLAGS` minus `stack-switching`
 * plus the backend is what makes the committed fixture evidence of that (I85).
 * Passing it as well produces the same bytes — measured, and asserted by
 * `tests/compiler/stackful-fiber-pruned`.
 */
/**
 * **The contract program, on the fiber backend** (DL38, I90).
 *
 * `ASYNC_ON_MAIN_FLAGS` minus `--enable stack-switching`, plus the backend flag.
 * The omission is the round's subject: a fiber build's suspension is a call the
 * host sees, so the artifact must not need the proposal — and if it silently
 * *did*, the gate this artifact feeds is what would notice.
 *
 * Built as its own program rather than by re-running the build with a flag,
 * because the transcript it must print is the same seven lines the continuation
 * build prints: the ABI contract is backend-independent, and two artifacts
 * compared against one expected file is how that stays true.
 */
const ASYNC_ON_MAIN_FIBER_FLAGS = [
  "--runtime", "incremental",
  "--target", "release",
  "--exportStart", "__start",
  "--optimizeLevel", "0",
  "--stackful-backend", "fiber",
];

const FIBER_FLAGS = [
  // `THREAD_FLAGS` minus the `--enable stack-switching` **pair**, keeping every
  // other flag in order — a filter that dropped the two tokens by value would
  // leave the `--enable` that introduced them dangling, which the compiler reads
  // as a repeated switch with a missing value.
  ...THREAD_FLAGS.reduce((kept, flag, index, all) => {
    if (flag === "--enable" && all[index + 1] === "stack-switching") return kept;
    if (index > 0 && all[index - 1] === "--enable" && flag === "stack-switching") return kept;
    kept.push(flag);
    return kept;
  }, []),
  "--stackful-backend",
  "fiber",
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
/**
 * The entry-surface case is an **async** `main`: measured, a sync `main` is
 * never called by this compiler's boot body (only the shell resumes one), so a
 * sync entry case would have no stop to assert and would be a test of the
 * harness's patience. What the engine's entry surface actually is — host calls
 * `__start`, shell resumes `main` — is what the case measures.
 */

const PROGRAMS = {
  // The conformance matrix's own cases (`docs`: `tools/debug-conformance`).
  // Each one exists to name a feature, so its flags are named too rather than
  // inherited from a folder: an async case that quietly lost stack switching
  // would measure the promise backend under an async case's name.
  "async-before-await": ASYNC_ON_MAIN_FLAGS,
  "async-after-await": ASYNC_ON_MAIN_FLAGS,
  "async-loop-resume": ASYNC_ON_MAIN_FLAGS,
  "stack-switch-resume": ASYNC_ON_MAIN_FLAGS,
  "task-entry": ASYNC_ON_MAIN_FLAGS,
  "start-game-entry": ASYNC_ON_MAIN_FLAGS,
  "promise-fallback": PLAIN_FLAGS,
  // The Promise backend's **entry**: an `async main` with no stack switching.
  // `PLAIN_FLAGS` plus `--exportStart __start` is the whole point of the
  // program — with `--enable stack-switching` it would measure the stackful
  // shell instead, so it is named here rather than inheriting the folder's
  // default, and its entry is an export rather than a start section because
  // that is the shape the SDK builds (and the one the host calls).
  "async-main-promise": [...PLAIN_FLAGS, "--exportStart", "__start"],
  "count": THREAD_FLAGS,
  "spawn-join": THREAD_FLAGS,
  "spawn-refusals": THREAD_FLAGS,
  "two-workers": THREAD_FLAGS,
  // The wake path's guard (`tests/threads.rs`): a park on a worker that a
  // completion posted *before* it resumes. Named here because it is the one
  // thread program that must **not** get the folder default — see `WAKE_FLAGS`.
  "wake-on-worker": WAKE_FLAGS,
  // DL22's ordering probe: the same two-waiter shape, run twice — with the
  // completion posted after both parks and (the mirror) before them. Same flags as
  // the wake guard, for the same reason.
  "two-waiters-late": WAKE_FLAGS,
  "async-on-main": ASYNC_ON_MAIN_FLAGS,
  // Built from `async/async-on-main.ts` — see `ALIASES` below.
  "async-on-main-fiber": ASYNC_ON_MAIN_FIBER_FLAGS,
  "rt-guards": PLAIN_FLAGS,
  "main-policy": ASYNC_ON_MAIN_FLAGS,
  "fallback-loop": ASYNC_ON_MAIN_FLAGS,
  "main-step-replaced": ASYNC_ON_MAIN_FLAGS,
  // DL36's fiber executor guest: the I70 scenario on the fiber backend.
  "i70-fiber": FIBER_FLAGS,
};

/**
 * **One source, two artifacts** (DL38). The mapping is shared with
 * `rebuild.mjs` (`scripts/lib/program-aliases.mjs`); the flag list is this
 * file's, keyed by the artifact name in `PROGRAMS` above.
 */
const ALIASES = Object.fromEntries(
  Object.entries(PROGRAM_ALIASES).map(([name, source]) => [name, { source, flags: PROGRAMS[name] }]),
);

/**
 * The default flags for a folder, so a new program in an existing folder needs
 * no entry above. A folder with no default is an error: it would be a program
 * nobody decided how to build.
 */
const FOLDER_FLAGS = {
  "conformance": PLAIN_FLAGS,
  "async": ASYNC_ON_MAIN_FLAGS,
  "policy": ASYNC_ON_MAIN_FLAGS,
  "thread": THREAD_FLAGS,
  "mask": THREAD_FLAGS,
  "fiber": FIBER_FLAGS,
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

/** The compiler this run builds with — asked once, and the identity a record carries. */
const identity = compilerIdentity();
if (identity.hash === null) {
  console.error(
    "build-test-programs: no compiler to identify — nothing is skipped on a build record " +
      "this run cannot write (" + (identity.path ?? "no installed compiler") + ")",
  );
}

let built = 0;
let skipped = 0;
/** Artifacts rebuilt *because the compiler changed* — the count I82 was blind to. */
let rebuiltForCompiler = 0;

/** Reads the record beside an artifact, or null. Thin alias: the schema lives in `lib/toolchain.mjs`. */
const readRecord = (wasm) => readBuildRecord(wasm);
const writeRecord = (wasm, record) => writeBuildRecord(wasm, record);

/** Whether two flag lists are the same list, in order. */
function sameFlags(a, b) {
  if (!Array.isArray(a) || !Array.isArray(b) || a.length !== b.length) return false;
  for (let i = 0; i < a.length; ++i) if (a[i] !== b[i]) return false;
  return true;
}
// **The work list: one entry per artifact**, which is one per source plus the
// aliases. An alias names its own source, so `async-on-main-fiber.wasm` is built
// from `async/async-on-main.ts` and nothing else has to know it exists.
const work = sources.map((rel) => {
  const name = rel.split("/").pop().replace(/\.ts$/, "");
  const folder = rel.includes("/") ? rel.split("/")[0] : "";
  const alias = ALIASES[name];
  return {
    rel: alias ? alias.source : rel,
    name,
    flags: alias ? alias.flags : PROGRAMS[name] ?? FOLDER_FLAGS[folder],
  };
});
// The aliases are artifacts with no `.ts` of their own, so they are not in
// `sources`; they are appended here in name order, which keeps the build's output
// stable without pretending they are programs.
for (const name of Object.keys(ALIASES).sort()) {
  if (sources.some((rel) => rel.split("/").pop().replace(/\.ts$/, "") === name)) continue;
  work.push({ rel: ALIASES[name].source, name, flags: ALIASES[name].flags });
}
for (const { rel, name, flags } of work) {
  if (only.length > 0 && !only.includes(name)) continue;
  if (!flags) {
    console.error(
      `build-test-programs: ${rel} has no flag list — add it to PROGRAMS, or give ` +
      `its folder a default in FOLDER_FLAGS`,
    );
    process.exit(1);
  }
  const wasm = join(out, `${name}.wasm`);
  const ts = join(programs, rel);
  // The override replaces the level the table chose, and only the level: every
  // other flag (memory, features, runtime) is the program's own.
  let effective = flags;
  if (optimize !== null) {
    effective = [];
    for (let i = 0; i < flags.length; ++i) {
      if (flags[i] === "--optimizeLevel") {
        ++i;
        continue;
      }
      effective.push(flags[i]);
    }
    effective.push("--optimizeLevel", String(optimize));
  }
  // **The flags the artifact was actually built with.** A debug build adds
  // `--debug --sourceMap` on top, and those change the bytes, so they belong in
  // the record: a record that named only the table's list would claim an artifact
  // was built by a command that would not have produced it.
  const usedFlags = debug ? [...effective, ...DEBUG_FLAGS] : effective;

  // --- the skip condition, and why the mtime is no longer enough (I82) ------
  //
  // "Artifact newer than its source" was the whole test, and it is **not** the
  // question. The artifact's *bytes* are a function of the source **and of the
  // compiler that read it** — so a tree whose only change is in the compiler
  // rebuilt nothing, and the round's control read as "0 bytes moved" while five
  // guests had in fact moved (DL35's gate 3; the seat measured the five). A skip
  // test that cannot see the compiler cannot see the change that matters most.
  //
  // So each artifact carries a record of how it was built (`<name>.wasm.build.json`)
  // and the skip needs all of it: the source older, the compiler the same, **and
  // the flags the same**. The last one is not in the brief and is a strict
  // improvement of the same kind — a flag edit is invisible to an mtime test in
  // exactly the way a compiler edit was.
  const record = readRecord(wasm);
  const upToDate =
    !force &&
    existsSync(wasm) &&
    statSync(wasm).mtimeMs >= statSync(ts).mtimeMs &&
    identity.hash !== null &&
    record !== null &&
    record.compiler === identity.hash &&
    sameFlags(record.flags, usedFlags);
  if (upToDate) {
    ++skipped;
    continue;
  }
  if (!force && record !== null && record.compiler !== identity.hash && existsSync(wasm)) {
    ++rebuiltForCompiler;
  }
  console.log(
    `build-test-programs: ${rel}` +
      (debug ? " (debug)" : "") +
      (optimize !== null ? ` (optimizeLevel ${optimize})` : ""),
  );
  execFileSync(
    process.execPath,
    [compiler, ts, "-o", wasm, ...usedFlags],
    {
      cwd: programs,
      stdio: "inherit",
    },
  );
  writeRecord(wasm, {
    compiler: identity.hash,
    compilerPath: identity.path,
    source: rel,
    flags: usedFlags,
  });
  ++built;
}
console.log(
  `build-test-programs: ${built} built, ${skipped} up to date, ${work.length} total` +
    (rebuiltForCompiler > 0 ? ` (${rebuiltForCompiler} for a new compiler)` : "") +
    (debug ? ` — debug artifacts in ${out}` : "") +
    (optimize !== null ? ` — optimizeLevel ${optimize} artifacts in ${out}` : ""),
);
