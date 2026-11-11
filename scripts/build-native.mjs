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
  cpSync, existsSync, lstatSync, mkdirSync, readdirSync, readFileSync, readlinkSync, rmSync,
  writeFileSync,
} from 'node:fs';
import { basename, dirname, isAbsolute, join, relative, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';
import { writeStamp } from './build-stamp.mjs';
import { ensureOgre } from './ensure-ogre.mjs';
import { readElfDynamic, runpathEntries } from './lib/elf.mjs';
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

// ── payload relocation ───────────────────────────────────────────────────────
//
// A packaged library's search path has to mean "this directory" and nothing
// else. The measurement that made this a build step: every Ogre-Next library in
// the payload carried
//
//     RUNPATH /home/<builder>/work/Tension/third_party/ogre-next-install/lib
//
// — correct on the machine that built it and meaningless on every other. A
// `dist/` copied to another machine still ran, because `run.sh` also exported
// `LD_LIBRARY_PATH=$here/lib`, which *outranks* DT_RUNPATH... except for the two
// places it does not: a consumer that dlopens the adapter itself, a package used
// out of `node_modules` by an absolute path, and anything on Windows, where
// there is no RUNPATH at all. The absolute path also leaked the builder's
// directory into every published artifact.
//
// Two layers, and they are different jobs:
//
//   * `scripts/bootstrap.mjs` now asks CMake for `-DCMAKE_INSTALL_RPATH=$ORIGIN`,
//     so a tree built today is relocatable when it is installed. That is the
//     fix at the source.
//   * this step *verifies* the payload and repairs it if it is not, because a
//     tree built before that flag exists is still on disk, and because a flag
//     that stops being honoured should fail the build rather than ship.
//
// The repair is `patchelf`; the check is not. `scripts/lib/elf.mjs` reads the
// RUNPATH out of the file with no external tool, so an unrelocatable payload
// fails the build even on a machine where patchelf was never installed.

/// Only `$ORIGIN`-relative entries survive being moved. Absolute ones never do.
function isRelocatable(entry) {
  return entry.startsWith('$ORIGIN') || entry.startsWith('$LIB');
}

/// `patchelf`, if this machine has one. `PATCHELF` names it explicitly.
function findPatchelf() {
  const explicit = process.env.PATCHELF;
  if (explicit) return existsSync(explicit) ? explicit : null;
  return which('patchelf') ?? null;
}

/// Every shared object under `dir`, as regular files.
///
/// Symlinks are skipped deliberately: `libFoo.so -> libFoo.so.4.0` is a second
/// name for one file, and patching both means patching the same inode twice.
function payloadLibraries(dir) {
  const libraries = [];
  const walk = (from) => {
    let entries;
    try {
      entries = readdirSync(from, { withFileTypes: true });
    } catch {
      return;
    }
    for (const entry of entries) {
      const full = join(from, entry.name);
      if (entry.isDirectory()) walk(full);
      else if (entry.isFile() && /\.so(\.|$)/.test(entry.name)) libraries.push(full);
    }
  };
  walk(dir);
  return libraries;
}

/**
 * Make every library in a payload find its siblings through `$ORIGIN`.
 *
 * Two modes, because the two payloads have different shapes:
 *
 *   `exact`   the RUNPATH must equal `wanted` character for character. The
 *             Ogre-Next payload has libraries at two depths (`lib/` and
 *             `lib/OGRE-Next/`), so one specific string is the only thing that
 *             works for both, and `$ORIGIN` on its own is relocatable *and*
 *             wrong. This is also the mode that keeps an install built before
 *             the flag was corrected from shipping.
 *   default   only absolute entries are a defect. The adapter's path is computed
 *             by CMake from the real layout and gains one extra entry naming the
 *             build tree; rewriting it every build to drop an entry that is
 *             harmless and relative would be noise, and would make `patchelf`
 *             mandatory for a build that does not need it.
 */
function relocatePayload(dir, wanted, label, { exact = false } = {}) {
  const libraries = payloadLibraries(dir);
  if (!libraries.length) return;

  const stale = [];
  for (const library of libraries) {
    let dynamic;
    try {
      dynamic = readElfDynamic(library);
    } catch (error) {
      fail(`${label}: cannot read ${relative(repo, library)}: ${error.message}`);
    }
    const current = runpathEntries(dynamic).join(':');
    const wrong = exact ? current !== wanted : !isRelocatable(current);
    if (wrong) stale.push({ library, dynamic, current });
  }

  if (!stale.length) {
    const found = runpathEntries(readElfDynamic(libraries[0])).join(':') || '(no RUNPATH)';
    note(`${label}: ${libraries.length} librar(ies) already relocatable, e.g. ${found}`);
    return;
  }

  const patchelf = findPatchelf();
  if (!patchelf) {
    fail(`${label}: ${stale.length} packaged librar(ies) carry a path the payload cannot use\n` +
         stale.map(({ library, current }) =>
           `  ${relative(repo, library).split('\\').join('/')}: ${current || '(no RUNPATH)'}`).join('\n') +
         `\n  wanted: ${wanted}` +
         '\n  They must use $ORIGIN so the package survives being copied. Fix either way:\n' +
         '    - rebuild the Ogre-Next install with `npm run bootstrap -- --force` (it now\n' +
         '      passes -DCMAKE_INSTALL_RPATH=$ORIGIN:$ORIGIN/..), or\n' +
         '    - install patchelf (binutils-distro package, `python3 -m pip install patchelf`,\n' +
         '      or the static build from https://github.com/NixOS/patchelf/releases)\n' +
         '      and re-run this build.');
  }

  for (const { library, dynamic } of stale) {
    const args = ['--set-rpath', wanted];
    // Keep the *tag*, not just the value. `tension-ogre/CMakeLists.txt` links
    // with `--disable-new-dtags` so the adapter's own Ogre-Next wins over an
    // `LD_LIBRARY_PATH` the user's shell happens to carry (DT_RPATH is searched
    // before that variable, DT_RUNPATH after). patchelf's `--set-rpath` emits
    // DT_RUNPATH by default, which would silently reverse that precedence and
    // reintroduce the stale-library bug the flag was added for.
    if (dynamic.rpathKind === 'RPATH') args.push('--force-rpath');
    args.push(library);
    // `capture`, not `run`: patchelf is silent on success, and a failure should
    // be reported as this step's diagnosis rather than as a thrown command line.
    try {
      capture(patchelf, args);
    } catch (error) {
      fail(`${label}: patchelf refused ${relative(repo, library)}\n${error.message}`);
    }
    // Verified by the reader that found it: a repair that is not re-read is a
    // claim, not a fix.
    const after = readElfDynamic(library);
    if (runpathEntries(after).join(':') !== wanted) {
      fail(`${label}: ${relative(repo, library)} still reads ` +
           `"${runpathEntries(after).join(':')}" after patchelf`);
    }
  }
  note(`${label}: rewrote the RUNPATH of ${stale.length} librar(ies) to ${wanted}`);
}

/// The last word: every payload library's search path is `$ORIGIN`-relative,
/// and every payload library can resolve the payload's own libraries by itself.
///
/// Separate from the repair because it holds even when nothing needed repairing
/// — the state being asserted is "this artifact is self-contained", and a build
/// that only checks when it changed something does not assert that.
///
/// The resolution half is the one that catches a rpath that is *relative and
/// still wrong*: `$ORIGIN` on its own is relocatable and useless for a plugin in
/// `lib/OGRE-Next/`, whose dependencies are one directory up. Measured, the day
/// this was added: 463 unresolved references, none of them named by the rpath
/// audit. `ldd -r` asks the loader directly, and only payload-provided sonames
/// are held to it — a build machine without `libGL` must not fail this gate,
/// because the payload does not claim to ship libGL.
function auditRelocatablePayloads(dirs) {
  const offending = [];
  let checked = 0;
  for (const { dir, label } of dirs) {
    for (const library of payloadLibraries(dir)) {
      checked++;
      const dynamic = readElfDynamic(library);
      const entries = runpathEntries(dynamic);
      const bad = entries.filter((entry) => !isRelocatable(entry));
      if (bad.length) {
        offending.push(`${label}: ${relative(repo, library).split('\\').join('/')} -> ${bad.join(':')}`);
      }
    }
  }
  if (offending.length) {
    fail('a packaged library names a directory outside its payload:\n' +
         offending.map((line) => `  ${line}`).join('\n') + '\n' +
         '  A shipped package must resolve through $ORIGIN; an absolute path only\n' +
         '  exists on the machine that built it.');
  }
  note(`rpath: ${checked} packaged librar(ies) checked, all $ORIGIN-relative`);

  if (WIN || !which('ldd')) return;
  const unresolved = [];
  for (const { dir, label } of dirs) {
    // What this payload promises to provide, by soname.
    const provided = new Set(payloadLibraries(dir).map((library) => basename(library)));
    for (const library of payloadLibraries(dir)) {
      let report;
      try {
        // `LD_LIBRARY_PATH` deleted, and the environment cleared to what the
        // loader would see from a launcher that set nothing: the question is
        // what the library can do alone.
        report = capture('ldd', ['-r', library], {
          env: { PATH: process.env.PATH ?? '/usr/bin:/bin' },
        });
      } catch {
        continue;  // ldd's own refusal; the rpath audit above already passed
      }
      for (const line of report.split('\n')) {
        const missing = /^\s*(\S+) => not found/.exec(line);
        if (missing && provided.has(missing[1])) {
          unresolved.push(`${label}: ${relative(repo, library).split('\\').join('/')} cannot find ${missing[1]}`);
        }
      }
    }
  }
  if (unresolved.length) {
    fail('a packaged library cannot resolve the payload it belongs to:\n' +
         unresolved.map((line) => `  ${line}`).join('\n') + '\n' +
         '  Check the RUNPATH: a plugin in lib/OGRE-Next/ needs $ORIGIN/.. as well\n' +
         '  as $ORIGIN, and bootstrap.mjs passes both.');
  }
  note(`rpath: every payload library resolves the payload alone, with no LD_LIBRARY_PATH`);

  // Symlinks, for the same reason the RUNPATH is checked: a payload link that
  // names an absolute path is a link into the build machine. `copyTree` asks for
  // `verbatimSymlinks` and the Ogre-Next install writes relative ones, so this
  // holds today — and it is exactly the property a later "just dereference it"
  // fix would quietly break.
  const escaping = [];
  for (const { dir, label } of dirs) {
    const walk = (from) => {
      for (const entry of readdirSync(from, { withFileTypes: true })) {
        const full = join(from, entry.name);
        if (entry.isSymbolicLink()) {
          const target = readlinkSync(full);
          if (isAbsolute(target)) {
            escaping.push(`${label}: ${relative(repo, full).split('\\').join('/')} -> ${target}`);
          }
        } else if (entry.isDirectory()) {
          walk(full);
        }
      }
    };
    walk(dir);
  }
  if (escaping.length) {
    fail('a packaged symlink points outside its payload:\n' +
         escaping.map((line) => `  ${line}`).join('\n') + '\n' +
         '  A relative link survives being copied; an absolute one is a path on\n' +
         '  this machine. `cpSync` needs `verbatimSymlinks: true` somewhere.');
  }
  note('links: every packaged symlink is relative');
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
  // Every Ogre-Next library sits beside its siblings in this one directory, so
  // `$ORIGIN` is the whole search path they need — and the only spelling that
  // survives the copy into `dist/lib` that `tension build` makes later.
  // `$ORIGIN/..` as well: the render system plugins land in `lib/OGRE-Next/` and
  // their dependencies are `lib/`. See the note on `$(INSTALL_RPATH)` in
  // bootstrap.mjs for the measurement.
  if (!WIN) {
    relocatePayload(join(destination, 'lib'), '$ORIGIN:$ORIGIN/..', 'ogre-next', { exact: true });
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
  // The adapter's own path, from the adapter's perspective: itself, then the
  // Ogre-Next payload by both spellings (the local payload directory, and the
  // `tension-`-prefixed name `npm pack` gives the published package). All of them
  // are `$ORIGIN`-relative, so the same string works in `packages/`, in a
  // published `node_modules/`, and — through the first entry — in the flat
  // `dist/lib` that `tension build` assembles.
  //
  // The link also appends the *build tree's* `$ORIGIN/../../third_party/...`,
  // because the copy CMake stages into `tension-ogre/build/` is what the C++ and
  // Rust suites load, and that copy has to resolve Ogre without an environment
  // variable. In the package the entry is dead — nothing is two levels up — and
  // it is harmless there because `$ORIGIN` comes first and the payload is flat or
  // a sibling. What the audit below enforces is the property that matters: no
  // entry is absolute.
  if (!WIN) {
    const sibling = basename(ogreNextPayload);
    relocatePayload(
      join(destination, 'lib'),
      ['$ORIGIN', `$ORIGIN/../../${sibling}/lib`, `$ORIGIN/../../tension-${sibling}/lib`].join(':'),
      'ogre',
    );
  }
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
  // Which backend the ten `tension::2d` imports resolve to.
  //
  //   (unset)                 in core — the default since Pass B
  //   TENSION_RENDER2D=rust   in core, stated explicitly
  //   TENSION_RENDER2D=cpp    the C++ DSO, for a bisect
  //
  // The flag is deliberately a build switch and not a runtime one: it decides
  // which code exists. `cpp` turns the feature off, which leaves the DSO the
  // only thing that can answer `tension::2d` — so a run on that path still
  // needs `--capability`. Pass C removes both the flag and the DSO.
  const backend = process.env.TENSION_RENDER2D ?? 'rust';
  if (backend !== 'rust' && backend !== 'cpp') {
    fail(`TENSION_RENDER2D=${backend} is not a backend; use \`rust\` (in core) or \`cpp\` (the DSO, for a bisect)`);
  }
  const render2d = backend === 'rust';
  const enabled = [ai ? 'ai' : 'audio'];
  if (render2d) enabled.push('render2d-core');
  // SDL3 goes *into* the binary. This is the one artifact that ships, so this is
  // the one build that must not depend on a `libSDL3.so.0` the target machine
  // happens to have: the cost is a CMake build of the vendored SDL source, paid
  // here and nowhere else. `cargo build` for iteration stays on the system SDL.
  //
  // `TENSION_STATIC_SDL=0` builds a dynamic payload binary — for bisecting this
  // flag, which is the only reason to want one.
  const staticSdl = process.env.TENSION_STATIC_SDL !== '0';
  if (staticSdl) enabled.push('static-sdl3');
  const features = ai
    ? ['--features', enabled.join(',')]
    : ['--no-default-features', '--features', enabled.join(',')];
  note(`core: cargo build --release ${features.join(' ')}`);
  note(
    render2d
      ? 'core: 2D renderer is in core'
      : 'core: 2D renderer is the C++ DSO (TENSION_RENDER2D=cpp) — pass --capability at run time',
  );
  note(
    staticSdl
      ? 'core: SDL3 is static (the payload binary needs no libSDL3)'
      : 'core: SDL3 is dynamic (TENSION_STATIC_SDL=0) — the payload needs libSDL3.so.0',
  );
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

// Every library that ships must find its siblings through `$ORIGIN`. Checked
// again here, after every payload is staged, rather than only where each one was
// written: this is the property `dist/` depends on, and it should be asserted at
// the end on the artifacts that actually exist.
if (!WIN) {
  auditRelocatablePayloads([
    { dir: join(ogreNext, 'lib'), label: 'ogre-next' },
    { dir: join(payload('ogre'), 'lib'), label: 'ogre' },
  ]);
}

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
//
// The ogre limit is 40 MB, and the reason is that this package's floor is the
// *engine*, not the adapter. On Linux the adapter is one shared object, under
// 5 MB, resolving Ogre-Next out of the sibling package through `DT_RPATH`. On
// Windows there is no RPATH, so `stageWindowsDependencies` copies the whole DLL
// closure beside `libtension_ogre.dll` — `libOgreNextMain.dll`, the Hlms
// render systems, and the MinGW runtime they need. Those DLLs are 15-22 MB on
// their own, and the adapter is the small part of the total.
//
// The previous 25 MB limit was below that floor, so it reported OVER BUDGET on
// a package with nothing removable in it. 40 MB is the floor plus room for one
// more plugin; that is headroom, not a target.
//
// **What is not in this number: Media and sample assets.** `Media/` ships in
// `packages/ogre-next-${SUFFIX}` (its own 40 MB limit), reduced to 1.3 MB from
// the install's 144 MB by the sample-asset prune described in
// `packages/ogre-next/README.md`. If either package goes over its limit, that
// prune has regressed: find what came back before raising a limit, because a
// limit raised without a measurement stops reporting anything.
const BUDGET = {
  [`packages/core-${SUFFIX}/bin/tension-core${EXE}`]: 50,
  [`packages/ogre-next-${SUFFIX}`]: 40,
  [`packages/ogre-${SUFFIX}`]: 40,
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
