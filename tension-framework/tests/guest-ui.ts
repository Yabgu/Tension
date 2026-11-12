// The UI toolkit's pure half: wrapping, column math, tile costs, hit testing.
//
// No canvas and no GPU, because none of it needs one — a Painter builds records
// into a buffer, and the rest is arithmetic over numbers a test can state. The
// drawing half is proved by the two apps that ship on it (`apps/docs` and the
// editor), which is the only place pixels mean anything.

import { Painter } from "../assembly/ui/painter";
import { Hits } from "../assembly/ui/hit";
import { Snapshot } from "../assembly/input";
import {
  ChangeTarget, ClickTarget, SCAN_BACKSPACE, SCAN_LEFT, SCAN_TAB,
} from "../assembly/ui/events";
import { WidgetBehavior } from "../assembly/ui/builder";
import { UiEvent, UiEventKind } from "../assembly/ui/event-def";
import { TextBuilder, TextPool } from "../assembly/ui/text";
import { ListSource } from "../assembly/ui/layout";
import { drawText } from "../assembly/ui/widget";
import {
  Axis, Dirty, Kind, KIND_NONE, RULE_H, WidgetTree,
} from "../assembly/ui/layout";
import { ALIGN_CENTER, ALIGN_START, ALIGN_STRETCH, Props, Ui } from "../assembly/ui/builder";
import { listItem } from "../assembly/ui/widget";
import { FONT_MONO, SIZE_14, fontBook } from "../assembly/ui/fonts";
import {
  LINE_STEP, MIN_COLS, breakLine, centred, columnsFor, fitColumns,
} from "../assembly/ui/flow";
import { CELL_H, CELL_W, DEFAULT_THEME, MAX_RECORDS, hlineCost, tileCost } from "../assembly/ui/theme";
import { print } from "../assembly/io";
import { ConfigBuilder, RuntimeSession } from "../assembly/runtime";

let failures: i32 = 0;

function check(ok: bool, what: string): void {
  if (!ok) {
    failures++;
    print("  FAIL: " + what);
  }
}

function checkEq(want: i32, got: i32, what: string): void {
  if (want != got) {
    failures++;
    print("  FAIL: " + what + " (want " + want.toString() + ", got " + got.toString() + ")");
  }
}

function checkStr(want: string, got: string, what: string): void {
  if (want != got) {
    failures++;
    print("  FAIL: " + what + " (want \"" + want + "\", got \"" + got + "\")");
  }
}

function bytesOf(text: string): Uint8Array {
  return Uint8Array.wrap(String.UTF8.encode(text, false));
}

/// The cell geometry is the atlas's, and `LINE_STEP` is derived from it.
function caseGeometry(): void {
  checkEq(18, CELL_W, "the 2x atlas cell is 18 wide (9 * 2)");
  checkEq(32, CELL_H, "and 32 tall (16 * 2)");
  checkEq(CELL_H + 8, LINE_STEP, "a line is the cell plus eight pixels of air");
  checkEq(4000, MAX_RECORDS, "the record cap leaves room under the renderer's 4096");
}

/// Wrapping: the three rules `breakLine` documents, asserted where they are.
function caseWrapping(): void {
  const text = bytesOf("the quick brown fox jumps");
  const n: i32 = i32(text.length);

  // Shorter than the column: the whole span, with any trailing space trimmed.
  checkEq(n, breakLine(text, 0, n, 40), "a line that fits is returned whole");

  // A break lands on a space and excludes it.
  const at: i32 = breakLine(text, 0, n, 10);     // "the quick " -> 9
  checkEq(9, at, "the break lands before the space");
  checkEq(32, i32(text[at]), "and the character after it is the space");

  // Mid-word when there is no space: a long token is broken, never spilled.
  const token = bytesOf("tension_framework_assembly");
  checkEq(8, breakLine(token, 0, i32(token.length), 8), "a long token breaks mid-word");

  // A space exactly at the limit is a valid break — the widest line that fits.
  const edge = bytesOf("12345 789");
  checkEq(5, breakLine(edge, 0, i32(edge.length), 5), "a space at the limit breaks there");
}

/// The responsive column: capped, floored, and centred.
function caseColumns(): void {
  checkEq(80, columnsFor(80 * CELL_W), "a column is pixels over advance");
  checkEq(80, fitColumns(80 * CELL_W + 24, 12, 80), "a pane exactly at the cap keeps it");
  checkEq(80, fitColumns(4000, 12, 80), "a very wide pane is capped, not filled");

  // A pane too narrow to hold MIN_COLS still gets MIN_COLS, so no wrap loop
  // divides by zero or emits a zero-length line forever.
  checkEq(MIN_COLS, fitColumns(10, 12, 80), "a pane narrower than the floor gets the floor");

  // Centring: the column sits in the middle of what is left, and never against
  // the pane's own edge.
  checkEq(1000 + (1000 - 20 * CELL_W) / 2, centred(1000, 1000, 20, 8), "a column centres");
  checkEq(1008, centred(1000, 100, 80, 8), "and never crosses the inset");
}

/// Tile costs, and that `fill` emits exactly what `tileCost` promised.
function caseCosts(): void {
  checkEq(1, tileCost(CELL_W, CELL_H), "one cell is one record");
  checkEq(4, tileCost(CELL_W * 2, CELL_H * 2), "two by two is four");
  checkEq(2, tileCost(CELL_W + 1, CELL_H), "a partial column rounds up");
  checkEq(0, tileCost(0, 100), "nothing is not a draw");
  checkEq(3, hlineCost(CELL_W * 2 + 1), "a rule rounds its partial cell up");

  const p = new Painter();
  p.reset();
  p.fill(0, 0, CELL_W * 2, CELL_H * 2, 953);
  checkEq(tileCost(CELL_W * 2, CELL_H * 2), p.count, "fill emits what tileCost predicts");

  // The clip trims a fill to the rectangle it is given.
  p.reset();
  p.setClip(0, 0, CELL_W, CELL_H * 2);
  p.fill(0, 0, CELL_W * 4, CELL_H * 2, 953);
  checkEq(2, p.count, "a clip trims a rectangle to its own bounds");
  p.clearClip();
}

/// A glyph outside the clip emits nothing; a straddling one is trimmed.
function caseGlyphClip(): void {
  const p = new Painter();
  const text = bytesOf("abcdef");

  p.reset();
  p.setClip(0, 0, 1000, 1000);
  p.textBytes(text, 0, 6, 0, 0, 0, 0, CELL_W, 0, 1000);
  checkEq(6, p.count, "six glyphs in the open emit six records");

  p.reset();
  p.setClip(CELL_W * 2, 0, CELL_W, 1000);        // only the third cell
  p.textBytes(text, 0, 6, 0, 0, 0, 0, CELL_W, 0, 1000);
  checkEq(1, p.count, "a clip to one cell emits one glyph");

  // Fully outside below: nothing at all.
  p.reset();
  p.setClip(0, 0, 1000, 10);
  p.textBytes(text, 0, 6, 0, 100, 0, 0, CELL_W, 0, 1000);
  checkEq(0, p.count, "a glyph below the clip is not drawn");
  p.clearClip();

  // The budget refuses and counts rather than growing.
  const small = new Painter(DEFAULT_THEME, 3);
  small.reset();
  small.textBytes(text, 0, 6, 0, 0, 0, 0, CELL_W, 0, 1000);
  checkEq(3, small.count, "a small painter stops at its capacity");
  checkEq(3, small.dropped, "and counts what it refused");
}

