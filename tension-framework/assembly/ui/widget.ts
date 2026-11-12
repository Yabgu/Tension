// The four things every panel is made of: a label, a rule, a box, a button.
//
// Deliberately small. A toolkit that grows a retained widget tree before anything
// uses one is a toolkit whose API is a guess; these are the shapes the
// documentation viewer already drew by hand, factored so the editor draws the same
// ones rather than a second set that drifts.
//
// Everything here draws immediately, into a `Painter`, and records its click
// target through `Painter.addHit` at the moment it draws (`hit.ts` explains why
// that ordering is the mechanism, and why the painter owns the clip gate). Nothing
// allocates per frame — text is bytes and a span, not a `String`.
//
// This module is the **immediate-mode** half of the toolkit: the two apps in this
// tree draw with it, and it stays for as long as they do. A panel that wants
// retained geometry uses the tree in `layout.ts`/`builder.ts` instead.

import { Painter } from "./painter";
import { LINE_STEP, px } from "./flow";
import {
  BOLD, CELL_H, CELL_W, CHROME_DIVIDER, CHROME_SELECTION, CHROME_SURFACE, CHROME_WHITE,
  HEADING, MUTED, NORMAL, REGULAR,
} from "./theme";

/** The target ids a shell hands back from `Hits.at`, for the shared widgets. */
export const HIT_NONE: i32 = 0;

/**
 * One line of text at `(x, y)`, clipped vertically to `[clipTop, clipBottom)`.
 *
 * `advance` is the step, not the size: a heading passes `CELL_W + 3 * scale` for
 * letter-spacing.
 */
export function drawLabel(p: Painter, chars: Uint8Array, start: i32, len: i32, x: i32, y: i32,
                      colour: i32 = NORMAL, weight: i32 = REGULAR,
                      advance: i32 = CELL_W, clipTop: i32 = -0x7FFFFFFF,
                      clipBottom: i32 = 0x7FFFFFFF): i32 {
  return p.textBytes(chars, start, len, x, y, colour, weight, advance, clipTop, clipBottom);
}

/** The same, for a string already in memory — used for static UI words. */
export function drawText(p: Painter, value: string, x: i32, y: i32, colour: i32 = NORMAL,
                     weight: i32 = REGULAR, advance: i32 = CELL_W,
                     clipTop: i32 = -0x7FFFFFFF, clipBottom: i32 = 0x7FFFFFFF): i32 {
  const bytes = Uint8Array.wrap(String.UTF8.encode(value, false));
  return p.textBytes(bytes, 0, i32(bytes.length), x, y, colour, weight, advance,
                     clipTop, clipBottom);
}

/** A one-pixel horizontal rule across `w` at `y`. */
export function rule(p: Painter, x: i32, y: i32, w: i32, cell: i32 = CHROME_DIVIDER): void {
  p.hline(x, y, w, cell);
}

/** A one-pixel vertical rule down `h` at `x`. */
export function vrule(p: Painter, x: i32, y: i32, h: i32, cell: i32 = CHROME_DIVIDER): void {
  p.vline(x, y, h, cell);
}

/**
 * A button: a filled box, a bright top edge, and a centred label.
 *
 * The three lines are the documentation viewer's Run button, which is the only
 * button in the tree that has been looked at by a person — so the shape is
 * measured rather than invented. `pressed` swaps the top edge for a bright
 * bottom one, which is the whole of a pressed state at this size: there is no
 * border radius, no shadow, and no colour to darken (the atlas has five).
 *
 * Returns the rectangle it used, so a caller that wants a *different* hit shape
 * from the drawn one has it. Usually the caller passes the rect to `Hits.add`.
 */
