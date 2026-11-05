#!/usr/bin/env node
// End-to-end checks for the examples against the real engine.
//
// The Rust suites answer static questions — does every example pin a
// DWARF-emitting compiler, does every artifact carry .debug_info, is every
// launch.json well formed. This runner answers the one a static check cannot:
// when the declared command is actually executed, does the engine accept it,
// does the guest run, and does a breakpoint bind?
//
//   node tests/e2e/runner.js                  # all three modes (--check)
//   node tests/e2e/runner.js --only launch    # launch | smoke | debug
//   node tests/e2e/runner.js --example io     # one example
//   node tests/e2e/runner.js --help
//
// Exit 0 when every case passes or skips; 1 when any case fails.

import fs from "node:fs";
import path from "node:path";

import {
  discoverExamples,
  loadBreakpoints,
  loadKnownSkips,
  relativePath,
} from "./lib/examples.js";
import {
  expand,
  expandArgs,
  missingDeclaredInput,
  readLaunchConfigs,
  unexpandedVariables,
} from "./lib/launch-json.js";
import { createReport, firstLineOf } from "./lib/report.js";
import { lldbSkipReason, resolveLldb, resolveTensionCore } from "./lib/resolve.js";
import { reportsMissingGuest, runTensionCore, unknownFlagIn } from "./lib/run-tension-core.js";
import { runUnderLldb } from "./lib/run-lldb.js";

const MODES = ["launch", "smoke", "debug"];

const LAUNCH_TIMEOUT_MS = 15_000;
const SMOKE_TIMEOUT_MS = 2_000;
const DEBUG_TIMEOUT_MS = 10_000;

/// A guest path that cannot exist. Every launch configuration is rewritten to
/// use it, so a run that gets past argument parsing must stop at the file check.
function missingGuestPath() {
  return path.join("/tmp", `e2e-missing-${process.pid}.wasm`);
}

function parseArgs(argv) {
  const options = { check: true, only: null, example: null, help: false };
  for (let index = 0; index < argv.length; index += 1) {
    const arg = argv[index];
    if (arg === "--check") options.check = true;
    else if (arg === "--only") {
      options.only = argv[index + 1];
      index += 1;
    } else if (arg === "--example") {
      options.example = argv[index + 1];
      index += 1;
    } else if (arg === "--help" || arg === "-h") options.help = true;
    else throw new Error(`unknown argument ${arg}`);
  }
  if (options.only && !MODES.includes(options.only)) {
    throw new Error(`--only takes one of ${MODES.join(", ")}, not "${options.only}"`);
  }
  return options;
}

function usage() {
  return [
    "usage: node tests/e2e/runner.js [--check] [--only <mode>] [--example <name>]",
    "",
    "modes:",
    "  launch  rebuild each .vscode/launch.json command and prove its flags parse",
    "  smoke   run each built artifact under `--debug` and look for a crash",
    "  debug   bind a source breakpoint per config/breakpoints.json under lldb",
    "",
    "environment:",
    "  TENSION_CORE  path to the tension-core binary (default: target/release)",
  ].join("\n");
}

/// The arguments an example's own launch configuration declares, with the guest
/// replaced by a real artifact.
///
/// The headless configuration is preferred when an example declares both: a
/// test must not need a display, and the windowed OGRE path has a pre-existing
/// teardown segfault that is not what this suite is about.
function runArguments(example, artifact, missingGuest) {
  const configurations = readLaunchConfigs(example.dir);
  const headless = configurations.find(
    (configuration) =>
      Array.isArray(configuration.args) &&
      configuration.args.some((value) => String(value) === "--renderer=null")
  );
  const chosen = headless ?? configurations[0];
  const guest = artifact ?? missingGuest;
  if (!chosen) return ["--debug", guest];

  const { args, guestIndex } = expandArgs(chosen, example.dir);
  if (guestIndex >= 0) args[guestIndex] = guest;
  else args.push(guest);
  return args;
}

// ------------------------------------------------------------- launch ---