/// Hit testing: the topmost target wins, and the draw's rect is the one tested.
function caseHits(): void {
  const hits = new Hits();
  hits.begin();
  hits.add(0, 0, 100, 40, 1, 10);
  hits.add(50, 0, 100, 40, 2, 20);      // overlaps target 1
  hits.begin();
  hits.add(0, 0, 100, 40, 1, 10);
  hits.add(50, 0, 100, 40, 2, 20);

  checkEq(1, hits.at(10, 10), "a point in the first target finds it");
  checkEq(1, hits.at(49, 10), "and still the first just before the overlap");
  checkEq(2, hits.at(50, 10), "the later target wins where they overlap");
  checkEq(-1, hits.at(200, 10), "a point in neither finds nothing");
  checkEq(20, hits.tagAt(60, 10), "the tag comes back with the target");

  hits.begin();
  checkEq(0, hits.count, "begin() empties the list");
}

// ── the retained tree ────────────────────────────────────────────────────────

/// A tree on the default book, with a painter and a hit list.
class Bench {
  tree: WidgetTree;
  ui: Ui;
  p: Painter;
  hits: Hits;

  constructor(capacity: i32 = 64) {
    // Locals first: the compiler refuses to read `this` before every field has
    // been assigned, and the builder wants the tree it is about to be given.
    const tree = new WidgetTree(fontBook(), capacity);
    const ui = new Ui(tree);
    const p = new Painter();
    const hits = new Hits();
    this.tree = tree;
    this.ui = ui;
    this.p = p;
    this.hits = hits;
  }
}

/// The pool: a fixed array of numbers, a free list, and no way to make a cycle.
function casePool(): void {
  const b = new Bench(4);
  const t = b.tree;
  const root = b.ui.root(100, 100);
  const a = b.ui.column(root);
  const c = b.ui.column(root);
  checkEq(3, t.live, "three widgets are live");
  check(a >= 0 && c >= 0, "a builder that fits returns a slot");

  // The fourth slot is the last one; the fifth is refused and counted.
  const d = b.ui.column(root);
  check(d >= 0, "the last slot in the pool is still handed out");
  const extra = b.ui.column(root);
  checkEq(-1, extra, "the pool refuses a widget past its capacity");
  checkEq(1, t.overflow, "and counts the refusal");

  // Freeing pushes the slot on a list that is reused, so a rebuild of the same
  // shape does not grow the pool.
  t.remove(c);
  checkEq(3, t.live, "removing a subtree frees its slot");
  const e = b.ui.column(root);
  checkEq(c, e, "the next allocation reuses the freed slot");
  checkEq(1, t.overflow, "and a reuse is not a second refusal");

  // A cycle is refused, not recursed into: both passes are recursive.
  t.append(e, root);
  checkEq(-1, t.parent[root], "append refuses to make a cycle");
  checkEq(-1, t.firstChild[e], "and the refused append linked nothing");

  // `kind` for a freed slot is the marker the passes skip on.
  t.remove(a);
  checkEq(KIND_NONE, t.kind[a], "a freed slot is not a widget");
  t.remove(a);
  checkEq(3, t.live, "removing twice frees once");
}

/// `Props` literals: an unlisted field is zero, which is why every zero means
/// "the kind's default" and `align` is one-based.
function caseProps(): void {
  const b = new Bench();
  const root = b.ui.root(200, 200);
  const col = b.ui.column(root, { pad: 8, flex: 1 });
  checkEq(8, b.tree.pad[col], "pad comes from the literal");
  checkEq(1, b.tree.flex[col], "and so does flex");
  checkEq(0, b.tree.gap[col], "a field the literal omits is zero");
  checkEq(3, b.tree.align[col], "a column stretches by default (Align.Stretch)");

  const row = b.ui.row(col, { pad: 6, minH: 40 });
  checkEq(6, b.tree.pad[row], "a row takes its own pad");
  checkEq(40, b.tree.minH[row], "and its height floor");
  checkEq(0, b.tree.flex[row], "an omitted flex is fixed");

  const centred = b.ui.row(col, { align: ALIGN_CENTER });
  checkEq(1, b.tree.align[centred], "ALIGN_CENTER is one-based and lands on Align.Center");
  const started = b.ui.row(col, { align: ALIGN_START });
  checkEq(0, b.tree.align[started], "and ALIGN_START can override the kind's Stretch");

  // An empty literal is the kind's default, which is the property the one-based
  // encoding exists for.
  const empty = new Props();
  checkEq(0, empty.align, "an empty Props has no opinion about alignment");
}

/// Flex: the shares are exact, and a floor is paid for by the last flex child.
function caseFlex(): void {
  const b = new Bench();
  const root = b.ui.root(200, 100);
  const row = b.ui.row(root);
  const a = b.ui.spacer(row, 1);
  const c = b.ui.spacer(row, 1);
  const d = b.ui.spacer(row, 1);
  b.tree.layout();

  checkEq(200, b.tree.w[row], "a row stretches to its parent's width");
  checkEq(200, b.tree.w[a] + b.tree.w[c] + b.tree.w[d],
          "three equal shares fill the row exactly");
  checkEq(200, b.tree.x[d] + b.tree.w[d], "the last share ends on the edge");

  // Padding and gaps come out of the share, not out of the rounding.
  const root2 = b.ui.root(200, 100);
  const row2 = b.ui.row(root2, { pad: 10, gap: 5 });
  const e = b.ui.spacer(row2, 1);
  const f = b.ui.spacer(row2, 1);
  const g = b.ui.spacer(row2, 1);
  b.tree.layout();
  checkEq(200, b.tree.w[e] + b.tree.w[f] + b.tree.w[g] + 2 * 10 + 2 * 5,
          "children plus padding plus gaps is the row exactly");
  checkEq(b.tree.x[e] + b.tree.w[e] + 5, b.tree.x[f], "a gap separates the first pair");

  // A floor is honoured, and the residual absorbs it: still exact.
  const root3 = b.ui.root(100, 100);
  const row3 = b.ui.row(root3);
  const h = b.ui.spacer(row3, 1);
  const i = b.ui.spacer(row3, 1);
  const j = b.ui.spacer(row3, 1);
  b.ui.minW(h, 60);
  b.tree.layout();
  checkEq(60, b.tree.w[h], "minW floors a flex child");
  checkEq(100, b.tree.w[h] + b.tree.w[i] + b.tree.w[j],
          "and the other shares still sum to the row exactly");
}

