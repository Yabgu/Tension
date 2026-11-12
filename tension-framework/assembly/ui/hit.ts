// Click targets, recorded by the draw that produced them.
//
// ## Why not recompute positions at click time
//
// A UI that computes where a row *should* be and where it *was drawn* has two
// layouts, and they drift. This file exists because they drifted here: the
// documentation viewer's hit test recomputed a result row's y and the constant
// pair disagreed with the draw by one row, so a click selected the row *below* the
// pointer — a bug that reads as "the click is offset" and is not.
//
// So the draw writes down what it drew, and the click asks the list. There is one
// layout, and it is the one on screen.
//
// ## Later is on top
//
// `at()` answers the **last** rect that contains the point, which is the last one
// drawn and therefore the one the user sees on top. That is the same rule the
// renderer's sort keys follow, so a panel drawn over a button steals its clicks
// without any z bookkeeping here.
//
// ## A cursor, not a fresh list
//
// `begin()` used to replace six arrays, which is six allocations per frame for a
// list that is emptied every frame. It now rewinds a length cursor over arrays
// sized once, and a `push` past capacity is counted in `dropped` rather than
// growing the list mid-frame. The cap is the bargain the record buffer makes too:
// a frame needing more targets than this has a virtualised list in it, and the
// honest answer is a number a caller can report.
//
// ## The clip is the painter's business, not this file's
//
// `add` records what it is given. The gate against recording a target for
// something that was clipped away lives in `Painter.addHit`, because that is the
// only object that knows the clip and emits the record — one call, one rectangle,
// one decision, so a target cannot outlive the pixels it describes. A caller that
// calls `add` directly opts out of that gate deliberately (the two apps that
// predate the widget tree do).

/** How many targets one frame can record. */
export const HIT_CAPACITY: i32 = 1024;

export class Hits {
  private cap: i32;
  /** Live targets; also the write cursor. */
  private n: i32 = 0;
  /** Targets refused because the list was full. */
  dropped: i32 = 0;

  private xs: i32[];
  private ys: i32[];
  private ws: i32[];
  private hs: i32[];
  private ids: i32[];
  /** The caller's own tag per target, when it needs two lookup tables at once. */
  private tags: i32[];

  constructor(capacity: i32 = HIT_CAPACITY) {
    const cap: i32 = capacity > 0 ? capacity : HIT_CAPACITY;
    this.cap = cap;
    this.xs = new Array<i32>(cap);
    this.ys = new Array<i32>(cap);
    this.ws = new Array<i32>(cap);
    this.hs = new Array<i32>(cap);
    this.ids = new Array<i32>(cap);
    this.tags = new Array<i32>(cap);
  }

  get count(): i32 {
    return this.n;
  }

  /** Empty the list; called at the top of the frame that will re-record it. */
  begin(): void {
    this.n = 0;
    this.dropped = 0;
  }

  /**
   * Record a target. Call it where the rectangle is drawn, not before and not
   * after: the point is that the two cannot disagree.
   *
   * Returns false when the rectangle is empty or the list is full (and counts the
   * latter), so a caller that cares can say so. Callers that predate this ignore
   * the answer.
   */
  add(x: i32, y: i32, w: i32, h: i32, id: i32, tag: i32 = -1): bool {
    if (w <= 0 || h <= 0) return false;
    if (this.n >= this.cap) {
      this.dropped++;
      return false;
    }
    const i: i32 = this.n++;
    this.xs[i] = x;
    this.ys[i] = y;
    this.ws[i] = w;
    this.hs[i] = h;
    this.ids[i] = id;
    this.tags[i] = tag;
    return true;
  }

  /**
   * The `id` of the topmost target containing `(x, y)`, or -1.
   *
   * A linear scan from the end: a frame has tens of targets, and the first match
   * from the top is the answer, so there is nothing to index.
   */
  at(x: i32, y: i32): i32 {
    for (let i: i32 = this.n - 1; i >= 0; i--) {
      if (x >= this.xs[i] && x < this.xs[i] + this.ws[i] &&
          y >= this.ys[i] && y < this.ys[i] + this.hs[i]) {
        return this.ids[i];
      }
    }
    return -1;
  }

  /** The `tag` of the topmost target containing `(x, y)`, or -1. */
  tagAt(x: i32, y: i32): i32 {
    for (let i: i32 = this.n - 1; i >= 0; i--) {
      if (x >= this.xs[i] && x < this.xs[i] + this.ws[i] &&
          y >= this.ys[i] && y < this.ys[i] + this.hs[i]) {
        return this.tags[i];
      }
    }
    return -1;
  }

  /** Whether any target contains the point. */
  contains(x: i32, y: i32): bool {
    return this.at(x, y) >= 0;
  }

  // --- reading back what was recorded -------------------------------------
  //
  // A test that asserts "the clipped row recorded nothing" has to be able to name
  // a target by index; a click handler only ever needs `at`. These are the four
  // accessors that difference needs, and they are bounds-checked so a test that
  // walks past the end reads zeros instead of trapping.

  xAt(index: i32): i32 {
    return index >= 0 && index < this.n ? this.xs[index] : 0;
  }

  yAt(index: i32): i32 {
    return index >= 0 && index < this.n ? this.ys[index] : 0;
  }

  wAt(index: i32): i32 {
    return index >= 0 && index < this.n ? this.ws[index] : 0;
  }

  hAt(index: i32): i32 {
    return index >= 0 && index < this.n ? this.hs[index] : 0;
  }

  idAt(index: i32): i32 {
    return index >= 0 && index < this.n ? this.ids[index] : -1;
  }
}

// The press edge is not here, deliberately. `input.Snapshot.buttonPressed(n)`
// already answers "went down since the previous read" by latching the previous
// button mask where the record is read, and a second mechanism would be a second
// answer to the same question — the class of bug this file exists to stop. A UI
// calls `buttonPressed(1)` once per frame and `at(x, y)` with the pointer.
