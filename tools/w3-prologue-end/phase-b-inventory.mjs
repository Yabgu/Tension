#!/usr/bin/env node
// Inventory: which functions in a module have line-table rows, and what their
// first row is. Joins .debug_info (subprogram DIEs: low_pc/high_pc) with the
// rows phase-a-line.mjs produced.
//
//   node phase-b-inventory.mjs <debug-info.txt> <rows-file> [file-name]
//
// A function's "first source line" is not guessed from the source: it is the
// line of the lowest-address row inside [low_pc, high_pc). That row is what a
// breakpoint on the first line would have to bind to.
import fs from 'node:fs';

const [, , infoPath, rowsPath, fileName = 'game.ten'] = process.argv;

const infoText = fs.readFileSync(infoPath, 'utf8');
const rowsRaw = fs.readFileSync(rowsPath, 'utf8').trim().split(/\r?\n/);

const rows = rowsRaw.map((text, i) => {
  const parts = text.trim().split(/\s+/);
  return {
    index: i,
    address: parseInt(parts[0], 16),
    line: Number(parts[1]),
    column: Number(parts[2]),
    fileIndex: Number(parts[3]),
    flags: parts.slice(7).join(' '),
  };
});

// Sequence boundaries, so "next row in the same sequence" is well defined.
let sequenceOf = [];
{
  let seq = 0;
  for (const row of rows) {
    sequenceOf[row.index] = seq;
    if (row.flags.includes('end_sequence')) seq++;
  }
}

// Subprogram DIEs: name, low_pc, high_pc. dwarf4 constant form -> high_pc can be
// a length; disambiguate with the following DIE's low_pc when needed.
const dieRe =
  /DW_TAG_subprogram\s*\r?\n\s*DW_AT_name\t\("([^"]+)"\)\s*\r?\n\s*DW_AT_low_pc\t\(0x([0-9a-f]+)\)\s*\r?\n\s*DW_AT_high_pc\t\(0x([0-9a-f]+)\)/g;

const functions = [];
let m;
while ((m = dieRe.exec(infoText))) {
  const low = parseInt(m[2], 16);
  const highRaw = parseInt(m[3], 16);
  const high = highRaw > low ? highRaw : low + highRaw;
  functions.push({ name: m[1], lowPc: low, highPc: high });
}

const hx = (n) => `0x${n.toString(16).padStart(8, '0')}`;

const inventory = [];
for (const fn of functions) {
  const inside = rows.filter((r) => r.address >= fn.lowPc && r.address < fn.highPc);
  if (inside.length === 0) continue;
  const first = inside.reduce((a, b) => (b.address < a.address ? b : a));
  const firstSeq = sequenceOf[first.index];

  // The row that immediately follows the first row *in the same sequence*.
  let next = null;
  for (let i = first.index + 1; i < rows.length && sequenceOf[i] === firstSeq; ++i) {
    next = rows[i];
    break;
  }

  // The first *later* row that carries a different source line — that is the
  // "next line" a slide would land on.
  let nextDistinctLine = null;
  for (let i = first.index + 1; i < rows.length && sequenceOf[i] === firstSeq; ++i) {
    if (rows[i].line !== first.line) {
      nextDistinctLine = rows[i];
      break;
    }
  }

  inventory.push({
    name: fn.name,
    lowPc: hx(fn.lowPc),
    highPc: hx(fn.highPc),
    rowsInFunction: inside.length,
    firstRow: {
      indexInTable: first.index,
      indexInSequence: rows.slice(0, first.index).filter((r) => sequenceOf[r.index] === firstSeq).length,
      address: hx(first.address),
      line: first.line,
      column: first.column,
      fileIndex: first.fileIndex,
      isFirstRowOfSequence: (() => {
        for (let i = first.index - 1; i >= 0; --i) {
          if (sequenceOf[i] !== firstSeq) return true;
        }
        return first.index === 0;
      })(),
    },
    nextRowInSequence: next ? { address: hx(next.address), line: next.line, column: next.column } : null,
    nextDistinctLineRow: nextDistinctLine
      ? { address: hx(nextDistinctLine.address), line: nextDistinctLine.line, column: nextDistinctLine.column }
      : null,
    sequenceLength: rows.filter((r) => sequenceOf[r.index] === firstSeq).length,
  });
}

inventory.sort((a, b) => parseInt(a.lowPc, 16) - parseInt(b.lowPc, 16));
console.log(JSON.stringify({ file: fileName, functionCount: inventory.length, functions: inventory }, null, 2));
