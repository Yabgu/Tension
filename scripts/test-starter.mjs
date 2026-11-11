#!/usr/bin/env node
// scripts/test-starter.mjs — scaffold the starter template and run what it built.
//
// ## Why this suite exists
//
// `packages/cli/templates/starter` is the first code every user sees: it is what
// `tension init` writes. It is also the only file in the tree that is *both* a
// guest and a document — `docs/getting-started.md` quotes its loop — so it drifts
// in three directions at once: away from the framework's API, away from the CLI's
// scaffolding contract, and away from the build pipeline that turns it into a
// `dist/`.
//
// Nothing else in `npm test` covers that combination. `cli` runs `init` and reads
// the files it wrote; `framework` compiles the SDK's own fixtures, which are not
// the template. So before this suite, a template that stopped compiling shipped
// silently, and the first hour of every new project was broken.
//
// ## What it asserts, in order
//
//   1. `tension init` scaffolds a project, and `package.json` names it.
//   2. `npm install` resolves the template's dependencies — the `file:` specs the
//      CLI substitutes inside the repo, and the registry's compiler.
//   3. `npm run build` compiles the guest and writes a `dist/` with a launcher.
//   4. The `dist/` binary, from its own directory, draws its frames headless and
//      exits 0 with the loop's own summary line.
//   5. The frames counted are the template's own `HEADLESS_FRAMES` constant.
//
// Step 4 is the load-bearing one. It runs the *packaged* core out of the dist, not
// `target/debug/tension-core`, so a scaffold is exercised the way a user runs it:
// `./dist/run.sh`, minus the window.
//
// ## Costs and the network
//
// Two external steps: `npm install` (the registry, for `@yabgu_gm/tensionscript`)
// and the guest compile. The `docs` suite already installs its Markdown parser on
// first run, so this is the tree's existing posture rather than a new dependency.
// A machine with a warm npm cache does both offline.
//
// The run itself needs a Vulkan device; the starter draws offscreen but still
// opens a GPU target. A machine without one fails with the pipeline error the
// other 2D suites fail with — see `tension-core/tests/support/ci.rs` for the
// policy, and `TENSION_TEST_ALLOW_SKIP=1` to downgrade it to a printed skip.
//
// Nothing this suite builds is kept: the temp project, its `node_modules` and its
// 20 MB `dist/` are removed on the way out. `TENSION_KEEP_STARTER=1` leaves the
// directory in place and prints the path, which is what to reach for when the
// suite fails and the reader wants to poke at the scaffold.

