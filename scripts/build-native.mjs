#!/usr/bin/env node
// Populate the native packages under packages/ from this repository's build.
//
// One command, either platform. The artifacts this fills are platform-specific
// — `libtension_ogre.so` on Linux, `libtension_ogre.dll` on Windows, a `.exe`
// host — so they live in platform payload packages and the checked-in meta
// packages resolve them at run time:
//
//   packages/core             bin/tension-core.js  (spawns the payload binary)
//   packages/ogre             index.js             (exports the adapter's path)
//   packages/ogre-next        index.js             (exports lib/, include/, Media/)
//
//   packages/core-<platform>-<arch>/bin/tension-core[.exe]
//   packages/ogre-<platform>-<arch>/lib/libtension_ogre.{so,dll}
//   packages/ogre-next-<platform>-<arch>/{lib,include,Media}
//
// The payload packages carry `os`/`cpu` and are what `npm pack` would publish;
// the meta packages are what an example depends on, so a guest never names a
// platform. Locally only one platform is ever built, so the resolver finds the
// sibling payload directly (see packages/ogre/index.js).
//
// Everything below `packages/` that this writes is gitignored.
//
// Pruning is the one judgement here: Ogre's install is 170 MB and 144 MB of it
// is sample content (volumeTerrain, materials, models, packs, 2.0). Nothing in
// Tension reads those — measured: all 18 --ogre-guest cases pass and the
// animated-character example runs with only Hlms/, Compute/, VCT/, particle/
// and the cfgs. See packages/ogre-next/README.md.

