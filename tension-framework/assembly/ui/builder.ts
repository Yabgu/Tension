// The authoring API: build the tree once, then never touch it again.
//
// ## Why a builder and not constructors in the app
//
// A retained tree has two very different call sites. Authoring happens **once**,
// at startup, and wants to read like the UI it describes:
//
//     const root = ui.root(1280, 720);
//     const col  = ui.column(root, { pad: 8, flex: 1 });
//     const bar  = ui.row(col, { pad: 6, minH: 40 });
//     ui.button(bar, "File");
//     ui.spacer(bar, 1);
//     ui.button(bar, "Run");
//
// The frame happens **every 16 ms** and must allocate nothing. Keeping the two in
// separate files is what makes the second one auditable: nothing in `layout.ts`
// calls `String.UTF8.encode`, and `setText` — the one place that does — is only
// reachable from here.
//
// ## Why properties are an options object and not five positional numbers
//
// `ui.row(col, { pad: 6, minH: 40 })` reads as the thing it builds; `ui.row(col, 0,
// 6, 0, 40)` is four numbers in an order nobody remembers. TensionScript spells a
// literal against a class type, so `Props` below *is* the options type and the
// literal creates it.
//
// One consequence is worth stating precisely, because it decides every field's
// meaning. Measured on TensionScript 0.13.2, an object literal **does** run the
// class's field initializers — `{ b: 2 }` against `class P { a: i32 = 7; b: i32 =
// 9; c: i32 = 11; }` answers `a=7 b=2 c=11`, not `a=0 b=2 c=0`. So an unlisted
// field holds its *declared* value, and every field of `Props` below is declared
// `= 0` for exactly that reason: zero is the value a caller did not name, which is
// why zero is free to mean "the kind's own default".
//
// That is also why `align` is one-based (`ALIGN_CENTER`, not `Align.Center`):
// `Align.Start` is 0, and "unset" and "start" would otherwise be the same number.
// A `props.align` of 0 means "whatever this kind does by default", which for every
// container is `Stretch` and for every leaf is `Start`.
//
// ## Why properties are also setters
//
// The shape of a widget is decided when it is created; its *content* changes. So
// every field the builder can set is also a setter that returns the id, which
// makes a later edit a one-liner and marks exactly the flags it invalidates:
//
//     ui.text(this.status, "ready");        // re-measure, up the tree
//     ui.colour(this.status, MUTED);        // repaint, and nothing else
//
// The flag each setter chooses is the earliest pass that must re-run — see `Dirty`
// in `layout.ts` for why the setters are allowed to set only one bit.

import { Snapshot } from "../input";
import { Dispatcher, NO_EVENTS, UiEvents } from "./events";
import { FontBook, FontPage } from "./fonts";
import { Hits } from "./hit";
import {
  Align, DIVIDER_PX, Dirty, Kind, LIST_ROWS, ListSource, RULE_H, SLIDER_MAX, WidgetTree,
} from "./layout";
import { TextBuilder, TextPool } from "./text";

/** `Props.align` values. One-based so that 0 can mean "the kind's default". */
export const ALIGN_UNSET: i32 = 0;
export const ALIGN_START: i32 = 1;
export const ALIGN_CENTER: i32 = 2;
export const ALIGN_END: i32 = 3;
export const ALIGN_STRETCH: i32 = 4;

/**
 * The shape of a widget, as an options literal.
 *
 * Every field is in device pixels and declared `= 0`, so an unlisted field is
 * zero whether the compiler runs the initializer or not (it does — see the header
 * for the measurement). `gap` on a split is the divider's width.
 */
export class Props {
  /** Padding inside the widget's own rectangle. */
  pad: i32 = 0;
  /** Space between children (row/column), or the divider's width (split). */
  gap: i32 = 0;
  /** Share of the parent's leftover space along its main axis. 0 is "fixed". */
  flex: i32 = 0;
  minW: i32 = 0;
  minH: i32 = 0;
  /** One of the `ALIGN_*` constants; 0 leaves the kind's default. */
  align: i32 = 0;
  /** A `NORMAL`/`MUTED`/`LINK`/`CODE`/`HEADING` stripe. */
  colour: i32 = 0;
  /** `REGULAR` (0) or `BOLD` (1). */
  weight: i32 = 0;
}

