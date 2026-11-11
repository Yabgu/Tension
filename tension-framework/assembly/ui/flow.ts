// Where a line ends: measuring, wrapping, and the vertical rhythm.
//
// ## Why wrapping is arithmetic and not a measurement loop
//
// The font is monospace — a glyph advances by `advance` whatever it is, because
// the atlas has one cell size and no kerning table (`theme.ts`). So "how many
// characters fit in `pixels`" is a division, and a break is a scan back to a
// space. Nothing here measures a glyph, and nothing here allocates.
//
// ## Why this is separate from the painter
//
// A painter that also broke lines would break a line the layout had already
// placed — the bug that produced orphaned words twenty pixels low when a
// paragraph's source newlines reached `Painter.text`. So the split is absolute:
// this file decides *where* a line starts and how long it is; `Painter.text`
// draws exactly the span it is given.

import { CELL_H, CELL_W, DEFAULT_THEME } from "./theme";

/** One line of body text, in pixels: the cell plus air between lines. */
export const LINE_STEP: i32 = CELL_H + 8;

/**
 * The narrowest column a layout will draw.
 *
 * A window dragged almost shut would otherwise compute a column of zero or fewer
 * characters; every wrap loop assumes `cols > 0` and would divide by it or emit a
 * zero-length line forever.
 */
export const MIN_COLS: i32 = 8;

/** A padding in source pixels, scaled with the font. */
export function px(n: i32): i32 {
  return n * DEFAULT_THEME.scale;
}

/** How many characters fit in `pixels` at `advance`. */
export function columnsFor(pixels: i32, advance: i32 = CELL_W): i32 {
  return pixels / advance;
}

/**
 * The break width for a byte range, honouring word boundaries.
 *
 * Returns the number of characters from `start` that belong on the line, never
 * exceeding `maxCols`, and preferring to break at a space. A single word longer
 * than the line is broken mid-word rather than overflowing — a URL in a code
 * sample is the case, and spilling outside the pane would paint over the panel
 * beside it.
 */
export function breakAt(ptr: usize, start: i32, end: i32, maxCols: i32): i32 {
  const limit: i32 = start + maxCols;
  if (limit >= end) return end - start;

  // Walk back to the last space at or before the limit.
  for (let i: i32 = limit; i > start; i--) {
    if (load<u8>(ptr + <usize>i) == 32) return i - start;
  }
  return maxCols;
}

/**
 * The same, over a byte array — what a layout that flattened its text has.
 *
 * The rule is one comparison, and it is worth stating exactly, because the
 * obvious alternatives are both wrong:
 *
 *   * **The candidate line is `chars[start .. limit)`, where `limit = start +
 *     cols`.** So a line may hold exactly `cols` characters; index `limit` is
 *     the first one that does not fit.
 *   * **Breaking at a space returns `i - start`, which excludes the space.** The
 *     caller then skips the spaces it lands on, so a break never leaves a
 *     leading space on the next line and never counts the space twice.
 *   * **A space at `limit` itself is a valid break.** It yields `cols`, the
 *     widest line that fits, and the space moves to the next line to be skipped.
 *     Rejecting it — scanning from `limit - 1` — would shorten every line by up
 *     to one word for no reason.
 */
export function breakLine(chars: Uint8Array, start: i32, end: i32, cols: i32): i32 {
  const limit: i32 = start + cols;
  if (limit >= end) {
    // Trim a trailing space so a single-line paragraph does not carry one.
    let n: i32 = end - start;
    while (n > 0 && chars[start + n - 1] == 32) n--;
    return n;
  }
  for (let i: i32 = limit; i > start; i--) {
    if (chars[i] == 32) return i - start;
  }
  return cols;
}

/**
 * The text column for a pane: as many columns as fit, capped, and centred.
 *
 * The whole of a responsive text layout, in five lines of arithmetic. `cap` exists
 * twice over — readability (prose wider than ~80 characters is hard to track) and
 * the record budget (a glyph is a record, so a line's cost is its column count).
 *
 * Returns the column count; the caller takes the x from `centred`.
 */
export function fitColumns(paneWidth: i32, padding: i32, capCols: i32,
                           advance: i32 = CELL_W): i32 {
  const available: i32 = paneWidth - padding * 2;
  const capped: i32 = capCols * advance;
  let textPx: i32 = available < capped ? available : capped;
  if (textPx < MIN_COLS * advance) textPx = MIN_COLS * advance;
  return textPx / advance;
}

/**
 * Where a column of `cols` characters starts inside a pane: centred, but never
 * nearer than `leastInset` to the pane's own start (a narrow window would
 * otherwise put text against the divider).
 */
export function centred(paneX: i32, paneWidth: i32, cols: i32, leastInset: i32,
                        advance: i32 = CELL_W): i32 {
  const used: i32 = cols * advance;
  let x: i32 = paneX + (paneWidth - used) / 2;
  const least: i32 = paneX + leastInset;
  if (x < least) x = least;
  return x;
}
