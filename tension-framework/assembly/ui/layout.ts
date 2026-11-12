// The retained widget tree: a pool of nodes, two passes, three flags.
//
// ## Why the tree is arrays and not objects
//
// A widget in this toolkit is an **`i32` slot index**, never a reference. One
// `WidgetTree` owns twenty-seven parallel `i32[]` arrays (plus the per-widget
// `FontPage`), and a child is the number its parent stores in `firstChild`. Three
// things follow, and all three are the reason:
//
//   * **Nothing allocates when the tree changes.** Adding a widget is a free-list
//     pop and twenty-seven stores; it does not create a node for the collector to
//     trace, and it cannot produce a cycle the collector cannot see.
//   * **A tree can be inspected from a test as numbers.** "The flex children sum
//     to exactly the inner width" is `w[0] + w[1] + w[2] == 100`, not a walk over
//     objects with getters.
//   * **`@inline` struct values cannot be called through.** TensionScript refuses
//     a method call on a struct *value* (`2d/types.ts` records the AS100 for the
//     three spellings), so a `Widget` struct would not be able to hold a `measure`
//     method — the passes would have to be free functions over addresses. Parallel
//     arrays have no such restriction and no such indirection.
//
// ## Why authoring is a builder and not a constructor
//
// The tree is built **once**, at startup, by the cursor-style API in
// `builder.ts`: `ui.column(root, { pad: 8 })`. After that it is retained — the
// per-frame path is `layout()` (arithmetic) and `paint()` (records), and neither
// allocates. That split is the whole point of the retained mode: a frame whose
// nothing changed does no measure work and no arrange work, and only redraws.
//
// ## The two passes
//
//   * **Measure** is bottom-up and answers "how big does this want to be": a label
//     from its advance table, a button from its label plus padding, a container
//     from its children. It runs only over subtrees flagged `Dirty.Measure`.
//   * **Arrange** is top-down and answers "where does this actually go": the
//     parent assigns each child's rectangle from its own, and a flex child gets a
//     share of what is left. It runs only over subtrees flagged `Dirty.Arrange`.
//
// A container's *measured* size is its content size; its *arranged* size is what
// the parent gave it. Both are needed, in that order, and a pass that tried to do
// both would need the parent's answer before the child's question.
//
// ## Why the record budget is a paint concern and not a layout one
//
// Layout emits no records at all: 512 widgets cost zero of the 4,096. Only
// `paint` spends them, and it spends them where they show — a glyph is one
// record, a tiled fill is `tileCost(w, h)`. So `cost`/`subtree` are recorded
// during paint (the count the painter actually charged), and paint stops walking
// when the painter is full rather than emitting into a refusal. `skipped` says how
// many widgets that cost, so a caller can report it instead of guessing.

import { Chrome, FontBook, FontPage } from "./fonts";
import { Hits } from "./hit";
import { Painter } from "./painter";
import { Theme } from "./theme";

/**
 * How many widgets a tree can hold.
 *
 * A pool, not a growable list: a UI that needs more than this is a UI with a
 * virtualised list in it, and that is a different mechanism (Pass 3 owns it).
 * 512 is the editor's whole chrome with room for a scene tree's visible rows.
 */
export const WIDGET_CAPACITY: i32 = 512;

/**
 * How deep a tree may nest before the passes stop.
 *
 * Both passes are recursive, and a wasm guest's stack is not a resource to spend
 * on a malformed tree. `append` refuses a cycle, so depth is bounded by the
 * widget count — this is the second guard, and it is cheap enough to keep.
 */
export const MAX_DEPTH: i32 = 32;

/** A free slot's `kind`. Every live widget has one of the nine below. */
export const KIND_NONE: i32 = -1;

/** What a widget is. The five drawing kinds are the whole of Pass 2. */
export const enum Kind {
  /** The tree's single root, laid out like a column over the viewport. */
  Root = 0,
  Row = 1,
  Column = 2,
  Split = 3,
  Label = 4,
  Button = 5,
  TextField = 6,
  Spacer = 7,
  Rule = 8,
}

/** Cross-axis placement inside a row or column. */
export const enum Align {
  Start = 0,
  Center = 1,
  End = 2,
  /** Fill the cross axis. The default for a split's two panes. */
  Stretch = 3,
}

/** Which axis a `Split` divides. */
export const enum Axis {
  /** Children side by side; the divider is vertical. */
  X = 0,
  /** Children stacked; the divider is horizontal. */
  Y = 1,
}

/**
 * The three dirty flags, as bits.
 *
 * They are **nested**: a widget that needs measuring also needs arranging (its
 * size feeds its parent's distribution) and painting (it will be a different size
 * on screen). Setters set one bit — the earliest stage that must re-run — and
 * `layout()` promotes, so the invariant is restored once per frame rather than
 * maintained in twenty setters.
 *
 * `Paint` propagates nowhere: a colour change moves nothing.
 */
export const enum Dirty {
  Clean = 0,
  Paint = 1,
  Arrange = 2,
  Measure = 4,
}

/** The narrowest a text field measures itself, before `minW` overrides it. */
export const FIELD_MIN_W: i32 = 96;

/** A rule is one pixel: that is the whole of its size. */
export const RULE_H: i32 = 1;

/** A split's divider, when the caller does not name a width. */
export const DIVIDER_PX: i32 = 4;

/**
 * The text arena's size.
 *
 * Every label, button and field in the tree shares it, and text is copied in when
 * it is authored. 16 KiB is ~4,000 dense characters of UI copy — an editor's whole
 * chrome is well under half of it. A tree that overflows keeps the prefix that
 * fits (a truncated label is a symptom; a blank one looks like a layout bug).
 */
