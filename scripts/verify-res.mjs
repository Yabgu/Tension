#!/usr/bin/env node
// End-to-end verification of the resource stack.
//
//   1. pack assets/ + the generated large asset -> game.tns
//   2. re-read game.tns with the independent ECMA-208 reader
//   3. pack again and compare the two volumes byte for byte
//   4. run the game through tension-core and check its stdout
//
// Exit 0 only when every step passes.
//
// The reader is `examples/res/verify/verify.py` and stays Python on purpose: an
// independent implementation is the whole value of the check, and rewriting it
// in the same language as the packer would weaken it. This file is the driver —
// it finds a Python interpreter, runs the steps, and compares bytes.
//
// Usage: node scripts/verify-res.mjs

import { existsSync, readFileSync } from 'node:fs';
import { join } from 'node:path';
import { REPO, WIN, which } from './lib/toolchain.mjs';
import { fail, spawn } from './lib/proc.mjs';

const repo = REPO;
const example = join(repo, 'examples', 'res');
const RUNNER = 'verify-res';

const core = process.env.TENSION_CORE ??
  join(repo, 'tension-core', 'target', 'debug', `tension-core${WIN ? '.exe' : ''}`);

/// A Python 3 interpreter. `python3` is the POSIX name; Windows ships `python`,
/// and the Store alias named `python3` is a stub that prints an install prompt
/// and exits non-zero, so the version check is what decides.
function findPython() {
  for (const candidate of ['python3', 'python']) {
    const path = which(candidate);
    if (!path) continue;
    const version = spawn(path, ['--version']);
    if (version.status === 0 && /Python 3\./.test(version.stdout + version.stderr)) {
      return path;
    }
  }
  return null;
}

const python = findPython();
if (!python) {
  fail(RUNNER, 'no Python 3 found — the independent volume reader needs it\n' +
               '  (the packer is Zig; the verifier is deliberately a different implementation)');
}

function step(title) {
  console.log(`\n== ${title} ==`);
}

function die(message) {
  console.error(`${RUNNER}: ${message}`);
  process.exit(1);
}

// ── 1. pack ────────────────────────────────────────────────────────────────
step('1. pack assets/ + the generated large asset -> game.tns');
const packOnce = () => {
  const result = spawn(process.execPath, [join(repo, 'scripts', 'pack-example.mjs'), example],
                       { cwd: repo, maxBuffer: 64 * 1024 * 1024 });
  process.stdout.write(result.stdout);
  if (result.status !== 0) {
    process.stderr.write(result.stderr);
    die('packing failed');
  }
  return result.stdout;
};