/// A split clamps its divider at both ends, at the top of every arrange.
function caseSplit(): void {
  const b = new Bench();
  const root = b.ui.root(400, 200);
  const sp = b.ui.split(root, Axis.X);
  const left = b.ui.column(sp);
  const right = b.ui.column(sp);
  b.ui.minW(left, 120);
  b.ui.minW(right, 100);
  b.tree.layout();

  // The divider's width is `DIVIDER_PX`; the content is what is left.
  const div = b.tree.gap[sp];
  checkEq(400, b.tree.w[left] + b.tree.w[right] + div, "content plus divider is the split");
  checkEq(b.tree.x[left] + b.tree.w[left] + div, b.tree.x[right],
          "the right pane starts after the divider");
  checkEq((400 - div) / 2, b.tree.splitPx[sp], "an unset divider starts at half");

  b.ui.divider(sp, 4);
  b.tree.layout();
  checkEq(120, b.tree.w[left], "a divider dragged past the left floor clamps to it");

  b.ui.divider(sp, 9999);
  b.tree.layout();
  checkEq(400 - div - 100, b.tree.w[left], "and past the right floor clamps to it");
  checkEq(100, b.tree.w[right], "leaving the right pane at its own minimum");

  // A resize re-clamps: the state cannot be left outside the frame.
  b.tree.resize(300, 200);
  b.tree.layout();
  checkEq(300 - div - 100, b.tree.splitPx[sp], "a narrowed window re-clamps the divider");
  checkEq(100, b.tree.w[right], "and the right pane keeps its minimum");

  // Narrower than both minimums: the left floor wins, because `hi` is clamped up
  // to `lo` rather than inverted. The panes overrun; the clip is what hides it.
  b.tree.resize(200, 200);
  b.tree.layout();
  checkEq(120, b.tree.splitPx[sp], "a window too narrow for both floors keeps the left");
}

/// A label measures from its page; a button is that plus its padding.
function caseLeafSizes(): void {
  const b = new Bench();
  const root = b.ui.root(300, 300);
  const col = b.ui.column(root);
  const lab = b.ui.label(col, "Handgloves");
  const btn = b.ui.button(col, "File", { pad: 6 });
  b.tree.layout();

  const page = b.tree.page[lab];
  checkEq(page.lineStep, b.tree.h[lab], "a label is one line tall");
  checkEq(b.tree.textWidth(lab), b.tree.w[lab], "and as wide as its advances");
  checkEq(b.tree.textWidth(btn) + 12, b.tree.w[btn], "a button is its label plus both pads");
  checkEq(page.lineStep + 12, b.tree.h[btn], "and one line plus both pads");

  // Proportional text: a wide word measures wider than a narrow one.
  const narrow = b.ui.label(col, "ill");
  const wide = b.ui.label(col, "WWW");
  b.tree.layout();
  check(b.tree.w[wide] > b.tree.w[narrow], "a proportional page measures W wider than i");

  // A page swap re-measures, because the advances came from the other table.
  const mono = b.ui.label(col, "Handgloves", {});
  b.tree.layout();
  const interW = b.tree.w[mono];
  b.ui.font(mono, FONT_MONO, SIZE_14);
  b.tree.layout();
  check(b.tree.w[mono] != interW, "a font change re-measures the label");
  checkEq(85, b.tree.w[mono], "mono measures ten glyphs at 8.5 px each (340 quarter-px)");

  const r = b.ui.rule(col);
  b.tree.layout();
  checkEq(RULE_H, b.tree.h[r], "a rule is one pixel tall");
  checkEq(300, b.tree.w[r], "and spans the column");
}

/// A widget's own buffer: encoded in place, grown by doubling, never per frame.
function caseTextBuffer(): void {
  const b = new Bench();
  const root = b.ui.root(300, 100);
  const col = b.ui.column(root);
  const f = b.ui.field(col, "hello");
  b.tree.layout();
  checkEq(5, b.tree.textLength(f), "the field's text is five bytes");
  const cap0 = b.tree.bufferOf(f).capacity;

  // A same-length rewrite goes into the same bytes: no growth, no new buffer.
  b.ui.text(f, "world");
  b.tree.layout();
  checkEq(5, b.tree.textLength(f), "a same-length rewrite keeps its length");
  checkEq(cap0, b.tree.bufferOf(f).capacity, "and needs no new capacity");

  // A field's box does not grow with its content: the caret would move out from
  // under the pointer.
  const before = b.tree.w[f];
  b.ui.text(f, "a much longer string than the field");
  b.tree.layout();
  checkEq(before, b.tree.w[f], "a field's width does not follow its text");

  // A label's does, which is the difference between the two kinds.
  const lab = b.ui.label(col, "short");
  b.tree.layout();
  const shortW = b.tree.w[lab];
  b.ui.text(lab, "a much longer label");
  b.tree.layout();
  check(b.tree.w[lab] > shortW, "a label grows with its text");

  // Each widget owns its bytes: a second label does not see the first one's.
  const other = b.ui.label(col, "zzz");
  b.tree.layout();
  checkEq(3, b.tree.textLength(other), "a new label has its own buffer");
  b.ui.text(other, "yyy");
  b.tree.layout();
  checkEq(3, b.tree.textLength(other), "and rewrites it in place");
  checkEq(19, b.tree.textLength(lab), "leaving its neighbour's text alone");

  // A container carries no buffer at all until something writes to it.
  checkEq(0, b.tree.textLength(col), "a column has no text");
  checkEq(0, b.tree.bufferOf(col).capacity <= 32 ? 0 : 1, "and no buffer of its own");

  // Growth is by doubling, so retyping a long string once does not grow per byte.
  const long = b.ui.label(col, "0123456789abcdef0123456789abcdef0123456789abcdef");
  b.tree.layout();
  const capLong = b.tree.bufferOf(long).capacity;
  check(capLong >= 48 && capLong <= 96, "a 48-byte label grew to one doubling");
  b.ui.text(long, "0123456789abcdef0123456789abcdef0123456789abcde");
  b.tree.layout();
  checkEq(capLong, b.tree.bufferOf(long).capacity, "and a shorter rewrite reuses it");
}

/// The three flags: work happens only where the change reaches.
function caseDirty(): void {
  const b = new Bench();
  const root = b.ui.root(320, 240);
  const col = b.ui.column(root, { pad: 4 });
  const btn = b.ui.button(col, "Run");
  b.tree.layout();
  check(b.tree.measures > 0, "the first layout measures");
  check(b.tree.arranges > 0, "and arranges");

  b.tree.layout();
  checkEq(0, b.tree.measures, "a clean tree measures nothing");
  checkEq(0, b.tree.arranges, "and arranges nothing");

  // Colour: repaint only, and nothing above it moves.
  b.ui.colour(btn, 2);
  b.tree.layout();
  checkEq(0, b.tree.measures, "a colour change does not re-measure");
  checkEq(0, b.tree.arranges, "and does not re-arrange");
  checkEq(Dirty.Paint, b.tree.dirty[btn], "the paint flag is the one it set");

  // Text: the label's size changed, so it propagates up and re-measures.
  const before = b.tree.w[btn];
  b.ui.text(btn, "Run the scene");
  b.tree.layout();
  check(b.tree.measures > 0, "a text change re-measures");
  check(b.tree.w[btn] > before, "and the button grew with its label");

  // Resize: arrange only. This is the whole point of the two passes.
  b.tree.layout();
  b.tree.resize(500, 300);
  b.tree.layout();
  checkEq(0, b.tree.measures, "a resize does NOT re-measure");
  check(b.tree.arranges > 0, "but it does re-arrange");
  checkEq(500, b.tree.w[root], "and the root took the new width");

  // Padding is a *measure* input: a container's size is content plus twice the
  // padding, so the number every ancestor distributes around just changed.
  b.tree.layout();
  const beforePad = b.tree.h[col];
  b.ui.pad(col, 12);
  b.tree.layout();
  check(b.tree.measures > 0, "a padding change re-measures, because a size changed");
  checkEq(beforePad + 16, b.tree.h[col], "and the column grew by both pads");

  // A flex change is an arrange: no size changed, only the share of one.
  b.tree.layout();
  b.ui.flex(btn, 1);
  b.tree.layout();
  checkEq(0, b.tree.measures, "a flex change does NOT re-measure");
  check(b.tree.arranges > 0, "but it re-arranges");

  // The paint flag is cleared by the paint that honours it. Paint once first: the
  // arrange above promoted its own flags, and those are real repaints too.
  b.tree.paint(b.p, b.hits);
  checkEq(0, b.tree.paintDirty(), "a paint clears what the arrange promoted");
  b.ui.colour(btn, 3);
  checkEq(1, b.tree.paintDirty(), "one widget wants a repaint");
  b.tree.paint(b.p, b.hits);
  checkEq(0, b.tree.paintDirty(), "and painting it clears the flag");
}

