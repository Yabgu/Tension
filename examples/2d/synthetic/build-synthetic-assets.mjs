#!/usr/bin/env node
// examples/2d/synthetic/build-synthetic-assets.mjs — draw the CI fixture.
//
// Writes three 1024x1024 RGBA PNGs under tension-2d/test-assets/synthetic/.
// They are generated, not committed: this script is the source, the PNGs are
// output.
//
// The pages exist so a human can *look* at what the synthetic scene binds — the
// guests never read them. `emit.mjs` rebuilds the same pixels from
// `pages.mjs` and writes the IWI the adapter decodes, so the PNG is a viewer
// convenience and nothing depends on it being current.
//
// Usage: node examples/2d/synthetic/build-synthetic-assets.mjs [--out <dir>]

import { mkdirSync, writeFileSync } from 'node:fs';
import { dirname, join, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';

import { scene, buildPages, PAGE, PAGE_COUNT } from './pages.mjs';
import { png } from './png.mjs';

const here = dirname(fileURLToPath(import.meta.url));
const repo = resolve(here, '..', '..', '..');

const argv = process.argv.slice(2);
let out = join(repo, 'tension-2d', 'test-assets', 'synthetic');
for (let i = 0; i < argv.length; i++) {
  if (argv[i] === '--out') out = resolve(argv[++i]);
}

const pages = buildPages();
mkdirSync(out, { recursive: true });

for (let i = 0; i < PAGE_COUNT; i++) {
  const path = join(out, `page${i}.png`);
  writeFileSync(path, png(PAGE, PAGE, pages[i]));
  console.log(`build-synthetic-assets: ${path} (${PAGE}x${PAGE})`);
}

// The numbers, beside the pixels, so the two can be compared without reading
// the module that produced them.
writeFileSync(join(out, 'scene.json'), JSON.stringify(scene(), null, 2));
console.log(`build-synthetic-assets: ${join(out, 'scene.json')}`);
