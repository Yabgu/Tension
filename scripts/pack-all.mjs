#!/usr/bin/env node
// Pack the native packages into tarballs under packages/dist/.
//
// **Not part of `npm run build`.** The default flow has the examples consume
// the packages as directories through `file:` dependencies, which npm resolves
// as symlinks — no packing, no tarballs in the tree. This exists for the day
// they need to be published or handed to someone without the repository, and
// running it is a deliberate act (`npm run pack:all`), not a build step.
//
// Each tarball contains what its `package.json` `files` field lists, so a
// package that grows a directory without saying so will not silently ship it.
// `packages/dist/` is tracked (with a .gitkeep) so the output directory exists
// but the tarballs themselves are not.

import { spawnSync } from 'node:child_process';
import { existsSync, mkdirSync, readdirSync } from 'node:fs';
import { dirname, join, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';

const here = dirname(fileURLToPath(import.meta.url));
const repo = resolve(here, '..');
const packages = join(repo, 'packages');
const dist = join(packages, 'dist');

mkdirSync(dist, { recursive: true });

<<<<<<< HEAD
const order = ['ogre-next', 'ogre', 'core'];
=======
const order = ['ogre-next', 'freeimage', 'ogre', 'core'];
>>>>>>> origin/main
for (const name of order) {
  const dir = join(packages, name);
  if (!existsSync(join(dir, 'package.json'))) continue;
  // A package with an empty payload is a mistake worth naming here rather than
  // discovering it as a 2 KB tarball that installs nothing.
  const payload = JSON.parse(
    spawnSync('node', ['-p', `JSON.stringify(require(${JSON.stringify(join(dir, 'package.json'))}).files ?? [])`],
              { encoding: 'utf8' }).stdout || '[]');
  const empty = payload.filter((entry) => !existsSync(join(dir, entry)));
  if (empty.length) {
    console.error(`pack-all: ${name}: missing payload ${empty.join(', ')} — run npm run build:native first`);
    process.exit(1);
  }
  console.log(`==> packing @yabgu_gm/tension-${name}`);
  const packed = spawnSync('npm', ['pack', '--pack-destination', dist], { cwd: dir, stdio: 'inherit' });
  if (packed.status !== 0) {
    console.error(`pack-all: npm pack failed for ${name} (${packed.status})`);
    process.exit(1);
  }
}

const tarballs = readdirSync(dist).filter((f) => f.endsWith('.tgz'));
console.log(`\npack-all: ${tarballs.length} tarball(s) in packages/dist/`);
for (const tarball of tarballs.sort()) console.log(`  ${tarball}`);
