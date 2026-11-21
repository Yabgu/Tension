#!/usr/bin/env node
// Print the first rows of the line-table sequence that contains a given source
// line, and the sequence header, from rows written by phase-a-line.mjs.
//
//   node phase-a-first-rows.mjs <rows-file> <file-name> <line> [count]
//
// The rows file is phase-a-line.mjs's `--rows-file` output; the columns are
// address, line, column, file index, isa, discriminator, opIndex, flags.
import fs from 'node:fs';

const [, , rowsPath, fileName, lineArg, countArg] = process.argv;
const wanted = Number(lineArg);
const count = Number(countArg ?? 4);

const raw = fs.readFileSync(rowsPath, 'utf8').trim().split(/\r?\n/);
const rows = raw.map((text) => {
  const parts = text.trim().split(/\s+/);
  return {
    address: parts[0],
    line: Number(parts[1]),
    column: Number(parts[2]),
    fileIndex: Number(parts[3]),
    flags: parts.slice(7).join(' '),
  };
});

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

// The file index is resolved by the caller's module metadata; here the caller
// passes the *name* and we accept any file index that the sequence uses, so the
// match is on the line number within the earliest sequence that has it.
let found = null;
for (let s = 0; s < sequences.length; ++s) {
  const index = sequences[s].findIndex((row) => row.line === wanted);
  if (index >= 0) {
    found = { index: s, rowIndex: index, sequence: sequences[s] };
    break;
  }
}

if (!found) {
  console.error(`no row with line ${wanted} in ${rowsPath}`);
  process.exit(3);
}

const { index, rowIndex, sequence } = found;
const first = sequence[0];
const last = sequence[sequence.length - 1];

console.log(
  JSON.stringify(
    {
      file: fileName,
      requestedLine: wanted,
      sequenceIndex: index,
      sequenceFirstRowAddress: first.address,
      sequenceEndAddress: last.address,
      sequenceRowCount: sequence.length,
      matchingRowIndexInSequence: rowIndex,
      firstRows: sequence.slice(0, count).map((row, i) => ({
        rowInSequence: i,
        address: row.address,
        fileIndex: row.fileIndex,
        line: row.line,
        column: row.column,
        isStmt: row.flags.includes('is_stmt'),
        prologueEnd: row.flags.includes('prologue_end'),
        endSequence: row.flags.includes('end_sequence'),
      })),
      rowAfterMatch: sequence[rowIndex + 1]
        ? {
            address: sequence[rowIndex + 1].address,
            line: sequence[rowIndex + 1].line,
            column: sequence[rowIndex + 1].column,
          }
        : null,
    },
    null,
    2,
  ),
);
