// Where the pieces live: the interpreter under test and the debugger.
//
// The runner is invoked from the repository root (`node tests/e2e/runner.js`),
// but every path is derived from this file's own location so a test can be
// started from anywhere.

import fs from "node:fs";
import path from "node:path";
import { fileURLToPath } from "node:url";

const here = path.dirname(fileURLToPath(import.meta.url));

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
export function resolveLldb() {
  for (const name of ["lldb", "lldb-22", "lldb-21", "lldb-20", "lldb-19"]) {
    const found = which(name);
    if (found) return found;
  }
  return null;
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