export const TEXT_ARENA_BYTES: i32 = 16384;

/** What a label, button or field holds: a span of UTF-8 in the tree's arena. */
export class WidgetTree {
  /** The atlas pages, for text metrics and for the painter's cell arithmetic. */
  book: FontBook;
  /** The page a widget measures and draws with unless it names its own. */
  defaultPage: FontPage;
  /** `defaultPage`, as a `Theme`, for the arithmetic that wants only a grid. */
  theme: Theme;

  capacity: i32;
  /** Live widgets. `used` is the high-water mark and never falls. */
  live: i32 = 0;
  used: i32 = 0;
  /** The root slot, or -1 before `builder.root`. */
  root: i32 = -1;
  /** The pool's free list, threaded through `nextSibling`. */
  freeHead: i32 = -1;
  /** Allocations refused because the pool was full. */
  overflow: i32 = 0;
  /** Visits refused because the tree was deeper than `MAX_DEPTH`. */
  tooDeep: i32 = 0;

  // --- what the last `layout()` did, for the tests and for a status line -----
  /** Widgets whose size was recomputed. Zero on a resize, by design. */
  measures: i32 = 0;
  /** Widgets re-placed. */
  arranges: i32 = 0;

  // --- the viewport ---------------------------------------------------------
  //
  // The rectangle the tree is drawn into. `arrange` culls against it (a widget
  // that misses it is not visible and nothing inside it can be), and `paint`
  // pushes it as the painter's clip so the two cannot disagree about what is on
  // screen.
  clipX: i32 = 0;
  clipY: i32 = 0;
  clipW: i32 = 0;
  clipH: i32 = 0;

  // --- the text arena -------------------------------------------------------
  //
  // One run of bytes for every label in the tree, appended to as text is set.
  // This is what removes the per-frame `String.UTF8.encode` that `widget.ts`'s
  // `drawText` still pays: a label's text is encoded **when it is authored**, and
  // a frame only reads it.
  text: Uint8Array;
  textUsed: i32 = 0;

  // --- the pool -------------------------------------------------------------
  //
  // Twenty-seven runs of `capacity` numbers. `id` is what `Hits` records; `parent`,
  // `firstChild`, `lastChild` and `nextSibling` are the tree; everything else is
  // either geometry, a style, or a cached measurement.
  id: i32[];
  kind: i32[];
  parent: i32[];
  firstChild: i32[];
  lastChild: i32[];
  nextSibling: i32[];

  x: i32[];
  y: i32[];
  w: i32[];
  h: i32[];

  pad: i32[];
  /** Children between each pair in a row/column; a split's divider width. */
  gap: i32[];
  flex: i32[];
  minW: i32[];
  minH: i32[];
  align: i32[];
  /** `Axis` for a split; unread for every other kind. */
  axis: i32[];

  dirty: i32[];
  /** Whether the widget's rectangle meets the viewport, from the last arrange. */
  visible: bool[];
  /** Records this widget's own chrome emitted in the last paint. */
  cost: i32[];
  /** `cost` plus every descendant's, from the last paint. */
  subtree: i32[];

  textAt: i32[];
  textLen: i32[];
  /** The label's width in pixels, cached by measure so paint need not re-scan. */
  textW: i32[];
  page: FontPage[];
  colour: i32[];
  weight: i32[];

  /** A split's position, in pixels from the content edge. -1 until first arrange. */
  splitPx: i32[];

  /**
   * Size the pool, the arena, and pick the default page.
   *
   * `capacity` is clamped rather than trusted: a caller that computed it from a
   * config file should get a working tree at the pool's limit, not a 200 MB
   * allocation and not a silently truncated grid.
   */
  constructor(book: FontBook, capacity: i32 = WIDGET_CAPACITY) {
    const cap: i32 = capacity > 0 ? (capacity <= 4096 ? capacity : 4096) : WIDGET_CAPACITY;
    const page: FontPage = book.pages[0];
    // Locals first: TensionScript refuses to read `this` before every field has
    // been assigned, and sizing an array from `this.capacity` is exactly that.
    const ids = new Array<i32>(cap);
    const kinds = new Array<i32>(cap);
    // `kind` starts at KIND_NONE so a slot that was never allocated is not live.
    for (let i: i32 = 0; i < cap; i++) kinds[i] = KIND_NONE;

    this.book = book;
    this.theme = page;
    this.defaultPage = page;
    this.capacity = cap;
    this.text = new Uint8Array(TEXT_ARENA_BYTES);

    this.id = ids;
    this.kind = kinds;
    this.parent = new Array<i32>(cap);
    this.firstChild = new Array<i32>(cap);
    this.lastChild = new Array<i32>(cap);
    this.nextSibling = new Array<i32>(cap);
    this.x = new Array<i32>(cap);
    this.y = new Array<i32>(cap);
    this.w = new Array<i32>(cap);
    this.h = new Array<i32>(cap);
    this.pad = new Array<i32>(cap);
    this.gap = new Array<i32>(cap);
    this.flex = new Array<i32>(cap);
    this.minW = new Array<i32>(cap);
    this.minH = new Array<i32>(cap);
    this.align = new Array<i32>(cap);
    this.axis = new Array<i32>(cap);
    this.dirty = new Array<i32>(cap);
    this.visible = new Array<bool>(cap);
    this.cost = new Array<i32>(cap);
    this.subtree = new Array<i32>(cap);
    this.textAt = new Array<i32>(cap);
    this.textLen = new Array<i32>(cap);
    this.textW = new Array<i32>(cap);
    this.page = new Array<FontPage>(cap);
    this.colour = new Array<i32>(cap);
    this.weight = new Array<i32>(cap);
    this.splitPx = new Array<i32>(cap);
  }

