#!/usr/bin/env node
// The capability adapter: its own build, its checks, and its unit tests.
//
// The build itself is CMake (`tension-ogre/CMakeLists.txt`), the same recipe
// `npm run build` uses, so a standalone build here produces the identical
// artifact. What this file adds is the modes a developer reaches for:
//
//   node scripts/build-ogre.mjs            build (backend = ogre)
//   node scripts/build-ogre.mjs --check    report what the adapter would link
//   node scripts/build-ogre.mjs --clean    remove the CMake tree and build/
//   node scripts/build-ogre.mjs --test     build and run the unit tests
//
// Environment:
//   TENSION_OGRE_BACKEND=ogre|none   `none` builds without OGRE at all; the only
//                                    renderer it can satisfy is `renderer=null`
//   TENSION_OGRE_PREFIX=<prefix>     a hand-built Ogre-Next install
//   CXX=<compiler>                   forwarded to CMake

import { spawnSync } from 'node:child_process';
import { existsSync, readdirSync, rmSync } from 'node:fs';
import { join } from 'node:path';
import { REPO, WIN, run, toolchainReport, which } from './lib/toolchain.mjs';
import { missingSystemFilter, stageWindowsDependencies } from './lib/dll.mjs';
import { inherit } from './lib/proc.mjs';

const repo = REPO;
const here = join(repo, 'tension-ogre');
const buildDir = join(here, 'build-cmake');
const outDir = join(here, 'build');
const RUNNER = 'tension-ogre';

const backend = process.env.TENSION_OGRE_BACKEND ?? 'ogre';
const mode = process.argv[2] ?? '';

function die(message) {
  console.error(`${RUNNER}: ${message}`);
  process.exit(1);
}

if (backend !== 'ogre' && backend !== 'none') {
  die(`TENSION_OGRE_BACKEND=${backend} is not a backend.\n` +
      '  Use ogre (link OGRE-Next) or none (build without it).');
}

/// The pinned upstream revision. `--check` compares the submodule's HEAD against
/// it: the drift it catches is real, and this file used to name the wrong commit.
const PIN_SHA = '475f783d76f21b530e718aab4a548cdd9a222e50';

if (mode === '--print-pin') {
  console.log(`OGRE-Next ${PIN_SHA} (v3.0.0-788-g475f783d76)`);
  process.exit(0);
}

if (mode === '--check') {
  console.log(`${RUNNER}: backend=${backend} (default; 'none' opts out of OGRE)`);
  const pkgConfig = which('pkg-config');
  if (pkgConfig) {
    const version = spawnSync(pkgConfig, ['--modversion', 'OGRE-Next'], { encoding: 'utf8' });
    if (version.status === 0) {
      console.log(`${RUNNER}: OGRE-Next ${version.stdout.trim()} via pkg-config`);
      const pluginDir = spawnSync(pkgConfig, ['--variable', 'plugindir', 'OGRE-Next'],
                                  { encoding: 'utf8' });
      if (pluginDir.status === 0) console.log(`  plugin dir: ${pluginDir.stdout.trim()}`);
    } else {
      console.log(`${RUNNER}: OGRE-Next not found via pkg-config`);
    }
  }

  // The in-tree install either layout: Linux spells it share/OGRE-Next/Media,
  // Windows puts Media/ at the prefix root.
  const inTree = join(repo, 'third_party', 'ogre-next-install');
  const media = existsSync(join(inTree, 'share', 'OGRE-Next', 'Media'))
    ? join(inTree, 'share', 'OGRE-Next', 'Media')
    : join(inTree, 'Media');
  if (existsSync(media)) {
    console.log(`${RUNNER}: in-tree Ogre-Next at third_party/ogre-next-install (preferred)`);
  }

  // The submodule is what the bootstrap builds, so its HEAD is the revision the
  // measurements were taken against. Comparing the gitlink is an exact, cheap
  // check.
  const submodule = join(repo, 'third_party', 'ogre-next');
  if (existsSync(join(submodule, '.git'))) {
    const head = spawnSync('git', ['-C', submodule, 'rev-parse', 'HEAD'], { encoding: 'utf8' });
    const sha = (head.stdout ?? '').trim();
    if (sha && sha !== PIN_SHA) {
      die(`MISMATCH — submodule HEAD is ${sha}\n` +
          `               but the pin in this file is ${PIN_SHA}\n` +
          '               (update the pin here, or check that commit out in the submodule)');
    }
    if (sha) console.log(`${RUNNER}: submodule HEAD matches the pin (${PIN_SHA})`);
  }
  console.log(`${RUNNER}: pinned against ${PIN_SHA} (v3.0.0-788-g475f783d76)`);
  process.exit(0);
}

