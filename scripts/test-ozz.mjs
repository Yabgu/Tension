#!/usr/bin/env node
// Build and run the ozz loading probe (chunk 19, 19f-b).
//
// No window and no renderer: the probe only reads bytes. The volume arrives as
// the guest's own `--tns=` argument, and the **guest** mounts it with
// `resMount` — the host's mount verb. One table serves `resReadFile` and the Ogre
// loader alike, so the probe no longer needs the volume handed over twice.
//
// Usage: npm run test:ozz   (from the repository root)
//        npm run test:ozz   (from the example directory)

import { existsSync } from 'node:fs';
import { join } from 'node:path';
import { REPO, WIN, CompilerError, resolveCompiler, spawnForm } from './lib/toolchain.mjs';
import { fail, inherit, spawn } from './lib/proc.mjs';

const repo = REPO;
const example = join(repo, 'examples', 'ogre', 'animated-character');
const RUNNER = 'test-ozz';

const core = process.env.TENSION_CORE ??
  join(repo, 'tension-core', 'target', 'debug', `tension-core${WIN ? '.exe' : ''}`);
const adapter = process.env.TENSION_OGRE_DSO ??
  join(repo, 'tension-ogre', 'build', WIN ? 'libtension_ogre.dll' : 'libtension_ogre.so');

if (!existsSync(core)) {
  fail(RUNNER, `no interpreter at ${core} — build it with:\n` +
               '  cargo build --manifest-path tension-core/Cargo.toml --no-default-features');
}
if (!existsSync(adapter)) {
  console.error(`${RUNNER}: building the OGRE adapter…`);
  if (inherit(process.execPath, [join(repo, 'scripts', 'build-ogre.mjs')]).status !== 0) {
    fail(RUNNER, 'the adapter did not build');
  }
}

const hash = spawn(core, ['layout-hash']).stdout.trim();
const generated = inherit(process.execPath,
                          [join(repo, 'scripts', 'gen-session.mjs'), '--hash', hash]);
if (generated.status !== 0) fail(RUNNER, 'the framework generator refused the layout hash');

// The compiler is the vendored one at the repo root; the example's own
// dependencies (tension-core, tension-framework) are still per-example, and a
// fresh tree has none of them — the guest below imports the framework, so that
// is the link to test. (This used to be tested by the example's own copy of the
// compiler, which no longer exists: one install point means one thing missing,
// not two.)
let asc;
try {
  asc = resolveCompiler(example);
} catch (error) {
  if (error instanceof CompilerError) fail(RUNNER, error.message);
  throw error;
}
if (!existsSync(join(example, 'node_modules', '@yabgu_gm', 'tension-core'))) {
  console.error(`${RUNNER}: installing the example's dependencies…`);
  if (inherit('npm', ['install', '--silent'], { cwd: example }).status !== 0) {
    fail(RUNNER, 'npm install failed');
  }
}

const form = spawnForm(asc, [join(example, 'ozz-load.ten'),
                             '--config', join(repo, 'tension-framework', 'build', 'session.asconfig.json'),
                             '-o', join(example, 'build', 'ozz-load.wasm')]);
const compiled = spawn(form.command, form.args, { cwd: example, shell: form.shell });
if (compiled.status !== 0) {
  process.stderr.write(compiled.stdout + compiled.stderr);
  fail(RUNNER, 'ozz-load.ten did not compile');
}

// The volume the probe reads.
if (inherit(process.execPath, [join(repo, 'scripts', 'pack-example.mjs'), example]).status !== 0) {
  fail(RUNNER, 'packing the example volume failed');
}

const volume = join(example, 'build', 'assets.tns');
const result = spawn(core, [
  // No `--res`: the guest mounts the volume itself (`resMount`), which registers
  // it in the host's one mount table — the table `resReadFile` and the Ogre
  // loader both read. Handing it over twice was the duplication this removed.
  '--capability', adapter,
  join(example, 'build', 'ozz-load.wasm'),
  `--tns=${volume}`,
  '--renderer=null',
], { cwd: example });

process.stdout.write(result.stdout);
if (result.stderr) process.stderr.write(result.stderr);
if (result.status !== 0) fail(RUNNER, `the probe exited ${result.status}`);
