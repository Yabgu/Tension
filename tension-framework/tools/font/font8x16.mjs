// The 8x16 bitmap font the documentation viewer draws with.
//
// ## Where the data comes from — and where it does not
//
// The glyphs are the **IBM VGA 8x16 ROM font**, taken from the CC0 transcription
// in `robhagemans/hoard-of-bitfonts`:
//
//   https://github.com/robhagemans/hoard-of-bitfonts/blob/master/ibm/vga_8x16.yaff
//
// That repository dedicates its own work to the public domain — *"to the extent
// possible under law, I waive all copyright and related or neighbouring rights
// to that additional work under the Creative Commons Zero dedication"* — and
// documents the typefaces themselves as not subject to copyright in the US,
// with the 25-year term expired in the UK. The yaff also records its own
// upstream (`IBM_VGA_8x16.bin`, `VGA8.F16`), so the chain is checkable rather
// than asserted here.
//
// **Not** taken from the Linux kernel's `lib/fonts/font_8x16.c`. That file is
// `SPDX-License-Identifier: GPL-2.0`, and a viewer in a permissively-licensed
// tree cannot ship GPL bytes however good the data is. It was used only as an
// *independent transcription to compare against*: 90 of the 95 ASCII glyphs are
// byte-identical to it, and the five that differ (`` ` ``, `f`, `v`, `|`, `~`)
// are one-pixel horizontal differences between the two ROM variants of this
// font. Two independently transcribed copies agreeing on 90 glyphs is the
// evidence that this is the font it claims to be.
//
// ## The data, and the bit order
//
// `VGA_8X16_HEX` is the ROM's own format: **16 bytes per glyph, one byte per
// scanline, MSB leftmost**. `decode()` is the single place that bit order is
// interpreted, so there is exactly one chance to get it wrong — and the evidence
// it is right is that `'A'` decodes to
//
//     00 00 10 38 6C C6 C6 FE C6 C6 C6 C6 00 00 00 00
//
// which is what every published table gives for the VGA capital A.
//
// ## Why the cell is 9 wide when the glyph is 8
//
// The ROM glyphs fill all eight columns — **67 of the 95** ASCII glyphs have ink
// in column 0 — because VGA text mode's 80-column cell is *nine* dots wide (720
// pixels across 80 columns) and the hardware supplies the ninth as spacing.
// Drawn at an 8-pixel advance on a shared atlas, one glyph's column 0 would sit
// against its neighbour's column 7 and characters would touch; that is precisely
// the defect the previous hand-authored table avoided by staying narrow, at the
// cost of letterforms that were cramped and, in places, wrong.
//
// So a cell here is `ROWS x COLS` = 16 x 9: the ROM's 8 columns plus one blank
// spacing column. That is the font as the hardware draws it. It is also what
// makes the spacing rule below — *the last column is empty* — true for every
// glyph, which is the property that guarantees two characters can never touch.
//
// ## Metrics
//
//     row 0-1    leading; marks only ( $ ^ ` ' " reach here )
//     row 2      ascenders (b d f h k l t) and cap height (A-Z, 0-9)
//     row 5      x-height
//     row 11     **the baseline** — the bottom row of every cap, digit and
//                x-height letter
//     row 12-14  descenders (g j p q y), the comma and semicolon tails, and Q's
//
// These are the ROM font's own metrics, not ones this file invented, and
// `assertMetrics` refuses the table if any of them stops holding. A glyph with
// the wrong row count is refused at load rather than drawn short, because a font
// table is exactly the kind of data where one missing row shifts every glyph
// after it on the atlas.
//
// ## Why a bitmap and not a TTF
//
// There is no font rasterizer in this tree, Python is deliberately not a
// repository dependency (`scripts/gen-session.mjs` says so at length), and the
// 2D sampler is `Filter::Nearest` — so a bitmap cell scaled by an integer is
// *crisp* on screen, which is the whole reason bitmap fonts survive. A TTF would
// mean a new dependency, a rasterizer in the guest, and antialiased edges that
// nearest filtering would turn into mud.

