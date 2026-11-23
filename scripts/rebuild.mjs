#!/usr/bin/env node
// Build the whole chain, in dependency order, and then *verify each link*.
//
//     npm run rebuild              build everything, then verify
//     npm run rebuild -- --check   verify only; exit 1 if anything is stale
//
// # The question this answers
//
// The user's words: *"why npm run build cannot check everything if its update …
// npm run build is never enough."* It is not enough because `npm run build` is
// four steps over *one* repository, and the thing that can be wrong is the seam
// between repositories — and between a build and the copy of it that is actually
// loaded. Each seam below is a link no existing script covers. This header is
// the list, and it is the reason this script exists rather than another
// `npm run` line:
//
// 1. **compiler tree → `dist/`.** `TensionScript`'s `prebuild` rebuilds
//    binaryen and `npm run build` there rebuilds `dist/`. Nothing in *this*
//    repository ever asks whether that happened. A tree pulled to a new commit
//    with no `npm run build` in it looks exactly like a built one until you read
//    a `dist/assemblyscript.js` that is a week old.
//
// 2. **`dist/` → installed copy.** This is the link that bites hardest, because
//    `preinstall` (`scripts/ensure-compiler.mjs`) actively installs *the wrong
//    thing*: its fast path accepts whatever tarball the root `package.json`
//    names, so every `npm install`/`npm ci` lays down `.packs/`'s build and no
//    script compares that against the sibling tree. Measured: `npm ci` in this
//    repo replaced a fresh `45b3535e` with the tarball's `66e6932e` and printed
//    "up to date". No `npm run` in either repository would have told you.
//
// 3. **`std/` → installed `std/`.** The compiler's library is not one file. A
//    `dist/`-only copy is a known defect: the installed `assemblyscript.js` and
//    the installed `std/` can come from different commits and nothing fails —
//    the guest compiles against the wrong library. So this compares every file,
//    not the directory's existence.
//
// 4. **`tension-core/src` → the binary.** `cargo build` refreshes the binary
//    only when someone runs it, and nothing runs it for you after a pull. A
//    stale `target/debug/tension-core.exe` is what VS Code launches, so the
//    symptom is a debug session against code that is not in the tree.
//
// 5. **test program `.ts` → the guest `.wasm`.** `build/` is gitignored, so a
//    fresh checkout has no guests at all, and the Rust suites build one lazily
//    ("when its `.wasm` is missing or older than its `.ts`") — which means the
//    guests are fresh only for the tests that happened to run. `npm run build`
//    builds examples, not these.
//
// 6. **committed fixtures.** `tests/programs/fixtures/**/*.wasm` are checked in
//    and are the artifacts the debugger suite stops inside. They are rebuilt by
//    hand; nothing says whether the source that is in the tree is the source
//    that produced them.
//
// 7. **generated docs.** `docs/abi/*.md` is generated from the header and the
//    registration sites. `npm test` checks it (`test-abi-docs`), `npm run build`
//    does not — so a tree that was built but never tested carries a stale ABI
//    reference.
//
// # Fail-closed, not fail-convenient
//
// A link that cannot be checked prints `UNKNOWN` and the run exits 1. "Cannot
// check" is not "fine" — that is the difference between this script and a
// sentence in a README saying everything is up to date. In build mode a failed
// step stops the chain; it does not continue to the next link and print a table
// over a half-built tree.
//
// # What it will not do
//
// It never runs `npm install` (which would rewrite the lock and drop the
// tarball's `integrity`). The one install it may run is `npm ci`, and only when
// `node_modules` is absent in the checkout it is about to build.

import { spawnSync } from 'node:child_process';
import { createHash } from 'node:crypto';
import { cpSync, existsSync, readFileSync, readdirSync, realpathSync, rmSync, statSync } from 'node:fs';
import { basename, delimiter, dirname, join, relative, resolve } from 'node:path';

import { REPO, capture, run } from './lib/toolchain.mjs';

const CHECK_ONLY = process.argv.includes('--check');
const PACKAGE = '@yabgu_gm/tensionscript';

