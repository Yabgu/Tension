#!/usr/bin/env node
// The packaged binaries' build stamp: what each one was built from.
//
// Two binaries ship, consumed through the `file:` packages:
//
//   adapter   packages/ogre/lib/libtension_ogre.so
//   core      packages/core/bin/tension-core
//
// Both also link the Zig archive built from `tension-res/` — the adapter links
// `zig-out/lib/libtension_res.a` directly in build.sh, the core through
// `cargo:rustc-link-lib=static=tension_res` in build.rs, and the adapter also
// includes `tension_res.h`. A change there makes *both* binaries stale, so
// tension-res is in both input sets. Leaving it out of either would report
// "fresh" for a binary reading a different record format than the guest — the
// -22 this stamp exists to make legible.
//
// Content hash, never mtime. `tension-framework/build.sh` rewrites
// `assembly/runtime/layout.ts` (line 189) and `assembly/runtime/manifest.ts`
// (via scripts/gen-manifest.py) on every run, with byte-identical output. Thus
// the mtimes advance every single build while the content never changes, and
// `build:framework` runs *after* `build:native` — a mtime comparison would call
// a perfectly good adapter stale, every time.
//
// Canonical form: files sorted by repo-relative POSIX path; for each,
// `<relpath>\0<sha256(file content)>\n`; then SHA-256 over that stream.

import { createHash } from 'node:crypto';
import { readdirSync, readFileSync, writeFileSync } from 'node:fs';
import { join, relative } from 'node:path';

/** Where the stamp lives, relative to the repository root. */
export const STAMP_PATH = join('packages', 'build-stamp.json');

/// Input sets. `dirs` entries are `[root, include, exclude?]`; a file under
/// `root` counts when `include(name)` and not `exclude(path)`.
///
/// `tension-ogre/src` excludes `src/generated` because that tree is listed
/// separately: it holds the header codegen writes, and it is the one input a
/// reader is most likely to wonder about.
export const INPUT_SETS = {
  adapter: {
    dirs: [
      ['tension-framework/assembly/ogre/generated', () => true],
      ['tension-ogre/src/generated', () => true],
      ['tension-ogre/src', (n) => n.endsWith('.cpp') || n.endsWith('.h'), (p) => p.includes('/src/generated/')],
      ['tension-res/src', (n) => n.endsWith('.zig')],
    ],
    files: [
      'schema/ogre.json',
      'tension-framework/assembly/ogre/wire.ts',
      'tension-framework/assembly/ogre/index.ts',
      'tension-res/build.zig',
      'tension-res/include/tension_res.h',
    ],
  },
  core: {
    dirs: [
      ['tension-core/src', (n) => n.endsWith('.rs')],
      ['tension-res/src', (n) => n.endsWith('.zig')],
    ],
    files: [
      'tension-core/Cargo.toml',
      'tension-core/Cargo.lock',
      'tension-core/build.rs',
      'tension-res/build.zig',
      'tension-res/include/tension_res.h',
    ],
  },
};

function toPosix(p) {
  return p.split('\\').join('/');
}

function walk(abs, include, exclude, out) {
  let entries;
  try {
    entries = readdirSync(abs, { withFileTypes: true });
  } catch {
    return; // a set member that does not exist contributes nothing
  }
  for (const entry of entries) {
    const path = join(abs, entry.name);
    if (entry.isDirectory()) {
      walk(path, include, exclude, out);
    } else if (entry.isFile()) {
      const posix = toPosix(path);
      if (include(entry.name) && !(exclude && exclude(posix))) out.push(path);
    }
  }
}

/// The repository-relative POSIX paths that feed `name`, sorted.
export function inputFiles(repo, name) {
  const set = INPUT_SETS[name];
  if (!set) throw new Error(`unknown input set: ${name}`);
  const out = [];
  for (const [root, include, exclude] of set.dirs) {
    walk(join(repo, toPosix(root)), include, exclude, out);
  }
  for (const file of set.files) out.push(join(repo, toPosix(file)));
  const rels = [...new Set(out.map((p) => toPosix(relative(repo, p))))];
  return rels.sort();
}

/// SHA-256 over the canonical stream described at the top of this file.
export function hashOf(repo, name) {
  const outer = createHash('sha256');
  for (const rel of inputFiles(repo, name)) {
    const inner = createHash('sha256').update(readFileSync(join(repo, rel))).digest('hex');
    outer.update(`${rel}\0${inner}\n`);
  }
  return outer.digest('hex');
}

export function currentHashes(repo) {
  return { adapter: hashOf(repo, 'adapter'), core: hashOf(repo, 'core') };
}

function gitCommit(repo) {
  try {
    const head = readFileSync(join(repo, '.git', 'HEAD'), 'utf8').trim();
    if (head.startsWith('ref: ')) {
      return readFileSync(join(repo, '.git', head.slice(5).trim()), 'utf8').trim();
    }
    return head;
  } catch {
    return 'unknown';
  }
}

/// Write the stamp. Called by build-native.mjs once both binaries are in place.
export function writeStamp(repo) {
  const hashes = currentHashes(repo);
  const builtAt = new Date().toISOString();
  const commit = gitCommit(repo);
  const stamp = { version: 1 };
  for (const name of ['adapter', 'core']) {
    stamp[name] = { hash: hashes[name], built_at: builtAt, git_commit: commit };
  }
  const path = join(repo, STAMP_PATH);
  writeFileSync(path, `${JSON.stringify(stamp, null, 2)}\n`);
  return { path, stamp, counts: { adapter: inputFiles(repo, 'adapter').length, core: inputFiles(repo, 'core').length } };
}

/// Compare the stamp against the sources on disk.
///
/// Returns `{ missing: true }` when nothing was ever built, or
/// `{ stale: [{ name, built_at }] }` for each binary whose inputs moved.
export function staleness(repo) {
  let stamp;
  try {
    stamp = JSON.parse(readFileSync(join(repo, STAMP_PATH), 'utf8'));
  } catch {
    return { missing: true, stale: [] };
  }
  const stale = [];
  for (const name of ['adapter', 'core']) {
    const recorded = stamp[name];
    if (!recorded || recorded.hash !== hashOf(repo, name)) {
      stale.push({ name, built_at: recorded?.built_at ?? 'unknown' });
    }
  }
  return { missing: false, stale };
}