  // ── the pool ────────────────────────────────────────────────────────────

  /**
   * Take a slot, or -1 when the pool is full.
   *
   * A new widget is dirty at the *measure* level: it has never had a size, and
   * whoever linked it is marked up the tree by `append`, so the next `layout()`
   * reaches it. Nothing is measured here — allocating during authoring keeps
   * authoring out of the pass.
   */
  alloc(kind: i32): i32 {
    let i: i32 = -1;
    if (this.freeHead >= 0) {
      i = this.freeHead;
      this.freeHead = this.nextSibling[i];
    } else if (this.used < this.capacity) {
      i = this.used;
      this.used++;
    } else {
      this.overflow++;
      return -1;
    }

    this.live++;
    this.kind[i] = kind;
    this.id[i] = i;
    this.parent[i] = -1;
    this.firstChild[i] = -1;
    this.lastChild[i] = -1;
    this.nextSibling[i] = -1;
    this.x[i] = 0;
    this.y[i] = 0;
    this.w[i] = 0;
    this.h[i] = 0;
    this.pad[i] = 0;
    this.gap[i] = 0;
    this.flex[i] = 0;
    this.minW[i] = 0;
    this.minH[i] = 0;
    this.align[i] = Align.Start;
    this.axis[i] = Axis.X;
    this.dirty[i] = Dirty.Measure;
    this.visible[i] = false;
    this.cost[i] = 0;
    this.subtree[i] = 0;
    this.textAt[i] = 0;
    this.textLen[i] = 0;
    this.textW[i] = 0;
    this.page[i] = this.defaultPage;
    this.colour[i] = 0;
    this.weight[i] = 0;
    this.splitPx[i] = -1;
    return i;
  }

  /**
   * Give a slot back, and everything under it.
   *
   * Post-order, because freeing a parent first would lose its child list. The
   * slot goes on the free list threaded through `nextSibling`, which is dead for a
   * detached widget — one array doing two jobs, and the list cannot outlive the
   * tree that owns it.
   */
  remove(i: i32): void {
    if (i < 0 || i >= this.used || this.kind[i] == KIND_NONE) return;
    let c: i32 = this.firstChild[i];
    while (c >= 0) {
      const next: i32 = this.nextSibling[c];
      this.remove(c);
      c = next;
    }
    this.detach(i);
    if (this.root == i) this.root = -1;
    this.kind[i] = KIND_NONE;
    this.visible[i] = false;
    this.firstChild[i] = -1;
    this.lastChild[i] = -1;
    this.nextSibling[i] = this.freeHead;
    this.freeHead = i;
    this.live--;
  }

  /** Empty the tree: every slot free, the arena reset, the counters cleared. */
  clear(): void {
    for (let i: i32 = 0; i < this.used; i++) {
      this.kind[i] = KIND_NONE;
      this.visible[i] = false;
    }
    this.live = 0;
    this.used = 0;
    this.root = -1;
    this.freeHead = -1;
    this.overflow = 0;
    this.tooDeep = 0;
    this.measures = 0;
    this.arranges = 0;
    this.textUsed = 0;
    this.clipX = 0;
    this.clipY = 0;
    this.clipW = 0;
    this.clipH = 0;
  }

  /**
   * Link `child` as the last child of `parent`.
   *
   * Refuses a cycle by walking the parent chain — `append(a, b)` then `append(b, a)`
   * would otherwise make a stack overflow rather than an error, and both passes are
   * recursive. The refusal is silent (the shape is the caller's bug) but the tree
   * stays valid, which is the property that matters.
   */
  append(parent: i32, child: i32): void {
    if (parent < 0 || child < 0) return;
    if (parent == child) return;
    if (parent >= this.used || child >= this.used) return;
    if (this.kind[parent] == KIND_NONE || this.kind[child] == KIND_NONE) return;
    if (this.isAncestor(child, parent)) return;

    this.detach(child);
    this.parent[child] = parent;
    const last: i32 = this.lastChild[parent];
    if (last < 0) this.firstChild[parent] = child;
    else this.nextSibling[last] = child;
    this.lastChild[parent] = child;
    this.nextSibling[child] = -1;

    // A new child changes the parent's content size, which changes the grandparent's
    // distribution: the whole chain up must re-measure.
    this.markMeasure(parent);
    this.dirty[child] |= Dirty.Measure;
  }

  /** Unlink `child` from its parent. The slot stays live; `remove` frees it. */
  detach(child: i32): void {
    if (child < 0 || child >= this.used) return;
    const p: i32 = this.parent[child];
    if (p < 0) return;
    let prev: i32 = -1;
    let c: i32 = this.firstChild[p];
    while (c >= 0 && c != child) {
      prev = c;
      c = this.nextSibling[c];
    }
    if (c == child) {
      if (prev < 0) this.firstChild[p] = this.nextSibling[child];
      else this.nextSibling[prev] = this.nextSibling[child];
      if (this.lastChild[p] == child) this.lastChild[p] = prev;
    }
    this.parent[child] = -1;
    this.nextSibling[child] = -1;
    if (c == child) this.markMeasure(p);
  }

  /** Whether `maybeAncestor` is `node` or above it. */
  isAncestor(maybeAncestor: i32, node: i32): bool {
    let c: i32 = node;
    let guard: i32 = 0;
    while (c >= 0 && guard <= this.capacity) {
      if (c == maybeAncestor) return true;
      c = this.parent[c];
      guard++;
    }
    return false;
  }

