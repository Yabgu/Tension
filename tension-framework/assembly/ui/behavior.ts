// Widget behaviors: the open half of the layout engine.
//
// ## Why this is an interface and not a `switch`
//
// The engine used to dispatch on a `Kind` integer: `measureSelf` was a chain of
// `if (k == Kind.Button)` and `paintSelf` another. That is **closed** — a docking
// layout, an icon button, or a divider that drags differently had no way in except
// by editing the engine, which means every new control is a framework change and
// every framework change is a re-test of every control.
//
// So a widget is a **slot in the pool** plus a **behavior object** that decides how
// that slot measures, arranges, paints and handles input. The engine walks the
// tree and owns the invariants (dirty flags, clipping, culling, cost accounting);
// the behavior owns the one thing that differs per widget. Adding a control is
// now `ui.node(parent, new DockLayout())`, and the engine does not learn its name.
//
// ## Behaviors are stateless; the tree holds the state
//
// A built-in behavior is a **shared singleton**: one `RowBehavior` arranges every
// row in the tree. That works because nothing is stored on the behavior — the
// geometry, the style, the text and the interaction state all live in the tree's
// parallel arrays, keyed by slot. The behavior is a *function of (tree, slot)*.
//
// A custom behavior may hold its own state (`new DockLayout()` per widget), and
// then it must be constructed per widget — which is exactly what `ui.node` with an
// instance gives you. The two styles coexist because the interface only ever sees
// a slot.
//
// ## The contract with the engine
//
//     measure(ui, id)          → write the widget's size (ui.setSize)
//     arrange(ui, id, x,y,w,h) → place the children (ui.setRect); `x,y,w,h` are the
//                                rectangle the parent already gave this widget
//     paint(ui, id, p)         → emit records and hit targets (p.addHit)
//     handle(ui, id, ev)       → true to consume the event
//
// The engine calls all four and expects nothing else. It clears the dirty flags
// itself, decides visibility, pushes clips, and skips subtrees out of the viewport;
// a behavior that tried to do any of that would be doing it twice.
//
// **What a behavior may touch.** `ui.tree` is public — the arrays are the widget
// state, and hiding them behind forty accessors would make a custom control
// unreadable. What the engine reserves is the *invariants*: use `ui.setSize` so the
// size floors apply, `ui.setRect` so geometry stays in one place, and `p.addHit` so
// a target is clipped exactly like the record beside it. Writing `tree.w[id]`
// directly is allowed and occasionally right; skipping the floor is not.

import { Ui, WidgetBehavior } from "./builder";
import { UiEvent, UiEventKind, WHEEL_STEP } from "./event-def";
import { Chrome, FontPage } from "./fonts";
import {
  Align, Axis, DIVIDER_GRAB, DIVIDER_PX, FIELD_MIN_W, KIND_NONE, Kind, ListSource,
  RULE_H, SLIDER_MAX, SLIDER_MIN_W, SLIDER_THUMB_H, SLIDER_THUMB_W, State, WidgetTree,
} from "./layout";
import { Painter } from "./painter";
import { MUTED } from "./theme";
import { TextBuffer, TextPool } from "./text";

// ── helpers every behavior shares ────────────────────────────────────────────

/** A row/column's content width: children plus gaps plus padding. */
export function contentW(t: WidgetTree, i: i32): i32 {
  const pad: i32 = t.pad[i];
  const horizontal: bool = t.kind[i] == Kind.Row;
  let sum: i32 = 0;
  let cross: i32 = 0;
  let n: i32 = 0;
  let c: i32 = t.firstChild[i];
  while (c >= 0) {
    // A hidden child takes no space: its parent measures as if it were not there,
    // which is what lets a flex sibling grow into a collapsed panel's place.
    if (t.hidden[c]) {
      c = t.nextSibling[c];
      continue;
    }
    if (horizontal) {
      sum += t.w[c];
      if (t.h[c] > cross) cross = t.h[c];
    } else {
      if (t.w[c] > cross) cross = t.w[c];
    }
    n++;
    c = t.nextSibling[c];
  }
  if (horizontal) {
    const gaps: i32 = n > 1 ? t.gap[i] * (n - 1) : 0;
    return sum + gaps + 2 * pad;
  }
  return cross + 2 * pad;
}

/** The same on the other axis. */
export function contentH(t: WidgetTree, i: i32): i32 {
  const pad: i32 = t.pad[i];
  const horizontal: bool = t.kind[i] == Kind.Row;
  let sum: i32 = 0;
  let cross: i32 = 0;
  let n: i32 = 0;
  let c: i32 = t.firstChild[i];
  while (c >= 0) {
    if (t.hidden[c]) {
      c = t.nextSibling[c];
      continue;
    }
    if (horizontal) {
      if (t.h[c] > cross) cross = t.h[c];
    } else {
      sum += t.h[c];
      if (t.w[c] > cross) cross = t.w[c];
    }
    n++;
    c = t.nextSibling[c];
  }
  if (horizontal) return cross + 2 * pad;
  const gaps: i32 = n > 1 ? t.gap[i] * (n - 1) : 0;
  return sum + gaps + 2 * pad;
}

