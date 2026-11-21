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
import os from "node:os";
import path from "node:path";
import { spawnSync } from "node:child_process";
import { fileURLToPath } from "node:url";
import { Worker } from "node:worker_threads";

import { lldbSkipReason, resolveLldb, resolveTensionCore } from "../e2e-debugger/lib/resolve.js";
import { PROBE_TIMEOUT_MS, guestOf, makeLoadProbe, programs, repo, runCase, sourceOf } from "./lib/cases.js";

const here = path.dirname(fileURLToPath(import.meta.url));
const engineSrc = path.join(repo, "tension-core", "src");

/** The capture format. v2 split `unresolved` from `skipped(reason)`. */
const FORMAT = "debug-conformance v2";

function parseArgs(argv) {
  const args = { only: [], json: null, build: true, probe: true, workers: 8 };
  for (let i = 0; i < argv.length; ++i) {
    const arg = argv[i];
    if (arg === "--only") args.only.push(argv[++i]);
    else if (arg === "--json") args.json = argv[++i];
    else if (arg === "--no-build") args.build = false;
    else if (arg === "--no-probe") args.probe = false;
    else if (arg === "--workers") args.workers = Number(argv[++i]);
    else if (arg.startsWith("--workers=")) args.workers = Number(arg.slice("--workers=".length));
    else throw new Error(`unknown argument ${arg}`);
  }
  if (!Number.isInteger(args.workers) || args.workers < 1) args.workers = 1;
  return args;
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
 * Does a case name match one of the `--only` needles?
 *
 * **An exact name wins over a substring.** `transcript#1` is a prefix of
 * `transcript#10`, so a filter that only compared substrings would silently add
 * a case — and a case the caller did not list is a case the two runs being
 * compared do not share. A needle that names a case exactly therefore matches
 * that case and nothing else; only a needle naming no case falls back to a
 * substring, which is the `--only async` convenience.
 */
function matchesOnly(name, needles) {
  if (needles.some((needle) => needle === name)) return true;
  return needles.some((needle) => !exactlyNamesACase(needle) && name.includes(needle));
}

/** Whether `needle` is the full name of some case. */
let caseNames = null;
function exactlyNamesACase(needle) {
  return caseNames !== null && caseNames.has(needle);
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

async function main() {
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

  // Expand first, filter second: "an exact name wins" needs the whole name set
  // before it can decide what a needle means.
  const allCases = [];
  for (const row of matrix.cases) allCases.push(...expand(row));
  caseNames = new Set(allCases.map((testCase) => testCase.name));
  const rows = args.only.length > 0 ? allCases.filter((testCase) => matchesOnly(testCase.name, args.only)) : allCases;
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
  // Probes first, on this thread. The load answer is cached per
  // (program, executors) because it cannot vary per case, so measuring it once
  // beats measuring it per worker — and a pool that re-probed would spend its
  // parallelism on the same fact.
  const probe = makeLoadProbe(binary);
  const results = new Array(rows.length);
  const pending = [];
  for (const [index, testCase] of rows.entries()) {
    if (args.probe) {
      const loadable = probe(testCase);
      if (!loadable.loads) {
        results[index] = {
          ...testCase,
          verdict: "skipped",
          reason: loadable.reason,
          engineMessage: loadable.message,
          detail: `skipped(${loadable.reason}): ${loadable.message ?? "the engine would not load the guest"}`,
          breakpoint: null,
        };
        continue;
      }
    }
    pending.push(index);
  }

  // One line per completed case. A 15-minute run that prints nothing until the
  // end is a run the caller can only poll blind, which is why the previous
  // rounds polled a directory count instead of the log.
  let done = 0;
  const progress = (result) => {
    ++done;
    const label = result.verdict === "pass" ? "ok" : result.verdict;
    console.log(
      `${label} ${done}/${rows.length} ${result.name}` +
        (result.verdict === "pass" ? "" : `  (${result.detail})`)
    );
  };
  for (const result of results) if (result) progress(result);
  console.log("");

  const context = { lldb: lldb.path, binary, workRoot };

  if (args.workers <= 1) {
    for (const index of pending) {
      results[index] = runCase(context, rows[index]);
      progress(results[index]);
    }
  } else {
    await runPool(pending, context, args.workers);
  }

  async function runPool(indices, caseContext, count) {
    const queue = [...indices];
    const size = Math.min(count, queue.length);
    let active = size;
    await new Promise((resolve) => {
      for (let spawned = 0; spawned < size; ++spawned) {
        const worker = new Worker(new URL("./lib/case-worker.js", import.meta.url), {
          workerData: { context: caseContext },
        });
        let current = null;
        let closed = false;
        const close = () => {
          if (closed) return;
          closed = true;
          if (--active === 0) resolve();
        };
        const feed = () => {
          if (queue.length === 0) {
            worker.postMessage({ type: "stop" });
            return;
          }
          current = queue.shift();
          worker.postMessage({ type: "run", index: current, testCase: rows[current] });
        };
        worker.on("message", (message) => {
          if (message.type !== "result") return;
          results[message.index] = message.result;
          current = null;
          progress(message.result);
          feed();
        });
        worker.on("error", (error) => {
          // A worker that dies costs the case it was holding, not the run. The
          // row is `error(harness-error)` and the pool refills from the queue.
          const index = current ?? queue.shift();
          if (index !== undefined && index !== null) {
            results[index] = {
              ...rows[index],
              verdict: "error",
              reason: "harness-error",
              detail: String(error && error.message ? error.message : error).split("\n")[0],
              breakpoint: null,
            };
            current = null;
            progress(results[index]);
          }
        });
        worker.on("exit", close);
        feed();
      }
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
      workers: args.workers,
      counts,
      results,
    };
    fs.writeFileSync(path.resolve(args.json), `${JSON.stringify(capture, null, 2)}\n`);
    console.log(`debug-conformance: table written to ${args.json}`);
  }

  process.exit(failed === 0 ? 0 : 1);
}

main().catch((error) => {
  console.error(`debug-conformance: ${error && error.message ? error.message : error}`);
  process.exit(2);
});