/// The sibling checkout. `TENSIONSCRIPT_DIR` exists because CI and worktrees put
/// the two repositories somewhere other than side by side; the default is the
/// layout both machines have used.
const COMPILER_DIR = resolve(process.env.TENSIONSCRIPT_DIR ?? join(REPO, '..', 'TensionScript'));
const INSTALLED = join(REPO, 'node_modules', ...PACKAGE.split('/'));

const CORE = join(REPO, 'tension-core');
const PROGRAMS = join(CORE, 'tests', 'programs');

// ── helpers ─────────────────────────────────────────────────────────────────

const say = (message) => console.log(`rebuild: ${message}`);

/// A short, stable stamp. Local time, because the comparison it explains
/// (`is this newer than that`) is a local one.
function stamp(ms) {
  if (ms == null) return '—';
  const d = new Date(ms);
  const pad = (n) => String(n).padStart(2, '0');
  return `${d.getFullYear()}-${pad(d.getMonth() + 1)}-${pad(d.getDate())} ` +
         `${pad(d.getHours())}:${pad(d.getMinutes())}`;
}

/// The newest file under `root` matching `accept`, as `{ path, ms }`, or null.
function newest(root, accept = () => true) {
  if (!existsSync(root)) return null;
  let best = null;
  const stack = [root];
  while (stack.length > 0) {
    const dir = stack.pop();
    for (const entry of readdirSync(dir, { withFileTypes: true })) {
      const full = join(dir, entry.name);
      if (entry.isDirectory()) {
        if (entry.name !== 'node_modules' && entry.name !== 'target') stack.push(full);
        continue;
      }
      if (!accept(entry.name)) continue;
      const ms = statSync(full).mtimeMs;
      if (best === null || ms > best.ms) best = { path: full, ms };
    }
  }
  return best;
}

/// `{ expected, actual, ok }` for two directory trees, compared file by file.
function compareTrees(left, right) {
  if (!existsSync(left)) return { expected: 'present', actual: 'missing', ok: false };
  if (!existsSync(right)) return { expected: 'present', actual: 'missing', ok: false };
  const files = [];
  const walk = (dir) => {
    for (const entry of readdirSync(dir, { withFileTypes: true })) {
      const full = join(dir, entry.name);
      if (entry.isDirectory()) walk(full);
      else files.push(relative(left, full));
    }
  };
  walk(left);
  let missing = 0;
  let differing = 0;
  for (const file of files) {
    const target = join(right, file);
    if (!existsSync(target)) { missing += 1; continue; }
    if (statSync(target).size !== statSync(join(left, file)).size) { differing += 1; continue; }
    // Same size is not same bytes; the compiler's `std/` is small enough that a
    // real comparison costs nothing and a size check would miss a same-length
    // edit, which is exactly the edit a comment change makes.
    if (captureHash(join(left, file)) !== captureHash(target)) differing += 1;
  }
  const ok = missing === 0 && differing === 0;
  return {
    expected: `${files.length} files identical`,
    actual: ok ? `${files.length} identical` : `${differing} differ, ${missing} missing`,
    ok,
  };
}

/// SHA-256 of a file, via Node rather than a platform tool.
function captureHash(file) {
  return createHash('sha256').update(readFileSync(file)).digest('hex');
}

/// Where npm is, resolved once per run.
///
/// # Why this is not one guess any more
///
/// It was `dirname(process.execPath)/node_modules/npm/bin/npm-cli.js` — where nvm
/// and the Windows installer put npm beside node. **Debian and Ubuntu do not:**
/// node is `/usr/bin/node` and npm is `/usr/lib/node_modules/npm`, reached through
/// a `/usr/bin/npm` symlink. There the guess names a path that does not exist and
/// the chain stopped at its first build step (I74, measured on snowarch).
///
/// The order below keeps every layout that worked working, and is tried in this
/// sequence because each route is more specific than the next:
///
/// 1. **`npm_execpath`** — npm sets it for every lifecycle script and it is the
///    documented way to find npm from inside one. Right on every layout npm
///    itself supports, including ones this machine has never seen.
/// 2. **`npm` on `PATH`** — kept because the script is also run as plain
///    `node scripts/rebuild.mjs` (CI, and the tooling here), where nothing sets
///    `npm_execpath`. A symlink is followed to its target, which on every unix
///    layout is `npm-cli.js` — the same file route 1 names.
/// 3. **The neighbour-of-node guess**, last, so a layout that resolved before
///    still resolves now and this change cannot trade one machine for another.
///
/// Nothing resolves → an error naming all three, thrown **before any build
/// step**. A run that cannot find npm must not look like a run that found
/// nothing to do.
let npmResolution;