/** Every glyph the viewer can draw, in cell order (ASCII 32..126), ROM bytes. */
const VGA_8X16_HEX = {
  ' ': '00000000000000000000000000000000',
  '!': '0000183c3c3c18181800181800000000',
  '"': '00666666240000000000000000000000',
  '#': '0000006c6cfe6c6c6cfe6c6c00000000',
  '$': '18187cc6c2c07c060686c67c18180000',
  '%': '00000000c2c60c183060c68600000000',
  '&': '0000386c6c3876dccccccc7600000000',
  '\'': '00303030600000000000000000000000',
  '(': '00000c18303030303030180c00000000',
  ')': '000030180c0c0c0c0c0c183000000000',
  '*': '0000000000663cff3c66000000000000',
  '+': '000000000018187e1818000000000000',
  ',': '00000000000000000018181830000000',
  '-': '00000000000000fe0000000000000000',
  '.': '00000000000000000000181800000000',
  '/': '0000000002060c183060c08000000000',
  '0': '0000386cc6c6d6d6c6c66c3800000000',
  '1': '00001838781818181818187e00000000',
  '2': '00007cc6060c183060c0c6fe00000000',
  '3': '00007cc606063c060606c67c00000000',
  '4': '00000c1c3c6cccfe0c0c0c1e00000000',
  '5': '0000fec0c0c0fc060606c67c00000000',
  '6': '00003860c0c0fcc6c6c6c67c00000000',
  '7': '0000fec606060c183030303000000000',
  '8': '00007cc6c6c67cc6c6c6c67c00000000',
  '9': '00007cc6c6c67e0606060c7800000000',
  ':': '00000000181800000018180000000000',
  ';': '00000000181800000018183000000000',
  '<': '000000060c18306030180c0600000000',
  '=': '00000000007e00007e00000000000000',
  '>': '0000006030180c060c18306000000000',
  '?': '00007cc6c60c18181800181800000000',
  '@': '0000007cc6c6dedededcc07c00000000',
  'A': '000010386cc6c6fec6c6c6c600000000',
  'B': '0000fc6666667c66666666fc00000000',
  'C': '00003c66c2c0c0c0c0c2663c00000000',
  'D': '0000f86c6666666666666cf800000000',
  'E': '0000fe6662687868606266fe00000000',
  'F': '0000fe6662687868606060f000000000',
  'G': '00003c66c2c0c0dec6c6663a00000000',
  'H': '0000c6c6c6c6fec6c6c6c6c600000000',
  'I': '00003c18181818181818183c00000000',
  'J': '00001e0c0c0c0c0ccccccc7800000000',
  'K': '0000e666666c78786c6666e600000000',
  'L': '0000f06060606060606266fe00000000',
  'M': '0000c6eefefed6c6c6c6c6c600000000',
  'N': '0000c6e6f6fedecec6c6c6c600000000',
  'O': '00007cc6c6c6c6c6c6c6c67c00000000',
  'P': '0000fc6666667c60606060f000000000',
  'Q': '00007cc6c6c6c6c6c6d6de7c0c0e0000',
  'R': '0000fc6666667c6c666666e600000000',
  'S': '00007cc6c660380c06c6c67c00000000',
  'T': '00007e7e5a1818181818183c00000000',
  'U': '0000c6c6c6c6c6c6c6c6c67c00000000',
  'V': '0000c6c6c6c6c6c6c66c381000000000',
  'W': '0000c6c6c6c6d6d6d6feee6c00000000',
  'X': '0000c6c66c7c38387c6cc6c600000000',
  'Y': '0000666666663c181818183c00000000',
  'Z': '0000fec6860c183060c2c6fe00000000',
  '[': '00003c30303030303030303c00000000',
  '\\': '00000080c0e070381c0e060200000000',
  ']': '00003c0c0c0c0c0c0c0c0c3c00000000',
  '^': '10386cc6000000000000000000000000',
  '_': '00000000000000000000000000ff0000',
  '`': '30301800000000000000000000000000',
  'a': '0000000000780c7ccccccc7600000000',
  'b': '0000e06060786c666666667c00000000',
  'c': '00000000007cc6c0c0c0c67c00000000',
  'd': '00001c0c0c3c6ccccccccc7600000000',
  'e': '00000000007cc6fec0c0c67c00000000',
  'f': '0000386c6460f060606060f000000000',
  'g': '000000000076cccccccccc7c0ccc7800',
  'h': '0000e060606c7666666666e600000000',
  'i': '00001818003818181818183c00000000',
  'j': '00000606000e06060606060666663c00',
  'k': '0000e06060666c78786c66e600000000',
  'l': '00003818181818181818183c00000000',
  'm': '0000000000ecfed6d6d6d6c600000000',
  'n': '0000000000dc66666666666600000000',
  'o': '00000000007cc6c6c6c6c67c00000000',
  'p': '0000000000dc66666666667c6060f000',
  'q': '000000000076cccccccccc7c0c0c1e00',
  'r': '0000000000dc7666606060f000000000',
  's': '00000000007cc660380cc67c00000000',
  't': '0000103030fc30303030361c00000000',
  'u': '0000000000cccccccccccc7600000000',
  'v': '000000000066666666663c1800000000',
  'w': '0000000000c6c6d6d6d6fe6c00000000',
  'x': '0000000000c66c3838386cc600000000',
  'y': '0000000000c6c6c6c6c6c67e060cf800',
  'z': '0000000000fecc183060c6fe00000000',
  '{': '00000e18181870181818180e00000000',
  '|': '00001818181800181818181800000000',
  '}': '0000701818180e181818187000000000',
  '~': '000076dc000000000000000000000000',
};