/** Cross-axis placement for a row: `y` inside `[top, top+height)`. */
export function placeCross(t: WidgetTree, c: i32, top: i32, height: i32): void {
  const a: i32 = t.align[c];
  if (a == Align.Stretch) {
    t.y[c] = top;
    t.h[c] = height > 0 ? height : 0;
    return;
  }
  const ch: i32 = t.h[c];
  if (a == Align.Center) t.y[c] = top + (height - ch) / 2;
  else if (a == Align.End) t.y[c] = top + height - ch;
  else t.y[c] = top;
}

/** Cross-axis placement for a column: `x` inside `[left, left+width)`. */
export function placeCrossY(t: WidgetTree, c: i32, left: i32, width: i32): void {
  const a: i32 = t.align[c];
  if (a == Align.Stretch) {
    t.x[c] = left;
    t.w[c] = width > 0 ? width : 0;
    return;
  }
  const cw: i32 = t.w[c];
  if (a == Align.Center) t.x[c] = left + (width - cw) / 2;
  else if (a == Align.End) t.x[c] = left + width - cw;
  else t.x[c] = left;
}

/**
 * The pixel width of the first `n` bytes of a widget's text.
 *
 * The painter's own arithmetic, byte for byte: a tab is four spaces, a control byte
 * is one, and everything else is its own advance, accumulated in quarter-pixels and
 * rounded once. Shared by the selection block, the caret and the click-to-caret hit
 * test so the three cannot disagree about where a byte sits.
 */
export function advanceTo(ui: Ui, id: i32, n: i32): i32 {
  const b: TextBuffer = ui.tree.bufferOf(id);
  if (n <= 0) return 0;
  const limit: i32 = n < b.len ? n : b.len;
  const page: FontPage = ui.tree.page[id];
  const weight: i32 = ui.tree.weight[id];
  const spaceQ: i32 = page.advanceQ(weight, 32);
  let q: i32 = 0;
  for (let k: i32 = 0; k < limit; k++) {
    const code: i32 = b.bytes[k];
    if (code == 9) {
      q += spaceQ * 4;
      continue;
    }
    if (code < 32) {
      q += spaceQ;
      continue;
    }
    q += page.advanceQ(weight, code);
  }
  return (q + 3) / 4;
}

/**
 * The two panes of a split, skipping hidden ones.
 *
 * A split is defined as "two children", but which two is the tree's answer, not
 * the slot's: collapsing one pane (play mode collapses the sidebar) must leave the
 * remaining pane filling the split rather than leaving the split arranging a
 * zero-width rect at a stale position.
 */
function paneOf(t: WidgetTree, i: i32, second: bool): i32 {
  let c: i32 = t.firstChild[i];
  let seen: i32 = 0;
  while (c >= 0) {
    if (!t.hidden[c]) {
      if (!second && seen == 0) return c;
      if (second && seen == 1) return c;
      seen++;
    }
    c = t.nextSibling[c];
  }
  return -1;
}

/** Where a widget's text starts inside its own box, for its `textAlign`. */
export function alignedTextX(ui: Ui, id: i32, x: i32, w: i32): i32 {
  const t: WidgetTree = ui.tree;
  const tw: i32 = t.textW[id];
  const a: i32 = t.textAlign[id];
  if (a == Align.Center) return x + (w - tw) / 2;
  if (a == Align.End) return x + w - tw;
  return x;
}

/** One widget's glyphs, clipped to `x,y,w,h`. */
export function paintText(ui: Ui, id: i32, p: Painter, x: i32, y: i32, w: i32, h: i32,
                          disabled: bool): void {
  const t: WidgetTree = ui.tree;
  const b: TextBuffer = t.bufferOf(id);
  if (b.len <= 0 || w <= 0 || h <= 0) return;
  const colour: i32 = disabled ? MUTED : t.colour[id];
  p.pushClip(x, y, w, h);
  p.textBytes(b.bytes, 0, b.len, x, y, colour, t.weight[id], 0, y, y + h, t.page[id]);
  p.popClip();
}

/** The state bits, unpacked once per paint. */
class Look {
  disabled: bool = false;
  hovered: bool = false;
  pressed: bool = false;
  focused: bool = false;

  read(state: i32): void {
    this.disabled = (state & State.Disabled) != 0;
    this.hovered = (state & State.Hover) != 0;
    this.pressed = (state & State.Press) != 0;
    this.focused = (state & State.Focus) != 0;
  }
}

// ── containers ───────────────────────────────────────────────────────────────

/**
 * The tree's single root.
 *
 * Measured by nobody: its rectangle is the window's and `WidgetTree.resize` owns it,
 * because a root that measured itself from its content would refuse to shrink below
 * it. It arranges like a column, so the usual child is one `column(flex: 1)`.
 */
export class RootBehavior implements WidgetBehavior {
  measure(ui: Ui, id: i32): void {}

  arrange(ui: Ui, id: i32, x: i32, y: i32, w: i32, h: i32): void {
    placeColumn(ui.tree, id, x, y, w, h);
  }

  paint(ui: Ui, id: i32, p: Painter): void {}

  handle(ui: Ui, id: i32, ev: UiEvent): bool {
    return false;
  }
}