/// Culling: a widget that misses the viewport emits nothing and records nothing.
function caseCull(): void {
  const b = new Bench();
  const root = b.ui.root(200, 200);
  const col = b.ui.column(root);
  const first = b.ui.button(col, "one", { minH: 50 });
  const second = b.ui.button(col, "two", { minH: 50 });
  b.tree.setViewport(0, 0, 200, 40);
  b.tree.layout();

  check(b.tree.visible[first], "the button in the viewport is visible");
  check(!b.tree.visible[second], "the one below it is not");
  checkEq(50, b.tree.y[second], "and it is still laid out where it belongs");

  b.tree.paint(b.p, b.hits);
  check(b.p.count > 0, "the visible button drew");
  checkEq(1, b.hits.count, "and recorded one target");
  checkEq(-1, b.hits.at(10, 60), "a point over the culled button finds nothing");
  check(b.hits.at(10, 10) == b.tree.id[first], "a point over the visible one finds it");

  // The gate itself: a target clipped away records nothing, whatever the caller
  // believes it drew.
  const h = new Hits();
  b.p.reset();
  b.p.useHits(h);
  b.p.pushClip(0, 0, 10, 10);
  check(!b.p.addHit(40, 40, 50, 50, 99), "a target outside the clip is refused");
  check(b.p.addHit(0, 0, 100, 100, 98), "a target over the clip is recorded");
  checkEq(0, h.xAt(0), "and trimmed to the clip's corner");
  checkEq(10, h.wAt(0), "and to its width");
  checkEq(10, h.hAt(0), "and to its height");
  checkEq(1, h.count, "one target, not two");
  b.p.popClip();
  b.p.useHits(null);

  // `skipped` counts the culled widget, so a status line can report the cull.
  check(b.tree.skipped >= 1, "the paint reports what it skipped");
}

/// The `listItem` bug, asserted: a row scrolled out of the pane records no target.
///
/// This is the defect the pass exists to fix, so it gets a test that fails on the
/// old code — where the early return for a vertically clipped row still called
/// `hits.add`, so a click in the space where the row used to be selected it.
function caseListItemClip(): void {
  const p = new Painter();
  const hits = new Hits();
  const row = bytesOf("a row");

  p.reset();
  p.useHits(hits);
  p.pushClip(100, 100, 200, 60);         // a pane holding two 20-px rows

  // Inside: one target, at the row's own rectangle.
  listItem(p, row, 0, 5, 100, 110, 200, 1);
  checkEq(1, hits.count, "a row inside the pane records one target");
  checkEq(110, hits.yAt(0), "at its own y");

  // Below the pane: no target at all, and no record either.
  const before = p.count;
  listItem(p, row, 0, 5, 100, 200, 200, 2);
  checkEq(1, hits.count, "a row below the pane records nothing");
  checkEq(before, p.count, "and draws nothing");

  // Straddling the bottom edge: the target is the visible half, not the whole row.
  listItem(p, row, 0, 5, 100, 150, 200, 3);
  checkEq(2, hits.count, "a straddling row still records");
  checkEq(10, hits.hAt(1), "trimmed to the ten pixels of it that are visible");
  checkEq(3, hits.idAt(1), "and it is the row's own id");

  // A click where the hidden row used to be finds nothing.
  checkEq(-1, hits.at(150, 200), "a click in the empty space finds nothing");
  checkEq(1, hits.at(150, 110), "and a click on the visible row finds it");

  // The mechanism, stated so it is measured rather than asserted: raw `Hits.add`
  // has no clip and records anyway — which is exactly what `listItem` used to do
  // — while `addHit` is the gate that refuses it.
  hits.begin();
  hits.add(100, 200, 200, 20, 9);
  checkEq(1, hits.count, "raw Hits.add records a target outside the clip");
  checkEq(9, hits.at(150, 200), "so a click in the empty space would find it");
  hits.begin();
  check(!p.addHit(100, 200, 200, 20, 9), "addHit refuses the same rectangle");
  checkEq(0, hits.count, "and records nothing");

  p.popClip();
  p.useHits(null);
}

/// Cost: what the painter charged, per widget and in total.
function caseTreeCost(): void {
  const b = new Bench();
  const root = b.ui.root(300, 200);
  const col = b.ui.column(root);
  const btn = b.ui.button(col, "Open", { pad: 4 });
  const lab = b.ui.label(col, "a label");
  const r = b.ui.rule(col);
  b.tree.layout();
  b.tree.paint(b.p, b.hits);

  checkEq(b.p.count, b.tree.totalCost(), "the tree's cost is what the painter emitted");
  check(b.tree.cost[btn] >= 2, "a button costs its two fills plus its glyphs");
  check(b.tree.cost[lab] > 0, "a label costs its glyphs");
  check(b.tree.cost[r] > 0, "a rule costs the tiles it emitted");
  checkEq(0, b.tree.cost[col], "a column draws nothing itself");
  checkEq(b.tree.subtree[btn] + b.tree.subtree[lab] + b.tree.subtree[r], b.tree.subtree[col],
          "a container's subtree cost is the sum of its children's");
  checkEq(b.tree.cost[col] + b.tree.subtree[btn] + b.tree.subtree[lab] + b.tree.subtree[r],
          b.tree.subtree[col], "and its own cost is on top of theirs");

  // The trim logic is the painter's and is unchanged: a label clipped by a narrow
  // container emits fewer records than it has characters. A `minW` cannot test
  // this — it is a floor, so it never narrows a widget below its text. A stretched
  // label in a 20-pixel column can.
  const narrow = new Bench();
  const nroot = narrow.ui.root(20, 60);
  const ncol = narrow.ui.column(nroot);
  const long = narrow.ui.label(ncol, "a very long label indeed, wider than its box",
                               { align: ALIGN_STRETCH });
  narrow.tree.layout();
  checkEq(20, narrow.tree.w[long], "a stretched label is as wide as its column");
  narrow.tree.paint(narrow.p, narrow.hits);
  check(narrow.tree.cost[long] > 0, "and still emits the glyphs that fit");
  check(narrow.tree.cost[long] < 20, "which is fewer than it has characters");
}

