// Small, dependency-free helpers shared by every command.
//
// Two rules this file exists to keep:
//
//   1. **The CLI's own output goes to stderr.** `tension dev` hands its child
//      the real stdio so a game's `print` lands on the terminal unmodified. If
//      the CLI wrote its progress to stdout, a game's output and the tool's
//      output would interleave in one stream and neither would be parseable.
//      stdout belongs to the game; the tool talks on stderr.
//
//   2. **No dependency is added for something Node already does.** This package
//      runs before `npm install` has finished in the worst case, and it is the
//      thing that tells the user their install is wrong — it must not have its
//      own install to get wrong.

import { spawnSync } from 'node:child_process';
import { existsSync, readFileSync } from 'node:fs';
import { delimiter, join } from 'node:path';

/** Whether `path` exists. */
export function exists(path) {
  return existsSync(path);
}

/** Write a progress line. Returns nothing; the caller keeps its own wording. */
export function step(message) {
  process.stderr.write(`${message}\n`);
}

/** Write a warning. Prefixed so it is greppable in a long dev session. */
export function warn(message) {
  process.stderr.write(`tension: warning: ${message}\n`);
}

/**
 * Fail the command.
 *
 * `detail` is printed indented beneath the headline, one line per entry, and is
 * where the actionable part goes: the path that was looked for, the command
 * that fixes it. A message that only says what is wrong is a bug report; this
 * one is supposed to say what to do.
 */
export function die(message, detail = []) {
  process.stderr.write(`tension: ${message}\n`);
  for (const line of [].concat(detail)) {
    for (const part of String(line).split('\n')) process.stderr.write(`  ${part}\n`);
  }
  process.exit(1);
}

/** Parse a JSON file, naming the file and the position when it is malformed. */
export function readJson(path, what = 'JSON') {
  let text;
  try {
    text = readFileSync(path, 'utf8');
  } catch (error) {
    if (error.code === 'ENOENT') return null;
    die(`cannot read ${path}`, error.message);
  }
  try {
    return JSON.parse(text);
  } catch (error) {
    // V8's message already carries the offset ("at position 42"); it does not
    // carry a line, which is what a human wants. Compute it rather than making
    // the reader count.
    const at = /at position (\d+)/.exec(error.message);
    if (at) {
      const upto = text.slice(0, Number(at[1]));
      const line = upto.split('\n').length;
      const column = Number(at[1]) - upto.lastIndexOf('\n');
      die(`${path} is not valid ${what}`, `line ${line}, column ${column}: ${error.message}`);
    }
    die(`${path} is not valid ${what}`, error.message);
  }
}

/**
 * Run a program, inheriting stdio, and return its exit status.
 *
 * `shell` is opt-in and used for `npm` only: on Windows npm is a `.cmd` shim
 * that cannot be spawned without one.
 */
export function run(command, args, options = {}) {
  const result = spawnSync(command, args, { stdio: 'inherit', ...options });
  if (result.error) {
    die(`cannot run ${command}`, result.error.message);
  }
  return result.status ?? 1;
}

/** Run a program and capture stdout. Returns `{ status, stdout, stderr }`. */
export function capture(command, args, options = {}) {
  const result = spawnSync(command, args, { encoding: 'utf8', ...options });
  if (result.error) {
    return { status: null, stdout: '', stderr: result.error.message, error: result.error };
  }
  return { status: result.status, stdout: result.stdout ?? '', stderr: result.stderr ?? '' };
}

/** The executable suffix, and the reason every path helper here takes a name. */
export const EXE = process.platform === 'win32' ? '.exe' : '';

/** `platform-arch`, the suffix every payload package carries. */
export const SUFFIX = `${process.platform}-${process.arch}`;

/**
 * Locate a package's bin shim inside a project.
 *
 * npm writes `node_modules/.bin/<name>` as a symlink on Unix and a `.cmd` +
 * `.ps1` + shell script trio on Windows. Both are tried rather than guessed
 * from the platform, because a project can be installed by pnpm (which writes
 * its own shims) and because the fallback — running the package's JS entry with
 * `process.execPath` — needs neither.
 */
export function findBin(projectDir, name) {
  const bin = join(projectDir, 'node_modules', '.bin', name);
  // npm writes three shims for one bin on Windows: `<name>.cmd`, `<name>.ps1`,
  // and an **extensionless POSIX shell script**. All three exist, and the
  // extensionless one is not an executable image — `spawnSync` answers ENOENT
  // for it, which reads like "the package is not installed" and is not. So the
  // platform's own spelling is tried first; the POSIX shim stays as a fallback
  // for a project installed by pnpm, or copied from another OS than it runs on.
  const candidates = process.platform === 'win32'
    ? [`${bin}.cmd`, `${bin}.exe`, bin]
    : [bin, `${bin}.cmd`, `${bin}.exe`];
  for (const candidate of candidates) {
    if (exists(candidate)) return candidate;
  }
  return null;
}

/**
 * A program name as it must be spawned on this platform.
 *
 * Only `npm` needs this today; it is a function because the reason (a `.cmd`
 * shim cannot be spawned without a shell) applies to any npm-provided bin and
 * the next one should not have to rediscover it.
 */
export function npmCommand() {
  return process.platform === 'win32' ? 'npm.cmd' : 'npm';
}

/** Search PATH for an executable. Returns the absolute path or null. */
export function which(name) {
  for (const dir of (process.env.PATH ?? '').split(delimiter)) {
    if (!dir) continue;
    for (const candidate of [join(dir, name), join(dir, `${name}${EXE}`)]) {
      if (exists(candidate)) return candidate;
    }
  }
  return null;
}

/** Bytes as a short human string: `1.2 MB`, `840 KB`, `12 B`. */
export function bytes(n) {
  if (n < 1024) return `${n} B`;
  if (n < 1024 * 1024) return `${(n / 1024).toFixed(1)} KB`;
  return `${(n / (1024 * 1024)).toFixed(1)} MB`;
}

/** The current time, in the shape the build manifest records it. */
export function now() {
  return new Date().toISOString();
}
