// The input capability's location, resolved for this platform.
//
// `packages/ogre/index.js` exists so a caller can find the OGRE adapter without
// knowing a `.so` from a `.dll`. This is the same resolver for
// `tension-input`, and it exists because the CLI's `resolveCapability` looks for
// `packages/input/index.js` before it falls back to a build path — a lookup that
// had nothing to find.
//
// **Where the payload lives.** Unlike OGRE, the input capability has no platform
// payload package: `scripts/build-input.mjs` writes
// `tension-input/build/libtension_input.{so,dll}` directly, and nothing copies it
// into `packages/`. So the repository layout is a single candidate, and the
// published layout is the payload package a release pass would create.
//
// SPDX-License-Identifier: MIT

import { existsSync } from 'node:fs';
import { dirname, join, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';

const here = dirname(fileURLToPath(import.meta.url));
const repo = resolve(here, '..', '..');
const suffix = `${process.platform}-${process.arch}`;

/** Windows keeps `.dll`; every other platform `.so`. */
export const dsoName = process.platform === 'win32'
  ? 'libtension_input.dll'
  : 'libtension_input.so';

const candidates = [
  // Repository layout: the capability's own build directory.
  join(repo, 'tension-input', 'build', dsoName),
  // Published layout: the per-platform payload beside this package.
  resolve(here, '..', `input-${suffix}`, 'lib', dsoName),
];

export const dsoPath = candidates.find(existsSync) ?? candidates[0];

/// True when the capability has been built for this platform.
export const available = existsSync(dsoPath);

/// The directory a loader should put on its search path, when one is needed.
export const payloadDir = dirname(dsoPath);

export { suffix, repo };
