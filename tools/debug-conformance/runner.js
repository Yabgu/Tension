#!/usr/bin/env node
// The conformance gate: every feature we have, asked of the debugger.
//
// # What it asserts, and why in three pieces
//
// For each case it compiles a guest (with the repository's vendored compiler),
// runs `tension-core` under lldb in batch mode, and asks **three** questions
// separately, because they fail for different reasons and a single "it stopped"
// answer hides which one happened:
//
//   1. `unresolved`  — the breakpoint matched no location. lldb never bound the
//                      request to an address, so nothing could stop there.
//   2. `no stop`     — the breakpoint resolved (or not) and execution ran to
//                      the end without stopping. The address existed and was
//                      never reached.
//   3. `stopped at N` — it stopped, at the right file, on a **different line**.
//                      This is the regression that bit the owner: "it hits some
//                      kind of breakpoint but it doesn't match source code
//                      there." A harness that accepts "it stopped" as success
//                      reports this as green.
//
// A case passes only when all three hold: resolved >= 1, the process stopped on
// a breakpoint, and the stop's `frame.file` ends with the expected file and its
// `frame.line` **equals** the expected line.
//
// # One driver
//
// The run goes through `tools/e2e-debugger/lib/run-lldb.js` — the same driver
// `tests/debugger.rs` and the examples' debug mode use. A second reader of lldb
// output would be a second place for "did it stop?" to be answered differently.
// The driver reports each breakpoint's location count as well as the stops, so
// question 1 and question 2 are not the same answer.
//
// # lldb is a dependency, not an option
//
// A missing lldb **fails** this command with install instructions. A skip would
// be a hole in the gate, and a hole in the gate is the defect the gate exists to
// find.
//
// # Usage
//
//   node tools/debug-conformance/runner.js                 # every case
//   node tools/debug-conformance/runner.js --only async    # a substring of the name
//   node tools/debug-conformance/runner.js --json out.json # also write the table
//   node tools/debug-conformance/runner.js --no-build      # use the artifacts as they are
//
// Exit 0 when every case passes, 1 when any fails, 2 when the harness itself
// cannot run (no lldb, no engine binary, no matrix entry's marker).

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

/** A breakpoint run costs ~8 s (measured in `tools/e2e-debugger`); 30 s is 3.7x. */
const DEBUG_TIMEOUT_MS = 30_000;

function parseArgs(argv) {
  const args = { only: null, json: null, build: true };
  for (let i = 0; i < argv.length; ++i) {
    const arg = argv[i];
    if (arg === "--only") args.only = argv[++i];
    else if (arg === "--json") args.json = argv[++i];
    else if (arg === "--no-build") args.build = false;
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

  console.log(`debug-conformance: lldb ${lldb.path} (${lldb.source}); engine ${path.relative(repo, binary)}`);
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
  let failures = 0;

  for (const testCase of rows) {
    const guest = guestOf(testCase.program);
    const symbolPath = path.dirname(sourceOf(testCase.program));
    const extra = testCase.executors > 0 ? ["--executors", String(testCase.executors)] : [];
    const hostArgs = ["--debug", ...extra, "--symbol-path", symbolPath, guest];
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
        detail: String(error && error.message ? error.message : error).split("\n")[0],
        breakpoint: null,
      });
      ++failures;
      continue;
    }

    const breakpoint = observed.breakpoints?.[0] ?? null;
    const resolved = (breakpoint?.resolved ?? 0) >= 1;
    const stopped = observed.stopped && observed.hit_breakpoint;
    const fileOk = typeof observed.file === "string" && observed.file.endsWith(testCase.file);
    const lineOk = observed.line === testCase.line;

    let verdict;
    if (!resolved) verdict = "unresolved";
    else if (!stopped) verdict = "no stop";
    else if (!fileOk) verdict = `stopped with no source file (${observed.file || "empty"})`;
    else if (!lineOk) verdict = `stopped at ${observed.line}`;
    else verdict = "pass";

    if (verdict !== "pass") ++failures;
    results.push({
      ...testCase,
      verdict,
      detail:
        verdict === "pass"
          ? `${testCase.file}:${testCase.line}`
          : `${testCase.file}:${testCase.line} -> ${verdict}` +
            (breakpoint ? ` (locations ${breakpoint.locations}, resolved ${breakpoint.resolved})` : ""),
      breakpoint: breakpoint ?? null,
    });
  }

  fs.rmSync(cacheRoot, { recursive: true, force: true });

  const width = Math.max(...results.map((result) => result.name.length), 4);
  for (const result of results) {
    const mark = result.verdict === "pass" ? "PASS" : "FAIL";
    console.log(`  ${mark} ${result.name.padEnd(width)}  ${result.detail}`);
  }
  const passed = results.filter((result) => result.verdict === "pass").length;
  console.log(`\ndebug-conformance: ${passed}/${results.length} cases pass, ${failures} fail`);

  if (args.json) {
    fs.mkdirSync(path.dirname(path.resolve(args.json)), { recursive: true });
    fs.writeFileSync(path.resolve(args.json), `${JSON.stringify({ lldb: lldb.version ?? null, binary: path.relative(repo, binary), results }, null, 2)}\n`);
    console.log(`debug-conformance: table written to ${args.json}`);
  }

  process.exit(failures === 0 ? 0 : 1);
}

try {
  main();
} catch (error) {
  console.error(`debug-conformance: ${error && error.message ? error.message : error}`);
  process.exit(2);
}
