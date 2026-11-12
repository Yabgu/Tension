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

import { Ui, WidgetBehavior } from "./builder";
import { UiEvent } from "./event-def";
import { Chrome, FontBook, FontPage } from "./fonts";
import { Hits } from "./hit";
import { Painter } from "./painter";
import { TextBuffer, TextBuilder, TextPool } from "./text";
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

/** What a widget is. */
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
  /** A recycled-row scroller. Owns a viewport for its own subtree. */
  List = 9,
  /** A track and a thumb over a fixed-point value. */
  Slider = 10,
  /**
   * A widget whose behavior was supplied by the caller.
   *
   * Not a behavior of its own — `ui.node(parent, new DockLayout())` sets
   * `behavior[slot]` to the instance and tags the slot with this. The tag exists so
   * introspection (`tree.kind[i]`) and the test suite can tell a custom widget from
   * a spacer, which is what `Kind.Custom` would otherwise be confused with.
   */
  Custom = 11,
}

/**
 * Widget state bits: what the pointer and the keyboard have done to it.
 *
 * Not a dirty flag — `Dirty` says what must be recomputed; this says what the
 * user is doing. A change here sets `Dirty.Paint` and nothing else, because
 * hover and press change no size and no position.
 */
export const enum State {
  None = 0,
  Hover = 1,
  Press = 2,
  Focus = 4,
  Disabled = 8,
}

/** A slider's range is fixed-point over 0..SLIDER_MAX, so no float crosses the UI. */
export const SLIDER_MAX: i32 = 1000;

/**
 * How far either side of a split's divider still grabs it.
 *
 * A divider is 1-4 px, which is a hairline to aim at. The hit rect is widened by
 * this many pixels each way at paint time — the drawn rule stays exactly as wide
 * as it was, because widening the *pixels* would move the panes.
 */
export const DIVIDER_GRAB: i32 = 3;

/** How many recycled rows a list has before the caller overrides it. */
export const LIST_ROWS: i32 = 40;

/** The narrowest a slider measures itself before `minW` overrides it. */
export const SLIDER_MIN_W: i32 = 120;

/** A slider's thumb, in pixels. Wider than tall: it reads as a grip, not a dot. */
export const SLIDER_THUMB_W: i32 = 9;
export const SLIDER_THUMB_H: i32 = 16;

/**
 * The stripe a disabled widget's text draws with.
 *
 * Muted, because a disabled control should look like a caption rather than like
 * something that failed. It is a *stripe*, not a tint — a record cannot be tinted
 * (`theme.ts`), so "disabled text" has to be a colour the atlas already bakes.
 */
const MUTED_COLOUR: i32 = 1;

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
 * What a virtualised `List` reads its rows from.
 *
 * A list cannot hold a thousand row widgets, so it holds a couple of dozen and
 * recycles them; the model is what says how many rows there are and what each one
 * says. `text` writes into the frame's `TextPool` rather than returning a
 * `String`, so filling a row allocates nothing.
 *
 * The contract is narrow on purpose: `text` **writes into `out` and nothing
 * else**. A model that set widget text itself would be a second author of the
 * row, and the list's own recycle logic is what decides which row shows what.
 */
export abstract class ListSource {
  abstract count(): i32;
  abstract text(index: i32, out: TextPool): void;
}

/**
 * What an unassigned slot does: nothing.
 *
 * Defined here rather than imported from `behavior.ts` so that this module never
 * needs `behavior.ts` at run time — the interface is the only thing it borrows, and
 * an interface is erased. That keeps the import graph acyclic in the direction that
 * matters: `builder` → `layout` is a real dependency, `layout` → `builder` is a type.
 */
class NoBehavior implements WidgetBehavior {
  measure(ui: Ui, id: i32): void {}
  arrange(ui: Ui, id: i32, x: i32, y: i32, w: i32, h: i32): void {}
  paint(ui: Ui, id: i32, p: Painter): void {}
  handle(ui: Ui, id: i32, ev: UiEvent): bool {
    return false;
  }
}

// Deliberately NOT a module-level `new`: this module imports `behavior.ts` only for
// the interface, and constructing an implementation at load time here ran before
// that module's own initialisation — an indirect call through a table slot that was
// not yet set, which is `wasm trap: uninitialized element`. The tree builds its
// sentinel in its constructor, after every module is loaded.
let SHARED_NO_BEHAVIOR: WidgetBehavior | null = null;

function noBehavior(): WidgetBehavior {
  if (SHARED_NO_BEHAVIOR == null) SHARED_NO_BEHAVIOR = new NoBehavior();
  return SHARED_NO_BEHAVIOR!;
}

