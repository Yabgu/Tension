#!/usr/bin/env node
// Run every example that can run headless, and classify what happened.
//
// `build:examples` answers "does it compile". This answers "does it *run*", which is a
// different question and the one four rounds of this project kept conflating: a corpus that
// builds is not a corpus that works. Each example runs in its own directory under a timeout,
// and the outcome is one of four words — no prose, no judgement in the classifier:
//
//   ran              exit 0 and nothing said otherwise
//   ran-but-failed   exit 0, and the transcript says the guest failed (DL63)
//   hung             no exit before the timeout (SIGKILL after)
//   refused-by-name  exited non-zero and the output names a refusal
//   needs-display    exited non-zero and the output says there is no display/device
//   failed           exited non-zero and named neither — a crash (DL63)
//
// **A backend axis (DL63).** By default each example runs the artifact it declares —
// which made "16 ran" a claim about declarations, not about the engine: four OGRE
// examples declared `promise` and read as `ran` while doing nothing at all. Set
// `TENSION_RUN_BACKEND=fiber` (or `continuation`, `promise`) and every example is
// **rebuilt** for that backend before it runs, so the same corpus is measured on a
// backend none of them declare:
//
//   TENSION_RUN_BACKEND=fiber npm run run:examples
//
// The table's `backend` column is read **from the artifact** (`tension.requires`), not
// from the request, so a build that silently ignored the flag is visible rather than
// assumed away.
//
// **A forced sweep rebuilds in place**, so it leaves the examples' `build/` directories
// holding that profile's artifacts. Run the declared profile again (or
// `npm run build:examples`) before trusting a declared table afterwards — measured in
// DL63: a sweep was followed by a "declared" run that reported 4 `ran-but-failed` and 2
// `hung` because those examples were still fiber builds. Stated here because the failure
// mode is silent: every row looks like a normal row.
//
// **`hung` is the failure this instrument exists for**, so its exit status is non-zero.
// Everything else is reported and tolerated: a `needs-display` example is a fact about the
// host, and a refusal is the compiler or the loader doing its job by name.
//
// The verdict is the transcript's, not this script's opinion: the classifier reads the last
// diagnostic-shaped line and quotes it in the table, so a wrong classification is visible.
//
//   npm run run:examples                    every example, 30 s each
//   TENSION_RUN_TIMEOUT=60 npm run run:examples
//   TENSION_EXAMPLES="ai io" npm run run:examples
//
// Nothing here builds. Run `npm run build:examples` first; an example with no artifact is
// reported as `no-artifact` rather than being silently attempted (a build would hide the
// difference between "does not run" and "was never built").

import { spawnSync } from 'node:child_process';
import { existsSync, readdirSync, readFileSync } from 'node:fs';
import { dirname, join, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';

import { classify, declaredBackend, guestFailure, lastDiagnostic } from './lib/census-classify.mjs';

const WIN = process.platform === 'win32';
const here = dirname(fileURLToPath(import.meta.url));
const repo = resolve(here, '..');
const examplesRoot = join(repo, 'examples');
const DEFAULT_TIMEOUT = Number(process.env.TENSION_RUN_TIMEOUT ?? 30);

/// An example's name relative to examples/, with POSIX separators (Windows hands back
/// backslashes, and every key here is written `ogre/hello-triangle`).
function relativeName(dir) {
  return dir.slice(examplesRoot.length + 1).split(/[\\/]/).join('/');
}

/// Every directory with a package.json that declares a `run` script — the one this script
/// drives. `build`-only directories are a build question, not a run question.
function findRunnable() {
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
      return typeof pkg.scripts?.run === 'string';
    })
    .sort();
}

/// The backend this sweep forces, or `''` for each example's own declaration.
const FORCED_BACKEND = (process.env.TENSION_RUN_BACKEND ?? '').trim();
/// A rebuild in a forced profile runs a codegen step in some examples, so it gets its
/// own, longer bound than the run.
const BUILD_TIMEOUT = Number(process.env.TENSION_BUILD_TIMEOUT ?? 300);

