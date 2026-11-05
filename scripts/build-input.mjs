#!/usr/bin/env node
// tension-input build recipe — the input capability's DSO.
//
// Produces `<repo>/tension-input/build/libtension_input.{so,dll}`, the shared
// object tension-core dlopens for `--capability`.
//
// The capability's design is INPUT.md at the repo root; its wire is
// include/tension_input.h. It links SDL3 — and only SDL3: the host never names
// it, and this DSO is where the platform lives (INPUT.md §3 Q6).
//
// SDL3 comes from `pkg-config sdl3`. On Windows there is no pkg-config in a
// default MSYS2 UCRT64 install unless SDL3 is a package there, so the search also
// accepts the conventional `<prefix>/include/SDL3` and `-lSDL3` layout: this is
// the one capability with an external dependency, and failing to find it should
// name what to install rather than a pkg-config error.
//
// Environment:
//   CXX=<compiler>
//   TENSION_SDL3_PREFIX=<prefix>   an SDL3 install pkg-config does not know

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

// The capability's window-geometry probe is X11-specific: it `dlopen`s
// `libX11.so.6` and calls `XOpenDisplay`/`XGetGeometry` to size the surface SDL
// created (src/input.cpp:24-111). That is a real port to Windows (load
// `user32.dll` and use `GetClientRect`), not a build-system difference, so the
// build says so instead of failing on a missing `dlfcn.h`.
if (WIN) {
  die('this capability is POSIX/X11-only today: src/input.cpp loads libX11 to size\n' +
      '  the window SDL created, which has no Windows equivalent in the source yet.\n' +
      '  The rest of the tree builds and runs on Windows; only the input capability\n' +
      '  (and therefore examples/ogre/input-camera) does not.');
}

function pkgConfig(args) {
  const pkg = which('pkg-config');
  if (!pkg) return null;
  try {
    return spawnSync(pkg, args, { encoding: 'utf8', env: process.env });
  } catch {
    return null;
  }
}

/// Where SDL3 is, as `{ cflags, libs }`. `pkg-config` first; then an explicit
/// prefix; then the MSYS2 layout, which is where `pacman -S mingw-w64-ucrt-x86_64-sdl3`
/// puts it.
function findSdl3() {
  const probe = pkgConfig(['--exists', 'sdl3']);
  if (probe && probe.status === 0) {
    const cflags = pkgConfig(['--cflags', 'sdl3']);
    const libs = pkgConfig(['--libs', 'sdl3']);
    if (cflags?.status === 0 && libs?.status === 0) {
      const version = pkgConfig(['--modversion', 'sdl3']);
      console.log(`${RUNNER}: SDL3 ${version?.stdout.trim() ?? ''} via pkg-config`);
      return { cflags: cflags.stdout.trim().split(/\s+/).filter(Boolean),
               libs: libs.stdout.trim().split(/\s+/).filter(Boolean) };
    }
  }

  const prefixes = [
    process.env.TENSION_SDL3_PREFIX,
    ...(WIN ? ['C:/msys64/ucrt64'] : []),
    '/usr/local',
    '/usr',
  ].filter(Boolean);

  for (const prefix of prefixes) {
    const header = join(prefix, 'include', 'SDL3', 'SDL.h');
    if (!existsSync(header)) continue;
    console.log(`${RUNNER}: SDL3 at ${prefix} (headers, no pkg-config)`);
    return {
      cflags: [`-I${join(prefix, 'include')}`],
      libs: [`-L${join(prefix, 'lib')}`, '-lSDL3'],
    };
  }
  return null;
}

const sdl = findSdl3();
if (!sdl) {
  die('SDL3 not found.\n' +
      '  Install it (Arch: pacman -S sdl3 · Debian: apt install libsdl3-dev ·\n' +
      '  MSYS2: pacman -S mingw-w64-ucrt-x86_64-sdl3), or set TENSION_SDL3_PREFIX.');
}

const cxx = process.env.CXX ?? (WIN ? 'g++' : 'c++');
if (!which(cxx)) die(`${cxx} not found on PATH.`);

mkdirSync(out, { recursive: true });

// -std=c++17: the adapter uses <thread>, <condition_variable> and the standard
//   library's types, like tension-ogre's.
// -fPIC: the object is dlopen'd, not linked into a PIE.
// -Wall -Wextra: warnings are the point of a build recipe a reviewer reads.
// -lpthread is not optional: the SDL thread and its condvars need it.
const args = [
  '-std=c++17', '-O2', '-fPIC', '-Wall', '-Wextra',
  `-I${join(here, 'include')}`,
  `-I${join(repo, 'tension-core', 'include')}`,
  ...sdl.cflags,
  join(here, 'src', 'adapter.cpp'),
  join(here, 'src', 'input.cpp'),
  '-shared',
  '-o', join(out, WIN ? 'libtension_input.dll' : 'libtension_input.so'),
  ...sdl.libs,
  ...(WIN ? [] : ['-lpthread']),
];
run(cxx, args);

const artifact = join(out, WIN ? 'libtension_input.dll' : 'libtension_input.so');
console.log(`${RUNNER}: ${artifact}`);

// The DSO's own DT_NEEDED is worth printing: it is how a reader checks that the
// host is not the one naming SDL (INPUT.md §3 Q6). `objdump` is a Unix habit and
// is not in a default Windows PATH unless MSYS2 is, so this is best-effort.
const objdump = which('objdump');
if (objdump) {
  try {
    const listing = spawnSync(objdump, ['-p', artifact], { encoding: 'utf8' }).stdout ?? '';
    const needed = listing.split(/\r?\n/)
      .filter((line) => line.includes('DLL Name:') || line.includes('NEEDED'))
      .map((line) => `  ${line.trim().split(/\s+/).pop()}`);
    if (needed.length) console.log(`${RUNNER}: DT_NEEDED:\n${needed.join('\n')}`);
  } catch {
    // Diagnostics only.
  }
}

// Unused import guard: `readdirSync` is imported for symmetry with the other
// build scripts and may become useful; drop it if that stops being true.
void readdirSync;
