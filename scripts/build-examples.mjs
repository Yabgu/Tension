#!/usr/bin/env node
// Build every example's guest wasm, in place.
//
// The counterpart of `build.sh`'s example loop. Each example is its own npm
// project carrying its own `node_modules`, so this shells out to `npm run build`
// per directory rather than trying to compile them from one place — the
// per-example recipe is what knows which `.ts` to compile and where the output
// goes.
//
// A missing `node_modules` is installed first. `TENSION_SKIP_MODEL_FETCH=1` is
// set for that install because the `ai` example's postinstall fetches 2.3 GB of
// weights; `examples/ai/prepare.sh` does that on demand instead.
//
// `TENSION_EXAMPLES` narrows the set (space- or comma-separated directory
// names), which is what a targeted rebuild wants:
//     TENSION_EXAMPLES="ogre/hello-triangle io" npm run build:examples

import { spawnSync } from 'node:child_process';
import { existsSync, readdirSync, readFileSync } from 'node:fs';
import { dirname, join, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';

const WIN = process.platform === 'win32';

/// `npm` is a `.cmd` shim on Windows, which Node cannot spawn without a shell:
/// the failure is `status: null` and an ENOENT error, and a caller that only
/// checks `status !== 0` reports it as "failed (null)". Unix runs it directly.
function npm(args, options = {}) {
  const result = spawnSync('npm', args, { shell: WIN, ...options });
  if (result.error) {
    console.error(`build-examples: npm ${args.join(' ')}: ${result.error.message}`);
  }
  return result;
}

const here = dirname(fileURLToPath(import.meta.url));
const repo = resolve(here, '..');
const examplesRoot = join(repo, 'examples');

/// Every directory under examples/ that has a package.json with a `build`
/// script, at depth 1 or 2 (examples/io, examples/ogre/hello-triangle).
function findExamples() {
  const found = [];
  for (const first of readdirSync(examplesRoot, { withFileTypes: true })) {
    if (!first.isDirectory()) continue;
    const one = join(examplesRoot, first.name);
    if (existsSync(join(one, 'package.json'))) {
      found.push(one);
      continue;
    }
    for (const second of readdirSync(one, { withFileTypes: true })) {
      if (!second.isDirectory()) continue;
      const two = join(one, second.name);
      if (existsSync(join(two, 'package.json'))) found.push(two);
    }
  }
  return found
    .filter((dir) => {
      const pkg = JSON.parse(readFileSync(join(dir, 'package.json'), 'utf8'));
      return typeof pkg.scripts?.build === 'string';
    })
    .sort();
}

/// Examples that do not build today, with the reason. Named rather than
/// silently skipped: `npm run build` should not be quietly narrower than "every
/// example", and a reader who wonders about one of these should be able to see
/// why without bisecting.
const KNOWN_BROKEN = new Map([
  ['ogre/bouncing-ball', 'AS105: needs 133 initial pages, session.json declares 132 (docs/known-issues.md)'],
]);

const filter = (process.env.TENSION_EXAMPLES ?? '')
  .split(/[\s,]+/)
  .filter(Boolean);

let examples = findExamples();
if (filter.length) {
  examples = examples.filter((dir) => {
    const rel = dir.slice(examplesRoot.length + 1);
    return filter.some((want) => rel === want || rel.endsWith(`/${want}`));
  });
  if (!examples.length) {
    console.error(`build-examples: TENSION_EXAMPLES matched nothing (${filter.join(', ')})`);
    process.exit(1);
  }
}

// One toolchain check, up front, rather than the same confusing failure inside
// the first example that imports the framework.
const framework = join(repo, 'tension-framework', 'build', 'session.asconfig.json');
if (!existsSync(framework)) {
  console.error('build-examples: no framework session config\n' +
                '  run:  npm run build:framework   (or npm run build)');
  process.exit(1);
}

let failed = 0;
let skipped = 0;
for (const dir of examples) {
  const rel = dir.slice(examplesRoot.length + 1);
  if (!filter.length && KNOWN_BROKEN.has(rel)) {
    console.log(`==> skipping ${rel}: ${KNOWN_BROKEN.get(rel)}`);
    skipped++;
    continue;
  }
  console.log(`==> building ${rel}`);
  // Check for the *dependency*, not just the directory: a tree installed before
  // these packages existed has a node_modules and no link to them, and that
  // stale tree is exactly what makes a build pick up an old adapter.
  const wired = existsSync(join(dir, 'node_modules', '@yabgu_gm', 'tension-core'));
  if (!wired) {
    console.log(`    installing ${rel} deps`);
    const install = npm(['install', '--no-audit', '--no-fund'], {
      cwd: dir, stdio: 'inherit',
      env: { ...process.env, TENSION_SKIP_MODEL_FETCH: '1' },
    });
    if (install.status !== 0) {
      console.error(`build-examples: ${rel}: npm install failed (${install.status})`);
      failed++;
      continue;
    }
  }
  const built = npm(['run', 'build'], { cwd: dir, stdio: 'inherit' });
  if (built.status !== 0) {
    console.error(`build-examples: ${rel}: build failed (${built.status})`);
    failed++;
  }
}

if (failed) {
  console.error(`\nbuild-examples: ${failed} of ${examples.length} example(s) failed`);
  process.exit(1);
}
const built = examples.length - skipped;
console.log(`\nbuild-examples: ${built} example(s) built` +
            (skipped ? `, ${skipped} skipped (known broken)` : ''));
