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

import { mkdtempSync, readFileSync, rmSync, writeFileSync } from 'node:fs';
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

// ── 3. the docs are not empty ───────────────────────────────────────────────

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
