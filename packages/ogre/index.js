// The adapter's location, resolved for this platform.
//
// An example depends on `@yabgu_gm/tension-ogre` and never names a platform.
// The binaries live in a platform payload package — `packages/ogre-win32-x64`,
// `packages/ogre-linux-x64` — the shape a published install uses: one package
// per platform, selected by npm's `os`/`cpu` fields.
//
// Locally the payload is found by path rather than by npm, because a `file:`
// dependency is installed as a symlink and npm does not install the *linked*
// package's own dependencies. Following the symlink puts this module's real
// location at `packages/ogre/`, so its sibling payload is exactly where the
// build wrote it. A fresh clone therefore needs no install-time network or
// registry: `npm run build` writes the payload, and the resolver finds it.
//
// The published layout is the second candidate: npm extracts this package into
// `node_modules/@yabgu_gm/tension-ogre/`, whose sibling is
// `node_modules/@yabgu_gm/tension-ogre-<platform>-<arch>/`.

import { existsSync } from 'node:fs';
import { dirname, join, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';

const here = dirname(fileURLToPath(import.meta.url));
const suffix = `${process.platform}-${process.arch}`;

const candidates = [
  // Repository layout: `packages/ogre` -> `packages/ogre-win32-x64`.
  resolve(here, '..', `ogre-${suffix}`),
  // Published layout: `node_modules/@yabgu_gm/tension-ogre` ->
  // `node_modules/@yabgu_gm/tension-ogre-win32-x64`.
  resolve(here, '..', `tension-ogre-${suffix}`),
];

const payloadDir = candidates.find(existsSync) ?? candidates[0];

/// The library a `--capability` flag points at. Windows keeps `.dll`, every
/// other platform `.so`; `LoadLibrary` does not care about the extension, but
/// the path has to be right.
export const dsoName = process.platform === 'win32'
  ? 'libtension_ogre.dll'
  : 'libtension_ogre.so';

export const dsoPath = join(payloadDir, 'lib', dsoName);

/// True when `npm run build` has produced this platform's payload.
export const available = existsSync(dsoPath);

export { payloadDir, suffix };