export function button(p: Painter, x: i32, y: i32, w: i32, h: i32, chars: Uint8Array,
                       start: i32, len: i32, advance: i32 = CELL_W,
                       pressed: bool = false): void {
  p.fill(x, y, w, h, CHROME_SELECTION);
  if (pressed) p.fill(x, y + h - px(1), w, px(1), CHROME_WHITE);
  else p.fill(x, y, w, px(1), CHROME_WHITE);

  const textW: i32 = len * advance;
  const textX: i32 = x + (w - textW) / 2;
  const textY: i32 = y + (h - CELL_H) / 2;
  p.textBytes(chars, start, len, textX, textY, HEADING, REGULAR, advance,
              y, y + h);
}

/** A button whose label is a `String`; same shape, for menus and dialogs. */
export function textButton(p: Painter, x: i32, y: i32, w: i32, h: i32, value: string,
                           advance: i32 = CELL_W, pressed: bool = false): void {
  const bytes = Uint8Array.wrap(String.UTF8.encode(value, false));
  button(p, x, y, w, h, bytes, 0, i32(bytes.length), advance, pressed);
}

/**
 * A row that acts like a list item: its label, its indent, and its hit target.
 *
 * `selected` underlines rather than fills — a filled row at this size is a block
 * of colour the same weight as the panel behind it, and the underline reads as
 * "this one" without competing with the text.
 *
 * ## The fixed bug, and why the record moved
 *
 * This function used to take a `Hits` and call `hits.add` **twice**: once on the
 * early return for a row outside the caller's vertical clip, and once at the end.
 * The early return is the defect — a row scrolled out of a pane still recorded its
 * target, so a click in the empty space where it used to be selected it, and a
 * scrolled-out row could steal a click from the row that replaced it.
 *
 * The record now comes from `Painter.addHit`, which intersects with the painter's
 * **own** clip and records nothing when the intersection is empty. So there is no
 * parameter to pass and no early return to get wrong: the target is whatever part
 * of the row the painter would actually have drawn, which is the only rectangle
 * the user can point at. `Hits` is no longer a parameter here for that reason.
 */
export function listItem(p: Painter, chars: Uint8Array, start: i32, len: i32,
                         x: i32, y: i32, width: i32, id: i32, tag: i32 = -1,
                         colour: i32 = NORMAL, weight: i32 = REGULAR,
                         selected: bool = false, clipTop: i32 = -0x7FFFFFFF,
                         clipBottom: i32 = 0x7FFFFFFF): void {
  const step: i32 = LINE_STEP;
  if (y + step >= clipTop && y < clipBottom) {
    p.textBytes(chars, start, len, x, y, colour, weight, CELL_W, clipTop, clipBottom);
    if (selected) p.hline(x, y + CELL_H, width, CHROME_WHITE);
  }
  // After the draw, and gated by the painter's clip — the same rule the tree uses.
  p.addHit(x, y, width, step, id, tag);
}

/**
 * A panel's frame: a background only when the caller can afford it, plus rules.
 *
 * `Painter.fill` is tiled, so a full-window background at 1280x720 is ~4,000
 * records — the entire frame budget. A panel therefore draws its *edges* unless it
 * is small, and this helper makes that decision once instead of in every caller:
 * a `surface` is filled only when its tile cost is under `budget`.
 */
export function panel(p: Painter, x: i32, y: i32, w: i32, h: i32, budget: i32 = 240,
                      cell: i32 = CHROME_SURFACE): void {
  if (w <= 0 || h <= 0) return;
  const cols: i32 = (w + CELL_W - 1) / CELL_W;
  const rows: i32 = (h + CELL_H - 1) / CELL_H;
  if (cols * rows <= budget) p.fill(x, y, w, h, cell);
  p.hline(x, y, w, CHROME_DIVIDER);
  p.hline(x, y + h - 1, w, CHROME_DIVIDER);
}

/** A section heading: the label, a wider advance, and a rule under it. */
export function heading(p: Painter, value: string, x: i32, y: i32, w: i32): void {
  drawText(p, value, x, y, MUTED, BOLD, CELL_W + px(1));
  p.hline(x, y + CELL_H + px(4), w, CHROME_DIVIDER);
}
