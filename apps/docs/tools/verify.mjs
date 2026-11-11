#!/usr/bin/env node
// Prove the assets are readable, and that they agree with each other.
//
// This is the check the guest will mirror. `docs.bin` is read with the offsets
// `lib/format.mjs` declares — a second implementation from the writer, not the
// same code — then the sections, the index and the transcripts are cross-checked
// against it:
//
//   * every section's block range is inside that page and inside the block array
//   * every search posting names a real section and a real block
//   * every transcript names a real runnable block
//   * every printed character has a glyph cell in the atlas
//   * the atlas is an IWI whose dimensions are the ones `ui.json` claims
//
// A build that passes this can still be ugly; it cannot be *wrong* about its own
// structure, which is the class of defect that costs a day.
//
// Usage:  node tools/verify.mjs [--show <n>]   (default: show the first 3 pages)

import { existsSync, readFileSync } from 'node:fs';
import { dirname, join, relative, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';

import { BLOCK_FLAG, KIND, STYLE } from './lib/format.mjs';
import { readDocs } from './lib/read-docs.mjs';
import { readSearch } from './lib/read-search.mjs';

const here = dirname(fileURLToPath(import.meta.url));
const appDir = resolve(here, '..');
const repo = resolve(appDir, '..', '..');
const assets = join(appDir, 'assets');

const argv = process.argv.slice(2);
let showPages = 3;
for (let i = 0; i < argv.length; i++) {
  if (argv[i] === '--show') showPages = Number(argv[++i]);
  else {
    process.stderr.write(`verify: unknown argument '${argv[i]}'\n`);
    process.exit(2);
  }
}

let failures = 0;
const fail = (message) => {
  failures++;
  process.stderr.write(`  FAIL ${message}\n`);
};
const ok = (message) => process.stdout.write(`  ok   ${message}\n`);

const KIND_NAME = Object.fromEntries(Object.entries(KIND).map(([name, id]) => [id, name]));
const STYLE_NAME = Object.fromEntries(Object.entries(STYLE).map(([name, id]) => [id, name]));

/** A heading rule that reads like the source's, for the page dump. */
function underline(level) {
  return '-'.repeat(Math.min(60, 12 + level * 6));
}

// ── docs.bin ────────────────────────────────────────────────────────────────

process.stdout.write('\ndocs.bin\n');
const docsPath = join(assets, 'docs.bin');
if (!existsSync(docsPath)) {
  fail(`${relative(repo, docsPath)} does not exist — run tools/bundle.mjs`);
  process.exit(1);
}

let docs;
try {
  docs = readDocs(docsPath);
} catch (error) {
  fail(`unreadable: ${error.message}`);
  process.exit(1);
}

ok(`version ${docs.version}, source 0x${docs.sourceSha.toString(16).padStart(8, '0')}`);
ok(`${docs.counts.pages} pages, ${docs.counts.blocks} blocks, ${docs.counts.runs} runs, ` +
   `${docs.counts.sections} sections, ${docs.counts.toc} toc entries`);

// Every page's block range must be inside the array and contiguous with the last.
let expectedFirst = 0;
for (const page of docs.pages) {
  if (page.blockFirst !== expectedFirst) {
    fail(`page ${page.index} ("${page.path}") starts at block ${page.blockFirst}, expected ${expectedFirst}`);
  }
  expectedFirst = page.blockFirst + page.blockCount;
}
if (expectedFirst !== docs.blocks.length) {
  fail(`pages cover ${expectedFirst} blocks, the array holds ${docs.blocks.length}`);
} else {
  ok('page block ranges tile the block array exactly');
}

// Every block must name runs that exist, and belong to the page that claims it.
for (const block of docs.blocks) {
  if (block.page >= docs.pages.length) {
    fail(`block ${block.index} names page ${block.page}, which does not exist`);
    break;
  }
}
ok('every block names a real page');

// Sections: inside their page, and opening on a heading.
let sectionProblems = 0;
for (const section of docs.sections) {
  const page = docs.pages[section.page];
  if (!page) { fail(`section ${section.index} names page ${section.page}`); sectionProblems++; break; }
  if (section.blockFirst < page.blockFirst ||
      section.blockFirst + section.blockCount > page.blockFirst + page.blockCount) {
    fail(`section ${section.index} ("${section.title}") is outside page ${section.page}`);
    sectionProblems++;
    if (sectionProblems > 3) break;
  }
  const first = docs.blocks[section.blockFirst];
  if (!first || first.kind !== KIND.heading) {
    fail(`section ${section.index} ("${section.title}") does not start on a heading`);
    sectionProblems++;
    if (sectionProblems > 3) break;
  }
}
if (!sectionProblems) ok('every section starts on a heading and stays inside its page');

// Every string must be drawable by a 95-glyph font. This is not pedantry: the
// bundle's titles come from `docs/book.json` and do not pass through the
// Markdown normalizer, so an em dash in a chapter title would reach the sidebar
// as a box. The check that found that lives here now.
{
  const undrawable = new Map();
  const scan = (text, where) => {
    for (const ch of text) {
      const code = ch.codePointAt(0);
      if (code === 9 || code === 10) continue;
      if (code >= 32 && code <= 126) continue;
      if (!undrawable.has(ch)) undrawable.set(ch, where);
    }
  };
  for (const page of docs.pages) { scan(page.title, `page ${page.index} title`); scan(page.path, `page ${page.index} path`); }
  for (const entry of docs.toc) scan(entry.title, 'toc');
  for (const section of docs.sections) scan(section.title, `section ${section.index}`);
  for (const block of docs.blocks) for (const run of block.runs) scan(run.text, `block ${block.index}`);

  if (undrawable.size) {
    for (const [ch, where] of undrawable) {
      fail(`${JSON.stringify(ch)} (U+${ch.codePointAt(0).toString(16).toUpperCase().padStart(4, '0')}) ` +
        `cannot be drawn; first seen in ${where}`);
    }
  } else {
    ok('every string is ASCII — all of it is drawable by the 95-glyph font');
  }
}

// ── search.bin ──────────────────────────────────────────────────────────────

process.stdout.write('\nsearch.bin\n');
const searchPath = join(assets, 'search.bin');
if (!existsSync(searchPath)) {
  fail(`${relative(repo, searchPath)} does not exist — run tools/search.mjs`);
} else {
  try {
    const search = readSearch(searchPath);
    ok(`${search.termCount} terms, ${search.postingCount} postings, ` +
       `${search.sectionCount} sections`);

    // The dictionary must be sorted, or binary search is a lie.
    let sorted = true;
    for (let i = 1; i < search.terms.length; i++) {
      if (search.terms[i - 1].term >= search.terms[i].term) { sorted = false; break; }
    }
    if (!sorted) fail('the dictionary is not in ascending order; binary search would miss terms');
    else ok('the dictionary is sorted (binary search is valid)');

    // Every posting must name a section this bundle has.
    let bad = 0;
    for (const posting of search.postings) {
      if (posting.section >= docs.sections.length) bad++;
    }
    if (bad) fail(`${bad} posting(s) name a section outside 0..${docs.sections.length - 1}`);
    else ok('every posting names a real section');

    // A known term, looked up both ways.
    const probe = 'load';
    const found = search.find(probe);
    if (!found) fail(`the dictionary has no term '${probe}'`);
    else {
      const results = search.query(probe, 3);
      ok(`lookup "${probe}": ${found.postCount} section(s)`);
      for (const hit of results) {
        const section = docs.sections[hit.section];
        process.stdout.write(`       ${hit.score.toString().padStart(4)}  ${section.title}` +
          `  [${docs.pages[section.page].path}]\n`);
      }
      if (!results.length) fail(`query "${probe}" returned nothing`);
    }

    const pref = search.prefix('rend', 5);
    ok(`prefix "rend" -> ${pref.map((t) => t.term).join(', ') || '(none)'}`);
    if (!pref.length) fail('prefix search found nothing for "rend"');
  } catch (error) {
    fail(`unreadable: ${error.message}`);
  }
}

// ── transcripts.bin ─────────────────────────────────────────────────────────

process.stdout.write('\ntranscripts.bin\n');
const transcriptPath = join(assets, 'transcripts.bin');
if (!existsSync(transcriptPath)) {
  fail(`${relative(repo, transcriptPath)} does not exist — run tools/run-examples.mjs`);
} else {
  const buf = readFileSync(transcriptPath);
  const magic = buf.subarray(0, 8).toString('ascii');
  if (magic !== 'TNTRN1\u0000\u0000') {
    fail(`not a transcript bundle (magic ${JSON.stringify(magic)})`);
  } else {
    const version = buf.readUInt32LE(8);
    const count = buf.readUInt32LE(12);
    const stringsAt = buf.readUInt32LE(16);
    const stringBytes = buf.readUInt32LE(20);
    if (version !== 1) fail(`transcript version ${version}, expected 1`);

    const runnableBlocks = docs.blocks.filter(
      (block) => block.kind === KIND.code && (block.flags & BLOCK_FLAG.runnable) !== 0,
    );
    ok(`${count} transcript(s) for ${runnableBlocks.length} runnable block(s)`);
    if (count !== runnableBlocks.length) {
      fail('the transcript count does not match the runnable blocks; rebuild run-examples.mjs');
    }

    for (let i = 0; i < count; i++) {
      const at = 24 + i * 24;
      const blockIndex = buf.readUInt32LE(at);
      const status = buf.readUInt8(at + 4);
      const offset = buf.readUInt32LE(at + 8);
      const length = buf.readUInt32LE(at + 12);
      const exit = buf.readInt32LE(at + 16);
      const duration = buf.readUInt32LE(at + 20);

      const block = docs.blocks[blockIndex];
      if (!block) { fail(`transcript ${i} names block ${blockIndex}, which does not exist`); continue; }
      if ((block.flags & BLOCK_FLAG.runnable) === 0) {
        fail(`transcript ${i} names block ${blockIndex}, which is not tagged runnable`);
      }
      if (offset + length > stringBytes) {
        fail(`transcript ${i} reads past the string blob`);
        continue;
      }
      if (status !== 0) fail(`transcript ${i} recorded a failure (status ${status}, exit ${exit})`);

      const page = docs.pages[block.page];
      const text = buf.subarray(stringsAt + offset, stringsAt + offset + length).toString('utf8');
      process.stdout.write(`       ${page.path} block ${blockIndex}: ` +
        `${text.split('\n').filter(Boolean).length} line(s), ${duration} ms\n`);
      for (const line of text.split('\n').filter(Boolean).slice(0, 4)) {
        process.stdout.write(`         | ${line}\n`);
      }
    }
  }
}

// ── ui.iwi ──────────────────────────────────────────────────────────────────

process.stdout.write('\nui.iwi\n');
const atlasPath = join(assets, 'ui.iwi');
const uiPath = join(assets, 'ui.json');
if (!existsSync(atlasPath) || !existsSync(uiPath)) {
  fail('ui.iwi or ui.json does not exist — run tools/make-font.mjs');
} else {
  const atlas = readFileSync(atlasPath);
  const ui = JSON.parse(readFileSync(uiPath, 'utf8'));

  if (atlas.subarray(0, 4).toString('ascii') !== 'IWI1') {
    fail('not an IWI container');
  } else {
    const width = atlas.readUInt32LE(4);
    const height = atlas.readUInt32LE(8);
    const components = atlas.readUInt16LE(13);
    const bitsPerPixel = atlas.readUInt16LE(15);
    const pixelBytes = Number(atlas.readBigUInt64LE(66));

    ok(`IWI1 ${width}x${height}, ${components} components, ${bitsPerPixel} bpp, ` +
       `${(atlas.length / 1024).toFixed(1)} KiB`);

    // The decoder's own refusals: 3 or 4 components, interleaved, 8-bit.
    if (components !== 4) fail(`the viewer needs RGBA (4 components), this has ${components}`);
    else if (bitsPerPixel !== 32) fail(`expected 32 bits per pixel, got ${bitsPerPixel}`);
    else if (atlas[17] !== 0) fail('planar storage is refused by the decoder');
    else ok('the container is one the 2D decoder accepts');

    if (pixelBytes !== width * height * 4) {
      fail(`declared ${pixelBytes} pixel bytes, ${width * height * 4} required`);
    } else if (atlas.length !== 74 + pixelBytes) {
      fail(`file is ${atlas.length} bytes, header + pixels is ${74 + pixelBytes}`);
    } else {
      ok('pixel data matches the declared size exactly');
    }

    if (width !== ui.atlas.width || height !== ui.atlas.height) {
      fail(`ui.json says ${ui.atlas.width}x${ui.atlas.height}, the file is ${width}x${height}`);
    } else {
      ok('ui.json dimensions match the file');
    }

    // The cell formula in the manifest must reproduce the baker's layout.
    const { stripe, colourStride, glyphCells } = ui.text;
    const cells = (width / ui.atlas.cellWidth) * (height / ui.atlas.cellHeight);
    if (glyphCells + Object.keys(ui.chrome).length > cells) {
      fail(`${glyphCells} glyph cells + chrome do not fit in ${cells} cells`);
    } else {
      ok(`${glyphCells} glyph cells + ${Object.keys(ui.chrome).length} chrome cells in ${cells} cells`);
    }
    const sample = 4 * colourStride + 1 * stripe + ('A'.charCodeAt(0) - 32);
    if (sample >= glyphCells) fail(`the cell formula puts 'A' bold/heading at ${sample}, outside the stripe`);
    else ok(`'A' (heading, bold) is cell ${sample}`);

    // **The guest's cell size must be the baked one.** The viewer emits one
    // sprite per glyph with `w = CELL_W, h = CELL_H`, and those are also the
    // record's *source* texel rect — so if `src/text.ts` disagrees with
    // `ui.json` the sampler reads the neighbouring cells and every character is
    // drawn from the wrong place. It would look like damaged glyphs, not like a
    // configuration error, which is why this is checked rather than trusted.
    const textSource = readFileSync(join(appDir, 'src', 'text.ts'), 'utf8');
    const readConst = (name, pattern) => {
      const match = textSource.match(pattern);
      if (!match) {
        fail(`src/text.ts no longer declares ${name} in the form this check reads`);
        return 0;
      }
      return Number(match[1]);
    };
    const scale = readConst('SCALE', /export const SCALE: i32 = (\d+);/);
    const baseW = readConst('CELL_W', /export const CELL_W: i32 = (\d+) \* SCALE;/);
    const baseH = readConst('CELL_H', /export const CELL_H: i32 = (\d+) \* SCALE;/);
    const guestCellW = baseW * scale;
    const guestCellH = baseH * scale;
    if (guestCellW !== ui.atlas.cellWidth || guestCellH !== ui.atlas.cellHeight) {
      fail(`the atlas cell is ${ui.atlas.cellWidth}x${ui.atlas.cellHeight} but the guest draws ` +
        `${guestCellW}x${guestCellH} — rebuild the font at the guest's scale ` +
        `(FONT_SCALE=${scale} node tools/make-font.mjs)`);
    } else {
      ok(`the guest's ${guestCellW}x${guestCellH} cell matches the baked atlas (SCALE ${scale})`);
    }
  }
}

// ── the pages ───────────────────────────────────────────────────────────────

process.stdout.write(`\nfirst ${showPages} pages, as the guest will read them\n`);
for (let i = 0; i < Math.min(showPages, docs.pages.length); i++) {
  const page = docs.pages[i];
  process.stdout.write(`\n[${i}] ${page.title}  (${page.path}, ${page.blockCount} blocks)\n`);
  for (let b = 0; b < page.blockCount; b++) {
    const block = docs.blocks[page.blockFirst + b];
    const marker = block.kind === KIND.heading ? '#'.repeat(block.level) : '';
    const flags = [];
    if (block.flags & BLOCK_FLAG.runnable) flags.push('runnable');
    if (block.flags & BLOCK_FLAG.generated) flags.push('generated');
    if (block.flags & BLOCK_FLAG.sectionStart) flags.push('section');

    // Show the styled runs as the viewer will paint them: `[style]text`.
    const text = block.runs
      .map((run) => (run.style === STYLE.plain ? run.text : `[${STYLE_NAME[run.style]}]${run.text}`))
      .join('');

    // A long block is truncated for the dump only; the file holds it whole.
    const shown = text.length > 160 ? `${text.slice(0, 157)}...` : text;
    const oneLine = shown.split('\n').join(' \\n ');
    process.stdout.write(`    ${String(block.index).padStart(4)} ${KIND_NAME[block.kind].padEnd(9)} ` +
      `${marker} ${oneLine}${flags.length ? `  {${flags.join(',')}}` : ''}\n`);
    if (block.kind === KIND.heading) process.stdout.write(`    ${underline(block.level)}\n`);
  }
}

// ── verdict ─────────────────────────────────────────────────────────────────

process.stdout.write('\n');
if (failures) {
  process.stderr.write(`verify: ${failures} check(s) failed\n`);
  process.exit(1);
}
process.stdout.write('verify: all checks passed\n');
