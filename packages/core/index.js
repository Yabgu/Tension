// The interpreter's location, resolved for this platform.
//
// The binary lives in `packages/core-<platform>-<arch>/bin/` (repository
// layout) or `node_modules/@yabgu_gm/tension-core-<platform>-<arch>/bin/`
// (published layout). `bin/tension-core.js` runs it; this module exists for
// callers that need the path itself — the example runner and the test suites
// spawn the host directly so they can control stdio and the environment.

import { existsSync } from 'node:fs';
import { dirname, join, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';

const here = dirname(fileURLToPath(import.meta.url));
const suffix = `${process.platform}-${process.arch}`;
const name = process.platform === 'win32' ? 'tension-core.exe' : 'tension-core';

const candidates = [
  resolve(here, '..', `core-${suffix}`, 'bin', name),
  resolve(here, '..', `tension-core-${suffix}`, 'bin', name),
];

export const hostPath = candidates.find(existsSync) ?? candidates[0];
export const available = existsSync(hostPath);

export { suffix };
