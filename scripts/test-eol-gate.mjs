#!/usr/bin/env node
// The line-ending gate's own gate.
//
// `normalize-eol.mjs --check` is the only thing standing between this repository
// and a CRLF file, and for as long as it existed it skipped a file it could not
// decode in silence: a non-UTF-8 source passed, because the script logged
// "skipped (not valid UTF-8)" and then only counted the files it had converted.
// A policy gate that passes by declining to look is worse than none, since it
// reports green.
//
// So this exercises the checker against a fixture tree with one file per rule,
// and asserts both directions:
//
//   * what must be refused (CRLF in a source file, a BOM, latin-1, UTF-16, a
//     bare CR) is refused, and named in the output;
//   * what must be allowed (a CRLF `.bat`) is allowed and left alone;
//   * what the fixer repairs (CRLF, BOM) is repaired, and what it must not
//     guess at (latin-1, UTF-16, bare CR) is left byte-identical.
//
// Usage: node scripts/test-eol-gate.mjs

import { mkdtempSync, readFileSync, rmSync, unlinkSync, writeFileSync } from 'node:fs';
import { spawnSync } from 'node:child_process';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { REPO } from './lib/toolchain.mjs';

const node = process.execPath;
const checker = join(REPO, 'scripts', 'normalize-eol.mjs');

let checks = 0;
let failures = 0;
const fail = (message) => {
  failures += 1;
  console.error(`not ok  ${message}`);
};
const ok = (message) => {
  checks += 1;
  console.log(`ok      ${message}`);
};
const expect = (condition, message) => (condition ? ok(message) : fail(message));

const dir = mkdtempSync(join(tmpdir(), 'eol-gate-'));

/// Latin-1 "café": 0xe9 is not a UTF-8 continuation-free sequence on its own.
const latin1 = Buffer.from([0x63, 0x61, 0x66, 0xe9, 0x0a]);
/// "const a = 1;\n" as UTF-16 LE, with its BOM.
const utf16le = Buffer.concat([
  Buffer.from([0xff, 0xfe]),
  Buffer.from('const a = 1;\n', 'utf16le'),
]);

const fixtures = {
  'clean.ts': 'const a = 1;\n',
  'crlf.ts': 'const a = 1;\r\nconst b = 2;\r\n',
  'bom.ts': '\ufeffconst a = 1;\n',
  'bare-cr.ts': 'const a = 1;\rconst b = 2;\n',
  'crlf.bat': '@echo off\r\necho hi\r\n',
  'crlf.cmd': '@echo off\r\n',
  'latin1.txt': latin1,
  'utf16.ts': utf16le,
};
for (const [name, content] of Object.entries(fixtures)) {
  writeFileSync(join(dir, name), content);
}

const run = (...args) =>
  spawnSync(node, [checker, ...args, dir], { encoding: 'utf8' });

const read = (name) => readFileSync(join(dir, name));

// ── 1. --check refuses every violation, and names it ────────────────────────
{
  const result = run('--check');
  expect(result.status === 1, '--check exits 1 on a dirty tree');
  for (const name of ['crlf.ts', 'bom.ts', 'bare-cr.ts', 'latin1.txt', 'utf16.ts']) {
    expect(result.stderr.includes(name), `--check names ${name}`);
  }
  expect(!result.stderr.includes('clean.ts'), '--check does not name a clean file');
  expect(!result.stderr.includes('crlf.bat'), '--check allows CRLF in a .bat');
  expect(!result.stderr.includes('crlf.cmd'), '--check allows CRLF in a .cmd');
  expect(
    result.stderr.includes('not valid UTF-8') && result.stderr.includes('person must fix'),
    '--check separates what a person must fix from what it can repair',
  );
}

// ── 2. the fixer repairs the repairable, and only those ─────────────────────
{
  const result = run();
  expect(result.status === 1, 'the fixer exits 1 while unfixable files remain');
  expect(read('crlf.ts').equals(Buffer.from('const a = 1;\nconst b = 2;\n')), 'CRLF source becomes LF');
  expect(read('bom.ts').equals(Buffer.from('const a = 1;\n')), 'the UTF-8 BOM is stripped');
  expect(read('crlf.bat').equals(Buffer.from(fixtures['crlf.bat'])), 'a .bat keeps its CRLF');
  expect(read('latin1.txt').equals(latin1), 'a latin-1 file is not rewritten');
  expect(read('utf16.ts').equals(utf16le), 'a UTF-16 file is not rewritten');
  expect(
    result.stderr.includes('utf16.ts') && result.stderr.includes('latin1.txt'),
    'the fixer names what it refused to guess at',
  );
}

// ── 3. with the unfixable files gone, the gate goes green ───────────────────
{
  for (const name of ['bare-cr.ts', 'latin1.txt', 'utf16.ts']) unlinkSync(join(dir, name));
  const result = run('--check');
  expect(result.status === 0, '--check exits 0 on a clean tree');
  expect(result.stdout.includes('all UTF-8 and LF'), 'the pass line states both conventions');
  expect(result.stdout.includes('batch file'), 'the pass line mentions the batch-file exception');
}

rmSync(dir, { recursive: true, force: true });

if (failures > 0) {
  console.error(`\neol-gate: ${failures} of ${checks + failures} check(s) failed`);
  process.exit(1);
}
console.log(`\neol-gate: ${checks} checks passed`);
