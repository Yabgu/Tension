#!/usr/bin/env node
// The root `preinstall` hook: make sure the vendored compiler exists.
//
// # Why this has to run at *install* time
//
// `.packs/` is gitignored — 2.1 MB per bump does not belong in history — and the
// root `package.json` declares the compiler as `file:.packs/…-g<sha>.tgz`. So on a
// fresh clone the **first command a reader runs** is the one that cannot work:
//
//     npm error code ENOENT
//     npm error path …/.packs/yabgu_gm-tensionscript-0.14.1-gd96ac6062b28.tgz
//
// and it dies before any script of ours could have run, because npm resolves the
// dependency graph (and the file: tarball it names) before it runs `postinstall`.
// `preinstall` is early enough: measured on a scratch package, a `preinstall` that
// wrote the tarball let the install proceed — it failed only on the placeholder
// bytes, which is the proof the hook fires before the tarball is read.
//
// So the two commands become one: `git clone && git submodule update --init &&
// npm install` is the whole first-run story, and the compiler is built as part of
// it.
//
// # Why it must be cheap when it is not needed
//
// This hook runs on **every** `npm install`, including one that adds an unrelated
// dependency or restores a warm tree. The no-op path is four file reads and one
// `git rev-parse`; the slow path is a compiler build (measured: ~40 s warm-cache,
// longer cold). Anything less than "does nothing unless it must" would make every
// routine install a coffee break, and readers would learn to distrust the hook.
//
// # Why it may not edit `package.json`
//
// `vendorCompiler` rewrites the root spec when the tarball moves. During
// `preinstall` that file is the **input of the command that is running** — npm has
// already parsed it and decided what to fetch. So this entry point passes
// `allowSpecRewrite: false`: if the spec does not name the tarball that was (or
// would be) produced, it fails with the command to run instead, rather than
// mutating npm's input underneath it.
//
// # Recursion
//
// The vendoring path runs `npm ci` and `npm run build` inside
// `third_party/TensionScript`. That subtree has its own hooks; `TENSION_COMPILER_VENDORING`
// is set for those children so that no install anywhere beneath this run can
// re-enter the build. A re-entry is skipped with one line, not an error: it is a
// legitimate consequence of nesting, not a fault.

import { existsSync, readFileSync } from 'node:fs';
import { execFileSync } from 'node:child_process';
import { dirname, join, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';

import { RECURSION_MARKER, vendorCompiler } from './vendor-compiler.mjs';

const here = dirname(fileURLToPath(import.meta.url));
const repo = resolve(here, '..');
const manifestPath = join(repo, '.packs', 'manifest.json');
const PACKAGE = '@yabgu_gm/tensionscript';
const LABEL = 'ensure-compiler';

function say(message) {
  console.log(`${LABEL}: ${message}`);
}

// A nested install is not a second chance to vendor; it is the same one.
if (process.env[RECURSION_MARKER]) {
  say('inside a vendoring run — nothing to do');
  process.exit(0);
}

/// The manifest, or `null` when this tree has never been vendored.
function readManifest() {
  if (!existsSync(manifestPath)) return null;
  try {
    return JSON.parse(readFileSync(manifestPath, 'utf8'));
  } catch {
    return null;
  }
}

/// The root's declared spec for the compiler, or `null`.
function declaredSpec() {
  try {
    const root = JSON.parse(readFileSync(join(repo, 'package.json'), 'utf8'));
    return root.devDependencies?.[PACKAGE] ?? null;
  } catch {
    return null;
  }
}

/// The submodule's commit, or `null` when it is not initialized.
///
/// Only used to *warn*. A submodule checked out ahead of the vendored tarball is a
/// recoverable state — the install should still succeed, with the compiler the
/// tree actually declares — so this is not a failure condition here. It would be
/// a failure in `compiler:vendor`, which is the command that resolves it.
function submoduleCommit() {
  const submodule = join(repo, 'third_party', 'TensionScript');
  if (!existsSync(join(submodule, 'package.json'))) return null;
  try {
    return execFileSync('git', ['rev-parse', '--short=12', 'HEAD'], {
      cwd: submodule, encoding: 'utf8',
    }).trim();
  } catch {
    return null;
  }
}

const manifest = readManifest();
const spec = declaredSpec();

// ── the fast path ───────────────────────────────────────────────────────────
//
// Present and self-consistent: the manifest names a version and commit, the
// tarball it names is on disk and is the one the root declares. Nothing to build,
// nothing to say beyond one line.
if (manifest && spec === `file:.packs/${manifest.tarball}` &&
    existsSync(join(repo, '.packs', manifest.tarball))) {
  const head = submoduleCommit();
  if (head && head !== manifest.sha) {
    // Not a failure: the install must not be blocked by an unbumped submodule.
    // But it must not be silent either — this is the drift the whole vendoring
    // exists to make visible, and an install is exactly when someone is looking.
    say(`note: third_party/TensionScript is at ${head}, the vendored tarball is ${manifest.sha}`);
    say('      the tree keeps the vendored compiler; `npm run compiler:vendor` moves it');
  }
  say(`up to date — ${manifest.version} at ${manifest.sha}`);
  process.exit(0);
}

// ── the slow path ───────────────────────────────────────────────────────────
//
// Missing, or present but not what the root declares. Build it. The line below is
// the only warning a reader gets before a minute of silence, so it says what is
// happening and why rather than "please wait".
say(manifest
  ? `the vendored tarball does not match package.json — rebuilding it from third_party/TensionScript`
  : 'no vendored compiler yet (.packs/ is not in git) — building it from third_party/TensionScript');
say('this is the first-run cost; later installs reuse .packs/ and skip it');

try {
  const result = vendorCompiler({
    allowSpecRewrite: false,
    label: LABEL,
    reason: null,
  });
  say(`ready: ${result.tarball}`);
} catch (error) {
  if (!error.reported) throw error;
  process.exit(1);
}
