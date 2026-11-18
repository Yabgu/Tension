#!/usr/bin/env node
// Initialise the submodules a native build requires, before a Rust build script
// panics about a missing file.
//
// # The failure this replaces
//
// `git pull` does not update submodules, and the root `preinstall` hook only
// initialises `TensionScript` (it needs the compiler, not the C++ host). So a
// pulled tree reached its first native build and died inside the build script:
//
//     thread 'main' panicked at build.rs:238:9:
//     C:\work\Tension\third_party\ImageViewer\src\format\IwiFile.cpp is missing
//     — initialise the submodule with `git submodule update --init third_party/ImageViewer`
//
// A panic is a poor way to ask for a checkout step, and a reader who only wants
// the JavaScript side should not have to know about it. This runs from the build
// path instead, so the requirement is met where it is felt and nowhere else.
//
// # What is required, and why exactly this
//
// `grep third_party/ tension-core/build.rs` answers with **one** path:
// `third_party/ImageViewer`. `build.rs` compiles `src/format/IwiFile.cpp` and
// `src/imageviewer/ImagePluginDef.h` into the host and panics when either is
// absent. No other build script names a `third_party/` path.
//
// `third_party/ogre-next` is **not** here: nothing in the core build reads it, and
// the OGRE side has its own bootstrap (`scripts/ensure-ogre.mjs`, run by
// `build-ogre.mjs` and `bootstrap.mjs`). Adding it would make every native build
// wait on a large C++ tree for no reason.
//
// # Cost
//
// A `stat` per required path when the submodule is present — the list is checked
// against the working tree, not against `git submodule status`, because a file's
// existence is the thing `build.rs` actually tests.

import { existsSync } from 'node:fs';
import { spawnSync } from 'node:child_process';
import { dirname, join, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';

// `scripts/lib/submodules.mjs` → the repository root is two levels up.
const here = dirname(fileURLToPath(import.meta.url));
const repo = resolve(here, '..', '..');

/**
 * One entry per path `tension-core/build.rs` requires, with the file whose absence
 * makes it panic. The `file` is the assertion; the `paths` are what to initialise.
 */
export const BUILD_SUBMODULES = [
  {
    path: 'third_party/ImageViewer',
    file: 'third_party/ImageViewer/src/format/IwiFile.cpp',
    why: 'tension-core/build.rs:238 compiles IwiFile.cpp into the host and panics without it',
  },
];

/**
 * Ensure each required submodule is checked out. Returns the list of paths that
 * had to be initialised; empty on the common path.
 *
 * `git submodule update --init <path>` is idempotent and a no-op when the submodule
 * is already at the recorded commit, so a mismatch is repaired by the same call.
 * Failures are thrown, not swallowed: a build that continues after a failed
 * submodule update fails later, in Rust, with the message this function exists to
 * avoid.
 */
export function ensureSubmodules({ say = () => {} } = {}) {
  const initialised = [];
  for (const entry of BUILD_SUBMODULES) {
    if (existsSync(join(repo, entry.file))) continue;
    say(`${entry.path} is not checked out (${entry.why}) — initialising`);
    const result = spawnSync('git', ['submodule', 'update', '--init', entry.path], {
      cwd: repo,
      encoding: 'utf8',
      // `git` is `git.exe` on Windows, so this is spawned directly: a shell would
      // split a `C:\Program Files\Git\…` path on the space.
      stdio: 'inherit',
    });
    if (result.error) {
      throw new Error(`git submodule update --init ${entry.path}: ${result.error.message}`);
    }
    if (result.status !== 0) {
      throw new Error(
        `git submodule update --init ${entry.path} failed (exit ${result.status}).\n` +
        '  That path is required by tension-core/build.rs; without it the Rust build panics.\n' +
        `  Run it by hand if the remote was unreachable: git submodule update --init ${entry.path}`);
    }
    if (!existsSync(join(repo, entry.file))) {
      throw new Error(
        `${entry.path} is still missing ${entry.file} after update --init.\n` +
        '  The submodule is initialised but its commit is not checked out; run:\n' +
        `    git -C ${entry.path} checkout .`);
    }
    initialised.push(entry.path);
  }
  return initialised;
}

// Standalone: `node scripts/ensure-submodules.mjs` does the same thing without a build.
if (process.argv[1] && resolve(process.argv[1]) === fileURLToPath(import.meta.url)) {
  try {
    const done = ensureSubmodules({ say: (message) => console.log(`ensure-submodules: ${message}`) });
    console.log(done.length
      ? `ensure-submodules: initialised ${done.join(', ')}`
      : 'ensure-submodules: everything the build requires is present');
  } catch (error) {
    console.error(`ensure-submodules: ${error.message}`);
    process.exit(1);
  }
}
