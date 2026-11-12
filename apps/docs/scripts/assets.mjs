#!/usr/bin/env node
// Bake the documentation viewer's type, then prove the three artifacts agree.
//
// ## Why this is the editor's script with a different name
//
// The two apps read the **same book**: `FontBook` indexes the pages the framework
// baked from `assets/fonts/fonts.json`, and the constants the guest compiles in
// (`assembly/ui/fonts.generated.ts`) describe those pages. An app that baked a
// *different* spec would be sampling cells from a grid the guest no longer has,
// which draws neighbouring glyphs and reads as "the font broke". So the spec and
// the faces come from the framework (`--spec`, `--faces`) and only the output
// directory is this app's.
//
// ## Why the old atlas has to be removed first
//
// `assets/` is gitignored, so a stale `ui.iwi` from the VGA bake survives a
// checkout and gets packed into the volume: 2.3 MB of app that nothing reads, and
// a second answer to "which atlas is this viewer using". It is removed here, at
// the top, and the manifest is deleted with it — the pages that replace it are
// named `ui.0.iwi` … and a leftover `ui.json` from the old bake is a manifest for
// an atlas that is gone.
//
// ## Why the guest's table is emitted into `src/`
//
// TensionScript cannot parse JSON (`apps/docs/src/format.ts` ships a small
// extractor for the bundle's header and says why a general parser is the wrong
// trade). The manifest is the human-readable contract and `verify-atlas.mjs`'s
// reference; `src/ui-fonts.generated.ts` is what a reader can diff against it.

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

// 1. The VGA single-atlas bake, and any previous page bake.
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

// 3. The check: pixels, manifest and constants, compared against each other.
run('verify', [
  join(FRAMEWORK, 'tools', 'font', 'verify-atlas.mjs'),
  '--manifest', 'assets/ui.json',
  '--ts', 'src/ui-fonts.generated.ts',
]);
