// Markdown → the block/run model `docs.bin` stores.
//
// `marked.lexer()` returns a token stream, and this file maps it into **our**
// schema rather than shipping marked's tokens. That indirection is the point:
// marked's token shape is an internal API with no compatibility promise, so a
// minor upgrade could silently change the wire format. Nothing downstream sees a
// marked token.
//
// Two rules the normalizer keeps:
//
//   1. **The output is ASCII.** The viewer's font is 95 glyphs, and the docs are
//      written with em dashes, arrows and typographic quotes. Folding is done
//      here, at build time, and anything with no sensible ASCII spelling is
//      reported instead of silently becoming a box. `bundle.mjs` fails the build
//      on an unmapped character that is not inside a code fence — a stray `→` in
//      prose is a font bug we want to see, not a rendering artefact.
//
//   2. **A run is a contiguous span of one style.** Styles are not nested in the
//      output: `**a *b* c**` becomes three runs (strong, strong+emphasis,
//      strong), because the viewer resolves a style per run and has no style
//      stack. Strength and emphasis compose to two bits, and code/link override.

import { marked } from 'marked';
import { KIND, STYLE, BLOCK_FLAG } from './format.mjs';

/**
 * Typographic → ASCII. Every entry was found by scanning `docs/`; the list is
 * the reason the build is allowed to refuse an unmapped character.
 */
const FOLD = new Map(Object.entries({
  '\u2014': '-',   // em dash
  '\u2013': '-',   // en dash
  '\u2012': '-',   // figure dash
  '\u2010': '-',   // hyphen
  '\u2011': '-',   // non-breaking hyphen
  '\u2018': "'",   // left single quote
  '\u2019': "'",   // right single quote
  '\u201c': '"',   // left double quote
  '\u201d': '"',   // right double quote
  '\u2026': '...', // ellipsis
  '\u2192': '->',  // rightwards arrow
  '\u2190': '<-',  // leftwards arrow
  '\u21d2': '=>',  // rightwards double arrow
  '\u21d4': '<=>', // leftwards double arrow
  '\u00d7': 'x',   // multiplication sign
  '\u00b7': '.',   // middle dot
  '\u2022': '*',   // bullet
  '\u00a0': ' ',   // non-breaking space
  '\u2009': ' ',   // thin space
  '\u200b': '',    // zero-width space
  '\u2028': ' ',   // line separator
  '\u2029': ' ',   // paragraph separator
  '\u2265': '>=',  // greater-or-equal
  '\u2264': '<=',  // less-or-equal
  '\u2260': '!=',  // not equal
  '\u00b1': '+/-', // plus-minus
  '\u00b0': 'deg', // degree
  '\u00b5': 'u',   // micro
  '\u03c0': 'pi',  // pi
  '\u03b1': 'alpha',
  '\u03b2': 'beta',
  '\u03bc': 'u',
  '\u00a7': '#',   // section sign (the docs use it as "section 7")
  '\u2212': '-',   // minus sign
  '\u207b': '-',   // superscript minus
  '\u00b9': '1',   // superscript one
  '\u00b2': '2',   // superscript two
  '\u00b3': '3',   // superscript three
  '\u00bd': '1/2', // one half
  '\u03c9': 'w',   // omega
  '\u2297': '(x)', // circled times
  '\u25b6': '>',   // black right-pointing triangle
  '\u25c0': '<',   // black left-pointing triangle
  '\u00e9': 'e',
  '\u00e8': 'e',
  '\u00fc': 'u',
  '\u00f6': 'o',
  '\u00e4': 'a',
  '\u00df': 'ss',
  '\u2713': 'ok',  // check mark
  '\u25cf': '*',   // black circle
  '\u2500': '-',   // box drawing horizontal
  '\u2502': '|',   // box drawing vertical
  '\u250c': '+', '\u2510': '+', '\u2514': '+', '\u2518': '+',
  '\u251c': '+', '\u2524': '+', '\u252c': '+', '\u2534': '+', '\u253c': '+',
}));

/** Characters with no fold that are acceptable as-is (they are ASCII). */
function isPrintableAscii(code) {
  return code === 0x09 || code === 0x0a || (code >= 0x20 && code <= 0x7e);
}

/**
 * Fold a string to ASCII.
 *
 * Returns `{ text, unmapped }`, where `unmapped` is the set of code points with
 * no spelling. The caller decides whether that is fatal; a code fence tolerates
 * more than prose does.
 */
export function fold(input) {
  const unmapped = new Set();
  let out = '';
  for (const ch of input) {
    const code = ch.codePointAt(0);
    if (isPrintableAscii(code)) {
      out += ch;
      continue;
    }
    if (FOLD.has(ch)) {
      out += FOLD.get(ch);
      continue;
    }
    // A stray carriage return is in files that were edited on Windows; it is
    // not a content problem and it must not reach the guest as a glyph.
    if (ch === '\r') continue;
    unmapped.add(ch);
    out += '?';
  }
  return { text: out, unmapped };
}

