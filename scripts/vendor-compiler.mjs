#!/usr/bin/env node
// Vendor the TensionScript compiler as a tarball pinned by a git commit.
//
// # Why a tarball and not the registry
//
// The owner's rule: *"add tensionscript as submodule to tension in third_party
// and use tar npm i — I don't wanna release npm every release we made."*
//
// So the compiler's version is the **submodule gitlink**, not a semver range in
// 24 manifests. A language change reaches this repo by checking out a new
// submodule commit and running this script; no `npm publish` sits in the path,
// and nothing here depends on the registry copy existing — which matters,
// because ours is going to be unpublished.
//
// # Why `npm pack` is not enough on its own
//
// `npm pack` does **not** run `prepublishOnly` (that is a publish hook). The
// submodule's `prepublishOnly` is `npm run build && npm run publish:verify`,
// and `dist/` is gitignored — so packing a fresh submodule checkout would ship a
// `files: ["dist/"]` package with no `dist/`, and the tarball would export
// `./dist/asc.js` while containing nothing of the sort. That is exactly the
// 0.8.0 failure the submodule's own `scripts/verify-dist.js` was written for.
// This script therefore runs the build and the verify itself, in that order,
// before it packs. A pack that skips them is a stale compiler under a
// correct-looking version.
//
// # Why the sha is in the filename
//
// The version in the submodule's `package.json` does not move on every commit —
// two language fixes in a week can leave it at 0.14.1. Without the commit in the
// name, the second bump would write a byte-different tarball at the same path,
// and `npm ci` would refuse it later with an integrity error that names no
// cause: the lockfile recorded the hash of the tarball it installed, and the
// file it finds no longer has it. `-g<sha>` makes a repack of a different
// commit a different file, so the lockfile's recorded integrity stays true.
//
// # Two entry points, one implementation
//
//   node scripts/vendor-compiler.mjs            the explicit bump
//                                              (`npm run compiler:vendor`): may
//                                              rewrite the root spec.
//   node scripts/ensure-compiler.mjs            the root `preinstall` hook: may
//                                              **not**, because npm is reading
//                                              that spec right now.
//
// The second calls `vendorCompiler({ allowSpecRewrite: false })` from here. A
// forked second copy of "build, verify, pack" is how the two would drift — one
// of them would learn a new step and the other would keep shipping stale bytes.
//
// # What it touches
//
//   .packs/<name>.tgz          the artifact (gitignored: 2.1 MB per bump)
//   .packs/manifest.json       version, sha, tarball name, integrity, time
//   package.json               devDependencies["@yabgu_gm/tensionscript"]
//                              (explicit entry point only)
//
// Nothing else. In particular it does not install: the root `npm install` that
// follows is the one install point, and it is what refreshes the lockfile.

