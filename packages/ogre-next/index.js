// Ogre-Next's libraries, headers and Hlms media, resolved for this platform.
//
// The payload lives in `packages/ogre-next-<platform>-<arch>` (repository
// layout) or `node_modules/@yabgu_gm/tension-ogre-next-<platform>-<arch>`
// (published layout). See packages/ogre/index.js for why the resolver finds it
// by path locally instead of through npm's optional dependencies.

import { existsSync } from 'node:fs';
import { dirname, join, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';

const here = dirname(fileURLToPath(import.meta.url));
const suffix = `${process.platform}-${process.arch}`;

const candidates = [
  resolve(here, '..', `ogre-next-${suffix}`),
  resolve(here, '..', `tension-ogre-next-${suffix}`),
];

export const payloadDir = candidates.find(existsSync) ?? candidates[0];

/// Shared libraries and, on Windows, the import libraries.
export const libDir = join(payloadDir, 'lib');
/// Ogre's public headers, including the Hlms subdirectories.
export const includeDir = join(payloadDir, 'include');
/// The pruned Media tree: `Hlms/`, `Compute/`, `VCT/`, `particle/` and the cfgs.
export const mediaDir = join(payloadDir, 'Media');

/// Render-system plugins: `lib/OGRE-Next` on Unix, `bin/Release` on Windows.
export const pluginDir = existsSync(join(payloadDir, 'lib', 'OGRE-Next'))
  ? join(payloadDir, 'lib', 'OGRE-Next')
  : join(payloadDir, 'bin', 'Release');

export const available = existsSync(libDir) && existsSync(mediaDir);

export { suffix };