  /** How many children a widget has. O(n) in the sibling list, called rarely. */
  childCount(i: i32): i32 {
    let n: i32 = 0;
    let c: i32 = this.firstChild[i];
    while (c >= 0) {
      n++;
      c = this.nextSibling[c];
    }
    return n;
  }

  /** The live slot that carries `id`, or -1. A click's one lookup. */
  slotOf(id: i32): i32 {
    for (let i: i32 = 0; i < this.used; i++) {
      if (this.kind[i] != KIND_NONE && this.id[i] == id) return i;
    }
    return -1;
  }

  /**
   * Records the whole tree emitted in the last paint.
   *
   * Not `get cost`: `cost` is the per-widget array, and a getter of that name is a
   * duplicate property rather than an overload.
   */
  totalCost(): i32 {
    const r: i32 = this.root;
    return r < 0 ? 0 : this.subtree[r];
  }

  /** Widgets the last paint skipped, because the budget ran out or they were culled. */
  skipped: i32 = 0;
  /** Widgets that will be repainted, counted before the paint that clears them. */
  paintDirty(): i32 {
    let n: i32 = 0;
    for (let i: i32 = 0; i < this.used; i++) {
      if (this.kind[i] != KIND_NONE && (this.dirty[i] & Dirty.Paint) != 0) n++;
    }
    return n;
  }

  // ── text ────────────────────────────────────────────────────────────────

  /**
   * Set a widget's text from a string.
   *
   * Encoded **once**, here — this is the allocation `drawText` pays per frame and
   * this path does not. A string that fits in the room the widget already has is
   * rewritten in place, so editing a field does not grow the arena by one copy per
   * keystroke; anything longer is appended.
   */
  setText(i: i32, value: string): void {
    if (i < 0 || i >= this.used) return;
    const encoded = Uint8Array.wrap(String.UTF8.encode(value, false));
    this.setTextBytes(i, encoded, 0, i32(encoded.length));
  }

  /**
   * `setText` for bytes the caller already encoded. Copied into the arena.
   *
   * The arena only grows, and a widget reuses its own run when the new text fits
   * in it. That is what keeps a text field from appending one copy per keystroke:
   * typing "hello" into a five-byte run rewrites five bytes and moves nothing.
   */
  setTextBytes(i: i32, bytes: Uint8Array, start: i32, len: i32): void {
    if (i < 0 || i >= this.used) return;
    const n: i32 = len > 0 ? len : 0;

    // Reuse the widget's own run when it is big enough, else take the tail.
    let at: i32 = this.textAt[i];
    if (this.textLen[i] <= 0 || n > this.textLen[i]) at = this.textUsed;

    // Room in the arena from `at`. A text that does not fit keeps the prefix that
    // does: a truncated label is a visible symptom, and a blank one is
    // indistinguishable from a bug in the layout.
    let room: i32 = this.text.length - at;
    if (room < 0) room = 0;
    const take: i32 = n < room ? n : room;

    for (let k: i32 = 0; k < take; k++) this.text[at + k] = bytes[start + k];
    this.textAt[i] = at;
    this.textLen[i] = take;
    if (at + take > this.textUsed) this.textUsed = at + take;
    this.markMeasure(i);
  }

  /** The page a widget measures and draws with. */
  setPage(i: i32, page: FontPage): void {
    if (i < 0 || i >= this.used) return;
    if (this.page[i] == page) return;
    this.page[i] = page;
    // A different page is a different advance table: the text no longer measures
    // what it did, and nothing about its geometry can be reused.
    this.markMeasure(i);
  }

  /** The width the last measure computed for a label, in pixels. */
  textWidth(i: i32): i32 {
    if (i < 0 || i >= this.used) return 0;
    return this.textW[i];
  }

  /** Measure a widget's own text, from the arena. */
  private measureOwnText(i: i32): i32 {
    const n: i32 = this.textLen[i];
    if (n <= 0) return 0;
    return this.book.measure(this.page[i], this.weight[i], this.text, this.textAt[i], n);
  }

  // ── flags ───────────────────────────────────────────────────────────────

  /**
   * Mark the chain from `i` to the root as needing a measure.
   *
   * Up, not down: a widget's size feeds its parent's content size, and nothing
   * below it changes when it grows.
   */
  markMeasure(i: i32): void {
    let c: i32 = i;
    let guard: i32 = 0;
    while (c >= 0 && c < this.used && guard <= this.capacity) {
      this.dirty[c] |= Dirty.Measure;
      c = this.parent[c];
      guard++;
    }
  }

  /**
   * Mark `i` and its ancestors as needing an arrange.
   *
   * Up, because a widget's size may have changed and its parent's distribution
   * depends on it. The downward half of the propagation happens in the arrange
   * pass itself: a container that re-places a child flags it, because a child whose
   * rectangle was just assigned must re-place *its* children. Setting those flags
   * here as well would be the same work done twice.
   */
  markArrange(i: i32): void {
    let c: i32 = i;
    let guard: i32 = 0;
    while (c >= 0 && c < this.used && guard <= this.capacity) {
      this.dirty[c] |= Dirty.Arrange;
      c = this.parent[c];
      guard++;
    }
  }

  /** Mark one widget as needing a repaint. Goes nowhere: colour moves nothing. */
  markPaint(i: i32): void {
    if (i < 0 || i >= this.used) return;
    this.dirty[i] |= Dirty.Paint;
  }

  /** Restore the nesting the setters were allowed to leave implicit. */
  private promote(): void {
    for (let i: i32 = 0; i < this.used; i++) {
      if (this.kind[i] == KIND_NONE) continue;
      const d: i32 = this.dirty[i];
      if ((d & Dirty.Measure) != 0) {
        this.dirty[i] = d | Dirty.Arrange | Dirty.Paint;
      } else if ((d & Dirty.Arrange) != 0) {
        this.dirty[i] = d | Dirty.Paint;
      }
    }
  }

