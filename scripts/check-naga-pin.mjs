#!/usr/bin/env node
// scripts/check-naga-pin.mjs — refuse a tree that links two naga versions.
//
// `tension-core` and `tension-shadergen` both depend on naga, and they must
// agree. When they diverge, cargo quietly links *both* copies: two `From`
// impls that do not convert, two `Options` types that do not compare, and a
// `cargo tree -p naga` that answers "specification is ambiguous" instead of a
// version. The previous turn hit exactly that while testing 30.0.1.
//
// The check is `cargo tree -p naga -e normal`:
//
//   - one version  -> the tree prints `naga vX.Y.Z` at its root, exit 0;
//   - two versions -> cargo cannot resolve `-p naga` and exits non-zero with
//                     `specification 'naga' is ambiguous`, listing each
//                     `naga@X.Y.Z` it means. That message *is* the mismatch
//                     report, so it is parsed rather than re-derived.
//
// Exit 0 silently on success; non-zero with a message naming the versions on
// failure. Wired into `scripts/test-2d.mjs` and `scripts/test.mjs`.

import { spawnSync } from 'node:child_process';
import { dirname, join, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';

const RUNNER = 'check-naga-pin';
const here = resolve(dirname(fileURLToPath(import.meta.url)), '..');

/**
 * Ask cargo what naga versions the workspace links.
 *
 * Returns `{ versions: string[], output: string }`. Chosen over parsing a
 * dependency tree because `cargo tree -p naga` *fails* on the case this script
 * exists to catch, and the failure message is the only place the versions are
 * named.
 */
export function nagaVersions(manifestPath) {
  const result = spawnSync('cargo', ['tree', '-p', 'naga', '-e', 'normal', '--manifest-path', manifestPath], {
    encoding: 'utf8',
  });

  if (result.error) {
    return { versions: [], output: '', error: String(result.error) };
  }

  const combined = `${result.stdout ?? ''}${result.stderr ?? ''}`;

  // Success: the root line is `naga vX.Y.Z`.
  const root = combined.match(/^naga v(\d+\.\d+\.\d+\S*)/m);
  if (result.status === 0 && root) {
    return { versions: [root[1]], output: combined };
  }

  // Ambiguous: cargo lists `naga@X.Y.Z` per candidate.
  const ambiguous = [...combined.matchAll(/naga@(\d+\.\d+\.\d+\S*)/g)].map((m) => m[1]);
  if (ambiguous.length > 0) {
    return { versions: [...new Set(ambiguous)], output: combined };
  }

  // Anything else is a cargo failure this script cannot interpret.
  return { versions: [], output: combined, error: `cargo tree exited ${result.status}` };
}

function main() {
  const manifest = join(here, 'tension-core', 'Cargo.toml');
  const { versions, output, error } = nagaVersions(manifest);

  if (error) {
    console.error(`${RUNNER}: could not determine the naga version`);
    if (output) console.error(output.trim());
    console.error(error);
    process.exit(1);
  }

  if (versions.length > 1) {
    console.error(
      `${RUNNER}: this tree links ${versions.length} naga versions — ${versions.join(', ')}\n` +
        `  tension-core and tension-shadergen must pin the same version.\n` +
        `  See the note above the naga dependency in either Cargo.toml.\n` +
        `  cargo tree said:\n${output.trim().replace(/^/gm, '    ')}`,
    );
    process.exit(1);
  }

  if (versions.length === 0) {
    console.error(`${RUNNER}: no naga dependency found, which is not the expected tree`);
    console.error(output.trim());
    process.exit(1);
  }

  // Silent on success: this runs in two preambles and a passing check has
  // nothing to say.
}

// Only run when invoked directly, so a test can import `nagaVersions`.
if (process.argv[1] && resolve(process.argv[1]) === resolve(fileURLToPath(import.meta.url))) {
  main();
}