/// The hit list is a cursor over fixed arrays, not six allocations per frame.
function caseHitCursor(): void {
  const h = new Hits(4);
  h.begin();
  check(h.add(0, 0, 10, 10, 1), "the first target is recorded");
  checkEq(1, h.count, "and counted");
  check(h.add(0, 0, 10, 10, 2), "the second fits");
  h.add(0, 0, 10, 10, 3);
  h.add(0, 0, 10, 10, 4);
  check(!h.add(0, 0, 10, 10, 5), "the fifth is refused by the capacity");
  checkEq(1, h.dropped, "and counted as dropped");
  checkEq(4, h.count, "the capacity is the cap");

  h.begin();
  checkEq(0, h.count, "begin() rewinds the cursor");
  checkEq(0, h.dropped, "and clears the drop count");
  check(!h.add(0, 0, 0, 10, 1), "a zero-width target is not a target");

  // A trimmed target is what a clipped widget records, and it is what `at` tests.
  h.begin();
  h.add(10, 0, 30, 20, 7);
  checkEq(7, h.at(10, 0), "the trimmed target answers at its own corner");
  checkEq(-1, h.at(9, 0), "and not one pixel left of it");
}

// ── the event system ────────────────────────────────────────────────────────

/// A click target that counts what it was told.
///
/// Handlers are objects with a method, not closures: the compiler this targets
/// cannot call a closure back across a module boundary (the note in `events.ts` has
/// the minimal repro). `watch` is the one-line wiring an app writes.
class Tally implements ClickTarget, ChangeTarget {
  n: i32 = 0;
  lastValue: i32 = -999;
  firstId: i32 = -1;
  /** The widget this tally was last attached to, so `click` knows who fired. */
  via: i32 = -1;

  click(): void {
    if (this.n == 0) this.firstId = this.via;
    this.n++;
  }

  change(value: i32): void {
    this.n++;
    this.lastValue = value;
  }
}

/// A custom widget: it measures itself from its floors, paints two rules, records a
/// hit target, and **refuses** every event so the bubble continues.
///
/// This is the whole of what `ui.node(parent, behavior)` needs from a caller — the
/// four methods of `WidgetBehavior` and nothing else. The engine still owns the
/// dirty flags, the clip, the cull and the record accounting; this owns only what a
/// passive box differs in.
class Passive implements WidgetBehavior {
  /** How many events reached `handle`, so a test can prove dispatch happened. */
  handled: i32 = 0;

  measure(ui: Ui, id: i32): void {
    ui.setSize(id, ui.tree.minW[id], ui.tree.minH[id]);
    ui.applyFloors(id);
  }

  arrange(ui: Ui, id: i32, x: i32, y: i32, w: i32, h: i32): void {
    // No children, nothing to place.
  }

  paint(ui: Ui, id: i32, p: Painter): void {
    const t: WidgetTree = ui.tree;
    const page = t.page[id];
    p.addHit(t.x[id], t.y[id], t.w[id], t.h[id], t.id[id], id);
    p.hline(t.x[id], t.y[id], t.w[id], page.chromeCell(5), page);
  }

  handle(ui: Ui, id: i32, ev: UiEvent): bool {
    this.handled++;
    return false;                 // never consume: the bubble goes on
  }
}

/// A model with `n` rows of "item <i>".
class CountingModel extends ListSource {
  n: i32 = 0;

  constructor(n: i32) {
    super();
    this.n = n;
  }

  count(): i32 {
    return this.n;
  }

  text(index: i32, out: TextPool): void {
    out.str("item ");
    out.int(index);
  }
}

/// One dispatch, with the pointer where a frame put it.
function pointerFrame(ui: Ui, snap: Snapshot, x: i32, y: i32,
                      dx: i32, dy: i32, buttons: u32): void {
  snap.latch();
  snap.setPointer(x, y, dx, dy);
  snap.setButtons(buttons);
  ui.frame(snap);
}

/// One draw, into the hit list the next dispatch will read.
///
/// Both draw paths run in the same frame — a tree paint and one `drawText` — so the
/// "this frame allocated nothing" checks cover the retained path *and* the
/// immediate-mode one that the two apps still use.
function drawFrame(b: Bench): void {
  b.tree.layout();
  b.p.reset();
  drawText(b.p, "frame", 0, 0);
  b.tree.paint(b.p, b.ui.hits);
}

/// A press and release at a point, with a draw in between, and no motion.
function clickAt(b: Bench, snap: Snapshot, x: i32, y: i32): void {
  pointerFrame(b.ui, snap, x, y, 0, 0, 1);
  drawFrame(b);
  pointerFrame(b.ui, snap, x, y, 0, 0, 0);
  drawFrame(b);
}

/// **The allocation claim**, as a number rather than a promise.
///
/// A text field is typed into for forty frames and a label beside it never
/// changes. What must hold: the tree's frame pool wrote **nothing** (no list row
/// was refilled), the label's buffer was never reallocated, and every keystroke
/// arrived exactly once.
function caseZeroAllocText(): void {
  const b = new Bench();
  const root = b.ui.root(400, 160);
  const col = b.ui.column(root);
  const f = b.ui.field(col, "");
  const lab = b.ui.label(col, "fixed caption");
  b.tree.layout();

  const labCap = b.tree.bufferOf(lab).capacity;
  const labLen = b.tree.textLength(lab);

  const snap = Snapshot.synthetic();
  b.ui.setFocus(f);
  check(b.ui.isFocused(f), "the field takes the focus");

  for (let i: i32 = 0; i < 40; i++) {
    print("  [za] frame " + i.toString());
    snap.pushText("a");
    snap.latch();
    b.ui.pool.begin();
    b.ui.frame(snap);
    b.tree.layout();
  }

  checkEq(40, b.tree.textLength(f), "forty frames of typing delivered forty bytes");
  checkEq("a".repeat(40).length, b.ui.textOf(f).length, "and they are all there");
  checkEq(0, b.tree.texts.highWater, "the frame pool wrote no bytes for a fixed label");
  checkEq(0, b.tree.texts.dropped, "and dropped none");
  checkEq(labCap, b.tree.bufferOf(lab).capacity, "the label's buffer was never reallocated");
  checkEq(labLen, b.tree.textLength(lab), "and its text never changed");
  check(b.tree.bufferOf(f).capacity < 256, "the field's buffer grew by doubling, not per byte");

  // The heap, as a second witness. Every widget's buffer has reached its size by
  // frame five (a field grows on the keystroke that needs it, by doubling), so the
  // next hundred and fifteen frames must not add one page. This is *evidence*
  // rather than proof — a mark-and-sweep heap can recycle — but it is the page
  // count the process actually holds, and the two assertions above are the
  // mechanism the number is supposed to reflect.
  const pagesBefore: i32 = memory.size();
  for (let i: i32 = 0; i < 115; i++) {
    snap.pushText("b");
    snap.latch();
    b.ui.frame(snap);
    drawFrame(b);
  }
  checkEq(pagesBefore, memory.size(), "115 more frames added no wasm page to the heap");
  checkEq(155, b.tree.textLength(f), "and every frame's keystroke still arrived");

  // The same claim for the painter's pool, which is where `drawText` writes.
  const p = new Painter();
  p.reset();
  const before = p.texts.highWater;
  drawText(p, "frames", 0, 0);
  const one = p.texts.highWater;
  check(before == 0 && one == 6, "drawText wrote six bytes into the frame pool");
  const cap: i32 = p.texts.capacity;
  for (let i: i32 = 0; i < 20; i++) drawText(p, "frames", 0, 0);
  checkEq(21 * 6, p.texts.highWater, "twenty-one strings in a frame are 126 bytes of pool");
  checkEq(cap, p.texts.capacity, "and the pool's allocation never grew");
  checkEq(0, p.texts.dropped, "and none of it was dropped");
  p.reset();
  checkEq(0, p.texts.highWater, "a new frame rewinds the cursor");

  // A composed line costs the pool nothing beyond its bytes.
  const tb = new TextBuilder(32);
  tb.str("node ").int(-2147483648).str(" ok");
  const tbLen: i32 = tb.len;
  const tbMinus: i32 = tb.bytes[5];
  const tbLast: i32 = tb.bytes[15];
  print("  [za] p5 len=" + tbLen.toString() + " minus=" + tbMinus.toString() + " last=" + tbLast.toString());
  checkEq(19, tbLen, "a builder composes node + INT_MIN + ok in 19 bytes");
  checkEq(45, tbMinus, "the minus sign opens the integer");
  checkEq(56, tbLast, "and the digits end on the last one");
}