  // ── the passes ──────────────────────────────────────────────────────────

  /** Give the root its rectangle and mark it for layout. A resize is exactly this. */
  resize(w: i32, h: i32): void {
    const r: i32 = this.root;
    if (r < 0) return;
    const rw: i32 = w > 0 ? w : 0;
    const rh: i32 = h > 0 ? h : 0;
    this.w[r] = rw;
    this.h[r] = rh;
    // The viewport follows the window unless a caller says otherwise: culling
    // against a stale rectangle is the failure mode that produces "the UI is
    // blank but the records are there".
    this.clipX = 0;
    this.clipY = 0;
    this.clipW = rw;
    this.clipH = rh;
    this.markArrange(r);
  }

  /** Restrict the tree to a rectangle: culling here, the painter's clip there. */
  setViewport(x: i32, y: i32, w: i32, h: i32): void {
    this.clipX = x;
    this.clipY = y;
    this.clipW = w > 0 ? w : 0;
    this.clipH = h > 0 ? h : 0;
    // Visibility is derived from the clip, so a new clip means every rect must be
    // tested again — which is an arrange, since that is the pass that knows rects.
    const r: i32 = this.root;
    if (r >= 0) this.markArrange(r);
  }

  /**
   * Run whichever passes are needed, and nothing else.
   *
   * The counters are reset first so a test (or a status line) reads this frame's
   * work rather than the tree's lifetime: `measures == 0` after a resize is the
   * assertion, and it is only meaningful if something set it to zero.
   */
  layout(): void {
    this.measures = 0;
    this.arranges = 0;
    const r: i32 = this.root;
    if (r < 0) return;
    this.promote();
    if ((this.dirty[r] & Dirty.Measure) == 0 && (this.dirty[r] & Dirty.Arrange) == 0) return;
    if ((this.dirty[r] & Dirty.Measure) != 0) this.measureAt(r, 0);
    if ((this.dirty[r] & Dirty.Arrange) != 0) this.arrangeAt(r, 0);
  }

  // --- measure: bottom-up --------------------------------------------------

  /**
   * Recompute the sizes in a dirty subtree.
   *
   * The recursion is gated on the flag, which is sound because `markMeasure`
   * marks the whole chain to the root: a dirty descendant implies a dirty
   * ancestor, so the walk cannot skip a subtree that needs work and cannot visit
   * one that does not.
   */
  private measureAt(i: i32, depth: i32): void {
    if (depth > MAX_DEPTH) {
      this.tooDeep++;
      return;
    }
    if ((this.dirty[i] & Dirty.Measure) == 0) return;
    let c: i32 = this.firstChild[i];
    while (c >= 0) {
      this.measureAt(c, depth + 1);
      c = this.nextSibling[c];
    }
    this.measureSelf(i);
    this.dirty[i] = this.dirty[i] & ~Dirty.Measure;
    this.measures++;
  }

  /** A widget's content size, from its kind and its children. */
  private measureSelf(i: i32): void {
    const k: i32 = this.kind[i];
    const page: FontPage = this.page[i];
    const pad: i32 = this.pad[i];

    if (k == Kind.Label) {
      const tw: i32 = this.measureOwnText(i);
      this.textW[i] = tw;
      this.w[i] = tw;
      this.h[i] = page.lineStep;
      this.floorToMin(i);
      return;
    }

    if (k == Kind.Button) {
      const tw: i32 = this.measureOwnText(i);
      this.textW[i] = tw;
      this.w[i] = tw + 2 * pad;
      this.h[i] = page.lineStep + 2 * pad;
      this.floorToMin(i);
      return;
    }

    if (k == Kind.TextField) {
      const tw: i32 = this.measureOwnText(i);
      this.textW[i] = tw;
      // A field's intrinsic width is a floor, not a measurement: its text is the
      // *content*, and content that grows a field's box makes a form that jumps
      // while you type. `minW` overrides the floor.
      this.w[i] = this.minW[i] > 0 ? this.minW[i] : FIELD_MIN_W;
      this.h[i] = page.lineStep + 2 * pad;
      this.floorToMin(i);
      return;
    }

    if (k == Kind.Spacer) {
      this.textW[i] = 0;
      this.w[i] = 0;
      this.h[i] = 0;
      return;
    }

    if (k == Kind.Rule) {
      this.w[i] = 0;
      this.h[i] = RULE_H;
      this.floorToMin(i);
      return;
    }

    if (k == Kind.Row || k == Kind.Column) {
      // Both axes from the children: `contentW`/`contentH` each walk the list once
      // and know which axis they are summing, so a row and a column share them.
      this.w[i] = this.contentW(i);
      this.h[i] = this.contentH(i);
      this.floorToMin(i);
      return;
    }

    // The root's rectangle is the window's, not its content's: `resize` owns it,
    // and re-deriving it from the children would make a window smaller than its
    // content refuse to shrink.
    if (k == Kind.Root) return;

    if (k == Kind.Split) {
      const a: i32 = this.firstChild[i];
      const b: i32 = a >= 0 ? this.nextSibling[a] : -1;
      if (a < 0 || b < 0) {
        this.w[i] = 2 * pad;
        this.h[i] = 2 * pad;
        this.floorToMin(i);
        return;
      }
      const div: i32 = this.gap[i] > 0 ? this.gap[i] : DIVIDER_PX;
      if (this.axis[i] == Axis.X) {
        this.w[i] = this.w[a] + this.w[b] + div + 2 * pad;
        this.h[i] = (this.h[a] > this.h[b] ? this.h[a] : this.h[b]) + 2 * pad;
      } else {
        this.w[i] = (this.w[a] > this.w[b] ? this.w[a] : this.w[b]) + 2 * pad;
        this.h[i] = this.h[a] + this.h[b] + div + 2 * pad;
      }
      this.floorToMin(i);
      return;
    }
  }

