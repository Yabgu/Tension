#!/usr/bin/env node
// tension-input build recipe — the input capability's DSO.
//
// Produces `<repo>/tension-input/build/libtension_input.{so,dll}`, the shared
// object tension-core dlopens for `--capability`.
//
// The design is INPUT.md at the repo root, the module page is
// docs/modules/input.md, and the wire is include/tension_input.h. **It links
// nothing but the C++ runtime.** Until v7 it linked SDL3, because the capability
// owned the platform: its own thread, its own `SDL_Init`, its own window and poll
// loop. The host owns all of that now and the capability is an event-layer
// subscriber, so the one external dependency is gone and the DT_NEEDED list below
// is the evidence.
//
// **No platform gate.** Nothing in src/ names a window system, so this recipe is
// the same everywhere the host builds — that is the portability claim v7 makes.
// Verified by compilation on Linux; a Windows build is a CI task, and
// `docs/known-limitations.md` records that nothing has *run* there.
//
// Environment:
//   CXX=<compiler>

import { spawnSync } from 'node:child_process';
import { mkdirSync } from 'node:fs';
import { join } from 'node:path';
import { REPO, WIN, run, which } from './lib/toolchain.mjs';

const repo = REPO;
const here = join(repo, 'tension-input');
const out = join(here, 'build');
const RUNNER = 'tension-input';

function die(message) {
  console.error(`${RUNNER}: ${message}`);
  process.exit(1);
}

const cxx = process.env.CXX ?? (WIN ? 'g++' : 'c++');
if (!which(cxx)) die(`${cxx} not found on PATH.`);

mkdirSync(out, { recursive: true });

// -std=c++17: <mutex>, <atomic> and the standard library's types.
// -fPIC: the object is dlopen'd, not linked into a PIE.
// -Wall -Wextra: warnings are the point of a build recipe a reviewer reads.
const args = [
  '-std=c++17', '-O2', '-fPIC', '-Wall', '-Wextra',
  `-I${join(here, 'include')}`,
  `-I${join(repo, 'tension-core', 'include')}`,
  join(here, 'src', 'adapter.cpp'),
  join(here, 'src', 'input.cpp'),
  '-shared',
  '-o', join(out, WIN ? 'libtension_input.dll' : 'libtension_input.so'),
];
run(cxx, args);

const artifact = join(out, WIN ? 'libtension_input.dll' : 'libtension_input.so');
console.log(`${RUNNER}: ${artifact}`);

// The DSO's own DT_NEEDED is worth printing: it is how a reader checks that the
// host is the one naming SDL and this capability names it nowhere. `objdump` is
// best-effort, and on a Windows host there is no DT_NEEDED to read at all.
const objdump = which('objdump');
if (objdump) {
  try {
    const listing = spawnSync(objdump, ['-p', artifact], { encoding: 'utf8' }).stdout ?? '';
    const needed = listing.split(/\r?\n/)
      .filter((line) => line.includes('DLL Name:') || line.includes('NEEDED'))
      .map((line) => `  ${line.trim().split(/\s+/).pop()}`);
    if (needed.length) console.log(`${RUNNER}: DT_NEEDED:\n${needed.join('\n')}`);
    if (needed.some((line) => /sdl/i.test(line))) {
      die('the DSO still links SDL; v7 removed every SDL call from this capability');
    }
  } catch {
    // Diagnostics only.
  }
}