function resolveNpm() {
  if (npmResolution) return npmResolution;
  const tried = [];

  // 1. npm_execpath — the documented route from inside a lifecycle script.
  const execpath = process.env.npm_execpath;
  if (execpath) {
    if (existsSync(execpath)) {
      return (npmResolution = { route: 'npm_execpath', file: realpathSync(execpath) });
    }
    tried.push(`npm_execpath → ${execpath} (does not exist)`);
  } else {
    tried.push('npm_execpath (unset — not run under `npm run`)');
  }

  // 2. The PATH's npm. `npm.cmd`/`npm.exe` first on Windows, where `npm` may be
  //    an extensionless shell script the OS will not execute.
  const names = process.platform === 'win32'
    ? ['npm.cmd', 'npm.exe', 'npm']
    : ['npm'];
  for (const dir of (process.env.PATH ?? '').split(delimiter).filter(Boolean)) {
    for (const name of names) {
      const candidate = join(dir, name);
      if (!existsSync(candidate)) continue;
      const real = realpathSync(candidate);
      // `npm-cli.js` (or a link to it) runs under this same node, exactly as
      // route 1 would. Anything else is a real executable — a `.cmd` shim on
      // Windows, an exotic wrapper elsewhere — and is spawned directly.
      if (real.endsWith('.js')) {
        return (npmResolution = { route: `PATH → ${candidate}`, file: real });
      }
      return (npmResolution = { route: `PATH → ${candidate}`, file: real, direct: true });
    }
  }
  tried.push('PATH (no `npm` on it)');

  // 3. The neighbour-of-node guess, unchanged, so nothing that worked stops.
  const neighbour = join(dirname(process.execPath), 'node_modules', 'npm', 'bin', 'npm-cli.js');
  if (existsSync(neighbour)) {
    return (npmResolution = { route: 'neighbour of node', file: neighbour });
  }
  tried.push(`neighbour of node → ${neighbour} (does not exist)`);

  throw new Error(
    `cannot find npm's CLI — tried:\n  ${tried.join('\n  ')}`,
  );
}

/// npm, invoked through Node so a `.cmd` shim is never spawned directly.
function npm(args, options = {}) {
  const { file, direct } = resolveNpm();
  const result = direct
    // A real executable: on Windows that is a `.cmd`, which node cannot spawn
    // without a shell; elsewhere it is a script with its own interpreter line.
    ? spawnSync(file, args, {
        stdio: 'inherit',
        cwd: options.cwd ?? REPO,
        env: process.env,
        shell: process.platform === 'win32',
      })
    : spawnSync(process.execPath, [file, ...args], {
        stdio: 'inherit',
        cwd: options.cwd ?? REPO,
        env: process.env,
      });
  if (result.error) throw new Error(`npm ${args.join(' ')}: ${result.error.message}`);
  if (result.status !== 0) throw new Error(`npm ${args.join(' ')} failed (exit ${result.status})`);
}

/// `node <script>` in a child, with the repo's environment assembly skipped on
/// purpose: these are Node scripts and need nothing from the C toolchain.
function node(script, args = [], cwd = REPO) {
  const result = spawnSync(process.execPath, [join(REPO, script), ...args], {
    stdio: 'inherit',
    cwd,
    env: process.env,
  });
  if (result.error) throw new Error(`${script}: ${result.error.message}`);
  if (result.status !== 0) throw new Error(`${script} failed (exit ${result.status})`);
}

