// One conformance case, run and classified — the unit a worker pool runs.
//
// This module exists because the case is the whole cost (spawn lldb, wait ~11 s,
// read one transcript line) and cases are already independent: each has its own
// `.cache/work/<case>/` and spawns its own engine. Splitting it out lets
// `runner.js` run the same function inline (`--workers 1`) or on a bounded pool
// of worker threads (`--workers N`), with no second copy of the classification
// rules for the parallel path to drift away from.
//
// What is deliberately *not* here: the load probe. It is keyed by
// (program, executors) and cached, so the main thread runs it once for every
// case before dispatching — a pool that re-probed would multiply the probe runs
// by the worker count and measure the same fact several times.

import fs from "node:fs";
import path from "node:path";
import { spawnSync } from "node:child_process";
import { fileURLToPath } from "node:url";

import { debugGuest } from "../../e2e-debugger/lib/run-lldb.js";

const here = path.dirname(fileURLToPath(import.meta.url));
export const repo = path.resolve(here, "..", "..", "..");
export const programs = path.join(repo, "tension-core", "tests", "programs");
export const debugBuild = path.join(programs, "build", "debug");

/** A breakpoint run costs ~8 s (measured in `tools/e2e-debugger`); 30 s is 3.7x. */
export const DEBUG_TIMEOUT_MS = 30_000;

/** A load probe is a parse plus a short run; every conformance guest finishes in <1 s. */
export const PROBE_TIMEOUT_MS = 20_000;

/** Where a program's source lives, by searching the program folders. */
export function sourceOf(programName) {
  for (const folder of fs.readdirSync(programs, { withFileTypes: true })) {
    if (!folder.isDirectory() || folder.name === "build") continue;
    const candidate = path.join(programs, folder.name, `${programName}.ts`);
    if (fs.existsSync(candidate)) return candidate;
  }
  return null;
}

/** The guest artifact, and the symbol path a breakpoint needs. */
export function guestOf(programName) {
  const guest = path.join(debugBuild, `${programName}.wasm`);
  if (!fs.existsSync(guest)) {
    throw new Error(
      `no debug artifact at ${path.relative(repo, guest)} — run ` +
        `"node scripts/build-test-programs.mjs --debug" first`
    );
  }
  return guest;
}

/**
 * Can the engine load this guest? Asked directly, not inferred.
 *
 * The engine is run on the artifact with no debugger. A guest it cannot parse
 * is reported by its own `failed to parse WebAssembly module` chain, which is a
 * property of (guest, engine) and has nothing to do with breakpoints. The
 * answer is cached per (program, executors) because it cannot vary per case.
 */
export function makeLoadProbe(binaryPath) {
  const cache = new Map();
  return function probe(testCase) {
    const key = `${testCase.program}\u0000${testCase.executors}`;
    if (cache.has(key)) return cache.get(key);
    const guest = guestOf(testCase.program);
    const args = ["--debug"];
    if (testCase.executors > 0) args.push("--executors", String(testCase.executors));
    args.push(guest);
    const run = spawnSync(binaryPath, args, {
      cwd: path.dirname(guest),
      encoding: "utf8",
      timeout: PROBE_TIMEOUT_MS,
      maxBuffer: 4 * 1024 * 1024,
    });
    const stderr = run.stderr ?? "";
    const verdict = { loads: true, reason: null, message: null };
    if (run.error && run.error.code === "ETIMEDOUT") {
      // Parsed and still running: that is a load, not a refusal.
      verdict.loads = true;
    } else if (/unknown (option|argument) \x60?([^\x60\n]*)\x60?/.test(stderr)) {
      // The engine does not accept a flag this case needs. A stale binary is the
      // usual cause (e.g. one built before `--executors`). That is still "did not
      // run", but it is not the guest's fault and not the debugger's.
      const flag = /unknown (?:option|argument) \x60([^\x60]+)\x60/.exec(stderr);
      verdict.loads = false;
      verdict.reason = "engine-arg-unsupported";
      verdict.message = `${flag ? flag[1] : "an option"} is not accepted by this engine (${path.relative(repo, binaryPath)})`;
    } else if (/failed to parse WebAssembly module/.test(stderr)) {
      verdict.loads = false;
      verdict.reason = "guest-refused";
      const lines = stderr
        .trim()
        .split("\n")
        .map((line) => line.trim())
        .filter((line) => line && !/^Caused by:?$/.test(line) && !/^usage:/.test(line));
      verdict.message = lines.slice(-2).join(" | ") || stderr.trim().split("\n").pop();
    } else if (run.status !== 0) {
      verdict.loads = false;
      verdict.reason = "engine-error";
      verdict.message =
        stderr
          .trim()
          .split("\n")
          .map((line) => line.trim())
          .filter((line) => line && !/^usage:|^\s{2,}/.test(line))
          .slice(-2)
          .join(" | ") || `exit ${run.status}`;
    }
    cache.set(key, verdict);
    return verdict;
  };
}

/**
 * Run one case under lldb and classify it.
 *
 * `context` is `{ lldb, binary, workRoot }` — everything the case needs that is
 * the same for every case in a run. The returned row carries the verdict, the
 * expected and observed line, and lldb's own breakpoint record, so a later
 * reader can re-check the classification instead of trusting it.
 */
export function runCase(context, testCase) {
  const guest = guestOf(testCase.program);
  const symbolPath = path.dirname(sourceOf(testCase.program));
  const extra = testCase.executors > 0 ? ["--executors", String(testCase.executors)] : [];
  const hostArgs = ["--debug", ...extra, "--symbol-path", symbolPath, guest];

  let observed;
  try {
    observed = debugGuest({
      lldb: context.lldb,
      binary: context.binary,
      guest,
      args: hostArgs,
      symbolPath,
      cwd: path.dirname(guest),
      breakpoints: [{ file: testCase.file, line: testCase.line }],
      workDir: path.join(context.workRoot, testCase.name.replace(/[^\w.-]/g, "_")),
      timeoutMs: DEBUG_TIMEOUT_MS,
    });
  } catch (error) {
    return {
      ...testCase,
      verdict: "error",
      reason: "harness-error",
      detail: String(error && error.message ? error.message : error).split("\n")[0],
      breakpoint: null,
    };
  }

  const breakpoint = observed.breakpoints?.[0] ?? null;
  const resolved = (breakpoint?.resolved ?? 0) >= 1;
  const stopped = observed.stopped && observed.hit_breakpoint;
  const fileOk = typeof observed.file === "string" && observed.file.endsWith(testCase.file);
  const lineOk = observed.line === testCase.line;

  let verdict;
  if (!resolved) verdict = "unresolved";
  else if (!stopped) verdict = "no-stop";
  else if (!fileOk) verdict = "no-source";
  else if (!lineOk) verdict = "wrong-line";
  else verdict = "pass";

  return {
    ...testCase,
    verdict,
    reason: null,
    expectedLine: testCase.line,
    observedLine: observed.line ?? null,
    observedFile: observed.file ?? null,
    detail:
      verdict === "pass"
        ? `${testCase.file}:${testCase.line}`
        : `${testCase.file}:${testCase.line} -> ${verdict}` +
          (verdict === "wrong-line" ? ` at ${observed.line}` : "") +
          (verdict === "no-source" ? ` (file ${observed.file || "empty"})` : "") +
          (breakpoint ? ` (locations ${breakpoint.locations}, resolved ${breakpoint.resolved})` : ""),
    breakpoint: breakpoint ?? null,
  };
}
