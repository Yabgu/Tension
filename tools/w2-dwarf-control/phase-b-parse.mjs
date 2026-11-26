#!/usr/bin/env node
// Phase B: read the DWARF the guest actually carries and answer four questions
// per source row — where the row is, which sequence it belongs to, which CU owns
// it, and whether its address is inside a CU range.
//
// Input is `llvm-dwarfdump` output over the .wasm itself (its `.debug_line`,
// `.debug_info` and `.debug_ranges` custom sections), never the `.wasm.map` and
// never a disassembly.
//
//   llvm-dwarfdump --debug-line   build/game.wasm > line.txt
//   llvm-dwarfdump --debug-info   build/game.wasm > info.txt
//   llvm-dwarfdump --debug-ranges build/game.wasm > ranges.txt
//   node phase-b-parse.mjs line.txt info.txt ranges.txt > phase-b-dwarf-rows.json
//
// Written for this round and committed with its output, because the numbers in
// STATE.md should be reproducible by someone who was not here.

import fs from 'node:fs';

const [linePath, infoPath, rangesPath] = process.argv.slice(2);
if (!linePath || !infoPath || !rangesPath) {
  console.error('usage: phase-b-parse.mjs <debug-line.txt> <debug-info.txt> <debug-ranges.txt>');
  process.exit(2);
}

const lineText = fs.readFileSync(linePath, 'utf8');
const infoText = fs.readFileSync(infoPath, 'utf8');
const rangesText = fs.readFileSync(rangesPath, 'utf8');

/** The four source lines under test, and the file whose rows they are. */
const TARGET_LINES = [10, 11, 14, 22];

// ── the line table ────────────────────────────────────────────────────────────
//
// llvm-dwarfdump prints one row per line: address, line, column, file index.
// A row flagged end_sequence closes the current sequence.

const rowRe = /^(0x[0-9a-f]{16})\s+(\d+)\s+(\d+)\s+(\d+)\s+(\d+)\s+(\d+)\s+(\d+)\s*(.*)$/;

/** `file_names[N]` -> name, so the row's file index can be read as a filename. */
const fileNames = new Map();
{
  const re = /^\s*file_names\[\s*(\d+)\]:\s*\r?\n\s*name:\s*"(.*)"/gm;
  let m;
  while ((m = re.exec(lineText))) fileNames.set(Number(m[1]), m[2]);
}

const rows = [];
for (const line of lineText.split(/\r?\n/)) {
  const m = rowRe.exec(line);
  if (!m) continue;
  rows.push({
    address: parseInt(m[1], 16),
    line: Number(m[2]),
    column: Number(m[3]),
    fileIndex: Number(m[4]),
    flags: m[8].trim(),
    endSequence: /end_sequence/.test(m[8]),
  });
}

const sequences = [];
let current = [];
for (const row of rows) {
  current.push(row);
  if (row.endSequence) {
    sequences.push(current);
    current = [];
  }
}
if (current.length) sequences.push(current);

// ── the CU and its ranges ────────────────────────────────────────────────────

const ranges = [];
for (const line of rangesText.split(/\r?\n/)) {
  const m = /^([0-9a-f]{8})\s+([0-9a-f]{8})\s+([0-9a-f]{8})\s*$/.exec(line.trim());
  if (!m) continue;
  ranges.push({ begin: parseInt(m[2], 16), end: parseInt(m[3], 16) });
}

const cuName = /DW_AT_name\t\("([^"]+)"\)/.exec(infoText);
const fnDie =
  /DW_AT_name\t\("game\/_start_game"\)[\s\S]{0,200}?DW_AT_low_pc\t\(0x([0-9a-f]+)\)[\s\S]{0,120}?DW_AT_high_pc\t\(0x([0-9a-f]+)\)/.exec(
    infoText,
  );

const fn = fnDie
  ? (() => {
      const low = parseInt(fnDie[1], 16);
      const high = parseInt(fnDie[2], 16);
      // DWARF4 constant form: high_pc is a length when it is smaller than low_pc.
      return { name: 'game/_start_game', lowPc: low, highPc: high > low ? high : low + high };
    })()
  : null;

const hx8 = (n) => `0x${n.toString(16).padStart(8, '0')}`;
const hx16 = (n) => `0x${n.toString(16).padStart(16, '0')}`;
const rangeAt = (n) => ranges.find((r) => n >= r.begin && n < r.end) ?? null;

const findings = [];
for (let s = 0; s < sequences.length; ++s) {
  const seq = sequences[s];
  for (let i = 0; i < seq.length; ++i) {
    const row = seq[i];
    if (!TARGET_LINES.includes(row.line)) continue;
    const name = fileNames.get(row.fileIndex) ?? '';
    if (name !== 'game.ten') continue;
    const range = rangeAt(row.address);
    findings.push({
      line: row.line,
      rowAddress: hx16(row.address),
      rowAddressDecimal: row.address,
      fileIndex: row.fileIndex,
      file: name,
      column: row.column,
      flags: row.flags,
      rowIndexInSequence: i,
      firstOfSequence: i === 0,
      sequenceIndex: s,
      sequenceStart: hx16(seq[0].address),
      sequenceEnd: hx16(seq[seq.length - 1].address),
      sequenceRowCount: seq.length,
      offsetFromSequenceStart: row.address - seq[0].address,
      inCuRanges: Boolean(range),
      containingRange: range ? `[${hx8(range.begin)}, ${hx8(range.end)})` : null,
      rowAddressIsRangeStart: range ? range.begin === row.address : false,
      inFunctionRange: fn ? row.address >= fn.lowPc && row.address < fn.highPc : null,
      offsetFromFunctionLowPc: fn ? row.address - fn.lowPc : null,
    });
  }
}

console.log(
  JSON.stringify(
    {
      binary: 'examples/io/build/game.wasm',
      readFrom: ['.debug_line', '.debug_info', '.debug_ranges'],
      cu: {
        name: cuName ? cuName[1] : null,
        rangesEntries: ranges.length,
        rangesAddressed: '.debug_ranges offset 0 (DW_AT_ranges)',
      },
      functionDie: fn
        ? {
            name: fn.name,
            lowPc: hx8(fn.lowPc),
            highPc: hx8(fn.highPc),
            note: 'DW_AT_high_pc is a length in this CU (DWARF4 constant form)',
          }
        : null,
      totalLineTableRows: rows.length,
      sequenceCount: sequences.length,
      rows: findings,
    },
    null,
    2,
  ),
);