/// The feature list the core binary is built with, in the same terms
/// `scripts/build-native.mjs` uses (`TENSION_AI`, `TENSION_RENDER2D`,
/// `TENSION_STATIC_SDL`).
///
/// This duplicates four lines of that script rather than calling it, because
/// `build-native.mjs` builds the **release payload** only and has no way to
/// express a dev profile — and the binary VS Code launches is
/// `target/debug/tension-core`. Duplicating the *selection* is the smaller
/// wrong: the alternative is a debug binary with a different feature set from
/// the release one, which is a debugging mystery, not a saved line.
function runtimeFeatures() {
  const ai = process.env.TENSION_AI === '1';
  const render2d = (process.env.TENSION_RENDER2D ?? 'rust') === 'rust';
  const staticSdl = process.env.TENSION_STATIC_SDL !== '0';
  const enabled = [ai ? 'ai' : 'audio'];
  if (render2d) enabled.push('render2d-core');
  if (staticSdl) enabled.push('static-sdl3');
  return {
    ai,
    args: ai
      ? ['--features', enabled.join(',')]
      : ['--no-default-features', '--features', enabled.join(',')],
  };
}

// ── build ───────────────────────────────────────────────────────────────────

function build() {
  // **Resolved first, and reported.** Which npm this run will use is the fact
  // that explains a build failure three steps later, and an unfamiliar layout
  // should be diagnosable from one line instead of another round of guessing
  // (I74). Thrown here, before any step, not at the first `npm` call.
  const { route, file } = resolveNpm();
  say(`npm via ${route} → ${file}`);

  // 1. the compiler checkout
  if (!existsSync(COMPILER_DIR)) {
    throw new Error(
      `${COMPILER_DIR} does not exist — set TENSIONSCRIPT_DIR to the compiler checkout`,
    );
  }
  if (!existsSync(join(COMPILER_DIR, 'node_modules'))) {
    say(`compiler: node_modules absent in ${COMPILER_DIR} — npm ci`);
    npm(['ci'], { cwd: COMPILER_DIR });
  }
  say('compiler: npm run build');
  npm(['run', 'build'], { cwd: COMPILER_DIR });

  // 2. dist/ + std/ -> the installed package
  say(`install: ${relative(REPO, INSTALLED)}/dist and /std`);
  for (const part of ['dist', 'std']) {
    const from = join(COMPILER_DIR, part);
    const to = join(INSTALLED, part);
    if (!existsSync(from)) throw new Error(`${from} does not exist — the compiler build did not produce it`);
    rmSync(to, { recursive: true, force: true });
    cpSync(from, to, { recursive: true });
  }

  // 3. the runtime
  say('runtime: npm run build:native (release)');
  node('scripts/build-native.mjs');
  const { ai, args } = runtimeFeatures();
  say(`runtime: cargo build (dev) ${args.join(' ')}`);
  try {
    run('cargo', ['build', '--manifest-path', join(CORE, 'Cargo.toml'), '--bin', 'tension-core', ...args]);
  } catch (error) {
    throw new Error(
      `${error.message}` +
        (ai ? ' — this is the `ai` feature; build-native.mjs turns it on only for TENSION_AI=1' : ''),
    );
  }

  // 4. the guests the suites run
  say('guests: scripts/build-test-programs.mjs (and --debug)');
  node('scripts/build-test-programs.mjs');
  node('scripts/build-test-programs.mjs', ['--debug']);
}

// ── verify ──────────────────────────────────────────────────────────────────

/**
 * @returns {{link: string, expected: string, actual: string, status: 'PASS'|'STALE'|'UNKNOWN'}[]}
 */
