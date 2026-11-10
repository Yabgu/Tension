// Read `docs.bin` back with the same offsets the guest will use.
//
// This is deliberately a *second* implementation of the layout, not a shared
// one: the writer is a build tool and the reader is the contract. `verify.mjs`
// runs this against a fresh build, so a writer that emits something other than
// what `format.mjs` declares fails at build time rather than as a garbled page
// in the viewer.
//
// It reads by offset, never by shaping the bytes into objects whose field order
// could differ from the wire's — the same discipline the guest's reader will
// follow, where a field is a `load<u32>(base + K)` at a named constant.

import { readFileSync } from 'node:fs';
import {
  B, BLOCK_BYTES, H, HEADER_BYTES, MAGIC, PAGE_BYTES, P, R, RUN_BYTES, S,
  SECTION_BYTES, T, TOC_BYTES, TOC_NO_PAGE, VERSION,
} from './format.mjs';

/** A refusal the caller can act on: a version or a magic this reader cannot read. */
export class DocsFormatError extends Error {}

/**
 * Load a bundle.
 *
 * Returns arrays of plain objects, one per record, with strings already decoded.
 * That is more memory than a streaming reader needs; a 561 KiB file becomes a
 * few megabytes of objects, which is fine for a build tool and would not be fine
 * in the guest. The guest reads in place — this is the readable version.
 */
export function readDocs(pathOrBuffer) {
  const buf = Buffer.isBuffer(pathOrBuffer) ? pathOrBuffer : readFileSync(pathOrBuffer);

  if (buf.length < HEADER_BYTES) {
    throw new DocsFormatError(`shorter than the ${HEADER_BYTES}-byte header`);
  }
  const magic = buf.subarray(H.magic, H.magic + 8).toString('ascii');
  if (magic !== MAGIC) {
    throw new DocsFormatError(`not a docs bundle (magic ${JSON.stringify(magic)})`);
  }
  const version = buf.readUInt32LE(H.version);
  if (version !== VERSION) {
    throw new DocsFormatError(
      `bundle version ${version}, this reader speaks ${VERSION}; rebuild the assets`,
    );
  }

  const count = (field) => buf.readUInt32LE(H[field]);
  const pageCount = count('pageCount');
  const blockCount = count('blockCount');
  const runCount = count('runCount');
  const sectionCount = count('sectionCount');
  const tocCount = count('tocCount');
  const stringBytes = count('stringBytes');
  const stringsAt = count('stringsOffset');

  const str = (offset, length) => {
    if (offset + length > stringBytes) {
      throw new DocsFormatError(`string at ${offset}+${length} is past the ${stringBytes}-byte blob`);
    }
    return buf.subarray(stringsAt + offset, stringsAt + offset + length).toString('utf8');
  };

  const pages = [];
  for (let i = 0; i < pageCount; i++) {
    const at = count('pagesOffset') + i * PAGE_BYTES;
    pages.push({
      index: i,
      title: str(buf.readUInt32LE(at + P.titleOffset), buf.readUInt32LE(at + P.titleLength)),
      path: str(buf.readUInt32LE(at + P.pathOffset), buf.readUInt32LE(at + P.pathLength)),
      blockFirst: buf.readUInt32LE(at + P.blockFirst),
      blockCount: buf.readUInt32LE(at + P.blockCount),
      flags: buf.readUInt32LE(at + P.flags),
    });
  }

  const blocksAt = count('blocksOffset');
  const runsAt = count('runsOffset');
  const blocks = [];
  for (let i = 0; i < blockCount; i++) {
    const at = blocksAt + i * BLOCK_BYTES;
    const runFirst = buf.readUInt32LE(at + B.runFirst);
    const runCountHere = buf.readUInt32LE(at + B.runCount);
    if (runFirst + runCountHere > runCount) {
      throw new DocsFormatError(`block ${i} names runs ${runFirst}..${runFirst + runCountHere} of ${runCount}`);
    }
    const runs = [];
    for (let r = 0; r < runCountHere; r++) {
      const rat = runsAt + (runFirst + r) * RUN_BYTES;
      runs.push({
        style: buf.readUInt8(rat + R.style),
        text: str(buf.readUInt32LE(rat + R.textOffset), buf.readUInt32LE(rat + R.textLength)),
      });
    }
    blocks.push({
      index: i,
      kind: buf.readUInt8(at + B.kind),
      flags: buf.readUInt8(at + B.flags),
      level: buf.readUInt8(at + B.level),
      page: buf.readUInt32LE(at + B.page),
      line: buf.readUInt32LE(at + B.line),
      extra: buf.readUInt32LE(at + B.extra),
      runs,
    });
  }

  const sections = [];
  for (let i = 0; i < sectionCount; i++) {
    const at = count('sectionsOffset') + i * SECTION_BYTES;
    sections.push({
      index: i,
      title: str(buf.readUInt32LE(at + S.titleOffset), buf.readUInt32LE(at + S.titleLength)),
      page: buf.readUInt32LE(at + S.page),
      blockFirst: buf.readUInt32LE(at + S.blockFirst),
      blockCount: buf.readUInt32LE(at + S.blockCount),
    });
  }

  const toc = [];
  for (let i = 0; i < tocCount; i++) {
    const at = count('tocOffset') + i * TOC_BYTES;
    const page = buf.readUInt32LE(at + T.page);
    toc.push({
      index: i,
      title: str(buf.readUInt32LE(at + T.titleOffset), buf.readUInt32LE(at + T.titleLength)),
      page: page === TOC_NO_PAGE ? null : page,
      depth: buf.readUInt32LE(at + T.depth),
    });
  }

  return {
    version,
    sourceSha: buf.readUInt32LE(H.sourceSha),
    counts: { pages: pageCount, blocks: blockCount, runs: runCount, sections: sectionCount, toc: tocCount },
    pages,
    blocks,
    sections,
    toc,
    /** The plain text of one block: its runs concatenated with no separator. */
    blockText: (block) => block.runs.map((r) => r.text).join(''),
  };
}
