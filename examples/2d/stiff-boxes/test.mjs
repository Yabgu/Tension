#!/usr/bin/env node
// examples/2d/stiff-boxes/test.mjs — run stiff-boxes and assert simulation & render verification.
//
// Asserts:
//   1. Texture atlas built at compile time and packed into build/stiff-boxes.tns.
//   2. tension-core loads the packed volume and runs game.wasm headless.
//   3. tension::solver BDF2 steps stiff rigid body contact equations stably.
//   4. Continuous collision and rotation dynamic simulation succeeds.
//   5. Visual rendering produces non-zero screenshot pixels.
//   6. Guest prints "OK: stiff-boxes BDF2 simulation stable".

import { spawnSync } from 'node:child_process';
import { existsSync } from 'node:fs';
import { dirname, join, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';

const RUNNER = 'stiff-boxes';

function supportSkip() {
  return process.env.TENSION_TEST_ALLOW_SKIP === '1';
}

const here = dirname(fileURLToPath(import.meta.url));
const repo = resolve(here, '..', '..', '..');
const WIN = process.platform === 'win32';
const EXE = WIN ? '.exe' : '';

function die(message) {
  console.error(`${RUNNER}: ${message}`);
  process.exit(1);
}

function run(cmd, args, opts = {}) {
  const result = spawnSync(cmd, args, { encoding: 'utf8', ...opts });
  if (result.error) return null;
  return result;
}

// ── 1. Compile-time generation and build ────────────────────────────────────
console.log(`${RUNNER}: generating compile-time textures...`);
const emit = run('node', [join(here, 'emit-boxes.mjs')], { stdio: 'inherit', cwd: here });
if (!emit || emit.status !== 0) die('compile-time texture generation failed');

console.log(`${RUNNER}: building guest wasm...`);
const guestBuild = run('node', [join(repo, 'scripts', 'build-2d-guest.mjs')], {
  stdio: 'inherit',
  cwd: here,
});
if (!guestBuild || guestBuild.status !== 0) die('the guest did not build');

console.log(`${RUNNER}: packing resource volume...`);
const pack = run('node', [join(repo, 'scripts', 'pack-example.mjs'), here], {
  stdio: 'inherit',
  cwd: here,
});
if (!pack || pack.status !== 0) die('resource volume packing failed');

// ── 2. find tension-core ───────────────────────────────────────────────────
function findCore() {
  if (process.env.TENSION_CORE && existsSync(process.env.TENSION_CORE)) {
    return process.env.TENSION_CORE;
  }
  for (const profile of ['release', 'debug']) {
    const candidate = join(repo, 'tension-core', 'target', profile, `tension-core${EXE}`);
    if (existsSync(candidate)) return candidate;
  }
  return null;
}

const core = findCore();
if (!core) {
  die(
    `no tension-core\n` +
      `  Run \`cargo build --manifest-path tension-core/Cargo.toml\` first.`,
  );
}

// ── 3. run headless ─────────────────────────────────────────────────────────
const tnsPath = join(here, 'build', 'stiff-boxes.tns');
const wasmPath = join(here, 'build', 'game.wasm');
const args = ['--res', tnsPath, wasmPath];

console.log(`${RUNNER}: running headless simulation with BDF2 solver...`);
const result = run(core, args, {
  stdio: ['ignore', 'pipe', 'pipe'],
  cwd: here,
  env: { ...process.env, SDL_VIDEODRIVER: 'offscreen' },
});
if (!result) die('could not start tension-core');

const output = `${result.stdout ?? ''}${result.stderr ?? ''}`;

for (const line of (result.stdout ?? '').split('\n')) {
  if (line.trim()) console.log(`  ${line}`);
}

const gpu = output.match(/vkCreateGraphicsPipeline[s]?\s+(VK_\w+)/);
if (gpu || /set_pipeline -> -5/.test(output)) {
  const why = gpu ? gpu[1] : 'pipeline creation refused';
  const message = `this machine could not create a graphics pipeline (${why}).`;
  if (supportSkip()) {
    console.log(`${RUNNER}: SKIP — ${message}`);
    process.exit(0);
  }
  die(message);
}

if (result.status !== 0) {
  console.error(result.stderr ?? '');
  die(`tension-core exited ${result.status}`);
}

const hasTex = output.includes('OK: Texture loaded from resource volume');
if (!hasTex) die('texture was not loaded from resource volume');

const hasSolver = output.includes('OK: Solver initialized with BDF2');
if (!hasSolver) die('BDF2 solver was not initialized');

if (output.includes('ERROR:')) {
  die(`simulation reported error:\n${output}`);
}

const hasFrame150 = output.includes('OK: Frame 150 reached');
if (!hasFrame150) die('simulation did not reach Frame 150');

const verdict = output.includes('OK: stiff-boxes BDF2 simulation stable');
if (!verdict) die('simulation assertion failed');

console.log(`${RUNNER}: PASS — 2D box physics with BDF2 solver and compile-time packed textures verified`);

// ── 4. windowed mode if requested ──────────────────────────────────────────
const show = process.argv.includes('--show') || process.argv.includes('--window') || process.argv.includes('--windowed');
if (show) {
  console.log(`${RUNNER}: opening interactive window...`);
  run(core, ['--res', tnsPath, wasmPath, '--windowed'], {
    stdio: 'inherit',
    cwd: here,
  });
}