/** A vertical flex container. */
export class ColumnBehavior implements WidgetBehavior {
  measure(ui: Ui, id: i32): void {
    const t: WidgetTree = ui.tree;
    t.w[id] = contentW(t, id);
    t.h[id] = contentH(t, id);
    ui.applyFloors(id);
  }

  arrange(ui: Ui, id: i32, x: i32, y: i32, w: i32, h: i32): void {
    placeColumn(ui.tree, id, x, y, w, h);
  }

  paint(ui: Ui, id: i32, p: Painter): void {}

  handle(ui: Ui, id: i32, ev: UiEvent): bool {
    return false;
  }
}

/** A horizontal flex container: the transpose of `ColumnBehavior`. */
export class RowBehavior implements WidgetBehavior {
  measure(ui: Ui, id: i32): void {
    const t: WidgetTree = ui.tree;
    t.w[id] = contentW(t, id);
    t.h[id] = contentH(t, id);
    ui.applyFloors(id);
  }

  arrange(ui: Ui, id: i32, x: i32, y: i32, w: i32, h: i32): void {
    placeRow(ui.tree, id, x, y, w, h);
  }

  paint(ui: Ui, id: i32, p: Painter): void {}

  handle(ui: Ui, id: i32, ev: UiEvent): bool {
    return false;
  }
}

/**
 * The flex rule, exactly, in one place for both axes.
 *
 * `inner = w - 2*pad - gap*(n-1)` is what the children share. A child with
 * `flex == 0` keeps its measured width along the main axis; the rest split
 * `free = inner - fixed`.
 *
 * Every flex child but the **last** gets `free * flex / flexTotal` — integer
 * division, floored. The last gets `free - given`, the residual. That is not a
 * rounding refinement, it is what makes the container *exactly* as wide as it says:
 * distributing a remainder after the fact is the same arithmetic with two more
 * places for it to drift, and a one-pixel gap at the end of a toolbar is visible as
 * a stripe. A child claiming a share smaller than its floor is floored, and the last
 * flex child absorbs the difference.
 */
function placeMain(t: WidgetTree, i: i32, horizontal: bool): void {
  const pad: i32 = t.pad[i];
  const gap: i32 = t.gap[i];
  const innerX: i32 = t.x[i] + pad;
  const innerY: i32 = t.y[i] + pad;
  const innerW: i32 = t.w[i] - 2 * pad;
  const innerH: i32 = t.h[i] - 2 * pad;

  let n: i32 = 0;
  let fixed: i32 = 0;
  let flexTotal: i32 = 0;
  let lastFlex: i32 = -1;
  let c: i32 = t.firstChild[i];
  while (c >= 0) {
    // Hidden children are out of the flow: no space, no gap, no placement. The gap
    // arithmetic counts `n` *after* this skip, so collapsing the middle child of a
    // three-child row does not leave a stray gap behind it.
    if (t.hidden[c]) {
      c = t.nextSibling[c];
      continue;
    }
    n++;
    if (t.flex[c] > 0) {
      flexTotal += t.flex[c];
      lastFlex = c;
    } else {
      fixed += horizontal ? t.w[c] : t.h[c];
    }
    c = t.nextSibling[c];
  }

  const gaps: i32 = n > 1 ? gap * (n - 1) : 0;
  let avail: i32 = (horizontal ? innerW : innerH) - gaps;
  if (avail < 0) avail = 0;
  let free: i32 = avail - fixed;
  if (free < 0) free = 0;

  let given: i32 = 0;
  let cursor: i32 = horizontal ? innerX : innerY;
  c = t.firstChild[i];
  while (c >= 0) {
    if (t.hidden[c]) {
      c = t.nextSibling[c];
      continue;
    }
    let main: i32 = horizontal ? t.w[c] : t.h[c];
    const fl: i32 = t.flex[c];
    if (fl > 0) {
      main = c == lastFlex ? free - given : free * fl / flexTotal;
      const floor: i32 = horizontal ? t.minW[c] : t.minH[c];
      if (main < floor) main = floor;
      given += main;
    }
    if (horizontal) {
      t.x[c] = cursor;
      t.w[c] = main;
      placeCross(t, c, innerY, innerH);
    } else {
      t.y[c] = cursor;
      t.h[c] = main;
      placeCrossY(t, c, innerX, innerW);
    }
    cursor += main + gap;
    c = t.nextSibling[c];
  }
}

function placeRow(t: WidgetTree, i: i32, x: i32, y: i32, w: i32, h: i32): void {
  placeMain(t, i, true);
}

function placeColumn(t: WidgetTree, i: i32, x: i32, y: i32, w: i32, h: i32): void {
  placeMain(t, i, false);
}

/**
 * Two panes and a divider the user drags.
 *
 * `splitPx` is the divider's position from the content edge, and it is **state**:
 * clamped at the start of every arrange, not only when a drag moves it. That is what
 * makes the pane survive a resize — a window narrowed past the smaller pane's floor
 * would otherwise leave the divider outside the frame, and a drag handler would be
 * asked to fix a number the layout had already invalidated.
 *
 * `arrange` also runs on a frame where nothing was dragged, for the same reason: the
 * clamp is part of the layout, not part of the gesture.
 */