import { spawnSync } from 'node:child_process';
import {
  cpSync, existsSync, lstatSync, mkdirSync, readdirSync, readFileSync, rmSync, writeFileSync,
} from 'node:fs';
import { basename, dirname, join, relative, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';
import { writeStamp } from './build-stamp.mjs';
import { ensureOgre } from './ensure-ogre.mjs';
import { EXE, WIN, capture, run, toolchainReport, tryCapture, ucrt64Bin, which } from './lib/toolchain.mjs';

const here = dirname(fileURLToPath(import.meta.url));
const repo = resolve(here, '..');
const packages = join(repo, 'packages');

export const SUFFIX = `${process.platform}-${process.arch}`;

const OGRE_SRC = join(repo, 'third_party', 'ogre-next-install');

/// Ogre's sample content. Removed from the package; see the README for the
/// measurement that says nothing reads them.
const OGRE_SAMPLE_ASSETS = ['volumeTerrain', 'materials', 'models', 'packs', '2.0'];

/// Media directories the Hlms and the adapter actually read.
const OGRE_MEDIA_KEEP = ['Hlms', 'Compute', 'VCT', 'particle'];

function fail(message) {
  console.error(`build-native: ${message}`);
  process.exit(1);
}

function note(message) {
  console.log(`build-native: ${message}`);
}

/// The pre-payload layout copied lib/, include/ and Media/ into the meta
/// packages themselves. `.gitignore` already calls anything left there a stale
/// local build that must not travel, but a leftover does real damage before it
/// is ever committed: the adapter's rpath used to spell the Ogre directory as
/// `../../ogre-next/lib`, which is where the stale copy sits, and glibc takes
/// the first rpath hit. The packaged adapter then loaded an Ogre-Next from
/// before FreeImage was removed and `npm start` died on `libfreeimage.so.3`,
/// while the build and both test suites stayed green. Deleting these makes the
/// platform payload the only copy in the tree.
const STALE_META_PAYLOADS = ['ogre/lib', 'ogre-next/lib', 'ogre-next/include', 'ogre-next/Media'];

function pruneStaleMetaPayloads() {
  for (const stale of STALE_META_PAYLOADS) {
    const dir = join(packages, stale);
    if (!existsSync(dir)) continue;
    rmSync(dir, { recursive: true, force: true });
    note(`pruned packages/${stale} (pre-payload build; the payload is authoritative)`);
  }
}

/// The platform payload directory for a component.
function payload(name) {
  return join(packages, `${name}-${SUFFIX}`);
}

/// Write the payload package's own manifest.
///
/// The payload directories are build products (gitignored), so their
/// package.json is written here rather than checked in. `os`/`cpu` are what an
/// npm registry uses to pick this package on the matching machine; the meta
/// package's resolver finds it locally without that filter, because only one
/// platform is ever built per checkout.
const COMPONENT_DESCRIPTIONS = {
  'ogre-next': 'Ogre-Next 3.0 runtime: shared libraries, headers and the Hlms shader media.',
  ogre: 'The OGRE capability adapter that tension-core dlopens for --capability.',
  core: 'The Tension interpreter: runs a guest wasm and loads capability adapters.',
};

function writePayloadManifest(destination, component, files, extra = {}) {
  const manifest = {
    name: `@yabgu_gm/tension-${component}-${SUFFIX}`,
    version: '0.1.0',
    private: true,
    description: `${COMPONENT_DESCRIPTIONS[component]} (${SUFFIX})`,
    os: [process.platform],
    cpu: [process.arch],
    files,
    ...extra,
  };
  mkdirSync(destination, { recursive: true });
  writeFileSync(join(destination, 'package.json'), `${JSON.stringify(manifest, null, 2)}\n`);
}

/// Copy a directory, **preserving symlinks**.
///
/// `dereference: true` is the trap here: a shared library ships as
/// `libFoo.so -> libFoo.so.4.0 -> libFoo.so.4.0.0` and dereferencing turns one
/// 9 MB file into three 9 MB files. First run of this script produced a 26 MB
/// package from an 8.7 MB install, and a 29 MB ogre-next lib/ from 15 MB, for
/// exactly that reason. The links are relative, so they stay valid inside the
/// package.
function copyTree(from, to) {
  rmSync(to, { recursive: true, force: true });
  mkdirSync(dirname(to), { recursive: true });
  cpSync(from, to, { recursive: true, dereference: false, verbatimSymlinks: true });
}

/// Size in bytes, recursively. Used for the budget report at the end.
///
/// `lstatSync`, not `statSync`: a shared library ships as a chain of relative
/// symlinks, and following them counts the same megabytes once per link. The
/// first version of this function reported one 8.7 MB install as 25.8 MB.
function du(target) {
  if (!existsSync(target)) return 0;
  const st = lstatSync(target);
  if (!st.isDirectory()) return st.size;
  let total = 0;
  for (const entry of readdirSync(target)) total += du(join(target, entry));
  return total;
}

function mb(bytes) {
  return `${(bytes / (1024 * 1024)).toFixed(1)} MB`;
}

/// The directory holding Ogre's Media tree: `share/OGRE-Next/Media` on Linux,
/// `Media` at the prefix root on Windows.
function ogreMediaDir(prefix) {
  const installed = join(prefix, 'share', 'OGRE-Next', 'Media');
  return existsSync(installed) ? installed : join(prefix, 'Media');
}

/// Where Ogre's `.cfg` files land: beside the media on Linux, with the DLLs on
/// Windows.
function ogreConfigDirs(prefix) {
  return [
    join(prefix, 'share', 'OGRE-Next'),
    join(prefix, 'bin', 'Release'),
    join(prefix, 'bin'),
  ].filter(existsSync);
}

// ── ogre-next ────────────────────────────────────────────────────────────────

function packageOgreNext() {
  ensureOgre({ note, fail });

  const destination = payload('ogre-next');
  rmSync(destination, { recursive: true, force: true });
  mkdirSync(destination, { recursive: true });

  note('ogre-next: copying lib/, include/, Media/ (sample assets pruned)');
  copyTree(join(OGRE_SRC, 'lib'), join(destination, 'lib'));
  copyTree(join(OGRE_SRC, 'include'), join(destination, 'include'));
  // Windows keeps the runtime DLLs and the cfg files in bin/. The adapter
  // copies them beside itself at build time, so they have to travel. The
  // command-line tools (`OgreMeshTool.exe`, `OgreCmgenToCubemap.exe`) do not:
  // nothing here runs them, and they are 700 KB of payload.
  if (WIN && existsSync(join(OGRE_SRC, 'bin'))) {
    const binDir = join(destination, 'bin');
    const source = join(OGRE_SRC, 'bin');
    const walk = (from, to) => {
      mkdirSync(to, { recursive: true });
      for (const entry of readdirSync(from, { withFileTypes: true })) {
        const src = join(from, entry.name);
        const dst = join(to, entry.name);
        if (entry.isDirectory()) {
          walk(src, dst);
        } else if (entry.name.endsWith('.dll') || entry.name.endsWith('.cfg')) {
          cpSync(src, dst);
        }
      }
    };
    walk(source, binDir);
  }

  const media = ogreMediaDir(OGRE_SRC);
  for (const name of OGRE_MEDIA_KEEP) {
    const from = join(media, name);
    if (existsSync(from)) copyTree(from, join(destination, 'Media', name));
  }
  // The cfgs name plugins and resource locations; Ogre reads them from beside
  // the media when a caller points at it.
  for (const dir of ogreConfigDirs(OGRE_SRC)) {
    for (const cfg of readdirSync(dir)) {
      if (cfg.endsWith('.cfg')) {
        cpSync(join(dir, cfg), join(destination, 'Media', cfg));
      }
    }
  }
  for (const name of OGRE_SAMPLE_ASSETS) {
    if (existsSync(join(destination, 'Media', name))) {
      fail(`sample asset "${name}" leaked into the package; pruning is broken`);
    }
  }
  writePayloadManifest(destination, 'ogre-next',
                       WIN ? ['lib/', 'include/', 'Media/', 'bin/'] : ['lib/', 'include/', 'Media/']);
  return destination;
}

// ── tension-res ──────────────────────────────────────────────────────────────

/// The Zig static archive both native artifacts link.
///
/// `tension-core/build.rs` builds it too, through `zig build`, but the adapter
/// needs it first — it links the archive directly and includes `tension_res.h` —
/// and building it twice is a cache hit, not a rebuild.
///
/// The `-Dtarget` is not cosmetic: an MSVC host cannot link a MinGW-ABI archive
/// (LNK1143), so when the Rust target is `windows-msvc`, Zig has to produce an
/// MSVC-compatible one. The host triple is read from `rustc -vV` rather than
/// assumed, because a machine can have both toolchains installed.
function buildRes() {
  const args = ['build', '-Doptimize=ReleaseSafe'];
  if (WIN) {
    const version = tryCapture('rustc', ['-vV']) ?? '';
    if (version.includes('windows-msvc')) {
      args.push('-Dtarget=x86_64-windows-msvc');
    }
  }
  note(`res: zig ${args.join(' ')}`);
  run('zig', args, { cwd: join(repo, 'tension-res') });

  const archive = join(repo, 'tension-res', 'zig-out', 'lib', 'libtension_res.a');
  if (!existsSync(archive)) {
    // Zig names the archive `tension_res.lib` for an MSVC target. The adapter's
    // CMake `find_library` searches both names, so a copy is all that is
    // missing.
    const msvcArchive = join(repo, 'tension-res', 'zig-out', 'lib', 'tension_res.lib');
    if (existsSync(msvcArchive)) {
      cpSync(msvcArchive, archive);
    } else {
      fail(`zig reported success but ${archive} is missing`);
    }
  }
}

/// Copy every non-system DLL the payload's DLLs depend on, transitively.
///
/// A Windows package is only usable if it carries its whole DLL closure: the
/// adapter is built by MSYS2's g++ against an Ogre built by the same toolchain,
/// and the resulting imports reach well past the obvious ones — `zlib1.dll`
/// and `libzzip.dll` come from OgreNextMain, the MinGW runtime from every
/// object compiled by g++. Missing one surfaces as `LoadLibrary failed with
/// error code 126`, which names no file at all, so the closure is computed here
/// rather than guessed at.
///
/// `objdump` lists the imports (binutils ships with the compiler this build
/// already requires). Anything not found in the payload or MSYS2's UCRT64 bin
/// is a Windows system DLL and stays out of the package.
function stageWindowsDependencies(libDir, extraSearch = []) {
  if (!WIN) return;
  const objdump = which('objdump');
  if (!objdump) {
    fail('objdump not found; it is needed to compute the DLL closure of the adapter');
  }
  const ucrt = ucrt64Bin();
  const search = [libDir, ...extraSearch, ...(ucrt ? [ucrt] : [])];
  const seen = new Set();
  const queue = readdirSync(libDir).filter((f) => f.toLowerCase().endsWith('.dll'));

  while (queue.length) {
    const dll = queue.shift();
    if (seen.has(dll.toLowerCase())) continue;
    seen.add(dll.toLowerCase());
    const path = join(libDir, dll);
    if (!existsSync(path)) continue;

    let listing;
    try {
      listing = capture(objdump, ['-p', path]);
    } catch (error) {
      // Never silent: the first version swallowed this, and an ENOBUFS read as
      // "this DLL imports nothing" — which is exactly how a missing dependency
      // becomes a LoadLibrary error 126 three steps later.
      fail(`could not read the imports of ${path}: ${error.message}`);
    }
    for (const line of listing.split(/\r?\n/)) {
      const match = /DLL Name:\s*(\S+)/.exec(line);
      if (!match) continue;
      const dep = match[1];
      if (seen.has(dep.toLowerCase())) continue;
      const source = search.map((dir) => join(dir, dep)).find(existsSync);
      if (!source) continue; // a Windows system DLL
      const target = join(libDir, dep);
      if (!existsSync(target)) cpSync(source, target);
      queue.push(dep);
    }
  }
}

// ── the adapter ──────────────────────────────────────────────────────────────

/// Build the adapter against the *package* rather than third_party/, so the
/// binary that ships is the binary that was tested.
///
/// CMake on both platforms: `tension-ogre/CMakeLists.txt` already carries the
/// Ogre discovery, the backend switch and the Windows DLL staging, and it is
/// the one recipe that has to work for both. The compiler choice on Windows is
/// forced by the Ogre build: a MinGW-style install ships `libOgreNextMain.dll.a`
/// import libraries, which MSVC's linker cannot use, so the adapter is built
/// with gcc/g++ against them. That mix (MinGW adapter, MSVC host) is what the
/// tree already does and what its DLL search-path handling expects.
function buildAdapter(ogreNextPayload) {
  const buildDir = join(repo, 'tension-ogre', 'build-cmake');

  // Where the Ogre-Next libraries sit relative to the packaged adapter. Both
  // directories carry the platform suffix, so this cannot be spelled in
  // CMakeLists.txt; computing it from the paths actually written here is the
  // only way it stays true when the layout changes. The published spelling is
  // added too because `npm pack` renames every package with the `tension-`
  // scope prefix, which shifts the sibling's directory name.
  const adapterLibDir = join(payload('ogre'), 'lib');
  const ogreNextLibDir = join(ogreNextPayload, 'lib');
  const rpathExtra = [
    relative(adapterLibDir, ogreNextLibDir).split('\\').join('/'),
    `../../tension-${basename(ogreNextPayload)}/lib`,
  ];

  const args = [
    '-S', join(repo, 'tension-ogre'),
    '-B', buildDir,
    '-G', 'Ninja',
    '-DCMAKE_BUILD_TYPE=Release',
    `-DOGRE_NEXT_PREFIX=${ogreNextPayload}`,
    `-DTENSION_RES_DIR=${join(repo, 'tension-res')}`,
    `-DTENSION_OGRE_RPATH_EXTRA=${rpathExtra.join(';')}`,
  ];

  if (WIN) {
    const mingwOgre = existsSync(join(ogreNextPayload, 'lib', 'libOgreNextMain.dll.a')) ||
                      existsSync(join(ogreNextPayload, 'lib', 'Release', 'libOgreNextMain.dll.a'));
    if (mingwOgre) {
      // `gcc`/`g++` here are MSYS2's UCRT64 compilers, which the toolchain
      // layer puts on PATH; the adapter must match the Ogre install's ABI.
      args.push('-DCMAKE_C_COMPILER=gcc', '-DCMAKE_CXX_COMPILER=g++');
    }
  }

  note(`ogre: configuring ${relative(repo, buildDir).split('\\').join('/')} against packages/ogre-next-${SUFFIX}`);
  run('cmake', args);
  run('cmake', ['--build', buildDir]);

  const built = process.platform === 'win32'
    ? join(repo, 'tension-ogre', 'build', 'libtension_ogre.dll')
    : join(repo, 'tension-ogre', 'build', 'libtension_ogre.so');
  if (!existsSync(built)) {
    fail(`cmake reported success but ${built} is missing`);
  }

  const destination = payload('ogre');
  for (const name of ['lib', 'bin']) {
    rmSync(join(destination, name), { recursive: true, force: true });
  }
  mkdirSync(join(destination, 'lib'), { recursive: true });
  cpSync(built, join(destination, 'lib', 'libtension_ogre' + (WIN ? '.dll' : '.so')));
  // The Ogre runtime DLLs staged beside the adapter by the post-build step:
  // the adapter imports them and the host loads it with an altered search
  // path, so the directory is self-contained.
  if (WIN) {
    for (const entry of readdirSync(join(repo, 'tension-ogre', 'build'))) {
      if (entry.endsWith('.dll') && entry !== 'libtension_ogre.dll') {
        cpSync(join(repo, 'tension-ogre', 'build', entry),
               join(destination, 'lib', entry));
      }
    }

    // The adapter's own DLLs plus Ogre's, which the closure walk resolves from
    // the Ogre payload and the payload's own lib/.
    const gxx = which('g++');
    stageWindowsDependencies(join(destination, 'lib'), [
      ...(gxx ? [dirname(gxx)] : []),
    ]);
  }
  auditLinkage(join(destination, 'lib'), ogreNextPayload, WIN ? null : built);
  writePayloadManifest(destination, 'ogre', ['lib/']);
  return destination;
}

/// Resolve the packaged adapter's dependencies the way a guest will, and refuse
/// to finish when the result is not the payload this build just wrote.
///
/// The build succeeding proves nothing about loading. `tension-ogre/build/`
/// reaches Ogre through the third_party rpath entry, so the C++ and Rust suites
/// load it fine even when the packaged copy resolves somewhere else entirely —
/// that is exactly how the packaged adapter spent this branch loading a
/// pre-FreeImage Ogre-Next out of a stale `packages/ogre-next/lib` while every
/// test passed and `npm start` failed. This is the check that would have said so.
///
/// `LD_LIBRARY_PATH` is dropped on purpose: it is the one thing that can hide a
/// wrong rpath on a developer machine, and a guest does not get the variable set.
function auditLinkage(adapterLibDir, ogreNextPayload, builtSo) {
  if (WIN) return;  // No rpath; the DLL closure is staged and walked instead.

  const so = join(adapterLibDir, 'libtension_ogre.so');
  const env = { ...process.env };
  delete env.LD_LIBRARY_PATH;

  let output;
  try {
    output = capture('ldd', [so], { env });
  } catch (error) {
    fail(`could not resolve the packaged adapter's dependencies: ${error.message}`);
  }

  const unresolved = [];
  for (const line of output.split('\n')) {
    const match = /^\s*(\S+)\s+=>\s+(.*)$/.exec(line);
    if (!match) continue;
    const [, name, where] = match;
    if (where.includes('not found')) {
      unresolved.push(name);
    } else if (/freeimage/i.test(line)) {
      // Not a version check but a provenance one: this tree builds Ogre-Next
      // with the codec off, so a FreeImage soname can only come from an Ogre
      // install built before that change.
      fail(`the packaged adapter resolves ${name} from ${where}\n` +
           '  This tree builds Ogre-Next without FreeImage, so that is a stale install.\n' +
           `  Expected to resolve against packages/ogre-next-${SUFFIX}/lib.`);
    } else if (/libOgreNext/.test(name)) {
      // Any Ogre-Next outside the payload is a stale copy winning the rpath
      // race, which is silent and produces exactly the failure above.
      if (!resolve(where).startsWith(resolve(ogreNextPayload)) &&
          !resolve(where).startsWith(resolve(join(repo, 'third_party')))) {
        fail(`the packaged adapter resolves ${name} from outside the payload\n` +
             `  got:      ${where}\n` +
             `  expected: under packages/ogre-next-${SUFFIX}/lib\n` +
             '  A stale Ogre-Next directory is shadowing the payload on the rpath.');
      }
    }
  }

  if (unresolved.length > 0) {
    fail(`the packaged adapter cannot load — unresolved: ${unresolved.join(', ')}\n` +
         `  ${relative(repo, builtSo).split('\\').join('/')} resolves fine through the\n` +
         '  third_party rpath entry, so the payload copy needs its own sibling directory.\n' +
         '  See TENSION_OGRE_RPATH_EXTRA in tension-ogre/CMakeLists.txt.');
  }

  note(`linkage: ${relative(repo, so).split('\\').join('/')} resolves entirely within the payload`);
}

// ── SDL generation guards ────────────────────────────────────────────────────
//
// This project is SDL3 and only SDL3. Two ways a second generation comes back,
// and neither is visible in a build log:
//
//   * a linker resolves libSDL2 from somewhere on the search path, and the
//     packaged adapter then holds two SDL instances — two event queues, and a
//     window neither one sees. That is a runtime puzzle, not a build error.
//
//   * someone reaches for Ogre's SDL2-era window params key. It is a stale
//     string literal from Ogre's own samples: it carries a plain
//     `{Display*, Window}` and links no SDL at all. It is legitimate inside
//     third_party/ogre-next, which is vendor code we do not edit. Anywhere in
//     our source it means someone bound the renderer to an X11 window and
//     re-pinned the app to XWayland — the opposite of "Wayland where available".

// Written as a concatenation on purpose: if this file contained the literal,
// the scan below would flag the guard itself and the build could never pass.
const SDL2_WINDOW_KEY = 'SDL2' + 'x11';

/// Source scan: the SDL2-era key must not appear in project source. Vendor code
/// under third_party/ is excluded — it is the origin of the literal, not a use.
function auditSdlSourceReferences() {
  const skipDirs = new Set(['node_modules', 'third_party', 'build', 'target', '.git', '.codewhale']);
  const sourceFile = /\.(mjs|js|ts|c|cc|cpp|cxx|h|hpp|rs|md)$/;
  const hits = [];

  const walk = (dir) => {
    for (const entry of readdirSync(dir, { withFileTypes: true })) {
      if (skipDirs.has(entry.name)) continue;
      const full = join(dir, entry.name);
      if (entry.isDirectory()) { walk(full); continue; }
      if (!sourceFile.test(entry.name)) continue;
      let text;
      try {
        text = readFileSync(full, 'utf8');
      } catch {
        continue;  // unreadable is not a violation
      }
      text.split('\n').forEach((line, index) => {
        if (line.includes(SDL2_WINDOW_KEY)) {
          hits.push(`${relative(repo, full).split('\\').join('/')}:${index + 1}`);
        }
      });
    }
  };

  walk(repo);

  if (hits.length > 0) {
    fail(`the SDL2-era Ogre window key "${SDL2_WINDOW_KEY}" appears in project source:\n` +
         hits.map((hit) => `  ${hit}`).join('\n') + '\n' +
         '  That key binds an X11 window and pins the renderer to XWayland.\n' +
         '  The SDL3 path is SDL_WINDOW_VULKAN + SDL_Vulkan_CreateSurface, with the\n' +
         '  instance created by the app and the surface handed to Ogre-Next.');
  }

  note('sdl: no SDL2-era window key in project source');
}

/// Linkage scan: no packaged native library may carry a pre-SDL3 soname. Only
/// SDL3 (`libSDL3.so.0`) is acceptable. readelf is ELF-only; on Windows the DLL
/// closure is staged and walked by stageWindowsDependencies instead.
function auditSdlLinkage() {
  if (WIN) return;

  const libraries = [];
  const walk = (dir) => {
    if (!existsSync(dir)) return;
    for (const entry of readdirSync(dir, { withFileTypes: true })) {
      const full = join(dir, entry.name);
      if (entry.isDirectory()) { walk(full); continue; }
      if (entry.isFile() && /\.so(\.|$)/.test(entry.name)) libraries.push(full);
    }
  };
  walk(packages);

  const offending = [];
  let sdl3Seen = 0;

  for (const library of libraries) {
    let output;
    try {
      output = capture('readelf', ['-d', library]);
    } catch {
      continue;  // not a dynamic object; nothing to audit
    }
    for (const line of output.split('\n')) {
      const needed = /Shared library: \[([^\]]+)\]/.exec(line);
      if (!needed) continue;
      const soname = needed[1];
      if (/^libSDL3\.so/.test(soname)) sdl3Seen++;
      if (/^libSDL2|^libSDL-1\.2|^libSDL\.so\.1/.test(soname)) {
        offending.push(`${relative(repo, library).split('\\').join('/')} -> ${soname}`);
      }
    }
  }

  if (offending.length > 0) {
    fail('a packaged library links a pre-SDL3 SDL — this project is SDL3 only\n' +
         offending.map((hit) => `  ${hit}`).join('\n') + '\n' +
         '  Two SDL instances mean two event queues and a window neither one sees.');
  }

  if (sdl3Seen === 0) {
    note(`sdl: ${libraries.length} packaged librar(ies) checked, SDL3 not linked by any`);
  } else {
    note(`sdl: ${libraries.length} packaged librar(ies) checked, SDL3 present, no pre-SDL3 SDL`);
  }
}

