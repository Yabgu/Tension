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
// 3. **`std/` → installed `std/`, as a mirror and nothing more** (DL43, I102).
//    The compiler's library is not one file, and the installed copy sits beside
//    `dist/` — but **no compile reads it.** The library a guest compiles against is
//    embedded in `dist/asc.js`, the bundle `bin/tensionscript.js` imports, and that
//    bundle is inside the identity. Measured: appending a syntax error to the
//    installed `std/assembly/task-rt.ts` still compiled a guest, exit 0.
//
//    So this row no longer claims what it used to claim ("the guest compiles
//    against the wrong library") — that was wrong, and a green row over a file
//    nothing loads is worse than no row. It now states what it checks: that the
//    **install step** left the package's on-disk sources in step with the tree they
//    were copied from, which is what a reader of the installed package sees. The
//    load-bearing guarantee — that a `std/` edit reaches the guests — moved to the
//    identity (`toolchain.mjs`'s `COMPILER_BUNDLES`).
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
import { pathToFileURL } from 'node:url';

import { REPO, capture, compilerBundleDigest, compilerIdentity, readBuildRecord, run } from './lib/toolchain.mjs';
import { PROGRAM_ALIASES } from './lib/program-aliases.mjs';
import { GUEST_EXTENSIONS, isGuestSource, guestStem } from './lib/guest-extensions.mjs';
import {
  readBuildRecord as readArtifactRecord,
  runtimeInputDigest,
  verifyRuntimeRecord,
} from './lib/build-record.mjs';

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
/**
 * The compiler checkout's own record, and the digest its inputs give **now**.
 *
 * The module is imported **from that checkout** — `scripts/lib/build-record.mjs`,
 * the one its build wrote the record with — so the canonical form has a single
 * definition and a change to the input set moves both ends. A tree that has no
 * such module (an older checkout) answers `null`, which is STALE with the reason.
 */
async function readCompilerInputDigest(dir, dist) {
  const module = join(dir, 'scripts', 'lib', 'build-record.mjs');
  if (!existsSync(module)) return null;
  let helpers;
  try {
    helpers = await import(pathToFileURL(module).href);
  } catch {
    return null;
  }
  if (typeof helpers.compilerInputDigest !== 'function') return null;
  return { record: helpers.readCompilerRecord(dist), current: helpers.compilerInputDigest(dir) };
}

/// The first 12 hex characters — long enough to be a fingerprint in a table cell,
/// short enough to read, and never the thing a comparison uses.
function short(hash) {
  return typeof hash === 'string' ? hash.slice(0, 12) : 'no compiler';
}

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
  // **Nothing writes the dev binary's record here any more** (DL42, I100). `cargo
  // build` writes it — `tension-core/build.rs` — whichever wrapper or hand typed the
  // command, so there is one writer and no step a round can skip.

  // 4. the guests the suites run
  say('guests: scripts/build-test-programs.mjs (and --debug)');
  node('scripts/build-test-programs.mjs');
  node('scripts/build-test-programs.mjs', ['--debug']);
}

// ── verify ──────────────────────────────────────────────────────────────────

/**
 * @returns {{link: string, expected: string, actual: string, status: 'PASS'|'STALE'|'UNKNOWN'}[]}
 */
