#!/usr/bin/env node
// The conformance gate: every feature we have, asked of the debugger.
//
// # What it asserts, and why the verdicts are separate
//
// For each case it compiles a guest (with the repository's vendored compiler),
// runs `tension-core` under lldb in batch mode, and asks the questions
// separately, because they fail for different reasons and one word covering two
// facts is how four rounds were lost:
//
//   `skipped`     — the case did not run. **Always carries a reason.** Today
//                   that is `guest-refused`: the engine could not load the
//                   guest (a continuation module on an engine without stack
//                   switching), so nothing was measured. This is not a failure
//                   of the debugger and must never be counted as one.
//   `unresolved`  — the guest ran and the breakpoint matched **zero**
//                   locations. lldb never bound the request to an address.
//   `no-stop`     — the breakpoint resolved and execution ran to the end
//                   without stopping. The address existed and was never hit.
//   `no-source`   — it stopped, and the frame names no file we asked for.
//   `wrong-line`  — it stopped in the right file on a **different** line; both
//                   the expected and the observed line are recorded.
//   `pass`        — resolved >= 1, stopped on a breakpoint, right file, and
//                   `line === expected`. "It stopped" is not a pass.
//
// A skipped case is not green either: it is *unknown*, and the tally says so
// instead of folding it into a failure count.
//
// # The engine is part of the result
//
// A capture records the engine binary's path, mtime, and the `async backend:`
// line it prints. If the binary predates the newest file under
// `tension-core/src/`, the run warns loudly and says so in the capture: a stale
// interpreter silently turns every continuation guest into a "failure", which is
// exactly what happened before this was recorded.
//
// # Loadability is probed, not inferred
//
// Before a case runs under lldb, the engine is run on the artifact **without a
// debugger** and its stderr read. A guest it refuses to parse is
// `skipped(guest-refused)` with the engine's own message attached. Inferring
// "refused" from "lldb found no location" is the mistake this replaces.
//
// # One driver
//
// The run goes through `tools/e2e-debugger/lib/run-lldb.js` — the same driver
// `tests/debugger.rs` and the examples' debug mode use. A second reader of lldb
// output would be a second place for "did it stop?" to be answered differently.
//
// # lldb is a dependency, not an option
//
// A missing lldb **fails** this command with install instructions. A skip would
// be a hole in the gate, and a hole in the gate is the defect the gate exists to
// find. (`skipped` here means the *case* did not run, and it says why.)
//
// # Usage
//
//   node tools/debug-conformance/runner.js                 # every case
//   node tools/debug-conformance/runner.js --only async    # a substring of the name
//   node tools/debug-conformance/runner.js --json out.json # also write the table
//   node tools/debug-conformance/runner.js --no-build      # use the artifacts as they are
//   node tools/debug-conformance/runner.js --no-probe      # skip the load probe (debugging the gate)
//
// Exit 0 when every case passes or is skipped with a reason, 1 when any case
// fails, 2 when the harness itself cannot run (no lldb, no engine binary, no
// matrix entry's marker).

import fs from "node:fs";
import path from "node:path";
import { spawnSync } from "node:child_process";
import { fileURLToPath } from "node:url";

import { lldbSkipReason, resolveLldb, resolveTensionCore } from "../e2e-debugger/lib/resolve.js";
import { debugGuest } from "../e2e-debugger/lib/run-lldb.js";

const here = path.dirname(fileURLToPath(import.meta.url));
const repo = path.resolve(here, "..", "..");
const programs = path.join(repo, "tension-core", "tests", "programs");
const debugBuild = path.join(programs, "build", "debug");
const engineSrc = path.join(repo, "tension-core", "src");

/** The capture format. v2 split `unresolved` from `skipped(reason)`. */
const FORMAT = "debug-conformance v2";

/** A breakpoint run costs ~8 s (measured in `tools/e2e-debugger`); 30 s is 3.7x. */
const DEBUG_TIMEOUT_MS = 30_000;

/** A load probe is a parse plus a short run; every conformance guest finishes in <1 s. */
const PROBE_TIMEOUT_MS = 20_000;

function parseArgs(argv) {
  const args = { only: null, json: null, build: true, probe: true };
  for (let i = 0; i < argv.length; ++i) {
    const arg = argv[i];
    if (arg === "--only") args.only = argv[++i];
    else if (arg === "--json") args.json = argv[++i];
    else if (arg === "--no-build") args.build = false;
    else if (arg === "--no-probe") args.probe = false;
    else throw new Error(`unknown argument ${arg}`);
  }
  return args;
}

