// Bootstrap the pinned Ogre-Next when the in-tree install is missing.
//
// `build:native` consumes `third_party/ogre-next-install`: it copies the
// libraries, headers and media into a platform payload package, and links the
// adapter against them. That install is a build product of the pinned
// submodules, not something a checkout carries, so a fresh clone does not have
// it. `npm run build` runs the bootstrap itself, once, and continues.
//
// The pre-check mirrors the bootstrap's own "is installed" test: main library,
// Media tree, Vulkan render system. A false negative costs one no-op
// bootstrap run (the script is idempotent); a false positive would let a
// half-built install through to fail later inside the C++ compile, which is
// the expensive direction to be wrong.
//
// Nothing here runs on an install that is already complete, so the steady-state
// cost is a few stat calls and a short walk of the usual plugin directories.

import { spawnSync } from 'node:child_process';
import { existsSync, readdirSync, statSync } from 'node:fs';
import { delimiter, dirname, join, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';

const here = dirname(fileURLToPath(import.meta.url));
const repo = resolve(here, '..');

const OGRE_INSTALL = join(repo, 'third_party', 'ogre-next-install');
const BOOTSTRAP = join(repo, 'scripts', 'bootstrap.mjs');
const WIN = process.platform === 'win32';

function isDirectory(path) {
  try {
    return statSync(path).isDirectory();
  } catch {
    return false;
  }
}

/// First entry under `root` whose basename satisfies `match`, or null.
/// The install's plugin directory is not worth hard-coding: OGRE puts the
/// render systems under `lib/OGRE-Next` on Linux and `bin/` on Windows, and a
/// relocated package can differ again. the bootstrap itself searches the whole
/// prefix for `RenderSystem_Vulkan.*`, so this does too.
///
/// `match` receives the name lowercased. Windows artifacts are not spelled
/// consistently — a DLL may be capitalised — and a case-sensitive compare would
/// report a good install as missing.
function findMatching(root, match) {
  let entries;
  try {
    entries = readdirSync(root, { withFileTypes: true });
  } catch {
    return null;
  }
  for (const entry of entries) {
    const path = join(root, entry.name);
    if (entry.isDirectory()) {
      const found = findMatching(path, match);
      if (found) return found;
    } else if (match(entry.name.toLowerCase())) {
      return path;
    }
  }
  return null;
}

/// The main library, in whichever layout this platform installs it. Linux:
/// `lib/libOgreNextMain.so` beside its symlink chain. Windows: the import
/// library in `lib/Release/` and the DLL in `bin/Release/`. Ask for the
/// artifact rather than for one platform's spelling of the path.
function hasMainLibrary(prefix) {
  const match = (name) =>
    /^(lib)?ogrenextmain\.(dll|dll\.a|so|lib)$/.test(name) ||
    /^libogrenextmain\.so\.\d/.test(name);
  for (const dir of ['lib', 'bin']) {
    if (findMatching(join(prefix, dir), match)) return true;
  }
  return findMatching(prefix, match) !== null;
}

/// The media tree: `share/OGRE-Next/Media` on Linux, `Media/` at the prefix
/// root on Windows. Either is what the Hlms needs.
function hasMedia(prefix) {
  return isDirectory(join(prefix, 'share', 'OGRE-Next', 'Media')) ||
         isDirectory(join(prefix, 'Media'));
}

function hasVulkanPlugin(prefix) {
  const match = (name) => name.startsWith('rendersystem_vulkan.');
  // Normal installs put the render systems here. Trying these first keeps the
  // check from walking the install's 144 MB Media tree on every build.
  for (const dir of [join('lib', 'OGRE-Next'), join('bin', 'OGRE-Next'), 'lib', 'bin']) {
    if (findMatching(join(prefix, dir), match)) return true;
  }
  // A relocated install can put them elsewhere; the bootstrap searches the whole
  // prefix, so fall back to that rather than mistaking a usable install for a
  // missing one.
  return findMatching(prefix, match) !== null;
}


/// What the install is missing, as short reasons. Empty means it is complete
/// enough for `build:native` to consume. Paths are injectable so the detector
/// can be exercised without touching the real install.
export function bootstrapProblems(ogre = OGRE_INSTALL) {
  const problems = [];
  if (!hasMainLibrary(ogre)) problems.push('no OgreNextMain library');
  if (!hasMedia(ogre)) problems.push('no Media tree');
  if (!hasVulkanPlugin(ogre)) problems.push('no Vulkan render system');
  return problems;
}

function runBootstrap({ bootstrap, repoRoot }) {
  // Node on every platform: the bootstrap is a Node script now, so it needs no
  // shell, no MSYS2 wrapper and no TENSION_BASH override. It assembles its own
  // toolchain environment (scripts/lib/toolchain.mjs).
  return spawnSync(process.execPath, [bootstrap], {
    cwd: repoRoot,
    stdio: 'inherit',
    env: { ...process.env, DONT_SHOW_UI_ERRORS: process.env.DONT_SHOW_UI_ERRORS ?? '1' },
  });
}

/// Make sure the install exists, bootstrapping it when it does not. `note` and
/// `fail` are `build-native.mjs`'s reporters, so the output keeps that script's
/// prefix and exit path.
export function ensureOgre({
  note = (message) => console.log(`build-native: ${message}`),
  fail = (message) => {
    console.error(`build-native: ${message}`);
    process.exit(1);
  },
  ogre = OGRE_INSTALL,
  bootstrap = BOOTSTRAP,
  repoRoot = repo,
} = {}) {
  const missing = bootstrapProblems(ogre);
  if (missing.length === 0) return;

  note(`OGRE-Next is not built yet (${missing.join(', ')})`);
  note('running scripts/bootstrap.mjs (one-time build, a few minutes)');
  const result = runBootstrap({ bootstrap, repoRoot });
  if (result.error) {
    fail(`could not start scripts/bootstrap.mjs: ${result.error.message}`);
  }
  if (result.status !== 0) {
    const why = result.signal ? `signal ${result.signal}` : `exit ${result.status}`;
    fail(`scripts/bootstrap.mjs failed (${why}); see its output above`);
  }

  const still = bootstrapProblems(ogre);
  if (still.length) {
    fail(`bootstrap finished but the install is still incomplete (${still.join(', ')})`);
  }
  note('OGRE-Next is ready');
}