function verify() {
  const rows = [];
  const row = (link, expected, actual, status) => rows.push({ link, expected, actual, status });

  if (!existsSync(COMPILER_DIR)) {
    row('compiler: tree', 'a checkout', `${COMPILER_DIR} absent`, 'UNKNOWN');
    row('compiler: dist', 'unknown', 'unknown', 'UNKNOWN');
    row('compiler: installed dist', 'unknown', 'unknown', 'UNKNOWN');
    row('compiler: installed std', 'unknown', 'unknown', 'UNKNOWN');
  } else {
    const dist = join(COMPILER_DIR, 'dist', 'assemblyscript.js');
    const src = newest(join(COMPILER_DIR, 'src'), (name) => name.endsWith('.ts'));
    const distMs = existsSync(dist) ? statSync(dist).mtimeMs : null;
    row(
      'compiler: src → dist/assemblyscript.js',
      `built after ${stamp(src?.ms)}`,
      distMs === null ? 'dist missing' : `built ${stamp(distMs)}`,
      distMs !== null && src !== null && distMs >= src.ms ? 'PASS' : 'STALE',
    );

    const installed = join(INSTALLED, 'dist', 'assemblyscript.js');
    if (!existsSync(dist) || !existsSync(installed)) {
      row(
        'compiler: dist → installed',
        'both present',
        `${existsSync(dist) ? '' : 'dist missing '}${existsSync(installed) ? '' : 'installed missing'}`.trim(),
        existsSync(dist) && existsSync(installed) ? 'PASS' : 'STALE',
      );
    } else {
      const expected = captureHash(dist);
      const actual = captureHash(installed);
      row(
        'compiler: dist → installed',
        `${expected.slice(0, 12)} (tree)`,
        `${actual.slice(0, 12)} (installed)`,
        expected === actual ? 'PASS' : 'STALE',
      );
    }

    const std = compareTrees(join(COMPILER_DIR, 'std'), join(INSTALLED, 'std'));
    row('compiler: std → installed std', std.expected, std.actual, std.ok ? 'PASS' : 'STALE');
  }

  // The runtime, one row per profile: the release payload and the debug binary
  // VS Code launches are different artifacts and one can be stale alone.
  const src = newest(join(CORE, 'src'));
  for (const profile of ['release', 'debug']) {
    const binary = join(CORE, 'target', profile, 'tension-core.exe');
    const binaryPosix = join(CORE, 'target', profile, 'tension-core');
    const exists = existsSync(binary) ? binary : existsSync(binaryPosix) ? binaryPosix : null;
    if (exists === null) {
      row(`runtime: src → ${profile}`, `newer than ${stamp(src?.ms)}`, 'binary missing', 'STALE');
      continue;
    }
    const ms = statSync(exists).mtimeMs;
    row(
      `runtime: src → ${profile}`,
      `newer than ${stamp(src?.ms)}`,
      `built ${stamp(ms)}`,
      src !== null && ms >= src.ms ? 'PASS' : 'STALE',
    );
  }

  // Committed fixtures: present, and no older than a source of the same name.
  //
  // Compared by **git commit time**, not file mtime. A checkout rewrites the
  // mtime of the files it changed and leaves the rest at their clone time, so an
  // mtime comparison says "main-policy.wasm is older than main-policy.ts" on a
  // tree where the commit history says the opposite — a false STALE, measured
  // here after a rebase. Commit time is a property of the history, so it reads
  // the same on any clone. mtime is the fallback only for an untracked file,
  // which has no history to ask.
  const fixtures = probe('git', ['-C', REPO, 'ls-files', 'tension-core/tests/programs/fixtures']);
  if (fixtures === null) {
    row('fixtures: committed .wasm', 'enumerable', 'git ls-files failed', 'UNKNOWN');
  } else {
    const wasm = fixtures.split('\n').map((l) => l.trim()).filter((l) => l.endsWith('.wasm'));
    let missing = 0;
    let older = 0;
    for (const rel of wasm) {
      const full = join(REPO, rel);
      if (!existsSync(full)) { missing += 1; continue; }
      const source = findSourceFor(rel);
      if (source === null) continue;
      const sourceRel = relative(REPO, source).split('\\').join('/');
      const fixtureTime = lastCommit(rel);
      const sourceTime = lastCommit(sourceRel);
      const fixtureMs = fixtureTime === null ? statSync(full).mtimeMs : fixtureTime * 1000;
      const sourceMs = sourceTime === null ? statSync(source).mtimeMs : sourceTime * 1000;
      if (fixtureMs < sourceMs) older += 1;
    }
    row(
      'fixtures: committed .wasm',
      `${wasm.length} present, none behind its source`,
      missing === 0 && older === 0
        ? `${wasm.length} present, all current`
        : `${missing} missing, ${older} behind source`,
      missing === 0 && older === 0 ? 'PASS' : 'STALE',
    );
  }

  // Built guests: every test program `.ts` has an artifact at least as new.
  const sources = [];
  if (existsSync(PROGRAMS)) {
    for (const entry of readdirSync(PROGRAMS, { withFileTypes: true })) {
      if (!entry.isDirectory() || entry.name === 'build' || entry.name === 'fixtures') continue;
      for (const file of readdirSync(join(PROGRAMS, entry.name))) {
        if (file.endsWith('.ts')) sources.push(join(PROGRAMS, entry.name, file));
      }
    }
  }
  let stale = 0;
  let absent = 0;
  for (const source of sources) {
    const artifact = join(PROGRAMS, 'build', `${basename(source, '.ts')}.wasm`);
    if (!existsSync(artifact)) { absent += 1; continue; }
    if (statSync(artifact).mtimeMs < statSync(source).mtimeMs) stale += 1;
  }
  row(
    'guests: tests/programs/**/*.ts → build/*.wasm',
    `${sources.length} built after source`,
    absent === 0 && stale === 0 ? `${sources.length} current` : `${absent} absent, ${stale} stale`,
    sources.length > 0 && absent === 0 && stale === 0 ? 'PASS' : 'STALE',
  );

  // Generated ABI docs, asked of the generator itself.
  const doc = spawnSync(process.execPath, [join(REPO, 'scripts', 'gen-abi-doc.mjs'), '--check'], {
    encoding: 'utf8',
    cwd: REPO,
    env: process.env,
  });
  row(
    'docs: docs/abi/*.md',
    'generator --check clean',
    doc.status === 0 ? 'current' : 'stale',
    doc.status === 0 ? 'PASS' : 'STALE',
  );

  return rows;
}