// The generator reports both sizes; read them from its own output rather than
// repeating the constants here.
const packOutput = packOnce();
const largeBytes = /large\.bin \(([0-9]+) bytes/.exec(packOutput)?.[1];
const compressedBytes = /compressed\.bin \(([0-9]+) bytes/.exec(packOutput)?.[1];
if (!largeBytes) die('the packer did not report the generated large size');
if (!compressedBytes) die('the packer did not report the compressible size');

const volume = join(example, 'game.tns');

/// Read one file out of the volume with the independent reader, and return its
/// bytes. `--raw` keeps the payload free of the reader's own formatting.
function readWithVerifier(path) {
  const result = spawn(python, [join(example, 'verify', 'verify.py'), volume, path, '--raw'],
                       { cwd: example, maxBuffer: 64 * 1024 * 1024 });
  if (result.status !== 0) {
    die(`the independent reader failed on ${path}:\n${result.stderr.trim()}`);
  }
  return result.stdout;
}

/// Compare the reader's bytes with the file on disk.
function expectIdentical(path, sourceFile, what) {
  const got = readWithVerifier(path);
  const want = readFileSync(join(example, sourceFile)).toString('utf8');
  if (got !== want) {
    die(`${what}: the reader's bytes differ from ${sourceFile}`);
  }
  console.log(`${what}: byte-identical`);
}

// ── 2. the independent reader ──────────────────────────────────────────────
step('2. independent reader on game.tns');

// text/intro.txt is small and textual: print a few lines so a failure is
// readable rather than a byte count.
const intro = readWithVerifier('text/intro.txt').split('\n');
console.log('--- first three lines of text/intro.txt as the independent reader reads it ---');
console.log(intro.slice(0, 3).join('\n'));

expectIdentical('text/intro.txt', 'assets/text/intro.txt', 'text/intro.txt');
// data/level1.bin is 4096 bytes in a 2048-byte Buffer, so its payload spans
// Buffers: the reader walks the continuation chain and accumulates the bytes.
expectIdentical('data/level1.bin', 'assets/data/level1.bin',
                'chunked data/level1.bin (4096 B) read through its continuation chain');
// data/large.bin is the generated 20 MiB File: ~10600 chunks, read uncached
<<<<<<< HEAD
// (`tension-res/DESIGN.md` §8). The reader walks the whole chain.
=======
// (DESIGN.md §8.3). The reader walks the whole chain.
>>>>>>> origin/main
expectIdentical('data/large.bin', 'build/large.bin',
                `chunked data/large.bin (${largeBytes} B, stored) read through its continuation chain`);
// data/compressed.bin is stored as a Deflate stream (STREAM FORMAT 2, COMPRESS
// TYPE 8): the reader decodes it and its expanded bytes must match the source.
expectIdentical('data/compressed.bin', 'build/compressed.bin',
                `compressed data/compressed.bin (${compressedBytes} B expanded by the independent reader)`);

// ── 3. reproducibility ─────────────────────────────────────────────────────
step('3. reproducibility: pack again and compare');
const first = readFileSync(volume);
packOnce();
const second = readFileSync(volume);
if (!first.equals(second)) {
  die('packing twice produced different volumes — the packer is not reproducible');
}
console.log('two packs of the same tree are byte-identical');

// ── 4. the game itself ─────────────────────────────────────────────────────
step('4. run the game through tension-core');
const wasm = join(example, 'build', 'game.wasm');
if (!existsSync(wasm)) {
  die('build/game.wasm is missing; run `npm run build` first');
}

const game = spawn(core, ['--res', volume, wasm], { cwd: example, maxBuffer: 16 * 1024 * 1024 });
process.stdout.write(game.stdout);
if (game.stderr) process.stderr.write(game.stderr);
if (game.status !== 0) die(`the game exited ${game.status}`);

const out = game.stdout;
/// Every clause below is a claim about what the guest read back.
const must = [
  ['pak root: data/ text/ textures/', 'the pak root listing'],
  ['TensionCore resource demo', 'the demo banner'],
  ['read 16 header bytes, size 4096', 'the chunked read'],
  [`large.bin: size ${largeBytes} stored`, 'the large file size'],
  ['large.bin: cross-boundary window 1792..2304 pattern ok', 'the cross-boundary window'],
  [`large.bin: 16 bytes at ${Math.floor(Number(largeBytes) / 2)} pattern ok`, 'the mid-file read'],
  [`compressed.bin: size ${compressedBytes} compressed`, 'the compressed file size'],
  ['compressed.bin: first 16 bytes pattern ok', 'the compressed first read'],
  [`compressed.bin: 16 bytes at ${Math.floor(Number(compressedBytes) / 2)} read 16 pattern ok`,
   'the compressed mid-file read'],
];
for (const [needle, what] of must) {
  if (!out.includes(needle)) die(`the guest output has no ${what} ("${needle}")`);
}
if (!/large\.bin: bytes 2047\.\.2050 = [0-9]+ [0-9]+ [0-9]+ [0-9]+ pattern ok/.test(out)) {
  die('the guest did not verify bytes 2047..2050');
}
if (!/large\.bin: last byte [0-9]+ pattern ok/.test(out)) {
  die('the guest did not verify the large file\'s last byte');
}
if (!/compressed\.bin: last byte [0-9]+ read 1 pattern ok/.test(out)) {
  die('the guest did not verify the compressed file\'s last byte');
}
if (out.includes('MISMATCH')) die('the guest reported a pattern MISMATCH');

console.log('\nverify-res: all checks passed');
