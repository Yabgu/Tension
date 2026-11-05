#!/usr/bin/env node
// `tension-core` as npm installs it: a shim that runs the platform's binary.
//
// npm's `bin` entries have to be a file that exists at install time, and the
// real host is `tension-core.exe` on Windows and `tension-core` everywhere
// else, in a platform payload package. Pointing `bin` at either spelling would
// be wrong on the other platform, and npm does not invent the extension. A JS
// entry is the same file on both, so the manifest stays platform-free and the
// choice of binary happens here.
//
// Arguments, stdio and the exit code pass straight through: this is a runner,
// not a wrapper with opinions.

import { spawnSync } from 'node:child_process';
import { existsSync } from 'node:fs';
import { dirname, join, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';

const here = dirname(fileURLToPath(import.meta.url));
const suffix = `${process.platform}-${process.arch}`;
const binary = process.platform === 'win32' ? 'tension-core.exe' : 'tension-core';

const candidates = [
  // Repository layout: packages/core/bin -> packages/core-win32-x64/bin
  resolve(here, '..', '..', `core-${suffix}`, 'bin', binary),
  // Published layout: node_modules/@yabgu_gm/tension-core/bin ->
  // node_modules/@yabgu_gm/tension-core-win32-x64/bin
  resolve(here, '..', '..', `tension-core-${suffix}`, 'bin', binary),
];

const host = candidates.find(existsSync);
if (!host) {
  console.error(`tension-core: no ${suffix} build found.`);
  console.error(`  looked for: ${candidates.join(', ')}`);
  console.error('  build it with: npm run build (at the repository root)');
  process.exit(1);
}

const result = spawnSync(host, process.argv.slice(2), {
  stdio: 'inherit',
  // Windows resolves the host's sibling DLLs from its own directory; on Unix
  // the adapter's RPATH covers it.
});

if (result.error) {
  console.error(`tension-core: ${result.error.message}`);
  process.exit(1);
}
if (result.signal) {
  process.kill(process.pid, result.signal);
}
process.exit(result.status ?? 1);
