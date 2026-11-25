// Process and toolchain helpers shared by every build script.
//
// The build is plain Node on every platform: no `sh`, no `cmd.exe` batch file.
// What cannot be removed is the *toolchain* difference — Windows needs MSYS2's
// UCRT64 compilers and the MSVC environment, Linux has them on PATH. That
// difference is resolved here, once, so each build script asks for a tool by
// name and gets a usable one.
//
// ## Why the environment has to be assembled, not inherited
//
// On Windows, `npm run build` starts in a plain shell: no `vcvars64.bat` has
// run, so `link.exe` is absent and `cargo build` cannot link; and MSYS2's
// `gcc`/`gfortran`/`cmake`/`ninja`/`pkg-config` are not on PATH either. Both
// come from running their setup and importing the result, which is what
// `msvcEnvironment()` and `ucrt64Bin()` do below.
//
// ## Why each child gets its own directory first on PATH
//
// `tension-core/build.rs`'s `prefer_tool_own_dir` documents the failure this
// prevents: MSYS2's compilers exit silently when an earlier PATH entry shadows
// one of their own DLLs (a Visual Studio environment ahead of MSYS2 is the
// common arrangement). Prepending the chosen tool's directory on the *child's*
// PATH makes the tool resolve its own DLLs. That discipline is kept here —
// dropping it reintroduces an intermittent, output-less failure.