async function runLaunchMode({ examples, knownSkips, report, binary }) {
  const missing = missingGuestPath();

  for (const example of examples) {
    const known = knownSkips.get(example.name);
    if (known) {
      report.skip("launch", example.name, known);
      continue;
    }

    let configurations;
    try {
      configurations = readLaunchConfigs(example.dir);
    } catch (error) {
      report.fail("launch", example.name, error.message);
      continue;
    }
    if (configurations.length === 0) {
      report.skip("launch", example.name, "no .vscode/launch.json");
      continue;
    }

    for (const [index, configuration] of configurations.entries()) {
      const label = configurations.length > 1 ? `${example.name}#${index}` : example.name;
      const program = expand(configuration.program ?? "", example.dir);

      const programVariables = unexpandedVariables(program);
      if (programVariables.length > 0) {
        report.skip("launch", label, `unexpanded variable in program (${programVariables.join(", ")})`);
        continue;
      }
      if (!program) {
        report.fail("launch", label, "launch.json declares no \"program\"");
        continue;
      }
      if (!fs.existsSync(program)) {
        report.fail(
          "launch",
          label,
          `program does not resolve to a file: ${program}`
        );
        continue;
      }

      const { args } = expandArgs(configuration, example.dir);
      const expandedVariables = args.flatMap((value) => unexpandedVariables(value));
      if (expandedVariables.length > 0) {
        report.skip("launch", label, `unexpanded variable in args (${expandedVariables.join(", ")})`);
        continue;
      }

      // Everything the configuration would have loaded is routed through the
      // missing-guest path: the point is to exercise the option parser, not the
      // example's resources.
      const guestIndex = args.findIndex((value) => value.endsWith(".wasm"));
      const runArgs = [...args];
      if (guestIndex >= 0) runArgs[guestIndex] = missing;
      else runArgs.push(missing);

      const run = await runTensionCore({
        binary,
        args: runArgs,
        cwd: example.dir,
        timeoutMs: LAUNCH_TIMEOUT_MS,
      });

      if (run.timedOut) {
        report.fail("launch", label, `did not exit within ${LAUNCH_TIMEOUT_MS}ms while reporting a missing guest`);
        continue;
      }
      const flag = unknownFlagIn(run.stderr);
      if (flag) {
        report.fail(
          "launch",
          label,
          `launch.json passes \`${flag}\`, which the engine rejected (removed or renamed flag)`
        );
        continue;
      }
      if (reportsMissingGuest(run.stderr)) {
        report.pass("launch", label);
        continue;
      }
      report.fail(
        "launch",
        label,
        `expected a missing-file report, got exit ${run.code}: ${firstLineOf(run.stderr)}`
      );
    }
  }
}

// -------------------------------------------------------------- smoke ---

async function runSmokeMode({ examples, knownSkips, report, binary }) {
  for (const example of examples) {
    const known = knownSkips.get(example.name);
    if (known) {
      report.skip("smoke", example.name, known);
      continue;
    }
    if (example.artifacts.length === 0) {
      report.skip("smoke", example.name, "no build/*.wasm artifact");
      continue;
    }

    for (const artifact of example.artifacts) {
      const label = `${example.name}/${path.basename(artifact)}`;
      const args = runArguments(example, artifact, missingGuestPath());
      const commandLine = relativePath(artifact);

      const missingInput = missingDeclaredInput(args);
      if (missingInput) {
        report.skip(
          "smoke",
          label,
          `declared input missing (${missingInput}) — path as written in launch.json`
        );
        continue;
      }

      const run = await runTensionCore({
        binary,
        args,
        cwd: example.dir,
        timeoutMs: SMOKE_TIMEOUT_MS,
      });

      if (run.stderr.includes("error while loading shared libraries")) {
        report.skip("smoke", label, "shared library missing at runtime (LD_LIBRARY_PATH)");
        continue;
      }
      if (run.stderr.includes("panicked at")) {
        report.fail("smoke", label, `engine panicked: ${firstLineOf(run.stderr)}`);
        continue;
      }
      if (run.signal === "SIGSEGV" || run.signal === "SIGABRT" || run.code === 139 || run.code === 134) {
        report.fail("smoke", label, `crashed (${run.signal ?? `exit ${run.code}`})`);
        continue;
      }
      if (run.timedOut) {
        report.pass("smoke", label);
        continue;
      }
      if (run.code === 0) {
        report.pass("smoke", label);
        continue;
      }
      report.fail(
        "smoke",
        label,
        `exited ${run.code} without a signal or a panic — not a clean run and not a crash: ${firstLineOf(run.stderr)}`
      );
    }
  }
}

// -------------------------------------------------------------- debug ---