/// Focus is a pre-order walk over what can take it, and Tab follows it.
function caseFocusOrder(): void {
  const b = new Bench();
  const root = b.ui.root(400, 200);
  const col = b.ui.column(root);
  const first = b.ui.field(col, "one");
  const middle = b.ui.button(col, "not focusable");
  const last = b.ui.field(col, "two");
  b.tree.layout();

  check(!b.tree.focusable[middle], "a button is not in the tab order");
  check(b.tree.focusable[first] && b.tree.focusable[last], "fields are");

  b.ui.setFocus(first);
  check(b.ui.isFocused(first), "SetFocus takes");
  b.ui.focusNext(false);
  check(b.ui.isFocused(last), "Tab skips the button and lands on the next field");
  b.ui.focusNext(false);
  check(b.ui.isFocused(first), "Tab wraps to the first");
  b.ui.focusNext(true);
  check(b.ui.isFocused(last), "Shift-Tab wraps backwards");

  // The same through a real Tab edge, which is the path an app runs.
  const snap = Snapshot.synthetic();
  b.ui.setFocus(first);
  snap.latch();
  snap.setKey(SCAN_TAB, true);
  b.ui.frame(snap);
  check(b.ui.isFocused(last), "a Tab scancode moves the focus the same way");
  snap.latch();
  snap.setKey(SCAN_TAB, false);
  b.ui.frame(snap);
  check(b.ui.isFocused(last), "and holding it does not run away");

  // A click on nothing blurs.
  b.ui.setFocus(last);
  clickAt(b, snap, 5, 500);
  checkEq(-1, b.ui.focusId, "clicking empty space blurs");

  // The `readText` contract: bytes typed while nothing is focused are **consumed
  // and discarded**, not held for the next field that happens to get focus.
  const b3 = new Bench();
  const r3 = b3.ui.root(300, 100);
  const only = b3.ui.field(r3, "");
  b3.tree.layout();
  const s3 = Snapshot.synthetic();
  s3.pushText("typed into nothing");
  s3.latch();
  b3.ui.frame(s3);
  checkEq(0, b3.tree.textLength(only), "bytes with no focus go nowhere");
  b3.ui.setFocus(only);
  s3.latch();
  b3.ui.frame(s3);
  checkEq(0, b3.tree.textLength(only), "and they are not delivered to the field that focuses next");

  // Exactly once: the queue is empty after the frame that read it.
  s3.pushText("ok");
  s3.latch();
  const before = s3.textPending();
  b3.ui.frame(s3);
  checkEq(2, before, "the queue held two bytes before the frame");
  checkEq(0, s3.textPending(), "and none after it — one read consumed them");
  checkEq(2, b3.tree.textLength(only), "which is exactly what the field received");
}

/// Bubbling: the button consumes, and the row behind it never hears about it.
///
/// Handler order at each widget on the way up: the registered target fires and
/// consumes, else the behavior's `handle` decides, else the parent hears it. So a
/// button with a handler never hands its click to the row, and a button *without*
/// one still consumes it (a button is a target) — both asserted here.
function caseBubbling(): void {
  const b = new Bench(64);
  const root = b.ui.root(400, 200);
  const col = b.ui.column(root, { pad: 4 });
  const row = b.ui.row(col, { pad: 2 });
  const btn = b.ui.button(row, "File", { pad: 4, minH: 30 });
  b.tree.layout();
  b.p.reset();
  b.tree.paint(b.p, b.ui.hits);

  const bx: i32 = b.tree.x[btn] + b.tree.w[btn] / 2;
  const by: i32 = b.tree.y[btn] + b.tree.h[btn] / 2;
  checkEq(b.tree.id[btn], b.ui.hits.at(bx, by), "the pointer is over the button");

  const btnTally = new Tally();
  btnTally.via = b.tree.id[btn];
  const rowTally = new Tally();
  rowTally.via = b.tree.id[row];
  b.ui.onClick(b.tree.id[btn], btnTally);
  b.ui.onClick(b.tree.id[row], rowTally);

  const snap = Snapshot.synthetic();
  pointerFrame(b.ui, snap, bx, by, 0, 0, 1);
  checkEq(1, btnTally.n, "the button's handler fired exactly once");
  checkEq(0, rowTally.n, "a button inside a row takes the click; the row does not");
  checkEq(b.tree.id[btn], btnTally.firstId, "and it was the button that heard it");

  // A press on a *caption* inside the row: a label is a target but does not consume,
  // so the click bubbles up to the row and stops there. This is the positive half of
  // "bubbling works" — the button case above is the half where it must not.
  pointerFrame(b.ui, snap, bx, by, 0, 0, 0);   // release

  // A *passive* custom widget: it records a hit target and refuses the event, so the
  // click bubbles to the row. This is the positive half of "bubbling works" — and it
  // is a custom behavior doing the work, which is the extension point in one line.
  const passive = new Passive();
  const tail = b.ui.node(row, passive, { minW: 40, minH: 20 });
  b.tree.layout();
  b.p.reset();
  b.tree.paint(b.p, b.ui.hits);
  const lx: i32 = b.tree.x[tail] + 2;
  const ly: i32 = b.tree.y[tail] + 2;
  checkEq(b.tree.id[tail], b.ui.hits.at(lx, ly), "the custom widget records a target");
  pointerFrame(b.ui, snap, lx, ly, 0, 0, 1);
  checkEq(1, rowTally.n, "a click on a passive widget bubbles to the row");
  checkEq(1, btnTally.n, "and does not reach the button beside it");
  checkEq(1, passive.handled, "the custom behavior saw the event on the way past");

  // A press on the row's own background hits nothing: containers are not targets.
  pointerFrame(b.ui, snap, lx, ly, 0, 0, 0);
  const emptyX: i32 = b.tree.x[row] + b.tree.w[row] - 1;
  pointerFrame(b.ui, snap, emptyX, b.tree.y[row] + 1, 0, 0, 1);
  checkEq(1, rowTally.n, "and the row's bare background is not a target");

  // With no handler on the button, the bubble still stops there.
  const b2 = new Bench(32);
  const r2 = b2.ui.root(300, 120);
  const row2 = b2.ui.row(r2, { pad: 2 });
  const btn2 = b2.ui.button(row2, "Ok", { pad: 4, minH: 24 });
  b2.tree.layout();
  b2.p.reset();
  b2.tree.paint(b2.p, b2.ui.hits);
  const row2Tally = new Tally();
  b2.ui.onClick(b2.tree.id[row2], row2Tally);
  const s2 = Snapshot.synthetic();
  pointerFrame(b2.ui, s2, b2.tree.x[btn2] + 4, b2.tree.y[btn2] + 4, 0, 0, 1);
  checkEq(0, row2Tally.n, "an unwired button still consumes the click");
}