/**
 * The tree's authoring front end.
 *
 * Holds no state of its own beyond the tree: a builder call allocates, links, sets
 * the kind's defaults, applies the caller's properties, and returns the slot. The
 * slot is the widget, for the life of the tree.
 */
export class Ui {
  tree: WidgetTree;
  /** The pages, for `font()` and for the measure a builder call may trigger. */
  book: FontBook;
  /**
   * This frame's click targets, as the paint recorded them.
   *
   * Owned by the `Ui` rather than by the app, because the event dispatcher reads
   * the same list the paint filled — two lists would be two answers to "what is
   * under the pointer".
   */
  hits: Hits;
  /** Focus, capture, hover and the bubble. */
  dispatch: Dispatcher;

  constructor(tree: WidgetTree, events: UiEvents = NO_EVENTS) {
    // Locals first: TensionScript refuses to read `this` before every field has
    // been assigned, and the dispatcher wants the tree and the hit list.
    const hits = new Hits();
    const dispatch = new Dispatcher(tree, hits, events);
    this.tree = tree;
    this.book = tree.book;
    this.hits = hits;
    this.dispatch = dispatch;
  }

  /** Replace the event handler without rebuilding the tree. */
  setEvents(events: UiEvents): void {
    this.dispatch.events = events;
  }

  // ── the shapes ──────────────────────────────────────────────────────────

  /**
   * The tree's root, sized to the window.
   *
   * The root lays its children out like a column, so the usual child is one
   * `column(root, { flex: 1 })` that fills everything. Its rectangle belongs to
   * `WidgetTree.resize` after this: a root that measured itself from its content
   * would refuse to shrink below it.
   */
  root(w: i32, h: i32, props: Props | null = null): i32 {
    const i: i32 = this.make(Kind.Root, props, Align.Stretch, 0);
    this.tree.root = i;
    this.tree.resize(w, h);
    return i;
  }

  /** A horizontal container. Spans its parent's cross axis (its height, if nested). */
  row(parent: i32, props: Props | null = null): i32 {
    return this.make(Kind.Row, props, Align.Stretch, 0, parent);
  }

  /** A vertical container. Spans its parent's width unless told otherwise. */
  column(parent: i32, props: Props | null = null): i32 {
    return this.make(Kind.Column, props, Align.Stretch, 0, parent);
  }

  /**
   * Two panes and a divider the user can drag (Pass 3 owns the drag).
   *
   * `axis` is `Axis.X` for panes side by side, `Axis.Y` for stacked. The divider's
   * width is `props.gap`, or `DIVIDER_PX` (4) — enough to hit with a pointer and
   * narrow enough not to read as a panel of its own.
   */
  split(parent: i32, axis: i32, props: Props | null = null): i32 {
    const i: i32 = this.make(Kind.Split, props, Align.Stretch, DIVIDER_PX, parent);
    if (i < 0) return -1;
    this.tree.axis[i] = axis;
    // A split's divider is draggable by definition; that is the whole widget.
    this.tree.draggable[i] = true;
    return i;
  }

  /** One line of text, measured from its advance table. */
  label(parent: i32, text: string, props: Props | null = null): i32 {
    const i: i32 = this.make(Kind.Label, props, Align.Start, 0, parent);
    this.tree.setText(i, text);
    return i;
  }

  /** A filled box with a bright top edge and a centred label. */
  button(parent: i32, text: string, props: Props | null = null): i32 {
    const i: i32 = this.make(Kind.Button, props, Align.Start, 0, parent);
    this.tree.setText(i, text);
    return i;
  }

