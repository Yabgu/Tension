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
// **Windows links that runtime statically, and that is load-bearing.** A MinGW
// g++ default build of this DSO imports `libgcc_s_seh-1.dll`, `libstdc++-6.dll`
// and `libwinpthread-1.dll`. Unix finds those through the DSO's own DT_NEEDED /
// RPATH; Windows has no RPATH, so a dependency resolves only if it sits beside
// the *executable* or somewhere on PATH — and MSYS2's `ucrt64/bin` is on PATH
// only inside an MSYS2 shell. Loaded from cmd/PowerShell, which is where
// `npm start` runs, `LoadLibrary` fails with 126 (`ERROR_MOD_NOT_FOUND`), the
// host reports `could not load adapter`, and the capability looks unbuilt. A
// guest that imports `tension::input` cannot start at all. `-static` leaves the
// import list at KERNEL32 plus the UCRT api-sets, so the DSO needs nothing from
// the environment, at the cost of ~530 KB of runtime inside the DLL.
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
// -static (Windows only): fold libgcc, libstdc++ and libwinpthread into the DLL
// so loading it depends on no PATH entry — see the header. The guest reaches
// this DSO through the adapter's C ABI, so no C++ object crosses the boundary
// and there is no second runtime to keep in step with the host's.
const args = [
  '-std=c++17', '-O2', '-fPIC', '-Wall', '-Wextra',
  `-I${join(here, 'include')}`,
  `-I${join(repo, 'tension-core', 'include')}`,
  join(here, 'src', 'adapter.cpp'),
  join(here, 'src', 'input.cpp'),
  '-shared',
  ...(WIN ? ['-static'] : []),
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
