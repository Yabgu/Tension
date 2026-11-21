#!/usr/bin/env node
// Join the DWARF rows (phase-a-line.mjs output) with the measurements
// (phase-b-run.mjs output) and decide, per case, whether the *rule* holds.
//
// The rule, in the form that can fail:
//   If the requested line's row is the FIRST row of its line-table sequence,
//   lldb binds a different row (the next one). If it is not the first row,
//   lldb binds the requested row exactly.
//
// A requested line with no row at all is reported as `no row` — a different
// question from the rule, and not counted either way.
import fs from 'node:fs';

const [, , measurementsPath, casesPath, ...rowFiles] = process.argv;

const measurements = JSON.parse(fs.readFileSync(measurementsPath, 'utf8'));
// `fileIndex` is authored in the cases file (a reading of the source tree), and
// the measurement rows do not carry it. Join the two so a module whose lines
// repeat across files is analysed against the right file.
const casesByKey = new Map();
for (const c of JSON.parse(fs.readFileSync(casesPath, 'utf8'))) {
  casesByKey.set(`${c.module}|${c.function}|${c.line}|${c.kind}`, c);
}

// rows per module, keyed by module name from the rows filename
const rowsByModule = {};
for (const spec of rowFiles) {
  const [module, path] = spec.split('=');
  const raw = fs.readFileSync(path, 'utf8').trim().split(/\r?\n/);
  const rows = raw.map((text) => {
    const p = text.trim().split(/\s+/);
    return {
      address: parseInt(p[0], 16),
      line: Number(p[1]),
      column: Number(p[2]),
      fileIndex: Number(p[3]),
      flags: p.slice(7).join(' '),
    };
  });
  rowsByModule[module] = rows;
}

function analyse(rows, requestedLine, fileIndex) {
  // Only rows for the file under test. A line number is not unique across a
  // module's file table (measured: async-io line 96 exists for file 24 and file
  // 69, and the first analysis without this filter reported a phantom row).
  const FILE_INDEX = fileIndex;
  const own = rows.filter((r) => r.fileIndex === FILE_INDEX);

  // Sequence boundaries, computed over the whole table so indices stay stable.
  const sequences = [];
  let current = [];
  for (const row of rows) {
    current.push(row);
    if (row.flags.includes('end_sequence')) {
      sequences.push(current);
      current = [];
    }
  }
  if (current.length) sequences.push(current);

  const hits = [];
  for (let s = 0; s < sequences.length; ++s) {
    const seq = sequences[s];
    for (let i = 0; i < seq.length; ++i) {
      if (seq[i].fileIndex !== FILE_INDEX) continue;
      if (seq[i].line !== requestedLine) continue;
      // A row with the same address as the end_sequence terminator is not a
      // distinct program point (the producer emits it to close the sequence).
      if (seq[i].flags.includes('end_sequence') && i > 0 && seq[i - 1].address === seq[i].address) continue;
      hits.push({ sequence: s, index: i, row: seq[i], sequenceLength: seq.length });
    }
  }

  // A line can have many rows (inlined bodies, loop backs). The rule is about
  // the *sequence the function starts in*, so evaluate the earliest-address hit
  // and, within its sequence, the first following row that names a different
  // source line — that row is where lldb stops instead.
  let prediction = null;
  if (hits.length) {
    const entry = hits.reduce((a, b) => (b.row.address < a.row.address ? b : a));
    const seq = sequences[entry.sequence];
    let target = null;
    if (entry.index === 0) {
      for (let i = 1; i < seq.length; ++i) {
        const row = seq[i];
        if (row.flags.includes('end_sequence')) break;
        if (row.fileIndex !== FILE_INDEX) continue;
        if (row.line !== entry.row.line) {
          target = { line: row.line, address: row.address };
          break;
        }
      }
      prediction = {
        entryRowAddress: entry.row.address,
        entryRowIsFirstOfSequence: true,
        targetLine: target ? target.line : requestedLine,
        targetAddress: target ? target.address : entry.row.address,
        why: target
          ? 'first row of sequence; the first following row with a different line is the slide target'
          : 'first row of sequence, and every following row names the same line -> no slide',
      };
    } else {
      prediction = {
        entryRowAddress: entry.row.address,
        entryRowIsFirstOfSequence: false,
        targetLine: requestedLine,
        targetAddress: entry.row.address,
        why: `row ${entry.index} of its sequence (not the first) -> no slide`,
      };
    }
  }

  return { hits, ownRowCount: own.length, prediction, sequences };
}

const table = [];
for (const c of measurements.cases) {
  if (!rowsByModule[c.module]) {
    table.push({ ...c, note: 'no rows file for module' });
    continue;
  }
  const authored = casesByKey.get(`${c.module}|${c.function}|${c.requestedLine}|${c.kind}`);
  const fileIndex = authored?.fileIndex ?? 61;
  const { hits, ownRowCount, prediction: rule } = analyse(
    rowsByModule[c.module],
    c.requestedLine,
    fileIndex,
  );
  const fileName = authored?.file ?? c.file;
  const isFirst = hits.some((h) => h.index === 0);
  const rowIndexes = hits.map((h) => h.index);
  const observed = c.verdict;
  const stopped = c.stopped;
  const stoppedLine = c.stoppedLine;

  // Predict: first row -> slide (stop on a different line); not first -> exact.
  let prediction;
  if (hits.length === 0) prediction = 'no row';
  else if (isFirst) prediction = 'different line';
  else prediction = 'requested line';

  let holds;
  if (!hits.length) holds = 'n/a (no row for this line)';
  else if (!stopped) holds = 'VIOLATION (no stop)';
  else if (rule.targetLine !== c.requestedLine) {
    holds =
      stoppedLine === rule.targetLine
        ? `holds (predicted line ${rule.targetLine})`
        : `VIOLATION (predicted ${rule.targetLine}, stopped ${stoppedLine})`;
  } else {
    holds = stoppedLine === c.requestedLine ? 'holds' : 'VIOLATION (slid on a row the rule says does not slide)';
  }

  table.push({
    module: c.module,
    function: c.function,
    file: fileName,
    label: c.kind,
    requestedLine: c.requestedLine,
    dwarfdRowForLine: hits.length ? hits.map((h) => ({ sequence: h.sequence, indexInSequence: h.index, of: h.sequenceLength, address: `0x${h.row.address.toString(16)}`, column: h.row.column })) : [],
    isFirstRowOfSequence: hits.length ? isFirst : null,
    entryRow: rule ? `0x${rule.entryRowAddress.toString(16)}` : null,
    entryRowIsFirstOfSequence: rule ? rule.entryRowIsFirstOfSequence : null,
    predictedTargetLine: rule ? rule.targetLine : null,
    predictionWhy: rule ? rule.why : null,
    observedVerdict: observed,
    stoppedLine,
    ownFileRowCount: ownRowCount,
    holds,
  });
}

const counted = table.filter((t) => t.holds === 'holds' || String(t.holds).startsWith('holds (') || String(t.holds).startsWith('VIOLATION'));
const obey = counted.filter((t) => String(t.holds).startsWith('holds')).length;
const violations = counted.filter((t) => String(t.holds).startsWith('VIOLATION'));

console.log(
  JSON.stringify(
    {
      rule: 'requested row is the first row of its sequence -> lldb stops at the first row of that sequence carrying a different source line; otherwise -> the requested row. A sequence whose rows are all one line does not slide.',
      countedCases: counted.length,
      obey,
      violations: violations.length,
      noRowCases: table.filter((t) => String(t.holds).startsWith('n/a')).length,
      table,
    },
    null,
    2,
  ),
);
