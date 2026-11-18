// Generate the session runtime's constants and compile the framework guest.
//
// Two steps that belong together because the second consumes the first: the
// guest is compiled against `assembly/runtime/layout.ts`, which the generator
// rewrites from session.json. Running them as one npm script is what keeps a
// stale constant table from reaching a guest.
//
// **The compiler is not installed here, and its absence is not repaired here.**
// It is vendored once — `scripts/vendor-compiler.mjs` packs the
// `third_party/TensionScript` submodule into `.packs/` and the root
// `package.json` declares that tarball — and `requireCompiler()` asserts that the
// installed copy *is* that tarball before anything compiles. A build that quietly
// installs its own copy is a build that can disagree with the rest of the tree,
// which is what per-package installs used to do here: this package carried
// `^0.13.2` while the examples carried `^0.14.1`, and the nearby `.bin` won.
//
// The consequence is that a missing compiler stops the build with the two
// commands that fix it instead of reaching for one. That is deliberate: a global
// `tensionscript` on `PATH` is how a tree ends up compiled by a version four
// releases behind the pin.

import { spawnSync } from 'node:child_process';
import { existsSync, readFileSync } from 'node:fs';
import { dirname, join, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';

import { CompilerError, COMPILER, assertVendoredCompiler, requireCompiler } from './lib/toolchain.mjs';

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
// **The resolver is shared, and it asserts provenance.** `requireCompiler()` is
// the same call every other build script makes (`scripts/lib/toolchain.mjs`): the
// repo root's `.bin` only, no PATH fallback, and a check that the installed copy
// is the tarball `.packs/manifest.json` names — because a registry 0.14.1 and the
// vendored 0.14.1 have the same version string, so a version comparison cannot
// tell them apart. It throws with the two commands that fix a missing one rather
// than installing anything itself.
let compiler;
let vendored;
try {
  compiler = requireCompiler();
  vendored = assertVendoredCompiler(compiler);
} catch (error) {
  if (error instanceof CompilerError) die(error.message);
  throw error;
}

// The path and the vendored artifact, printed every run: this is the line that
// answers "did the build use the vendored compiler?" without inference.
console.log(`build-framework: ${COMPILER} ${vendored.version} from ${compiler}`);
console.log(`build-framework: vendored ${vendored.tarball} (${vendored.sha})`);

// 3. The framework guest itself.
npm(['run', 'build'], { cwd: framework });