/** Scanlines per glyph, and the ROM's own glyph width in bytes. */
const ROWS = 16;
const ROM_COLS = 8;

/**
 * The **cell** width: the ROM's 8 columns plus one spacing column.
 *
 * The spacing column is not padding added for looks — it is the ninth dot VGA
 * text mode's 80-column cell has, and the reason the ROM glyphs are free to use
 * all eight of their own columns. See the header.
 */
const COLS = ROM_COLS + 1;

/**
 * Where the baseline sits, so layout arithmetic and this table cannot disagree.
 *
 * The viewer positions a line by its baseline, which makes these numbers layout
 * constants rather than font trivia. They are declared here, above the table, so
 * `assertMetrics` can enforce them as the table is built — and re-exported
 * through `assets/ui.json` for anything that draws from the other side.
 */
export const BASELINE_ROW = 11;
/** The row ascenders (`b d f h k l t`) and capitals both start on. This font
 *  draws them the same height, which is part of why it reads as a system font
 *  rather than a typeface. */
export const ASCENT_ROW = 2;
/** Rows below the baseline a descender may occupy: `g` and `y` reach row 14,
 *  one row further than the previous hand-authored table allowed. */
export const DESCENT_ROWS = 3;

/** Glyphs whose ink legitimately sits above the ascender row: currency bar and
 *  the four top marks. Everything else must start at `ASCENT_ROW` or below. */
const MARKS_ABOVE = '$^`\'"';
/** Lowercase letters that occupy the x-height band. */
const X_HEIGHT = 'acemnorsuvwxz';
/** Lowercase letters whose stem reaches the ascender row. */
const ASCENDERS = 'bdfhklt';
/** Lowercase letters that hang below the baseline. */
const DESCENDERS = 'gjpqy';
/** Capitals and digits, which occupy the cap band. `Q`'s tail is allowed one
 *  row past the baseline, which is the only exception and is in the ROM. */
const CAPITALS = 'ABCDEFGHIJKLMNOPQRSTUVWXYZ0123456789';

/**
 * One glyph's 16 ROM bytes, MSB leftmost, expanded into a `ROWS x COLS` mask.
 *
 * The ninth (spacing) column is left zero. This is the only reader of the ROM's
 * bit order, and `'A'` decoding to `00 00 10 38 6C C6 C6 FE C6 C6 C6 C6` is
 * what says it is right.
 */
function decode(hex, char) {
  if (hex.length !== ROWS * 2) {
    throw new Error(`font8x16: '${char}' is ${hex.length / 2} bytes, expected ${ROWS}`);
  }
  const mask = new Uint8Array(ROWS * COLS);
  for (let y = 0; y < ROWS; y++) {
    const byte = parseInt(hex.slice(y * 2, y * 2 + 2), 16);
    if (Number.isNaN(byte)) throw new Error(`font8x16: '${char}' row ${y} is not a byte: ${hex}`);
    // **MSB is the leftmost pixel.** Bit 7 is column 0; bit 0 would put the
    // glyph in a mirror, which looks plausible on symmetric letters and wrong on
    // every other one.
    for (let x = 0; x < ROM_COLS; x++) {
      mask[y * COLS + x] = (byte >> (7 - x)) & 1;
    }
  }
  return mask;
}

/**
 * The glyph table, decoded and validated.
 *
 * `index` is the character's code minus 32, which is also its position in the
 * atlas stripe: the viewer converts a character to a cell with one subtraction
 * and no lookup table.
 */
