#!/usr/bin/env node
// Build and run the ozz loading probe (chunk 19, 19f-b).
//
// No window and no renderer: the probe only reads bytes. The volume is passed on
// both flags on purpose — `--res` mounts it for the `tension::res` capability
// (which `resReadFile` reads), and `--tns=` is the guest's own argument, which it
// hands to `ogre.mountTns` (the OGRE capability's mount). The two capabilities
// keep separate mount tables, and the probe checks both.
//
// Usage: npm run test:ozz   (from the repository root)
//        npm run test:ozz   (from the example directory)

import { existsSync } from 'node:fs';
import { join } from 'node:path';
import { REPO, WIN, npmBin } from './lib/toolchain.mjs';
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

// The example's own dependencies.
const asc = npmBin(example, 'tensionscript');
if (!existsSync(asc)) {
  console.error(`${RUNNER}: installing the example's dependencies…`);
  if (inherit('npm', ['install', '--silent'], { cwd: example }).status !== 0) {
    fail(RUNNER, 'npm install failed');
  }
}

const compiled = spawn(asc, [join(example, 'ozz-load.ts'),
                             '--config', join(repo, 'tension-framework', 'build', 'session.asconfig.json'),
                             '-o', join(example, 'build', 'ozz-load.wasm')], { cwd: example });
if (compiled.status !== 0) {
  process.stderr.write(compiled.stdout + compiled.stderr);
  fail(RUNNER, 'ozz-load.ts did not compile');
}

// The volume the probe reads.
if (inherit(process.execPath, [join(repo, 'scripts', 'pack-example.mjs'), example]).status !== 0) {
  fail(RUNNER, 'packing the example volume failed');
}

const volume = join(example, 'build', 'assets.tns');
const result = spawn(core, [
  '--res', volume,
  '--capability', adapter,
  join(example, 'build', 'ozz-load.wasm'),
  `--tns=${volume}`,
  '--renderer=null',
], { cwd: example });

process.stdout.write(result.stdout);
if (result.stderr) process.stderr.write(result.stderr);
if (result.status !== 0) fail(RUNNER, `the probe exited ${result.status}`);