/** The model of a list that has none: no rows, and it writes nothing. */
class EmptyListSource extends ListSource {
  count(): i32 {
    return 0;
  }

  text(index: i32, out: TextPool): void {}
}

/** What a label, button or field holds: a `TextBuffer` the widget owns. */
export class WidgetTree {
  /** The atlas pages, for text metrics and for the painter's cell arithmetic. */
  book: FontBook;
  /** The page a widget measures and draws with unless it names its own. */
  defaultPage: FontPage;
  /**
   * The buffer a widget with no text carries.
   *
   * A shared empty `TextBuffer` rather than a `null` in the array: the slot always
   * answers something, so `textLength`/`paintText` need no null check, and the first
   * `setText` replaces the reference with one the widget owns. Nothing ever writes
   * through this one (`setText` allocates when the slot still points here).
   */
  private emptyText: TextBuffer = new TextBuffer(1);
  /**
   * The model a list with no source reads from: it has no rows and writes nothing.
   *
   * A sentinel rather than a null for the same reason as `emptyText`, and compared
   * by identity where it matters (`placeList`) so a caller that sets row text
   * itself is not overwritten with nothing.
   */
  private noSource: ListSource = new EmptyListSource();
  /**
   * Scratch text for filling virtualised rows.
   *
   * Separate from the painter's pool on purpose. A list's rows are filled during
   * **arrange** and copied into each row's own buffer, so the bytes here never
   * outlive one row — while the painter's pool is rewound at `reset()` and holds
   * what the *draw* is about to read. Sharing one buffer between the two is a
   * question with no answer (who rewinds it?), and 2 KiB is cheaper than the
   * answer would be.
   */
  texts: TextPool = new TextPool(2048);
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
  /**
   * The subtrees queued for an arrange that does not start at the root.
   *
   * A list that scrolls must re-place its own rows and nothing else. Pushing the
   * list here is what lets `layout()` do that work without walking the ancestors
   * that did not change — and without a second `arrangeAt` from the root, which
   * would re-place the parent and defeat the purpose.
   *
   * A fixed array, drained every `layout()`. Past its capacity `reflowSubtree`
   * falls back to marking the root, so the tree is always correct; only the amount
   * of work differs.
   */
  private subtreeQueue: i32[] = new Array<i32>(32);
  private dirtySubtrees: i32 = 0;

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

  // --- the text -------------------------------------------------------------
  //
  // Every widget that carries text owns a `TextBuffer` (see `text.ts`): a
  // `Uint8Array`, a byte count, and a capacity that only grows. A set encodes
  // straight into it with `byteLength` + `encodeUnsafe`, so retyping a field that
  // already has room touches no heap, and a frame that changes nothing allocates
  // nothing at all. The buffer is created on the first `setText`, so a `Row` does
  // not carry one.
  textBuf: TextBuffer[];

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

  /** The label's width in pixels, cached by measure so paint need not re-scan. */
  textW: i32[];
  page: FontPage[];
  colour: i32[];
  weight: i32[];
  /** Where the text sits inside the widget's own box: `Align.Start/Center/End`. */
  textAlign: i32[];

  /** `State` bits: hover, press, focus, disabled. */
  state: i32[];

  /** A split's position, in pixels from the content edge. -1 until first arrange. */
  splitPx: i32[];
  /** A slider's position, `0..SLIDER_MAX`. */
  value: i32[];

  // --- text editing ---------------------------------------------------------
  /** Caret position as a **byte** offset into `textBuf`. */
  caret: i32[];
  /** Where a selection began, or -1. `caret` is the moving end. */
  selAnchor: i32[];

  // --- the list -------------------------------------------------------------
  /** Rows the list claims, which is not the number of widgets it has. */
  itemCount: i32[];
  /** One row's height. */
  itemH: i32[];
  /** Scroll offset in pixels, from the top of the content. */
  scrollY: i32[];
  /** The item a recycled row is currently showing, or -1. */
  itemIndex: i32[];
  /** Where the recycled rows start, in child order. */
  rowFirst: i32[];
  /** The model the rows are filled from, or null. */
  source: ListSource[];

  /**
   * The behavior that measures, arranges, paints and handles this slot.
   *
   * This array **is** the open extension point: the engine never asks a widget what
   * kind it is, it asks the widget's behavior what to do. A built-in kind's entry is
   * a shared singleton (behaviors are stateless); a custom widget's is the instance
   * the caller passed to `ui.node`.
   */
  behavior: WidgetBehavior[];