  /** A row/column's content width: children plus gaps plus padding. */
  private contentW(i: i32): i32 {
    const pad: i32 = this.pad[i];
    const horizontal: bool = this.kind[i] == Kind.Row;
    let sum: i32 = 0;
    let cross: i32 = 0;
    let n: i32 = 0;
    let c: i32 = this.firstChild[i];
    while (c >= 0) {
      if (horizontal) {
        sum += this.w[c];
        if (this.h[c] > cross) cross = this.h[c];
      } else {
        if (this.w[c] > cross) cross = this.w[c];
      }
      n++;
      c = this.nextSibling[c];
    }
    if (horizontal) {
      const gaps: i32 = n > 1 ? this.gap[i] * (n - 1) : 0;
      return sum + gaps + 2 * pad;
    }
    return cross + 2 * pad;
  }

  /** The same on the other axis. */
  private contentH(i: i32): i32 {
    const pad: i32 = this.pad[i];
    const horizontal: bool = this.kind[i] == Kind.Row;
    let sum: i32 = 0;
    let cross: i32 = 0;
    let n: i32 = 0;
    let c: i32 = this.firstChild[i];
    while (c >= 0) {
      if (horizontal) {
        if (this.h[c] > cross) cross = this.h[c];
      } else {
        sum += this.h[c];
        if (this.w[c] > cross) cross = this.w[c];
      }
      n++;
      c = this.nextSibling[c];
    }
    if (horizontal) return cross + 2 * pad;
    const gaps: i32 = n > 1 ? this.gap[i] * (n - 1) : 0;
    return sum + gaps + 2 * pad;
  }

  /** Apply the widget's own size floors. */
  private floorToMin(i: i32): void {
    if (this.w[i] < this.minW[i]) this.w[i] = this.minW[i];
    if (this.h[i] < this.minH[i]) this.h[i] = this.minH[i];
  }

  // --- arrange: top-down ---------------------------------------------------

  /**
   * Place the children of a dirty container, then recurse.
   *
   * Every child gets `Arrange` set before the recursion — that is the downward
   * half of the propagation, and it is here rather than in `markArrange` because
   * this is the only place that can know the child's rectangle just changed.
   */
  private arrangeAt(i: i32, depth: i32): void {
    if (depth > MAX_DEPTH) {
      this.tooDeep++;
      return;
    }
    if ((this.dirty[i] & Dirty.Arrange) == 0) return;
    this.arranges++;
    // Visibility is a property of the rectangle `arrange` just gave the widget, so
    // it is computed here and nowhere else. It has to be computed for the widget
    // being arranged, not only for its children: the root has no parent to test it,
    // and a root left `false` culls the whole tree — which is exactly the bug this
    // line fixed (a paint that emitted zero records while every child was visible).
    this.visible[i] = this.meetsViewport(i);

    const k: i32 = this.kind[i];
    if (k == Kind.Root || k == Kind.Column) this.placeColumn(i);
    else if (k == Kind.Row) this.placeRow(i);
    else if (k == Kind.Split) this.placeSplit(i);

    this.dirty[i] = this.dirty[i] & ~Dirty.Arrange;

    let c: i32 = this.firstChild[i];
    while (c >= 0) {
      this.dirty[c] |= Dirty.Arrange;
      this.arrangeAt(c, depth + 1);
      c = this.nextSibling[c];
    }
  }

  /** Whether a widget's rectangle meets the viewport. */
  private meetsViewport(i: i32): bool {
    const x0: i32 = this.x[i];
    const y0: i32 = this.y[i];
    if (x0 >= this.clipX + this.clipW || x0 + this.w[i] <= this.clipX) return false;
    if (y0 >= this.clipY + this.clipH || y0 + this.h[i] <= this.clipY) return false;
    return true;
  }

  /**
   * A row: main axis `x`, cross axis `y`.
   *
   * ## The flex rule, exactly
   *
   * `inner = w - 2*pad - gap*(n-1)` is what the children share. A child with
   * `flex == 0` keeps its measured width; the rest split `free = inner - fixed`.
   *
   * Every flex child but the **last** gets `free * flex / flexTotal` — integer
   * division, floored. The last gets `free - given`, the residual. That is not a
   * rounding refinement, it is what makes the row *exactly* as wide as it says:
   * distributing a remainder after the fact is the same arithmetic with two more
   * places for it to drift, and a one-pixel gap at the end of a toolbar is visible
   * as a stripe. A child claiming a share smaller than its `minW` is floored to
   * `minW`; the last flex child then absorbs the difference, which is what a
   * flexbox does and is why the floor is applied before `given` is accumulated.
   */
  private placeRow(i: i32): void {
    const pad: i32 = this.pad[i];
    const gap: i32 = this.gap[i];
    const innerX: i32 = this.x[i] + pad;
    const innerY: i32 = this.y[i] + pad;
    const innerW: i32 = this.w[i] - 2 * pad;
    const innerH: i32 = this.h[i] - 2 * pad;

    let n: i32 = 0;
    let fixed: i32 = 0;
    let flexTotal: i32 = 0;
    let lastFlex: i32 = -1;
    let c: i32 = this.firstChild[i];
    while (c >= 0) {
      n++;
      if (this.flex[c] > 0) {
        flexTotal += this.flex[c];
        lastFlex = c;
      } else {
        fixed += this.w[c];
      }
      c = this.nextSibling[c];
    }

    const gaps: i32 = n > 1 ? gap * (n - 1) : 0;
    let avail: i32 = innerW - gaps;
    if (avail < 0) avail = 0;
    let free: i32 = avail - fixed;
    if (free < 0) free = 0;

    let given: i32 = 0;
    let cursor: i32 = innerX;
    c = this.firstChild[i];
    while (c >= 0) {
      let cw: i32 = this.w[c];
      const fl: i32 = this.flex[c];
      if (fl > 0) {
        cw = c == lastFlex ? free - given : free * fl / flexTotal;
        if (cw < this.minW[c]) cw = this.minW[c];
        given += cw;
      }
      this.x[c] = cursor;
      this.w[c] = cw;
      this.placeCross(c, innerY, innerH);
      cursor += cw + gap;
      c = this.nextSibling[c];
    }
  }

