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
import { existsSync, mkdtempSync, readdirSync, rmSync, statSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { delimiter, dirname, join } from 'node:path';
import { fileURLToPath } from 'node:url';

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

<<<<<<< HEAD
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

=======
>>>>>>> origin/main
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
<<<<<<< HEAD
  const msysUsr = msys2UsrBin();
  if (msysUsr) parts.push(msysUsr);
  for (const name of ['zig', 'patch']) parts.push(...extraDirs(name));
=======
  for (const name of ['zig']) parts.push(...extraDirs(name));
>>>>>>> origin/main
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

/// Directories a tool may live in without being on PATH.
///
/// Zig is the measured case: `winget install zig` places it under
/// `%LOCALAPPDATA%\Microsoft\WinGet\Packages\zig.zig_*\zig-*\` with no shim
/// on PATH. That lookup lives here so the build
/// keeps working on a machine that installed it the documented way.
function extraDirs(name) {
<<<<<<< HEAD
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
=======
  if (!WIN || name !== 'zig') return [];
>>>>>>> origin/main
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
