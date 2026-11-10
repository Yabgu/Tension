// Read `search.bin` back with the offsets `format`/`search.mjs` declare.
//
// Same discipline as `read-docs.mjs`: a second implementation of the layout, so
// a writer that emits something else fails here rather than in the viewer.

import { readFileSync } from 'node:fs';

export const SEARCH_MAGIC = 'TNSRCH1\u0000';
export const SEARCH_VERSION = 1;
export const SEARCH_HEADER_BYTES = 40;
export const TERM_BYTES = 16;
export const POSTING_BYTES = 12;

export class SearchFormatError extends Error {}

/** One posting: which section, how often, and where it first appeared. */
export function decodePosting(word) {
  return {
    section: word & 0xffff,
    inHeading: (word & 0x8000) !== 0,
    occurrences: word & 0x7fff,
  };
}

export function readSearch(pathOrBuffer) {
  const buf = Buffer.isBuffer(pathOrBuffer) ? pathOrBuffer : readFileSync(pathOrBuffer);

  if (buf.length < SEARCH_HEADER_BYTES) {
    throw new SearchFormatError(`shorter than the ${SEARCH_HEADER_BYTES}-byte header`);
  }
  const magic = buf.subarray(0, 8).toString('ascii');
  if (magic !== SEARCH_MAGIC) {
    throw new SearchFormatError(`not a search index (magic ${JSON.stringify(magic)})`);
  }
  const version = buf.readUInt32LE(8);
  if (version !== SEARCH_VERSION) {
    throw new SearchFormatError(`index version ${version}, this reader speaks ${SEARCH_VERSION}`);
  }

  const termCount = buf.readUInt32LE(12);
  const postingCount = buf.readUInt32LE(16);
  const sectionCount = buf.readUInt32LE(20);
  const stringBytes = buf.readUInt32LE(24);
  const stringsAt = buf.readUInt32LE(28);
  const termsAt = buf.readUInt32LE(32);
  const postingsAt = buf.readUInt32LE(36);

  const str = (offset, length) => {
    if (offset + length > stringBytes) {
      throw new SearchFormatError(`term at ${offset}+${length} is past the ${stringBytes}-byte blob`);
    }
    return buf.subarray(stringsAt + offset, stringsAt + offset + length).toString('utf8');
  };

  const terms = [];
  for (let i = 0; i < termCount; i++) {
    const at = termsAt + i * TERM_BYTES;
    terms.push({
      term: str(buf.readUInt32LE(at), buf.readUInt32LE(at + 4)),
      postFirst: buf.readUInt32LE(at + 8),
      postCount: buf.readUInt32LE(at + 12),
    });
  }

  const postings = [];
  for (let i = 0; i < postingCount; i++) {
    const at = postingsAt + i * POSTING_BYTES;
    postings.push({
      section: buf.readUInt32LE(at),
      inHeading: (buf.readUInt16LE(at + 4) & 0x8000) !== 0,
      occurrences: buf.readUInt16LE(at + 4) & 0x7fff,
      firstBlock: buf.readUInt16LE(at + 6),
      firstChar: buf.readUInt32LE(at + 8),
    });
  }

  /** Binary search the sorted dictionary. This is the guest's lookup, in JS. */
  function find(term) {
    let lo = 0;
    let hi = terms.length - 1;
    while (lo <= hi) {
      const mid = (lo + hi) >> 1;
      const cmp = terms[mid].term < term ? -1 : terms[mid].term > term ? 1 : 0;
      if (cmp === 0) return terms[mid];
      if (cmp < 0) lo = mid + 1;
      else hi = mid - 1;
    }
    return null;
  }

  /** Every term sharing `prefix`, in dictionary order. The as-you-type path. */
  function prefix(prefixText, limit = 20) {
    let lo = 0;
    let hi = terms.length;
    while (lo < hi) {
      const mid = (lo + hi) >> 1;
      if (terms[mid].term < prefixText) lo = mid + 1;
      else hi = mid;
    }
    const out = [];
    for (let i = lo; i < terms.length && out.length < limit; i++) {
      if (!terms[i].term.startsWith(prefixText)) break;
      out.push(terms[i]);
    }
    return out;
  }

  /**
   * Score and rank sections for a query.
   *
   * Deliberately simple and explainable: a term's occurrences, doubled when it
   * appeared in the section's heading. The reader can tell why a result ranked
   * where it did, which matters more than a marginally better order.
   */
  function query(text, limit = 10) {
    const wanted = new Map();
    for (const word of text.toLowerCase().split(/[^a-z0-9_]+/)) {
      if (word.length < 2) continue;
      const entry = find(word);
      if (!entry) continue;
      for (let i = 0; i < entry.postCount; i++) {
        const posting = postings[entry.postFirst + i];
        const score = posting.occurrences * (posting.inHeading ? 2 : 1);
        const current = wanted.get(posting.section);
        if (!current) wanted.set(posting.section, { ...posting, score });
        else current.score += score;
      }
    }
    return [...wanted.values()].sort((a, b) => b.score - a.score).slice(0, limit);
  }

  return { termCount, postingCount, sectionCount, terms, postings, find, prefix, query };
}
