#!/usr/bin/env node
// Bake the editor's type, then prove the three artifacts agree.
//
// ## Why this is a file and not a line in `package.json`
//
// Three things have to happen in order and all three can fail in ways that look
// like something else:
//
//   1. **Remove the previous bake.** The atlas used to be one file (`ui.iwi`,
//      the VGA table). A leftover of it is packed into the volume and never read,
//      which is 2.3 MB of app that does nothing — and worse, it makes "which atlas
//      is this app using" a question with two answers.
//   2. **Bake.** `bake-ttf.mjs` turns real outlines into `assets/ui.N.iwi`, the
//      `assets/ui.json` manifest and `src/ui-fonts.generated.ts`.
//   3. **Verify.** `verify-atlas.mjs` compares the three against each other. A
//      bake that regenerated two of three does not throw; it produces a guest that
//      samples cells from a grid it no longer has, which draws neighbouring glyphs
//      and reads as "the font broke".
//
// The spec is the **framework's**, not a copy: the framework bakes the default
// book that `FontBook` indexes, and an app that baked a *different* spec would be
// reading the framework's constants. `--faces` is what lets this app name that
// spec without copying 1.1 MB of typefaces into `apps/editor`.

import { rmSync } from 'node:fs';
import { dirname, join, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';
import { spawnSync } from 'node:child_process';

const HERE = dirname(fileURLToPath(import.meta.url));
const APP = resolve(HERE, '..');
const FRAMEWORK = resolve(APP, '..', '..', 'tension-framework');

function run(label, args) {
  const result = spawnSync(process.execPath, args, { cwd: APP, stdio: 'inherit' });
  if (result.status !== 0) {
    process.stderr.write(`assets: ${label} failed (${result.status})\n`);
    process.exit(result.status ?? 1);
  }
}

// 1. The old single-atlas bake, and any previous page bake. `assets/` is
//    gitignored, so this only ever removes a product.
for (const stale of ['ui.iwi', 'ui.preview.png', 'ui.json']) {
  rmSync(join(APP, 'assets', stale), { force: true });
}

// 2. The bake: one page per (family, size), the manifest, and the guest's table.
run('bake', [
  join(FRAMEWORK, 'tools', 'font', 'bake-ttf.mjs'),
  '--spec', join(FRAMEWORK, 'assets', 'fonts', 'fonts.json'),
  '--faces', FRAMEWORK,
  '--atlas', 'assets',
  '--manifest', 'assets/ui.json',
  '--ts', 'src/ui-fonts.generated.ts',
  '--preview', 'assets',
]);

// 3. The check.
run('verify', [
  join(FRAMEWORK, 'tools', 'font', 'verify-atlas.mjs'),
  '--manifest', 'assets/ui.json',
  '--ts', 'src/ui-fonts.generated.ts',
]);
