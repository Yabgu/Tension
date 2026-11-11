// The UI toolkit's pure half: wrapping, column math, tile costs, hit testing.
//
// No canvas and no GPU, because none of it needs one — a Painter builds records
// into a buffer, and the rest is arithmetic over numbers a test can state. The
// drawing half is proved by the two apps that ship on it (`apps/docs` and the
// editor), which is the only place pixels mean anything.

import { Painter } from "../assembly/ui/painter";
import { Hits } from "../assembly/ui/hit";
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

  if (failures != 0) {
    print("ui: " + failures.toString() + " check(s) failed");
    return;
  }
  print("ui: wrapping, columns, tile costs, clipping and hit testing hold");
  print("OK");
  RuntimeSession.close();
}
