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
// and `dist/` is gitignored — so packing a fresh submodule checkout would ship
// a `files: ["dist/"]` package with no `dist/`, and the tarball would export
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
// # What it touches
//
//   .packs/<name>.tgz          the artifact (gitignored: 2.1 MB per bump)
//   .packs/manifest.json       version, sha, tarball name, integrity, time
//   package.json               devDependencies["@yabgu_gm/tensionscript"]
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

function die(message) {
  console.error(`vendor-compiler: ${message}`);
  process.exit(1);
}

function run(command, args, options = {}) {
  // `shell` is opt-in and only for `npm`/`git`, which are `.cmd`/`.exe` shims on
  // Windows that Node cannot spawn directly. An absolute path must not go
  // through the shell: `C:\Program Files\...` would be split on the space.
  const result = spawnSync(command, args, { encoding: 'utf8', ...options });
  if (result.error) die(`${command}: ${result.error.message}`);
  return result;
}

const npm = (args, options = {}) => run('npm', args, { shell: WIN, ...options });
const git = (args, options = {}) => run('git', args, { ...options });

// ── 1. the submodule, initialized ───────────────────────────────────────────
//
// `git submodule status` prefixes the line with a space when the submodule is
// checked out, `-` when it is not initialized, and `+` when the checkout does
// not match the recorded gitlink. Only `-` needs work here: a `+` means someone
// checked out a different commit on purpose, and this script should read that
// commit rather than silently reset it.
if (!existsSync(join(submodule, 'package.json'))) {
  console.log('vendor-compiler: third_party/TensionScript is not initialized — updating');
  const init = git(['submodule', 'update', '--init', 'third_party/TensionScript'], {
    cwd: repo, stdio: 'inherit',
  });
  if (init.status !== 0) die('git submodule update --init failed');
  if (!existsSync(join(submodule, 'package.json'))) {
    die('third_party/TensionScript is still empty after update --init');
  }
}

// ── 2. what is being vendored ───────────────────────────────────────────────
const pkg = JSON.parse(readFileSync(join(submodule, 'package.json'), 'utf8'));
const version = pkg.version;
if (typeof version !== 'string' || !version) die('the submodule package.json has no version');

const head = git(['rev-parse', '--short=12', 'HEAD'], { cwd: submodule });
if (head.status !== 0) die('git rev-parse failed in the submodule');
const sha = head.stdout.trim();

// `npm pack` derives the basename from the package name: the scope's `@` and
// `/` become `-`. So `@yabgu_gm/tensionscript` packs as
// `yabgu_gm-tensionscript-<version>.tgz`, and we add the commit before the
// extension.
const baseName = `${PACKAGE.replace(/^@/, '').replace('/', '-')}-${version}`;
const tarballName = `${baseName}-g${sha}.tgz`;
const tarballPath = join(packs, tarballName);
const spec = `file:.packs/${tarballName}`;

// ── 3. the no-op ────────────────────────────────────────────────────────────
//
// Idempotent by *content*, not by timestamp: the same version and commit with a
// tarball whose sha512 still matches the manifest is the same vendoring, so the
// second run rebuilds nothing. The root spec is checked too — a manifest can be
// right while the manifest that *consumes* it points somewhere else (an
// interrupted run, or a hand edit).
const root = JSON.parse(readFileSync(rootManifestPath, 'utf8'));
const currentSpec = root.devDependencies?.[PACKAGE] ?? null;
if (existsSync(tarballPath) && existsSync(manifestPath)) {
  try {
    const previous = JSON.parse(readFileSync(manifestPath, 'utf8'));
    if (previous.version === version && previous.sha === sha && previous.tarball === tarballName) {
      const integrity = `sha512-${createHash('sha512').update(readFileSync(tarballPath)).digest('base64')}`;
      if (integrity === previous.integrity) {
        if (currentSpec === spec) {
          console.log(`vendor-compiler: up to date — ${version} at ${sha}`);
          console.log(`vendor-compiler: ${tarballName} (${previous.integrity.slice(0, 23)}…)`);
          process.exit(0);
        }
        // The artifact is right and only the spec is stale: rewrite that one
        // field rather than rebuilding a tarball that already matches.
        writeSpec(root, spec);
        console.log(`vendor-compiler: artifact up to date, spec rewritten to ${spec}`);
        console.log('vendor-compiler: next: npm install');
        process.exit(0);
      }
      console.log('vendor-compiler: the tarball no longer matches its manifest integrity — repacking');
    }
  } catch {
    console.log('vendor-compiler: unreadable manifest — repacking');
  }
}

// ── 4. build, verify, pack ──────────────────────────────────────────────────
//
// **The build is not conditional on `node_modules` existing.** A submodule left
// with a `node_modules` from an earlier commit still has a `dist/` built from
// *that* commit, and `npm pack` would happily ship it. The install is, because
// `npm ci` is the one that is idempotent and reproducible.
if (!existsSync(join(submodule, 'node_modules'))) {
  console.log('vendor-compiler: installing the submodule’s dependencies (npm ci)');
  const ci = npm(['ci', '--no-audit', '--no-fund'], { cwd: submodule, stdio: 'inherit' });
  if (ci.status !== 0) die('npm ci failed in third_party/TensionScript');
}

console.log('vendor-compiler: building the compiler');
const build = npm(['run', 'build'], { cwd: submodule, stdio: 'inherit' });
if (build.status !== 0) die('npm run build failed in third_party/TensionScript');

// The gate for "the build actually produced the artifacts the tarball exports".
// A build that emits nothing looks like a successful build until you look, and
// an empty `dist/` in a tarball is the 0.8.0 install failure.
console.log('vendor-compiler: verifying dist/');
const verify = npm(['run', 'publish:verify'], { cwd: submodule, stdio: 'inherit' });
if (verify.status !== 0) die('npm run publish:verify failed — refusing to pack');

mkdirSync(packs, { recursive: true });
// Pack into a scratch name first, then rename: `--pack-destination` always uses
// npm's own basename, so the commit suffix has to be applied afterwards.
const scratchName = `${baseName}.tgz`;
const scratchPath = join(packs, scratchName);
console.log(`vendor-compiler: packing ${version} at ${sha}`);
const pack = npm(['pack', '--pack-destination', packs], { cwd: submodule, stdio: 'inherit' });
if (pack.status !== 0) die('npm pack failed');
if (!existsSync(scratchPath)) {
  die(`npm pack did not produce ${scratchName} in .packs (see its output above)`);
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

writeSpec(root, spec);

const bytes = readFileSync(tarballPath).length;
console.log(`vendor-compiler: .packs/${tarballName} (${(bytes / 1048576).toFixed(2)} MB)`);
console.log(`vendor-compiler: ${PACKAGE} → ${spec}`);
console.log('vendor-compiler: next: npm install   (refreshes the root lockfile)');

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