export class SplitPaneBehavior implements WidgetBehavior {
  measure(ui: Ui, id: i32): void {
    const t: WidgetTree = ui.tree;
    const pad: i32 = t.pad[id];
    const a: i32 = paneOf(t, id, false);
    const b: i32 = a >= 0 ? paneOf(t, id, true) : -1;
    if (a < 0 || b < 0) {
      // One pane (or none): the split measures to its own floor and the arrange
      // gives the survivor the whole rectangle.
      t.w[id] = 2 * pad;
      t.h[id] = 2 * pad;
      ui.applyFloors(id);
      return;
    }
    const div: i32 = t.gap[id] > 0 ? t.gap[id] : DIVIDER_PX;
    if (t.axis[id] == Axis.X) {
      t.w[id] = t.w[a] + t.w[b] + div + 2 * pad;
      t.h[id] = (t.h[a] > t.h[b] ? t.h[a] : t.h[b]) + 2 * pad;
    } else {
      t.w[id] = (t.w[a] > t.w[b] ? t.w[a] : t.w[b]) + 2 * pad;
      t.h[id] = t.h[a] + t.h[b] + div + 2 * pad;
    }
    ui.applyFloors(id);
  }

  arrange(ui: Ui, id: i32, x: i32, y: i32, w: i32, h: i32): void {
    const t: WidgetTree = ui.tree;
    const a: i32 = paneOf(t, id, false);
    const b: i32 = a >= 0 ? paneOf(t, id, true) : -1;
    if (a < 0) return;
    const pad: i32 = t.pad[id];
    if (b < 0) {
      // A collapsed pane: the survivor takes the whole content box, and the
      // divider is not drawn at all (there is nothing to separate).
      ui.setRect(a, x + pad, y + pad, w - 2 * pad, h - 2 * pad);
      return;
    }
    const div: i32 = t.gap[id] > 0 ? t.gap[id] : DIVIDER_PX;
    const innerX: i32 = x + pad;
    const innerY: i32 = y + pad;
    const innerW: i32 = w - 2 * pad;
    const innerH: i32 = h - 2 * pad;
    const horizontal: bool = t.axis[id] == Axis.X;

    const total: i32 = horizontal ? innerW : innerH;
    let content: i32 = total - div;
    if (content < 0) content = 0;

    const minA: i32 = horizontal ? t.minW[a] : t.minH[a];
    const minB: i32 = horizontal ? t.minW[b] : t.minH[b];
    const lo: i32 = minA > 0 ? minA : 0;
    let hi: i32 = content - (minB > 0 ? minB : 0);
    if (hi < lo) hi = lo;    // narrower than both floors: the left floor wins

    let sp: i32 = t.splitPx[id];
    if (sp < 0) sp = content / 2;
    if (sp < lo) sp = lo;
    if (sp > hi) sp = hi;
    if (sp < 0) sp = 0;
    t.splitPx[id] = sp;

    const rest: i32 = content - sp > 0 ? content - sp : 0;
    if (horizontal) {
      ui.setRect(a, innerX, innerY, sp, innerH);
      ui.setRect(b, innerX + sp + div, innerY, rest, innerH);
    } else {
      ui.setRect(a, innerX, innerY, innerW, sp);
      ui.setRect(b, innerX, innerY + sp + div, innerW, rest);
    }
  }

  paint(ui: Ui, id: i32, p: Painter): void {
    const t: WidgetTree = ui.tree;
    const a: i32 = paneOf(t, id, false);
    const b: i32 = a >= 0 ? paneOf(t, id, true) : -1;
    if (a < 0 || b < 0) return;
    const div: i32 = t.gap[id] > 0 ? t.gap[id] : DIVIDER_PX;
    const pad: i32 = t.pad[id];
    const page: FontPage = t.page[id];
    const x: i32 = t.x[id];
    const y: i32 = t.y[id];
    const w: i32 = t.w[id];
    const h: i32 = t.h[id];
    const look = new Look();
    look.read(t.state[id]);

    // **Hover and press are visible, because a 4-px hairline with no feedback
    // reads as a painted line rather than as a handle.** The colour is the whole
    // vocabulary this toolkit has (no tint, no radius): divider at rest, thumb
    // grey on hover, white while dragging.
    const cell: i32 = look.pressed ? Chrome.White
      : (look.hovered ? Chrome.Thumb : Chrome.Divider);

    // The drawn rule stays exactly as wide as it is; the *target* is widened by
    // DIVIDER_GRAB each way, because a 4-px hairline is not a thing to aim at.
    // Widening the pixels instead would move the panes.
    if (t.axis[id] == Axis.X) {
      const dx: i32 = t.x[a] + t.w[a];
      p.fill(dx, y + pad, div, h - 2 * pad, page.chromeCell(cell), page);
      p.addHit(dx - DIVIDER_GRAB, y, div + 2 * DIVIDER_GRAB, h, t.id[id], id);
    } else {
      const dy: i32 = t.y[a] + t.h[a];
      p.fill(x + pad, dy, w - 2 * pad, div, page.chromeCell(cell), page);
      p.addHit(x, dy - DIVIDER_GRAB, w, div + 2 * DIVIDER_GRAB, t.id[id], id);
    }
  }

