#!/usr/bin/env node
// Build the HlmsPbs-subclass reference probe.
//
// The binary is `probe`, beside these sources (and gitignored — it is a build
// product, not a fixture). The sources compile the adapter's own
// `hlms_tension_skin.cpp` against Ogre's public headers, which is what makes them
// a reference: if the subclass stops compiling against a new Ogre, this is where
// it shows up as a compile error rather than as a shader that renders nothing.
//
// Ogre comes from pkg-config when it is installed system-wide, and from
// `third_party/ogre-next-install` otherwise — the same preference order as every
// other Ogre consumer in this tree.
//
// Usage: node scripts/build-hlms-skin.mjs

import { existsSync } from 'node:fs';
import { join } from 'node:path';
import { REPO, WIN, run, toolchainReport, which } from './lib/toolchain.mjs';
import { spawn } from './lib/proc.mjs';

const repo = REPO;
const here = join(repo, 'tension-ogre', 'tests', 'hlms-skin');
const RUNNER = 'hlms-skin';

function die(message) {
  console.error(`${RUNNER}: ${message}`);
  process.exit(1);
}

const cxx = process.env.CXX ?? (WIN ? 'g++' : 'c++');
if (!which(cxx)) die(`${cxx} not found on PATH.`);

/// Ogre's include roots and libraries, from pkg-config or the in-tree install.
function findOgre() {
  const pkgConfig = which('pkg-config');
  if (pkgConfig) {
    const exists = spawn(pkgConfig, ['--exists', 'OGRE-Next']);
    if (exists.status === 0) {
      const cflags = spawn(pkgConfig, ['--cflags', 'OGRE-Next']).stdout.trim();
      const libs = spawn(pkgConfig, ['--libs', 'OGRE-Next']).stdout.trim();
      const includedir = spawn(pkgConfig, ['--variable=includedir', 'OGRE-Next']).stdout.trim();
      console.log(`${RUNNER}: Ogre-Next via pkg-config`);
      return {
        cflags: cflags.split(/\s+/).filter(Boolean),
        libs: libs.split(/\s+/).filter(Boolean),
        // The Hlms headers include their siblings by bare name.
        hlms: [
          `-isystem ${join(includedir, 'OGRE-Next', 'Hlms', 'Common')}`,
          `-isystem ${join(includedir, 'OGRE-Next', 'Hlms', 'Pbs')}`,
          `-isystem ${join(includedir, 'OGRE-Next', 'Hlms', 'Unlit')}`,
        ],
      };
    }
  }

  // The in-tree install: Linux puts headers under include/OGRE-Next, a Windows
  // install puts them in include/OGRE-Next too, and the media/libraries follow
  // the platform's own layout.
  const prefix = process.env.TENSION_OGRE_PREFIX ?? join(repo, 'third_party', 'ogre-next-install');
  const include = join(prefix, 'include');
  if (!existsSync(join(include, 'OGRE-Next'))) return null;

  // Windows installs the import libraries under lib/Release.
  const libDirs = [join(prefix, 'lib'), join(prefix, 'lib', 'Release')].filter(existsSync);
  console.log(`${RUNNER}: Ogre-Next at ${prefix} (in-tree)`);
  return {
    cflags: [
      `-isystem ${include}`,
      `-isystem ${join(include, 'OGRE-Next')}`,
    ],
    libs: [
      ...libDirs.map((dir) => `-L${dir}`),
      '-lOgreNextMain', '-lOgreNextHlmsPbs', '-lOgreNextHlmsUnlit',
    ],
    hlms: [
      `-isystem ${join(include, 'OGRE-Next', 'Hlms', 'Common')}`,
      `-isystem ${join(include, 'OGRE-Next', 'Hlms', 'Pbs')}`,
      `-isystem ${join(include, 'OGRE-Next', 'Hlms', 'Unlit')}`,
    ],
  };
}

const ogre = findOgre();
if (!ogre) {
  die('OGRE-Next not found (neither pkg-config nor third_party/ogre-next-install).\n' +
      '  Build it with: npm run bootstrap');
}

console.log(`${RUNNER}: ${process.platform}/${process.arch} (${toolchainReport()})`);

// -O0 -g: this is a reference probe, not a shader. Readability of the stack when
// it fails is the point.
const args = [
  '-O0', '-g', '-std=c++17',
  '-o', join(here, 'probe'),
  join(here, 'main.cc'),
  join(here, 'HlmsTensionSkin.cpp'),
  ...ogre.cflags,
  ...ogre.hlms,
  ...ogre.libs,
];

run(cxx, args);
console.log(`built ${join(here, 'probe')}`);
