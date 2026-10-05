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

function hostBinary() {
  if (process.env.TENSION_CORE) return process.env.TENSION_CORE;
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

const host = hostBinary();
if (!existsSync(host)) {
  die(`no interpreter at ${host}\n` +
      `  build it:  cargo build --manifest-path tension-core/Cargo.toml --no-default-features\n` +
      `  Windows:   build.bat`);
}

// ── the guest's build dependencies and its wasm ──────────────────────────────
const asc = join(exampleDir, 'node_modules', '.bin', WIN ? 'asc.cmd' : 'asc');
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
  adapter = process.env.TENSION_OGRE_DSO ?? join(repo, 'tension-ogre', 'build', 'libtension_ogre.so');
  if (!existsSync(adapter)) {
    die(`no OGRE adapter at ${adapter}\n` +
        `  Windows:  build.bat\n` +
        `  Unix:     tension-ogre/build.sh`);
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