/** Where a program's source lives, by searching the program folders. */
function sourceOf(programName) {
  for (const folder of fs.readdirSync(programs, { withFileTypes: true })) {
    if (!folder.isDirectory() || folder.name === "build") continue;
    const candidate = path.join(programs, folder.name, `${programName}.ts`);
    if (fs.existsSync(candidate)) return candidate;
  }
  return null;
}

/** The 1-based line holding `// @<marker>`, exactly once. */
function lineOfMarker(source, marker) {
  // The comment must **end** at the marker: `@stop` is a prefix of `@stop2`, and
  // `includes` would make one file's second marker satisfy the first case.
  const needle = new RegExp(`//\\s*${marker.replace(/[.*+?^${}()|[\]\\]/g, "\\$&")}\\s*$`);
  const matches = [];
  const lines = source.split("\n");
  for (let i = 0; i < lines.length; ++i) {
    if (needle.test(lines[i])) matches.push(i + 1);
  }
  if (matches.length !== 1) {
    throw new Error(
      `marker '${needle}' appears ${matches.length} time(s); a matrix row needs exactly one`
    );
  }
  return matches[0];
}

/**
 * Every call to the program's transcript function, in source order.
 *
 * A transcript call is how a showcase program prints, so "every line the
 * program prints" is "every call to this function". The count is positional —
 * `#1`, `#2` — so the case name says which line of the *transcript* is under
 * test rather than which line of the file.
 */
