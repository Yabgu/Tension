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
import { join, sep } from 'node:path';

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
 * Assert that `bin`, inside the repository at `repo`, is the compiler this tree
 * vendored. Returns `{ version, tarball, sha }` so a caller can print what it
 * proved; throws {@link CompilerProvenanceError} otherwise.
 */
export function assertVendoredCompiler(repo, bin) {
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

  // The binary must be the installed package's own, not a shim that happens to sit
  // at the right path. `realpath` also covers the POSIX shim, which is a symlink.
  try {
    const realBin = realpathSync(bin);
    const realPkg = realpathSync(pkgDir);
    if (!realBin.startsWith(`${realPkg}${sep}`) && realBin !== realPkg) {
      problems.push(`  ${bin} resolves to ${realBin}, outside ${realPkg}`);
    }
  } catch (error) {
    problems.push(`  ${bin} does not resolve: ${error.message}`);
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
