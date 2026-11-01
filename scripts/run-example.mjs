#!/usr/bin/env node
// Cross-platform `npm start` / `npm run run` for the examples.
//
// Windows runs npm scripts through cmd.exe, where `../../tension-core/target/
// debug/tension-core` (no `.exe`), `printf ... |`, `${MODEL:-...}` and `./run.sh`
// all fail. This one runner replaces those per-example variants: it resolves
// the host binary for the platform, builds the guest, packs what needs packing,
// and composes the host's arguments — on Linux, macOS and Windows alike.
//
// Each example declares how it runs in a `tension` block in its package.json:
//
//   kind              "plain" | "io" | "ai" | "ogre" | "res" | "collision"
//   wasm              the guest artifact, when it is not build/game.wasm
//   stdin             text to feed the host (io)
//   args              default guest arguments (io)
//   model             model path for the ai example
//   extraCapability   a second --capability (input-camera's input DSO)
//   release           use target/release instead of target/debug
//   hostArgs          extra host options placed before the guest path, as an
//                     array (e.g. ["--log-level=trace", "--log-format=json"]);
//                     the example's own flags, so a reader can see them
//
// Steps that belong to the repository's own build scripts — the framework's
// session-config generator and `pack.sh` — are run through bash, because
// single-sourcing that logic matters more than avoiding the shell, and this
// repository already needs MSYS2 or Git Bash on Windows. Everything else is
// native. Set TENSION_BASH to point at a specific bash.
//
// A small, dependency-free script on purpose: it runs before `npm install`.