/// One example, in its own directory, under a timeout.
function runOne(dir, timeoutSeconds) {
  const rel = relativeName(dir);
  const pkg = JSON.parse(readFileSync(join(dir, 'package.json'), 'utf8'));

  // **A forced profile rebuilds first** (DL63). The host refuses a guest built for the
  // other backend *by name* — `--executor` is a test instrument, not a converter — so the
  // only honest way to run a `promise` example on fiber is to build it for fiber. The
  // example's own build script supplies every other flag; a later `--stackful-backend`
  // wins, which is what makes appending it here a *profile* rather than a second recipe.
  if (FORCED_BACKEND) {
    const built = spawnSync('npm', ['run', 'build', '--', '--stackful-backend', FORCED_BACKEND], {
      cwd: dir,
      shell: WIN,
      timeout: BUILD_TIMEOUT * 1000,
      encoding: 'utf8',
      stdio: ['ignore', 'pipe', 'pipe'],
    });
    if (built.status !== 0) {
      const combined = `${built.stdout ?? ''}${built.stderr ?? ''}`;
      return {
        rel, backend: FORCED_BACKEND, verdict: 'build-failed',
        detail: `${lastDiagnostic(combined) || 'the build exited non-zero'}`,
      };
    }
  }

  // The artifact an example runs is named by its own config (`game.wasm`, `story.wasm`,
  // `demo.wasm`, …), so this asks the build directory rather than guessing at names: one
  // guessed list reported `audio` as unbuilt when it had always been built.
  const buildDir = join(dir, 'build');
  const built = existsSync(buildDir)
    ? readdirSync(buildDir).filter((name) => name.endsWith('.wasm'))
    : [];
  if (!built.length) {
    return { rel, backend: '-', verdict: 'no-artifact', detail: 'no build/*.wasm — run `npm run build:examples`' };
  }
  // The artifact's own claim, first `.wasm` in the build directory (an example builds one).
  let backend = '-';
  try {
    backend = declaredBackend(readFileSync(join(buildDir, built[0])));
  } catch {
    backend = '-';
  }

  const started = Date.now();
  const result = spawnSync('npm', ['run', 'run'], {
    cwd: dir,
    shell: WIN,
    timeout: timeoutSeconds * 1000,
    encoding: 'utf8',
    // stdin closed: an example that waits for input must see EOF and say so, not block for
    // the full timeout. The census is about the guest's behaviour, not the operator's.
    stdio: ['ignore', 'pipe', 'pipe'],
    killSignal: 'SIGKILL',
  });
  const elapsed = ((Date.now() - started) / 1000).toFixed(1);
  const combined = `${result.stdout ?? ''}${result.stderr ?? ''}`;
  const timedOut = result.error?.code === 'ETIMEDOUT' || result.signal === 'SIGKILL';
  const verdict = classify(result.status, timedOut, combined);
  // A `ran` row is the elapsed time and nothing else; every other word quotes the line
  // that decided it — and `ran-but-failed` quotes the *guest's* line, which is the whole
  // point of the class.
  const why = verdict === 'ran-but-failed' ? guestFailure(combined) : lastDiagnostic(combined);
  const detail = verdict === 'ran' ? `${elapsed}s` : `${elapsed}s — ${why}`;
  void pkg;
  return { rel, backend, verdict, detail };
}

const filter = (process.env.TENSION_EXAMPLES ?? '')
  .split(/[\s,]+/)
  .filter(Boolean);

let examples = findRunnable();
if (filter.length) {
  examples = examples.filter((dir) => {
    const rel = relativeName(dir);
    return filter.some((want) => rel === want || rel.endsWith(`/${want}`));
  });
  if (!examples.length) {
    console.error(`run-examples: TENSION_EXAMPLES matched nothing (${filter.join(', ')})`);
    process.exit(1);
  }
}

console.log(
  `run-examples: ${examples.length} example(s), ${DEFAULT_TIMEOUT}s each, stdin closed` +
  (FORCED_BACKEND ? `, **rebuilt for backend=${FORCED_BACKEND}**` : ', each on its own declared backend')
);
console.log('');

const rows = [];
for (const dir of examples) {
  const row = runOne(dir, DEFAULT_TIMEOUT);
  rows.push(row);
  console.log(
    `  ${String(row.backend).padEnd(12)} ${row.verdict.padEnd(16)} ${row.rel.padEnd(28)} ${row.detail}`
  );
}

const counts = new Map();
for (const row of rows) counts.set(row.verdict, (counts.get(row.verdict) ?? 0) + 1);
const summary = [...counts.entries()].map(([verdict, n]) => `${n} ${verdict}`).join(', ');

console.log('');
console.log(`run-examples: ${rows.length} example(s) — ${summary}${FORCED_BACKEND ? ` (backend=${FORCED_BACKEND})` : ''}`);

// **`hung` is the failure**, and since DL63 so is `ran-but-failed`: a guest that said it
// failed and exited 0 is the same species of green line, one word quieter. Everything
// else is a fact about this host, the build, or a refusal that is doing its job — a census
// that failed on `needs-display` would be red on every runner without a GPU, which is the
// shape of a check nobody keeps green.
const failed = rows.filter(
  (row) => row.verdict === 'hung' || row.verdict === 'ran-but-failed' || row.verdict === 'failed'
);
if (failed.length) {
  console.error('');
  console.error(`run-examples: ${failed.length} example(s) did not do their work — this is the failure:`);
  for (const row of failed) console.error(`  ${row.rel} [${row.backend}] ${row.verdict}: ${row.detail}`);
  process.exit(1);
}
process.exit(0);
