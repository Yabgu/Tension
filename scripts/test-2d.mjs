#!/usr/bin/env node
// scripts/test-2d.mjs — the 2D adapter's smoke test.
//
// Builds the DSO, builds a stub `tension-core` around tension-2d/tests/
// smoke_core.cpp, and runs it headless (`SDL_VIDEODRIVER=offscreen`).
//
// The stub core is the point: it dlopens the capability, provides guest memory
// and `register_import`, then drives the nine verbs *through the registered
// import table* — the same path the session uses. A test that called the shims
// directly would skip registration, signature checking and the `ret`-versus-
// status split, which is where the interesting bugs live.
//
// Exit codes: 0 pass, 1 fail, 77 skip (no GPU device on this machine).

import { spawnSync } from 'node:child_process';
import { mkdirSync, existsSync } from 'node:fs';
import { dirname, join, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';

const RUNNER = 'test-2d';
const here = resolve(dirname(fileURLToPath(import.meta.url)), '..');
const src = join(here, 'tension-2d');
const out = join(src, 'build');
const WIN = process.platform === 'win32';

function die(message) {
  console.error(`${RUNNER}: ${message}`);
  process.exit(1);
}

function run(cmd, args, opts = {}) {
  const result = spawnSync(cmd, args, { encoding: 'utf8', ...opts });
  if (result.error) return null;
  return result;
}

// ── 1. the capability ────────────────────────────────────────────────────────
const build = run('node', [join(here, 'scripts', 'build-2d.mjs')], { stdio: 'inherit' });
if (!build || build.status !== 0) die('building the DSO failed');

const dso = join(out, WIN ? 'libtension_2d.dll' : 'libtension_2d.so');
if (!existsSync(dso)) die(`expected ${dso} to exist after the build`);

// ── 2. the stub core ─────────────────────────────────────────────────────────
mkdirSync(out, { recursive: true });
const cxx = process.env.CXX ?? (WIN ? 'g++' : 'c++');
const harness = join(out, 'smoke_2d');
const compile = run(cxx, [
  '-std=c++17', '-O1', '-Wall', '-Wextra',
  `-I${join(src, 'include')}`,
  `-I${join(here, 'tension-core', 'include')}`,
  join(src, 'tests', 'smoke_core.cpp'),
  '-o', harness,
  ...(WIN ? [] : ['-ldl']),
]);
if (!compile || compile.status !== 0) {
  console.error(compile?.stdout ?? '', compile?.stderr ?? '');
  die('building the stub core failed');
}
console.log(`${RUNNER}: built ${harness}`);

// ── 3. run it headless ──────────────────────────────────────────────────────
// `offscreen`, not `dummy`: dummy has no GPU backend (DESIGN.md §9).
const result = run(harness, [dso], {
  stdio: 'inherit',
  env: { ...process.env, SDL_VIDEODRIVER: 'offscreen' },
});

if (result?.status === 77) {
  console.log(`${RUNNER}: SKIP — no GPU device on this host`);
  process.exit(0);
}
if (!result || result.status !== 0) {
  console.error(`${RUNNER}: FAIL (exit ${result?.status ?? 'spawn error'})`);
  process.exit(1);
}
console.log(`${RUNNER}: PASS`);