  /**
   * An editable field, width `minW` (or 96 px, the toolkit's floor).
   *
   * Flexes by default: a field is the thing in a toolbar that should take the room
   * that is left. Its own text never changes its box — a form whose fields jump
   * while you type is a form that moves the caret out from under the pointer.
   */
  field(parent: i32, text: string, props: Props | null = null): i32 {
    const i: i32 = this.make(Kind.TextField, props, Align.Start, 0, parent);
    if (i < 0) return -1;
    if (props == null || props.flex == 0) this.tree.flex[i] = 1;
    // Focusable by definition: a field that Tab cannot reach is a field the
    // keyboard cannot use, and a caret with no focus has nothing to draw.
    this.tree.focusable[i] = true;
    this.tree.setText(i, text);
    return i;
  }

  /** Empty space that claims `flex` shares of what is left. */
  spacer(parent: i32, flex: i32 = 1, props: Props | null = null): i32 {
    const i: i32 = this.make(Kind.Spacer, props, Align.Start, 0, parent);
    // `props.flex` wins when it was given, because `make` applied it last; the
    // positional argument is the shape's own parameter and applies otherwise.
    if (this.tree.flex[i] == 0) this.tree.flex[i] = flex > 0 ? flex : 1;
    return i;
  }

  /** A one-pixel horizontal rule spanning its container's width. */
  rule(parent: i32, props: Props | null = null): i32 {
    const i: i32 = this.make(Kind.Rule, props, Align.Stretch, 0, parent);
    if (this.tree.minH[i] < RULE_H) this.tree.minH[i] = RULE_H;
    return i;
  }

  /**
   * A virtualised list of `rows` recycled row widgets.
   *
   * `rows` is how many item widgets exist, and it is the list's whole cost: a
   * 10,000-item list with `rows: 20` arranges and paints at most twenty rows per
   * frame. Ask for more rows than fit on screen and the extras are culled; ask for
   * fewer and the list shows at most that many at a time.
   *
   * The rows are created here, at authoring, so nothing allocates when the list
   * scrolls. `source` supplies the text; pass null and set the rows' text yourself.
   */
  list(parent: i32, source: ListSource | null, rows: i32 = LIST_ROWS,
       props: Props | null = null): i32 {
    const t: WidgetTree = this.tree;
    const i: i32 = this.make(Kind.List, props, Align.Stretch, 0, parent);
    if (i < 0) return -1;
    // Only assign a model that exists: the slot already holds the tree's no-op one,
    // and a caller that passes null sets its rows' text itself.
    if (source != null) {
      t.source[i] = <ListSource>source;
      t.itemCount[i] = source!.count();
    }
    if (props == null || props.flex == 0) t.flex[i] = 1;
    if (props != null && props.minH > 0) t.minH[i] = props.minH;

    const n: i32 = rows > 0 ? rows : LIST_ROWS;
    for (let k: i32 = 0; k < n; k++) {
      // A row is a label with an item index; `placeList` decides which item it
      // shows and `paintSelf` gives it a hit target because it has one.
      const row: i32 = t.alloc(Kind.Label);
      if (row < 0) break;
      t.align[row] = Align.Stretch;
      t.append(i, row);
      t.itemIndex[row] = -1;
      t.visible[row] = false;
    }
    return i;
  }

  /** A track and a thumb over `0..SLIDER_MAX`. */
  slider(parent: i32, value0: i32, props: Props | null = null): i32 {
    const i: i32 = this.make(Kind.Slider, props, Align.Start, 0, parent);
    if (i < 0) return -1;
    this.tree.value[i] = clampSlider(value0);
    this.tree.draggable[i] = true;
    return i;
  }

  // ── the setters ─────────────────────────────────────────────────────────

  /**
   * Padding, in pixels.
   *
   * A **measure**, not an arrange: a container's measured size is its content plus
   * twice its padding (`measureSelf`), so changing the padding changes the number
   * the parent distributes around. An arrange-only flag would leave every ancestor
   * holding a stale size, which is the drift the two passes exist to prevent.
   */
  pad(id: i32, value: i32): i32 {
    this.tree.pad[id] = value > 0 ? value : 0;
    this.tree.markMeasure(id);
    return id;
  }

