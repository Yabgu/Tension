#!/usr/bin/env node
// scripts/parity-2d.mjs — build both 2D backends and compare them.
//
// Pass B moved the 2D renderer from C++ into core. This is the command that
// answers "did it move, or did it get rewritten?": the same guest through both
// binaries, compared on everything the guest prints.
//
//   cpp   `cargo build --no-default-features --features audio`  (the DSO path)
//   rust  `cargo build`                                         (in-core, default)
//
// Then `cargo test --test render2d_parity`, which does three things:
//
//   1. compiles preset 1 and the shipped graphs in-process and compares the
//      SPIR-V to the modules the C++ build produced, byte for byte;
//   2. rebuilds the sort key table from the graph and checks it against the
//      comparator's constant;
//   3. runs both binaries on hello-sprites and compares stdout line for line —
//      including the guest's own full-frame pixel count.
//
// Part 3 needs a working graphics pipeline. Where one cannot be created (a
// software Vulkan driver that fails `vkCreateGraphicsPipelines`), it says so and
// reports what both backends did instead; parts 1 and 2 run everywhere.
//
// The binaries are built here rather than inside the Rust test because
// `cargo test` holds `target/`'s lock, and a nested `cargo build` would wait on
// itself.

import { spawnSync } from 'node:child_process';
import { copyFileSync, existsSync } from 'node:fs';
import { dirname, join, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';

import { EXE } from './lib/toolchain.mjs';

const RUNNER = 'parity-2d';
const repo = resolve(dirname(fileURLToPath(import.meta.url)), '..');
const core = join(repo, 'tension-core');
const target = join(core, 'target', 'debug');

function die(message) {
  console.error(`${RUNNER}: ${message}`);
  process.exit(1);
}

function run(cmd, args, opts = {}) {
  console.log(`${RUNNER}: ${cmd} ${args.join(' ')}`);
  const result = spawnSync(cmd, args, { stdio: 'inherit', cwd: core, ...opts });
  if (result.error) die(`${cmd}: ${result.error.message}`);
  return result;
}

// The feature set `scripts/build-native.mjs` uses for the C++ path: `audio`
// only, so the comparison does not pull in the vendored llama.cpp build.
const COLD = ['--no-default-features', '--features', 'audio'];

const binary = join(target, `tension-core${EXE}`);
const cppBinary = join(target, `tension-core-cpp${EXE}`);

// ── 1. the C++-backend binary ────────────────────────────────────────────────
run('cargo', ['build', ...COLD]);
if (!existsSync(binary)) die(`no binary at ${binary}`);
copyFileSync(binary, cppBinary);
console.log(`${RUNNER}: ${cppBinary} (C++ backend: the tension-2d DSO)`);

// ── 2. the in-core binary ────────────────────────────────────────────────────
run('cargo', ['build']);
if (!existsSync(binary)) die(`no binary at ${binary}`);
console.log(`${RUNNER}: ${binary} (in-core: render2d-core)`);

// ── 3. the comparison ────────────────────────────────────────────────────────
const result = run('cargo', [
  'test',
  '--features', 'render2d-core',
  '--test', 'render2d_parity',
], {
  env: {
    ...process.env,
    TENSION_PARITY_CPP: cppBinary,
    TENSION_PARITY_RUST: binary,
  },
});

process.exit(result.status ?? 1);
