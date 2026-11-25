#!/usr/bin/env node
// Read a wasm module's `.debug_line` section directly: prologue, opcode stream,
// and the rows those opcodes produce. Answers "does this producer ever emit
// DW_LNS_set_prologue_end (0x0a) / DW_LNS_set_epilogue_begin (0x0b), and where".
//
//   node phase-a-line.mjs <module.wasm> [--rows-file out.txt]
//
// Why not llvm-dwarfdump: it prints the rows, and with -v it prints the opcodes,
// but it refuses some artifacts outright (`error: … bad form` — measured on the
// stack-switching builds, whose .debug_info it cannot decode). `.debug_line`
// alone is well-formed in those, and that is all this needs.
//
// Fidelity check: for a module llvm-dwarfdump *does* read, the rows this prints
// must equal its row table exactly. `--rows-file` writes them in dwarfdump's
// shape so the comparison is mechanical.

import fs from 'node:fs';

const [, , modulePath, ...rest] = process.argv;
if (!modulePath) {
  console.error('usage: phase-a-line.mjs <module.wasm> [--rows-file out.txt]');
  process.exit(2);
}
const rowsFileIndex = rest.indexOf('--rows-file');
const rowsFile = rowsFileIndex >= 0 ? rest[rowsFileIndex + 1] : null;

const bytes = fs.readFileSync(modulePath);

// ── wasm container: find the `.debug_line` custom section ────────────────────

function uleb(buf, p) {
  let result = 0;
  let shift = 0;
  for (;;) {
    if (p.i >= buf.length) throw new Error('truncated ULEB');
    const byte = buf[p.i++];
    result += (byte & 0x7f) * 2 ** shift;
    if ((byte & 0x80) === 0) return result;
    shift += 7;
    if (shift > 63) throw new Error('ULEB too long');
  }
}

function customSection(buf, wanted) {
  if (buf.length < 8 || buf.toString('latin1', 0, 4) !== '\0asm') {
    throw new Error('not a wasm module');
  }
  const p = { i: 8 };
  while (p.i < buf.length) {
    const id = buf[p.i++];
    const size = uleb(buf, p);
    const payloadStart = p.i;
    const payloadEnd = payloadStart + size;
    if (payloadEnd > buf.length) throw new Error('section overruns file');
    if (id === 0) {
      const q = { i: payloadStart };
      const nameLength = uleb(buf, q);
      const name = buf.toString('utf8', q.i, q.i + nameLength);
      if (name === wanted) {
        return { start: q.i + nameLength, end: payloadEnd };
      }
    }
    p.i = payloadEnd;
  }
  return null;
}

const section = customSection(bytes, '.debug_line');
if (!section) {
  console.error(`${modulePath}: no .debug_line section`);
  process.exit(3);
}

// ── the line program ─────────────────────────────────────────────────────────

const OP = {
  1: 'DW_LNS_copy',
  2: 'DW_LNS_advance_pc',
  3: 'DW_LNS_advance_line',
  4: 'DW_LNS_set_file',
  5: 'DW_LNS_set_column',
  6: 'DW_LNS_negate_stmt',
  7: 'DW_LNS_set_basic_block',
  8: 'DW_LNS_const_add_pc',
  9: 'DW_LNS_fixed_advance_pc',
  10: 'DW_LNS_set_prologue_end',
  11: 'DW_LNS_set_epilogue_begin',
  12: 'DW_LNS_set_isa',
};

function readSleb(buf, p) {
  let result = 0;
  let shift = 0;
  let byte;
  do {
    byte = buf[p.i++];
    result |= (byte & 0x7f) << shift;
    shift += 7;
  } while (byte & 0x80);
  if (shift < 32 && byte & 0x40) result |= -1 << shift;
  return result;
}

function readCString(buf, p) {
  const start = p.i;
  while (p.i < buf.length && buf[p.i] !== 0) p.i++;
  const text = buf.toString('utf8', start, p.i);
  p.i++; // NUL
  return text;
}

const p = { i: section.start };
const unitLength = bytes.readUInt32LE(p.i);
p.i += 4;
const unitEnd = p.i + unitLength;

const version = bytes.readUInt16LE(p.i);
p.i += 2;

const headerLength = bytes.readUInt32LE(p.i);
p.i += 4;
const programStart = p.i + headerLength;

