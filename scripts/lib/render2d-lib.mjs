// Where the C++ `tension::2d` adapter (the `--capability` DSO) is, and whether
// it is current.
//
// # Why this is one module and not four copies
//
// Every suite that loads the adapter was asking the same question —
// `existsSync(dso)` — and answering it the way gate finding 8 describes: an
// artifact that *exists* was taken as an artifact that is *right*. A DSO built
// six days before an IWI grammar change exists, loads, and decodes with the old
// reader; the suite that loads it is then green or red about a renderer this
// tree no longer has, depending only on which files happen to be on disk.
//
// So the check lives here once: a DSO older than the newest source
// `scripts/build-2d.mjs --cpp` compiles into it is refused by name, with both
// dates and the rebuild command. `scripts/test-framework.mjs` and the example
// suites all call this, so the rule cannot be present in four spellings and
// absent from a fifth.
//
// # Missing is not the same as stale
//
// The example suites run against the in-core renderer when there is no DSO at
// all — that is a supported configuration, and `required: false` says so. A
// *stale* DSO is never supported: it is a renderer the tree replaced, still on
// the disk, still preferred over the in-core one when the host falls back to the
// DSO build.

import { existsSync, readdirSync, statSync } from 'node:fs';
import { extname, join, relative } from 'node:path';

/// The newest source the C++ adapter is built from, by mtime.
///
/// The roots are `scripts/build-2d.mjs`'s own include paths and translation
/// units. Walking them here rather than listing files keeps the check honest
/// when a source is added: a new file under one of these roots is covered
/// without editing this function. `null` when nothing is found, which cannot
/// happen in a checkout that also has the artifact.
export function newestRender2dSource(repo) {
  const roots = [
    join(repo, 'tension-2d', 'reference'),
    join(repo, 'tension-2d', 'include'),
    join(repo, 'tension-core', 'include'),
    join(repo, 'third_party', 'ImageViewer', 'src', 'format'),
    join(repo, 'third_party', 'ImageViewer', 'src', 'imageviewer'),
  ];
  const extensions = new Set(['.cpp', '.cc', '.c', '.h', '.hpp', '.ixx', '.inl']);
  let newest = null;
  const walk = (dir) => {
    let entries;
    try {
      entries = readdirSync(dir, { withFileTypes: true });
    } catch {
      return;
    }
    for (const entry of entries) {
      const path = join(dir, entry.name);
      if (entry.isDirectory()) {
        walk(path);
      } else if (extensions.has(extname(entry.name))) {
        const mtimeMs = statSync(path).mtimeMs;
        if (!newest || mtimeMs > newest.mtimeMs) newest = { path, mtimeMs };
      }
    }
  };
  for (const root of roots) walk(root);
  return newest;
}

/// Where the adapter is, or `null` when `required` is false and it is absent.
///
/// Throws an [`Error`] whose `message` is the failure a suite should print, for
/// the two cases that are never a skip: an artifact that is missing when the
/// suite needs it, and an artifact older than its sources. `TENSION_2D_LIB`
/// overrides the path (a harness variable, not a release-binary one — see
/// `docs/backlog/env-var-audit.md`); it is still held to the staleness rule.
export function render2dDso(repo, { required = true, env = process.env } = {}) {
  const candidate =
    env.TENSION_2D_LIB ??
    join(repo, 'tension-2d', 'build', `libtension_2d${process.platform === 'win32' ? '.dll' : '.so'}`);
  if (!existsSync(candidate)) {
    if (!required) return null;
    throw new Error(
      `no tension::2d library at ${candidate}\n` +
        `build it with: node scripts/build-2d.mjs --cpp\n` +
        `(this suite asserts on a real frame; it no longer skips when the DSO is absent)`,
    );
  }
  const built = statSync(candidate).mtimeMs;
  const newest = newestRender2dSource(repo);
  if (newest && built < newest.mtimeMs) {
    throw new Error(
      `the tension::2d library is older than the sources it was built from\n` +
        `artifact: ${relative(repo, candidate)} (${new Date(built).toISOString()})\n` +
        `newest source: ${relative(repo, newest.path)} (${new Date(newest.mtimeMs).toISOString()})\n` +
        `rebuild it with: node scripts/build-2d.mjs --cpp\n` +
        `(a stale DSO measures a renderer this tree no longer has — gate finding 8)`,
    );
  }
  return candidate;
}