import { spawnSync } from 'node:child_process';
import { createHash } from 'node:crypto';
import { existsSync, mkdtempSync, readFileSync, readdirSync, realpathSync, rmSync, statSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { delimiter, dirname, join, relative, sep } from 'node:path';
import { fileURLToPath } from 'node:url';

// The provenance rule and its messages live in the published CLI package, so the
// rule has one implementation rather than one per consumer. See the header there.
import {
  COMPILER_PACKAGE as COMPILER,
  CompilerProvenanceError as ProvenanceError,
  assertVendoredCompiler as assertVendoredImpl,
  compilerFixCommands,
} from '../../packages/cli/src/compiler-provenance.js';

export const WIN = process.platform === 'win32';
export const EXE = WIN ? '.exe' : '';

/// The repository root. `scripts/lib/toolchain.mjs` -> two levels up.
export const REPO = fileURLToPath(new URL('../..', import.meta.url)).replace(/[\\/]$/, '');

/// Candidate MSYS2 roots, in preference order. UCRT64 is the toolchain the
/// Windows build is measured against (third_party/README.md, AGENTS.md).
const MSYS2_ROOTS = ['C:\\msys64', 'C:\\msys32', 'C:\\tools\\msys64'];
const MSYS2_BIN = {
  UCRT64: 'ucrt64',
  MINGW64: 'mingw64',
};

function isDirectory(path) {
  try {
    return statSync(path).isDirectory();
  } catch {
    return false;
  }
}

/// The newest installed Windows Vulkan SDK, or null.
///
/// One implementation for the three places that need it — OGRE's configure
/// (`bootstrap.mjs`), the adapter's configure (`build-native.mjs`) and the
/// standalone adapter script (`build-ogre.mjs`). They must agree about which SDK
/// is in play: OGRE compiles its render system against it and the adapter
/// compiles against the plugin headers, which `#include <vulkan/vulkan_core.h>`.
///
/// The LunarG installer sets `VULKAN_SDK` machine-wide, which a shell opened
/// *before* the install does not inherit — measured on the machine this was
/// written on: empty in the build shell, `C:\\VulkanSDK\\1.4.363.0` at machine
/// scope. So the env var wins when it is set, and the install layout is the
/// fallback rather than the other way round.
///
/// Returns a forward-slashed path, because it is handed to CMake cache
/// variables where a backslash is an escape.
///
/// `TENSION_VULKAN_SDK` names one explicitly, for an install somewhere else.
export function findVulkanSdk() {
  const root = 'C:\\VulkanSDK';
  const explicit = process.env.TENSION_VULKAN_SDK;
  if (explicit && existsSync(join(explicit, 'Include', 'vulkan', 'vulkan_core.h'))) {
    return explicit.split('\\').join('/');
  }
  if (process.env.VULKAN_SDK &&
      existsSync(join(process.env.VULKAN_SDK, 'Include', 'vulkan', 'vulkan_core.h'))) {
    return process.env.VULKAN_SDK.split('\\').join('/');
  }
  let versions = [];
  try {
    versions = readdirSync(root, { withFileTypes: true })
      .filter((entry) => entry.isDirectory())
      .map((entry) => entry.name)
      .sort((a, b) => {
        const pa = a.split('.').map(Number);
        const pb = b.split('.').map(Number);
        for (let i = 0; i < Math.max(pa.length, pb.length); ++i) {
          const delta = (pb[i] ?? 0) - (pa[i] ?? 0);
          if (delta !== 0) return delta;
        }
        return 0;
      });
  } catch {
    return null;
  }
  for (const version of versions) {
    const dir = join(root, version);
    if (existsSync(join(dir, 'Include', 'vulkan', 'vulkan_core.h'))) {
      return dir.split('\\').join('/');
    }
  }
  return null;
}

/// MSYS2's UCRT64 `bin` directory, or null when there is no MSYS2.
///
/// `TENSION_MSYS2` overrides the search — a machine that installed MSYS2
/// somewhere unusual should not have to move it.
export function ucrt64Bin() {
  const explicit = process.env.TENSION_MSYS2;
  const roots = explicit ? [explicit, ...MSYS2_ROOTS] : MSYS2_ROOTS;
  for (const root of roots) {
    for (const sub of Object.values(MSYS2_BIN)) {
      const bin = join(root, sub, 'bin');
      if (isDirectory(bin)) return bin;
    }
  }
  return null;
}

/// Candidate MSYS2 `usr/bin` directory, where POSIX utilities like patch live.
export function msys2UsrBin() {
  const explicit = process.env.TENSION_MSYS2;
  const roots = explicit ? [explicit, ...MSYS2_ROOTS] : MSYS2_ROOTS;
  for (const root of roots) {
    const bin = join(root, 'usr', 'bin');
    if (isDirectory(bin)) return bin;
  }
  return null;
}

/// The `set` output of a Visual Studio developer environment, as a map, or
/// null when there is no Visual Studio installation with the C++ tools.
///
/// `vswhere` finds the installation; `vcvars64.bat` computes the environment.
/// It is computed by a script, not stored anywhere readable, so the only
/// reliable way to get `link.exe`, `INCLUDE` and `LIB` into a Node child is to
/// run that script and import its output.
///
/// It runs through a temporary `.cmd` file rather than `cmd /s /c "..."`: the
/// inline form needs doubled quotes that cmd strips by rules that differ
/// between callers, and the measured failure is a bare "The network path was
/// not found" with no output at all. A file has one spelling and works.
function msvcEnvironment() {
  const vswhereCandidates = [
    join(process.env['ProgramFiles(x86)'] ?? 'C:\\Program Files (x86)',
         'Microsoft Visual Studio', 'Installer', 'vswhere.exe'),
    join(process.env.ProgramFiles ?? 'C:\\Program Files',
         'Microsoft Visual Studio', 'Installer', 'vswhere.exe'),
  ];
  const vswhere = vswhereCandidates.find(existsSync);
  if (!vswhere) return null;

  const found = spawnSync(vswhere, [
    '-latest', '-prerelease', '-products', '*',
    '-requires', 'Microsoft.VisualStudio.Component.VC.Tools.x86.x64',
    '-property', 'installationPath',
  ], { encoding: 'utf8', windowsHide: true });
  const install = (found.stdout ?? '').trim().split(/\r?\n/)[0];
  if (!install) return null;

  const vcvars = join(install, 'VC', 'Auxiliary', 'Build', 'vcvars64.bat');
  if (!existsSync(vcvars)) return null;

  const scratch = mkdtempSync(join(tmpdir(), 'tension-vcvars-'));
  const script = join(scratch, 'env.cmd');
  try {
    writeFileSync(script, `@echo off\r\ncall "${vcvars}" >nul\r\nset\r\n`, 'utf8');
    const captured = spawnSync('cmd.exe', ['/d', '/c', script], {
      encoding: 'utf8',
      windowsHide: true,
    });
    if (captured.status !== 0 || !captured.stdout) return null;

    const env = {};
    for (const line of captured.stdout.split(/\r?\n/)) {
      const eq = line.indexOf('=');
      if (eq <= 0) continue;
      const key = line.slice(0, eq);
      // `set` prints the name as stored, which is `path` or `Path` depending
      // on the host; Node's env object is case-sensitive, so pin the one name
      // that is merged rather than assigned.
      env[key.toLowerCase() === 'path' ? 'PATH' : key] = line.slice(eq + 1);
    }
    return env;
  } finally {
    rmSync(scratch, { recursive: true, force: true });
  }
}

let cachedBaseEnv = null;

/// Marker set on every environment this module assembles.
///
/// Without it the assembly is not idempotent, and that is not academic: a build
/// script that spawns another Node script (`test.mjs` -> `test-framework.mjs`)
/// re-runs `vcvars64.bat` and prepends its PATH again. Measured on this tree, two
/// levels of nesting produced a 9,898-character PATH — past `cmd.exe`'s
/// 8,191-character limit for a single variable. cmd truncates it silently, the
/// tail (where `C:\Program Files\nodejs` lives) is lost, and every npm `.cmd` shim
/// then fails with `'node' is not recognized`.
const MARKER = 'TENSION_TOOLCHAIN_ENV';

/// Split a PATH, drop empties, and keep the first occurrence of each directory.
/// Case-insensitive on Windows, where `C:\Foo` and `c:\foo` are one directory.
function dedupePath(value) {
  const seen = new Set();
  const keep = [];
  for (const entry of value.split(delimiter)) {
    const key = WIN ? entry.toLowerCase() : entry;
    if (!entry || seen.has(key)) continue;
    seen.add(key);
    keep.push(entry);
  }
  return keep;
}

/// The environment every child build process starts from.
///
/// On Windows this is the MSVC environment (so `cargo` can link) with MSYS2's
/// UCRT64 `bin` appended (so `gcc`, `gfortran`, `cmake`, `ninja` and
/// `pkg-config` resolve), plus the directory of any tool installed without a
/// PATH shim (WinGet's Zig).
///
/// MSVC first, then the inherited PATH, then UCRT64: MSVC must win for `link.exe`
/// and the C runtime, while UCRT64 supplies the GNU compilers cargo's build
/// script needs for the Fortran and C sources.
///
/// `DONT_SHOW_UI_ERRORS=1` is set for the same reason AGENTS.md requires it:
/// a crashing MSYS2 compiler raises a modal Windows Error Reporting dialog that
/// hangs a non-interactive build forever instead of failing it.
export function baseEnv() {
  if (cachedBaseEnv) return { ...cachedBaseEnv };

  const env = { ...process.env };
  if (!WIN) {
    cachedBaseEnv = env;
    return { ...env };
  }

  env.DONT_SHOW_UI_ERRORS ??= '1';
  env.MSYS = env.MSYS ?? 'winsymlinks:nativestrict';

  // Already assembled by an outer Tension process: take it as-is. Re-running
  // vcvars here would duplicate the Visual Studio paths, and PATH length is a
  // hard constraint, not a preference.
  if (env[MARKER] === '1') {
    env.PATH = dedupePath(env.PATH ?? '').join(delimiter);
    cachedBaseEnv = env;
    return { ...env };
  }

  const msvc = msvcEnvironment();
  if (msvc) {
    for (const [key, value] of Object.entries(msvc)) {
      // PATH is merged below, not assigned: `vcvars64.bat` runs in a fresh cmd
      // whose PATH is the machine's, so assigning it would drop the user's own
      // entries (`~/.cargo/bin`, a WinGet-installed Zig, this process's node).
      if (key !== 'PATH') env[key] = value;
    }
  }

  const parts = [];
  if (msvc?.PATH) parts.push(msvc.PATH);
  parts.push(env.PATH ?? '');
  const ucrt = ucrt64Bin();
  if (ucrt) parts.push(ucrt);
  const msysUsr = msys2UsrBin();
  if (msysUsr) parts.push(msysUsr);
  for (const name of ['zig', 'patch']) parts.push(...extraDirs(name));
  env.PATH = dedupePath(parts.filter(Boolean).join(delimiter)).join(delimiter);
  env[MARKER] = '1';

  cachedBaseEnv = env;
  return { ...env };
}

/// Whether a toolchain setup actually succeeded, for the preflight messages.
export function toolchainReport() {
  if (!WIN) return 'native';
  const msvc = msvcEnvironment();
  const ucrt = ucrt64Bin();
  return [
    msvc ? 'MSVC' : 'MSVC MISSING',
    ucrt ? `UCRT64 at ${ucrt}` : 'UCRT64 MISSING',
  ].join(', ');
}

/// A program installed by npm into a project's `node_modules/.bin`.
///
/// npm writes three files on Windows — `name`, `name.cmd`, `name.ps1` — and the
/// extensionless one is a POSIX shell script that Windows cannot execute. So the
/// suffix is npm's (`.cmd`), not the platform's executable suffix (`.exe`), which
/// does not exist there at all. Getting this wrong is an ENOENT on the one file
/// that looked right.
export function npmBin(dir, name) {
  return join(dir, 'node_modules', '.bin', WIN ? `${name}.cmd` : name);
}

// === The TensionScript compiler =============================================================
//
// **One resolver, and it fails closed.** The compiler is vendored once: the
// `third_party/TensionScript` submodule is packed by `scripts/vendor-compiler.mjs`
// into `.packs/`, and the root `package.json` declares that tarball, so
// `<repo>/node_modules/.bin/tensionscript` is the only copy the tree is allowed to
// run.
//
// Three ways of finding "a compiler" existed before this module owned the question,
// and all three were wrong in different ways: `build-framework` looked at its own
// `node_modules` first, `apps/docs/tools/run-examples.mjs` looked at two packages
// that no longer have it, and `build-2d-guest.mjs` ended with a bare
// `'tensionscript'` — a PATH lookup. Measured: this machine has a **global**
// `@yabgu_gm/tensionscript` 0.11.0 shimmed at `~/.local/bin/tensionscript`, and a
// bare lookup found it, so a tree with no root install compiled with a compiler
// four versions behind the pin and reported ten parse errors in the framework's
// own source. A missing compiler is a **setup step**, not a search problem: there
// is no PATH lookup here, no `npm ls -g`, and no per-package fallback.

// The package name comes from the shared module, so there is one spelling of
// `@yabgu_gm/tensionscript` in this tree.
export { COMPILER };

/**
 * How to launch a compiler *file*: `{ command, prefix, shell, path }`.
 *
 * `path` is the script the invocation runs, which is what the provenance check
 * needs; `command`/`prefix` are what a spawn needs.
 *
 * A `.js` path runs through this Node on **every** platform — no shebang, no shell,
 * no executable bit. That is the case that matters: it is the compiler's own `bin`
 * entry, and using it is what keeps the resolution the same on Windows and POSIX.
 * A `.cmd`/`.bat` path is only reachable on Windows and needs a shell there; npm's
 * shims are not executable images. Anything else is spawned directly.
 */
export function compilerInvocation(path, win = WIN) {
  const common = { path };
  // A batch file is not an executable image: Windows needs `cmd.exe` to run it,
  // and Node refuses to spawn one directly (`EINVAL`).
  if (win && /\.(cmd|bat)$/i.test(path)) return { ...common, command: path, prefix: [], shell: true };
  // **A `.js` path always runs through this Node.** Windows has no shebang
  // handling, so spawning one directly is `EFTYPE` — which is what made
  // `$TENSIONSCRIPT=…\dist\asc.js` fail as an "escape hatch". This branch is also
  // what the vendored pin takes on every platform.
  if (/\.(c|m)?js$/i.test(path)) {
    return { ...common, command: process.execPath, prefix: [path], shell: false };
  }
  // A bare command name on Windows can only be reached through `cmd.exe`, because
  // what it resolves to is a `.cmd` shim. On POSIX a bare name goes to `execvp`.
  if (win && !/[\\/]/.test(path) && !/\.[a-z0-9]+$/i.test(path)) {
    return { ...common, command: path, prefix: [], shell: true };
  }
  return { ...common, command: path, prefix: [], shell: false };
}

/**
 * Quote one argument for a shell command line.
 *
 * Only used on the shell path. `spawnSync(cmd, args, { shell: true })` concatenates
 * the arguments unescaped — Node emits `DEP0190` for exactly that reason, and it is
 * right to: an argument with a space in it silently becomes two, which for a path
 * like `C:\Program Files\…` is a wrong command rather than an error.
 */
export function shellQuote(arg, win = WIN) {
  const text = String(arg);
  if (win) {
    // Windows: everything inside double quotes is literal except `"` and `%`.
    // A `.cmd` invocation is the only caller, and its arguments are file paths and
    // flags — none contains `%` — so doubling `"` is the whole rule.
    return `"${text.replace(/"/g, '""')}"`;
  }
  return `'${text.replace(/'/g, `'\\''`)}'`;
}

/**
 * How to spawn an invocation with `args`: `{ command, args, shell }`.
 *
 * **The shell form is one string with no argument array.** Node's `DEP0190` says
 * passing an array with `shell: true` concatenates without escaping; composing the
 * line ourselves with {@link shellQuote} is the fix, not a silenced warning. On the
 * direct form the array is passed through untouched, which is what makes a path
 * with a space in it safe there.
 */
export function spawnForm(invocation, args = [], win = WIN) {
  if (!invocation.shell) {
    return { command: invocation.command, args: [...invocation.prefix, ...args], shell: false };
  }
  const line = [invocation.command, ...invocation.prefix, ...args]
    .map((arg) => shellQuote(arg, win)).join(' ');
  // `args: []`, not the array: an empty array does not trigger the deprecation, and
  // an absent one would make Node append `process.argv` on some call shapes.
  return { command: line, args: [], shell: true };
}

/**
 * The vendored compiler as an invocation, or `null` when it is not installed.
 *
 * **The package's own `bin` entry comes first, on both platforms.** `npm` resolves
 * a package's `bin` field into `node_modules/.bin/<name>`, and that shim is a
 * symlink on POSIX but **three real files on Windows** — where `realpath` of
 * `tensionscript.cmd` is `tensionscript.cmd`, so a "is the binary inside the
 * package" check can never pass and every guest build failed with
 * `resolves to … outside …`. Running `<pkg>/bin/tensionscript.js` through this Node
 * needs no shim at all, which removes the inconsistency rather than describing it:
 * the resolved file is inside the installed package on every platform.
 *
 * The `.bin` shim stays as a fallback for a package layout with no resolvable `bin`
 * field — a vendored copy, or a manager that links its own — and
 * `assertVendoredCompiler` follows it to the script it runs.
 *
 * Searches the repo root and any explicit `dirs` a caller passes — nothing else.
 * The old `tension-framework` fallback is gone: that copy no longer exists, and a
 * hint pointing at a directory nothing will ever populate is worse than none.
 */
export function locateCompiler(...dirs) {
  const name = WIN ? 'tensionscript.cmd' : 'tensionscript';
  const seen = new Set();
  for (const dir of [REPO, ...dirs]) {
    if (seen.has(dir)) continue;
    seen.add(dir);

    const pkgDir = join(dir, 'node_modules', ...COMPILER.split('/'));
    const manifestPath = join(pkgDir, 'package.json');
    if (existsSync(manifestPath)) {
      try {
        const field = JSON.parse(readFileSync(manifestPath, 'utf8')).bin;
        const entry = typeof field === 'string' ? field : field?.tensionscript;
        if (entry) {
          const js = join(pkgDir, entry);
          if (existsSync(js)) return compilerInvocation(js);
        }
      } catch {
        // an unreadable manifest falls through to the shim
      }
    }

    const shim = join(dir, 'node_modules', '.bin', name);
    if (existsSync(shim)) return compilerInvocation(shim);
  }
  return null;
}

/** Thrown by {@link requireCompiler} and {@link assertVendoredCompiler}. */
export class CompilerError extends Error {
  constructor(message) { super(message); this.name = 'CompilerError'; }
}

/**
 * The **fix** for a missing compiler, named as the two commands that produce it.
 * Two steps because they fail in different situations: a fresh clone has no tarball
 * (`compiler:vendor` packs the submodule), and a tree with a tarball that was never
 * installed needs `npm install`. Naming only one sends half the readers to the
 * wrong command, and a message that says "run npm install" over a missing tarball
 * fails with an ENOENT on a path they have never seen.
 */
const COMPILER_STEPS = compilerFixCommands(REPO);

/**
 * Assert that a compiler invocation (or path) is the compiler this tree vendored —
 * not merely that a compiler exists there.
 *
 * **The check lives in `packages/cli/src/compiler-provenance.js`, not here.** That
 * package is published and cannot import this file, so the dependency runs the
 * other way and there is exactly **one** implementation of the rule: the CLI
 * asserts it in-repo, and this module re-exports it. A second copy here would be a
 * second check to keep in step, and the one that is not updated is the weaker one.
 *
 * Returns `{ version, tarball, sha }`; throws {@link CompilerError}.
 */
export function assertVendoredCompiler(target) {
  try {
    return assertVendoredImpl(REPO, target);
  } catch (error) {
    if (error instanceof ProvenanceError) throw new CompilerError(error.message);
    throw error;
  }
}

/**
 * The compiler to run as an invocation, or a `CompilerError` naming both fixes.
 *
 * Throws rather than returning `null`: a `null` that reaches `spawn` is an ENOENT
 * three frames away from the cause, and that is the bug shape this replaces.
 */
export function requireCompiler(...dirs) {
  const invocation = locateCompiler(...dirs);
  if (!invocation) {
    throw new CompilerError([
      `no vendored TensionScript compiler at ${join(REPO, 'node_modules', '.bin', WIN ? 'tensionscript.cmd' : 'tensionscript')}`,
      ...COMPILER_STEPS,
    ].join('\n'));
  }
  const facts = assertVendoredCompiler(invocation);
  return { ...invocation, version: facts.version, tarball: facts.tarball };
}

/**
 * `$TENSIONSCRIPT`, the explicit escape hatch, or `null`.
 *
 * An override is for the one reader who is deliberately testing a compiler that is
 * not the pin. It cannot be silent: a machine that built with the wrong compiler
 * for a month is what an override that whispers produces. Provenance is not
 * asserted for it — the path is by definition outside the pin — so the line is the
 * only record, and it goes to stderr so it cannot be mistaken for build output.
 */
export function compilerOverride() {
  const path = process.env.TENSIONSCRIPT;
  if (!path) return null;
  process.stderr.write(`tensionscript: using $TENSIONSCRIPT=${path} — NOT the vendored pin\n`);
  return path;
}

/**
 * The compiler to run: `$TENSIONSCRIPT` when set, else the asserted vendored pin.
 *
 * **Every build and test entry point calls this**, not `requireCompiler`, so the
 * documented escape hatch works where it is documented. `version`/`tarball` are
 * `null` under an override, because nothing has been proven about it.
 */
export function resolveCompiler(...dirs) {
  const override = compilerOverride();
  if (override) return { ...compilerInvocation(override), version: null, tarball: null };
  return requireCompiler(...dirs);
}

/**
 * **Which compiler this tree will run**, as an identity a build record can carry.
 *
 * `{ hash, path }` — `hash` covers **every bundle a compile loads**; `path` names
 * the primary one. Both are `null` when no compiler is installed, which is a fact
 * a caller must handle rather than an empty string that compares equal to
 * something.
 *
 * # Why two bundles, and how that was established (DL43, I102)
 *
 * The identity used to be the sha256 of `dist/assemblyscript.js` alone, on the
 * reasoning that "that bundle **is** the compiler". It is not: measured, a compile
 * loads two modules, and the std that compiles a guest lives in the *other* one.
 *
 * - `bin/tensionscript.js` → `await import("../dist/asc.js")` — the CLI.
 * - `dist/asc.js` → `from "@yabgu_gm/tensionscript"` → the package's own
 *   `exports` map → `./dist/assemblyscript.js`.
 *
 * Proven by breaking each file and compiling: appending a `throw` to either one
 * fails the compile (exit 1), and the `asc.js` failure surfaces from
 * `assemblyscript.js`'s module body, which is what shows the second load. Proven
 * the other way too: `dist/asc.js` contains the embedded `libraryFiles` (the std)
 * and `dist/assemblyscript.js` contains none of it, so a `std/` edit moves the
 * *first* file and not the second — which is exactly the hole I102 found, where a
 * std change moved the sources' digest, rebuilt `dist/`, and left the identity
 * unchanged so every guest was skipped.
 *
 * So the digest is over **both files' bytes, concatenated in a fixed order**
 * (`COMPILER_BUNDLES`). That is the same primitive as before — sha256 of bytes —
 * with no structured form to agree about, and it moves when either loaded module
 * moves, which is the property the record needs.
 *
 * It is also the file `rebuild.mjs` compares on its `dist → installed` link, so a
 * guest's build record and the check that reads it compare **the same bytes**. One
 * definition, two callers — a second copy is how the two would drift, and a record
 * that disagrees with the check is worse than no record.
 *
 * The escape hatch is honoured: `$TENSIONSCRIPT` wins for the invocation, so its
 * neighbouring `dist/` is what gets hashed. A record of a build made with
 * something other than the vendored pin must say so, not claim the pin.
 */
export function compilerIdentity(...dirs) {
  let resolved;
  try {
    resolved = resolveCompiler(...dirs);
  } catch {
    return { hash: null, path: null };
  }
  // `<pkg>/bin/tensionscript.js` → `<pkg>/dist/<bundle>`. A resolved path with no
  // `dist/` beside it (a shim, or a hand-pointed file) falls back to itself: less
  // specific, still an identity, and `path` in the record says which.
  const distDir = join(dirname(resolved.path), '..', 'dist');
  const bundles = COMPILER_BUNDLES.map((name) => join(distDir, name)).filter((file) => existsSync(file));
  // The fallback is the resolved entry itself, so a layout with no `dist/` still
  // answers something that changes when the thing being run changes.
  const files = bundles.length > 0 ? bundles : [resolved.path];
  const file = files[0];
  // A build record is committed for a committed fixture, so the path it carries
  // must not be one machine's home directory: repo-relative when it is inside the
  // repo, absolute only when it genuinely is not (the escape hatch pointing
  // somewhere else). `rel` is what a record writes; `path` stays absolute for
  // callers that have to open it.
  const rel = relative(REPO, file);
  const path = rel.startsWith('..') ? file : rel.split('\\').join('/');
  try {
    const digest = compilerBundleDigest(distDir) ?? createHash('sha256').update(readFileSync(file)).digest('hex');
    return { hash: digest, path, absolute: file };
  } catch {
    return { hash: null, path, absolute: file };
  }
}

/**
 * The bundles a compile loads, in the order the digest hashes them.
 *
 * `asc.js` is the CLI entry `bin/tensionscript.js` imports and the file that
 * carries the embedded std; `assemblyscript.js` is the library it resolves through
 * the package's own `exports` map. Both are read on every compile (DL43 measured
 * each by breaking it), so both belong in the identity. Listed rather than globbed
 * so an unrelated file dropped into `dist/` cannot move the identity — an identity
 * that moves on everything identifies nothing.
 *
 * **Exported, and the only list of its kind**: `rebuild.mjs`'s `dist → installed`
 * row walks this same list, so the row cannot pass on a pair of bundles the
 * identity would call different.
 */
export const COMPILER_BUNDLES = ['asc.js', 'assemblyscript.js'];

/**
 * sha256 over the bundles a compile loads, in {@link COMPILER_BUNDLES} order.
 *
 * One primitive — hash these bytes — with no structured form to agree about, so
 * this is not a second canonical form beside `build-record.mjs`'s: it is the same
 * "sha256 of file bytes" applied to a short fixed list. Returns `null` when none of
 * the bundles is present, which is "no compiler here" rather than an empty digest.
 */
export function compilerBundleDigest(distDir) {
  const digest = createHash('sha256');
  let found = 0;
  for (const name of COMPILER_BUNDLES) {
    const file = join(distDir, name);
    if (!existsSync(file)) continue;
    digest.update(readFileSync(file));
    found += 1;
  }
  return found === 0 ? null : digest.digest('hex');
}

/**
 * The sidecar a guest artifact records its build in: `<artifact>.build.json`.
 *
 * Beside the artifact rather than in a manifest at the top, so a copy of one
 * artifact carries its own provenance, and so a stale entry cannot outlive the
 * file it describes. The schema:
 *
 * ```json
 * { "compiler": "<sha256>", "compilerPath": "<file>", "source": "<rel .ts>",
 *   "flags": ["--runtime", "incremental", …] }
 * ```
 *
 * Writer: `scripts/build-test-programs.mjs`. Reader: `rebuild.mjs`'s
 * `guests: built by the installed compiler` link. Both go through the functions
 * below so the format has one definition (I82).
 */
export function buildRecordPath(artifact) {
  return `${artifact}.build.json`;
}

/**
 * The record beside `artifact`, or `null` when there is none or it cannot be
 * read. **`null` is a fact** — "this artifact predates the record" — and the
 * check reports it in those words rather than treating it as a match.
 */
export function readBuildRecord(artifact) {
  const path = buildRecordPath(artifact);
  if (!existsSync(path)) return null;
  try {
    const record = JSON.parse(readFileSync(path, 'utf8'));
    return record !== null && typeof record === 'object' ? record : null;
  } catch {
    return null;
  }
}

/// Writes the record beside `artifact`.
export function writeBuildRecord(artifact, record) {
  writeFileSync(buildRecordPath(artifact), `${JSON.stringify(record, null, 2)}\n`);
}

/// Directories a tool may live in without being on PATH.
///
/// Zig is the measured case: `winget install zig` places it under
/// `%LOCALAPPDATA%\Microsoft\WinGet\Packages\zig.zig_*\zig-*\` with no shim
/// on PATH. That lookup lives here so the build
/// keeps working on a machine that installed it the documented way.
function extraDirs(name) {
  if (!WIN) return [];
  if (name === 'patch') {
    const dirs = [];
    const gitUsrBin = join(process.env.ProgramFiles ?? 'C:\\Program Files', 'Git', 'usr', 'bin');
    if (isDirectory(gitUsrBin)) dirs.push(gitUsrBin);
    const gitUsrBinX86 = join(process.env['ProgramFiles(x86)'] ?? 'C:\\Program Files (x86)', 'Git', 'usr', 'bin');
    if (isDirectory(gitUsrBinX86)) dirs.push(gitUsrBinX86);
    return dirs;
  }
  if (name !== 'zig') return [];
  const root = join(process.env.LOCALAPPDATA ?? '', 'Microsoft', 'WinGet', 'Packages');
  const dirs = [];
  let packages;
  try {
    packages = readdirSync(root, { withFileTypes: true });
  } catch {
    return dirs;
  }
  for (const entry of packages) {
    if (!entry.isDirectory() || !/^zig\.zig_/i.test(entry.name)) continue;
    let versions;
    try {
      versions = readdirSync(join(root, entry.name), { withFileTypes: true });
    } catch {
      continue;
    }
    for (const version of versions) {
      if (version.isDirectory() && /^zig-/i.test(version.name)) {
        dirs.push(join(root, entry.name, version.name));
      }
    }
  }
  return dirs;
}

/// Absolute path to `name`, resolved against the build environment's PATH and
/// the usual Windows tool locations. Returns null when it is absent.
export function which(name) {
  const file = name.endsWith(EXE) || !WIN ? name : `${name}${EXE}`;
  const path = baseEnv().PATH ?? process.env.PATH ?? '';
  for (const dir of path.split(delimiter)) {
    if (!dir) continue;
    const candidate = join(dir, file);
    if (existsSync(candidate)) return candidate;
  }
  for (const dir of extraDirs(name)) {
    const candidate = join(dir, file);
    if (existsSync(candidate)) return candidate;
  }
  return null;
}

/// Run a tool, inheriting stdio. Throws on a non-zero exit with the command in
/// the message, because every caller here treats failure as fatal and the
/// command is what a reader needs to reproduce it.
///
/// A bare name is resolved through `which()` first: `zig` installed by WinGet is
/// not on PATH, so spawning it by name would fail even though the toolchain
/// layer can find it.
export function run(command, args = [], options = {}) {
  const env = baseEnv();
  let executable = command;
  if (!command.includes('/') && !command.includes('\\')) {
    executable = which(command) ?? command;
  }
  // The tool's own directory first on the child's PATH: see the header.
  const dir = dirname(executable);
  if (dir && existsSync(dir)) {
    env.PATH = `${dir}${delimiter}${env.PATH ?? ''}`;
  }

  const result = spawnSync(executable, args, { stdio: 'inherit', env, ...options });
  if (result.error) {
    throw new Error(`${command}: ${result.error.message}`);
  }
  if (result.status !== 0) {
    const why = result.signal ? `signal ${result.signal}` : `exit ${result.status}`;
    throw new Error(`${command} ${args.join(' ')} failed (${why})`);
  }
  return result;
}

/// Run a tool and return its trimmed stdout. Throws on a non-zero exit, with
/// stderr in the message — the calls here are probes whose failure text is the
/// diagnosis.
export function capture(command, args = [], options = {}) {
  let executable = command;
  if (!command.includes('/') && !command.includes('\\')) {
    executable = which(command) ?? command;
  }
  const result = spawnSync(executable, args, {
    encoding: 'utf8',
    env: baseEnv(),
    // The default 1 MB buffer is not enough for `objdump -p` on a 10 MB DLL,
    // and the failure mode is an ENOBUFS throw that a caller's `catch` reads as
    // "this file has no imports". Size it for the largest artifact here.
    maxBuffer: 64 * 1024 * 1024,
    ...options,
  });
  if (result.error) throw new Error(`${command}: ${result.error.message}`);
  if (result.status !== 0) {
    throw new Error(`${command} ${args.join(' ')} failed (${result.status}): ` +
                    (result.stderr ?? '').trim());
  }
  return (result.stdout ?? '').trim();
}

/// `capture`, but null instead of a throw. For version probes whose absence is
/// a branch rather than a failure.
export function tryCapture(command, args = []) {
  try {
    return capture(command, args);
  } catch {
    return null;
  }
}

/// Fail the build with a message naming the missing piece and how to get it.
/// Every script uses this so a missing tool reads the same way everywhere.
export function die(message) {
  console.error(message);
  process.exit(1);
}

/// Require a tool, or stop with `hint` explaining how to provide it.
export function need(name, hint) {
  const found = which(name);
  if (!found) die(`${name} not found.${hint ? `\n  ${hint}` : ''}`);
  return found;
}
