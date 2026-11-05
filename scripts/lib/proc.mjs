// Process helpers for the test runners.
//
// These differ from `toolchain.mjs` in one way that matters: a test case's
// non-zero exit is often the *expected* result (a guard that refuses, a drift
// check that aborts), so a runner needs the status and the streams rather than
// an exception. `spawn` here returns all three and never throws on a non-zero
// exit; the caller decides what a status means.

import { spawnSync } from 'node:child_process';
import { join } from 'node:path';
import { baseEnv, which } from './toolchain.mjs';

/// Quote one argument for `cmd.exe`.
///
/// Only used for npm's `.cmd` shims, which cannot be spawned directly. Node's
/// own `shell: true` would concatenate arguments without escaping (DEP0190), so
/// a path with a space in it would split; this quotes the ones that need it.
function cmdQuote(value) {
  if (value === '') return '""';
  return /[\s"&|<>^]/.test(value) ? `"${value.replace(/"/g, '""')}"` : value;
}

/// Run a program and capture everything.
///
/// `env` is layered over the build environment and may set a variable to
/// `undefined`, which removes it — that is how the `no-display` cases unset
/// `DISPLAY` and `WAYLAND_DISPLAY` without a shell's `env -u`.
export function spawn(command, args = [], options = {}) {
  const { env: extra, ...rest } = options;
  const env = baseEnv();
  if (extra) {
    for (const [key, value] of Object.entries(extra)) {
      if (value === undefined) delete env[key];
      else env[key] = value;
    }
  }

  let executable = command;
  if (!command.includes('/') && !command.includes('\\')) {
    executable = which(command) ?? command;
  }

  // npm's shims are `.cmd` files on Windows, and those only run through cmd.exe.
  const needsShell = process.platform === 'win32' && /\.cmd$/i.test(executable);
  const result = needsShell
    ? spawnSync('cmd.exe', ['/d', '/c', [executable, ...args].map(cmdQuote).join(' ')],
                { encoding: 'utf8', maxBuffer: 32 * 1024 * 1024, env, ...rest })
    : spawnSync(executable, args,
                { encoding: 'utf8', maxBuffer: 32 * 1024 * 1024, env, ...rest });

  return {
    status: result.status ?? (result.error ? 1 : 0),
    signal: result.signal ?? null,
    stdout: result.stdout ?? '',
    stderr: result.stderr ?? '',
    error: result.error ?? null,
  };
}

/// Run a program with its output going straight to this process's streams.
/// For build steps inside a test runner, where the reader wants the compiler's
/// own diagnostics rather than a summary of them.
export function inherit(command, args = [], options = {}) {
  const { env: extra, ...rest } = options;
  const env = baseEnv();
  if (extra) {
    for (const [key, value] of Object.entries(extra)) {
      if (value === undefined) delete env[key];
      else env[key] = value;
    }
  }
  let executable = command;
  if (!command.includes('/') && !command.includes('\\')) {
    executable = which(command) ?? command;
  }
  const needsShell = process.platform === 'win32' && /\.cmd$/i.test(executable);
  const result = needsShell
    ? spawnSync('cmd.exe', ['/d', '/c', [executable, ...args].map(cmdQuote).join(' ')],
                { stdio: 'inherit', env, ...rest })
    : spawnSync(executable, args, { stdio: 'inherit', env, ...rest });
  return {
    status: result.status ?? (result.error ? 1 : 0),
    signal: result.signal ?? null,
    error: result.error ?? null,
  };
}

/// The path of a repository-built executable, with the platform's suffix.
export function bin(repo, ...parts) {
  return join(repo, ...parts);
}

/// Print a block of text with a fixed indent — the runners echo a guest's
/// stdout before deciding whether it passed, and an unindented dump is hard to
/// tell from the runner's own lines.
export function indent(text, prefix = '    ') {
  return text
    .split(/\r?\n/)
    .filter((line, i, all) => !(i === all.length - 1 && line === ''))
    .map((line) => `${prefix}${line}`)
    .join('\n');
}

/// A failing assertion inside a runner: print why, exit 1.
export function fail(runner, message) {
  console.error(`${runner}: ${message}`);
  process.exit(1);
}

/// Skip with a reason — printed, never counted as a pass.
export function skip(runner, name, reason) {
  console.log(`== ${name}: SKIP — ${reason}`);
}
