// Click targets, recorded by the draw that produced them.
//
// ## Why not recompute positions at click time
//
// A UI that computes where a row *should* be and where it *was drawn* has two
// layouts, and they drift. This file exists because they drifted here: the
// documentation viewer's hit test recomputed a result row's y and the constant
// pair disagreed with the draw by one row, so a click selected the row *below*
// the pointer — a bug that reads as "the click is offset" and is not.
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
// The list is reused every frame: `begin()` empties it and nothing allocates. A
// thousand targets is four `i32` arrays that were sized once.

export class Hits {
  private xs: i32[] = [];
  private ys: i32[] = [];
  private ws: i32[] = [];
  private hs: i32[] = [];
  private ids: i32[] = [];
  /** The caller's own tag per target, when it needs two lookup tables at once. */
  private tags: i32[] = [];

  get count(): i32 {
    return this.ids.length;
  }

  /** Empty the list; called at the top of the frame that will re-record it. */
  begin(): void {
    this.xs = [];
    this.ys = [];
    this.ws = [];
    this.hs = [];
    this.ids = [];
    this.tags = [];
  }

  /**
   * Record a target. Call it where the rectangle is drawn, not before and not
   * after: the point is that the two cannot disagree.
   */
  add(x: i32, y: i32, w: i32, h: i32, id: i32, tag: i32 = -1): void {
    if (w <= 0 || h <= 0) return;
    this.xs.push(x);
    this.ys.push(y);
    this.ws.push(w);
    this.hs.push(h);
    this.ids.push(id);
    this.tags.push(tag);
  }

  /**
   * The `id` of the topmost target containing `(x, y)`, or -1.
   *
   * A linear scan from the end: a frame has tens of targets, and the first
   * match from the top is the answer, so there is nothing to index.
   */
  at(x: i32, y: i32): i32 {
    for (let i: i32 = this.ids.length - 1; i >= 0; i--) {
      if (x >= this.xs[i] && x < this.xs[i] + this.ws[i] &&
          y >= this.ys[i] && y < this.ys[i] + this.hs[i]) {
        return this.ids[i];
      }
    }
    return -1;
  }

  /** The `tag` of the topmost target containing `(x, y)`, or -1. */
  tagAt(x: i32, y: i32): i32 {
    for (let i: i32 = this.ids.length - 1; i >= 0; i--) {
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
}

// The press edge is not here, deliberately. `input.Snapshot.buttonPressed(n)`
// already answers "went down since the previous read" by latching the previous
// button mask where the record is read, and a second mechanism would be a second
// answer to the same question — the class of bug this file exists to stop. A UI
// calls `buttonPressed(1)` once per frame and `at(x, y)` with the pointer.
