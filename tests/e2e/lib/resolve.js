// Where the pieces live: the interpreter under test and the debugger.
//
// The runner is invoked from the repository root (`node tests/e2e/runner.js`),
// but every path is derived from this file's own location so a test can be
// started from anywhere.

import fs from "node:fs";
import { createRequire } from "node:module";
import path from "node:path";
import { fileURLToPath } from "node:url";

const here = path.dirname(fileURLToPath(import.meta.url));

/// Resolution for packages installed under `tests/e2e/`, not for this module's
/// own dependencies — there are none beyond Node built-ins.
const localRequire = createRequire(import.meta.url);

/// `tests/e2e/lib` -> the repository root.
export const repoRoot = path.resolve(here, "..", "..", "..");

export const examplesRoot = path.join(repoRoot, "examples");
export const configRoot = path.join(here, "..", "config");

/**
 * The `tension-core` binary to spawn.
 *
 * `--release` is preferred because a debug build of an interpreter that embeds
 * Wasmtime is large and slow to start; both are listed because which one exists
 * depends on what was last built, and a test that refuses to run because the
 * developer built only one of them is a test nobody runs.
 *
 * A path is also accepted from `TENSION_CORE`, so CI can point at an artifact
 * it built elsewhere.
 */
export function resolveTensionCore() {
  const override = process.env.TENSION_CORE;
  const candidates = override
    ? [path.resolve(override)]
    : [
        path.join(repoRoot, "tension-core", "target", "release", "tension-core"),
        path.join(repoRoot, "tension-core", "target", "debug", "tension-core"),
        path.join(repoRoot, "target", "release", "tension-core"),
        path.join(repoRoot, "target", "debug", "tension-core"),
      ];

  const found = candidates.find((candidate) => fs.existsSync(candidate));
  if (!found) {
    throw new Error(
      `tension-core binary not found. Build it first:\n` +
        `  cargo build --manifest-path tension-core/Cargo.toml --release\n` +
        `looked in:\n${candidates.map((candidate) => `  ${candidate}`).join("\n")}`
    );
  }
  return { path: found, release: found.includes(`${path.sep}release${path.sep}`) };
}

/// `which`-style lookup over `PATH`. Returns `null` when absent, so callers can
/// skip with a named reason instead of failing.
export function which(name) {
  const pathValue = process.env.PATH ?? "";
  for (const dir of pathValue.split(path.delimiter)) {
    if (!dir) continue;
    const candidate = path.join(dir, name);
    try {
      fs.accessSync(candidate, fs.constants.X_OK);
      return candidate;
    } catch {
      // keep looking
    }
  }
  return null;
}

/// lldb's executable name varies by distribution; try the names this project's
/// machines have used.
function lldbOnPath() {
  for (const name of ["lldb", "lldb-22", "lldb-21", "lldb-20", "lldb-19"]) {
    const found = which(name);
    if (found) return found;
  }
  return null;
}

/// The `@debugmcp/codelldb-*` package name for this host, or `null` for a
/// platform the package family does not publish.
export function codelldbPackageName(platform = process.platform, arch = process.arch) {
  const supported = ["linux-x64", "linux-arm64", "darwin-x64", "darwin-arm64", "win32-x64"];
  const candidate = `${platform}-${arch}`;
  return supported.includes(candidate) ? `@debugmcp/codelldb-${candidate}` : null;
}

/**
 * lldb, looked for in the order the two sources deserve.
 *
 * 1. `PATH`. A developer who installed lldb on purpose should get that one —
 *    it matches the debug info their system tools produce.
 * 2. `@debugmcp/codelldb-*` under `tests/e2e/node_modules`. This is what makes
 *    debug mode runnable on a machine with no system lldb: the same package
 *    family and version TensionScript uses, installed locally so this repo does
 *    not reach into a sibling checkout. Resolving it from
 *    `~/work/TensionScript` would couple the two repos, which is exactly what
 *    the local install avoids.
 *
 * Returns `{ path, source }` or `{ path: null, source: null, packageName }` —
 * the caller needs the package name to say what to install.
 */
export function resolveLldb() {
  const system = lldbOnPath();
  if (system) return { path: system, source: "which" };

  const packageName = codelldbPackageName();
  if (!packageName) return { path: null, source: null, packageName: null };

  let manifestPath;
  try {
    manifestPath = localRequire.resolve(`${packageName}/package.json`);
  } catch {
    return { path: null, source: null, packageName };
  }

  // The package ships `lldb/bin/lldb` (`.exe` on Windows). Both names are
  // tried rather than branching on platform: which one exists is a fact on
  // disk, and a guess here would fail silently on the platform we cannot test.
  const packageRoot = path.dirname(manifestPath);
  for (const name of ["lldb", "lldb.exe"]) {
    const candidate = path.join(packageRoot, "lldb", "bin", name);
    if (fs.existsSync(candidate)) return { path: candidate, source: "npm" };
  }
  return { path: null, source: null, packageName };
}

/// The sentence a skip prints when debug mode has no debugger to drive.
export function lldbSkipReason(resolved) {
  if (resolved.packageName) {
    return (
      `lldb not on PATH and ${resolved.packageName} not installed — ` +
      `run \`npm install\` in tests/e2e/`
    );
  }
  return "lldb not on PATH and no @debugmcp/codelldb package exists for this platform";
}

/**
 * Directories holding the OGRE capability's shared objects.
 *
 * `tension-core` itself does not link OGRE — the capability is a `.so` the host
 * loads on demand — but `libtension_ogre.so` needs `libOgreNext*.so.4.0`, which
 * lives under `third_party/` and is not on the default loader path. Runs set
 * `LD_LIBRARY_PATH` the way the examples' own scripts do; without it the OGRE
 * examples fail with "error while loading shared libraries", which would look
 * like a product defect instead of a checkout that was never wired up.
 */
export function libraryPath() {
  const dirs = [
    path.join(repoRoot, "third_party", "ogre-next-install", "lib"),
    path.join(repoRoot, "tension-ogre", "build"),
    path.join(repoRoot, "tension-input", "build"),
    path.join(repoRoot, "tension-framework", "build"),
  ].filter((dir) => fs.existsSync(dir));

  const inherited = process.env.LD_LIBRARY_PATH;
  return inherited ? [inherited, ...dirs].join(path.delimiter) : dirs.join(path.delimiter);
}