/// When git last committed `rel` (repo-relative, forward slashes), or null when
/// it has no history to ask.
function lastCommit(rel) {
  const out = probe('git', ['-C', REPO, 'log', '-1', '--format=%ct', '--', rel]);
  if (out === null) return null;
  const seconds = Number(out.trim());
  return Number.isFinite(seconds) && out.trim() !== '' ? seconds : null;
}

/// The `.ts` a fixture was built from, by basename, or null when there is none
/// (a fixture whose source was never in the tree cannot be compared).
function findSourceFor(fixtureRel) {
  const base = fixtureRel.slice(fixtureRel.lastIndexOf('/') + 1).replace(/\.wasm$/, '');
  if (!existsSync(PROGRAMS)) return null;
  for (const entry of readdirSync(PROGRAMS, { withFileTypes: true })) {
    if (!entry.isDirectory() || entry.name === 'build' || entry.name === 'fixtures') continue;
    const candidate = join(PROGRAMS, entry.name, `${base}.ts`);
    if (existsSync(candidate)) return candidate;
  }
  return null;
}

/// `capture`, but null on any failure — for probes whose failure is a row in the
/// table rather than an exception.
function probe(command, args) {
  try {
    return capture(command, args);
  } catch {
    return null;
  }
}

function printTable(rows) {
  const widths = [44, 28, 30, 7];
  const fit = (text, width) => (text.length > width ? `${text.slice(0, width - 1)}…` : text.padEnd(width));
  console.log(`\n${fit('link', widths[0])}  ${fit('expected', widths[1])}  ${fit('actual', widths[2])}  ${fit('status', widths[3])}`.trimEnd());
  console.log(`${'-'.repeat(widths[0])}  ${'-'.repeat(widths[1])}  ${'-'.repeat(widths[2])}  ${'-'.repeat(widths[3])}`);
  for (const row of rows) {
    console.log(
      `${fit(row.link, widths[0])}  ${fit(row.expected, widths[1])}  ${fit(row.actual, widths[2])}  ${row.status}`,
    );
  }
  const bad = rows.filter((row) => row.status !== 'PASS');
  console.log(
    `\nrebuild: ${rows.length - bad.length}/${rows.length} links PASS` +
      (bad.length > 0 ? `, ${bad.length} STALE/UNKNOWN` : ''),
  );
  return bad.length;
}

// ── main ────────────────────────────────────────────────────────────────────

try {
  if (!CHECK_ONLY) {
    build();
    say('chain built; verifying');
  }
  const rows = verify();
  const bad = printTable(rows);
  process.exit(bad === 0 ? 0 : 1);
} catch (error) {
  console.error(`\nrebuild: stopped — ${error.message}`);
  process.exit(1);
}
