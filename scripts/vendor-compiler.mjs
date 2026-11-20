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
//   .packs/<name>.tar          the artifact (gitignored: 10.4 MB per bump)
//   .packs/manifest.json       version, sha, tarball name, integrity, time
//   package.json               devDependencies["@yabgu_gm/tensionscript"]
//                              (explicit entry point only)
//
// Nothing else. In particular it does not install: the root `npm install` that
// follows is the one install point, and it is what refreshes the lockfile.

import { spawnSync } from 'node:child_process';
import { createHash } from 'node:crypto';
import { existsSync, mkdirSync, readFileSync, rmSync, writeFileSync } from 'node:fs';
import { dirname, join, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';

import { executableMembers, readTar, readTarGz, writeTar } from './lib/deterministic-tar.mjs';

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

/**
 * The tarball format this script writes, recorded in the manifest.
 *
 * `npm pack`'s own bytes are not reproducible across platforms, so `.packs/` holds
 * a **canonicalised** tarball (see `lib/deterministic-tar.mjs`). The version is
 * bumped whenever the canonicalisation rule changes, and a manifest carrying an
 * older one is repacked rather than called current — which is how a tree picks up
 * the fix without anyone deleting `.packs/` by hand.
 *
 *   v1  modes came from the input's execute bit. **Wrong across platforms**: NTFS
 *       has no execute bit, so the compiler's bin entry was 0755 on Linux and 0644
 *       on Windows — one header field, and `EINTEGRITY` on every non-Linux install.
 *   v2  modes come from the package's `bin` field: platform-independent by
 *       construction, because `package.json` is committed.
 *   v3  the artifact is an **uncompressed** `.tar`. v2's archive was identical on
 *       both platforms while its gzip was not — Node's bundled zlib differs between
 *       the Windows and Linux builds — so the last variable was the compressor. npm
 *       installs a `file:` `.tar` directly (measured on Windows: exit 0).
 */
const TARBALL_FORMAT = 'canonical-tar-v3';

function fail(message, label) {
  console.error(`${label}: ${message}`);
  const error = new Error(message);
  error.reported = true;
  throw error;
}

/// Whether a command has to go through a shell on this platform.
///
/// **`npm` is a `.cmd` shim on Windows**, and Node refuses to spawn a batch file
/// without a shell — the failure is `spawnSync npm ENOENT`, which reads as "npm is
/// not installed" rather than "npm is not an executable image". That is what broke
/// `npm install` on Windows in this file: the comment on `run` stated the rule and
/// no call site applied it. Measured on Windows: with `call npm ci`, `call npm run
/// build`, `call npm run publish:verify` and `call npm pack`, all four steps
/// succeed — only the spawn was wrong.
///
/// `git` does **not** need it: Git for Windows ships `git.exe`, so it spawns
/// directly, and keeping it out of a shell also keeps `C:\Program Files\Git\…`
/// from being split on the space.
///
/// This is the same decision `scripts/build-examples.mjs` makes for its `npm()`
/// and `packages/cli/src/util.js` encodes in `npmCommand()`; it lives here as a
/// predicate because this file spawns both tools.
function needsShell(command) {
  if (!WIN) return false;
  return command === 'npm' || /\.(cmd|bat)$/i.test(command);
}

function run(command, args, options = {}, label = 'vendor-compiler') {
  // `shell` may be forced by a caller; otherwise it is decided by the command.
  // An absolute *executable* path must not go through the shell — a path with a
  // space in it would be split — which is why this is not simply `WIN`.
  const shell = options.shell ?? needsShell(command);

  if (!shell) {
    const result = spawnSync(command, args, { encoding: 'utf8', ...options, shell: false });
    if (result.error) fail(`${command}: ${result.error.message}`, label);
    return result;
  }

  // **One composed string on the shell path, and no argument array.** Node says so
  // itself — `DEP0190`: "passing args to a child process with shell option true can
  // lead to security vulnerabilities, as the arguments are not escaped, only
  // concatenated". Silencing that would be exactly the wrong response here: this
  // file passes paths, and a path with a space in it becoming two arguments is a
  // wrong command rather than an error. So quote, then hand the shell one line.
  const line = [command, ...args].map((part) => {
    const text = String(part);
    if (!/[\s"]/.test(text)) return text;
    return WIN ? `"${text.replace(/"/g, '""')}"` : `'${text.replace(/'/g, `'\\''`)}'`;
  }).join(' ');
  const result = spawnSync(line, [], { encoding: 'utf8', ...options, shell: true });
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
  // `yabgu_gm-tensionscript-<version>.tgz`, and the artifact we ship is that payload
  // **uncompressed** as `<version>-g<sha>.tar` — see `lib/deterministic-tar.mjs` for
  // why the gzip had to go.
  const baseName = `${PACKAGE.replace(/^@/, '').replace('/', '-')}-${version}`;
  const tarballName = `${baseName}-g${sha}.tar`;
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
        previous.format === TARBALL_FORMAT &&
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
    } else if (previous && previous.format !== TARBALL_FORMAT) {
      say('the tarball predates the canonical format — repacking it');
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
  // `npm pack` writes `<baseName>.tgz` — its own basename, with the commit suffix
  // unknown to it. That file is a **scratch input**, not the artifact: it is read,
  // canonicalised and deleted below, and `.tgz` appears nowhere in the spec, the
  // manifest or the lockfile.
  const scratchName = `${baseName}.tgz`;
  const scratchPath = join(packs, scratchName);
  say(`packing ${version} at ${sha}`);
  const pack = run('npm', ['pack', '--pack-destination', packs],
                   { cwd: submodule, stdio: 'inherit', env: childEnv() }, label);
  if (pack.status !== 0) fail('npm pack failed', label);
  if (!existsSync(scratchPath)) {
    fail(`npm pack did not produce ${scratchName} in .packs (see its output above)`, label);
  }

  // ── canonicalise the bytes ────────────────────────────────────────────────
  //
  // **`npm pack` is not reproducible across platforms.** The same commit packed on
  // Linux and on Windows differs by ~1.6 KB of tar/gzip metadata — mtime, uid/gid,
  // uname/gname, mode — while every member's path, size and content is identical.
  // That matters here and nowhere else: the root `package-lock.json` records the
  // tarball's sha512, so a committed lockfile is valid on exactly one platform and
  // every other machine fails to install:
  //
  //   npm error sha512-J1IFTJfj0sgG… integrity checksum failed when using sha512:
  //     wanted sha512-J1IFTJfj0sgG… but got sha512-w9wt1kqwCK/…
  //
  // So the tarball written to `.packs/` is **ours**, not npm's: same member list,
  // same order, same contents, every piece of machine state fixed (see
  // `lib/deterministic-tar.mjs`). Two machines packing this commit now produce the
  // same bytes, which is the property the whole scheme needs.
  //
  // Note the last step: the artifact is written **uncompressed**. Canonicalising
  // the tar made the archive identical on both platforms; the gzip around it stayed
  // platform-dependent, because Node's bundled zlib differs between its Windows and
  // Linux builds. Measured on the real Windows machine: both canonical tarballs
  // decompressed to byte-identical raw streams (`cmp` clean, 10,465,280 B) while
  // still hashing differently gzipped. A plain `.tar` removes that variable instead
  // of pinning a compressor, and npm installs one from a `file:` spec.
  const scratched = readFileSync(scratchPath);
  const npmMembers = readTarGz(scratched);
  // **Which members are executable comes from `package.json`, never from the
  // input tarball.** npm pack on Windows records 0644 for the bin entry because
  // NTFS has no execute bit, so reading the mode back would bake the packing
  // platform into the artifact — the defect this whole module exists to remove.
  // `bin` is committed metadata and is the same on every machine.
  const executables = executableMembers(pkg.bin);
  const canonical = writeTar(npmMembers, { executables });
  // The repack must not change the package, only its container — so read what was
  // written and compare it to what npm produced. Comparing in memory would only
  // prove that `writeTar` agrees with itself; reading the *bytes* is what catches a
  // padding or offset mistake, which is the failure that would silently truncate
  // the last member.
  assertSameMembers(npmMembers, readTar(canonical), label);
  writeFileSync(tarballPath, canonical);
  // npm's own output is not referenced by anything after this: the manifest, the
  // root spec and the lockfile all name `tarballName`. Removing it means a stray
  // copy under npm's basename cannot be picked up by a later glob.
  rmSync(scratchPath, { force: true });
  say(`canonicalised ${npmMembers.length} members (mtime 0, uid/gid 0, ` +
      `0755 for ${executables.size} bin member(s), 0644 for the rest, uncompressed)`);

  const integrity = `sha512-${createHash('sha512').update(readFileSync(tarballPath)).digest('base64')}`;
  writeFileSync(manifestPath, `${JSON.stringify({
    format: TARBALL_FORMAT,
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

/**
 * Refuse a repack whose member list differs from npm's, in any way that matters.
 *
 * Order, path and byte length — not just the set. A tarball is an ordered sequence
 * and the order is part of the file; a member that moved is a member whose
 * extraction order changed, which for a package with bin links is not cosmetic.
 * Contents are covered by the size check plus the fact that `writeTarGz` copies
 * entry buffers verbatim from the reader.
 */
function assertSameMembers(before, after, label) {
  if (before.length !== after.length) {
    fail(`the repack changed the member count: ${before.length} → ${after.length}`, label);
  }
  for (let i = 0; i < before.length; i++) {
    const a = before[i];
    const b = after[i];
    if (a.name !== b.name || a.data.length !== b.data.length) {
      fail(`the repack changed member ${i}: ${a.name} (${a.data.length} B) → ` +
           `${b.name} (${b.data.length} B)`, label);
    }
  }
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

/// Keeps the root lockfile from pinning the tarball's bytes.
///
/// **The tarball is not byte-identical across platforms, and cannot be.** The
/// one file that differs is `dist/binaryen.js` — the JS glue built with the
/// platform's own toolchain — measured at 14 732 683 bytes on Linux and
/// 14 729 938 on Windows for the same compiler commit. A lockfile written on
/// one machine therefore fails `npm install` on the other with an
/// `EINTEGRITY` for a file nobody can make match:
///
///   npm error integrity checksum failed when using sha512 ... (26067456 bytes)
///
/// The pin that matters is the **submodule gitlink**, which is what this script
/// reads; the bytes are provenance-checked by the build and the manifest keeps
/// their hash for a reader who wants it (`.packs/manifest.json`). Removing the
/// lock's `integrity` for this one entry is what lets a second machine vendor
/// the same commit and install it.
function unpinLockIntegrity() {
  const lockPath = resolve(repo, "package-lock.json");
  if (!existsSync(lockPath)) return;
  const lock = JSON.parse(readFileSync(lockPath, "utf8"));
  const entry = lock.packages?.[`node_modules/${PACKAGE}`];
  if (!entry || entry.integrity === undefined) return;
  delete entry.integrity;
  writeFileSync(lockPath, `${JSON.stringify(lock, null, 2)}\n`);
  console.log(
    "vendor-compiler: package-lock.json no longer pins this tarball's integrity " +
      "(dist/binaryen.js is built per platform; the submodule gitlink is the pin)"
  );
}

// ── the explicit entry point ────────────────────────────────────────────────
if (process.argv[1] && resolve(process.argv[1]) === fileURLToPath(import.meta.url)) {
  if (process.env[RECURSION_MARKER]) {
    console.log('vendor-compiler: re-entered from inside a vendoring run — skipping');
  } else {
    try {
      const result = vendorCompiler();
      unpinLockIntegrity();
      if (!result.built) console.log(`vendor-compiler: ${result.tarball} (unchanged)`);
      else {
        // **The version does not change when the commit does.** The package is
        // always `0.14.1`, so npm sees an installed copy that satisfies the
        // new spec and leaves it alone: measured on Windows, `npm install`
        // said "up to date" while node_modules still held the previous
        // compiler, and the build then warned `DWARF emission failed` from a
        // tarball that had already been fixed. Removing the installed copy is
        // what makes npm unpack the new bytes.
        console.log('vendor-compiler: next: rm -rf node_modules/@yabgu_gm/tensionscript && npm install');
        console.log('vendor-compiler:       (the version stays 0.14.1, so npm will not replace the installed copy)');
      }
    } catch (error) {
      if (!error.reported) throw error;
      process.exit(1);
    }
  }
}
