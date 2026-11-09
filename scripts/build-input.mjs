#!/usr/bin/env node
// tension-input build recipe — the input capability's DSO.
//
// Produces `<repo>/tension-input/build/libtension_input.{so,dll}`, the shared
// object tension-core dlopens for `--capability`.
//
// The capability's design is INPUT.md at the repo root; its wire is
// include/tension_input.h. **It links nothing but libstdc++.** Until v7 it linked
// SDL3, because the capability owned the platform (INPUT.md §3 Q6): its own
// thread, its own `SDL_Init`, its own window and poll loop. The host owns all of
// that now, and the capability is an event-layer subscriber, so the one external
// dependency is gone and the DT_NEEDED list below is the evidence.
//
// Environment:
//   CXX=<compiler>

import { spawnSync } from 'node:child_process';
import { existsSync, mkdirSync } from 'node:fs';
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

// The source is portable now — every SDL call, the X11 `dlopen` probe and the
// thread that used them are gone (v7b), so `src/` has nothing Windows-specific
// left in it and this gate is the *last* thing that would stop a Windows build.
//
// It stays until V7c, deliberately. The change that makes it true is "input is
// portable and needs no window of its own", and that disclosure belongs with the
// documents that explain it (INPUT.md, docs/modules/input.md, the X11-only note
// in the edge probe) rather than with the line of shell that happens to come
// first. Removing the gate here would ship a claim nobody has verified on
// Windows.
if (WIN) {
  die('this capability is gated to POSIX until V7c: the source is portable as of\n' +
      '  v7b (no SDL, no libX11, no thread), but the docs that say so and the\n' +
      '  Windows verification have not landed. The rest of the tree builds and runs\n' +
      '  on Windows.');
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
// host is the one naming SDL, and from v7b that this capability names it at all
// — it should not appear. `objdump` is best-effort.
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