  /** Space between children, or a split's divider width. A measure, as `pad` is. */
  gap(id: i32, value: i32): i32 {
    this.tree.gap[id] = value > 0 ? value : 0;
    this.tree.markMeasure(id);
    return id;
  }

  /** Share of the leftover space along the parent's main axis. */
  flex(id: i32, value: i32): i32 {
    this.tree.flex[id] = value > 0 ? value : 0;
    // Flex changes the parent's distribution, which is an arrange from the parent
    // down — and `markArrange` walks to the root, which is where a distribution
    // starts.
    this.tree.markArrange(id);
    return id;
  }

  /** A width floor. Floors are a *measure* input, so they invalidate a size. */
  minW(id: i32, value: i32): i32 {
    this.tree.minW[id] = value > 0 ? value : 0;
    this.tree.markMeasure(id);
    return id;
  }

  minH(id: i32, value: i32): i32 {
    this.tree.minH[id] = value > 0 ? value : 0;
    this.tree.markMeasure(id);
    return id;
  }

  /** Both floors at once, which is how a caller pins a rect. */
  size(id: i32, w: i32, h: i32): i32 {
    this.tree.minW[id] = w > 0 ? w : 0;
    this.tree.minH[id] = h > 0 ? h : 0;
    this.tree.markMeasure(id);
    return id;
  }

  /** Cross-axis placement inside the parent. */
  align(id: i32, value: i32): i32 {
    this.tree.align[id] = value;
    this.tree.markArrange(id);
    return id;
  }

  /** A text colour. Repaint only: no size and no position depend on it. */
  colour(id: i32, value: i32): i32 {
    this.tree.colour[id] = value;
    this.tree.markPaint(id);
    return id;
  }

  /** A weight. Re-measures, because bold advances are wider. */
  weight(id: i32, value: i32): i32 {
    this.tree.weight[id] = value;
    this.tree.markMeasure(id);
    return id;
  }

  /** Which page a widget measures and draws with. Re-measures: new advances. */
  font(id: i32, family: i32, sizeIndex: i32): i32 {
    this.tree.setPage(id, this.book.page(family, sizeIndex));
    return id;
  }

  /** The widget's text. Re-measures and repaints. */
  text(id: i32, value: string): i32 {
    this.tree.setText(id, value);
    this.tree.markPaint(id);
    return id;
  }

  /** Override the widget's hit id. `Hits.at` answers this, not the slot. */
  hitId(id: i32, value: i32): i32 {
    this.tree.id[id] = value;
    return id;
  }

  /**
   * A split's divider position, in pixels from the content edge.
   *
   * Named `divider`, not `split`: the shape and the setter would otherwise be two
   * methods of one name, and TensionScript refuses the duplicate rather than
   * overloading on arity.
   */
  divider(id: i32, px: i32): i32 {
    this.tree.splitPx[id] = px;
    this.tree.markArrange(id);
    return id;
  }

  // ── the one allocator ───────────────────────────────────────────────────

  /**
   * Allocate, link, apply the kind's default, then the caller's properties.
   *
   * The order matters and is the reason there is a single `make`: the kind's
   * default is a *behaviour* (`Stretch` for containers, `DIVIDER_PX` for a split's
   * gap) and the caller's properties are an *override*, so applying them last is
   * what lets `{ align: ALIGN_START }` on a row mean something.
   */
  private make(kind: i32, props: Props | null, align: i32, gap: i32,
               parent: i32 = -1): i32 {
    const t: WidgetTree = this.tree;
    const i: i32 = t.alloc(kind);
    if (i < 0) return -1;
    t.align[i] = align;
    if (gap > 0) t.gap[i] = gap;
    if (parent >= 0) t.append(parent, i);
    if (props != null) {
      if (props.pad != 0) t.pad[i] = props.pad > 0 ? props.pad : 0;
      if (props.gap != 0) t.gap[i] = props.gap > 0 ? props.gap : 0;
      if (props.flex != 0) t.flex[i] = props.flex > 0 ? props.flex : 0;
      if (props.minW != 0) t.minW[i] = props.minW > 0 ? props.minW : 0;
      if (props.minH != 0) t.minH[i] = props.minH > 0 ? props.minH : 0;
      if (props.align > ALIGN_UNSET) t.align[i] = props.align - 1;
      if (props.colour != 0) t.colour[i] = props.colour;
      if (props.weight != 0) t.weight[i] = props.weight;
    }
    if (props != null && (props.minW != 0 || props.minH != 0)) t.markMeasure(i);
    if (props != null && props.flex != 0) t.markArrange(i);
    return i;
  }