  /**
   * The drag is the behavior's, not the engine's.
   *
   * `ui.capture(id)` on the press is what makes the gesture survive the pointer
   * leaving the divider's 4-px band: the band decides *who grabbed it*, capture
   * decides *who keeps it*. Without it a drag dies the moment the pointer outruns
   * the layout, which is the usual way a hand-written divider fails.
   */
  handle(ui: Ui, id: i32, ev: UiEvent): bool {
    const t: WidgetTree = ui.tree;
    if (ev.kind == UiEventKind.Click) {
      ui.capture(id);
      return true;
    }
    if (ev.kind == UiEventKind.Release) {
      ui.release();
      return true;
    }
    if (ev.kind == UiEventKind.Drag) {
      const d: i32 = t.axis[id] == Axis.X ? ev.dx : ev.dy;
      if (d != 0) {
        // Arrange clamps it; this only keeps the number in i32 range across a drag.
        t.splitPx[id] += d;
        t.reflowSubtree(id);
      }
      return true;
    }
    return false;
  }
}

// ── leaves ───────────────────────────────────────────────────────────────────

/** One line of text, measured from its advance table. */
export class LabelBehavior implements WidgetBehavior {
  measure(ui: Ui, id: i32): void {
    const t: WidgetTree = ui.tree;
    const tw: i32 = ui.measureOwnText(id);
    t.textW[id] = tw;
    t.w[id] = tw;
    t.h[id] = t.page[id].lineStep;
    ui.applyFloors(id);
  }

  arrange(ui: Ui, id: i32, x: i32, y: i32, w: i32, h: i32): void {}

  paint(ui: Ui, id: i32, p: Painter): void {
    const t: WidgetTree = ui.tree;
    const x: i32 = t.x[id];
    const y: i32 = t.y[id];
    const w: i32 = t.w[id];
    const h: i32 = t.h[id];
    const look = new Look();
    look.read(t.state[id]);
    // A recycled list row is clickable and a plain label is not: the row exists to
    // be picked, and a caption exists to be read. Being clickable is also what
    // earns it a hover background — a list of words with no response to the pointer
    // gives the user no way to know the rows are targets at all.
    const row: bool = t.itemIndex[id] >= 0;
    if ((row || t.clickable[id]) && (look.hovered || look.pressed)) {
      p.fill(x, y, w, h, t.page[id].chromeCell(Chrome.Surface), t.page[id]);
    }
    const tx: i32 = alignedTextX(ui, id, x, w);
    paintText(ui, id, p, tx, y, w - (tx - x), h, look.disabled);
    // A list row is a target by definition; a merely *clickable* label has its hit
    // recorded by the engine (`WidgetTree.paintAt`), so it is not doubled here.
    if (row) p.addHit(x, y, w, h, t.id[id], id);
  }

  handle(ui: Ui, id: i32, ev: UiEvent): bool {
    return false;
  }
}

/**
 * A filled box with a bright edge and a centred label.
 *
 * Three states, three edges — at this size there is no radius, no shadow and no
 * colour to darken, so the edge is the whole vocabulary: top when idle, bottom when
 * pressed, both when hovered or focused.
 */
export class ButtonBehavior implements WidgetBehavior {
  measure(ui: Ui, id: i32): void {
    const t: WidgetTree = ui.tree;
    const pad: i32 = t.pad[id];
    const tw: i32 = ui.measureOwnText(id);
    t.textW[id] = tw;
    t.w[id] = tw + 2 * pad;
    t.h[id] = t.page[id].lineStep + 2 * pad;
    ui.applyFloors(id);
  }

  arrange(ui: Ui, id: i32, x: i32, y: i32, w: i32, h: i32): void {}

  paint(ui: Ui, id: i32, p: Painter): void {
    const t: WidgetTree = ui.tree;
    const page: FontPage = t.page[id];
    const x: i32 = t.x[id];
    const y: i32 = t.y[id];
    const w: i32 = t.w[id];
    const h: i32 = t.h[id];
    const look = new Look();
    look.read(t.state[id]);

    p.fill(x, y, w, h,
           page.chromeCell(look.disabled ? Chrome.Track : Chrome.Selection), page);
    if (look.pressed) {
      p.fill(x, y + h - 1, w, 1, page.chromeCell(Chrome.White), page);
    } else {
      p.fill(x, y, w, 1, page.chromeCell(Chrome.White), page);
      if (look.hovered || look.focused) {
        p.fill(x, y + h - 1, w, 1, page.chromeCell(Chrome.White), page);
      }
    }
    const tw: i32 = t.textW[id];
    paintText(ui, id, p, x + (w - tw) / 2, y + (h - page.lineStep) / 2, tw,
              page.lineStep, look.disabled);
    p.addHit(x, y, w, h, t.id[id], id);
  }

  /**
   * A button is a click target, so it consumes the press.
   *
   * The *closure* fires first (see `Dispatcher.bubble`), so `ui.onClick(btn, cb)`
   * runs and then this consumes — which is why a button inside a row never hands
   * its click to the row. With no closure registered the consumption is still
   * right: a button with nothing wired to it should not click the panel behind it.
   */
  handle(ui: Ui, id: i32, ev: UiEvent): bool {
    if (ev.kind == UiEventKind.Click) return true;
    return false;
  }
}

