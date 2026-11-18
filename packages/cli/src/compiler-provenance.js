/**
 * @fileoverview Is the compiler that would run the one this repository vendored?
 *
 * **One implementation, and it ships with the CLI.** The `tension` CLI is a
 * separate, published package, so it cannot import `scripts/lib/toolchain.mjs` —
 * that file does not exist in a user's `node_modules`. The dependency therefore
 * runs the other way: this module has no imports beyond `node:fs`/`node:path`,
 * `packages/cli` ships it in `src/`, and the repo-side resolver
 * (`scripts/lib/toolchain.mjs`) imports *it*. A second copy of the rule inside the
 * CLI was the alternative and it is exactly how two checks drift apart: the weaker
 * one keeps passing while the stronger one is tightened.
 *
 * **Presence is not provenance.** A registry `0.14.1` and the tarball packed from
 * `third_party/TensionScript` at the pinned commit carry the same version string,
 * so a version comparison passes the one case the vendoring exists to exclude.
 * What makes the statement true is the chain, and all of it must agree:
 *
 *   `.packs/manifest.json`          version V, tarball T
 *   root `package.json`             spec     = `file:.packs/T`
 *   root `package-lock.json`        resolved = `file:.packs/T`, version V
 *   installed `<pkg>/package.json`  version V
 *   `realpath(bin)`                 inside the installed package
 *
 * Cheap by construction: four JSON reads and a realpath, no spawn, no compile.
 *
 * Only meaningful **inside this repository**, where a pin exists. A project that
 * installed `@yabgu_gm/tensionscript` from npm into its own `node_modules` has no
 * `.packs` and no claim to make; `project.js` calls this for in-repo projects only.
 */

import { existsSync, readFileSync, realpathSync } from 'node:fs';
import { basename, dirname, join, sep } from 'node:path';

/** The compiler package. */
export const COMPILER_PACKAGE = '@yabgu_gm/tensionscript';

/** Thrown when the compiler that would run is not the vendored pin. */
export class CompilerProvenanceError extends Error {
  constructor(message, problems = []) {
    super(message);
    this.name = 'CompilerProvenanceError';
    this.problems = problems;
  }
}

/** Where `npm install` at the repository root puts the vendored package. */
export function compilerPackageDir(repo) {
  return join(repo, 'node_modules', ...COMPILER_PACKAGE.split('/'));
}

/**
 * The two commands that produce a compiler, named separately because they fail in
 * different situations: a fresh clone has no tarball (`compiler:vendor` packs the
 * submodule), and a tree with a tarball that was never installed needs
 * `npm install`. Naming only one sends half the readers to the wrong command, and
 * "run npm install" over a missing tarball fails with an ENOENT on a path they
 * have never seen.
 */
export function compilerFixCommands(repo) {
  return [
    '  a fresh clone has no tarball:     npm run compiler:vendor',
    `  a tarball that is not installed:  npm install              (at ${repo})`,
  ];
}

/** The vendored pin as recorded in the three files that have to agree. */
export function vendoredCompilerFacts(repo) {
  const readJson = (path) => {
    if (!existsSync(path)) return null;
    try {
      return JSON.parse(readFileSync(path, 'utf8'));
    } catch {
      return null;
    }
  };

  const manifest = readJson(join(repo, '.packs', 'manifest.json'));
  const lock = readJson(join(repo, 'package-lock.json'));
  const root = readJson(join(repo, 'package.json'));
  const pkgDir = compilerPackageDir(repo);
  const installed = readJson(join(pkgDir, 'package.json'));

  return {
    manifest,
    lockEntry: lock?.packages?.[`node_modules/${COMPILER_PACKAGE}`] ?? null,
    lockSpec: (lock?.packages?.[''] ?? {}).devDependencies?.[COMPILER_PACKAGE] ?? null,
    rootSpec: root?.devDependencies?.[COMPILER_PACKAGE] ?? null,
    installed,
    pkgDir,
  };
}

/**
 * The file a compiler invocation actually runs.
 *
 * Accepts what the resolvers produce — an invocation `{ command, prefix, path }`
 * or a bare path — and answers the **script**, not the launcher. `path` is the
 * package's own bin entry when the resolver found one (`<pkg>/bin/tensionscript.js`,
 * run through `process.execPath` on every platform); a bare path is either that
 * same file or an npm `.bin` shim.
 */
export function launchedFile(target) {
  if (typeof target === 'string') return target;
  if (target && typeof target === 'object') return target.path ?? target.prefix?.[0] ?? target.command;
  return '';
}

/**
 * Where an npm `.bin` shim points, or the shim itself when it cannot be followed.
 *
 * **This exists because a shim is not a symlink on Windows.** npm writes
 * `node_modules/.bin/tensionscript` as a symlink on POSIX — `realpath` lands inside
 * the package — and as three real files on Windows (`tensionscript`,
 * `tensionscript.cmd`, `tensionscript.ps1`), where `realpath` is the shim itself
 * and a "is this inside the package" test can never pass. That is not a reason to
 * loosen the assertion: it is a reason to look at what the shim *runs*.
 *
 *   POSIX    `realpathSync` follows the symlink; nothing else is needed.
 *   Windows  `tensionscript.cmd` is text, and the script it launches appears in it
 *            as `"%dp0%\..\@yabgu_gm\tensionscript\bin\tensionscript.js"`. Read
 *            that, resolve it against the shim's own directory.
 *
 * A shim that names no script (a wrapper someone else wrote) resolves to itself,
 * which fails the provenance check — correctly: this module can only prove the pin
 * for a compiler it can follow to a file.
 */
