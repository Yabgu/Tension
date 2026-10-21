// The framework's async surface without a session (0.7.0).
//
// **What this used to test, and why it changed.** Until 0.7.0 it drove the pull
// path: `rt.onEvent` → `__taskDeliver` → `rt.runReady` → `__taskTick`, and
// asserted the parked task resumed with 41. All three of those symbols are gone
// — the host publishes, matches and wakes now — so that assertion has no subject
// left. The push path's wake is measured end to end instead, with a real host:
// `guest-push`, `guest-chain`, `guest-early`, `guest-sync`, `guest-enospc`,
// `guest-drop`, and the seven adopting examples.
//
// What is left to test here is the part that must not depend on a host at all:
// the guards. A guest that instantiates the framework and parks with **no task
// table and no session** must return quietly — no trap, no wild region read —
// because that is the state every fixture starts in before `session_open`.
//
// **Compiler requirement, stated as a gate:** the guest here links the
// *framework*, and the framework's build uses the published package. This test
// needs the std task machine (4a) and the completion symbol (4b), which ship in
// 0.3.0. A compiler without them is a **failure**, not a skip: the consumer
// dependency is `^0.3.0`, so an older compiler on disk means the install is
// wrong, and silently skipping is how that goes unnoticed. `TENSIONSCRIPT_BIN`
// may point at another build of 0.3.x.
//
// Run: node tests/rt-dispatch.mjs

import { execFileSync } from "node:child_process";
import { existsSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";

const here = dirname(fileURLToPath(import.meta.url));
const framework = join(here, "..");

let failures = 0;
let checks = 0;

function check(name, actual, expected) {
  ++checks;
  const a = JSON.stringify(actual);
  const e = JSON.stringify(expected);
  if (a === e) {
    console.log(`  ok  ${name}`);
  } else {
    ++failures;
    console.log(`  FAIL ${name}\n       expected ${e}\n       actual   ${a}`);
  }
}

/** A compiler whose std carries `__taskComplete`, or `null` with a reason. */
function findCompiler() {
  const candidates = [
    process.env.TENSIONSCRIPT_BIN,
    join(framework, "node_modules", "@acakar", "tensionscript", "bin", "tensionscript.js"),
    join(here, "..", "..", "..", "as-inspect", "assemblyscript", "bin", "tensionscript.js")
  ].filter(Boolean);
  for (const candidate of candidates) {
    if (!existsSync(candidate)) continue;
    const bundle = join(dirname(candidate), "..", "dist", "assemblyscript.js");
    if (!existsSync(bundle)) continue;
    if (!readFileSync(bundle, "utf8").includes("__taskComplete")) continue;
    return candidate;
  }
  return null;
}

const compiler = findCompiler();
if (!compiler) {
  console.log("FAIL: no compiler with __taskComplete.");
  console.log("      The framework depends on @acakar/tensionscript@^0.3.0, whose std has");
  console.log("      the task machine and the completion symbol. Run `npm install` here,");
  console.log("      or set TENSIONSCRIPT_BIN to a 0.3.x build.");
  process.exit(1);
}

const source = `
import { rt } from "../assembly/runtime/rt";
import { Task } from "~lib/task";

let resumed: i32 = 0;

async function awaitJob(h: Task<u32>): u32 {
  let v: u32 = await h;
  resumed = i32(v);
  return v;
}

export function probe(): i32 {
  // No table bound, no session open: the state a fixture is in before
  // session_open. Every one of these must be inert rather than a trap.
  rt.start();                             // binds families; needs no session
  let handle: Task<u32> = rt.job(7);      // a stamped handle, no allocation
  awaitJob(handle);                       // parks with no table: returns
  if (resumed != 0) return -1;            // nothing delivered, so nothing ran
  if (rt.hasRunnable()) return -2;        // and nothing claimed to be ready

  // The dispatcher with no session: rt.deliver reads the region table only when
  // a session is open, so this must be a no-op, not an out-of-bounds read.
  let record: EventRecord = new EventRecord();
  record.class_ = 4;
  record.a = 7;
  record.b = 41;
  rt.onEvent(4, changetype<u32>(record));
  if (resumed != 0) return -3;

  return 41;                              // the guards held
}

class EventRecord {
  seq: u64 = 0;
  class_: u32 = 0;
  flags: u32 = 0;
  a: u32 = 0;
  b: u32 = 0;
  f0: f32 = 0;
  f1: f32 = 0;
}
`;

// The probe lives beside this file, not in a temp directory: the guest imports
// the framework by relative path, which only resolves from inside the tree.
const tsPath = join(here, ".rt-dispatch.probe.ts");
const wasmPath = join(tmpdir(), `rt-dispatch-${process.pid}.wasm`);
writeFileSync(tsPath, source);

try {
  try {
    execFileSync(process.execPath, [
      compiler, tsPath, "-o", wasmPath,
      "--runtime", "incremental", "--exportRuntime", "--noColors"
    ], { stdio: "pipe", cwd: here, encoding: "utf8" });
  } catch (error) {
    console.log("FAIL the probe compiles");
    console.log(String(error.stdout || "") + String(error.stderr || ""));
    process.exitCode = 1;
    throw error;
  }

  const module = new WebAssembly.Module(readFileSync(wasmPath));
  const instance = new WebAssembly.Instance(module, {
    // The guest links the framework, whose host imports are not exercised by
    // this test: answer them with zeros, and make `abort` visible.
    env: new Proxy({}, {
      get(_target, name) {
        if (name === "abort") {
          return (message) => {
            const memory = instance.exports.memory;
            const data = new Uint8Array(memory.buffer);
            const view = new DataView(memory.buffer);
            const length = view.getUint32(message - 4, true) >> 1;
            let text = "";
            for (let i = 0; i < length; i++) {
              text += String.fromCharCode(data[message + i * 2] | (data[message + i * 2 + 1] << 8));
            }
            throw new Error(text);
          };
        }
        return () => 0;
      }
    }),
    // The scheduler's guest half (TensionScript 0.6.0): a guest that parks
    // imports `scheduler::park`. This harness exercises the *pull* path only,
    // so the push half is a no-op here — but the import must exist, or
    // instantiation fails before a single check runs (measured: "Import #1
    // scheduler: module is not an object or function").
    scheduler: {
      park: () => {}
    }
  });

  check("the framework parks and dispatches with no table and no session (41)",
    instance.exports.probe(), 41);
} finally {
  rmSync(tsPath, { force: true });
  rmSync(wasmPath, { force: true });
}

console.log();
if (failures) {
  console.log(`FAILURE: ${failures} of ${checks} checks failed`);
  process.exitCode = 1;
} else {
  console.log(`[ SUCCESS ] ${checks} checks`);
}