// ── core ─────────────────────────────────────────────────────────────────────

function buildCore() {
  const ai = process.env.TENSION_AI === '1';
  // Which backend the ten `tension::2d` imports resolve to (Pass A of the 2D
  // merge). Default is the capability DSO — the tree exactly as it was.
  // `TENSION_RENDER2D=rust` compiles the in-core renderer in, and the loader then
  // skips a 2D DSO named on the command line instead of registering the same
  // imports twice.
  //
  // The flag is deliberately a build switch and not a runtime one: it decides
  // which code exists. Pass B flips the default and the flag goes away with the
  // C++ adapter.
  const render2d = process.env.TENSION_RENDER2D === 'rust';
  const enabled = [ai ? 'ai' : 'audio'];
  if (render2d) enabled.push('render2d-core');
  const features = ai
    ? ['--features', enabled.join(',')]
    : ['--no-default-features', '--features', enabled.join(',')];
  note(`core: cargo build --release ${features.join(' ')}`);
  if (render2d) note('core: 2D renderer is in core (TENSION_RENDER2D=rust)');
  run('cargo', ['build', '--release', ...features], {
    cwd: join(repo, 'tension-core'),
  });

  const coreBin = join(repo, 'tension-core', 'target', 'release', `tension-core${EXE}`);
  if (!existsSync(coreBin)) {
    fail(`cargo reported success but ${coreBin} is missing`);
  }

  const destination = join(payload('core'), 'bin');
  mkdirSync(destination, { recursive: true });
  const target = join(destination, `tension-core${EXE}`);
  rmSync(target, { force: true });
  cpSync(coreBin, target);
  // npm runs `bin` entries by exec; the copy has to keep the mode cargo gave it.
  if (!WIN) spawnSync('chmod', ['755', target]);
  writePayloadManifest(payload('core'), 'core', ['bin/']);
  return payload('core');
}

