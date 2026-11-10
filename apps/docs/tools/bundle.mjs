#!/usr/bin/env node
// Build `assets/docs.bin` from `docs/book.json` + the Markdown it names.
//
// Two front doors, one parser:
//
//   docs/book.json ──► docs/*.md ─────────────┐
//   tension-framework/assembly/**/*.ts ──► generated .md ─┤
//                                                         └──► marked.lexer ──► blocks ──► docs.bin
//
// The TSDoc reference pages are *rendered to Markdown first*, then parsed by the
// same lexer as the prose. A second path that produced blocks directly would be
// a second markdown dialect to keep in step; this way there is one.
//
// **It fails rather than warns** on: a missing page, a page the manifest does
// not name, an unmapped character in prose, or a chapter with a page and
// children at once. The last one matters because the reader would have no
// defined order — and this repository's habit is that a guard which cannot fail
// is not a guard (`docs/guard-discipline.md`).
//
// Usage:  node tools/bundle.mjs [--out <path>] [--verbose]

import { execFileSync } from 'node:child_process';
import { mkdirSync, readFileSync, readdirSync, statSync, writeFileSync } from 'node:fs';
import { dirname, join, relative, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';

import { fold, parseDocument, sectionsOf } from './lib/markdown.mjs';
import { scanFramework } from './lib/tsdoc.mjs';
import {
  BLOCK_BYTES, BLOCK_FLAG, HEADER_BYTES, H, KIND, MAGIC, PAGE_BYTES, PAGE_FLAG, P,
  RUN_BYTES, R, SECTION_BYTES, S, STYLE, Strings, TOC_BYTES, TOC_NO_PAGE, T, VERSION, Writer,
} from './lib/format.mjs';

const here = dirname(fileURLToPath(import.meta.url));
const appDir = resolve(here, '..');
const repo = resolve(appDir, '..', '..');
const docsDir = join(repo, 'docs');

function fail(message, detail = []) {
  process.stderr.write(`bundle: ${message}\n`);
  for (const line of detail) process.stderr.write(`  ${line}\n`);
  process.exit(1);
}

const argv = process.argv.slice(2);
let outPath = join(appDir, 'assets', 'docs.bin');
let verbose = false;
for (let i = 0; i < argv.length; i++) {
  if (argv[i] === '--out') outPath = resolve(argv[++i]);
  else if (argv[i] === '--verbose') verbose = true;
  else fail(`unknown argument '${argv[i]}'`);
}

// ── the manifest ────────────────────────────────────────────────────────────

const bookPath = join(docsDir, 'book.json');
let book;
try {
  book = JSON.parse(readFileSync(bookPath, 'utf8'));
} catch (error) {
  fail(`cannot read ${bookPath}`, error.message);
}
if (!Array.isArray(book.chapters) || book.chapters.length === 0) {
  fail(`${bookPath} has no chapters`);
}

/**
 * Flatten the manifest into an ordered list of entries, keeping the depth so
 * the table of contents can indent.
 *
 * A chapter is either a *page* (a link) or a *group* (children). A chapter with
 * both is ambiguous — is the group heading itself a page? — so it is refused.
 */
function flatten(chapters, depth, out) {
  for (const chapter of chapters) {
    if (!chapter.title) fail(`a chapter at depth ${depth} has no title`);

    if (chapter.pages === 'sdk') {
      // A marker for "the generated reference", whose entries are known only
      // after the scan. Reserved here so the group keeps its position.
      out.push({ kind: 'sdk', title: chapter.title, depth });
      continue;
    }

    if (chapter.children) {
      if (chapter.page) {
        fail(`chapter '${chapter.title}' has both a page and children`, [
          'a chapter is a link or a group, not both; split it into two entries',
        ]);
      }
      out.push({ kind: 'group', title: chapter.title, depth });
      flatten(chapter.children, depth + 1, out);
      continue;
    }

    if (!chapter.page) fail(`chapter '${chapter.title}' has neither a page nor children`);
    out.push({ kind: 'page', title: chapter.title, page: chapter.page, depth });
  }
}

const flat = [];
flatten(book.chapters, 0, flat);

// ── the pages ───────────────────────────────────────────────────────────────

const strings = new Strings();
const pages = [];      // { title, path, blocks, flags }
const unmappedAll = new Map(); // char -> first file

/**
 * Fold a manifest title to the font's alphabet.
 *
 * `docs/book.json` is hand-written and uses the same typography the pages do, so
 * a chapter title can contain an em dash. Titles do not pass through the Markdown
 * normalizer — they are interned straight from the manifest — so they are folded
 * here. Missing this would put a `?` box in the sidebar, which is exactly the
 * class of defect the unmapped-character guard exists to prevent.
 */
function foldTitle(title, where) {
  const result = fold(title);
  for (const ch of result.unmapped) {
    if (!unmappedAll.has(ch)) unmappedAll.set(ch, where);
  }
  return result.text;
}

/** Every hand-written page the manifest names, loaded once. */
function loadPage(relPath, title, flags = 0) {
  const path = join(docsDir, relPath);
  let text;
  try {
    text = readFileSync(path, 'utf8');
  } catch {
    fail(`the manifest names a page that does not exist: docs/${relPath}`);
  }
  const pageIndex = pages.length;
  const { blocks, unmapped } = parseDocument(text, {
    page: pageIndex,
    generated: (flags & PAGE_FLAG.generated) !== 0,
  });
  for (const ch of unmapped) {
    if (!unmappedAll.has(ch)) unmappedAll.set(ch, `docs/${relPath}`);
  }
  pages.push({ title: foldTitle(title, `docs/${relPath}`), path: `docs/${relPath}`, blocks, flags });
  return pageIndex;
}

/** The generated reference pages, scanned once and spliced in where marked. */
let sdkPages = null;
function sdk() {
  if (sdkPages) return sdkPages;
  const framework = join(repo, 'tension-framework');
  if (!statSync(framework, { throwIfNoEntry: false })) {
    fail(`no tension-framework at ${framework}`, 'the reference chapter needs it');
  }
  sdkPages = scanFramework(framework, repo);
  if (!sdkPages.length) fail('the TSDoc scan found no documented declarations');
  return sdkPages;
}

/** Pages the manifest named, in order, so an unlisted page can be reported. */
const listed = new Set();

for (const entry of flat) {
  if (entry.kind === 'group') continue;
  if (entry.kind === 'sdk') {
    for (const page of sdk()) {
      // A generated page is marked so the viewer can label it; its flags also
      // reach every block, which is what lets a reader tell source-derived prose
      // from hand-written prose.
      const pageIndex = pages.length;
      const { blocks, unmapped } = parseDocument(page.markdown, {
        page: pageIndex,
        generated: true,
      });
      for (const ch of unmapped) {
        if (!unmappedAll.has(ch)) unmappedAll.set(ch, page.path);
      }
      pages.push({ title: page.title, path: `${page.path}`, blocks, flags: PAGE_FLAG.generated });
    }
    continue;
  }
  listed.add(entry.page);
  loadPage(entry.page, entry.title);
}

// A doc that exists but is not in the book is invisible in the viewer, which is
// the kind of omission nobody notices. Report it rather than silently shipping a
// partial book; `--allow-unlisted` is not offered, because the fix is one line.
const allMarkdown = [];
(function walkDocs(dir) {
  for (const name of readdirSync(dir)) {
    const path = join(dir, name);
    if (statSync(path).isDirectory()) {
      walkDocs(path);
      continue;
    }
    if (name.endsWith('.md')) allMarkdown.push(relative(docsDir, path).split('\\').join('/'));
  }
})(docsDir);

const unlisted = allMarkdown.filter((path) => !listed.has(path)).sort();
if (unlisted.length) {
  fail(`${unlisted.length} documentation page(s) are not in docs/book.json`, [
    ...unlisted.map((path) => `docs/${path}`),
    'add them to the manifest (or the viewer will not show them)',
  ]);
}

if (unmappedAll.size) {
  fail(`${unmappedAll.size} character(s) have no ASCII glyph`, [
    ...[...unmappedAll].map(([ch, where]) => `${JSON.stringify(ch)} (U+${ch.codePointAt(0).toString(16).toUpperCase().padStart(4, '0')}) in ${where}`),
    'add a fold to tools/lib/markdown.mjs FOLD, or edit the source',
  ]);
}

// ── sections ────────────────────────────────────────────────────────────────

// Sections are the unit of a search hit: a heading plus the blocks under it, so
// "Submit" in the 2D module is a destination rather than the whole page.
//
// **The indices are global, not page-relative.** `sectionsOf` works within one
// page because that is how a page's blocks arrive; the wire's section table
// indexes the whole block array, and a reader that added a page-relative index
// to a page offset would land in another page's prose. So the page's first block
// is computed first, then folded in here.
let blockCursor = 0;
for (const page of pages) {
  page.blockFirst = blockCursor;
  blockCursor += page.blocks.length;
}

const sections = [];
for (let i = 0; i < pages.length; i++) {
  const page = pages[i];
  for (const section of sectionsOf(page.blocks, i)) {
    sections.push({
      ...section,
      blockFirst: page.blockFirst + section.blockFirst,
    });
    page.blocks[section.blockFirst].flags |= BLOCK_FLAG.sectionStart;
  }
}

// ── the table of contents ───────────────────────────────────────────────────

// The TOC is the manifest, with each page entry pointing at the page it opens.
// A page named twice (it is not, today) would take the first index, which the
// duplicate check above already refuses for docs and the manifest layout keeps
// unique.
const toc = [];
{
  let pageCursor = 0;
  for (const entry of flat) {
    if (entry.kind === 'group') {
      toc.push({ title: foldTitle(entry.title, 'docs/book.json'), page: TOC_NO_PAGE, depth: entry.depth });
      continue;
    }
    if (entry.kind === 'sdk') {
      toc.push({ title: foldTitle(entry.title, 'docs/book.json'), page: TOC_NO_PAGE, depth: entry.depth });
      for (const page of sdk()) {
        toc.push({ title: page.title, page: pageCursor, depth: entry.depth + 1 });
        pageCursor++;
      }
      continue;
    }
    toc.push({ title: foldTitle(entry.title, 'docs/book.json'), page: pageCursor, depth: entry.depth });
    pageCursor++;
  }
}

// ── serialise ───────────────────────────────────────────────────────────────

const blockOut = new Writer();
const runOut = new Writer();
let blockCount = 0;
let runCount = 0;

for (let pageIndex = 0; pageIndex < pages.length; pageIndex++) {
  const page = pages[pageIndex];

  for (const block of page.blocks) {
    const runFirst = runCount;

    for (const run of block.runs) {
      const { offset, length } = strings.add(run.text);
      runOut.u8(run.style).zero(3).u32(offset).u32(length);
      runCount++;
    }

    // A code block's `extra` is the offset of its language string, which the
    // viewer draws as a label in the gutter. Everything else leaves it 0.
    let extra = block.extra ?? 0;
    if (block.kind === KIND.code && block.language) extra = strings.add(block.language).offset;

    blockOut
      .u8(block.kind)
      .u8(block.flags ?? 0)
      .u8(block.level ?? 0)
      .u8(0)
      .u32(runFirst)
      .u32(runCount - runFirst)
      .u32(pageIndex)
      .u32(block.line ?? 0)
      .u32(extra);
    blockCount++;
  }

  page.blockCount = blockCount - page.blockFirst;
}

// Sections must be written after the block indices are final, which they are.
const sectionOut = new Writer();
for (const section of sections) {
  const title = strings.add(section.title ?? '');
  sectionOut
    .u32(title.offset).u32(title.length)
    .u32(section.page)
    .u32(section.blockFirst)
    .u32(section.blockCount);
}

const tocOut = new Writer();
for (const entry of toc) {
  const title = strings.add(entry.title);
  tocOut
    .u32(title.offset).u32(title.length)
    .u32(entry.page)
    .u32(entry.depth);
}

const pageOut = new Writer();
for (const page of pages) {
  const title = strings.add(page.title);
  const path = strings.add(page.path);
  pageOut
    .u32(title.offset).u32(title.length)
    .u32(path.offset).u32(path.length)
    .u32(page.blockFirst)
    .u32(page.blockCount)
    .u32(page.flags);
}

// Sections in the file: strings last is not possible, because everything else
// references it by offset and the offsets have to be final before the header is
// written. So: strings first, then each table, and the header carries every
// offset.
const stringBlob = strings.toBuffer();

const layout = {};
let cursor = HEADER_BYTES;
layout.strings = cursor; cursor += stringBlob.length;
layout.pages = cursor; cursor += pageOut.length;
layout.blocks = cursor; cursor += blockOut.length;
layout.runs = cursor; cursor += runOut.length;
layout.sections = cursor; cursor += sectionOut.length;
layout.toc = cursor; cursor += tocOut.length;

const header = new Writer();
header.raw(Buffer.from(MAGIC, 'ascii'));
header
  .u32(VERSION)
  .u32(0)               // flags
  .u32(pages.length)
  .u32(blockCount)
  .u32(runCount)
  .u32(sections.length)
  .u32(toc.length)
  .u32(stringBlob.length)
  .u32(layout.strings)
  .u32(layout.pages)
  .u32(layout.blocks)
  .u32(layout.runs)
  .u32(layout.sections)
  .u32(layout.toc);

// The source commit, so a bundle can be matched to the tree it documents. A
// repository with no git (or a detached export) records 0 rather than failing:
// the docs are still true, only unattributable.
let sourceSha = 0;
try {
  const sha = execFileSync('git', ['-C', repo, 'rev-parse', 'HEAD'], { encoding: 'utf8' }).trim();
  sourceSha = parseInt(sha.slice(0, 8), 16) >>> 0;
} catch {
  // Not a git checkout.
}
header.u32(sourceSha).u32(0);

if (header.length !== HEADER_BYTES) {
  fail(`the header is ${header.length} bytes, not the ${HEADER_BYTES} the format declares`,
    'tools/lib/format.mjs H and HEADER_BYTES disagree');
}

const blob = Buffer.concat([
  header.toBuffer(),
  stringBlob,
  pageOut.toBuffer(),
  blockOut.toBuffer(),
  runOut.toBuffer(),
  sectionOut.toBuffer(),
  tocOut.toBuffer(),
]);

mkdirSync(dirname(outPath), { recursive: true });
writeFileSync(outPath, blob);

// ── report ──────────────────────────────────────────────────────────────────

const counts = {
  version: VERSION,
  pages: pages.length,
  blocks: blockCount,
  runs: runCount,
  sections: sections.length,
  toc: toc.length,
  strings: strings.byText.size,
  stringBytes: stringBlob.length,
  bytes: blob.length,
  sourceSha: `0x${sourceSha.toString(16).padStart(8, '0')}`,
};
// A sidecar for the verifier and for a human checking a build without opening a
// hex editor. It is build output, not an input.
writeFileSync(join(dirname(outPath), 'docs.index.json'), `${JSON.stringify({
  ...counts,
  out: relative(repo, outPath).split('\\').join('/'),
  pagesList: pages.map((page, i) => ({
    index: i,
    title: page.title,
    path: page.path,
    blocks: page.blockCount,
    generated: (page.flags & PAGE_FLAG.generated) !== 0,
  })),
  toc: toc.map((entry) => ({
    title: entry.title,
    page: entry.page === TOC_NO_PAGE ? null : entry.page,
    depth: entry.depth,
  })),
}, null, 2)}\n`);

process.stdout.write(
  `bundle: ${counts.pages} pages, ${counts.blocks} blocks, ${counts.runs} runs, ` +
  `${counts.sections} sections, ${counts.strings} strings\n` +
  `bundle: ${(blob.length / 1024).toFixed(1)} KiB -> ${relative(repo, outPath).split('\\').join('/')} ` +
  `(source ${counts.sourceSha})\n`,
);

if (verbose) {
  for (const page of pages) {
    process.stdout.write(`  ${String(page.blockCount).padStart(5)} blocks  ${page.path}\n`);
  }
  const byKind = new Map();
  for (const page of pages) for (const block of page.blocks) {
    byKind.set(block.kind, (byKind.get(block.kind) ?? 0) + 1);
  }
  const names = Object.fromEntries(Object.entries(KIND).map(([name, id]) => [id, name]));
  for (const [kind, count] of [...byKind].sort((a, b) => a[0] - b[0])) {
    process.stdout.write(`  ${String(count).padStart(5)} ${names[kind] ?? kind}\n`);
  }
}