  /** A column (and the root): main axis `y`. The transpose of `placeRow`. */
  private placeColumn(i: i32): void {
    const pad: i32 = this.pad[i];
    const gap: i32 = this.gap[i];
    const innerX: i32 = this.x[i] + pad;
    const innerY: i32 = this.y[i] + pad;
    const innerW: i32 = this.w[i] - 2 * pad;
    const innerH: i32 = this.h[i] - 2 * pad;

    let n: i32 = 0;
    let fixed: i32 = 0;
    let flexTotal: i32 = 0;
    let lastFlex: i32 = -1;
    let c: i32 = this.firstChild[i];
    while (c >= 0) {
      n++;
      if (this.flex[c] > 0) {
        flexTotal += this.flex[c];
        lastFlex = c;
      } else {
        fixed += this.h[c];
      }
      c = this.nextSibling[c];
    }

    const gaps: i32 = n > 1 ? gap * (n - 1) : 0;
    let avail: i32 = innerH - gaps;
    if (avail < 0) avail = 0;
    let free: i32 = avail - fixed;
    if (free < 0) free = 0;

    let given: i32 = 0;
    let cursor: i32 = innerY;
    c = this.firstChild[i];
    while (c >= 0) {
      let ch: i32 = this.h[c];
      const fl: i32 = this.flex[c];
      if (fl > 0) {
        ch = c == lastFlex ? free - given : free * fl / flexTotal;
        if (ch < this.minH[c]) ch = this.minH[c];
        given += ch;
      }
      this.y[c] = cursor;
      this.h[c] = ch;
      this.placeCrossY(c, innerX, innerW);
      cursor += ch + gap;
      c = this.nextSibling[c];
    }
  }

  /** Cross-axis placement for a row: `y` inside `[top, top+height)`. */
  private placeCross(c: i32, top: i32, height: i32): void {
    const a: i32 = this.align[c];
    if (a == Align.Stretch) {
      this.y[c] = top;
      this.h[c] = height > 0 ? height : 0;
      return;
    }
    const ch: i32 = this.h[c];
    if (a == Align.Center) this.y[c] = top + (height - ch) / 2;
    else if (a == Align.End) this.y[c] = top + height - ch;
    else this.y[c] = top;
  }

  /** Cross-axis placement for a column: `x` inside `[left, left+width)`. */
  private placeCrossY(c: i32, left: i32, width: i32): void {
    const a: i32 = this.align[c];
    if (a == Align.Stretch) {
      this.x[c] = left;
      this.w[c] = width > 0 ? width : 0;
      return;
    }
    const cw: i32 = this.w[c];
    if (a == Align.Center) this.x[c] = left + (width - cw) / 2;
    else if (a == Align.End) this.x[c] = left + width - cw;
    else this.x[c] = left;
  }

  /**
   * A split: two panes and a divider, with the divider's position as state.
   *
   * `splitPx` is **clamped at the start of every arrange**, not only when a drag
   * moves it. That is what makes the pane survive a resize: a window narrowed past
   * the smaller pane's minimum would otherwise leave the divider outside the frame,
   * and a drag handler would then be asked to fix a number the layout had already
   * invalidated. Clamping first means the state is always a legal position.
   */
  private placeSplit(i: i32): void {
    const a: i32 = this.firstChild[i];
    const b: i32 = a >= 0 ? this.nextSibling[a] : -1;
    if (a < 0 || b < 0) return;

    const pad: i32 = this.pad[i];
    const div: i32 = this.gap[i] > 0 ? this.gap[i] : DIVIDER_PX;
    const innerX: i32 = this.x[i] + pad;
    const innerY: i32 = this.y[i] + pad;
    const innerW: i32 = this.w[i] - 2 * pad;
    const innerH: i32 = this.h[i] - 2 * pad;
    const horizontal: bool = this.axis[i] == Axis.X;

    const total: i32 = horizontal ? innerW : innerH;
    let content: i32 = total - div;
    if (content < 0) content = 0;

    const minA: i32 = horizontal ? this.minW[a] : this.minH[a];
    const minB: i32 = horizontal ? this.minW[b] : this.minH[b];
    let lo: i32 = minA > 0 ? minA : 0;
    let hi: i32 = content - (minB > 0 ? minB : 0);
    if (hi < lo) hi = lo;

    let sp: i32 = this.splitPx[i];
    if (sp < 0) sp = content / 2;
    if (sp < lo) sp = lo;
    if (sp > hi) sp = hi;
    if (sp < 0) sp = 0;
    this.splitPx[i] = sp;

    if (horizontal) {
      const ab: i32 = content - sp > 0 ? content - sp : 0;
      this.x[a] = innerX;
      this.y[a] = innerY;
      this.w[a] = sp;
      this.h[a] = innerH > 0 ? innerH : 0;
      this.x[b] = innerX + sp + div;
      this.y[b] = innerY;
      this.w[b] = ab;
      this.h[b] = innerH > 0 ? innerH : 0;
    } else {
      const bb: i32 = content - sp > 0 ? content - sp : 0;
      this.x[a] = innerX;
      this.y[a] = innerY;
      this.w[a] = innerW > 0 ? innerW : 0;
      this.h[a] = sp;
      this.x[b] = innerX;
      this.y[b] = innerY + sp + div;
      this.w[b] = innerW > 0 ? innerW : 0;
      this.h[b] = bb;
    }
  }