  /** A default page for one widget, without going through the book by name. */
  page(id: i32, page: FontPage): i32 {
    this.tree.setPage(id, page);
    return id;
  }

  /** Force a measure+arrange on the next `layout()`; used after a bulk change. */
  invalidate(id: i32): i32 {
    this.tree.markMeasure(id);
    return id;
  }

  /** Whether a widget is visible in the viewport, from the last arrange. */
  isVisible(id: i32): bool {
    return this.tree.visible[id];
  }

  /** The widget's rectangle, one number at a time. */
  xOf(id: i32): i32 {
    return this.tree.x[id];
  }

  yOf(id: i32): i32 {
    return this.tree.y[id];
  }

  wOf(id: i32): i32 {
    return this.tree.w[id];
  }

  hOf(id: i32): i32 {
    return this.tree.h[id];
  }

  /** Mark one widget dirty for a repaint, from a caller tracking its own state. */
  repaint(id: i32): i32 {
    this.tree.markPaint(id);
    return id;
  }

  /** Mark one widget dirty at the arrange level, from a caller that moved it. */
  reflow(id: i32): i32 {
    this.tree.markArrange(id);
    return id;
  }

  /** Whether the widget carries a paint flag, for a caller that caches. */
  needsPaint(id: i32): bool {
    return (this.tree.dirty[id] & Dirty.Paint) != 0;
  }

  // ── list and slider state ───────────────────────────────────────────────

  /** How many items a list claims. Re-arranges the list, not its ancestors. */
  items(id: i32, count: i32): i32 {
    this.tree.itemCount[id] = count > 0 ? count : 0;
    this.tree.refreshList(id);
    return id;
  }

  /** Row height. Re-measures, because it changes the list's content height. */
  itemHeight(id: i32, px: i32): i32 {
    this.tree.itemH[id] = px > 0 ? px : 0;
    this.tree.markMeasure(id);
    return id;
  }

  /** The model changed but the indices did not: re-read every visible row. */
  refresh(id: i32): i32 {
    this.tree.refreshList(id);
    return id;
  }

  /** Scroll a list to a pixel offset, clamped. Re-arranges only the list. */
  scrollTo(id: i32, y: i32): i32 {
    const ih: i32 = this.tree.itemH[id] > 0 ? this.tree.itemH[id] : 1;
    const contentH: i32 = this.tree.itemCount[id] * ih;
    const innerH: i32 = this.tree.h[id] - 2 * this.tree.pad[id];
    let max: i32 = contentH - (innerH > 0 ? innerH : 0);
    if (max < 0) max = 0;
    let v: i32 = y;
    if (v < 0) v = 0;
    if (v > max) v = max;
    if (v == this.tree.scrollY[id]) return id;
    this.tree.scrollY[id] = v;
    this.tree.reflowSubtree(id);
    return id;
  }

  /** Where a list is scrolled to. */
  scrollOf(id: i32): i32 {
    return this.tree.scrollY[id];
  }

  /** A slider's value, `0..SLIDER_MAX`. */
  valueOf(id: i32): i32 {
    return this.tree.value[id];
  }