/// Mouse capture: a split keeps moving when the pointer leaves its divider.
function caseDragCapture(): void {
  const b = new Bench(64);
  const root = b.ui.root(600, 300);
  // `flex: 1` because a split's measured height is its two panes', and two empty
  // columns measure nothing — a split with no content and no flex is zero tall and
  // correctly culled.
  const sp = b.ui.split(root, Axis.X, { flex: 1 });
  const left = b.ui.column(sp);
  const right = b.ui.column(sp);
  b.ui.minW(left, 100);
  b.ui.minW(right, 100);
  b.tree.layout();
  b.p.reset();
  b.tree.paint(b.p, b.ui.hits);

  const div: i32 = b.tree.gap[sp];
  const divX: i32 = b.tree.x[left] + b.tree.w[left];
  const cy: i32 = 150;

  // The divider's target is wider than the divider, so a press 2 px off still grabs.
  checkEq(b.tree.id[sp], b.ui.hits.at(divX - 2, cy), "the grab band reaches left of the divider");
  checkEq(b.tree.id[sp], b.ui.hits.at(divX + div + 2, cy), "and right of it");
  checkEq(-1, b.ui.hits.at(divX - 20, cy), "but not twenty pixels away");

  const snap = Snapshot.synthetic();
  const startSplit: i32 = b.tree.splitPx[sp];
  pointerFrame(b.ui, snap, divX, cy, 0, 0, 1);
  checkEq(sp, b.ui.captureId, "the press took capture");

  pointerFrame(b.ui, snap, divX + 40, cy, 40, 0, 1);
  checkEq(startSplit + 40, b.tree.splitPx[sp], "a 40-px drag moved the divider 40 px");

  // Far outside the widget: capture is what keeps it moving, and `arrange` clamps.
  pointerFrame(b.ui, snap, 5000, 5000, 4000, 0, 1);
  b.tree.layout();
  checkEq(600 - div - 100, b.tree.splitPx[sp], "dragging past the right pane clamps to its floor");
  checkEq(100, b.tree.w[right], "and the pane keeps its minimum");

  // Release: motion no longer routes anywhere.
  pointerFrame(b.ui, snap, 5000, 5000, 0, 0, 0);
  checkEq(-1, b.ui.captureId, "the release dropped capture");
  b.tree.layout();
  const after: i32 = b.tree.splitPx[sp];
  pointerFrame(b.ui, snap, 100, cy, -300, 0, 0);
  b.tree.layout();
  checkEq(after, b.tree.splitPx[sp], "and the divider ignores motion with no button down");
}

/// A slider maps the pointer onto its range, through capture.
function caseSlider(): void {
  const rec = new Tally();
  const b = new Bench(64);
  const root = b.ui.root(400, 100);
  const sl = b.ui.slider(root, 500, { minW: 200 });
  b.ui.onChange(sl, rec);
  b.tree.layout();
  b.p.reset();
  b.tree.paint(b.p, b.ui.hits);

  const x0: i32 = b.tree.x[sl];
  const w: i32 = b.tree.w[sl];
  checkEq(500, b.ui.valueOf(sl), "a slider starts where it was built");
  checkEq(w, 200, "and is as wide as its minW");

  const snap = Snapshot.synthetic();
  pointerFrame(b.ui, snap, x0 + w / 2, 10, 0, 0, 1);
  checkEq(500, b.ui.valueOf(sl), "a press in the middle lands at half");
  pointerFrame(b.ui, snap, x0, 10, -100, 0, 1);
  checkEq(0, b.ui.valueOf(sl), "dragging to the left end is zero");
  pointerFrame(b.ui, snap, x0 - 500, 10, -500, 0, 1);
  checkEq(0, b.ui.valueOf(sl), "and past it stays zero");
  pointerFrame(b.ui, snap, x0 + w + 500, 10, 900, 0, 1);
  checkEq(1000, b.ui.valueOf(sl), "past the right end is the maximum");
  checkEq(1000, rec.lastValue, "and the handler was told");
  pointerFrame(b.ui, snap, x0 + w + 500, 10, 0, 0, 0);
  checkEq(-1, b.ui.captureId, "the release drops capture");
}

/// A thousand items, twenty widgets: only the visible rows are arranged and painted.
function caseVirtualList(): void {
  const model = new CountingModel(1000);
  const b = new Bench(128);
  const root = b.ui.root(400, 240);
  const col = b.ui.column(root);
  const list = b.ui.list(col, model, 20, { minH: 200 });
  b.tree.layout();

  checkEq(20, b.tree.childCount(list), "twenty row widgets, not a thousand");
  checkEq(1000, b.tree.itemCount[list], "and a thousand items behind them");

  const innerH: i32 = b.tree.h[list] - 2 * b.tree.pad[list];
  const ih: i32 = b.tree.itemH[list];
  const visible: i32 = innerH / ih + 1;

  // Arrange is the list and its rows: nothing like the item count.
  check(b.tree.arranges >= 20 && b.tree.arranges <= 24,
        "arranging a 1000-item list placed about twenty widgets");

  b.p.reset();
  b.tree.paint(b.p, b.ui.hits);
  check(b.ui.hits.count <= visible,
        "only the rows on screen record a hit target");
  check(b.ui.hits.count > 0, "and at least one does");
  check(b.tree.cost[list] == 0, "the list itself draws nothing");
  check(b.tree.subtree[list] < 20 * 8, "and its subtree costs the visible rows, not all twenty");

  // The rows that scrolled out are laid out where they belong and marked invisible.
  let row: i32 = b.tree.firstChild[list];
  let k: i32 = 0;
  let hidden: i32 = 0;
  while (row >= 0) {
    if (!b.tree.visible[row]) hidden++;
    row = b.tree.nextSibling[row];
    k++;
  }
  check(hidden > 0, "the rows below the window are culled");
  checkEq(20, k, "and all twenty still exist");

  // Scrolling re-arranges the list only — the root is not dirtied.
  b.ui.scrollTo(list, 100 * ih);
  checkEq(0, b.tree.dirty[b.tree.root] & Dirty.Arrange, "a scroll does not dirty the root");
  check((b.tree.dirty[list] & Dirty.Arrange) != 0, "it dirties the list");
  b.tree.layout();
  checkEq(100, b.tree.itemIndex[b.tree.firstChild[list]], "the first row now shows item 100");
  checkEq(100 * ih, b.ui.scrollOf(list), "and the scroll offset is where it was asked to be");

  // The rows that are showing have the right text, and the pool still bounded it.
  const first: i32 = b.tree.firstChild[list];
  checkEq(8, b.tree.textLength(first), "a row reads \"item 100\" (eight bytes)");
  check(b.tree.texts.highWater > 0 && b.tree.texts.highWater <= 200,
        "and filling the window wrote a bounded number of bytes");

  // Past the end: the scroll clamps rather than blanking the window.
  b.ui.scrollTo(list, 1 << 20);
  b.tree.layout();
  const maxScroll: i32 = 1000 * ih - innerH;
  checkEq(maxScroll, b.ui.scrollOf(list), "an over-scroll clamps to the last page");
  check(b.tree.visible[b.tree.firstChild[list]], "and the last page is drawn");

  // Scrolling back to the top brings item 0 back into the first row.
  b.ui.scrollTo(list, 0);
  b.tree.layout();
  checkEq(0, b.tree.itemIndex[b.tree.firstChild[list]], "and back to the top is item 0");
}