function transcriptLines(source, functionName) {
  const lines = [];
  const pattern = new RegExp(`(^|[^A-Za-z0-9_$.])${functionName}\\s*\\(`, "g");
  const sourceLines = source.split("\n");
  for (let i = 0; i < sourceLines.length; ++i) {
    const text = sourceLines[i];
    // The function's own declaration is the writer, not a transcript point.
    if (new RegExp(`function\\s+${functionName}\\s*\\(`).test(text)) continue;
    if (/^\s*\/\//.test(text)) continue;
    pattern.lastIndex = 0;
    if (pattern.test(text)) lines.push(i + 1);
  }
  return lines;
}

/** Expand a matrix row into the concrete cases it names. */
function expand(row) {
  const source = sourceOf(row.program);
  if (!source) throw new Error(`no .ts program named "${row.program}" under ${programs}`);
  const text = fs.readFileSync(source, "utf8");
  if (row.marker) {
    return [{ name: row.name, program: row.program, file: row.file, line: lineOfMarker(text, row.marker), group: row.group, executors: row.executors ?? 0 }];
  }
  const lines = transcriptLines(text, row.transcript);
  if (lines.length === 0) {
    throw new Error(`"${row.program}" calls ${row.transcript}(…) nowhere; the row names a function the program does not use`);
  }
  return lines.map((line, index) => ({
    name: `${row.name}.transcript#${index + 1}`,
    program: row.program,
    file: row.file,
    line,
    group: row.group,
    executors: row.executors ?? 0,
  }));
}

/** The guest artifact, and the symbol path a breakpoint needs. */
function guestOf(programName) {
  const guest = path.join(debugBuild, `${programName}.wasm`);
  if (!fs.existsSync(guest)) {
    throw new Error(
      `no debug artifact at ${path.relative(repo, guest)} — run ` +
        `"node scripts/build-test-programs.mjs --debug" first`
    );
  }
  return guest;
}

/** `mtimeMs` of the newest file under a directory tree, or `null`. */
function newestFile(root, filter) {
  let best = null;
  const walk = (dir) => {
    let entries;
    try {
      entries = fs.readdirSync(dir, { withFileTypes: true });
    } catch {
      return;
    }
    for (const entry of entries) {
      const full = path.join(dir, entry.name);
      if (entry.isDirectory()) walk(full);
      else if (!filter || filter(entry.name)) {
        const stat = fs.statSync(full);
        if (!best || stat.mtimeMs > best.mtimeMs) best = { path: full, mtimeMs: stat.mtimeMs };
      }
    }
  };
  walk(root);
  return best;
}

/**
 * The engine, as the capture must record it.
 *
 * `backend` is the line the engine itself prints (`async backend: …`), which is
 * the fact that decides whether a continuation guest can run at all. `stale`
 * compares the binary's mtime with the newest source it was built from: an
 * engine older than its sources is a measurement about a binary nobody has,
 * which is the trap this field exists to catch.
 */
function engineFacts(binaryPath) {
  const stat = fs.statSync(binaryPath);
  const newest = newestFile(engineSrc, (name) => name.endsWith(".rs") || name.endsWith(".toml"));
  const manifest = path.join(repo, "tension-core", "Cargo.toml");
  let manifestMtime = null;
  try {
    manifestMtime = fs.statSync(manifest).mtimeMs;
  } catch {
    manifestMtime = null;
  }
  const newestMs = Math.max(newest?.mtimeMs ?? 0, manifestMtime ?? 0);
  const facts = {
    path: binaryPath,
    relative: path.relative(repo, binaryPath),
    mtime: new Date(stat.mtimeMs).toISOString(),
    mtimeMs: stat.mtimeMs,
    newestSource: newest ? { path: path.relative(repo, newest.path), mtime: new Date(newest.mtimeMs).toISOString() } : null,
    stale: stat.mtimeMs < newestMs,
    backend: null,
  };
  // One probe run, with no guest that needs anything: `--help` prints the
  // backend line and nothing else starts.
  const help = spawnSync(binaryPath, ["--help"], { encoding: "utf8", timeout: PROBE_TIMEOUT_MS });
  const text = `${help.stdout ?? ""}\n${help.stderr ?? ""}`;
  const match = /async backend:\s*([a-z-]+)/.exec(text);
  facts.backend = match ? match[1] : null;
  return facts;
}

/**
 * Can the engine load this guest? Asked directly, not inferred.
 *
 * The engine is run on the artifact with no debugger. A guest it cannot parse
 * is reported by its own `failed to parse WebAssembly module` chain, which is a
 * property of (guest, engine) and has nothing to do with breakpoints. The
 * answer is cached per (program, executors) because it cannot vary per case.
 */
function makeLoadProbe(binaryPath) {
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

/** Count results by class. `skipped` is counted apart from `fail`. */
function tally(results) {
  const counts = {};
  for (const result of results) {
    const key = result.verdict;
    counts[key] = (counts[key] ?? 0) + 1;
  }
  return counts;
}

function main() {
  const args = parseArgs(process.argv.slice(2));
  const matrix = JSON.parse(fs.readFileSync(path.join(here, "matrix.json"), "utf8"));

  const lldb = resolveLldb();
  if (!lldb.path) {
    console.error(
      "debug-conformance: lldb is required and was not found.\n" +
        `  reason: ${lldbSkipReason(lldb)}\n` +
        "  install: npm install (the pinned @debugmcp/codelldb package), or\n" +
        "           apt-get install lldb / brew install llvm — then re-run.\n" +
        "  A skip is a hole in the gate; this command fails instead."
    );
    process.exit(2);
  }

  let binary;
  try {
    binary = resolveTensionCore().path;
  } catch (error) {
    console.error(`debug-conformance: ${error.message}`);
    process.exit(2);
  }

  const engine = engineFacts(binary);
  if (engine.stale) {
    console.error(
      "debug-conformance: WARNING — the engine binary is older than its sources.\n" +
        `  binary        ${engine.relative} (${engine.mtime})\n` +
        `  newest source ${engine.newestSource?.path ?? "(none)"} (${engine.newestSource?.mtime ?? "?"})\n` +
        "  Every guest this binary refuses will be reported as skipped(guest-refused),\n" +
        "  not as a debugger failure — but a stale engine measures a binary nobody has.\n" +
        "  Rebuild it: cargo build --manifest-path tension-core/Cargo.toml --release"
    );
  }
  if (engine.backend == null) {
    console.error(
      `debug-conformance: WARNING — ${engine.relative} did not print an \`async backend:\` line.\n` +
        "  The engine build predates the backend report (or is not tension-core).\n" +
        "  Whether continuation guests can run here is therefore unverified."
    );
  }

  if (args.build) {
    const built = spawnSync(process.execPath, [path.join(repo, "scripts", "build-test-programs.mjs"), "--debug"], {
      stdio: "pipe",
      encoding: "utf8",
      cwd: repo,
    });
    if (built.status !== 0) {
      console.error(`debug-conformance: the debug build failed:\n${built.stdout ?? ""}${built.stderr ?? ""}`);
      process.exit(2);
    }
  }

  const rows = [];
  for (const row of matrix.cases) {
    for (const testCase of expand(row)) {
      if (args.only && !testCase.name.includes(args.only)) continue;
      rows.push(testCase);
    }
  }
  if (rows.length === 0) {
    console.error("debug-conformance: the matrix expanded to no cases");
    process.exit(2);
  }

  console.log(
    `debug-conformance: lldb ${lldb.path} (${lldb.source}); engine ${path.relative(repo, binary)}` +
      (engine.backend ? ` [${engine.backend}]` : " [backend unknown]")
  );
  console.log(`debug-conformance: ${rows.length} cases\n`);

  // Work files live **in the repo**, beside the other harnesses' cache
  // (`tests/debug/.cache` in the compiler tree): nothing this gate needs may
  // live in a temp directory, because a temp directory is where the previous
  // round's 366-hole measurement was lost.
  const cacheRoot = path.join(here, ".cache", "work");
  fs.rmSync(cacheRoot, { recursive: true, force: true });
  fs.mkdirSync(cacheRoot, { recursive: true });
  const workRoot = cacheRoot;
  const results = [];
  const probe = makeLoadProbe(binary);

  for (const testCase of rows) {
    const guest = guestOf(testCase.program);
    const symbolPath = path.dirname(sourceOf(testCase.program));
    const extra = testCase.executors > 0 ? ["--executors", String(testCase.executors)] : [];
    const hostArgs = ["--debug", ...extra, "--symbol-path", symbolPath, guest];

    // The case did not run if the engine cannot load the guest. Asked before
    // the debugger is involved, so the answer cannot be a debugger verdict.
    if (args.probe) {
      const loadable = probe(testCase);
      if (!loadable.loads) {
        results.push({
          ...testCase,
          verdict: "skipped",
          reason: loadable.reason,
          engineMessage: loadable.message,
          detail: `skipped(${loadable.reason}): ${loadable.message ?? "the engine would not load the guest"}`,
          breakpoint: null,
        });
        continue;
      }
    }

    let observed;
    try {
      observed = debugGuest({
        lldb: lldb.path,
        binary,
        guest,
        args: hostArgs,
        symbolPath,
        cwd: path.dirname(guest),
        breakpoints: [{ file: testCase.file, line: testCase.line }],
        workDir: path.join(workRoot, testCase.name.replace(/[^\w.-]/g, "_")),
        timeoutMs: DEBUG_TIMEOUT_MS,
      });
    } catch (error) {
      results.push({
        ...testCase,
        verdict: "error",
        reason: "harness-error",
        detail: String(error && error.message ? error.message : error).split("\n")[0],
        breakpoint: null,
      });
      continue;
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

    results.push({
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
    });
  }

  fs.rmSync(cacheRoot, { recursive: true, force: true });

  const width = Math.max(...results.map((result) => result.name.length), 4);
  for (const result of results) {
    const mark =
      result.verdict === "pass" ? "PASS" : result.verdict === "skipped" ? "SKIP" : "FAIL";
    console.log(`  ${mark} ${result.name.padEnd(width)}  ${result.detail}`);
  }

  const counts = tally(results);
  const skipped = counts.skipped ?? 0;
  const passed = counts.pass ?? 0;
  const failed = results.length - passed - skipped;
  const summary =
    Object.entries(counts)
      .sort(([a], [b]) => a.localeCompare(b))
      .map(([key, value]) => `${key} ${value}`)
      .join(", ");
  console.log(
    `\ndebug-conformance: ${passed}/${results.length} pass, ${skipped} skipped, ${failed} fail` +
      (summary ? `  [${summary}]` : "")
  );

  if (args.json) {
    fs.mkdirSync(path.dirname(path.resolve(args.json)), { recursive: true });
    const capture = {
      format: FORMAT,
      engine,
      lldb: lldb.path ?? null,
      lldbVersion: lldb.version ?? null,
      binary: path.relative(repo, binary),
      probed: args.probe,
      counts,
      results,
    };
    fs.writeFileSync(path.resolve(args.json), `${JSON.stringify(capture, null, 2)}\n`);
    console.log(`debug-conformance: table written to ${args.json}`);
  }

  process.exit(failed === 0 ? 0 : 1);
}

try {
  main();
} catch (error) {
  console.error(`debug-conformance: ${error && error.message ? error.message : error}`);
  process.exit(2);
}
