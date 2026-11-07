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

// ── 0. dependency pins ──────────────────────────────────────────────────────
// Two naga copies would mean two `Options` types and a graph that compiles
// with one and is compared against the other. Fail here rather than deep in a
// `cargo tree` error someone has to decode.
{
  const pin = run('node', [join(here, 'scripts', 'check-naga-pin.mjs')]);
  if (!pin || pin.status !== 0) {
    console.error(pin?.stdout ?? '', pin?.stderr ?? '');
    die('the naga pin check failed');
  }
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

// ── 2a. the dummy driver is refused by name ─────────────────────────────────
//
// `dummy` comes up as a video driver with no GPU backend, so the device creation
// fails with "No supported SDL_GPU backend found!" — which reads as "no GPU on
// this machine" when the answer is "no GPU through this driver". The adapter
// refuses it before the device is attempted, and says which driver to use.
//
// Run before the main scenario and on its own: the guard fires before any device
// exists, so this case works on a host whose real GPU path cannot run at all.
{
  const dummy = run(harness, [dso], {
    stdio: 'pipe',
    encoding: 'utf8',
    env: { ...process.env, SDL_VIDEODRIVER: 'dummy' },
  });
  if (!dummy || dummy.status !== 77) {
    console.error(dummy?.stdout ?? '', dummy?.stderr ?? '');
    die(`dummy: expected the harness to skip (77), got ${dummy ? dummy.status : 'spawn error'}`);
  }
  if (!/dummy/i.test(dummy.stderr) || !/offscreen/i.test(dummy.stderr)) {
    console.error(dummy.stderr);
    die('dummy: the refusal does not name the driver and the one that works');
  }
  // The harness writes the refused handle to stderr, beside the adapter's log.
  if (!/^open -> -19$/m.test(dummy.stderr)) {
    console.error(dummy.stderr);
    die(`dummy: expected 'open -> -19' (-ENODEV) on stderr`);
  }
  console.log(`${RUNNER}: dummy driver refused by name (-ENODEV, points at offscreen)`);
}

// ── 2b. the runtime-compiled graph ──────────────────────────────────────────
//
// A graph the build never saw: `default_2d` with the quad at 1.5x. Written
// here with the same `graph emit-scaled` the build uses, so the blob a guest
// would send and the blob this test sends come from one implementation.
const runtimeBlob = join(src, 'tests', 'default_2d_scaled_1_5.t2dg');
const coreBin = join(here, 'tension-core', 'target', 'debug', 'tension-core');
const emitScaled = run(coreBin, ['graph', 'emit-scaled', '--factor', '1.5', '--out', runtimeBlob]);
if (!emitScaled || emitScaled.status !== 0) {
  console.error(emitScaled?.stdout ?? '', emitScaled?.stderr ?? '');
  die('graph emit-scaled failed');
}
console.log(`${RUNNER}: ${emitScaled.stdout.trim()} -> ${runtimeBlob}`);

// ── 3. run it headless ──────────────────────────────────────────────────────
// `offscreen`, not `dummy`: dummy has no GPU backend (DESIGN.md §9).
const result = run(harness, [dso], {
  stdio: 'inherit',
  env: {
    ...process.env,
    SDL_VIDEODRIVER: 'offscreen',
    // The stub core's `compile_graph` double shells out to the real compiler.
    TENSION_CORE_BIN: coreBin,
  },
});

if (result?.status === 77) {
  console.log(`${RUNNER}: SKIP — no GPU device on this host`);
  process.exit(0);
}
if (result?.signal) {
  // Not a refusal and not a skip: the process died inside the driver. Named
  // separately from a failing exit so the next reader does not go looking for a
  // defect in the adapter. Measured on an NVIDIA host (`libnvidia-glcore`,
  // SDL_VIDEODRIVER=offscreen, the first `present`); the same build passes on a
  // conformant Vulkan ICD with lavapipe.
  console.error(`${RUNNER}: the harness died from ${result.signal} inside the GPU driver — ` +
                'this host cannot run the render scenarios');
  process.exit(1);
}
if (!result || result.status !== 0) {
  console.error(`${RUNNER}: FAIL (exit ${result?.status ?? 'spawn error'})`);
  process.exit(1);
}
console.log(`${RUNNER}: PASS`);