import { spawnSync } from 'node:child_process';
import { existsSync, mkdirSync, readFileSync, writeFileSync } from 'node:fs';
import { delimiter, dirname, join, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';
import { staleness } from './build-stamp.mjs';

const here = dirname(fileURLToPath(import.meta.url));
const repo = resolve(here, '..');
const WIN = process.platform === 'win32';
const EXE = WIN ? '.exe' : '';

const exampleDir = process.cwd();
const pkg = JSON.parse(readFileSync(join(exampleDir, 'package.json'), 'utf8'));
const cfg = pkg.tension ?? {};
const kind = cfg.kind ?? 'plain';
const skipBuild = process.argv.includes('--no-build');
const guestArgs = process.argv.slice(2).filter((a) => a !== '--no-build');

function die(message) {
  console.error(message);
  process.exit(1);
}

function run(command, args, options = {}) {
  const result = spawnSync(command, args, { stdio: 'inherit', cwd: exampleDir, ...options });
  if (result.error) die(`${command}: ${result.error.message}`);
  if (result.status !== 0) process.exit(result.status ?? 1);
}

function npm(args) {
  // npm is a .cmd shim on Windows; it needs a shell to launch.
  run('npm', args, { shell: WIN });
}

function capture(command, args) {
  const result = spawnSync(command, args, { cwd: exampleDir, encoding: 'utf8' });
  if (result.error) die(`${command}: ${result.error.message}`);
  if (result.status !== 0) die(`${command} ${args.join(' ')} exited ${result.status}`);
  return result.stdout;
}

/// Resolve a `@yabgu_gm/tension-*` dependency from the example's own tree.
///
/// The native side is npm packages now (see `packages/`), so an example finds
/// its interpreter and adapter the same way it finds its compiler: through
/// `node_modules`, resolved from the example directory. `file:` dependencies
/// make those symlinks into `packages/`, so this is a real install rather than
/// a path the runner recomputes from the repository layout.
function pkgDir(name) {
  return join(exampleDir, 'node_modules', ...name.split('/'));
}

function pkgFile(name, ...rest) {
  return join(pkgDir(name), ...rest);
}

function hostBinary() {
  if (process.env.TENSION_CORE) return process.env.TENSION_CORE;
  const installed = pkgFile('@yabgu_gm/tension-core', 'bin', `tension-core${EXE}`);
  if (existsSync(installed)) return installed;
  // Fall back to the cargo tree: an example can still be run straight out of a
  // checkout that has not had `npm run build:native` yet.
  const profile = cfg.release ? 'release' : 'debug';
  return join(repo, 'tension-core', 'target', profile, `tension-core${EXE}`);
}

function findBash() {
  if (process.env.TENSION_BASH) return process.env.TENSION_BASH;
  // Prefer a real MSYS2 or Git Bash. `C:\Windows\System32\bash.exe` is the WSL
  // launcher: it cannot see Windows drive paths like /c/Work/... at all.
  for (const candidate of [
    'C:/msys64/usr/bin/bash.exe',
    'C:/Program Files/Git/bin/bash.exe',
  ]) {
    if (existsSync(candidate)) return candidate;
  }
  for (const dir of (process.env.PATH ?? '').split(delimiter)) {
    if (/[\\/]system32$/i.test(dir)) continue;
    const candidate = join(dir, `bash${EXE}`);
    if (existsSync(candidate)) return candidate;
  }
  return null;
}

function bash(script, args = []) {
  const command = [toPosix(script), ...args].map(shellQuote).join(' ');
  // On Windows the MSYS2 shell wrapper is what sets up /usr/bin and
  // /ucrt64/bin; a bare bash.exe launched from cmd has no PATH and cannot even
  // find `dirname`.
  if (WIN && existsSync('C:\\msys64\\msys2_shell.cmd')) {
    const line = `"C:\\msys64\\msys2_shell.cmd" -ucrt64 -defterm -no-start -where "${exampleDir}" -c "${command}"`;
    // shell:true lets Node quote the line for cmd.exe; passing it as a
    // spawn argument escapes the inner quotes the way cmd does not understand.
    run(line, [], { shell: true });
    return;
  }
  const bashPath = findBash();
  if (!bashPath) {
    die(`this step runs ${script} and needs bash (MSYS2 or Git Bash on Windows).\n` +
        `Install it, or set TENSION_BASH to a bash executable.`);
  }
  run(bashPath, [toPosix(script), ...args]);
}

function shellQuote(s) {
  return /^[\w\-./=:+@]+$/.test(s) ? s : `'${s.replace(/'/g, `'\\''`)}'`;
}

/// Locate a program on PATH, falling back to the UCRT64 bin on Windows (the
/// MSYS2 install used to build, which is not on a plain cmd PATH).
function findTool(name) {
  for (const dir of (process.env.PATH ?? '').split(delimiter)) {
    const candidate = join(dir, `${name}${EXE}`);
    if (existsSync(candidate)) return candidate;
  }
  if (WIN) {
    const candidate = `C:/msys64/ucrt64/bin/${name}.exe`;
    if (existsSync(candidate)) return candidate;
  }
  return name;
}

/// MSYS2/Git bash parses `C:\a\b` as `C:ab` (backslashes are escapes). Hand it
/// the POSIX spelling of a Windows path (`/c/a/b`).
function toPosix(p) {
  if (!WIN) return p;
  let s = p.replace(/\\/g, '/');
  const drive = /^([A-Za-z]):/.exec(s);
  if (drive) s = `/${drive[1].toLowerCase()}${s.slice(2)}`;
  return s;
}

/// Fetch the ai example's GGUF weights unless present (or opted out). Shared by
/// `npm start`, `npm run fetch-model` and `postinstall`, and runnable before
/// the host is built.
function fetchModel() {
  const model = process.env.MODEL ?? cfg.model ?? 'models/Phi-3-mini-4k-instruct-q4.gguf';
  if (existsSync(join(exampleDir, model))) return;
  if (process.env.TENSION_SKIP_MODEL_FETCH) {
    console.log('TENSION_SKIP_MODEL_FETCH is set; fetch it later with `npm run fetch-model`');
    return;
  }
  console.log(`fetching ${model} (~2.3 GB, one time)...`);
  const url = 'https://huggingface.co/microsoft/Phi-3-mini-4k-instruct-gguf/resolve/main/Phi-3-mini-4k-instruct-q4.gguf';
  mkdirSync(dirname(join(exampleDir, model)), { recursive: true });
  // curl ships with Windows 10+ and every Unix; one command, resumable.
  run('curl', ['-fL', '-C', '-', '--progress-bar', '-o', `${model}.part`, url]);
  run(process.execPath, ['-e',
    `require('fs').renameSync(${JSON.stringify(`${model}.part`)},${JSON.stringify(model)})`]);
}

// Modes that run before the host is needed: useful on a checkout not yet built.
if (process.argv.includes('--fetch-model')) {
  fetchModel();
  process.exit(0);
}
if (process.argv.includes('--pack-only')) {
  bash(join(exampleDir, 'pack.sh'));
  process.exit(0);
}

// ── are the packaged binaries current? ───────────────────────────────────────
// Two binaries ship and both are rebuilt by the same command, so a stale one is
// almost always "you pulled, then did not rebuild". The failure that motivates
// this guard is quiet and expensive: an adapter built before a wire-record
// change decodes the guest's records with the old layout and answers -EINVAL,
// which surfaces as `submitCamera refused` in the example rather than as
// anything about a build. Say it plainly here instead.
//
// Content hash, not mtime — `build:framework` rewrites layout.ts and
// manifest.ts with identical content on every build, so mtimes are always
// newer than the binaries. scripts/build-stamp.mjs has the detail.
{
  const check = staleness(repo);
  if (check.missing) {
    die('packaged binaries not found. Run: npm run build:native\n' +
        '  (at the repository root; it fills packages/ from the build)');
  }
  if (check.stale.length) {
    for (const { name, built_at } of check.stale) {
      console.error(`${pkg.name}: ${name} is stale (built at ${built_at}, sources changed). Run: npm run build`);
    }
    process.exit(1);
  }
}

const host = hostBinary();
if (!existsSync(host)) {
  die(`no interpreter at ${host}\n` +
      `  build it:  cargo build --manifest-path tension-core/Cargo.toml --no-default-features\n` +
      `  Windows:   build.bat`);
}

// ── the guest's build dependencies and its wasm ──────────────────────────────
const asc = join(exampleDir, 'node_modules', '.bin', WIN ? 'tensionscript.cmd' : 'tensionscript');
if (!existsSync(asc)) {
  console.log(`${pkg.name}: installing the guest's build dependencies...`);
  npm(['install', '--silent']);
}

// ── kind-specific prerequisites ──────────────────────────────────────────────
let adapter = null;
let extraCapability = null;

if (kind === 'ogre') {
  // The asc build reads the generated session config; without it the build
  // cannot run. Regenerate only when it is missing (the generator is a repo
  // script, so it goes through bash).
  const asconfig = join(repo, 'tension-framework', 'build', 'session.asconfig.json');
  if (!existsSync(asconfig)) {
    console.log('generating the framework session config...');
    bash(join(repo, 'tension-framework', 'build.sh'), ['--hash', capture(host, ['layout-hash']).trim()]);
  }
  adapter = process.env.TENSION_OGRE_DSO ?? pkgFile('@yabgu_gm/tension-ogre', 'lib', 'libtension_ogre.so');
  if (!existsSync(adapter)) {
    // No fallback to tension-ogre/build: that adapter has no rpath into the
    // packages and no siblings that satisfy it, so using it trades a clear "not
    // installed" for a confusing loader error three lines later.
    die(`no OGRE adapter at ${adapter}\n` +
        `  run:  npm run build:native   (at the repository root)\n` +
        `  it builds the adapter against packages/ogre-next and installs it here`);
  }
  // The adapter resolves its libraries through its own DT_RPATH, but it still
  // needs to be told where the render-system plugins and the Hlms media are:
  // build.sh bakes an absolute path, which is wrong once the package moves.
  // Set both from the installed packages so `npm start` needs no environment.
  const ogreNext = pkgDir('@yabgu_gm/tension-ogre-next');
  if (existsSync(ogreNext)) {
    process.env.TENSION_OGRE_PLUGIN_DIR ??= join(ogreNext, 'lib', 'OGRE-Next');
    process.env.TENSION_OGRE_MEDIA_DIR ??= join(ogreNext, 'Media');
  }
  // The adapter's own DT_RPATH covers its direct dependencies, but not theirs:
  // the packaged Ogre libraries carry a DT_RUNPATH baked at build time that
  // points into this repository's third_party/, and glibc stops honouring an
  // inherited DT_RPATH once it meets a DT_RUNPATH. Without patchelf there is no
  // way to rewrite that here, so the loader path is set explicitly — computed
  // from the installed packages, not from the repository layout.
  const libDirs = [
    pkgFile('@yabgu_gm/tension-ogre', 'lib'),
    pkgFile('@yabgu_gm/tension-ogre-next', 'lib'),
    pkgFile('@yabgu_gm/tension-freeimage', 'lib'),
  ].filter(existsSync);
  if (libDirs.length) {
    const existing = process.env.LD_LIBRARY_PATH;
    process.env.LD_LIBRARY_PATH =
      existing ? `${libDirs.join(delimiter)}${delimiter}${existing}` : libDirs.join(delimiter);
  }
  if (cfg.extraCapability) {
    extraCapability = resolve(exampleDir, cfg.extraCapability);
    if (!existsSync(extraCapability)) {
      // run.sh builds a missing second capability on demand; do the same. The
      // repo's convention is <cap>/build.sh beside <cap>/build/lib*.so.
      console.log('building the extra capability...');
      bash(resolve(dirname(extraCapability), '..', 'build.sh'));
      if (!existsSync(extraCapability)) {
        die(`still no capability at ${extraCapability} after its build`);
      }
    }
  }
}

if (kind === 'ai') {
  fetchModel();
}

// ── build the guest ──────────────────────────────────────────────────────────
if (!skipBuild) {
  npm(['run', '--silent', 'build']);
}

// ── pack a volume, if this example has one ───────────────────────────────────
const packScript = join(exampleDir, 'pack.sh');
if (existsSync(packScript)) {
  bash(packScript);
}

// ── compose the host command line ────────────────────────────────────────────
const wasm = cfg.wasm ?? 'build/game.wasm';
const assets = join(exampleDir, 'build', 'assets.tns');
const args = [];

if (kind === 'res') {
  args.push('--res', join(exampleDir, 'game.tns'));
} else if (kind === 'ogre') {
  if (existsSync(assets)) {
    // The same volume, once for the adapter's loader (--tns) and once for
    // `tension::res` (--res); they are separate tables (see examples/ogre/run.sh).
    args.push('--res', assets);
  }
  args.push('--capability', adapter);
  if (extraCapability) args.push('--capability', extraCapability);
}

// Host options the example declares, before the guest path like every other
// host option (everything after the guest path is the guest's, which is why an
// example that wants `--log-level` cannot just put it in `args`).
for (const option of cfg.hostArgs ?? []) args.push(option);

args.push(join(exampleDir, wasm));

if (kind === 'ogre') {
  if (existsSync(assets)) args.push(`--tns=${assets}`);
  // The guests only distinguish gl3plus from null. A window is the default a
  // reader wants; there is no DISPLAY to consult on Windows, so opt out with
  // TENSION_OGRE_HEADLESS=1 (as on Unix with no display).
  const headless = process.env.TENSION_OGRE_HEADLESS === '1'
    || (!WIN && !process.env.DISPLAY && !process.env.WAYLAND_DISPLAY);
  args.push(`--renderer=${headless ? 'null' : 'gl3plus'}`);
}

if (kind === 'ai') {
  args.push(process.env.MODEL ?? cfg.model ?? 'models/Phi-3-mini-4k-instruct-q4.gguf');
}

args.push(...(cfg.args ?? []), ...guestArgs);

// ── run ──────────────────────────────────────────────────────────────────────
if (kind === 'collision') {
  renderCollision();
} else {
  const options = { cwd: exampleDir, stdio: 'inherit' };
  if (cfg.stdin !== undefined) {
    options.stdio = ['pipe', 'inherit', 'inherit'];
    options.input = cfg.stdin;
  }
  const result = spawnSync(host, args, options);
  if (result.error) die(`${host}: ${result.error.message}`);
  process.exit(result.status ?? 0);
}

/// The collision demo prints a CSV on stdout and a small gnuplot script turns
/// it into a GIF. Ported from solver/collision/run.sh so it works in cmd, where
/// `>`, `grep -c` and `$?` have no equivalent worth relying on.
function renderCollision() {
  const gnuplot = process.env.GNUPLOT ?? findTool('gnuplot');
  const probe = spawnSync(gnuplot, ['--version'], { encoding: 'utf8' });
  if (probe.error) {
    die(`gnuplot not found. Install it:\n` +
        `  Windows:  winget install gnuplot   (or https://gnuplot.sourceforge.net)\n` +
        `  Debian:   sudo apt install gnuplot\n` +
        `  macOS:    brew install gnuplot`);
  }

  const positions = join(exampleDir, 'positions.dat');
  const csv = capture(host, [join(exampleDir, wasm)]);
  writeFileSync(positions, csv);
  const frames = csv.split(/\r?\n/).filter((line) => line.length > 0 && !line.startsWith('#')).length;

  // `stats` counts the frames inside gnuplot; older gnuplot (<4.6) has no
  // `stats`, so the shell count is the retry (mirrors run.sh).
  let rendered = spawnSync(gnuplot, ['collision.gnuplot'], { cwd: exampleDir, stdio: 'inherit' });
  if (rendered.status !== 0) {
    console.error(`gnuplot could not count the frames itself; retrying with N=${frames}`);
    rendered = spawnSync(gnuplot, ['-e', `N=${frames}`, 'collision.gnuplot'],
                         { cwd: exampleDir, stdio: 'inherit' });
  }
  if (rendered.status !== 0) process.exit(rendered.status ?? 1);

  console.log(`wrote positions.dat (${frames} frames)`);
  console.log('wrote collision.gif');
}