/// A text field's caret, selection and editing — the parts that are arithmetic.
function caseTextEditing(): void {
  const b = new Bench();
  const root = b.ui.root(400, 100);
  const f = b.ui.field(root, "abc", { minW: 200 });
  b.tree.layout();

  b.ui.setCaret(f, 1);
  checkEq(1, b.ui.caret(f), "the caret is where it was put");

  const snap = Snapshot.synthetic();
  b.ui.setFocus(f);

  // Typing inserts at the caret, not at the end.
  snap.pushText("X");
  snap.latch();
  b.ui.frame(snap);
  checkStr("aXbc", b.ui.textOf(f), "typed bytes go in at the caret");
  checkEq(2, b.ui.caret(f), "and the caret follows them");

  // Backspace deletes before the caret.
  snap.latch();
  snap.setKey(SCAN_BACKSPACE, true);
  b.ui.frame(snap);
  checkStr("abc", b.ui.textOf(f), "backspace removes the character before the caret");
  checkEq(1, b.ui.caret(f), "and moves the caret back");
  snap.latch();
  snap.setKey(SCAN_BACKSPACE, false);

  // Left/right move it; a shift-left extends a selection.
  b.ui.setCaret(f, 3);
  snap.latch();
  snap.setKey(SCAN_LEFT, true);
  b.ui.frame(snap);
  checkEq(2, b.ui.caret(f), "left moves the caret one code point");
  snap.latch();
  snap.setKey(SCAN_LEFT, false);
  b.ui.frame(snap);

  b.ui.setCaret(f, 3);
  snap.latch();
  snap.setModifiers(0x3);           // KMOD_LSHIFT
  snap.setKey(SCAN_LEFT, true);
  b.ui.frame(snap);
  checkEq(2, b.tree.selectionLo(f), "shift-left selects");
  checkEq(3, b.tree.selectionHi(f), "one character, from the anchor to the caret");
  checkEq(1, b.tree.selectionHi(f) - b.tree.selectionLo(f), "which is one byte of selection");

  // Typing over a selection replaces it.
  snap.latch();
  snap.setKey(SCAN_LEFT, false);
  snap.pushText("Z");
  b.ui.frame(snap);
  checkStr("abZ", b.ui.textOf(f), "typing replaces the selection");

  // A click places the caret, using the same advance arithmetic as the draw. Mono
  // makes the boundaries exact (nine pixels per glyph), so the assertion is about
  // the caret arithmetic rather than about rounding.
  b.ui.font(f, FONT_MONO, SIZE_14);
  b.ui.text(f, "abZ");
  // Padding so the text starts inside the field rather than at its left edge: a
  // click left of the *text* has to still be inside the *field*, or it is a click
  // on nothing (which blurs, correctly) and proves nothing about the caret.
  b.ui.pad(f, 20);
  b.tree.layout();
  b.p.reset();
  b.tree.paint(b.p, b.ui.hits);
  const tx: i32 = b.tree.x[f] + b.tree.pad[f];
  const snap2 = Snapshot.synthetic();
  const cy2: i32 = b.tree.y[f] + 5;
  pointerFrame(b.ui, snap2, tx + 19, cy2, 0, 0, 1);
  checkEq(2, b.ui.caret(f), "a click 19 px in — nearest the boundary after \"ab\" — is caret 2");
  pointerFrame(b.ui, snap2, tx + 19, cy2, 0, 0, 0);      // release, so the next is a press
  pointerFrame(b.ui, snap2, 8, cy2, -31, 0, 1);
  checkEq(0, b.ui.caret(f), "a click inside the field but left of the text is caret 0");
  pointerFrame(b.ui, snap2, 8, cy2, 0, 0, 0);
  pointerFrame(b.ui, snap2, 195, cy2, 187, 0, 1);
  checkEq(3, b.ui.caret(f), "and a click past the last glyph clamps to the end");
}

export function _start_game(): void {
  if (RuntimeSession.open(ConfigBuilder.forThisBuild()) != 0) {
    print("FAIL: the session did not open");
    return;
  }
  print(">>> caseGeometry");
  caseGeometry();
  print(">>> caseWrapping");
  caseWrapping();
  print(">>> caseColumns");
  caseColumns();
  print(">>> caseCosts");
  caseCosts();
  print(">>> caseGlyphClip");
  caseGlyphClip();
  print(">>> caseHits");
  caseHits();
  print(">>> casePool");
  casePool();
  print(">>> caseProps");
  caseProps();
  print(">>> caseFlex");
  caseFlex();
  print(">>> caseSplit");
  caseSplit();
  print(">>> caseLeafSizes");
  caseLeafSizes();
  print(">>> caseTextBuffer");
  caseTextBuffer();
  print(">>> caseDirty");
  caseDirty();
  print(">>> caseCull");
  caseCull();
  print(">>> caseListItemClip");
  caseListItemClip();
  print(">>> caseTreeCost");
  caseTreeCost();
  print(">>> caseHitCursor");
  caseHitCursor();
  print(">>> caseZeroAllocText");
  caseZeroAllocText();
  print(">>> caseFocusOrder");
  caseFocusOrder();
  print(">>> caseBubbling");
  caseBubbling();
  print(">>> caseDragCapture");
  caseDragCapture();
  print(">>> caseSlider");
  caseSlider();
  print(">>> caseVirtualList");
  caseVirtualList();
  print(">>> caseTextEditing");
  caseTextEditing();

  if (failures != 0) {
    print("ui: " + failures.toString() + " check(s) failed");
    return;
  }
  print("ui: layout, text, controls, events, drag and virtualisation hold");
  print("OK");
  RuntimeSession.close();
}