/**
 * An editable field: a surface, an underline, its selection, its glyphs, its caret.
 *
 * Drawn in that order because each is behind the next — a selection is a background
 * for the glyphs it covers, and the caret is a 1-px rule that belongs on top. The
 * selection is **one** fill from the low boundary to the high one rather than a fill
 * per glyph: both boundaries come from `advanceTo`, so the block edges match the
 * glyph edges exactly, and a hundred selected characters cost one record.
 */
export class TextFieldBehavior implements WidgetBehavior {
  measure(ui: Ui, id: i32): void {
    const t: WidgetTree = ui.tree;
    t.textW[id] = ui.measureOwnText(id);
    // A field's intrinsic width is a floor, not a measurement: its text is the
    // *content*, and content that grows a field's box makes a form that jumps while
    // you type — the caret would move out from under the pointer.
    t.w[id] = t.minW[id] > 0 ? t.minW[id] : FIELD_MIN_W;
    t.h[id] = t.page[id].lineStep + 2 * t.pad[id];
    ui.applyFloors(id);
  }

  arrange(ui: Ui, id: i32, x: i32, y: i32, w: i32, h: i32): void {}

  paint(ui: Ui, id: i32, p: Painter): void {
    const t: WidgetTree = ui.tree;
    const page: FontPage = t.page[id];
    const x: i32 = t.x[id];
    const y: i32 = t.y[id];
    const w: i32 = t.w[id];
    const h: i32 = t.h[id];
    const pad: i32 = t.pad[id];
    const look = new Look();
    look.read(t.state[id]);
    const tx: i32 = x + pad;
    const tw: i32 = w - 2 * pad;
    if (tw <= 0 || h <= 0) return;

    p.fill(x, y, w, h, page.chromeCell(Chrome.Surface), page);
    p.fill(x, y + h - 1, w, 1,
           page.chromeCell(look.focused ? Chrome.White : Chrome.Underline), page);

    p.pushClip(tx, y, tw, h);

    const b: TextBuffer = t.bufferOf(id);
    if (b.len > 0) {
      const lo: i32 = t.selectionLo(id);
      const hi: i32 = t.selectionHi(id);
      if (hi > lo) {
        const sx: i32 = tx + advanceTo(ui, id, lo);
        const ex: i32 = tx + advanceTo(ui, id, hi);
        p.fill(sx, y + 1, ex - sx, h - 2, page.chromeCell(Chrome.Selection), page);
      }
      p.textBytes(b.bytes, 0, b.len, tx, y, look.disabled ? MUTED : t.colour[id],
                  t.weight[id], 0, y, y + h, page);
    }

    if (look.focused && !look.disabled) {
      const cx: i32 = tx + advanceTo(ui, id, t.caretOf(id));
      p.fill(cx, y + 1, 1, h - 2, page.chromeCell(Chrome.Caret), page);
    }

    p.popClip();
    p.addHit(x, y, w, h, t.id[id], id);
  }

  /** A click places the caret and consumes; keys and typed text edit. */
  handle(ui: Ui, id: i32, ev: UiEvent): bool {
    const t: WidgetTree = ui.tree;
    if ((t.state[id] & State.Disabled) != 0) return false;

    // **Focus puts the caret at the end.** Tabbing into a field whose caret sat at
    // 0 made the first typed character land *before* the existing value — the kind
    // of bug that reads as "the field is broken". A click still places the caret
    // where it landed, because a click is a position and a Tab is not.
    if (ev.kind == UiEventKind.Focus) {
      t.setCaret(id, t.textLength(id));
      return true;
    }

    if (ev.kind == UiEventKind.Click) {
      t.shiftHeld = ev.shift;
      t.caretAtX(id, ev.localX);
      return true;
    }

    if (ev.kind == UiEventKind.Text) {
      ui.insertTyped(id);
      ui.fireChange(id, -1);
      return true;
    }

    if (ev.kind == UiEventKind.Key) {
      t.shiftHeld = ev.shift;
      let changed: bool = false;
      if (ev.value == SCAN_BACKSPACE) changed = t.backspace(id);
      else if (ev.value == SCAN_DELETE) changed = t.deleteForward(id);
      else if (ev.value == SCAN_LEFT) t.moveCaret(id, -1, ev.shift);
      else if (ev.value == SCAN_RIGHT) t.moveCaret(id, 1, ev.shift);
      else if (ev.value == SCAN_HOME) t.setCaret(id, 0);
      else if (ev.value == SCAN_END) t.setCaret(id, t.textLength(id));
      // Return is the field's *commit*, not the app's: a form's Enter belongs to
      // the form, and the widget that knows it is a text field is this one. The
      // registered `ui.onSubmit` target hears it; with none, nothing happens.
      else if (ev.value == SCAN_RETURN || ev.value == SCAN_KP_ENTER) {
        ui.fireSubmit(id);
        return true;
      }
      else return false;
      if (changed) ui.fireChange(id, -1);
      return true;
    }
    return false;
  }
}

/** Empty space that claims `flex` shares of what is left. */
export class SpacerBehavior implements WidgetBehavior {
  measure(ui: Ui, id: i32): void {
    const t: WidgetTree = ui.tree;
    t.textW[id] = 0;
    t.w[id] = 0;
    t.h[id] = 0;
  }

