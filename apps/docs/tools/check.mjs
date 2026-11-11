#!/usr/bin/env node
// Build every documentation asset, then verify it.
//
// This is what `npm test` runs as the `docs` suite. The order matters: each
// step consumes the one before it (`search` reads `docs.bin`; `run-examples`
// reads `docs.bin` to find the runnable blocks), so a failure is reported at the
// step that caused it rather than three steps later as an unreadable file.
//
// **It installs its own dependency.** `marked` is a devDependency of this
// package, and a fresh clone has no `node_modules` — the same situation
// `scripts/build-framework.mjs` handles for `tensionscript`. Installing here
// rather than documenting a manual step is what makes `npm test` the whole
// first-run story, which is the rule this repository already follows.

import { spawnSync } from 'node:child_process';
import { existsSync } from 'node:fs';
import { dirname, join, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';

const here = dirname(fileURLToPath(import.meta.url));
const appDir = resolve(here, '..');
const repo = resolve(appDir, '..', '..');
const WIN = process.platform === 'win32';

function run(command, args, options = {}) {
  const result = spawnSync(command, args, { stdio: 'inherit', ...options });
  if (result.error) {
    process.stderr.write(`docs: ${command}: ${result.error.message}\n`);
    process.exit(1);
  }
  return result.status ?? 1;
}

function step(name, args) {
  process.stdout.write(`==> docs: ${name}\n`);
  const status = run(process.execPath, args, { cwd: appDir });
  if (status !== 0) {
    process.stderr.write(`docs: ${name} failed (exit ${status})\n`);
    process.exit(status);
  }
}

// ── the dependency ──────────────────────────────────────────────────────────

const marked = join(appDir, 'node_modules', 'marked', 'package.json');
if (!existsSync(marked)) {
  process.stdout.write('docs: installing the parser (marked)...\n');
  const status = run('npm', ['install', '--silent', '--no-audit', '--no-fund'], {
    cwd: appDir,
    shell: WIN, // npm is a .cmd shim on Windows and cannot be spawned without one
  });
  if (status !== 0) {
    process.stderr.write('docs: npm install failed in apps/docs\n');
    process.exit(status);
  }
}

// ── the pipeline ────────────────────────────────────────────────────────────

step('bundle      (Markdown + TSDoc -> docs.bin)', ['tools/bundle.mjs']);
step('search      (inverted index -> search.bin)', ['tools/search.mjs']);
// The baker lives in the framework, because the atlas's geometry and the
// toolkit's cell constants are one contract (`assembly/ui/theme.ts`): a second
// copy here is how the `m` and `w` glyphs went wrong twice. It writes into the
// *current* directory's `assets/`, which is this one.
step('make-font   (glyph table -> ui.iwi)',
     ['../../tension-framework/tools/font/make-font.mjs']);
step('run-examples(compile + run -> transcripts.bin)', ['tools/run-examples.mjs']);

process.stdout.write('==> docs: verify\n');
const verify = spawnSync(process.execPath, ['tools/verify.mjs', '--show', '1'], {
  cwd: appDir,
  encoding: 'utf8',
});
// The dump of the first page is the useful part of a CI log: it is what a reader
// sees, rendered from the same bytes the guest will read.
if (verify.stdout) process.stdout.write(verify.stdout);
if (verify.status !== 0) {
  if (verify.stderr) process.stderr.write(verify.stderr);
  process.stderr.write(`docs: verify failed (exit ${verify.status})\n`);
  process.exit(verify.status ?? 1);
}