const minInstLength = bytes[p.i++];
const maxOpsPerInst = version >= 4 ? bytes[p.i++] : 1;
const defaultIsStmt = bytes[p.i++];
const lineBase = (bytes[p.i++] << 24) >> 24; // sbyte
const lineRange = bytes[p.i++];
const opcodeBase = bytes[p.i++];

const declaredLengths = [];
for (let op = 1; op < opcodeBase; ++op) declaredLengths[op] = bytes[p.i++];

const includeDirectories = [];
for (;;) {
  const dir = readCString(bytes, p);
  if (dir === '') break;
  includeDirectories.push(dir);
}

const fileNames = [];
for (;;) {
  const name = readCString(bytes, p);
  if (name === '') break;
  fileNames.push({
    name,
    directoryIndex: uleb(bytes, p),
    modTime: uleb(bytes, p),
    length: uleb(bytes, p),
  });
}

// ── execute the program ──────────────────────────────────────────────────────

const rows = [];
const opcodeCounts = Object.create(null);
const prologueEndRows = [];
const epilogueBeginRows = [];

let address = 0;
let opIndex = 0;
let file = 1;
let line = 1;
let column = 0;
let isStmt = defaultIsStmt !== 0;
let basicBlock = false;
let prologueEnd = false;
let epilogueBegin = false;
let isa = 0;
let discriminator = 0;

function bump(name) {
  opcodeCounts[name] = (opcodeCounts[name] ?? 0) + 1;
}

function emit(isEndOfSequence) {
  const row = {
    address,
    file,
    line,
    column,
    isStmt,
    prologueEnd,
    epilogueBegin,
    isa,
    discriminator,
    endSequence: isEndOfSequence,
  };
  rows.push(row);
  if (prologueEnd) prologueEndRows.push(row);
  if (epilogueBegin) epilogueBeginRows.push(row);
  basicBlock = false;
  prologueEnd = false;
  epilogueBegin = false;
  discriminator = 0;
}

let guard = 0;
while (p.i < unitEnd) {
  if (++guard > 10_000_000) throw new Error('line program runaway');
  const op = bytes[p.i++];

  if (op >= opcodeBase) {
    bump('special');
    const adjusted = op - opcodeBase;
    const addressAdvance = Math.floor(adjusted / lineRange) * minInstLength;
    const lineAdvance = lineBase + (adjusted % lineRange);
    address += addressAdvance;
    line += lineAdvance;
    emit(false);
    continue;
  }

  if (op === 0) {
    // Extended opcode: ULEB length, then a sub-opcode byte.
    const length = uleb(bytes, p);
    const subEnd = p.i + length;
    const sub = bytes[p.i++];
    if (sub === 1) {
      bump('DW_LNE_end_sequence');
      emit(true);
      address = 0;
      opIndex = 0;
      file = 1;
      line = 1;
      column = 0;
      isStmt = defaultIsStmt !== 0;
      basicBlock = false;
      prologueEnd = false;
      epilogueBegin = false;
      isa = 0;
      discriminator = 0;
    } else if (sub === 2) {
      bump('DW_LNE_set_address');
      // Address size is the CU's; wasm modules here use 4.
      const size = subEnd - p.i;
      address = size === 8 ? Number(bytes.readBigUInt64LE(p.i)) : bytes.readUInt32LE(p.i);
    } else if (sub === 3) {
      bump('DW_LNE_define_file');
      const name = readCString(bytes, p);
      fileNames.push({ name, directoryIndex: uleb(bytes, p), modTime: uleb(bytes, p), length: uleb(bytes, p) });
    } else if (sub === 4) {
      bump('DW_LNE_set_discriminator');
      discriminator = uleb(bytes, p);
    } else {
      bump(`DW_LNE_unknown_${sub}`);
    }
    p.i = subEnd;
    continue;
  }

  const name = OP[op] ?? `DW_LNS_unknown_${op}`;
  bump(name);
  switch (op) {
    case 1: // copy
      emit(false);
      break;
    case 2: // advance_pc
      address += uleb(bytes, p) * minInstLength;
      break;
    case 3: // advance_line
      line += readSleb(bytes, p);
      break;
    case 4: // set_file
      file = uleb(bytes, p);
      break;
    case 5: // set_column
      column = uleb(bytes, p);
      break;
    case 6: // negate_stmt
      isStmt = !isStmt;
      break;
    case 7: // set_basic_block
      basicBlock = true;
      break;
    case 8: { // const_add_pc
      const adjusted = 255 - opcodeBase;
      address += Math.floor(adjusted / lineRange) * minInstLength;
      break;
    }
    case 9: // fixed_advance_pc: a uhalf, per the DWARF spec
      address += bytes.readUInt16LE(p.i);
      p.i += 2;
      break;
    case 10: // set_prologue_end
      prologueEnd = true;
      break;
    case 11: // set_epilogue_begin
      epilogueBegin = true;
      break;
    case 12: // set_isa
      isa = uleb(bytes, p);
      break;
    default:
      throw new Error(`unhandled standard opcode ${op} at 0x${(p.i - 1).toString(16)}`);
  }
}

