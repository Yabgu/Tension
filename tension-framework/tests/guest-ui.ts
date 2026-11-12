// The UI toolkit's pure half: wrapping, column math, tile costs, hit testing.
//
// No canvas and no GPU, because none of it needs one — a Painter builds records
// into a buffer, and the rest is arithmetic over numbers a test can state. The
// drawing half is proved by the two apps that ship on it (`apps/docs` and the
// editor), which is the only place pixels mean anything.

import { Painter } from "../assembly/ui/painter";
import { Hits } from "../assembly/ui/hit";
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

/// The text arena: encoded once, reused in place, never a copy per frame.
function caseTextArena(): void {
  const b = new Bench();
  const root = b.ui.root(300, 100);
  const col = b.ui.column(root);
  const f = b.ui.field(col, "hello");
  b.tree.layout();
  const used = b.tree.textUsed;
  checkEq(5, used, "the field's text is five bytes of arena");

  // Retyping into the same run rewrites it and grows nothing.
  b.ui.text(f, "world");
  b.tree.layout();
  checkEq(5, b.tree.textUsed, "a same-length rewrite reuses its own run");

  // Longer text takes the tail. The arena is append-only — reclaiming the gap
  // would be a compaction pass over every widget's `textAt`, which is a heap in
  // its own right and not what a UI's text churn needs.
  b.ui.text(f, "hello there");
  b.tree.layout();
  checkEq(16, b.tree.textUsed, "longer text is appended at the tail");

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

  // The arena never hands out a stale run: a widget that was freed and reused for
  // another label reads its own bytes, not the previous widget's.
  const other = b.ui.label(col, "zzz");
  b.tree.layout();
  checkEq(3, b.tree.textLen[other], "a new label has its own run");
  const tail = b.tree.textUsed;
  b.ui.text(other, "yyy");
  b.tree.layout();
  checkEq(3, b.tree.textLen[other], "and rewrites it in place when it fits");
  checkEq(tail, b.tree.textUsed, "growing the arena by nothing");
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

export function _start_game(): void {
  if (RuntimeSession.open(ConfigBuilder.forThisBuild()) != 0) {
    print("FAIL: the session did not open");
    return;
  }
  caseGeometry();
  caseWrapping();
  caseColumns();
  caseCosts();
  caseGlyphClip();
  caseHits();
  casePool();
  caseProps();
  caseFlex();
  caseSplit();
  caseLeafSizes();
  caseTextArena();
  caseDirty();
  caseCull();
  caseListItemClip();
  caseTreeCost();
  caseHitCursor();

  if (failures != 0) {
    print("ui: " + failures.toString() + " check(s) failed");
    return;
  }
  print("ui: wrapping, columns, costs, clipping, hits, pool, flex, split, flags hold");
  print("OK");
  RuntimeSession.close();
}