export function shimTarget(shim) {
  // Inside a package already: nothing to follow.
  const dir = dirname(shim);
  if (basename(dir) !== '.bin') {
    try {
      return realpathSync(shim);
    } catch {
      return shim;
    }
  }
  // POSIX: the shim is a symlink whose realpath is the script.
  try {
    const real = realpathSync(shim);
    if (real !== shim) return real;
  } catch {
    // fall through to the text read: a Windows `.cmd` is a real file
  }
  try {
    const text = readFileSync(shim, 'utf8');
    const match = text.match(/"%dp0%\\?([^"]+?\.(?:c|m)?js)"/i) ||
                  text.match(/%~dp0([^\s"]+?\.(?:c|m)?js)/i);
    if (match) {
      // The shim is Windows text: its path is backslash-separated regardless of
      // the platform reading it (this parser is exercised on Linux too, where a
      // literal `..\@yabgu_gm\…` would otherwise be one long filename).
      const rel = match[1].replace(/^[\\/]+/, '').split(/[\\/]+/).join('/');
      return join(dir, rel);
    }
  } catch {
    // unreadable: it is not a shim we can prove anything about
  }
  return shim;
}

/**
 * Assert that `target`, inside the repository at `repo`, is the compiler this tree
 * vendored. Returns `{ version, tarball, sha }` so a caller can print what it
 * proved; throws {@link CompilerProvenanceError} otherwise.
 *
 * `target` is a compiler invocation (`{ command, prefix, path }`) or a bare path;
 * see {@link launchedFile}. Prefer the invocation the resolver produces — the
 * package's own `bin` entry, which is a file inside the package on every platform
 * and therefore the only thing this check can verify without guessing.
 */
export function assertVendoredCompiler(repo, target) {
  const { manifest, lockEntry, lockSpec, rootSpec, installed, pkgDir } =
    vendoredCompilerFacts(repo);

  const problems = [];
  if (!manifest) problems.push('  .packs/manifest.json is missing or unreadable');
  if (!installed) problems.push(`  ${COMPILER_PACKAGE} is not installed at ${pkgDir}`);
  if (!lockEntry) {
    problems.push(`  package-lock.json has no node_modules/${COMPILER_PACKAGE} entry`);
  }
  if (problems.length) {
    throw new CompilerProvenanceError([
      `the vendored TensionScript compiler is not installed at ${repo}`,
      ...problems,
      ...compilerFixCommands(repo),
    ].join('\n'), problems);
  }

  const version = manifest.version;
  const tarball = manifest.tarball;
  const wantSpec = `file:.packs/${tarball}`;

  if (rootSpec !== wantSpec) {
    problems.push(`  package.json declares  ${rootSpec ?? '(nothing)'}, the manifest says ${wantSpec}`);
  }
  if (lockSpec !== wantSpec) {
    problems.push(`  the lock records spec   ${lockSpec ?? '(nothing)'}, the manifest says ${wantSpec}`);
  }
  if (lockEntry.resolved !== wantSpec) {
    // The one comparison that rules out a registry install at the same version.
    problems.push(`  the lock resolved       ${lockEntry.resolved}, the manifest says ${wantSpec}`);
  }
  if (lockEntry.version !== version) {
    problems.push(`  the lock resolves       ${COMPILER_PACKAGE} ${lockEntry.version}, the manifest is ${version}`);
  }
  if (installed.version !== version) {
    problems.push(`  installed               ${COMPILER_PACKAGE} ${installed.version}, the manifest is ${version}`);
  }

  // The compiler that runs must be the installed package's own file, not something
  // else that happens to sit at a plausible path. `shimTarget` is what makes this
  // meaningful on Windows, where the `.bin` shim is a real file rather than a
  // symlink into the package.
  const launched = launchedFile(target);
  try {
    const realBin = shimTarget(launched);
    const realPkg = realpathSync(pkgDir);
    if (!realBin.startsWith(`${realPkg}${sep}`) && realBin !== realPkg) {
      problems.push(`  ${launched} runs ${realBin}, outside ${realPkg}`);
    }
  } catch (error) {
    problems.push(`  ${launched} does not resolve: ${error.message}`);
  }

  if (problems.length) {
    throw new CompilerProvenanceError([
      'the compiler that would run is NOT the vendored pin:',
      ...problems,
      '',
      `  re-vendor and install:  npm run compiler:vendor && npm install   (at ${repo})`,
    ].join('\n'), problems);
  }
  return { version, tarball, sha: manifest.sha };
}

/**
 * Whether `dir` is inside the repository at `repo`.
 *
 * Path-prefix, not string-prefix: `/repo-other` must not look like a child of
 * `/repo`, and on Windows the separator and case differ from how a caller spelled
 * the path.
 */
export function isInside(repo, dir) {
  if (!repo || !dir) return false;
  try {
    const realRepo = realpathSync(repo);
    const realDir = realpathSync(dir);
    return realDir === realRepo || realDir.startsWith(`${realRepo}${sep}`);
  } catch {
    return false;
  }
}