async function runDebugMode({ examples, allExamples, knownSkips, breakpoints, report, binary, lldbInfo }) {
  const lldb = lldbInfo.path;
  if (!lldb) {
    report.skipAll("debug", lldbSkipReason(lldbInfo));
    return;
  }

  // `byName` holds every example so a config entry naming a missing example is
  // a failure; `selected` is the --example filter, which narrows what runs
  // without making the unselected entries look broken.
  const byName = new Map(allExamples.map((example) => [example.name, example]));
  const selected = new Set(examples.map((example) => example.name));

  for (const [name, breakpoint] of breakpoints) {
    const example = byName.get(name);
    if (!example) {
      report.fail("debug", name, "breakpoints.json names an example that does not exist");
      continue;
    }
    if (!selected.has(name)) continue;
    const known = knownSkips.get(name);
    if (known) {
      report.skip("debug", name, known);
      continue;
    }
    if (example.artifacts.length === 0) {
      report.skip("debug", name, "no build/*.wasm artifact");
      continue;
    }

    const artifact = example.artifacts[0];
    const args = runArguments(example, artifact, missingGuestPath());
    const missingInput = missingDeclaredInput(args);
    if (missingInput) {
      report.skip(
        "debug",
        name,
        `declared input missing (${missingInput}) — path as written in launch.json`
      );
      continue;
    }

    const workDir = path.join("/tmp", `e2e-debug-${name.replace(/\//g, "-")}-${process.pid}`);
    let observed;
    try {
      observed = runUnderLldb({
        lldb,
        binary,
        args,
        cwd: example.dir,
        symbolPath: example.dir,
        breakpoints: [{ file: path.basename(breakpoint.file), line: breakpoint.line }],
        workDir,
        timeoutMs: DEBUG_TIMEOUT_MS,
      });
    } catch (error) {
      report.fail("debug", name, error.message.split("\n")[0]);
      continue;
    } finally {
      fs.rmSync(workDir, { recursive: true, force: true });
    }

    const stop = observed.stops?.[0];
    if (observed.resolved && stop) {
      report.pass("debug", name, `${stop.file}:${stop.line} (${stop.function || "?"})`);
    } else {
      report.fail(
        "debug",
        name,
        `breakpoint at ${path.basename(breakpoint.file)}:${breakpoint.line} never resolved` +
          (observed.timedOut ? " (lldb timed out)" : "")
      );
    }
  }
}

// --------------------------------------------------------------- main ---

async function main() {
  const options = parseArgs(process.argv.slice(2));
  if (options.help) {
    console.log(usage());
    return 0;
  }

  const { path: binary, release } = resolveTensionCore();
  const lldbInfo = resolveLldb();
  const knownSkips = loadKnownSkips();
  const breakpoints = loadBreakpoints();

  const allExamples = discoverExamples();
  let examples = allExamples;
  if (options.example) {
    examples = examples.filter((example) => example.name === options.example);
    if (examples.length === 0) {
      throw new Error(`no example named "${options.example}"`);
    }
  }

  console.log(
    `e2e: ${examples.length} example(s); tension-core ${release ? "release" : "debug"} at ${relativePath(binary)}`
  );
  console.log(
    `e2e: lldb = ${lldbInfo.path ? `${relativePath(lldbInfo.path)} (source: ${lldbInfo.source})` : "absent (debug mode will skip)"}; ` +
      `${breakpoints.size} breakpoint(s) configured, ${knownSkips.size} known skip(s)`
  );

  const report = createReport();
  const modes = options.only ? [options.only] : MODES;

  for (const mode of modes) {
    const started = Date.now();
    if (mode === "launch") await runLaunchMode({ examples, knownSkips, report, binary });
    else if (mode === "smoke") await runSmokeMode({ examples, knownSkips, report, binary });
    else if (mode === "debug") {
      await runDebugMode({
        examples,
        allExamples,
        knownSkips,
        breakpoints,
        report,
        binary,
        lldbInfo,
      });
    }
    console.log(`\n-- ${mode} (${Date.now() - started}ms) --`);
  }

  console.log(`\n${report.summary()}`);
  return report.failures().length === 0 ? 0 : 1;
}

main()
  .then((code) => {
    process.exitCode = code;
  })
  .catch((error) => {
    console.error(`e2e: ${error.message}`);
    process.exitCode = 1;
  });