  /**
   * Whether this widget's children are clipped to its content box.
   *
   * A `List` sets it (its rows are positioned in scrolled coordinates, so a row out
   * of the window must be culled rather than drawn and clipped). Nothing else does:
   * a panel that clipped its children would cut off a focus ring at its own edge.
   *
   * It is a **flag**, not a fifth interface method, so the behavior contract stays
   * the four the brief names and a custom behavior can still opt in.
   */
  clipsChildren: bool[];

  /**
   * Whether the widget is **out of the layout and off the screen**.
   *
   * Not the same thing as `visible`, which is *derived* by arrange from the clip
   * and says "this rect met the viewport". `hidden` is the opposite direction: a
   * panel a user collapsed, or the whole editor chrome while a scene plays. A
   * hidden widget is skipped by its parent's flow — it takes no space, so a flex
   * sibling reclaims it — is not arranged, records nothing and therefore is not
   * clickable.
   *
   * It is data rather than a behavior concern for the same reason `clipsChildren`
   * is: a behavior cannot see its siblings, so "this panel is collapsed" is a
   * property of the tree, not of the panel.
   */
  hidden: bool[];

  /**
   * Whether a widget that is not a control still records a hit target.
   *
   * A `Label` is a caption and records nothing, which is why a click on a panel's
   * background goes to nobody. Some labels are targets all the same — the caption
   * beside a field, which should focus it — and this is that permission. Set with
   * `ui.clickable(id)`.
   */
  clickable: bool[];

  /**
   * The `Ui` the passes call behaviors with.
   *
   * Set by `Ui`'s constructor. The tree keeps the data and the walk; the behaviors
   * need the authoring/runtime facade, so the tree holds the one reference rather
   * than threading it through every recursive call.
   */
  host: Ui | null = null;

  /** The sentinel a slot with no assigned behavior holds. */
  private noBeh: WidgetBehavior;

  /** Whether Tab can reach this widget. */
  focusable: bool[];
  /** Whether a press on this widget takes mouse capture. */
  draggable: bool[];

  /**
   * The clip that was in force when this widget was last arranged.
   *
   * Remembered so that a subtree can be re-arranged **without** its ancestors:
   * a list that scrolls must re-place its own rows, and walking back up to the
   * root to re-derive the clip would re-arrange the parent — which is the work
   * `setViewport` on a subtree exists to avoid.
   */
  effX: i32[];
  effY: i32[];
  effW: i32[];
  effH: i32[];

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
    this.textW = new Array<i32>(cap);
    this.page = new Array<FontPage>(cap);
    this.colour = new Array<i32>(cap);
    this.weight = new Array<i32>(cap);
    this.textAlign = new Array<i32>(cap);
    this.state = new Array<i32>(cap);
    this.splitPx = new Array<i32>(cap);
    this.value = new Array<i32>(cap);
    this.caret = new Array<i32>(cap);
    this.selAnchor = new Array<i32>(cap);
    this.itemCount = new Array<i32>(cap);
    this.itemH = new Array<i32>(cap);
    this.scrollY = new Array<i32>(cap);
    this.itemIndex = new Array<i32>(cap);
    this.rowFirst = new Array<i32>(cap);
    this.source = new Array<ListSource>(cap);
    this.behavior = new Array<WidgetBehavior>(cap);
    this.clipsChildren = new Array<bool>(cap);
    this.hidden = new Array<bool>(cap);
    this.clickable = new Array<bool>(cap);
    this.focusable = new Array<bool>(cap);
    this.draggable = new Array<bool>(cap);
    this.effX = new Array<i32>(cap);
    this.effY = new Array<i32>(cap);
    this.effW = new Array<i32>(cap);
    this.effH = new Array<i32>(cap);
    this.textBuf = new Array<TextBuffer>(cap);
    // Built here, not at module load: see `noBehavior()`.
    this.noBeh = noBehavior();
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
    this.textW[i] = 0;
    this.page[i] = this.defaultPage;
    this.colour[i] = 0;
    this.weight[i] = 0;
    this.textAlign[i] = Align.Start;
    this.state[i] = State.None;
    this.splitPx[i] = -1;
    this.value[i] = 0;
    this.caret[i] = 0;
    this.selAnchor[i] = -1;
    this.itemCount[i] = 0;
    this.itemH[i] = 0;
    this.scrollY[i] = 0;
    this.itemIndex[i] = -1;
    this.rowFirst[i] = -1;
    this.source[i] = this.noSource;
    // A slot with no behavior assigned does nothing, which is the correct answer
    // for a slot the engine has not been told about — and it means no pass has to
    // check for a null.
    this.behavior[i] = this.noBeh;
    this.clipsChildren[i] = false;
    this.hidden[i] = false;
    this.clickable[i] = false;
    this.focusable[i] = false;
    this.draggable[i] = false;
    this.effX[i] = 0;
    this.effY[i] = 0;
    this.effW[i] = 0;
    this.effH[i] = 0;
    // Lazy: a Row must not carry a text buffer it will never use. The shared empty
    // buffer is what "no text" looks like, and `setText` swaps in a real one.
    this.textBuf[i] = this.emptyText;
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
    // The buffer belongs to the widget; a slot that is free must not keep text
    // alive, or a tree rebuilt every frame would leak one buffer per rebuild.
    this.textBuf[i] = this.emptyText;
    this.source[i] = this.noSource;
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
    this.dirtySubtrees = 0;
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
   * A widget's text buffer, created on first use.
   *
   * Lazy because most widgets are containers: a `Row` that never carries text
   * should not carry a `Uint8Array` either. `text.ts` explains the buffer.
   */
  bufferOf(i: i32): TextBuffer {
    if (i < 0 || i >= this.used) return this.emptyText;
    return this.textBuf[i];
  }

