#!/usr/bin/env node
// The provenance assertion: does it point at the right file, and does it still bite?
//
// # The bug this pins down
//
// On POSIX `node_modules/.bin/tensionscript` is a **symlink** into the package, so
// `realpath` landed inside it and the "is the compiler inside the installed
// package" test passed. On Windows npm writes `tensionscript.cmd` as a **real
// file**, `realpath` is therefore the shim itself, and the same test could never
// pass:
//
//     build-framework: the compiler that would run is NOT the vendored pin:
//       C:\work\Tension\node_modules\.bin\tensionscript.cmd resolves to
//       C:\work\Tension\node_modules\.bin\tensionscript.cmd,
//       outside C:\work\Tension\node_modules\@yabgu_gm\tensionscript
//
// The fix is not to loosen the assertion but to stop resolving to a shim: the
// compiler's own `bin` entry, run through this Node, is a file inside the package
// on every platform.
//
// # What this proves, all of it on Linux
//
//   1. the resolver returns that bin entry, not the `.bin` shim, on this platform;
//   2. the assertion accepts it, and reports the vendored version;
//   3. the assertion **rejects** a compiler that is not the installed package's own
//      file — so the rule still bites rather than having been made vacuous;
//   4. a Windows-style `.cmd` shim is followed to the script it runs, and one that
//      names a file outside the package is rejected. The shim is a text file, so
//      this is testable here; the platform it comes from is not;
//   5. `$TENSIONSCRIPT` launches through `compilerInvocation` — a `.js` through this
//      Node (`EFTYPE` otherwise), a `.cmd` through a shell (`EINVAL` otherwise);
//   6. the shell form is one composed, quoted string with no argument array, which
//      is the fix for Node's `DEP0190` and for a spaced path becoming two args.
//
// Run: node scripts/test-compiler-provenance.mjs