import { spawnSync } from 'node:child_process';
import { createHash } from 'node:crypto';
import { existsSync, mkdirSync, readFileSync, renameSync, writeFileSync } from 'node:fs';
import { dirname, join, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';

const here = dirname(fileURLToPath(import.meta.url));
const repo = resolve(here, '..');
const submodule = join(repo, 'third_party', 'TensionScript');
const packs = join(repo, '.packs');
const manifestPath = join(packs, 'manifest.json');
const rootManifestPath = join(repo, 'package.json');
const PACKAGE = '@yabgu_gm/tensionscript';
const WIN = process.platform === 'win32';

/** Set while a vendoring run is active, so a nested install cannot re-enter. */
export const RECURSION_MARKER = 'TENSION_COMPILER_VENDORING';

function fail(message, label) {
  console.error(`${label}: ${message}`);
  const error = new Error(message);
  error.reported = true;
  throw error;
}

function run(command, args, options = {}, label = 'vendor-compiler') {
  // `shell` is opt-in and only for `npm`/`git`, which are `.cmd`/`.exe` shims on
  // Windows that Node cannot spawn directly. An absolute path must not go
  // through the shell: `C:\Program Files\...` would be split on the space.
  const result = spawnSync(command, args, { encoding: 'utf8', ...options });
  if (result.error) fail(`${command}: ${result.error.message}`, label);
  return result;
}

/**
 * Build, verify and pack the submodule's compiler, and write the manifest.
 *
 * Options:
 *   `allowSpecRewrite` — whether the root `package.json` may be edited. `true`
 *     for the explicit `npm run compiler:vendor`; **`false` inside `preinstall`**,
 *     where npm is in the middle of reading that file: an edit there is an edit
 *     to the input of the command that is running.
 *   `label` — the prefix on every message, so a `preinstall` failure reads as
 *     `ensure-compiler:` rather than as the tool it borrows.
 *   `reason` — one line printed before the slow path, so a 90-second
 *     `preinstall` does not read as a hang.
 *
 * Returns `{ version, sha, tarball, spec, built, specRewritten }`.
 * Throws (after printing) on any failure; it never calls `process.exit`, so a
 * caller decides what a failure means for its own protocol.
 */
export function vendorCompiler({
  allowSpecRewrite = true,
  label = 'vendor-compiler',
  reason = null,
} = {}) {
  const say = (message) => console.log(`${label}: ${message}`);

  // ── 1. the submodule, initialized ─────────────────────────────────────────
  //
  // `git submodule status` prefixes the line with a space when the submodule is
  // checked out, `-` when it is not initialized, and `+` when the checkout does
  // not match the recorded gitlink. Only `-` needs work here: a `+` means someone
  // checked out a different commit on purpose, and this script should read that
  // commit rather than silently reset it.
  if (!existsSync(join(submodule, 'package.json'))) {
    say('third_party/TensionScript is not initialized — updating');
    const init = run('git', ['submodule', 'update', '--init', 'third_party/TensionScript'],
                     { cwd: repo, stdio: 'inherit' }, label);
    if (init.status !== 0) fail('git submodule update --init failed', label);
    if (!existsSync(join(submodule, 'package.json'))) {
      fail('third_party/TensionScript is still empty after update --init', label);
    }
  }

  // ── 2. what is being vendored ─────────────────────────────────────────────
  const pkg = JSON.parse(readFileSync(join(submodule, 'package.json'), 'utf8'));
  const version = pkg.version;
  if (typeof version !== 'string' || !version) fail('the submodule package.json has no version', label);

  const head = run('git', ['rev-parse', '--short=12', 'HEAD'], { cwd: submodule }, label);
  if (head.status !== 0) fail('git rev-parse failed in the submodule', label);
  const sha = head.stdout.trim();

  // `npm pack` derives the basename from the package name: the scope's `@` and
  // `/` become `-`. So `@yabgu_gm/tensionscript` packs as
  // `yabgu_gm-tensionscript-<version>.tgz`, and we add the commit before the
  // extension.
  const baseName = `${PACKAGE.replace(/^@/, '').replace('/', '-')}-${version}`;
  const tarballName = `${baseName}-g${sha}.tgz`;
  const tarballPath = join(packs, tarballName);
  const spec = `file:.packs/${tarballName}`;

  const root = JSON.parse(readFileSync(rootManifestPath, 'utf8'));
  const currentSpec = root.devDependencies?.[PACKAGE] ?? null;

  // ── 3. the no-op ──────────────────────────────────────────────────────────
  //
  // Idempotent by *content*, not by timestamp: the same version and commit with a
  // tarball whose sha512 still matches the manifest is the same vendoring, so the
  // second run rebuilds nothing. **This is the path `preinstall` takes on every
  // warm `npm install`** — adding an unrelated dependency must not cost a
  // compiler build.
  if (existsSync(tarballPath) && existsSync(manifestPath)) {
    let previous = null;
    try {
      previous = JSON.parse(readFileSync(manifestPath, 'utf8'));
    } catch {
      previous = null;
    }
    if (previous &&
        previous.version === version &&
        previous.sha === sha &&
        previous.tarball === tarballName) {
      const integrity = `sha512-${createHash('sha512').update(readFileSync(tarballPath)).digest('base64')}`;
      if (integrity === previous.integrity) {
        if (currentSpec === spec) {
          say(`up to date — ${version} at ${sha}`);
          return { version, sha, tarball: tarballName, spec, built: false, specRewritten: false };
        }
        // The artifact is right and only the spec disagrees with it.
        if (!allowSpecRewrite) {
          fail([
            `the compiler tarball is current (${version} at ${sha}) but package.json`,
            `declares ${currentSpec ?? '(nothing)'} instead of ${spec}.`,
            '  Not rewriting package.json during an install — that file is the',
            '  input npm is reading right now.',
            '  run:  npm run compiler:vendor   (outside npm install)',
          ].join('\n'), label);
        }
        writeSpec(root, spec);
        say(`artifact up to date, spec rewritten to ${spec}`);
        return { version, sha, tarball: tarballName, spec, built: false, specRewritten: true };
      }
      say('the tarball no longer matches its manifest integrity — repacking');
    } else {
      say('the manifest does not describe this commit — repacking');
    }
  }

  // ── 4. build, verify, pack ────────────────────────────────────────────────
  //
  // **The build is not conditional on `node_modules` existing.** A submodule left
  // with a `node_modules` from an earlier commit still has a `dist/` built from
  // *that* commit, and `npm pack` would happily ship it. The install is, because
  // `npm ci` is the one that is idempotent and reproducible.
  say(reason ?? `building ${version} from third_party/TensionScript at ${sha}`);

  if (!existsSync(join(submodule, 'node_modules'))) {
    say('installing the submodule’s dependencies (npm ci)');
    const ci = run('npm', ['ci', '--no-audit', '--no-fund'],
                   { cwd: submodule, stdio: 'inherit', env: childEnv() }, label);
    if (ci.status !== 0) fail('npm ci failed in third_party/TensionScript', label);
  }

  say('building the compiler');
  const build = run('npm', ['run', 'build'],
                    { cwd: submodule, stdio: 'inherit', env: childEnv() }, label);
  if (build.status !== 0) fail('npm run build failed in third_party/TensionScript', label);

  // The gate for "the build actually produced the artifacts the tarball exports".
  // A build that emits nothing looks like a successful build until you look, and
  // an empty `dist/` in a tarball is the 0.8.0 install failure.
  say('verifying dist/');
  const verify = run('npm', ['run', 'publish:verify'],
                     { cwd: submodule, stdio: 'inherit', env: childEnv() }, label);
  if (verify.status !== 0) fail('npm run publish:verify failed — refusing to pack', label);

  mkdirSync(packs, { recursive: true });
  // Pack into a scratch name first, then rename: `--pack-destination` always uses
  // npm's own basename, so the commit suffix has to be applied afterwards.
  const scratchName = `${baseName}.tgz`;
  const scratchPath = join(packs, scratchName);
  say(`packing ${version} at ${sha}`);
  const pack = run('npm', ['pack', '--pack-destination', packs],
                   { cwd: submodule, stdio: 'inherit', env: childEnv() }, label);
  if (pack.status !== 0) fail('npm pack failed', label);
  if (!existsSync(scratchPath)) {
    fail(`npm pack did not produce ${scratchName} in .packs (see its output above)`, label);
  }
  renameSync(scratchPath, tarballPath);

  const integrity = `sha512-${createHash('sha512').update(readFileSync(tarballPath)).digest('base64')}`;
  writeFileSync(manifestPath, `${JSON.stringify({
    version,
    sha,
    tarball: tarballName,
    integrity,
    packedAt: new Date().toISOString(),
  }, null, 2)}\n`);

  // The root spec has to name the tarball that now exists, or the install that
  // follows cannot find it. In `preinstall` that is a refusal rather than an
  // edit — see `allowSpecRewrite`.
  let specRewritten = false;
  if (currentSpec !== spec) {
    if (!allowSpecRewrite) {
      fail([
        `packed ${spec} but package.json declares ${currentSpec ?? '(nothing)'}.`,
        '  Not rewriting package.json during an install — that file is the',
        '  input npm is reading right now. The tarball is built; the spec is not.',
        '  run:  npm run compiler:vendor   (outside npm install)',
      ].join('\n'), label);
    }
    writeSpec(root, spec);
    specRewritten = true;
  }

  const bytes = readFileSync(tarballPath).length;
  say(`.packs/${tarballName} (${(bytes / 1048576).toFixed(2)} MB)`);
  say(`${PACKAGE} → ${spec}`);
  return { version, sha, tarball: tarballName, spec, built: true, specRewritten };
}

/// The environment for a child `npm`, with the recursion marker set.
///
/// A vendoring run spawns `npm ci` and `npm run build` inside the submodule.
/// Those are different packages with their own hooks, but the marker is cheap
/// and it makes "nothing in this subtree may vendor again" a property of the
/// process tree rather than a claim about which package.json has what hook.
function childEnv() {
  return { ...process.env, [RECURSION_MARKER]: '1' };
}

/// Sets `devDependencies[PACKAGE]` on the **root** manifest and writes it back.
///
/// Preserves the file's own 2-space formatting and its trailing newline, and it
/// is a no-op when the value already matches — the caller uses that to avoid
/// rewriting a file it would not change.
function writeSpec(manifest, nextSpec) {
  manifest.devDependencies = manifest.devDependencies ?? {};
  if (manifest.devDependencies[PACKAGE] === nextSpec) return;
  manifest.devDependencies[PACKAGE] = nextSpec;
  writeFileSync(rootManifestPath, `${JSON.stringify(manifest, null, 2)}\n`);
}

// ── the explicit entry point ────────────────────────────────────────────────
if (process.argv[1] && resolve(process.argv[1]) === fileURLToPath(import.meta.url)) {
  if (process.env[RECURSION_MARKER]) {
    console.log('vendor-compiler: re-entered from inside a vendoring run — skipping');
  } else {
    try {
      const result = vendorCompiler();
      if (!result.built) console.log(`vendor-compiler: ${result.tarball} (unchanged)`);
      else console.log('vendor-compiler: next: npm install   (refreshes the root lockfile)');
    } catch (error) {
      if (!error.reported) throw error;
      process.exit(1);
    }
  }
}
