// Drive lldb against `tension-core`, mirroring TensionScript's
// `tests/debug/lib/run-lldb.js` shape: write a command file, write a small
// Python driver, run lldb in batch mode over the inferior, and read a single
// machine-readable line out of the transcript.
//
// Two differences from that harness, both measured here:
//   * the inferior is `tension-core`, not standalone Wasmtime — the engine is
//     the thing under test, and it loads the guest itself;
//   * the guest must be compiled with DWARF for a source breakpoint to bind at
//     all, which is what 0.14.0 adoption bought. Against a synthesised guest
//     the pending breakpoint stays pending.
//
// `settings set plugin.jit-loader.gdb.enable on` is what lets lldb see a
// JIT-registered guest image; without it every guest breakpoint stays
// unresolved and the run looks like a failure of the engine.

import { spawnSync } from "node:child_process";
import fs from "node:fs";
import path from "node:path";

import { libraryPath } from "./resolve.js";

const DRIVER = String.raw`
import lldb, json

dbg = lldb.debugger
target = dbg.GetSelectedTarget()
process = target.GetProcess()
UNAVAILABLE = "<unavailable>"

stops = []
if process.GetState() == lldb.eStateStopped:
    thread = process.GetSelectedThread()
    frame = thread.GetFrameAtIndex(0)
    entry = frame.GetLineEntry()
    file_name = ""
    line = 0
    if entry and entry.IsValid():
        file_name = entry.GetFileSpec().GetFilename() or ""
        line = entry.GetLine() or 0
    reason = thread.GetStopReason()
    stops.append({
        "file": file_name,
        "line": line,
        "function": frame.GetFunctionName() or "",
        "hit_breakpoint": reason == lldb.eStopReasonBreakpoint,
    })

print("@@LLDB_JSON " + json.dumps({
    "stops": stops,
    "resolved": any(stop["hit_breakpoint"] for stop in stops),
    "exit_state": process.GetState(),
}))
`;

const ATTACH_FAILURE =
  /executable found|failed to launch|process launch failed|cannot launch|invalid executable/i;

/**
 * @param {{
 *   lldb: string,
 *   binary: string,
 *   args: string[],
 *   cwd: string,
 *   symbolPath: string,
 *   breakpoints: {file: string, line: number}[],
 *   workDir: string,
 *   timeoutMs?: number,
 * }} options
 * @returns {{resolved: boolean, stops: object[], raw: string, timedOut: boolean}}
 */
export function runUnderLldb({
  lldb,
  binary,
  args,
  cwd,
  symbolPath,
  breakpoints,
  workDir,
  timeoutMs = 10_000,
}) {
  fs.mkdirSync(workDir, { recursive: true });
  const driverPath = path.join(workDir, "driver.py");
  fs.writeFileSync(driverPath, DRIVER);
  const commandsPath = path.join(workDir, "lldb.cmds");

  const lines = [
    "settings set plugin.jit-loader.gdb.enable on",
    `settings set target.debug-file-search-paths "${symbolPath}"`,
  ];
  for (const breakpoint of breakpoints) {
    lines.push(`breakpoint set -f "${breakpoint.file}" -l ${breakpoint.line}`);
  }
  lines.push("run");
  lines.push(`script exec(open(${JSON.stringify(driverPath)}).read())`);
  lines.push("quit");
  fs.writeFileSync(commandsPath, `${lines.join("\n")}\n`);

  const result = spawnSync(lldb, ["-b", "-s", commandsPath, "--", binary, ...args], {
    encoding: "utf8",
    cwd,
    timeout: timeoutMs,
    maxBuffer: 32 * 1024 * 1024,
    env: { ...process.env, LD_LIBRARY_PATH: libraryPath() },
  });

  const raw = `${result.stdout ?? ""}\n${result.stderr ?? ""}`;
  const marker = raw.split("\n").find((line) => line.startsWith("@@LLDB_JSON "));
  const timedOut = result.error?.code === "ETIMEDOUT" || result.signal === "SIGKILL";

  if (!marker) {
    // Distinguish "lldb never launched the engine" from "it ran and the
    // breakpoint never bound" — two different failures for a reader.
    const tail = raw.trim().split("\n").slice(-20).join("\n");
    if (ATTACH_FAILURE.test(raw)) {
      throw new Error(`lldb could not launch tension-core (exit ${result.status}):\n${tail}`);
    }
    if (timedOut) {
      return { resolved: false, stops: [], raw, timedOut: true };
    }
    throw new Error(
      `breakpoint never resolved (lldb exit ${result.status}, timedOut=${timedOut}):\n${tail}`
    );
  }

  const observed = JSON.parse(marker.slice("@@LLDB_JSON ".length));
  return { ...observed, raw, timedOut };
}