export const GLYPHS = (() => {
  const chars = Object.keys(VGA_8X16_HEX);
  if (chars.length !== 95) {
    throw new Error(`font8x16: ${chars.length} glyphs defined, 95 required (ASCII 32..126)`);
  }

  const glyphs = [];
  for (let code = 32; code <= 126; code++) {
    const ch = String.fromCharCode(code);
    const hex = VGA_8X16_HEX[ch];
    if (!hex) throw new Error(`font8x16: no glyph for ${JSON.stringify(ch)} (U+${code.toString(16)})`);
    glyphs.push({ char: ch, code, index: code - 32, mask: decode(hex, ch) });
  }
  assertMetrics(glyphs);
  return glyphs;
})();

/** Every row and column a glyph touches, or `null` for a blank glyph. */
function inkBounds(mask) {
  let top = -1, bottom = -1, left = COLS, right = -1;
  for (let y = 0; y < ROWS; y++) {
    for (let x = 0; x < COLS; x++) {
      if (!mask[y * COLS + x]) continue;
      if (top < 0) top = y;
      bottom = y;
      if (x < left) left = x;
      if (x > right) right = x;
    }
  }
  return top < 0 ? null : { top, bottom, left, right };
}

/**
 * Refuse a glyph table that breaks the metrics this file documents.
 *
 * Two kinds of claim, and the difference matters:
 *
 *   * **Vertical metrics** are this font's own — where the baseline, the
 *     ascender row and the descender depth are. They came from the ROM and any
 *     drift means the wrong font was substituted.
 *   * **The spacing column must be empty.** That one rule is what guarantees two
 *     adjacent characters can never touch, since cell N's ink ends at column 7
 *     and cell N+1's spacing column is 8. It is checked here for the source
 *     table and again in `make-font.mjs` for the baked bytes.
 *
 * A failure names the glyph and the row, because the useful part of this error
 * is *which* letter moved — a font is data, and a data error without a
 * coordinate is a scavenger hunt.
 */
function assertMetrics(glyphs) {
  const problems = [];
  const fail = (ch, why) => problems.push(`'${ch}': ${why}`);

  for (const { char: ch, mask } of glyphs) {
    const b = inkBounds(mask);
    if (b === null) {
      // The space is legitimately blank, and so is any other blank cell — but a
      // *visible* character with no ink would be a bug worth knowing about.
      if (ch !== ' ') fail(ch, 'has no ink at all');
      continue;
    }

    if (b.right === COLS - 1) fail(ch, 'ink in the spacing column, so it would touch the next character');
    if (b.top < ASCENT_ROW && !MARKS_ABOVE.includes(ch)) {
      fail(ch, `ink at row ${b.top}, above the ascent row ${ASCENT_ROW}`);
    }
    if (b.bottom > BASELINE_ROW + DESCENT_ROWS) {
      fail(ch, `ink at row ${b.bottom}, below the descent ${BASELINE_ROW + DESCENT_ROWS}`);
    }

    if (CAPITALS.includes(ch)) {
      const capBottom = ch === 'Q' ? BASELINE_ROW + 2 : BASELINE_ROW;
      if (b.bottom !== capBottom) fail(ch, `cap/digit bottom row ${b.bottom}, expected ${capBottom}`);
    }
    if (X_HEIGHT.includes(ch) && b.bottom !== BASELINE_ROW) {
      fail(ch, `x-height bottom row ${b.bottom}, baseline is ${BASELINE_ROW}`);
    }
    if (X_HEIGHT.includes(ch) && b.top !== 5) {
      fail(ch, `x-height top row ${b.top}, expected 5`);
    }
    if (ASCENDERS.includes(ch)) {
      if (b.top !== ASCENT_ROW) fail(ch, `ascender top row ${b.top}, ascent is ${ASCENT_ROW}`);
      if (b.bottom !== BASELINE_ROW) fail(ch, `ascender bottom row ${b.bottom}, baseline is ${BASELINE_ROW}`);
    }
    if (DESCENDERS.includes(ch) && b.bottom !== BASELINE_ROW + DESCENT_ROWS) {
      fail(ch, `descender bottom row ${b.bottom}, expected ${BASELINE_ROW + DESCENT_ROWS}`);
    }
  }

  if (problems.length) {
    throw new Error('font8x16: the glyph table breaks its own metrics:\n  ' +
      problems.join('\n  '));
  }
}

/** Look a character up, or `null` when the font has no glyph for it. */
export function glyphFor(ch) {
  const code = ch.codePointAt(0);
  if (code < 32 || code > 126) return null;
  return GLYPHS[code - 32];
}

export { ROWS, COLS, ROM_COLS };