async function verify() {
  const rows = [];
  const row = (link, expected, actual, status) => rows.push({ link, expected, actual, status });

  if (!existsSync(COMPILER_DIR)) {
    row('compiler: tree', 'a checkout', `${COMPILER_DIR} absent`, 'UNKNOWN');
    row('compiler: dist', 'unknown', 'unknown', 'UNKNOWN');
    row('compiler: installed dist', 'unknown', 'unknown', 'UNKNOWN');
    row('compiler: installed std', 'unknown', 'unknown', 'UNKNOWN');
  } else {
    // **The bundle's own record, not its mtime** (DL37, I86). An mtime cannot say
    // which sources produced a file — the lesson DL36 paid for one layer down — so
    // `scripts/build.js` writes a content digest of `src/`, `cli/` and `std/`
    // beside the artifact and this row recomputes it.
    //
    // **The digest's definition comes from the checkout being verified**, not from
    // a copy here: `COMPILER_DIR/scripts/lib/build-record.mjs` is the module that
    // wrote the record, so a change to the input set moves both ends together.
    // A second copy of the canonical form is how a record and its check come to
    // disagree.
    const dist = join(COMPILER_DIR, 'dist', 'assemblyscript.js');
    const compilerRecord = await readCompilerInputDigest(COMPILER_DIR, dist);
    if (compilerRecord === null) {
      row(
        'compiler: src → dist/assemblyscript.js',
        'a record naming its inputs',
        existsSync(dist) ? 'no build record beside dist' : 'dist missing',
        'STALE',
      );
    } else {
      const { record, current } = compilerRecord;
      row(
        'compiler: src → dist/assemblyscript.js',
        `${current.files} inputs → ${short(current.hash)}`,
        record === null
          ? 'no build record beside dist'
          : record.inputs === current.hash
            ? `recorded ${short(record.inputs)}`
            : `built from ${short(record.inputs)}`,
        record !== null && record.inputs === current.hash ? 'PASS' : 'STALE',
      );
    }

    // **Every bundle a compile loads** (DL43, I102), not just `assemblyscript.js`:
    // `dist/asc.js` carries the embedded std, so a std-only rebuild moves it and
    // leaves `assemblyscript.js` byte-identical — which is exactly the pair this row
    // used to call equal. Both sides are digested through
    // `toolchain.mjs`'s `compilerBundleDigest`, the same function `compilerIdentity`
    // uses for a guest's record, so the row and the records cannot disagree.
    const installedDir = join(INSTALLED, 'dist');
    const treeDigest = compilerBundleDigest(join(COMPILER_DIR, 'dist'));
    const installedDigest = compilerBundleDigest(installedDir);
    row(
      'compiler: dist → installed',
      treeDigest === null ? 'dist missing' : `${short(treeDigest)} (tree)`,
      installedDigest === null ? 'installed dist missing' : `${short(installedDigest)} (installed)`,
      treeDigest !== null && treeDigest === installedDigest ? 'PASS' : 'STALE',
    );

    // Named for what it checks, not for a load that does not happen: `std/` on disk
    // is a mirror of the tree's, and the compile-time library lives in `dist/asc.js`.
    const std = compareTrees(join(COMPILER_DIR, 'std'), join(INSTALLED, 'std'));
    row('compiler: std mirror (no compile reads it)', std.expected, std.actual, std.ok ? 'PASS' : 'STALE');
  }

  // The runtime, one row per profile: the release payload and the debug binary
  // VS Code launches are different artifacts and one can be stale alone.
  //
  // **Records, not mtimes** (DL37, I86). The binary's inputs are hashed into
  // `<binary>.build.json` by the step that ran cargo (`build-native.mjs` for
  // release, `build()` above for dev) and this recomputes the same digest. The
  // mtime answered "was it touched after the source", which is not the question:
  // a checkout, a rebase or a `touch` all move it without changing what the
  // binary was built from, and a compiler-only edit moves nothing at all.
  // **Verified per file, against a record the build wrote** (DL42, I100). The row's
  // label is still `<n> inputs → <aggregate>`; the verdict comes from
  // `verifyRuntimeRecord`, which recomputes one sha256 per input and names the first
  // file that moved. An aggregate compared between two implementations would pass a
  // build that forgot a file; a per-file list cannot.
  const digest = runtimeInputDigest(REPO);
  for (const profile of ['release', 'debug']) {
    const binary = join(CORE, 'target', profile, 'tension-core.exe');
    const binaryPosix = join(CORE, 'target', profile, 'tension-core');
    const found = existsSync(binary) ? binary : existsSync(binaryPosix) ? binaryPosix : null;
    if (found === null) {
      row(`runtime: src → ${profile}`, `${digest.files} inputs → ${short(digest.hash)}`, 'binary missing', 'STALE');
      continue;
    }
    const verdict = verifyRuntimeRecord(REPO, found);
    row(
      `runtime: src → ${profile}`,
      `${digest.files} inputs → ${short(digest.hash)}`,
      verdict.ok ? `recorded ${short(verdict.hash)}` : verdict.reason,
      verdict.ok ? 'PASS' : 'STALE',
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

  // Built guests: every test program source has an artifact at least as new.
  //
  // **One entry per artifact, not per source.** An alias (`PROGRAM_ALIASES`)
  // builds a second artifact from a source that already has one — DL38's fiber
  // build of the contract program — so a row that counted source files would
  // report one fewer guest than exists and never date the extra one.
  const sources = [];
  if (existsSync(PROGRAMS)) {
    for (const entry of readdirSync(PROGRAMS, { withFileTypes: true })) {
      if (!entry.isDirectory() || entry.name === 'build' || entry.name === 'fixtures') continue;
      for (const file of readdirSync(join(PROGRAMS, entry.name))) {
        if (isGuestSource(file)) sources.push(join(PROGRAMS, entry.name, file));
      }
    }
  }
  const artifacts = sources.map((source) => ({
    name: guestStem(basename(source)),
    source,
    artifact: join(PROGRAMS, 'build', `${guestStem(basename(source))}.wasm`),
  }));
  for (const [name, sourceRel] of Object.entries(PROGRAM_ALIASES)) {
    if (artifacts.some((entry) => entry.name === name)) continue;
    artifacts.push({
      name,
      source: join(PROGRAMS, sourceRel),
      artifact: join(PROGRAMS, 'build', `${name}.wasm`),
    });
  }
  let stale = 0;
  let absent = 0;
  for (const { source, artifact } of artifacts) {
    if (!existsSync(artifact)) { absent += 1; continue; }
    if (statSync(artifact).mtimeMs < statSync(source).mtimeMs) stale += 1;
  }
  row(
    'guests: tests/programs/**/*.tension → build/*.wasm',
    `${artifacts.length} built after source`,
    absent === 0 && stale === 0 ? `${artifacts.length} current` : `${absent} absent, ${stale} stale`,
    artifacts.length > 0 && absent === 0 && stale === 0 ? 'PASS' : 'STALE',
  );

  // **Which compiler built each guest** (I82). The link above asks whether the
  // artifact is newer than its source, and an artifact's bytes are a function of
  // **both** — so a compiler-only change is invisible to it: measured in DL35,
  // five guests had moved while that link read `0 bytes moved`.
  //
  // This link asks the other half, from the record the builder writes beside each
  // artifact: was it built by **the compiler that is installed now**? It reads
  // those records and never an mtime — the question is provenance, and an mtime
  // cannot answer a question about which binary ran.
  //
  // An artifact with **no** record is STALE, and says so in those words: it
  // predates the record, so nothing is known about what built it, and "unknown"
  // printed as PASS is the defect this link exists to remove.
  //
  // **Both sets.** The debug artifacts are guests too — they are what the
  // breakpoint tests load, and an artifact built by an older compiler is exactly
  // as misleading there as here. Only the sets that exist are counted, so a tree
  // that has never run a debug build is not failed for the absence.
  const installed = compilerIdentity();
  let recorded = 0;
  let unrecorded = 0;
  let otherCompiler = 0;
  for (const dir of ['build', join('build', 'debug')]) {
    if (!existsSync(join(PROGRAMS, dir))) continue;
    for (const { name } of artifacts) {
      const artifact = join(PROGRAMS, dir, `${name}.wasm`);
      if (!existsSync(artifact)) continue; // absence is the row above's business
      const record = readBuildRecord(artifact);
      if (record === null) { unrecorded += 1; continue; }
      if (installed.hash === null || record.compiler !== installed.hash) { otherCompiler += 1; continue; }
      recorded += 1;
    }
  }
  const present = recorded + unrecorded + otherCompiler;
  row(
    'guests: built by the installed compiler',
    present === 0 ? 'every guest carries a record' : `${present} recorded by ${short(installed.hash)}`,
    present === 0
      ? 'no artifacts built (run npm run rebuild)'
      : unrecorded === 0 && otherCompiler === 0
        ? `${recorded} of ${present} current`
        : [
            // Only the reasons that fired: a cell that reads "0 no build record,
            // 1 built by another compiler" makes a reader check a zero.
            unrecorded > 0 ? `${unrecorded} with no build record` : null,
            otherCompiler > 0 ? `${otherCompiler} built by another compiler` : null,
          ].filter(Boolean).join(', '),
    present > 0 && recorded === present && installed.hash !== null ? 'PASS' : 'STALE',
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

/// The source a fixture was built from, by basename, or null when there is none
/// (a fixture whose source was never in the tree cannot be compared).
///
/// The candidates are the **declared table's**, in the table's order, so a fixture
/// whose program was renamed is still found — and a tree that has both spellings
/// resolves the canonical one first, exactly as the compiler does.
function findSourceFor(fixtureRel) {
  const base = fixtureRel.slice(fixtureRel.lastIndexOf('/') + 1).replace(/\.wasm$/, '');
  if (!existsSync(PROGRAMS)) return null;
  for (const entry of readdirSync(PROGRAMS, { withFileTypes: true })) {
    if (!entry.isDirectory() || entry.name === 'build' || entry.name === 'fixtures') continue;
    for (const ext of GUEST_EXTENSIONS) {
      const candidate = join(PROGRAMS, entry.name, `${base}${ext}`);
      if (existsSync(candidate)) return candidate;
    }
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
  const rows = await verify();
  const bad = printTable(rows);
  process.exit(bad === 0 ? 0 : 1);
} catch (error) {
  console.error(`\nrebuild: stopped — ${error.message}`);
  process.exit(1);
}
