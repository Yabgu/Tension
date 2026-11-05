#!/usr/bin/env node
// Pack a resource tree into a Tension volume with the Zig packer.
//
// `tension-res` builds `zig-out/bin/tension-pack`; this is the one entry point
// every caller uses (the fixtures' shared volume, each example's assets), so the
// packer's location and its `.exe` suffix live in one place.
//
// Usage: node scripts/pack-volume.mjs <input-dir> <output.tns>

import { existsSync, mkdirSync } from 'node:fs';
import { dirname, join, resolve } from 'node:path';
import { REPO, WIN, run } from './lib/toolchain.mjs';

const [input, output] = process.argv.slice(2);
if (!input || !output) {
  console.error('usage: node scripts/pack-volume.mjs <input-dir> <output.tns>');
  process.exit(2);
}

const packer = process.env.TENSION_PACK ??
  join(REPO, 'tension-res', 'zig-out', 'bin', `tension-pack${WIN ? '.exe' : ''}`);
if (!existsSync(packer)) {
  console.error(`pack-volume: no packer at ${packer}\n` +
                '  build it: npm run build:native (or npm run build:res)');
  process.exit(1);
}
if (!existsSync(input)) {
  console.error(`pack-volume: no input tree at ${input}`);
  process.exit(1);
}

mkdirSync(dirname(resolve(output)), { recursive: true });
run(packer, [resolve(input), '-o', resolve(output), '-v']);