  arrange(ui: Ui, id: i32, x: i32, y: i32, w: i32, h: i32): void {}
  paint(ui: Ui, id: i32, p: Painter): void {}
  handle(ui: Ui, id: i32, ev: UiEvent): bool {
    return false;
  }
}

/** A one-pixel horizontal rule. */
export class RuleBehavior implements WidgetBehavior {
  measure(ui: Ui, id: i32): void {
    const t: WidgetTree = ui.tree;
    t.w[id] = 0;
    t.h[id] = RULE_H;
    ui.applyFloors(id);
  }

  arrange(ui: Ui, id: i32, x: i32, y: i32, w: i32, h: i32): void {}

  paint(ui: Ui, id: i32, p: Painter): void {
    const t: WidgetTree = ui.tree;
    p.hline(t.x[id], t.y[id], t.w[id], t.page[id].chromeCell(Chrome.Divider), t.page[id]);
  }

  handle(ui: Ui, id: i32, ev: UiEvent): bool {
    return false;
  }
}

/**
 * A track and a thumb over a fixed-point value.
 *
 * The thumb maps the pointer's **position** absolutely, not by deltas: a thumb
 * moved only by deltas drifts out of step with its track after one dropped frame.
 */
export class SliderBehavior implements WidgetBehavior {
  measure(ui: Ui, id: i32): void {
    const t: WidgetTree = ui.tree;
    const page: FontPage = t.page[id];
    t.w[id] = t.minW[id] > 0 ? t.minW[id] : SLIDER_MIN_W;
    t.h[id] = page.lineStep > t.minH[id] ? page.lineStep : t.minH[id];
    ui.applyFloors(id);
  }

  arrange(ui: Ui, id: i32, x: i32, y: i32, w: i32, h: i32): void {}

  paint(ui: Ui, id: i32, p: Painter): void {
    const t: WidgetTree = ui.tree;
    const page: FontPage = t.page[id];
    const x: i32 = t.x[id];
    const y: i32 = t.y[id];
    const w: i32 = t.w[id];
    const h: i32 = t.h[id];
    const look = new Look();
    look.read(t.state[id]);

    const cy: i32 = y + (h - 2) / 2;
    p.fill(x, cy, w, 2,
           page.chromeCell(look.disabled ? Chrome.Track : Chrome.Divider), page);
    const span: i32 = w - SLIDER_THUMB_W;
    const tx: i32 = span > 0 ? x + t.value[id] * span / SLIDER_MAX : x;
    p.fill(tx, y + (h - SLIDER_THUMB_H) / 2, SLIDER_THUMB_W, SLIDER_THUMB_H,
           page.chromeCell(Chrome.Thumb), page);
    p.addHit(x, y, w, h, t.id[id], id);
  }

  handle(ui: Ui, id: i32, ev: UiEvent): bool {
    const t: WidgetTree = ui.tree;
    if ((t.state[id] & State.Disabled) != 0) return false;
    if (ev.kind == UiEventKind.Click) {
      ui.capture(id);
      this.fromPointer(ui, id, ev.x);
      return true;
    }
    if (ev.kind == UiEventKind.Release) {
      ui.release();
      return true;
    }
    if (ev.kind == UiEventKind.Drag) {
      this.fromPointer(ui, id, ev.x);
      return true;
    }
    return false;
  }

  /** Point the slider at a tree-space x, clamped to the track. */
  private fromPointer(ui: Ui, id: i32, x: i32): void {
    const t: WidgetTree = ui.tree;
    const tw: i32 = t.w[id] - 2 * t.pad[id];
    if (tw <= 0) return;
    let local: i32 = x - (t.x[id] + t.pad[id]);
    if (local < 0) local = 0;
    if (local > tw) local = tw;
    const v: i32 = local * SLIDER_MAX / tw;
    if (v == t.value[id]) return;
    t.value[id] = v;
    t.markPaint(id);
    ui.fireChange(id, v);
  }
}

/**
 * A virtualised list: recycled row widgets over a scrolling window.
 *
 * A thousand-item list cannot be a thousand widgets, so the list owns a fixed set of
 * **row widgets** and re-points them at item indices as it scrolls. What is arranged
 * is the rows (`n`), what is painted is the visible subset of them, and both stay
 * bounded by the window rather than by the data.
 *
 * The clipping is the engine's (`WidgetTree.clipsChildren`), not this behavior's:
 * arrange intersects the clip for this subtree and paint pushes it, so a row that
 * scrolled out is culled rather than drawn and then clipped. That is what makes
 * scrolling a list **not** re-arrange its parent — `reflowSubtree` walks only this
 * subtree, from the clip it last had.
 */
export class ListBehavior implements WidgetBehavior {
  measure(ui: Ui, id: i32): void {
    const t: WidgetTree = ui.tree;
    // A scroller's size is the window onto its content, never the content: a list
    // measuring itself from `itemCount` would be a thousand rows tall.
    t.w[id] = t.minW[id] > 0 ? t.minW[id] : 0;
    t.h[id] = t.minH[id] > 0 ? t.minH[id] : 0;
    if (t.itemH[id] <= 0) t.itemH[id] = t.page[id].lineStep;
    ui.applyFloors(id);
  }