  /** A widget's live byte count, or 0. */
  textLength(i: i32): i32 {
    return i >= 0 && i < this.used ? this.textBuf[i].len : 0;
  }

  /**
   * Set a widget's text from a string.
   *
   * **No allocation** once the widget's buffer has room: `byteLength` counts and
   * `encodeUnsafe` writes into the buffer the widget already owns. This is the
   * difference between a frame that draws sixty labels and a frame that allocates
   * sixty `ArrayBuffer`s, which is what `drawText` used to cost.
   */
  setText(i: i32, value: string): void {
    if (i < 0 || i >= this.used) return;
    const b: TextBuffer = this.ownBuffer(i, String.UTF8.byteLength(value) + 8);
    b.set(value);
    this.afterText(i, b.len);
  }

  /**
   * The widget's own buffer, allocating one the first time it needs to write.
   *
   * The one place a `TextBuffer` is created, so "a widget that never carries text
   * never carries a buffer" is a property of one function rather than of four
   * setters remembering to check.
   */
  private ownBuffer(i: i32, need: i32): TextBuffer {
    let b: TextBuffer = this.textBuf[i];
    if (b == this.emptyText) {
      b = new TextBuffer(need > 32 ? need : 32);
      this.textBuf[i] = b;
    }
    return b;
  }

  /** `setText` for bytes the caller already has. Copied into the widget's buffer. */
  setTextBytes(i: i32, bytes: Uint8Array, start: i32, len: i32): void {
    if (i < 0 || i >= this.used) return;
    const b: TextBuffer = this.ownBuffer(i, len > 0 ? len : 32);
    b.setBytes(bytes, start, len > 0 ? len : 0);
    this.afterText(i, b.len);
  }

  /**
   * `setText` for a window of the frame pool.
   *
   * The path a virtualised list's rows take: the model wrote a row's text into the
   * pool, and one copy moves it into the row's own buffer. No allocation on either
   * side.
   */
  setTextSpan(i: i32, pool: TextPool): void {
    if (i < 0 || i >= this.used) return;
    const b: TextBuffer = this.ownBuffer(i, pool.len + 8);
    b.setSpan(pool);
    this.afterText(i, b.len);
  }

  /** `setText` for a builder's bytes. */
  setTextBuilder(i: i32, b: TextBuilder): void {
    this.setTextBytes(i, b.bytes, b.at, b.len);
  }

