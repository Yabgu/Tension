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

import { spawnSync } from "node:child_process";
import { existsSync, readFileSync, statSync } from "node:fs";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";

import { GUEST_EXTENSIONS } from "../../../scripts/lib/guest-extensions.mjs";

const here = dirname(fileURLToPath(import.meta.url));
const name = process.argv[2];
const trace = process.argv.includes("--trace");

if (!name) {
  console.error("usage: node --experimental-wasm-wasmfx runner.mjs <program> [--trace]");
  console.error("       async-on-main, main-policy, fallback-loop, rt-guards,");
  console.error("       count, spawn-join, spawn-refusals, two-workers");
  process.exit(2);
}

// **Which artifact, and does it carry debug info?**
//
// Two mistakes cost a debugging session each and are silent, so this file
// answers both before it runs anything:
//
// 1. `build/<name>.wasm` is a **release** build — no `--debug`, so it has no
//    `.debug_*` sections at all. A breakpoint in a `.ts` file can never bind
//    against it, and the run looks normal. `build/debug/<name>.wasm` is the one
//    a debugger needs.
// 2. A stale artifact answers with an old transcript, which reads exactly like
//    "my edit did nothing".
//
// So: prefer the debug artifact when its source is not newer, rebuild when the
// compiler is installed and the artifact is missing or stale, and always print
// what was loaded. `--release` forces the release artifact for a plain run.
const wantRelease = process.argv.includes("--release");
// **The source, by the declared table** (DL45): a program may be spelled `.tension`,
// `.ten` or `.ts`, and this launcher's job is to date the artifact against whichever
// the tree has. Search order is the table's, so a tree mid-rename resolves the
// canonical spelling first rather than depending on which file `readdir` returns.
const sourcePath = GUEST_EXTENSIONS
  .map((ext) => join(here, "async", `${name}${ext}`))
  .find((candidate) => existsSync(candidate)) ?? join(here, "async", `${name}${GUEST_EXTENSIONS[0]}`);
const debugPath = join(here, "build", "debug", `${name}.wasm`);
const releasePath = join(here, "build", `${name}.wasm`);

function mtime(path) {
  try {
    return statSync(path).mtimeMs;
  } catch {
    return 0;
  }
}

function hasDebugSections(bytes) {
  // A walk of the section table: id 0 is a custom section, and its name is a
  // LEB-length-prefixed string.
  let at = 8;
  const uleb = () => {
    let result = 0;
    let shift = 0;
    let byte;
    do {
      byte = bytes[at++];
      result |= (byte & 0x7f) << shift;
      shift += 7;
    } while (byte & 0x80);
    return result >>> 0;
  };
  const names = [];
  while (at < bytes.length) {
    const id = bytes[at++];
    const size = uleb();
    const end = at + size;
    if (id === 0) {
      const length = uleb();
      names.push(Buffer.from(bytes.subarray(at, at + length)).toString("utf8"));
    }
    at = end;
  }
  return names.filter((n) => n.startsWith(".debug_"));
}

function build(debug) {
  const flags = debug ? ["--debug"] : [];
  const result = spawnSync(
    process.execPath,
    [join(here, "..", "..", "..", "scripts", "build-test-programs.mjs"), ...flags, "--force", name],
    { stdio: "inherit", cwd: join(here, "..", "..", "..") },
  );
  return result.status === 0;
}

let wasmPath;
if (wantRelease) {
  wasmPath = releasePath;
} else if (mtime(debugPath) > 0 && mtime(debugPath) >= mtime(sourcePath)) {
  wasmPath = debugPath;
} else {
  // Missing or stale. Build if the vendored compiler is here; otherwise fall
  // back to whatever exists and say so.
  const compiler = join(here, "..", "..", "..", "node_modules", "@yabgu_gm", "tensionscript");
  if (existsSync(compiler)) {
    console.error(
      `runner: building the debug artifact for ${name} (it is missing or older than its source)`,
    );
    build(true);
  }
  wasmPath = mtime(debugPath) > 0 ? debugPath : releasePath;
}

if (!existsSync(wasmPath)) {
  console.error(`runner: no artifact at ${wasmPath} — run node scripts/build-test-programs.mjs`);
  process.exit(5);
}

const bytes = readFileSync(wasmPath);
const debugSections = hasDebugSections(bytes);
console.error(
  `runner: ${name} <- ${wasmPath.replace(here, ".")} ` +
  `(${bytes.length} bytes, ${new Date(mtime(wasmPath)).toISOString()})`,
);
console.error(
  debugSections.length
    ? `runner: DWARF present: ${debugSections.join(", ")} — a .ts breakpoint can bind ` +
      `with a DWARF-capable debugger (see .vscode/launch.json)`
    : `runner: NO debug info in this artifact — a .ts breakpoint cannot bind. ` +
      `Delete it and rerun (the debug build is automatic), or build with ` +
      `\`node scripts/build-test-programs.mjs --debug\`.`,
);
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
