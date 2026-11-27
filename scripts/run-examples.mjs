#!/usr/bin/env node
// Run every example that can run headless, and classify what happened.
//
// `build:examples` answers "does it compile". This answers "does it *run*", which is a
// different question and the one four rounds of this project kept conflating: a corpus that
// builds is not a corpus that works. Each example runs in its own directory under a timeout,
// and the outcome is one of four words — no prose, no judgement in the classifier:
//
//   ran              exit 0
//   hung             no exit before the timeout (SIGKILL after)
//   refused-by-name  exited non-zero and the output names a refusal
//   needs-display    exited non-zero and the output says there is no display/device
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

/// The diagnostic a *host* prints when it has no display or no device. Deliberately about
/// the host and not about the example: the same wording comes from SDL and Vulkan, and a
/// list keyed on an example's name would be a hardcoded answer rather than a measurement.
const DISPLAY_SIGNS = [
  'no available video device',
  'could not initialize',
  'failed to create window',
  'vulkan',
  'x11',
  'wayland',
  'DISPLAY',
  'no display',
  'dri3',
  'egl',
  'surface 0x0',
];

/// Output that is the tree refusing something on purpose. `refused`, `not implemented`,
/// `unavailable`, a capability the build does not have — all of these are the loader or the
/// guest naming a limit, which is a pass for this instrument even though the exit is 1.
const REFUSAL_SIGNS = [
  'refused',
  'not implemented',
  'not available',
  'requires ',
  'unsupported',
  'did not export',
  'declares `start`',
  'needs a session',
  'no session',
];

function lastDiagnostic(text) {
  const lines = text
    .split('\n')
    .map((line) => line.replace(/\x1b\[[0-9;]*m/g, '').trimEnd())
    .filter(Boolean);
  for (let i = lines.length - 1; i >= 0; i -= 1) {
    const line = lines[i];
    if (/^(Error|error:|ERROR|thread .* panicked|npm error)/.test(line)) return line;
  }
  return lines.length ? lines[lines.length - 1] : '';
}

function classify(status, timedOut, combined) {
  if (timedOut) return 'hung';
  if (status === 0) return 'ran';
  const lower = combined.toLowerCase();
  // Refusal first: a refusal that happens to name a display is still the tree saying no on
  // purpose, and the four words are ordered by which fact is more specific.
  if (REFUSAL_SIGNS.some((sign) => lower.includes(sign.toLowerCase()))) return 'refused-by-name';
  if (DISPLAY_SIGNS.some((sign) => lower.includes(sign.toLowerCase()))) return 'needs-display';
  return 'refused-by-name';
}

/// One example, in its own directory, under a timeout.
function runOne(dir, timeoutSeconds) {
  const rel = relativeName(dir);
  const pkg = JSON.parse(readFileSync(join(dir, 'package.json'), 'utf8'));
  // The artifact an example runs is named by its own config (`game.wasm`, `story.wasm`,
  // `demo.wasm`, …), so this asks the build directory rather than guessing at names: one
  // guessed list reported `audio` as unbuilt when it had always been built.
  const buildDir = join(dir, 'build');
  const built = existsSync(buildDir)
    ? readdirSync(buildDir).filter((name) => name.endsWith('.wasm'))
    : [];
  if (!built.length) {
    return { rel, verdict: 'no-artifact', detail: 'no build/*.wasm — run `npm run build:examples`' };
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
  const detail = verdict === 'ran' ? `${elapsed}s` : `${elapsed}s — ${lastDiagnostic(combined)}`;
  void pkg;
  return { rel, verdict, detail };
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

console.log(`run-examples: ${examples.length} example(s), ${DEFAULT_TIMEOUT}s each, stdin closed`);
console.log('');

const rows = [];
for (const dir of examples) {
  const row = runOne(dir, DEFAULT_TIMEOUT);
  rows.push(row);
  console.log(`  ${row.verdict.padEnd(16)} ${row.rel.padEnd(28)} ${row.detail}`);
}

const counts = new Map();
for (const row of rows) counts.set(row.verdict, (counts.get(row.verdict) ?? 0) + 1);
const summary = [...counts.entries()].map(([verdict, n]) => `${n} ${verdict}`).join(', ');

console.log('');
console.log(`run-examples: ${rows.length} example(s) — ${summary}`);

// **`hung` is the failure.** Everything else is a fact about this host, the build, or a
// refusal that is doing its job. A census that failed on `needs-display` would be red on
// every runner without a GPU, which is the shape of a check nobody keeps green.
const hung = rows.filter((row) => row.verdict === 'hung');
if (hung.length) {
  console.error('');
  console.error(`run-examples: ${hung.length} example(s) hung — this is the failure:`);
  for (const row of hung) console.error(`  ${row.rel}: ${row.detail}`);
  process.exit(1);
}
process.exit(0);