  /**
   * The caret follows the end when text is replaced wholesale, so a field whose
   * text is set by the app does not keep a caret past the end of it.
   */
  private afterText(i: i32, len: i32): void {
    if (this.caret[i] > len) this.caret[i] = len;
    if (this.selAnchor[i] > len) this.selAnchor[i] = len < 0 ? 0 : len;
    this.markMeasure(i);
    this.markPaint(i);
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

  /**
   * Measure a widget's own text, from its buffer.
   *
   * Public because a behavior sizes itself from it (`ui.measureOwnText`); the tree
   * owns the buffer and the book, so the behavior should not re-derive it.
   */
  measureOwnText(i: i32): i32 {
    const b: TextBuffer = this.textBuf[i];
    if (b.len <= 0) return 0;
    return this.book.measure(this.page[i], this.weight[i], b.bytes, 0, b.len);
  }

  // ── editing -------------------------------------------------------------
  //
  // A text field's edits happen on its own buffer, in bytes. Caret and anchor are
  // byte offsets, not character offsets, because everything downstream (the
  // advance table, the painter) indexes bytes — and a UTF-8 continuation byte is
  // not a place a caret can sit. `moveCaret` snaps to a lead byte for that reason.

  /** Whether byte `at` starts a UTF-8 sequence (as opposed to continuing one). */
  private isLeadByte(b: TextBuffer, at: i32): bool {
    if (at <= 0) return true;
    if (at >= b.len) return true;
    return (b.bytes[at] & 0xC0) != 0x80;
  }

  /** Snap `at` down to the nearest lead byte. */
  private snapLead(b: TextBuffer, at: i32): i32 {
    let c: i32 = at < 0 ? 0 : (at > b.len ? b.len : at);
    let guard: i32 = 0;
    while (c > 0 && !this.isLeadByte(b, c) && guard < 4) {
      c--;
      guard++;
    }
    return c;
  }

  /** The caret for a widget, snapped into its text. */
  caretOf(i: i32): i32 {
    return this.snapLead(this.textBuf[i], this.caret[i]);
  }

  /** Set the caret, clamped and snapped. Clears the selection. */
  setCaret(i: i32, at: i32): void {
    if (i < 0 || i >= this.used) return;
    this.caret[i] = at < 0 ? 0 : at;
    this.selAnchor[i] = -1;
    this.markPaint(i);
  }

  /** The selected byte range `[lo, hi)`, or lo == hi when nothing is selected. */
  selectionLo(i: i32): i32 {
    const a: i32 = this.selAnchor[i];
    if (a < 0) return this.caret[i];
    return a < this.caret[i] ? a : this.caret[i];
  }

  selectionHi(i: i32): i32 {
    const a: i32 = this.selAnchor[i];
    if (a < 0) return this.caret[i];
    return a < this.caret[i] ? this.caret[i] : a;
  }

  /** Delete the selection, if any. Returns whether anything went. */
  deleteSelection(i: i32): bool {
    const b: TextBuffer = this.textBuf[i];
    const lo: i32 = this.selectionLo(i);
    const hi: i32 = this.selectionHi(i);
    if (hi <= lo) {
      this.selAnchor[i] = -1;
      return false;
    }
    b.remove(lo, hi - lo);
    this.caret[i] = lo;
    this.selAnchor[i] = -1;
    this.afterText(i, b.len);
    return true;
  }

  /** Insert bytes at the caret, replacing the selection. */
  insertAtCaret(i: i32, src: Uint8Array, start: i32, n: i32): void {
    if (i < 0 || i >= this.used || n <= 0) return;
    const b: TextBuffer = this.ownBuffer(i, n + 8);
    this.deleteSelection(i);
    const at: i32 = this.snapLead(b, this.caret[i]);
    b.insert(at, src, start, n);
    this.caret[i] = at + n;
    this.selAnchor[i] = -1;
    this.afterText(i, b.len);
  }

  /** Insert a window of the frame pool at the caret. */
  insertSpanAtCaret(i: i32, pool: TextPool, n: i32): void {
    this.insertAtCaret(i, pool.buffer, pool.start, n);
  }

  /** Backspace: delete the selection, or the code point before the caret. */
  backspace(i: i32): bool {
    const b: TextBuffer = this.textBuf[i];
    if (this.deleteSelection(i)) return true;
    if (b.len <= 0) return false;
    const at: i32 = this.snapLead(b, this.caret[i]);
    if (at <= 0) return false;
    // One code point back: a lead byte and its continuation bytes.
    const prev: i32 = this.snapLead(b, at - 1);
    b.remove(prev, at - prev);
    this.caret[i] = prev;
    this.selAnchor[i] = -1;
    this.afterText(i, b.len);
    return true;
  }

  /** Forward delete: the selection, or the code point after the caret. */
  deleteForward(i: i32): bool {
    const b: TextBuffer = this.textBuf[i];
    if (this.deleteSelection(i)) return true;
    const at: i32 = this.snapLead(b, this.caret[i]);
    if (at >= b.len) return false;
    let next: i32 = at + 1;
    while (next < b.len && !this.isLeadByte(b, next)) next++;
    b.remove(at, next - at);
    this.caret[i] = at;
    this.selAnchor[i] = -1;
    this.afterText(i, b.len);
    return true;
  }

  /**
   * Move the caret one code point, or to an end.
   *
   * `extend` is the shift key: it keeps the anchor so the move grows a selection
   * instead of replacing it.
   */
  moveCaret(i: i32, delta: i32, extend: bool): void {
    const b: TextBuffer = this.textBuf[i];
    const from: i32 = this.snapLead(b, this.caret[i]);
    let to: i32 = from;
    if (delta < 0) {
      to = from <= 0 ? 0 : this.snapLead(b, from - 1);
    } else if (delta > 0) {
      to = from;
      if (to < b.len) {
        to++;
        while (to < b.len && !this.isLeadByte(b, to)) to++;
      }
    }
    if (extend) {
      if (this.selAnchor[i] < 0) this.selAnchor[i] = from;
    } else {
      this.selAnchor[i] = -1;
    }
    this.caret[i] = to;
    this.markPaint(i);
  }

  /**
   * Put the caret at the byte nearest to a pixel offset from the text's start.
   *
   * A click in a field has to land *in* it, so this walks the advance table the
   * same way the painter does — accumulated quarter-pixels and all — and picks the
   * boundary the pointer is closest to. `extend` is a shift-click.
   */
  caretAtX(i: i32, x: i32): i32 {
    const b: TextBuffer = this.textBuf[i];
    const page: FontPage = this.page[i];
    const weight: i32 = this.weight[i];
    const spaceQ: i32 = page.advanceQ(weight, 32);

    // The painter's own cursor arithmetic, byte for byte (`Painter.textBytes`):
    // a tab is four spaces, a control byte is one space, and everything else is its
    // own advance. Mirroring it is what makes the caret land between the glyphs
    // that are actually drawn rather than between the glyphs the outline would draw.
    let q: i32 = 0;
    let best: i32 = 0;
    let bestErr: i32 = 0x7FFFFFFF;
    for (let k: i32 = 0; k <= b.len; k++) {
      const at: i32 = (q + 2) / 4;
      const err: i32 = at > x ? at - x : x - at;
      if (err < bestErr) {
        bestErr = err;
        best = k;
      }
      if (k == b.len) break;
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

    const at: i32 = this.snapLead(b, best);
    if (this.shiftHeld) {
      if (this.selAnchor[i] < 0) this.selAnchor[i] = this.caret[i];
    } else {
      this.selAnchor[i] = -1;
    }
    this.caret[i] = at;
    this.markPaint(i);
    return at;
  }

  /**
   * Whether shift was held when the event being dispatched was produced.
   *
   * Set by the dispatcher for the duration of one event and read by the caret
   * helpers. A field on the tree rather than a parameter because the caret helpers
   * are called from four places and threading it would make three of them pass a
   * constant.
   */
  shiftHeld: bool = false;

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

  /**
   * Queue `i` to be re-arranged **in place**, with its descendants, next `layout()`.
   *
   * This is the mechanism a scroller needs and the reason a `List` can scroll
   * without its parent noticing: the widget keeps the clip it was last arranged
   * with (`effX`…) and re-places only its own subtree. Nothing above it is marked,
   * so nothing above it is visited.
   *
   * It is *not* a general-purpose invalidator — a size change must still go up the
   * tree (`markMeasure`), because a parent's distribution depends on it. Reaching
   * for this when the widget's own size changed is how a tree ends up with parents
   * holding stale arithmetic.
   */
  reflowSubtree(i: i32): void {
    if (i < 0 || i >= this.used || this.kind[i] == KIND_NONE) return;
    this.dirty[i] |= Dirty.Arrange;
    for (let k: i32 = 0; k < this.dirtySubtrees; k++) {
      if (this.subtreeQueue[k] == i) return;
    }
    if (this.dirtySubtrees < this.subtreeQueue.length) {
      this.subtreeQueue[this.dirtySubtrees++] = i;
      return;
    }
    // The queue is full. Correctness first: arrange from the root instead.
    const r: i32 = this.root;
    if (r >= 0) this.markArrange(r);
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
    // The frame boundary for scratch text. Rows copy what they are given, so nothing
    // holds a window across a frame and the cursor can go back to zero every time —
    // which is what makes `texts.highWater` mean "bytes this frame".
    this.texts.begin();
    const r: i32 = this.root;
    if (r < 0) return;
    this.promote();

    const rootMeasure: bool = (this.dirty[r] & Dirty.Measure) != 0;
    const rootArrange: bool = (this.dirty[r] & Dirty.Arrange) != 0;
    if (!rootMeasure && !rootArrange) {
      // Nothing above the queued subtrees moved; only they need re-placing.
      this.drainSubtrees();
      return;
    }
    if (rootMeasure) this.measureAt(r, 0);
    if (rootArrange) {
      // A full arrange reaches every queued subtree anyway, so the queue is spent.
      this.dirtySubtrees = 0;
      this.arrangeAt(r, 0, this.clipX, this.clipY, this.clipW, this.clipH);
    } else {
      this.drainSubtrees();
    }
  }

  /** Re-arrange each queued subtree from the clip it was last given. */
  private drainSubtrees(): void {
    const n: i32 = this.dirtySubtrees;
    this.dirtySubtrees = 0;
    for (let k: i32 = 0; k < n; k++) {
      const i: i32 = this.subtreeQueue[k];
      if (i < 0 || i >= this.used || this.kind[i] == KIND_NONE) continue;
      if ((this.dirty[i] & Dirty.Arrange) == 0) continue;
      this.arrangeAt(i, 0, this.effX[i], this.effY[i], this.effW[i], this.effH[i]);
    }
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
    // The one dispatch: the engine knows *when* to measure, the behavior knows
    // *what* a measurement is. `host` is set by `Ui`'s constructor; a tree driven
    // without one measures nothing, which is why `layout()` refuses early.
    this.behavior[i].measure(<Ui>this.host, i);
    this.dirty[i] = this.dirty[i] & ~Dirty.Measure;
    this.measures++;
  }

  /**
   * Apply the widget's own size floors.
   *
   * Public because a behavior writes its size and then has to honour `minW`/`minH`;
   * `ui.applyFloors` is the spelling a behavior uses, and this is what it calls.
   */
  applyFloors(i: i32): void {
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
  private arrangeAt(i: i32, depth: i32, cx: i32, cy: i32, cw: i32, ch: i32): void {
    if (depth > MAX_DEPTH) {
      this.tooDeep++;
      return;
    }
    if ((this.dirty[i] & Dirty.Arrange) == 0) return;
    // A hidden widget is out of the layout: its parent's flow already skipped it
    // (so a flex sibling holds the space), and here it must not be arranged, must
    // not run its behavior and must not paint. `visible = false` is what makes the
    // paint skip the whole subtree, which is also what makes it unclickable — a
    // collapsed panel must not keep a hit rect where it used to be.
    if (this.hidden[i]) {
      this.visible[i] = false;
      this.subtree[i] = 0;
      this.dirty[i] = this.dirty[i] & ~Dirty.Arrange;
      return;
    }
    this.arranges++;

    // The clip in force for this widget, remembered so that a subtree can be
    // re-arranged later without re-deriving it from the ancestors (`reflowSubtree`).
    this.effX[i] = cx;
    this.effY[i] = cy;
    this.effW[i] = cw;
    this.effH[i] = ch;

    // Visibility is a property of the rectangle `arrange` just gave the widget, so
    // it is computed here and nowhere else. It has to be computed for the widget
    // being arranged, not only for its children: the root has no parent to test it,
    // and a root left `false` culls the whole tree — which is exactly the bug this
    // line fixed (a paint that emitted zero records while every child was visible).
    this.visible[i] = this.meetsClip(i, cx, cy, cw, ch);

    // Place the children. The behavior gets the rectangle the parent already gave
    // this widget, so it never has to re-derive it — and a behavior that reads the
    // tree's own `x/y/w/h` sees exactly the numbers passed here.
    this.behavior[i].arrange(<Ui>this.host, i, this.x[i], this.y[i], this.w[i], this.h[i]);

    this.dirty[i] = this.dirty[i] & ~Dirty.Arrange;

    // **Only a list narrows the clip**, and it narrows it for its own subtree
    // alone: its rows are positioned in scrolled coordinates, so a row that has
    // scrolled out of the list's box has a rect outside it and is culled by this
    // intersection rather than by a special case in the row's own arithmetic.
    // Every other container passes the clip through untouched — a panel does not
    // clip its children, or a button's focus ring would be cut off at its box.
    let ncx: i32 = cx;
    let ncy: i32 = cy;
    let ncw: i32 = cw;
    let nch: i32 = ch;
    if (this.clipsChildren[i]) {
      const pad: i32 = this.pad[i];
      const bx0: i32 = this.x[i] + pad;
      const by0: i32 = this.y[i] + pad;
      const bx1: i32 = this.x[i] + this.w[i] - pad;
      const by1: i32 = this.y[i] + this.h[i] - pad;
      if (bx0 > ncx) ncx = bx0;
      if (by0 > ncy) ncy = by0;
      if (bx1 < ncx + ncw) ncw = bx1 - ncx;
      if (by1 < ncy + nch) nch = by1 - ncy;
    }

    let c: i32 = this.firstChild[i];
    while (c >= 0) {
      this.dirty[c] |= Dirty.Arrange;
      this.arrangeAt(c, depth + 1, ncx, ncy, ncw, nch);
      c = this.nextSibling[c];
    }
  }

  /** Whether a widget's rectangle meets a clip. */
  private meetsClip(i: i32, cx: i32, cy: i32, cw: i32, ch: i32): bool {
    const x0: i32 = this.x[i];
    const y0: i32 = this.y[i];
    if (cw <= 0 || ch <= 0) return false;
    if (x0 >= cx + cw || x0 + this.w[i] <= cx) return false;
    if (y0 >= cy + ch || y0 + this.h[i] <= cy) return false;
    return true;
  }

  /**
   * Force every recycled row to refill on the next arrange.
   *
   * Scrolling refills the rows whose index changed; this is for the other case —
   * the *model* changed and the indices did not. A caller that mutates its data
   * calls this and the next `layout()` re-reads every visible row.
   */
  refreshList(i: i32): void {
    if (i < 0 || i >= this.used) return;
    let row: i32 = this.firstChild[i];
    while (row >= 0) {
      this.itemIndex[row] = -1;
      row = this.nextSibling[row];
    }
    this.reflowSubtree(i);
  }

  /** Whether a widget's list has a model, as opposed to the no-op sentinel. */
  hasSource(i: i32): bool {
    return i >= 0 && i < this.used && this.source[i] != this.noSource;
  }

  /** Scroll a list by a pixel delta, clamped, re-arranging only its subtree. */
  scrollBy(i: i32, dy: i32): void {
    if (i < 0 || i >= this.used) return;
    const ih: i32 = this.itemH[i] > 0 ? this.itemH[i] : 1;
    const contentH: i32 = this.itemCount[i] * ih;
    const innerH: i32 = this.h[i] - 2 * this.pad[i];
    let maxScroll: i32 = contentH - (innerH > 0 ? innerH : 0);
    if (maxScroll < 0) maxScroll = 0;
    let sy: i32 = this.scrollY[i] + dy;
    if (sy < 0) sy = 0;
    if (sy > maxScroll) sy = maxScroll;
    if (sy == this.scrollY[i]) return;
    this.scrollY[i] = sy;
    this.reflowSubtree(i);
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
      // `cost` means "records this widget emitted in the last paint", so a skipped
      // widget emitted zero — leaving the previous frame's count there made a hidden
      // panel report the cost it had before it was hidden, and any budget arithmetic
      // built on it inherited the lie.
      this.cost[i] = 0;
      this.subtree[i] = 0;
      return 0;
    }
    if (p.full) {
      this.skipped++;
      this.cost[i] = 0;
      this.subtree[i] = 0;
      return 0;
    }

    // A **clickable** widget records its own rectangle before its behavior paints,
    // which is what makes "click the panel's background to focus it" possible
    // without a behavior that knows about focus: the engine owns the rect and the
    // hit, so any widget — a row, a column, a custom panel — can opt in with
    // `ui.clickable(id)`. Children paint after, so their targets are recorded later
    // and win the hit test; a click on a field inside a clickable row is the
    // field's, and a click on the row's caption is the row's.
    if (this.clickable[i]) {
      p.addHit(this.x[i], this.y[i], this.w[i], this.h[i], this.id[i], i);
    }

    const before: i32 = p.count;
    this.behavior[i].paint(<Ui>this.host, i, p);
    const own: i32 = p.count - before;
    this.cost[i] = own;
    // A painted widget is painted: the flag has done its job. Clearing it here
    // rather than in a separate sweep is what stops the flags from accumulating
    // into "everything is always dirty", which is the state a UI that never reads
    // them drifts into.
    this.dirty[i] = this.dirty[i] & ~Dirty.Paint;

    // A clipping container clips its children to its own content box. This is the
    // paint half of the arrange-time cull: arrange decided *which* rows are on
    // screen, and this decides what part of a partially visible one may be drawn.
    let total: i32 = own;
    if (this.clipsChildren[i]) {
      const pad: i32 = this.pad[i];
      p.pushClip(this.x[i] + pad, this.y[i] + pad,
                 this.w[i] - 2 * pad, this.h[i] - 2 * pad);
      let c: i32 = this.firstChild[i];
      while (c >= 0) {
        total += this.paintAt(c, p, depth + 1);
        c = this.nextSibling[c];
      }
      p.popClip();
    } else {
      let c: i32 = this.firstChild[i];
      while (c >= 0) {
        total += this.paintAt(c, p, depth + 1);
        c = this.nextSibling[c];
      }
    }
    this.subtree[i] = total;
    return total;
  }

}