// ── report ───────────────────────────────────────────────────────────────────

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

const hx = (n) => `0x${n.toString(16).padStart(16, '0')}`;

if (rowsFile) {
  const lines = [];
  for (const row of rows) {
    const flags = [row.isStmt ? 'is_stmt' : '', row.prologueEnd ? 'prologue_end' : '', row.epilogueBegin ? 'epilogue_begin' : '', row.endSequence ? 'end_sequence' : '']
      .filter(Boolean)
      .join(' ');
    lines.push(
      `${hx(row.address)} ${String(row.line).padStart(6)} ${String(row.column).padStart(6)} ${String(row.file).padStart(6)} ${String(row.isa).padStart(3)} ${String(row.discriminator).padStart(13)} ${String(0).padStart(7)} ${flags}`,
    );
  }
  fs.writeFileSync(rowsFile, `${lines.join('\n')}\n`);
}

const summary = {
  module: modulePath,
  section: '.debug_line',
  version,
  headerLength,
  minInstLength,
  maxOpsPerInst,
  defaultIsStmt: defaultIsStmt !== 0,
  lineBase,
  lineRange,
  opcodeBase,
  declaredStandardOpcodeLengths: Object.fromEntries(
    Array.from({ length: opcodeBase - 1 }, (_, i) => [OP[i + 1] ?? `op${i + 1}`, declaredLengths[i + 1]]),
  ),
  declaredLengthsThatDifferFromDwarf4Spec: (() => {
    // DWARF4 §6.2.5.2: the operand counts are fixed by the standard.
    const spec = {
      DW_LNS_copy: 0,
      DW_LNS_advance_pc: 1,
      DW_LNS_advance_line: 1,
      DW_LNS_set_file: 1,
      DW_LNS_set_column: 1,
      DW_LNS_negate_stmt: 0,
      DW_LNS_set_basic_block: 0,
      DW_LNS_const_add_pc: 0,
      DW_LNS_fixed_advance_pc: 1,
      DW_LNS_set_prologue_end: 0,
      DW_LNS_set_epilogue_begin: 0,
      DW_LNS_set_isa: 1,
    };
    const diffs = [];
    for (let op = 1; op < opcodeBase; ++op) {
      const name = OP[op];
      if (name && spec[name] !== undefined && declaredLengths[op] !== spec[name]) {
        diffs.push({ opcode: `0x${op.toString(16).padStart(2, '0')}`, name, declared: declaredLengths[op], spec: spec[name] });
      }
    }
    return diffs;
  })(),
  includeDirectories,
  fileCount: fileNames.length,
  fileNames: fileNames.map((f, i) => ({ index: i + 1, name: f.name, directoryIndex: f.directoryIndex })),
  totalRows: rows.length,
  sequenceCount: sequences.length,
  opcodeCounts,
  prologueEnd: {
    emitted: opcodeCounts.DW_LNS_set_prologue_end ?? 0,
    rows: prologueEndRows.map((r) => ({ address: hx(r.address), file: r.file, line: r.line, column: r.column })),
  },
  epilogueBegin: {
    emitted: opcodeCounts.DW_LNS_set_epilogue_begin ?? 0,
    rows: epilogueBeginRows.map((r) => ({ address: hx(r.address), file: r.file, line: r.line, column: r.column })),
  },
};

console.log(JSON.stringify(summary, null, 2));