/** Strip HTML tags and decode the five entities that appear in this corpus. */
function stripInlineHtml(text) {
  return text
    .replace(/<br\s*\/?>/gi, ' ')
    .replace(/<\/?[a-zA-Z][^>]*>/g, '')
    .replace(/&amp;/g, '&')
    .replace(/&lt;/g, '<')
    .replace(/&gt;/g, '>')
    .replace(/&quot;/g, '"')
    .replace(/&#39;/g, "'")
    .replace(/&nbsp;/g, ' ');
}

/** The two style bits a run carries, composed from nested inline tokens. */
function composeStyle(base, token) {
  switch (token.type) {
    case 'strong':
      return { style: base | 1, isStrong: true };
    case 'em':
      return { style: base | 2, isStrong: false };
    default:
      return { style: base, isStrong: false };
  }
}

/**
 * Walk inline tokens into runs.
 *
 * `ctx` carries the inherited style bits and whether the span is inside a link.
 * Code and links are terminal: their children are not styled further, because a
 * link's colour is the link colour regardless of the emphasis inside it.
 */
function inlineRuns(tokens, out, ctx = { style: 0, link: false }) {
  if (!tokens) return;
  for (const token of tokens) {
    switch (token.type) {
      case 'text': {
        // A text token may itself carry child tokens (marked nests them for
        // some constructs); prefer the children when present.
        if (token.tokens && token.tokens.length) inlineRuns(token.tokens, out, ctx);
        else pushRun(out, stripInlineHtml(token.text ?? ''), ctx.style);
        break;
      }
      case 'escape':
      case 'html':
        pushRun(out, stripInlineHtml(token.text ?? ''), ctx.style);
        break;
      case 'codespan':
        pushRun(out, token.text ?? '', STYLE.code);
        break;
      case 'br':
        pushRun(out, ' ', ctx.style);
        break;
      case 'strong':
      case 'em': {
        const { style } = composeStyle(ctx.style, token);
        inlineRuns(token.tokens ?? [{ type: 'text', text: token.text }], out, { ...ctx, style });
        break;
      }
      case 'del':
        inlineRuns(token.tokens ?? [{ type: 'text', text: token.text }], out, ctx);
        break;
      case 'link': {
        // The visible text is what a reader sees; the href is kept for the
        // viewer's status line, not in the run.
        inlineRuns(token.tokens ?? [{ type: 'text', text: token.text }], out, { ...ctx, style: STYLE.link, link: true });
        break;
      }
      case 'image':
        pushRun(out, `[${token.text ?? 'image'}]`, STYLE.link);
        break;
      default:
        // An unknown inline token is text we would otherwise drop silently.
        if (typeof token.text === 'string' && token.text) pushRun(out, stripInlineHtml(token.text), ctx.style);
        break;
    }
  }
}

/**
 * Append a run, merging with the previous one when the style matches.
 *
 * Merging is not cosmetic: `**a** **b**` and `**a b**` should cost one run, and
 * a paragraph of plain text should be one run rather than one per word. The
 * viewer allocates per run, so fewer runs is less work per frame.
 */
function pushRun(out, text, style) {
  if (!text) return;
  const last = out[out.length - 1];
  if (last && last.style === style) {
    last.text += text;
    return;
  }
  out.push({ style, text });
}

/**
 * Parse a Markdown document into blocks.
 *
 * @param {string} markdown
 * @param {{page:number, generated:boolean}} meta
 * @returns {{blocks:Array, unmapped:Set<string>}}
 */
export function parseDocument(markdown, meta = { page: 0, generated: false }) {
  const tokens = marked.lexer(markdown);
  const blocks = [];
  const unmapped = new Set();

  /** Emit one block, folding its runs. */
  const emit = (block, runs) => {
    const folded = [];
    for (const run of runs) {
      const result = fold(run.text);
      for (const ch of result.unmapped) unmapped.add(ch);
      if (result.text) folded.push({ style: run.style, text: result.text });
    }
    // A block with no text is still meaningful for `rule`; everything else
    // with no text is a paragraph that would draw an empty line.
    if (block.kind !== KIND.rule && folded.length === 0) return;
    blocks.push({
      kind: block.kind,
      flags: (block.flags ?? 0) | (meta.generated ? BLOCK_FLAG.generated : 0),
      level: block.level ?? 0,
      line: block.line ?? 0,
      extra: block.extra ?? 0,
      runs: folded,
    });
  };

  const walk = (list, depth) => {
    for (const token of list) {
      switch (token.type) {
        case 'heading': {
          const runs = [];
          inlineRuns(token.tokens, runs);
          emit({
            kind: KIND.heading,
            level: token.depth,
            flags: BLOCK_FLAG.sectionStart,
            line: token.raw ? countLinesBefore(markdown, token.raw) : 0,
          }, runs);
          break;
        }

        case 'paragraph': {
          const runs = [];
          inlineRuns(token.tokens ?? [{ type: 'text', text: token.text }], runs);
          emit({ kind: depth > 0 ? KIND.listItem : KIND.paragraph, level: depth }, runs);
          break;
        }

        case 'code': {
          const info = (token.lang ?? '').trim();
          const words = info.split(/\s+/).filter(Boolean);
          const runnable = words.includes('runnable');
          const lang = words.filter((w) => w !== 'runnable').join(' ');
          const result = fold(token.text ?? '');
          for (const ch of result.unmapped) unmapped.add(ch);
          blocks.push({
            kind: KIND.code,
            flags: (runnable ? BLOCK_FLAG.runnable : 0) | (meta.generated ? BLOCK_FLAG.generated : 0),
            level: depth,
            line: 0,
            // The language drives a label in the viewer's gutter. It is a short
            // ASCII word (`sh`, `ts`, `c`), so it is stored inline rather than
            // interned — the writer special-cases it as a small string table.
            extra: 0,
            language: lang,
            runs: [{ style: STYLE.code, text: result.text.replace(/\n+$/, '') }],
          });
          break;
        }

        case 'list': {
          for (const item of token.items ?? []) {
            // An item's tokens are paragraphs and possibly a nested list. The
            // first paragraph becomes the item; a nested list recurses.
            const nested = [];
            const paras = [];
            for (const child of item.tokens ?? []) {
              if (child.type === 'list') nested.push(child);
              else if (child.type === 'paragraph' || child.type === 'text') paras.push(child);
              else if (child.type === 'code') paras.push(child);
            }
            const runs = [];
            for (const para of paras) {
              if (para.type === 'code') continue;
              inlineRuns(para.tokens ?? [{ type: 'text', text: para.text }], runs);
              pushRun(runs, ' ', 0);
            }
            // Trailing space from the separator.
            const last = runs[runs.length - 1];
            if (last) last.text = last.text.replace(/\s+$/, '');
            emit({
              kind: KIND.listItem,
              level: depth,
              // `extra` is the ordered list's start number, or 0 for a bullet.
              extra: token.ordered ? Number(token.start) || 1 : 0,
            }, runs);
            for (const child of nested) walk([child], depth + 1);
          }
          break;
        }

        case 'blockquote': {
          const runs = [];
          inlineRuns(collectText(token.tokens ?? []), runs);
          emit({ kind: KIND.quote, level: depth }, runs);
          break;
        }

        case 'hr':
          emit({ kind: KIND.rule }, []);
          break;

        case 'table': {
          // A table is flattened to its rows, one per line, because the viewer
          // has no column geometry in v1. It is readable, which is the bar; a
          // real table is a 2.2b improvement.
          const rows = [];
          const header = (token.header ?? []).map((cell) => cell.text);
          if (header.length) rows.push(header.join('  |  '));
          for (const row of token.rows ?? []) rows.push(row.map((cell) => cell.text).join('  |  '));
          const runs = [];
          pushRun(runs, rows.join('\n'), STYLE.plain);
          emit({ kind: KIND.table }, runs);
          break;
        }

        case 'html': {
          const text = stripInlineHtml(token.text ?? '').trim();
          if (text) {
            const runs = [];
            pushRun(runs, text, STYLE.plain);
            emit({ kind: KIND.paragraph }, runs);
          }
          break;
        }

        case 'space':
          break;

        default:
          break;
      }
    }
  };

  walk(tokens, 0);
  return { blocks, unmapped };
}

/** Flatten a blockquote's children into inline tokens. */
function collectText(tokens) {
  const out = [];
  for (const token of tokens) {
    if (token.tokens) out.push(...token.tokens);
    else if (typeof token.text === 'string') out.push({ type: 'text', text: token.text });
  }
  return out;
}

/** 1-based line number of a token's first occurrence. Only used diagnostically. */
function countLinesBefore(doc, raw) {
  const at = doc.indexOf(raw);
  if (at < 0) return 0;
  let line = 1;
  for (let i = 0; i < at; i++) if (doc.charCodeAt(i) === 10) line++;
  return line;
}

/**
 * Split blocks into sections: a heading opens one, and everything until the next
 * heading of any level belongs to it. Level-1 headings *within* a page start a
 * new section too, which is what the search index wants — a hit should land on
 * "Submit" rather than on all of `docs/modules/2d.md`.
 */
export function sectionsOf(blocks, page) {
  const sections = [];
  let current = null;

  for (let i = 0; i < blocks.length; i++) {
    const block = blocks[i];
    const isStart = block.kind === KIND.heading;
    if (isStart || !current) {
      if (current) current.blockCount = i - current.blockFirst;
      const title = isStart ? block.runs.map((r) => r.text).join('') : null;
      current = {
        page,
        title: title ?? '(untitled)',
        blockFirst: i,
        blockCount: 0,
        level: block.level || 0,
      };
      sections.push(current);
      // The heading block itself belongs to the section it opens.
      continue;
    }
  }
  if (current) current.blockCount = blocks.length - current.blockFirst;
  return sections;
}
