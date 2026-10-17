// The framework's async dispatcher, executed (Phase 4b).
//
// What is under test: `rt.start()` binding the completion classes to their
// families, `rt.deliver`/`onBatch` decoding the arena's 32-byte records into
// `__taskDeliver`, and `rt.runReady()` resuming the parked task — the whole
// path a real completion takes, minus the host.
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
    join(framework, "node_modules", "@yabgu_gm", "tensionscript", "bin", "tensionscript.js"),
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
  console.log("      The framework depends on @yabgu_gm/tensionscript@^0.3.0, whose std has");
  console.log("      the task machine and the completion symbol. Run `npm install` here,");
  console.log("      or set TENSIONSCRIPT_BIN to a 0.3.x build.");
  process.exit(1);
}

const source = `
import { rt } from "../assembly/runtime/rt";
import { Task, TaskRecord } from "~lib/task";
import { __taskTick, __taskHasRunnable } from "~lib/task-rt";

let resumed: i32 = 0;

async function awaitJob(h: Task<u32>): u32 {
  let v: u32 = await h;
  resumed = i32(v);
  return v;
}

export function probe(): i32 {
  rt.start();
  let handle: Task<u32> = rt.job(7);
  awaitJob(handle);                       // parks on (JOBS, 7)
  if (rt.hasRunnable()) return -1;        // nothing delivered yet
  let record: EventRecord = new EventRecord();
  record.class_ = 4;                      // JOB_DONE
  record.a = 7;                           // the job id
  record.b = 41;                          // the loader's resource id
  rt.onEvent(4, changetype<u32>(record)); // the framework's dispatcher
  if (!rt.hasRunnable()) return -2;
  rt.runReady();                          // __taskTick
  return resumed;
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
    })
  });

  check("a delivered completion resumes the parked task through rt (41)",
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