// ── main ─────────────────────────────────────────────────────────────────────

console.log(`build-native: ${process.platform}/${process.arch} (${toolchainReport()})`);

// Before anything is built: a stale pre-payload directory can shadow the
// payload on the adapter's rpath and there is no error when it does.
pruneStaleMetaPayloads();

// Cheap and first: if an integration regressed to the X11-bound key, say so
// before spending a build to find out.
auditSdlSourceReferences();

const ogreNext = packageOgreNext();
buildRes();
buildAdapter(ogreNext);
buildCore();

// The sonames only exist once the packages are staged, so this runs last.
auditSdlLinkage();

// ── build stamp ──────────────────────────────────────────────────────────────
// Both binaries are now in place, so record what they were built from. The
// inputs are the declared sets in scripts/build-stamp.mjs — the adapter's C++
// and generated headers, the core's Rust and Cargo manifests, and the
// tension-res Zig archive both of them link. content, not mtime: see the header
// of that file for why. run-example.mjs reads this back and refuses to run a
// stale binary.
const stamped = writeStamp(repo);
note(`stamp: ${stamped.counts.adapter} adapter input(s), ${stamped.counts.core} core input(s)`);
note(`stamp: wrote ${relative(repo, stamped.path).split('\\').join('/')}`);

// ── budget ───────────────────────────────────────────────────────────────────
// These are the thresholds the packages were given. A number over budget is a
// report, not a failure: it means something unexpected is being copied and
// wants a look, which is cheaper to see here than in a consumer's tree.
const BUDGET = {
  [`packages/core-${SUFFIX}/bin/tension-core${EXE}`]: 50,
  [`packages/ogre-next-${SUFFIX}`]: 40,
  [`packages/ogre-${SUFFIX}`]: 25,
};
console.log('');
let over = 0;
for (const [rel, limit] of Object.entries(BUDGET)) {
  const bytes = du(join(repo, rel));
  const state = bytes / (1024 * 1024) > limit ? `OVER BUDGET (${limit} MB)` : 'ok';
  if (state !== 'ok') over++;
  console.log(`  ${rel.padEnd(46)} ${mb(bytes).padStart(8)}  ${state}`);
}
if (over) {
  console.log(`\nbuild-native: ${over} package(s) over budget — see the notes in packages/*/README.md`);
}
