// Generate the session runtime's constants and compile the framework guest.
//
// Two steps that belong together because the second consumes the first: the
// guest is compiled against `assembly/runtime/layout.ts`, which the generator
// rewrites from session.json. Running them as one npm script is what keeps a
// stale constant table from reaching a guest.
//
// The dependency install is here for the same reason `build-examples.mjs`
// installs per example: a fresh clone has no node_modules. Doing it in the build
// rather than documenting it means `npm run build` is the whole first-run story.
//
// **Since the compiler became a vendored tarball, that install is the repo
// root's.** `tensionscript` is no longer a devDependency of this package: it is
// vendored by `scripts/vendor-compiler.mjs` into `.packs/` and declared once, at
// the root, so every `npm run` in the tree resolves the same binary by walking
// up to `<repo>/node_modules/.bin`. Installing here would be the shadowing copy
// the vendoring exists to remove — and a nearer `.bin` wins, so it would quietly
// compile the framework with a different compiler than the examples use.

import { spawnSync } from 'node:child_process';
import { existsSync, readFileSync } from 'node:fs';
import { dirname, join, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';

const here = dirname(fileURLToPath(import.meta.url));
const repo = resolve(here, '..');
const framework = join(repo, 'tension-framework');
const WIN = process.platform === 'win32';

function die(message) {
  console.error(`build-framework: ${message}`);
  process.exit(1);
}

function run(command, args, options = {}) {
  // `shell` is opt-in and only ever used for `npm`, which is a `.cmd` shim on
  // Windows and cannot be spawned without one. An absolute path to node.exe
  // must not go through the shell: `C:\Program Files\...` would be split on
  // the space.
  const result = spawnSync(command, args, { stdio: 'inherit', ...options });
  if (result.error) die(`${command}: ${result.error.message}`);
  if (result.status !== 0) die(`${command} ${args.join(' ')} failed (exit ${result.status})`);
}

const npm = (args, options = {}) => run('npm', args, { shell: WIN, ...options });

// 1. The generated constants and the asc flags.
run(process.execPath, [join(repo, 'scripts', 'gen-session.mjs'), ...process.argv.slice(2)]);

// 2. The guest's build dependencies.
//
// **Compare the version, do not merely look for the binary.** This guard used
// to be `if (!existsSync(compiler))`, which is satisfied forever by the first
// successful install: a `node_modules` older than a facade syntax change kept
// its compiler and the tree then failed with parse errors naming the *facade*,
// not the stale binary. That is exactly what happened — 0.7.1 installed on
// 2026-10-21 stayed in place while the source began using `@managed` struct
// field defaults on 2026-10-23, and 40 parse errors per example were blamed on
// the source for two weeks.
//
// The source of truth is the lockfile: it records the exact version `npm
// install` would produce, so comparing against it needs no semver range
// parser and no network. See docs/guard-discipline.md.
const COMPILER = '@yabgu_gm/tensionscript';
const ROOT_PACKAGE = 'package.json';
const ROOT_LOCK = 'package-lock.json';
const VENDOR_MANIFEST = '.packs/manifest.json';

/// What the **root** asks for, and what its lock resolved. `null` when the root
/// declares nothing — which means this tree has not been through
/// `npm run compiler:vendor`, and the message should say so rather than
/// installing something.
function declaredCompiler() {
  const manifest = JSON.parse(readFileSync(join(repo, ROOT_PACKAGE), 'utf8'));
  const spec = manifest.devDependencies?.[COMPILER] ?? null;
  if (spec === null) return null;

  const lockPath = join(repo, ROOT_LOCK);
  if (!existsSync(lockPath)) return { spec, lockedSpec: null, version: null };
  const lock = JSON.parse(readFileSync(lockPath, 'utf8'));
  const root = lock.packages?.[''] ?? {};
  return {
    spec,
    // What the lock records the root as asking for. If this disagrees with
    // `package.json`, the lock is stale — a bump from `compiler:vendor` that was
    // never installed — and the resolved version below describes a dependency
    // graph the manifest no longer asks for. The spec carries the commit (`-g<sha>`),
    // so this is also what catches two different compilers sharing a version.
    lockedSpec: root.devDependencies?.[COMPILER] ?? null,
    version: lock.packages?.[`node_modules/${COMPILER}`]?.version ?? null,
  };
}

/// The version actually installed at the root, or `null` when the package is absent.
function installedCompiler() {
  const manifest = join(repo, 'node_modules', ...COMPILER.split('/'), 'package.json');
  if (!existsSync(manifest)) return null;
  try {
    return JSON.parse(readFileSync(manifest, 'utf8')).version ?? null;
  } catch {
    return null;  // an unreadable manifest is treated as absent: reinstall
  }
}

/// The `tensionscript` this build will run, resolved the way `npm run` resolves
/// it: this package's `.bin` first, then up the tree to the repo root. Returned
/// as a path so it can be printed — "it built" is not evidence of *which*
/// compiler built it, and a leftover per-package install is exactly the failure
/// the vendoring removes.
function resolvedCompiler() {
  const name = WIN ? 'tensionscript.cmd' : 'tensionscript';
  for (const dir of [join(framework, 'node_modules', '.bin'), join(repo, 'node_modules', '.bin')]) {
    const candidate = join(dir, name);
    if (existsSync(candidate)) return candidate;
  }
  return null;
}

const wanted = declaredCompiler();
if (wanted === null) {
  die(`${ROOT_PACKAGE} does not declare ${COMPILER}\n` +
      '  run:  npm run compiler:vendor   (then npm install at the repo root)');
}

// A `file:` spec names a tarball `compiler:vendor` writes and `.gitignore`
// excludes, so a fresh clone has the declaration and not the artifact. Say that
// here, where the two commands that fix it can be named, rather than letting
// `npm install` fail with an ENOENT on a path the reader has never seen.
if (wanted.spec.startsWith('file:')) {
  const artifact = join(repo, wanted.spec.slice('file:'.length));
  if (!existsSync(artifact)) {
    die(`${ROOT_PACKAGE} points at ${wanted.spec}, which does not exist\n` +
        '  run:  npm run compiler:vendor   (packs the submodule into .packs/)\n' +
        '  then: npm install               (at the repo root)');
  }
}

const staleLock = wanted.lockedSpec !== wanted.spec;
const installed = installedCompiler();
const versionMismatch = wanted.version !== null && installed !== wanted.version;
const found = resolvedCompiler();

if (found === null || staleLock || versionMismatch) {
  const why = found === null ? 'not installed'
            : staleLock ? `the lock records ${wanted.lockedSpec ?? 'nothing'}, the root declares ${wanted.spec}`
            : `${installed} but the lock resolves ${wanted.version}`;
  console.log(`build-framework: ${COMPILER}: ${why} — installing at the repo root`);
  npm(['install', '--no-audit', '--no-fund'], { cwd: repo });
}

// Installing is not the proof; the version is. A guard that reinstalls and then
// trusts the reinstall to have worked is the same defect one level down.
//
// Re-read after installing rather than comparing against the value read before.
// `npm install` legitimately rewrites the lock when the manifest changed — that
// is the whole point of the `staleLock` branch above — so a post-install check
// against the *old* expectation would fail on success.
{
  const settled = declaredCompiler();
  const after = installedCompiler();
  if (settled.lockedSpec !== settled.spec) {
    die(`${ROOT_LOCK} records ${COMPILER} as ${settled.lockedSpec ?? 'absent'} after ` +
        `npm install, but ${ROOT_PACKAGE} declares ${settled.spec}\n` +
        '  A lockfile npm cannot satisfy means a corrupt lock or a missing tarball.');
  }
  if (settled.version !== null && after !== settled.version) {
    die(`${COMPILER} is ${after ?? 'absent'} after npm install, but ${ROOT_LOCK} resolves ` +
        `${settled.version} (${ROOT_PACKAGE} declares ${settled.spec})\n` +
        '  Delete node_modules at the repo root and run npm install again.');
  }
}

const compiler = resolvedCompiler();
if (compiler === null) die(`${COMPILER} is still not on the path after installing`);

// The path and the vendored artifact, printed every run: this is the line that
// answers "did the build use the vendored compiler?" without inference.
console.log(`build-framework: ${COMPILER} ${installed} from ${compiler}`);
if (existsSync(join(repo, VENDOR_MANIFEST))) {
  const vendored = JSON.parse(readFileSync(join(repo, VENDOR_MANIFEST), 'utf8'));
  console.log(`build-framework: vendored ${vendored.tarball} (${vendored.sha})`);
}

// 3. The framework guest itself.
npm(['run', 'build'], { cwd: framework });
