// FreeImage, resolved for this platform.
//
// Ogre decodes every texture through it, so it travels with the Ogre stack.
// The payload lives in `packages/freeimage-<platform>-<arch>` (repository
// layout) or `node_modules/@yabgu_gm/tension-freeimage-<platform>-<arch>`
// (published layout).

import { existsSync } from 'node:fs';
import { dirname, join, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';

const here = dirname(fileURLToPath(import.meta.url));
const suffix = `${process.platform}-${process.arch}`;

const candidates = [
  resolve(here, '..', `freeimage-${suffix}`),
  resolve(here, '..', `tension-freeimage-${suffix}`),
];

export const payloadDir = candidates.find(existsSync) ?? candidates[0];

export const libDir = join(payloadDir, 'lib');
export const includeDir = join(payloadDir, 'include');
/// Windows keeps the DLL here; on Unix it is beside the libraries.
export const binDir = join(payloadDir, 'bin');

export const available = existsSync(includeDir);

export { suffix };