  arrange(ui: Ui, id: i32, x: i32, y: i32, w: i32, h: i32): void {
    const t: WidgetTree = ui.tree;
    const pad: i32 = t.pad[id];
    const innerX: i32 = x + pad;
    const innerY: i32 = y + pad;
    const innerW: i32 = w - 2 * pad;
    const innerH: i32 = h - 2 * pad;
    const ih: i32 = t.itemH[id] > 0 ? t.itemH[id] : t.page[id].lineStep;
    t.itemH[id] = ih;
    const count: i32 = t.itemCount[id];

    // Clamp the scroll to the content. `contentH` is the data's height — rows are a
    // window onto it, so the clamp is on the *state*, and the next drag starts from
    // a legal number.
    const contentH: i32 = count * ih;
    let maxScroll: i32 = contentH - (innerH > 0 ? innerH : 0);
    if (maxScroll < 0) maxScroll = 0;
    let sy: i32 = t.scrollY[id];
    if (sy < 0) sy = 0;
    if (sy > maxScroll) sy = maxScroll;
    t.scrollY[id] = sy;

    // Row `floor(sy/ih)` is the one containing the window's top edge: row `i` spans
    // `[i*ih - sy, (i+1)*ih - sy)`, so no extra row above is needed — and backing
    // off one would put a widget entirely out of view.
    const first: i32 = ih > 0 ? sy / ih : 0;
    t.rowFirst[id] = first;

    const src: ListSource = t.source[id];
    const hasModel: bool = t.hasSource(id);
    const pool: TextPool = t.texts;
    let row: i32 = t.firstChild[id];
    let k: i32 = 0;
    while (row >= 0) {
      const index: i32 = count > 0 ? first + k : -1;
      if (index < 0 || index >= count) {
        // No item here: a zero rect, so it is culled, paints nothing and records no
        // hit — the same rule a scrolled-out row gets, by the same code.
        ui.setRect(row, innerX, innerY, 0, 0);
        t.itemIndex[row] = -1;
      } else {
        ui.setRect(row, innerX, innerY + index * ih - sy, innerW > 0 ? innerW : 0, ih);
        if (t.itemIndex[row] != index) {
          t.itemIndex[row] = index;
          // Only a row whose index changed is refilled, and only when there is a
          // model: a caller that sets row text itself keeps what it wrote.
          if (hasModel) {
            pool.next();
            src.text(index, pool);
            t.setTextSpan(row, pool);
          }
        }
      }
      row = t.nextSibling[row];
      k++;
    }
  }

  paint(ui: Ui, id: i32, p: Painter): void {
    // Nothing of its own: a list is a window, and black is the background. It
    // records no hit either — a click in the empty space below the last row is not
    // a click on a row.
  }

  /** The wheel scrolls the list under the pointer, through the bubble. */
  handle(ui: Ui, id: i32, ev: UiEvent): bool {
    if (ev.kind != UiEventKind.Wheel) return false;
    ui.scrollList(id, -ev.value * WHEEL_STEP);
    return true;
  }
}

// The scancodes this file needs, duplicated from `events.ts` to keep the import
// one-way: `events.ts` imports behaviors, so behaviors must not import it.
const SCAN_BACKSPACE: i32 = 42;
const SCAN_DELETE: i32 = 76;
const SCAN_RETURN: i32 = 40;
const SCAN_KP_ENTER: i32 = 88;
const SCAN_RIGHT: i32 = 79;
const SCAN_LEFT: i32 = 80;
const SCAN_HOME: i32 = 74;
const SCAN_END: i32 = 77;

/**
 * The built-in behaviors, indexed by `Kind`.
 *
 * Constructed **by `Ui`**, not at module load: this module imports `Ui` for its
 * type and `builder.ts` imports this one for its classes, so a module-level array of
 * instances here would be a use-before-init waiting for a load order to change.
 * Building it in the constructor makes the order explicit and testable.
 */
export function builtinBehaviors(): WidgetBehavior[] {
  const out = new Array<WidgetBehavior>(Kind.Custom + 1);
  out[Kind.Root] = new RootBehavior();
  out[Kind.Row] = new RowBehavior();
  out[Kind.Column] = new ColumnBehavior();
  out[Kind.Split] = new SplitPaneBehavior();
  out[Kind.Label] = new LabelBehavior();
  out[Kind.Button] = new ButtonBehavior();
  out[Kind.TextField] = new TextFieldBehavior();
  out[Kind.Spacer] = new SpacerBehavior();
  out[Kind.Rule] = new RuleBehavior();
  out[Kind.List] = new ListBehavior();
  out[Kind.Slider] = new SliderBehavior();
  out[Kind.Custom] = new SpacerBehavior();   // never dispatched: set per widget
  return out;
}

/**
 * A behavior that does nothing, for a slot the engine has not been told about.
 *
 * Not a null: a null in the `behavior` array means every pass has to check, and the
 * one place that forgets is a trap. Doing nothing is the correct answer for an
 * unassigned slot anyway.
 */
export class NullBehavior implements WidgetBehavior {
  measure(ui: Ui, id: i32): void {}
  arrange(ui: Ui, id: i32, x: i32, y: i32, w: i32, h: i32): void {}
  paint(ui: Ui, id: i32, p: Painter): void {}
  handle(ui: Ui, id: i32, ev: UiEvent): bool {
    return false;
  }
}
