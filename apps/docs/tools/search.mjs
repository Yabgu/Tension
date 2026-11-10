#!/usr/bin/env node
// Build `assets/search.bin`: a static inverted index over `docs.bin`.
//
// **Why a static index and not a wasm search crate.** Measured on this corpus:
// 44k words of prose collapse to ~4k unique terms. At that size an in-memory
// dictionary scan with bounded edit distance is microseconds in wasm, and the
// whole index is a few hundred KiB. A crate like `tinysearch` exists to compress
// *large* corpora with Bloom filters and hashed postings, and it returns document
// ids rather than positions — we need the section and the character offset, so
// the reader can show a snippet and scroll to the line.
//
// **The dictionary is a flat sorted table, not front-coded.** Front coding would
// save maybe 20 KiB and would cost the guest a block-decode before every compare.
// A flat table lets the reader binary-search with a plain byte comparator, which
// is the part most likely to be written wrong. The measurement is in the report;
// if the corpus grows tenfold this is the first thing to revisit.
//
// **Sections come from `docs.bin`, not from re-parsing the Markdown.** The index
// and the bundle have to agree about what section 412 is, and the only way to
// guarantee that is to read the numbering out of the bundle.

import { execFileSync } from 'node:child_process';
import { mkdirSync, readFileSync, writeFileSync } from 'node:fs';
import { dirname, join, relative, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';

import { KIND } from './lib/format.mjs';
import { readDocs } from './lib/read-docs.mjs';

const here = dirname(fileURLToPath(import.meta.url));
const appDir = resolve(here, '..');
const repo = resolve(appDir, '..', '..');

function fail(message, detail = []) {
  process.stderr.write(`search: ${message}\n`);
  for (const line of detail) process.stderr.write(`  ${line}\n`);
  process.exit(1);
}

const argv = process.argv.slice(2);
let docsPath = join(appDir, 'assets', 'docs.bin');
let outPath = join(appDir, 'assets', 'search.bin');
let verbose = false;
for (let i = 0; i < argv.length; i++) {
  if (argv[i] === '--docs') docsPath = resolve(argv[++i]);
  else if (argv[i] === '--out') outPath = resolve(argv[++i]);
  else if (argv[i] === '--verbose') verbose = true;
  else fail(`unknown argument '${argv[i]}'`);
}

let docs;
try {
  docs = readDocs(docsPath);
} catch (error) {
  fail(`cannot read ${relative(repo, docsPath)}: ${error.message}`, [
    'build it first:  node tools/bundle.mjs',
  ]);
}

// ── the search wire ─────────────────────────────────────────────────────────
//
// A separate format from `docs.bin` and a separate magic, because the two files
// version independently: the index can be rebuilt from a bundle without the
// bundle changing, and a reader that finds a stale index should be able to say
// so rather than read it as a truncated bundle.

const MAGIC = 'TNSRCH1\u0000';
const VERSION = 1;
const HEADER_BYTES = 40;
const TERM_BYTES = 16;
const POSTING_BYTES = 12;

export const SEARCH_H = {
  magic: 0,
  version: 8,
  termCount: 12,
  postingCount: 16,
  sectionCount: 20,
  stringBytes: 24,
  stringsOffset: 28,
  termsOffset: 32,
  postingsOffset: 36,
};

// ── tokenising ──────────────────────────────────────────────────────────────

/**
 * Split text into search terms.
 *
 * Lowercased, split on anything that is not a letter or digit, and terms of one
 * character are dropped — a single letter matches nearly every section and would
 * make the result list noise. `res_read`, `tension-core` and `TensionCore` all
 * come out as usable pieces (`res`, `read`, `tension`, `core`, `tensioncore`),
 * which is what a reader typing part of a name expects.
 */
function tokenize(text) {
  const out = [];
  const lower = text.toLowerCase();
  let start = -1;
  for (let i = 0; i <= lower.length; i++) {
    const ch = i < lower.length ? lower.charCodeAt(i) : -1;
    const isWord = (ch >= 48 && ch <= 57) || (ch >= 97 && ch <= 122) || ch === 95;
    if (isWord) {
      if (start < 0) start = i;
      continue;
    }
    if (start >= 0) {
      if (i - start >= 2) out.push({ term: lower.slice(start, i), at: start });
      start = -1;
    }
  }
  return out;
}

// ── the index ───────────────────────────────────────────────────────────────

// term -> { sections: Map<sectionId, {occurrences, firstBlock, firstChar, inHeading}> }
const index = new Map();

// Blocks that carry no searchable prose. `rule` is a horizontal line; a code
// block is indexed because a reader searching for `res_read` means the code.
const SKIP = new Set([KIND.rule]);

let indexedBlocks = 0;

for (const section of docs.sections) {
  for (let b = 0; b < section.blockCount; b++) {
    const block = docs.blocks[section.blockFirst + b];
    if (!block || SKIP.has(block.kind)) continue;
    if (block.page !== section.page) continue;

    const text = docs.blockText(block);
    if (!text) continue;
    indexedBlocks++;

    // A term in a heading ranks above the same term in body prose: a section
    // called "Submit" is a better answer for "submit" than a sentence that
    // mentions the word.
    const inHeading = block.kind === KIND.heading;

    for (const { term, at } of tokenize(text)) {
      let entry = index.get(term);
      if (!entry) {
        entry = { sections: new Map() };
        index.set(term, entry);
      }
      let posting = entry.sections.get(section.index);
      if (!posting) {
        posting = { occurrences: 0, firstBlock: b, firstChar: at, inHeading };
        entry.sections.set(section.index, posting);
      }
      posting.occurrences++;
      if (inHeading) posting.inHeading = true;
    }
  }
}

// ── serialise ───────────────────────────────────────────────────────────────

const terms = [...index.keys()].sort();

// One string blob, built in term order so the dictionary's offsets are ascending
// — a reader can therefore skip a term without following a pointer.
const strings = [];
const offsets = new Map();
let stringBytes = 0;
for (const term of terms) {
  const buf = Buffer.from(term, 'utf8');
  offsets.set(term, stringBytes);
  strings.push(buf);
  stringBytes += buf.length;
}
const stringPad = (4 - (stringBytes % 4)) % 4;
const stringBlob = Buffer.concat([...strings, Buffer.alloc(stringPad)]);
const paddedStringBytes = stringBytes + stringPad;

// Postings, grouped by term in dictionary order. A term's postings are
// contiguous, so a reader binary-searches the dictionary and then reads a run.
const postings = [];
const termRows = [];
for (const term of terms) {
  const entry = index.get(term);
  const postFirst = postings.length;
  const sectionIds = [...entry.sections.keys()].sort((a, b) => a - b);
  for (const sectionId of sectionIds) {
    const p = entry.sections.get(sectionId);
    // `occurrences` carries the heading bit: bit 15 is "this term appeared in a
    // heading of this section", bits 0-14 are the count. A term occurring 32767
    // times in one section is not a thing that happens, and a separate field
    // would cost 4 bytes of padding on every one of the postings.
    postings.push({
      section: sectionId,
      packed: (p.inHeading ? 0x8000 : 0) | Math.min(p.occurrences, 0x7fff),
      firstBlock: Math.min(p.firstBlock, 0xffff),
      firstChar: p.firstChar,
    });
  }
  termRows.push({
    offset: offsets.get(term),
    length: Buffer.byteLength(term, 'utf8'),
    postFirst,
    postCount: postings.length - postFirst,
  });
}

const header = Buffer.alloc(HEADER_BYTES);
header.write(MAGIC, 0, 'ascii');
header.writeUInt32LE(VERSION, 8);
header.writeUInt32LE(termRows.length, 12);
header.writeUInt32LE(postings.length, 16);
header.writeUInt32LE(docs.counts.sections, 20);
header.writeUInt32LE(paddedStringBytes, 24);
const stringsOffset = HEADER_BYTES;
const termsOffset = stringsOffset + paddedStringBytes;
const postingsOffset = termsOffset + termRows.length * TERM_BYTES;
header.writeUInt32LE(stringsOffset, 28);
header.writeUInt32LE(termsOffset, 32);
header.writeUInt32LE(postingsOffset, 36);

const termTable = Buffer.alloc(termRows.length * TERM_BYTES);
termRows.forEach((row, i) => {
  const at = i * TERM_BYTES;
  termTable.writeUInt32LE(row.offset, at);
  termTable.writeUInt32LE(row.length, at + 4);
  termTable.writeUInt32LE(row.postFirst, at + 8);
  termTable.writeUInt32LE(row.postCount, at + 12);
});

const postingTable = Buffer.alloc(postings.length * POSTING_BYTES);
postings.forEach((posting, i) => {
  const at = i * POSTING_BYTES;
  postingTable.writeUInt32LE(posting.section, at);
  postingTable.writeUInt16LE(posting.packed, at + 4);
  postingTable.writeUInt16LE(posting.firstBlock, at + 6);
  postingTable.writeUInt32LE(posting.firstChar, at + 8);
});

const blob = Buffer.concat([header, stringBlob, termTable, postingTable]);

mkdirSync(dirname(outPath), { recursive: true });
writeFileSync(outPath, blob);

// ── the note on ranking ─────────────────────────────────────────────────────
//
// A posting carries four ranking inputs: occurrences, whether the term was in a
// heading, the block it first appeared in, and the character offset within that
// block. The *order* is the reader's business, but the inputs are chosen here
// because only the builder sees the whole corpus. The heading flag is bit 15 of
// the occurrences word rather than a separate field: see the write above.

const summary = {
  version: VERSION,
  terms: termRows.length,
  postings: postings.length,
  sections: docs.counts.sections,
  indexedBlocks,
  stringBytes: paddedStringBytes,
  bytes: blob.length,
};
writeFileSync(join(dirname(outPath), 'search.index.json'), `${JSON.stringify({
  ...summary,
  out: relative(repo, outPath).split('\\').join('/'),
  docsSource: `0x${docs.sourceSha.toString(16).padStart(8, '0')}`,
}, null, 2)}\n`);

process.stdout.write(
  `search: ${summary.terms} terms, ${summary.postings} postings over ` +
  `${summary.sections} sections from ${summary.indexedBlocks} blocks\n` +
  `search: ${(blob.length / 1024).toFixed(1)} KiB -> ` +
  `${relative(repo, outPath).split('\\').join('/')}\n`,
);

if (verbose) {
  // The longest postings, which is where a naive linear scan would hurt. A
  // reader that binary-searches the dictionary never touches these directly.
  const biggest = [...index.entries()]
    .map(([term, entry]) => ({ term, sections: entry.sections.size }))
    .sort((a, b) => b.sections - a.sections)
    .slice(0, 10);
  for (const row of biggest) {
    process.stdout.write(`  ${row.sections.toString().padStart(5)} sections  ${row.term}\n`);
  }
}