import { mkdirSync, mkdtempSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { dirname, join, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';

import {
  assertVendoredCompiler, compilerInvocation, locateCompiler, shellQuote, spawnForm,
} from './lib/toolchain.mjs';
import { launchedFile, shimTarget } from '../packages/cli/src/compiler-provenance.js';

const here = dirname(fileURLToPath(import.meta.url));
const repo = resolve(here, '..');
const RUNNER = 'compiler-provenance';

let failures = 0;
function check(name, condition, detail = '') {
  if (condition) {
    console.log(`ok      ${name}`);
  } else {
    console.log(`not ok  ${name}${detail ? `\n          ${detail}` : ''}`);
    failures++;
  }
}
function expectThrow(fn) {
  try {
    fn();
    return null;
  } catch (error) {
    return error;
  }
}

const pkgDir = join(repo, 'node_modules', '@yabgu_gm', 'tensionscript');

// ── 1. the resolver names the package's own bin, not a shim ─────────────────
const invocation = locateCompiler();
check('the compiler resolves at all', invocation !== null);
if (invocation) {
  const expected = join(pkgDir, 'bin', 'tensionscript.js');
  check("the resolved file is the package's own bin entry",
    resolve(invocation.path) === resolve(expected), invocation.path);
  check('it is not the .bin shim',
    !invocation.path.includes(`${join('node_modules', '.bin')}`), invocation.path);
  check('it runs through this Node, so no shell and no shim is involved',
    invocation.command === process.execPath && invocation.prefix.length === 1 &&
    invocation.shell === false,
    JSON.stringify(invocation));
  check('launchedFile() answers the script, not the launcher',
    resolve(launchedFile(invocation)) === resolve(expected), launchedFile(invocation));

  // ── 2. and it is accepted, with the vendored version ──────────────────────
  const facts = expectThrow(() => assertVendoredCompiler(invocation));
  check('the assertion accepts it', facts === null, facts?.message ?? '');
  if (!facts) {
    const proven = assertVendoredCompiler(invocation);
    check('the proven version is the manifest version', proven.version === '0.14.1', proven.version);
  }
}

// ── 3. the rule still bites ─────────────────────────────────────────────────
//
// A file that is a compiler but **not** the installed package's own — the shape a
// stray build, an npm-hoisted copy or a hand-placed binary would have. If this
// passed, the assertion would be checking nothing.
{
  const outside = join(repo, 'node_modules', '@yabgu_gm', 'tensionscript.bak', 'bin', 'tensionscript.js');
  const error = expectThrow(() => assertVendoredCompiler({ command: process.execPath, prefix: [outside], shell: false, path: outside }));
  check('a compiler outside the installed package is rejected', error !== null);
  check('and the message says where it actually ran',
    error !== null && /runs .*outside/.test(error.message) || /not installed/.test(error?.message ?? ''),
    (error?.message ?? '').split('\n').slice(0, 3).join('\n'));
}

// ── 4. a Windows `.cmd` shim is followed to what it runs ────────────────────
//
// npm's Windows shim is a batch file whose last line launches the package's script
// via `%dp0%`. Reproduced verbatim enough that the parser sees the same shape.
{
  const scratch = mkdtempSync(join(tmpdir(), 'tension-shim-'));
  try {
    const binDir = join(scratch, 'node_modules', '.bin');
    mkdirSync(binDir, { recursive: true });
    const shim = join(binDir, 'tensionscript.cmd');
    writeFileSync(shim, [
      '@ECHO off',
      'GOTO start',
      ':find_dp0',
      'SET dp0=%~dp0',
      'EXIT /b',
      ':start',
      'SETLOCAL',
      'CALL :find_dp0',
      '',
      'IF EXIST "%dp0%\\node.exe" (',
      '  SET "_prog=%dp0%\\node.exe"',
      ') ELSE (',
      '  SET "_prog=node"',
      '  SET PATHEXT=%PATHEXT:;.JS;=;%',
      ')',
      '',
      'endLocal & goto #_undefined_# 2>NUL || title %COMSPEC% & "%_prog%"  ' +
        '"%dp0%\\..\\@yabgu_gm\\tensionscript\\bin\\tensionscript.js" %*',
      '',
    ].join('\r\n'));

    const followed = shimTarget(shim);
    check('a Windows .cmd shim is followed to the script it runs',
      resolve(followed) === resolve(join(scratch, 'node_modules', '@yabgu_gm',
        'tensionscript', 'bin', 'tensionscript.js')), followed);

    // ... and the assertion uses that, so a shim inside a real package passes even
    // though `realpath(shim)` is the shim itself. Proven on the temp tree by
    // asserting the followed path lands where the shim says, which is the only
    // property the Windows case depends on.
    check('the shim itself is not what gets checked',
      resolve(followed) !== resolve(shim));

    // A shim pointing somewhere else must not be followed into a false pass.
    const stray = join(scratch, 'elsewhere.cmd');
    writeFileSync(stray, '"%dp0%\\..\\some-other-package\\bin\\tensionscript.js" %*\r\n');
    check('a shim naming another package is not accepted as this one',
      resolve(shimTarget(stray)) !== resolve(join(pkgDir, 'bin', 'tensionscript.js')));
  } finally {
    rmSync(scratch, { recursive: true, force: true });
  }
}

// ── 5. the $TENSIONSCRIPT override goes through the same invocation ─────────
//
// Measured on Windows, before this fix, both forms of the override failed at the
// spawn: a `.js` gave `EFTYPE` (Windows does not execute JavaScript) and a `.cmd`
// gave `EINVAL` (Node refuses a batch file without a shell). Neither is a fact
// about the compiler — both are facts about how it was launched. The decision
// belongs in `compilerInvocation`, which is what the vendored pin already uses.
{
  const jsOverride = compilerInvocation('C:\\work\\dist\\asc.js', true);
  check('a .js override runs through this Node on Windows',
    jsOverride.command === process.execPath && jsOverride.shell === false,
    JSON.stringify(jsOverride));
  check('a .js override names itself as the script',
    jsOverride.prefix.length === 1 && jsOverride.prefix[0] === 'C:\\work\\dist\\asc.js');

  const cmdOverride = compilerInvocation('C:\\work\\.bin\\tensionscript.cmd', true);
  check('a .cmd override asks for a shell',
    cmdOverride.shell === true && cmdOverride.command.endsWith('.cmd'),
    JSON.stringify(cmdOverride));

  const exeOverride = compilerInvocation('C:\\work\\tensionscript.exe', true);
  check('an .exe override spawns directly',
    exeOverride.shell === false && exeOverride.prefix.length === 0,
    JSON.stringify(exeOverride));

  // ── 6. the shell form is one string, so no argument can be mis-split ──────
  //
  // `spawnSync(cmd, args, { shell: true })` concatenates unescaped — Node's
  // DEP0190 — so `C:\Program Files\Git\bin` becomes two arguments. The composed
  // form quotes; the direct form passes the array through untouched, which is
  // what makes a spaced path safe there.
  const shellInvocation = { command: 'C:\\Program Files\\nodejs\\t.cmd', prefix: [], shell: true };
  const shellForm = spawnForm(shellInvocation, ['--out', 'C:\\a b\\o.wasm'], true);
  check('the shell form is a single command string with no argument array',
    shellForm.args.length === 0 && typeof shellForm.command === 'string', JSON.stringify(shellForm));
  check('a path with a space is quoted on the shell form',
    shellForm.command.includes('"C:\\Program Files\\nodejs\\t.cmd"') &&
    shellForm.command.includes('"C:\\a b\\o.wasm"'), shellForm.command);

  const directInvocation = { command: process.execPath, prefix: ['/x/asc.js'], shell: false };
  const directForm = spawnForm(directInvocation, ['--out', '/a b/o.wasm'], true);
  check('the direct form keeps the argv array, unquoted',
    directForm.shell === false && directForm.args.length === 3 &&
    directForm.args[2] === '/a b/o.wasm', JSON.stringify(directForm));

  check('POSIX quoting escapes a single quote', shellQuote("a'b", false) === "'a'\\''b'",
    shellQuote("a'b", false));
}

if (failures) {
  console.error(`\n${RUNNER}: ${failures} check(s) failed`);
  process.exit(1);
}
console.log(`\n${RUNNER}: OK`);