  // ── paint ───────────────────────────────────────────────────────────────

  /**
   * Draw the tree, and record its click targets as it draws.
   *
   * Pre-order, visible subtrees only, into the painter's clip — which is the
   * tree's viewport intersected with whatever the caller had already pushed. The
   * intersection is what makes a widget that scrolled out cost nothing: `visible`
   * was decided during arrange, so the walk stops at the container rather than at
   * every leaf inside it.
   *
   * `hits` is emptied here (`begin`) because the draw is what defines the frame's
   * targets; a caller that owns its own list passes it in and reads it back after.
   */
  paint(p: Painter, hits: Hits | null = null): void {
    const r: i32 = this.root;
    if (r < 0) return;
    this.skipped = 0;
    p.pushClip(this.clipX, this.clipY, this.clipW, this.clipH);
    if (hits != null) {
      p.useHits(hits);
      hits.begin();
    }
    this.paintAt(r, p, 0);
    if (hits != null) p.useHits(null);
    p.popClip();
  }

  /** Paint one subtree; returns the records it emitted, for `subtree`. */
  private paintAt(i: i32, p: Painter, depth: i32): i32 {
    if (depth > MAX_DEPTH) return 0;
    if (!this.visible[i]) {
      this.skipped++;
      this.subtree[i] = 0;
      return 0;
    }
    if (p.full) {
      this.skipped++;
      this.subtree[i] = 0;
      return 0;
    }

    const before: i32 = p.count;
    this.paintSelf(i, p);
    const own: i32 = p.count - before;
    this.cost[i] = own;
    // A painted widget is painted: the flag has done its job. Clearing it here
    // rather than in a separate sweep is what stops the flags from accumulating
    // into "everything is always dirty", which is the state a UI that never reads
    // them drifts into.
    this.dirty[i] = this.dirty[i] & ~Dirty.Paint;

    let total: i32 = own;
    let c: i32 = this.firstChild[i];
    while (c >= 0) {
      total += this.paintAt(c, p, depth + 1);
      c = this.nextSibling[c];
    }
    this.subtree[i] = total;
    return total;
  }

  /** One widget's own records: its chrome, its label, and its hit target. */
  private paintSelf(i: i32, p: Painter): void {
    const k: i32 = this.kind[i];
    const page: FontPage = this.page[i];
    const x: i32 = this.x[i];
    const y: i32 = this.y[i];
    const w: i32 = this.w[i];
    const h: i32 = this.h[i];

    if (k == Kind.Label) {
      this.paintText(i, p, x, y, w, h);
      return;
    }

    if (k == Kind.Button) {
      p.fill(x, y, w, h, page.chromeCell(Chrome.Selection), page);
      // A bright top edge is the whole of a raised state at this size: no radius,
      // no shadow, and no colour to darken (`widget.ts` measured that choice).
      p.fill(x, y, w, 1, page.chromeCell(Chrome.White), page);
      const tx: i32 = x + (w - this.textW[i]) / 2;
      const ty: i32 = y + (h - page.lineStep) / 2;
      this.paintText(i, p, tx, ty, this.textW[i], page.lineStep);
      p.addHit(x, y, w, h, this.id[i], Kind.Button);
      return;
    }

    if (k == Kind.TextField) {
      p.fill(x, y, w, h, page.chromeCell(Chrome.Surface), page);
      p.hline(x, y + h - 1, w, page.chromeCell(Chrome.Underline), page);
      this.paintText(i, p, x + this.pad[i], y, w - 2 * this.pad[i], h);
      p.addHit(x, y, w, h, this.id[i], Kind.TextField);
      return;
    }

    if (k == Kind.Rule) {
      p.hline(x, y, w, page.chromeCell(Chrome.Divider), page);
      return;
    }

    if (k == Kind.Split) {
      const a: i32 = this.firstChild[i];
      if (a < 0) return;
      const div: i32 = this.gap[i] > 0 ? this.gap[i] : DIVIDER_PX;
      const pad: i32 = this.pad[i];
      if (this.axis[i] == Axis.X) {
        p.fill(this.x[a] + this.w[a], y + pad, div, h - 2 * pad,
               page.chromeCell(Chrome.Divider), page);
      } else {
        p.fill(x + pad, this.y[a] + this.h[a], w - 2 * pad, div,
               page.chromeCell(Chrome.Divider), page);
      }
      return;
    }

    // Rows, columns, the root and spacers draw nothing: black is the background
    // and a filled panel costs the frame's whole record budget (`theme.ts`).
  }

  /** A label's glyphs, clipped to its own box. */
  private paintText(i: i32, p: Painter, x: i32, y: i32, w: i32, h: i32): void {
    const n: i32 = this.textLen[i];
    if (n <= 0 || w <= 0 || h <= 0) return;
    p.pushClip(x, y, w, h);
    p.textBytes(this.text, this.textAt[i], n, x, y, this.colour[i], this.weight[i],
                0, y, y + h, this.page[i]);
    p.popClip();
  }
}
