#!/usr/bin/env node
// The ABI docs are true, and are not stale.
//
// Two independent checks, because they catch different failures:
//
//   1. **Drift.** Regenerate in memory and compare byte for byte with what is
//      checked in. This catches the ordinary case — a slot appended or an
//      import renamed, and nobody re-ran the generator.
//
//   2. **The offsets.** The doc's offset column is computed by modelling the
//      struct layout, and a model is exactly the kind of thing that is silently
//      wrong. So a C program includes the real header and prints `offsetof` for
//      every field, and the two are compared. This is not a re-derivation: the
//      compiler is the authority on layout, and if it disagrees the generator
//      is wrong even when the doc is "up to date".
//
// The probe is skipped, loudly, when there is no C compiler on PATH. A skipped
// check is reported as skipped rather than counted as a pass.
//
// Usage: node scripts/test-abi-docs.mjs

import { cpSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from 'node:fs';
import { spawnSync } from 'node:child_process';
import { tmpdir } from 'node:os';
import { basename, join } from 'node:path';
import { REPO, which } from './lib/toolchain.mjs';
import { spawn } from './lib/proc.mjs';

const node = process.execPath;
const generator = join(REPO, 'scripts', 'gen-abi-doc.mjs');
const headerDir = join(REPO, 'tension-core', 'include');

let failures = 0;
const fail = (message) => {
  failures += 1;
  console.error(`not ok  ${message}`);
};
const ok = (message) => console.log(`ok      ${message}`);

// ── 1. drift ────────────────────────────────────────────────────────────────

const drift = spawn(node, [generator, '--check']);
if (drift.status === 0) {
  for (const line of drift.stdout.trim().split('\n')) console.log(`ok      ${line.replace(/^abi-docs: /, '')}`);
} else {
  const detail = `${drift.stdout}${drift.stderr}`.trim();
  for (const line of detail.split('\n')) console.error(`        ${line}`);
  fail('docs/abi/*.md match their sources');
}

// ── 2. offsets, against the compiler ────────────────────────────────────────

const listed = spawn(node, [generator, '--json']);
if (listed.status !== 0) {
  fail(`the generator could not list its fields: ${listed.stderr.trim()}`);
} else {
  const { fields, sizes } = JSON.parse(listed.stdout);

  const cc = ['cc', 'gcc', 'clang'].map((name) => which(name)).find((path) => path);
  if (!cc) {
    console.log('skip    C probe (no C compiler on PATH) — offsets are unverified this run');
  } else {
    const dir = mkdtempSync(join(tmpdir(), 'tension-abi-'));
    try {
      const lines = [
        '#include <stddef.h>',
        '#include <stdio.h>',
        '#include "tension_adapter.h"',
        '',
        'int main(void) {',
      ];
      for (const [struct, list] of Object.entries(fields)) {
        lines.push(`  printf("sizeof ${struct} %zu\\n", sizeof(${struct}));`);
        for (const field of list) {
          lines.push(`  printf("offsetof ${struct} ${field.name} %zu\\n", offsetof(${struct}, ${field.name}));`);
        }
      }
      lines.push('  return 0;', '}', '');
      const source = join(dir, 'probe.c');
      const binary = join(dir, process.platform === 'win32' ? 'probe.exe' : 'probe');
      writeFileSync(source, lines.join('\n'));

      const built = spawn(cc, ['-std=c11', '-I', headerDir, source, '-o', binary]);
      if (built.status !== 0) {
        // The header's own static_asserts run here too, so a compile failure is
        // a real failure of the contract, not of the probe.
        for (const line of `${built.stderr}`.trim().split('\n')) console.error(`        ${line}`);
        fail('the header compiles in C11 (the shape assertions are part of the build)');
      } else {
        const run = spawn(binary, []);
        if (run.status !== 0) {
          fail(`the offset probe exited ${run.status}: ${run.stderr.trim()}`);
        } else {
          const reported = new Map();
          for (const line of run.stdout.trim().split('\n')) {
            const parts = line.split(' ');
            if (parts[0] === 'sizeof') reported.set(`sizeof ${parts[1]}`, Number(parts[2]));
            else if (parts[0] === 'offsetof') reported.set(`${parts[1]}.${parts[2]}`, Number(parts[3]));
          }
          for (const [struct, expected] of Object.entries(sizes)) {
            const actual = reported.get(`sizeof ${struct}`);
            if (actual === expected) ok(`sizeof(${struct}) == ${actual}`);
            else fail(`sizeof(${struct}): the doc says ${expected}, the compiler says ${actual}`);
          }
          for (const [struct, list] of Object.entries(fields)) {
            for (const field of list) {
              const actual = reported.get(`${struct}.${field.name}`);
              if (actual === field.offset) continue;
              fail(`offsetof(${struct}, ${field.name}): the doc says ${field.offset}, the compiler says ${actual}`);
            }
          }
          ok(`every offset in docs/abi/adapter.md matches ${basename(cc)}`);
        }
      }
    } finally {
      rmSync(dir, { recursive: true, force: true });
    }
  }
}

// ── 3. the hook fires ───────────────────────────────────────────────────────
//
// The drift check above is what CI runs. The *hook* runs at the moment a commit
// is made, and the failure it exists for was an ordering mistake inside one
// commit (regenerate, then edit above the block again), which no amount of care
// in a commit message prevents. A hook nobody tested is a hook that may simply
// not fire, so this builds a small repository holding the generator's inputs,
// makes a commit that shifts a citation without regenerating, and asserts git
// refuses it — through `core.hooksPath`, the mechanism a developer's clone uses,
// not by calling the script the hook calls.

try {
  const proof = proveHookRejectsStaleCommit();
  if (proof.ok) console.log(`ok      ${proof.message}`);
  else fail(proof.message);
} catch (error) {
  fail(`the pre-commit hook could not be exercised: ${error.message}`);
}

/// Build a throwaway repo from this tree's generator inputs and prove the hook
/// rejects a stale tree, then accepts the same tree once regenerated.
function proveHookRejectsStaleCommit() {
  const root = mkdtempSync(join(tmpdir(), 'tension-hook-'));
  try {
    // Only what the generator reads, plus the hook itself. A full checkout would
    // be slower and would test git rather than the hook.
    const copies = [
      ['scripts/gen-abi-doc.mjs', 'scripts/gen-abi-doc.mjs'],
      ['scripts/lib', 'scripts/lib'],
      ['scripts/hooks', 'scripts/hooks'],
      ['.githooks', '.githooks'],
      ['tension-core/include', 'tension-core/include'],
      ['tension-core/src', 'tension-core/src'],
      ['docs/abi', 'docs/abi'],
      ['tension-ogre/src/adapter.cpp', 'tension-ogre/src/adapter.cpp'],
      ['tension-input/src/adapter.cpp', 'tension-input/src/adapter.cpp'],
      ['tension-2d/reference/adapter.cpp', 'tension-2d/reference/adapter.cpp'],
    ];
    for (const [from, to] of copies) {
      cpSync(join(REPO, from), join(root, to), { recursive: true });
    }

    const run = (args, options = {}) => spawnSync('git', args, { cwd: root, encoding: 'utf8', ...options });
    const must = (args) => {
      const result = run(args);
      if (result.status !== 0) {
        throw new Error(`\`git ${args.join(' ')}\` failed: ${(result.stderr ?? '').trim()}`);
      }
      return result;
    };

    must(['init', '-q']);
    must(['config', 'user.email', 'hook-test@example.invalid']);
    must(['config', 'user.name', 'hook test']);
    // The copy must be current before the negative case means anything.
    const baseline = spawnSync(node, [join(root, 'scripts', 'gen-abi-doc.mjs'), '--check'],
      { cwd: root, encoding: 'utf8' });
    if (baseline.status !== 0) {
      throw new Error(`the copied tree is already stale: ${baseline.stdout.trim()}`);
    }
    must(['add', '-A']);
    must(['commit', '-q', '-m', 'baseline']);

    // Now enable the hook the way a developer does, and move a citation: three
    // lines above the first `tension::platform` registration, `guest.md` left
    // alone. This is the slice-3 failure, reproduced.
    //
    // The registration lives in `host/platform_abi.rs` since 4b-3 (it used to be
    // inline in `main.rs`, registered for the process's own guest only). The
    // check follows the code rather than the file name: a fixture pinned to a
    // path the code has moved out of tests nothing.
    must(['config', 'core.hooksPath', '.githooks']);
    const registrations = join(root, 'tension-core', 'src', 'host', 'platform_abi.rs');
    const text = readFileSync(registrations, 'utf8');
    const anchor = text.indexOf('"tension::platform",');
    if (anchor < 0) throw new Error('host/platform_abi.rs has no tension::platform registration to shift');
    const lineStart = text.lastIndexOf('\n', anchor) + 1;
    writeFileSync(registrations, `${text.slice(0, lineStart)}// three lines\n// of shift\n// above the block\n${text.slice(lineStart)}`);
    must(['add', '-A']);

    const rejected = run(['commit', '-q', '-m', 'stale abi']);
    if (rejected.status === 0) {
      return { ok: false, message: 'the hook accepted a commit with stale ABI docs' };
    }
    const complaint = `${rejected.stdout ?? ''}${rejected.stderr ?? ''}`;
    if (!/stale/.test(complaint)) {
      return { ok: false, message: `the commit was refused, but not by the hook: ${complaint.trim().slice(0, 200)}` };
    }

    // And the same tree, regenerated, commits: the hook refuses staleness, not
    // the change.
    const regenerate = spawnSync(node, [join(root, 'scripts', 'gen-abi-doc.mjs')],
      { cwd: root, encoding: 'utf8' });
    if (regenerate.status !== 0) {
      throw new Error(`regenerating in the scratch repo failed: ${(regenerate.stderr ?? '').trim()}`);
    }
    must(['add', '-A']);
    const accepted = run(['commit', '-q', '-m', 'shifted and regenerated']);
    if (accepted.status !== 0) {
      return { ok: false, message: `the hook refused a regenerated commit: ${(accepted.stderr ?? '').trim()}` };
    }

    return {
      ok: true,
      message: 'the pre-commit hook refuses a commit that shifts an ABI citation ' +
        'without regenerating, and accepts it once regenerated',
    };
  } finally {
    rmSync(root, { recursive: true, force: true });
  }
}

// ── 4. the docs are not empty ───────────────────────────────────────────────

for (const name of ['adapter', 'guest']) {
  const path = join(REPO, 'docs', 'abi', `${name}.md`);
  let text = '';
  try {
    text = readFileSync(path, 'utf8');
  } catch {
    fail(`docs/abi/${name}.md is missing`);
    continue;
  }
  // A generator that parses nothing would still emit a valid document.
  // A row is a slot/field row: the adapter table's first cell is an index or a
  // dash, the guest table's is a backticked import name.
  const row = name === 'adapter' ? /^\| (?:\d+|—) \| /gm : /^\| `[a-z_]/gm;
  const rows = (text.match(row) ?? []).length;
  if (rows >= (name === 'adapter' ? 20 : 40)) ok(`docs/abi/${name}.md has ${rows} table rows`);
  else fail(`docs/abi/${name}.md has only ${rows} table rows — the parse found too little`);
}

if (failures > 0) {
  console.error(`\nabi-docs: ${failures} check(s) failed`);
  process.exit(1);
}
console.log('\nabi-docs: the generated ABI docs are current and the offsets match the compiler');
