#!/usr/bin/env node
// Phase B of DL4: the DWARF's own account of a breakpoint line.
//
// Reads .debug_info/.debug_abbrev/.debug_line/.debug_ranges straight out of the
// module — never .wasm.map, never a disassembly — and answers, per requested
// (module, file, line):
//
//   1. every line-table row for that line: address, file, line, and the bytes it
//      owns (span to the next row in the same sequence);
//   2. the compile unit that owns the row: DW_AT_name, low_pc/high_pc, and the
//      DW_AT_ranges list;
//   3. whether the row address falls inside at least one CU range.
//
// It also records, for the differential, whether a row is the *first* row of its
// sequence and what the sequence's DW_LNE_set_address was — those are the two
// facts that distinguish "first statement of a body" from "a later statement".

import fs from "node:fs";
import path from "node:path";

import { readDwarf } from "/home/acakar/work/TensionScript-a2/tests/debug/lib/dwarf-reader.js";

const [, , specPath] = process.argv;
const spec = JSON.parse(fs.readFileSync(specPath, "utf8"));

const hex = (n) => (n == null ? null : `0x${n.toString(16)}`);

function describe(modulePath, wantedFile, wantedLine) {
  const bytes = fs.readFileSync(modulePath);
  const dwarf = readDwarf(bytes);
  if (!dwarf) return { module: modulePath, error: "no .debug_info" };

  const out = {
    module: path.basename(modulePath),
    modulePath,
    wantedFile,
    wantedLine,
    units: [],
    rows: [],
    inAnyUnitRange: false,
  };

  for (const [unitIndex, unit] of dwarf.units.entries()) {
    const table = dwarf.line(unit);
    const fileOf = (index) => {
      if (index <= 0) return "<primary>";
      return table.files[index - 1] ?? `<file ${index}>`;
    };
    const ranges = unit.ranges.map(([low, high]) => ({ low, high }));
    const unitInfo = {
      index: unitIndex,
      name: unit.name,
      compDir: unit.compDir,
      lowPc: unit.lowPc,
      highPc: unit.highPc,
      rangeCount: ranges.length,
      ranges: ranges.slice(0, 12),
      rangesTruncated: Math.max(0, ranges.length - 12),
    };
    out.units.push(unitInfo);

    for (const [seqIndex, sequence] of table.sequences.entries()) {
      const seqRows = sequence.rows;
      // The sequence's own start is the address the first non-end row carries;
      // DW_LNE_set_address is not kept as a field, so the first row *is* it.
      const seqStart = seqRows.length > 0 ? seqRows[0].address : null;
      for (let i = 0; i < seqRows.length; ++i) {
        const row = seqRows[i];
        if (row.isEnd) continue;
        const file = fileOf(row.file);
        if (path.basename(file) !== path.basename(wantedFile)) continue;
        if (row.line !== wantedLine) continue;
        const next = seqRows[i + 1];
        const span = next ? next.address - row.address : 0;
        const inUnit = ranges.some((r) => row.address >= r.low && row.address < r.high);
        const inLowHigh =
          unit.lowPc != null && unit.highPc != null && row.address >= unit.lowPc && row.address < unit.highPc;
        if (inUnit || inLowHigh) out.inAnyUnitRange = true;
        out.rows.push({
          unitIndex,
          sequenceIndex: seqIndex,
          rowIndex: i,
          address: row.address,
          addressHex: hex(row.address),
          file,
          line: row.line,
          column: row.column,
          span,
          isFirstRowOfSequence: i === 0,
          sequenceStart: seqStart,
          offsetFromSequenceStart: seqStart == null ? null : row.address - seqStart,
          sequenceRowCount: seqRows.filter((r) => !r.isEnd).length,
          inUnitRanges: inUnit,
          inUnitLowHigh: inLowHigh,
        });
      }
    }
  }

  // Every row of the same file, so the differential can compare a working line
  // against a failing one inside one function.
  out.fileRows = [];
  for (const unit of dwarf.units) {
    const table = dwarf.line(unit);
    const fileOf = (index) => (index <= 0 ? "<primary>" : table.files[index - 1] ?? `<file ${index}>`);
    for (const sequence of table.sequences) {
      const seqRows = sequence.rows;
      const seqStart = seqRows.length > 0 ? seqRows[0].address : null;
      const rows = seqRows.map((r, i) => ({
        i,
        address: r.address,
        addressHex: hex(r.address),
        file: fileOf(r.file),
        line: r.line,
        isEnd: Boolean(r.isEnd),
        isFirst: i === 0,
        offsetFromSequenceStart: seqStart == null ? null : r.address - seqStart,
      }));
      const mine = rows.filter((r) => !r.isEnd && path.basename(r.file) === path.basename(wantedFile));
      if (mine.length === 0) continue;
      out.fileRows.push({ sequenceIndex: null, sequenceStart: seqStart, sequenceStartHex: hex(seqStart), rows: mine });
    }
  }
  return out;
}

const results = spec.cases.map((c) => ({ case: c.case, ...describe(c.module, c.file, c.line) }));
process.stdout.write(`${JSON.stringify(results, null, 2)}\n`);