if (mode === '--clean') {
  rmSync(buildDir, { recursive: true, force: true });
  rmSync(outDir, { recursive: true, force: true });
  console.log(`${RUNNER}: removed ${buildDir} and ${outDir}`);
  process.exit(0);
}

// ── the build ───────────────────────────────────────────────────────────────

if (!which('cmake')) die('cmake not found.');

const args = [
  '-S', here,
  '-B', buildDir,
  '-G', 'Ninja',
  '-DCMAKE_BUILD_TYPE=Release',
  `-DTENSION_OGRE_BACKEND=${backend}`,
  `-DTENSION_RES_DIR=${join(repo, 'tension-res')}`,
];

// The Ogre prefix: an explicit one wins; otherwise the in-tree install, which is
// what the tests and the packages are built against.
const prefix = process.env.TENSION_OGRE_PREFIX ?? join(repo, 'third_party', 'ogre-next-install');
if (backend === 'ogre' && existsSync(prefix)) {
  args.push(`-DOGRE_NEXT_PREFIX=${prefix}`);
}

// The compiler choice on Windows is forced by the Ogre build: a MinGW install
// ships `libOgreNextMain.dll.a` import libraries, which MSVC's linker cannot
// use. That mix — MinGW adapter, MSVC host — is deliberate.
if (WIN && backend === 'ogre') {
  const mingwOgre = existsSync(join(prefix, 'lib', 'libOgreNextMain.dll.a')) ||
                    existsSync(join(prefix, 'lib', 'Release', 'libOgreNextMain.dll.a'));
  if (mingwOgre) args.push('-DCMAKE_C_COMPILER=gcc', '-DCMAKE_CXX_COMPILER=g++');
}

if (process.env.CXX) args.push(`-DCMAKE_CXX_COMPILER=${process.env.CXX}`);

if (mode === '--test') args.push('-DTENSION_OGRE_BUILD_TESTS=ON');

console.log(`${RUNNER}: ${process.platform}/${process.arch} (${toolchainReport()}), backend ${backend}`);
run('cmake', args);
run('cmake', ['--build', buildDir]);

if (mode === '--test') {
  // The unit tests need no OGRE: the loader's worker reads bytes and the backend
  // is a mock, the config decoder is pure parsing. They run here rather than in
  // CTest so a failure's output is the binary's own.
  //
  // `stbi_codec_test` is the exception — it links OgreNextMain on purpose, to
  // prove the image codec is in the library and decodes. It is only built when
  // the OGRE backend is, so it is run when present rather than required: the
  // `none` backend has no Ogre to assert on.
  const testDir = join(outDir, 'tests');
  const present = readdirSync(testDir);
  const required = present
    .filter((name) => /^(config|scene|loader)_test(\.exe)?$/.test(name))
    .sort();
  if (required.length === 0) {
    die(`no test binaries in ${testDir}; the CMake configure did not build them`);
  }
  const codec = present
    .filter((name) => /^stbi_codec_test(\.exe)?$/.test(name))
    .sort();
  if (codec.length === 0) {
    console.log(`${RUNNER}: stbi_codec_test not built (backend ${backend}); skipping`);
  }

  const tests = [...required, ...codec];
  for (const test of tests) {
    console.log(`${RUNNER}: running ${test}`);
    const result = inherit(join(testDir, test), []);
    if (result.status !== 0) {
      die(`${test} failed (exit ${result.status})`);
    }
  }
  console.log(`${RUNNER}: ${tests.length} unit test(s) passed`);
  process.exit(0);
}

const artifact = WIN ? 'libtension_ogre.dll' : 'libtension_ogre.so';

// The post-build step stages Ogre's own DLLs beside the adapter, but not the rest
// of the closure (zlib1, libzzip, the MinGW runtime). Complete it here so this
// directory is self-contained — the guest suite loads the adapter straight out
// of it, and a missing dependency is a LoadLibrary error 126 that names no file.
if (WIN && backend === 'ogre') {
  const gxx = which('g++');
  const search = [
    ...(gxx ? [join(gxx, '..')] : []),
  ];
  const unresolved = missingSystemFilter(stageWindowsDependencies(outDir, search.map(String)));
  if (unresolved.length) {
    die(`the adapter's DLL closure is incomplete: ${unresolved.join(', ')}\n` +
        '  build the packages first: npm run build:native');
  }
}

console.log(`${RUNNER}: ${join(outDir, artifact)} (backend ${backend})`);
