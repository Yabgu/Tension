// Run one test program under Node, so it can be stepped and read on any OS.
//
// `tension-core` cannot run these programs on Windows: wasmtime gates stack
// switching to x86-64 Linux/macOS (`wasmtime-50/src/config.rs:2486`), and every
// program here is compiled with `--enable stack-switching`. Node's V8 does
// support it, so the same artifact runs — a guest does not care which host
// drives it, as long as the imports it declares are answered.
//
//   node --experimental-wasm-wasmfx runner.mjs main-policy
//   node --experimental-wasm-wasmfx runner.mjs fallback-loop --trace
//
// One instantiation. The memory is the module's own export, so the `print`
// closure reads it through a variable filled in immediately after
// instantiation — before any guest code runs, because the module has no start
// section (`--exportStart __start` moved the boot body behind a call).

import { readFileSync } from "node:fs";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";

const here = dirname(fileURLToPath(import.meta.url));
const name = process.argv[2];
const trace = process.argv.includes("--trace");

if (!name) {
  console.error("usage: node --experimental-wasm-wasmfx runner.mjs <program> [--trace]");
  console.error("       async-on-main, main-policy, fallback-loop, rt-guards,");
  console.error("       count, spawn-join, spawn-refusals, two-workers");
  process.exit(2);
}

const wasmPath = join(here, "build", `${name}.wasm`);
const bytes = readFileSync(wasmPath);
const module = new WebAssembly.Module(bytes);
const imports = WebAssembly.Module.imports(module);
if (trace) {
  console.error(
    "runner: imports " + imports.map((i) => `${i.module}::${i.name}`).join(", "),
  );
}

if (imports.some((i) => i.kind === "memory")) {
  console.error(
    `runner: ${name} imports a shared memory (a thread program). Run it under ` +
    `tension-core on Linux/macOS, or under the TensionScript harness.`,
  );
  process.exit(3);
}

/** The tag names `env.emit` uses — identical to `host/io.rs:94`. */
const EMIT_NAMES = ["status", "suspensions", "carried", "total", "final"];

const decoder = new TextDecoder("utf-8");
/** Filled in the moment the instance exists; `print` is only called later. */
let memory = null;

function refuseThread() {
  throw new Error(
    `${name} needs a thread host; run it under tension-core on Linux/macOS`,
  );
}

const exportsObject = new WebAssembly.Instance(module, {
  env: {
    abort: (a, b, c, d) => { throw new Error(`guest abort: ${a} ${b} ${c} ${d}`); },
    // `env.emit(tag, value)` is the contract program's own print, with the same
    // tag table `tension-core/src/host/io.rs:94` uses.
    emit: (tag, value) => {
      process.stdout.write(`${EMIT_NAMES[tag] ?? `tag${tag}`}: ${value}\n`);
    },
    __executorCount: refuseThread,
    __startThread: refuseThread,
  },
  scheduler: {
    // `scheduler::park` is the **Promise** (state-machine) backend's suspension.
    // A fake scheduler would print a transcript that proves nothing, so it is
    // refused by name like the thread imports.
    park: () => {
      throw new Error(
        `${name} uses the Promise backend (scheduler::park); run it under tension-core.`,
      );
    },
  },
  // The import module is literally `tension::io` — one name with a `::` in it,
  // not a nested namespace.
  "tension::io": {
    print: (ptr, len) => {
      process.stdout.write(decoder.decode(new Uint8Array(memory.buffer, ptr, len)));
    },
    log: (ptr, len) => {
      process.stderr.write(decoder.decode(new Uint8Array(memory.buffer, ptr, len)));
    },
  },
}).exports;

memory = exportsObject.memory;

if (typeof exportsObject.__start !== "function") {
  console.error("runner: no `__start` export — build with --exportStart __start");
  process.exit(4);
}

const status = exportsObject.__start();
if (trace) console.error(`runner: __start -> ${status}`);