import { existsSync, mkdtempSync, readFileSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { REPO, WIN } from './lib/toolchain.mjs';
import { inherit, indent, spawn } from './lib/proc.mjs';

const RUNNER = 'starter';
const EXE = WIN ? '.exe' : '';

/// The CLI's entry point. `init` is deliberately driven through it rather than
/// through `src/init.js`: the command line is part of what a new user meets.
const cli = join(REPO, 'packages', 'cli', 'bin', 'tension.js');

function die(message, detail) {
  if (detail) console.error(indent(detail));
  console.error(`${RUNNER}: ${message}`);
  process.exit(1);
}

/// Print a guest's or a tool's output the way the other runners do, and return it
/// whole so the caller can assert on the parts that matter.
function echo(result) {
  const text = `${result.stdout}${result.stderr}`;
  if (text.trim()) console.log(indent(text));
  return text;
}

const dir = mkdtempSync(join(tmpdir(), 'tension-starter-'));
const keep = process.env.TENSION_KEEP_STARTER === '1';

/// Remove the scaffold. `rmSync` on Windows occasionally loses a race with a
/// just-exited child holding a handle in `node_modules`, and a failed cleanup is
/// not a test failure — so it is attempted, reported, and never fatal.
function cleanup() {
  if (keep) {
    console.log(`${RUNNER}: kept ${dir} (TENSION_KEEP_STARTER=1)`);
    return;
  }
  try {
    rmSync(dir, { recursive: true, force: true, maxRetries: 3 });
  } catch (error) {
    console.log(`${RUNNER}: could not remove ${dir} (${error.message})`);
  }
}

process.on('exit', cleanup);

// ── 1. scaffold ─────────────────────────────────────────────────────────────

console.log(`${RUNNER}: scaffolding the starter template into ${dir}`);
const init = spawn(process.execPath, [cli, 'init', dir], { cwd: tmpdir(), timeout: 120_000 });
if (init.status !== 0) die('`tension init` failed', echo(init));

for (const expected of ['package.json', 'tension.config.json', 'README.md',
                        'src/main.ts', 'assets/sprites.iwi']) {
  if (!existsSync(join(dir, expected))) {
    die(`the scaffold has no ${expected} — the template is incomplete`);
  }
}

// The template's tokens are substituted, not copied: an unreplaced `__NAME__`
// compiles fine and then names the project nothing.
const scaffolded = readFileSync(join(dir, 'package.json'), 'utf8');
const pkg = JSON.parse(scaffolded);
if (/__[A-Z_]+__/.test(scaffolded)) die(`package.json still has a template token: ${scaffolded}`);
if (!pkg.dependencies?.['tension-framework'] || !pkg.devDependencies?.['@yabgu_gm/tensionscript']) {
  die('the scaffold does not declare the framework or the compiler');
}

// ── 2. install ──────────────────────────────────────────────────────────────

console.log(`${RUNNER}: npm install`);
const install = inherit('npm', ['install', '--no-audit', '--no-fund'], { cwd: dir, timeout: 600_000 });
if (install.status !== 0) {
  die('npm install failed — the template\'s dependencies do not resolve ' +
      '(a moved `file:` spec, or no registry for the compiler)', install.stdout);
}

// ── 3. build ────────────────────────────────────────────────────────────────

console.log(`${RUNNER}: npm run build`);
const build = spawn('npm', ['run', 'build'], { cwd: dir, timeout: 600_000 });
const buildOutput = echo(build);
if (build.status !== 0) {
  // A compile error here is the API-drift case this suite is for: the template
  // calls a framework name that moved, and the message is the compiler's.
  die('the template did not compile', buildOutput);
}

const wasm = join(dir, 'build', 'game.wasm');
const assets = join(dir, 'build', 'assets.tns');
if (!existsSync(wasm)) die('the build wrote no build/game.wasm');
if (!existsSync(assets)) die('the build wrote no build/assets.tns');
console.log(`${RUNNER}: guest ${readFileSync(wasm).length} bytes`);

const launcher = join(dir, 'dist', 'run.sh');
const packaged = join(dir, 'dist', 'bin', `tension-core${EXE}`);
if (!existsSync(launcher)) die('the build wrote no dist/run.sh — the dist is not self-contained');
if (!existsSync(packaged)) die('the build wrote no dist/bin/tension-core');

// ── 4. run the packaged binary, headless ────────────────────────────────────
//
// From the dist's own directory, with the dist's own assets: this is the half of
// `run.sh` that does not need a display. `--headless` is what the guest's
// `windowRequest()` reads to open an offscreen canvas and stop at its budget.
//
// `TENSION_2D_HEADLESS` is set for the whole suite by `suiteEnv`, and the starter
// ignores it on purpose: it takes its headless answer from the argument the CLI
// would pass, so a `tension.config.json` that stopped producing `--headless` is a
// failure here rather than a silent fallback. Passing the flag explicitly is what
// makes this the user's path and not the examples'.

console.log(`${RUNNER}: running dist/bin/tension-core --headless`);
const run = spawn(packaged, ['--res', join(dir, 'dist', 'assets.tns'),
                             join(dir, 'dist', 'game.wasm'), '--headless'],
                  { cwd: join(dir, 'dist'), timeout: 180_000 });
const output = echo(run);

const gpu = output.match(/vkCreateGraphicsPipeline[s]?\s+(VK_\w+)/);
if (gpu || /set_pipeline -> -5/.test(output)) {
  const why = gpu ? gpu[1] : 'pipeline creation refused';
  const message = `this machine could not create a graphics pipeline (${why}).`;
  if (process.env.TENSION_TEST_ALLOW_SKIP === '1') {
    console.log(`${RUNNER}: SKIP — ${message}`);
    process.exit(0);
  }
  die(message);
}

// The template fails by trapping (`fail()` prints, then `assert(false)`), and the
// host names the trap. Checked separately from the status so the suite says which
// line of the guest died rather than only that the process did.
if (/game aborted/.test(output)) die('the guest aborted', output);
if (run.status !== 0) die(`the packaged guest exited ${run.status}`);

// What the status cannot catch: a guest that returns from `_start_game` without
// adopting the loop exits **0** having drawn nothing — measured by deleting the
// adoption line from a scaffold, which still printed its banner and its device
// log and stopped. The missing summary line is the only trace it leaves.

const summary = output.match(/scene: (\d+) frame\(s\) \(the frame budget was reached\)/);
if (!summary) {
  die('the guest never reported finishing its frame budget — ' +
      'the loop did not run, or did not adopt the host\'s', output);
}
const frames = Number(summary[1]);

// The budget is the template's to change, so read it from the scaffold rather
// than hard-coding 240: a template edit that moves the number is fine, a guest
// that stops reaching it is not. Falling back to a floor keeps the suite working
// if the constant is renamed.
const source = readFileSync(join(dir, 'src', 'main.ts'), 'utf8');
const declared = source.match(/HEADLESS_FRAMES\s*:\s*i32\s*=\s*(\d+)/);
if (declared) {
  if (frames !== Number(declared[1])) {
    die(`the guest drew ${frames} frames, but the template asks for ${declared[1]}`);
  }
} else if (frames < 60) {
  die(`the guest drew only ${frames} frames — expected the template's full budget`);
}

console.log(`${RUNNER}: PASS — the scaffold built, ran ${frames} frames headless, and exited 0`);