  /** Set a slider's value; repaint only, because a thumb moves no layout. */
  setValue(id: i32, v: i32): i32 {
    this.tree.value[id] = clampSlider(v);
    this.tree.markPaint(id);
    return id;
  }

  /** A slider's value as a float in `0..1`, for a caller that wants one. */
  fraction(id: i32): f64 {
    return <f64>this.tree.value[id] / <f64>SLIDER_MAX;
  }

  /** The item a recycled row is showing, or -1. */
  itemOf(id: i32): i32 {
    return this.dispatch.itemOf(id);
  }

  // ── text from the frame pool ────────────────────────────────────────────

  /** The frame's scratch pool, for a caller composing an ephemeral string. */
  get pool(): TextPool {
    return this.tree.texts;
  }

  /**
   * Set a widget's text from the pool's **current** window.
   *
   * The zero-allocation path for composed text: `ui.pool.begin()`, then
   * `ui.pool.str("node ")`, `ui.pool.int(n)`, `ui.pool.str(" ")`, `ui.pool.str(name)`,
   * then `ui.textPool(row)`. One copy into the widget's own buffer and no
   * `String` anywhere.
   */
  textPool(id: i32): i32 {
    this.tree.setTextSpan(id, this.tree.texts);
    this.tree.markPaint(id);
    return id;
  }

  /** Start a fresh ephemeral string in the pool, keeping the previous one. */
  nextText(): void {
    this.tree.texts.next();
  }

  /** Set a widget's text from a builder the caller owns. */
  textBuilder(id: i32, b: TextBuilder): i32 {
    this.tree.setTextBuilder(id, b);
    this.tree.markPaint(id);
    return id;
  }

  // ── events ──────────────────────────────────────────────────────────────

  /**
   * Dispatch one frame of input.
   *
   * Call it **before** `layout()` and `paint()`, and pass the same `hits` to the
   * paint that `frame` read: the dispatch matches against what was on screen when
   * the pointer went down (`events.ts` has the argument for that order).
   */
  frame(input: Snapshot | null): void {
    this.dispatch.frame(input);
  }

  /** The focused widget's slot, or -1. */
  get focusId(): i32 {
    return this.dispatch.focusId;
  }

  /** The widget holding mouse capture, or -1. */
  get captureId(): i32 {
    return this.dispatch.captureId;
  }

  /** The widget under the pointer, from the last dispatch. */
  get hoverId(): i32 {
    return this.dispatch.hoverId;
  }

  /** The list item the last press landed on, or -1. Read inside `onClick`. */
  get lastItem(): i32 {
    return this.dispatch.lastItem;
  }

  /** Focus a widget (or clear it with -1), if it is focusable. */
  setFocus(id: i32): void {
    this.dispatch.setFocus(id);
  }

  /** Leave the focused widget. */
  blur(): void {
    this.dispatch.blur();
  }

  /** Whether a widget holds the focus. */
  isFocused(id: i32): bool {
    return this.dispatch.isFocused(id);
  }

  /** Move focus in pre-order. `back` is Shift-Tab. */
  focusNext(back: bool = false): void {
    this.dispatch.focusNext(back);
  }

  /** The widget under the pointer. */
  get hovered(): i32 {
    return this.dispatch.hoverId;
  }

  /** A text field's caret, as a byte offset. */
  caret(id: i32): i32 {
    return this.tree.caretOf(id);
  }

  /** Put a text field's caret at a byte offset. */
  setCaret(id: i32, at: i32): void {
    this.tree.setCaret(id, at);
  }

  /** A text field's text, as a `String`. Allocates: for tests and logs, not frames. */
  textOf(id: i32): string {
    const b = this.tree.bufferOf(id);
    if (b == null || b!.len <= 0) return "";
    return String.UTF8.decodeUnsafe(b!.bytes.dataStart, <usize>b!.len, false);
  }
}

/** A slider value, clamped to its range. */
function clampSlider(v: i32): i32 {
  if (v < 0) return 0;
  if (v > SLIDER_MAX) return SLIDER_MAX;
  return v;
}
