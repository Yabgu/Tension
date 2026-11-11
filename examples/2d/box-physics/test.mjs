#!/usr/bin/env node
// examples/2d/box-physics/test.mjs — run box-physics and assert the simulation results.
//
// Asserts:
//   1. tension-core exits 0.
//   2. SAT narrow-phase collision detection and polygon clipping resolved hundreds of contacts.
//   3. Angular dynamics: bodies rotated substantially under collision torques.
//   4. Numerical stability: no bodies escaped, exploded, or became NaN.
//   5. Visual rendering: screenshot contains non-black pixels from the arena and boxes.
//   6. The guest printed "OK: full 2d box physics simulation verified".

import { spawnSync } from 'node:child_process';
import { existsSync } from 'node:fs';
import { dirname, join, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';

const RUNNER = 'box-physics';

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

// ── 1. build guest ──────────────────────────────────────────────────────────
const guestBuild = run('node', [join(repo, 'scripts', 'build-2d-guest.mjs')], {
  stdio: 'inherit',
  cwd: here,
});
if (!guestBuild || guestBuild.status !== 0) die('the guest did not build');

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
const dso = join(repo, 'tension-2d', 'build', WIN ? 'libtension_2d.dll' : 'libtension_2d.so');
const capabilityArgs = existsSync(dso) ? ['--capability', dso] : [];

const result = run(core, [...capabilityArgs, join(here, 'build', 'game.wasm')], {
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

const contactsMatch = output.match(/resolved (\d+) contact pairs/);
if (!contactsMatch || Number(contactsMatch[1]) < 100) {
  die('insufficient collision contacts resolved');
}

const pixelsMatch = output.match(/screenshot -> \d+ bytes, (\d+) non-black pixels/);
if (!pixelsMatch || Number(pixelsMatch[1]) < 20000) {
  die('insufficient non-black pixels rendered');
}

const verdict = output.includes('OK: full 2d box physics simulation verified');
if (!verdict) {
  die('simulation assertion failed');
}

console.log(`${RUNNER}: PASS — full box physics and rotation simulation verified`);

// ── 4. windowed demonstration if requested ─────────────────────────────────
const show = process.argv.includes('--show') || process.argv.includes('--window') || process.argv.includes('--windowed');
if (show) {
  console.log(`${RUNNER}: opening interactive window...`);
  run(core, [...capabilityArgs, join(here, 'build', 'game.wasm'), '--windowed'], {
    stdio: 'inherit',
    cwd: here,
  });
}
