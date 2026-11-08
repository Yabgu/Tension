// Generate the session runtime's constants and compile the framework guest.
//
// Two steps that belong together because the second consumes the first: the
// guest is compiled against `assembly/runtime/layout.ts`, which the generator
// rewrites from session.json. Running them as one npm script is what keeps a
// stale constant table from reaching a guest.
//
// The dependency install is here for the same reason `build-examples.mjs`
// installs per example: `tensionscript` is a devDependency of this package, and
// a fresh clone has no node_modules. Doing it in the build rather than
// documenting it means `npm run build` is the whole first-run story.

import { spawnSync } from 'node:child_process';
<<<<<<< HEAD
import { existsSync, readFileSync } from 'node:fs';
=======
import { existsSync } from 'node:fs';
>>>>>>> origin/main
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
<<<<<<< HEAD
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
const DEP_PACKAGE = 'tension-framework/package.json';
const DEP_LOCK = 'tension-framework/package-lock.json';

/// The `tensionscript` package this package declares, and the version the lock
/// resolves it to. `null` when nothing is declared or there is no lock — both
/// mean "fall back to installing".
function declaredCompiler() {
  const manifest = JSON.parse(readFileSync(join(framework, 'package.json'), 'utf8'));
  const sections = [manifest.dependencies, manifest.devDependencies];
  const name = 'tensionscript';
  const declared = sections
    .filter(Boolean)
    .flatMap((section) => Object.entries(section))
    .find(([key]) => key === name || key.endsWith(`/${name}`));
  if (!declared) return null;

  const [packageName, range] = declared;
  const lockPath = join(framework, 'package-lock.json');
  if (!existsSync(lockPath)) return { packageName, range, locked: null, lockRange: null };
  const lock = JSON.parse(readFileSync(lockPath, 'utf8'));
  const entry = lock.packages?.[`node_modules/${packageName}`];
  // What the lock *recorded* as declared. If this disagrees with package.json,
  // the lock is stale — edited manifest, unrefreshed lock — and the resolved
  // version below describes a dependency graph the manifest no longer asks for.
  const root = lock.packages?.[''] ?? {};
  const lockRange = { ...root.dependencies, ...root.devDependencies }[packageName] ?? null;
  return { packageName, range, locked: entry?.version ?? null, lockRange };
}

/// The version actually installed, or `null` when the package is absent.
function installedCompiler(packageName) {
  const manifest = join(framework, 'node_modules', ...packageName.split('/'), 'package.json');
  if (!existsSync(manifest)) return null;
  try {
    return JSON.parse(readFileSync(manifest, 'utf8')).version ?? null;
  } catch {
    return null;  // an unreadable manifest is treated as absent: reinstall
  }
}

const wanted = declaredCompiler();
const compiler = join(framework, 'node_modules', '.bin',
                      WIN ? 'tensionscript.cmd' : 'tensionscript');
const have = wanted ? installedCompiler(wanted.packageName) : (existsSync(compiler) ? 'unknown' : null);
const expect = wanted?.locked ?? null;
// A lock whose recorded range has drifted from the manifest resolves a graph
// nobody asked for. `npm install` reads the manifest and rewrites the lock, so
// treating it as "needs installing" is what refreshes both.
const staleLock = wanted !== null && wanted.lockRange !== null && wanted.lockRange !== wanted.range;

if (!existsSync(compiler) || staleLock || (expect !== null && have !== expect)) {
  const why = !existsSync(compiler) ? 'not installed'
            : staleLock ? `lock records ${wanted.lockRange}, manifest declares ${wanted.range}`
            : `${have} but the lock resolves ${expect}`;
  console.log(`build-framework: ${wanted?.packageName ?? 'tensionscript'}: ${why} — installing`);
  npm(['install', '--no-audit', '--no-fund'], { cwd: framework });
}

// Installing is not the proof; the version is. A guard that reinstalls and then
// trusts the reinstall to have worked is the same defect one level down.
//
// Re-read the lock after installing, rather than comparing against the value
// read before. `npm install` legitimately rewrites the lock when the manifest
// changed — that is the whole point of the `staleLock` branch above — so a
// post-install check against the *old* expectation would fail on success. This
// was a real bug in the first version of this guard, caught by probing it with
// a declared downgrade.
if (wanted !== null) {
  const settled = declaredCompiler();
  const after = installedCompiler(settled.packageName);
  if (settled.locked === null) {
    die(`${settled.packageName} has no resolved version in ${DEP_LOCK} after ` +
        `npm install (${DEP_PACKAGE} declares ${settled.range})\n` +
        '  Check that the range names a version that exists in the registry.');
  }
  if (after !== settled.locked) {
    die(`${settled.packageName} is ${after ?? 'absent'} after npm install, ` +
        `but ${DEP_LOCK} resolves ${settled.locked} (${DEP_PACKAGE} declares ${settled.range})\n` +
        '  A lockfile that npm cannot satisfy means a corrupt lock, a registry\n' +
        '  mismatch, or a node_modules tree npm refuses to repair. Delete\n' +
        '  tension-framework/node_modules and run npm install again.');
  }
  console.log(`build-framework: ${settled.packageName} ${after} matches the lock`);
}

=======
const compiler = join(framework, 'node_modules', '.bin',
                      WIN ? 'tensionscript.cmd' : 'tensionscript');
if (!existsSync(compiler)) {
  console.log('build-framework: installing tension-framework dependencies');
  npm(['install', '--no-audit', '--no-fund'], { cwd: framework });
}

>>>>>>> origin/main
// 3. The framework guest itself.
npm(['run', 'build'], { cwd: framework });
