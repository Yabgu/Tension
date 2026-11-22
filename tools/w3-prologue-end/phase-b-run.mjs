#!/usr/bin/env node
// Phase B runner: a list of (guest, function, first-line, non-first-line) cases,
// each measured once by phase-b-measure.mjs, reported as one table.
//
//   node phase-b-run.mjs <cases.json> <out.json>
//
// The cases file is authored by hand from the sources (so the "first statement"
// claim is a reading of the code, not a guess by the tool), and every case is
// then measured; a case whose line has no DWARF row is reported as such rather
// than silently dropped.
import fs from 'node:fs';
import path from 'node:path';
import { spawnSync } from 'node:child_process';

const [, , casesPath, outPath] = process.argv;
const cases = JSON.parse(fs.readFileSync(casesPath, 'utf8'));

const here = path.dirname(new URL(import.meta.url).pathname.replace(/^\/([A-Za-z]:)/, '$1'));
const measure = path.join(here, 'phase-b-measure.mjs');

const rows = [];
for (const testCase of cases) {
  const result = spawnSync(
    process.execPath,
    [
      measure,
      '--guest',
      testCase.guest,
      '--file',
      testCase.file,
      '--line',
      String(testCase.line),
      ...(testCase.hostArg ?? []).flatMap((a) => ['--host-arg', a]),
    ],
    { encoding: 'utf8', maxBuffer: 64 * 1024 * 1024 },
  );

  if (result.status !== 0) {
    rows.push({
      ...testCase,
      error: (result.stderr || result.stdout || '').trim().split(/\r?\n/).slice(-3).join(' | '),
    });
    process.stderr.write(`FAILED ${testCase.function} ${testCase.file}:${testCase.line}\n`);
    continue;
  }

  const line = (result.stdout ?? '').trim().split(/\r?\n/).filter(Boolean).pop();
  const observed = JSON.parse(line);
  const row = {
    module: testCase.module,
    function: testCase.function,
    kind: testCase.kind,
    file: testCase.file,
    requestedLine: testCase.line,
    verdict: observed.verdict,
    stopped: Boolean(observed.stop),
    stoppedLine: observed.stop?.line ?? null,
    stoppedPc: observed.stop?.pc_hex ?? null,
    breakpointLocations: observed.breakpointLocations,
    rowCountForRequestedLine: observed.requestedLineRows.length,
    requestedLineRowAddrs: observed.requestedLineRows.map((r) => r.addr_hex),
    rowAfterRequestedLine: observed.rowAfterRequestedLine,
    stopRow: observed.stopRow,
  };
  rows.push(row);
  process.stderr.write(
    `${row.function.padEnd(22)} ${row.kind.padEnd(9)} line ${String(row.requestedLine).padStart(3)} -> ${row.verdict}\n`,
  );
}

fs.writeFileSync(outPath, `${JSON.stringify({ cases: rows }, null, 2)}\n`);
console.log(`wrote ${outPath} (${rows.length} cases)`);
