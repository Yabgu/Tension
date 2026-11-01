#!/usr/bin/env node
// Populate the native packages under packages/ from this repository's build.
//
// Four packages are shipped as directories and consumed by the examples through
// `file:` dependencies, which npm resolves as symlinks. Nothing here packs a
// tarball: the packages are the source of truth for what they contain, and
// `packages/*/package.json` + `files` say which parts travel if one ever is
// packed. Everything this script writes is gitignored.
//
// Run it once after a clone (`npm run build:native`), before `npm run build`.
//
//   @yabgu_gm/tension-ogre-next   third_party/ogre-next-install, sample assets pruned
//   @yabgu_gm/tension-freeimage   third_party/freeimage-install
//   @yabgu_gm/tension-ogre        tension-ogre/build.sh, linked against the package
//   @yabgu_gm/tension-core        cargo build --release
//
// Pruning is the one judgement here: Ogre's install is 170 MB and 144 MB of it
// is sample content (volumeTerrain, materials, models, packs, 2.0). Nothing in
// Tension reads those — measured: all 18 --ogre-guest cases pass and the
// animated-character example runs with only Hlms/, Compute/, VCT/, particle/
// and the cfgs. See packages/ogre-next/README.md.

import { spawnSync } from 'node:child_process';
import { cpSync, existsSync, lstatSync, mkdirSync, readdirSync, rmSync } from 'node:fs';
import { dirname, join, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';

const here = dirname(fileURLToPath(import.meta.url));
const repo = resolve(here, '..');
const packages = join(repo, 'packages');

const OGRE_SRC = join(repo, 'third_party', 'ogre-next-install');
const FREEIMAGE_SRC = join(repo, 'third_party', 'freeimage-install');

/// Ogre's sample content. Removed from the package; see the README for the
/// measurement that says nothing reads them.
const OGRE_SAMPLE_ASSETS = ['volumeTerrain', 'materials', 'models', 'packs', '2.0'];

function fail(message) {
  console.error(`build-native: ${message}`);
  process.exit(1);
}

function note(message) {
  console.log(`build-native: ${message}`);
}

/// Copy a directory, **preserving symlinks**.
///
/// `dereference: true` is the trap here: a shared library ships as
/// `libFoo.so -> libFoo.so.4.0 -> libFoo.so.4.0.0` and dereferencing turns one
/// 9 MB file into three 9 MB files. First run of this script produced a 26 MB
/// freeimage package from an 8.7 MB install, and a 29 MB ogre-next lib/ from
/// 15 MB, for exactly that reason. The links are relative, so they stay valid
/// inside the package.
function copyTree(from, to) {
  rmSync(to, { recursive: true, force: true });
  mkdirSync(dirname(to), { recursive: true });
  cpSync(from, to, { recursive: true, dereference: false, verbatimSymlinks: true });
}

/// Size in bytes, recursively. Used for the budget report at the end.
///
/// `lstatSync`, not `statSync`: a shared library ships as a chain of relative
/// symlinks, and following them counts the same megabytes once per link. The
/// first version of this function reported freeimage as 25.8 MB when its
/// contents are 8.7 MB.
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

// ── ogre-next ────────────────────────────────────────────────────────────────
if (!existsSync(join(OGRE_SRC, 'lib', 'libOgreNextMain.so'))) {
  fail(`no Ogre-Next install at ${OGRE_SRC}\n` +
       `  build it first: third_party/bootstrap.sh`);
}
note('ogre-next: copying lib/, include/, Media/ (sample assets pruned)');
copyTree(join(OGRE_SRC, 'lib'), join(packages, 'ogre-next', 'lib'));
copyTree(join(OGRE_SRC, 'include'), join(packages, 'ogre-next', 'include'));
for (const name of ['Hlms', 'Compute', 'VCT', 'particle']) {
  const from = join(OGRE_SRC, 'share', 'OGRE-Next', 'Media', name);
  if (existsSync(from)) copyTree(from, join(packages, 'ogre-next', 'Media', name));
}
// The cfgs name plugins and resource locations; Ogre reads them from beside the
// media when a caller points at it.
for (const cfg of readdirSync(join(OGRE_SRC, 'share', 'OGRE-Next'))) {
  if (cfg.endsWith('.cfg')) {
    cpSync(join(OGRE_SRC, 'share', 'OGRE-Next', cfg),
           join(packages, 'ogre-next', 'Media', cfg));
  }
}
for (const name of OGRE_SAMPLE_ASSETS) {
  if (existsSync(join(packages, 'ogre-next', 'Media', name))) {
    fail(`sample asset "${name}" leaked into the package; pruning is broken`);
  }
}

// ── freeimage ────────────────────────────────────────────────────────────────
if (existsSync(FREEIMAGE_SRC)) {
  note('freeimage: copying lib/, include/');
  copyTree(join(FREEIMAGE_SRC, 'lib'), join(packages, 'freeimage', 'lib'));
  if (existsSync(join(FREEIMAGE_SRC, 'include'))) {
    copyTree(join(FREEIMAGE_SRC, 'include'), join(packages, 'freeimage', 'include'));
  }
} else {
  note('freeimage: no third_party/freeimage-install — skipped');
}

// ── the adapter ──────────────────────────────────────────────────────────────
// Built against the *package* rather than third_party/, so the binary that ships
// is the binary that was tested. TENSION_OGRE_PREFIX is the branch build.sh uses
// for a relocated install.
note('ogre: building the adapter against packages/ogre-next');
const built = spawnSync('bash', [join(repo, 'tension-ogre', 'build.sh')], {
  cwd: repo,
  stdio: 'inherit',
  env: { ...process.env, TENSION_OGRE_PREFIX: join(packages, 'ogre-next') },
});
if (built.status !== 0) fail(`the adapter did not build (exit ${built.status})`);
const adapter = join(repo, 'tension-ogre', 'build', 'libtension_ogre.so');
if (!existsSync(adapter)) fail(`build.sh reported success but ${adapter} is missing`);
cpSync(adapter, join(packages, 'ogre', 'lib', 'libtension_ogre.so'));

// ── core ─────────────────────────────────────────────────────────────────────
note('core: cargo build --release');
const cargo = spawnSync('cargo', ['build', '--release'], {
  cwd: join(repo, 'tension-core'),
  stdio: 'inherit',
});
if (cargo.status !== 0) fail(`cargo build --release failed (exit ${cargo.status})`);
const coreBin = join(repo, 'tension-core', 'target', 'release', 'tension-core');
if (!existsSync(coreBin)) fail(`cargo reported success but ${coreBin} is missing`);
const dest = join(packages, 'core', 'bin', 'tension-core');
mkdirSync(dirname(dest), { recursive: true });
cpSync(coreBin, dest);
// npm runs `bin` entries by exec; the copy has to keep the mode cargo gave it.
spawnSync('chmod', ['755', dest]);

// ── budget ───────────────────────────────────────────────────────────────────
// These are the thresholds the packages were given. A number over budget is a
// report, not a failure: it means something unexpected is being copied and
// wants a look, which is cheaper to see here than in a consumer's tree.
const BUDGET = {
  'packages/core/bin/tension-core': 50,
  'packages/ogre-next': 30,
  'packages/freeimage': 15,
  'packages/ogre/lib/libtension_ogre.so': 10,
};
console.log('');
let over = 0;
for (const [rel, limit] of Object.entries(BUDGET)) {
  const bytes = du(join(repo, rel));
  const state = bytes / (1024 * 1024) > limit ? `OVER BUDGET (${limit} MB)` : 'ok';
  if (state !== 'ok') over++;
  console.log(`  ${rel.padEnd(42)} ${mb(bytes).padStart(8)}  ${state}`);
}
console.log(`  ${'packages/ (total)'.padEnd(42)} ${mb(du(packages)).padStart(8)}`);
if (over) {
  console.log(`\nbuild-native: ${over} package(s) over budget — see the notes in packages/*/README.md`);
}
