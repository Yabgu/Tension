// Events: what a pointer and a keyboard do to a retained tree.
//
// ## The order of a frame, and why it is that order
//
//     ui.frame(input);          // 1. dispatch, against LAST frame's targets
//     tree.layout();            // 2. measure/arrange whatever the event dirtied
//     tree.paint(p, ui.hits);   // 3. draw, recording THIS frame's targets
//
// Step 1 uses the hit list the *previous* paint produced, and that is deliberate
// rather than a wart. A hit list is a record of what was drawn, so it is always
// one frame old at the moment a click arrives; the alternative is to dispatch
// after painting, against rects that this frame has already moved. Given the
// choice between "the click is matched against where the widget was when you saw
// it" and "the click is matched against where it moved to while you clicked", the
// first is the one that activates what the user aimed at. The cost is that a
// focus ring appears one frame late, which nobody can see.
//
// ## Bubbling, and where it stops
//
// A press resolves to the topmost target at the pointer (`Hits.tagAt`, which is
// the widget slot). From there the walk goes **up** the `parent` chain calling
// `onClick(id)` until a handler answers true. So a button inside a row inside a
// panel is one click on the button: the button consumes it, and the row never
// hears about it. A click on the row's *background* — outside the button — starts
// at the row, which is what makes "click the row, not the button" expressible
// without a second target list.
//
// ## Capture
//
// A press on a widget that declares `draggable` takes **capture**: every motion
// until the button comes up goes to that widget, wherever the pointer is. That is
// what lets a split's divider keep moving when the pointer leaves the 4-px band —
// the band decides *who grabbed it*, and capture decides *who keeps it*. Without
// capture a drag dies the moment the pointer outruns the layout, which is the
// single most common way a hand-written drag handler fails.
//
// ## `readText` exactly once
//
// `Ui.frame` calls `input.readText(scratch)` once, unconditionally, before
// anything else looks at it — and discards the bytes when nothing is focused.
// Both halves matter. Zero calls lets the host's mirror fill up and drop
// keystrokes; two calls (one here, one in an app's own handler) means two
// consumers draining one queue, so each sees half the typing. Consuming and
// discarding is the only version where "no field is focused" and "a field is
// focused" cannot disagree about what the user typed.

import { Snapshot } from "../input";
import { Hits } from "./hit";
import { Axis, KIND_NONE, Kind, SLIDER_MAX, State, WidgetTree } from "./layout";

/**
 * The scratch `readText` writes into.
 *
 * 512 bytes is a paste, not a keypress. A frame that delivers more than this
 * answers `-ENOSPC` and **consumes nothing**; the dispatcher then grows the buffer
 * to `textPending()` so the *next* frame's single read succeeds. Growing on demand
 * is the one allocation this file can make, and it is bounded by what the user
 * pasted rather than by the frame rate.
 */
export const TEXT_SCRATCH: i32 = 512;


/**
 * The scancodes the toolkit reacts to, in SDL numbering.
 *
 * SDL 3's `SDL_Scancode` values; `input.Snapshot.pressed` takes the same number.
 * Named here because `43` in a dispatcher is a puzzle and `SCAN_TAB` is not.
 */
export const SCAN_RETURN: u32 = 40;
export const SCAN_ESCAPE: u32 = 41;
export const SCAN_BACKSPACE: u32 = 42;
export const SCAN_TAB: u32 = 43;
export const SCAN_DELETE: u32 = 76;
export const SCAN_RIGHT: u32 = 79;
export const SCAN_LEFT: u32 = 80;
export const SCAN_DOWN: u32 = 81;
export const SCAN_UP: u32 = 82;
export const SCAN_HOME: u32 = 74;
export const SCAN_END: u32 = 77;

/** How far one wheel notch scrolls a list, in pixels. */
export const WHEEL_STEP: i32 = 48;

/**
 * What an app is told about. Every method has a default, so an app overrides only
 * what it cares about.
 *
 * `id` is the widget's **hit id** (`tree.id[slot]`), which is what the builder
 * returned unless the app called `ui.hitId`. A recycled list row shares one id
 * across every item it shows, so a handler that needs to know *which* item reads
 * `ui.lastItem` — set for the duration of the dispatch, and the reason the row's
 * recycling cannot confuse a click.
 */
export abstract class UiEvents {
  /** A press landed on `id`. Return true to consume it and stop the bubble. */
  onClick(id: i32): bool {
    return false;
  }

  /**
   * `id` is being dragged and the pointer moved by `(dx, dy)`.
   *
   * Called **after** the toolkit has applied its own reaction — a split has already
   * moved its divider, a slider already has its new value — so a handler here
   * observes a value that is already correct.
   */
  onDrag(id: i32, dx: i32, dy: i32): bool {
    return false;
  }

  /** A field's or a slider's value changed. `value` is the slider position or -1. */
  onChange(id: i32, value: i32): void {}

  /** Return was pressed in the focused field. */
  onSubmit(id: i32): void {}

  /** A list under the pointer scrolled by `delta` pixels. Return true to consume. */
  onScroll(id: i32, delta: i32): bool {
    return false;
  }
}

/** The events an app that implements none of them gets. */
class NoEvents extends UiEvents {}

/** One shared no-op handler: an app without events still has a dispatcher. */
export const NO_EVENTS: UiEvents = new NoEvents();

/**
 * The keyboard and pointer state a frame is dispatched against.
 *
 * Kept separate from `Snapshot` because it is the *latched* view: `Snapshot` is
 * what the capability said this frame, and this is what changed since the last
 * time the UI looked. One `poll` per frame, then any number of reads.
 */
export class Pointer {
  x: i32 = 0;
  y: i32 = 0;
  dx: i32 = 0;
  dy: i32 = 0;
  /** Button 1, this frame and last. */
  down: bool = false;
  private wasDown: bool = false;
  /** Bit 0 of the modifier word, SDL's `KMOD_SHIFT`. */
  shift: bool = false;
  /** The wheel delta for this frame, in notches (positive is away from the user). */
  wheel: i32 = 0;

  /** Take this frame's state and compute the edges against the previous one. */
  poll(input: Snapshot): void {
    this.x = input.mouseX;
    this.y = input.mouseY;
    this.dx = input.mouseDx;
    this.dy = input.mouseDy;
    this.wheel = <i32>input.wheelY;
    this.shift = (input.modifiers & 0x3) != 0;   // KMOD_LSHIFT | KMOD_RSHIFT
    this.wasDown = this.down;
    this.down = (input.mouseButtons & 1) != 0;
  }

  /** For a dispatcher driven by something other than a `Snapshot`. */
  set(x: i32, y: i32, dx: i32, dy: i32): void {
    this.x = x;
    this.y = y;
    this.dx = dx;
    this.dy = dy;
  }

  /** Button 1 went down since the last `poll`. */
  get pressed(): bool {
    return this.down && !this.wasDown;
  }

  /** Button 1 came up since the last `poll`. */
  get released(): bool {
    return !this.down && this.wasDown;
  }
}

/**
 * The dispatcher: focus, capture, hover, and the walk up the tree.
 *
 * Holds the four ids the user's attention is on and turns a frame of input into
 * edits of the tree. It owns no widgets and draws nothing — a `Ui` owns one of
 * these and delegates to it, so the authoring API and the runtime API stay in the
 * one object an app holds.
 */
export class Dispatcher {
  tree: WidgetTree;
  hits: Hits;
  events: UiEvents;
  pointer: Pointer = new Pointer();

  /** The focused widget's **slot**, or -1. */
  focusId: i32 = -1;
  /** The widget holding mouse capture, or -1. */
  captureId: i32 = -1;
  /** The widget under the pointer, from the last dispatch. */
  hoverId: i32 = -1;
  /** The widget the button went down on, or -1. Cleared on release. */
  pressedId: i32 = -1;
  /** The list item the last press landed on, or -1. Read by `onClick`. */
  lastItem: i32 = -1;

  /** Typed bytes delivered to the focused field this frame. */
  typed: i32 = 0;
  /** Typed bytes the scratch could not hold (`-ENOSPC`); nothing was consumed. */
  typedDropped: i32 = 0;

  /** The buffer `readText` writes into. Sized for a paste, not for a keypress. */
  private scratch: Uint8Array = new Uint8Array(TEXT_SCRATCH);

  constructor(tree: WidgetTree, hits: Hits, events: UiEvents = NO_EVENTS) {
    this.tree = tree;
    this.hits = hits;
    this.events = events;
  }

  /**
   * Dispatch one frame.
   *
   * `input` may be null — an app that drives the dispatcher itself, or a headless
   * frame with no capability — in which case nothing is read and nothing moves,
   * but the method is still the frame boundary.
   */
  frame(input: Snapshot | null): void {
    const t: WidgetTree = this.tree;
    this.typed = 0;
    this.typedDropped = 0;

    // ── 1. the keystrokes, exactly once, whatever happens next ─────────────
    if (input != null) {
      const got: i32 = input.readText(this.scratch);
      if (got > 0) {
        this.typed = got;
      } else if (got < 0) {
        // `-ENOSPC`: the paste is bigger than the scratch, and **nothing was
        // consumed**. Grow the scratch to what is actually waiting so the next
        // frame's single read succeeds — retrying with the same buffer would fail
        // identically for ever, which is a stall, not a limit.
        this.typedDropped = -got;
        const need: i32 = input.textPending();
        if (need > 0) this.scratch = new Uint8Array(need + 64);
      }
    }

    // ── 2. the pointer, latched ───────────────────────────────────────────
    if (input != null) this.pointer.poll(input);
    t.shiftHeld = this.pointer.shift;

    // ── 3. keys that act on the tree, before the pointer does ─────────────
    if (input != null) {
      if (input.pressed(SCAN_TAB)) this.focusNext(this.pointer.shift);
      if (input.pressed(SCAN_ESCAPE)) this.blur();
    }
    this.editKeys(input);

    // ── 4. hover ──────────────────────────────────────────────────────────
    const slot: i32 = input != null ? this.hits.tagAt(this.pointer.x, this.pointer.y) : -1;
    this.setHover(slot);

    // ── 5. the press edge: focus, capture, the bubble ─────────────────────
    if (this.pointer.pressed) this.press(slot);

    // ── 6. the release edge: everything the press started ends ────────────
    if (this.pointer.released) this.release();

    // ── 7. motion while captured ──────────────────────────────────────────
    //
    // Every frame the button is down, not only the frames the pointer moved. A
    // split only cares about the delta, but a slider maps the pointer's *position*
    // onto its range, and skipping the frame where the pointer arrived without a
    // recorded delta is how a thumb stops one pixel short of the click.
    if (this.captureId >= 0 && this.pointer.down) this.drag();

    // ── 8. the wheel ──────────────────────────────────────────────────────
    if (this.pointer.wheel != 0) this.wheel(slot);

    // ── 9. the typed text, now that focus has settled ─────────────────────
    if (this.typed > 0) this.insertTyped();
  }

  // ── the press ───────────────────────────────────────────────────────────

  private press(slot: i32): void {
    const t: WidgetTree = this.tree;
    this.pressedId = slot;
    this.lastItem = slot >= 0 ? t.itemIndex[slot] : -1;

    if (slot < 0) {
      // A click on nothing is how you leave a field.
      this.blur();
      return;
    }

    if (t.focusable[slot]) this.setFocus(slot);
    else this.blur();

    if (t.draggable[slot]) this.captureId = slot;

    // The toolkit's own reaction first, so a handler sees the new value.
    const k: i32 = t.kind[slot];
    if (k == Kind.TextField) {
      // The caret goes where the pointer is, in text-local pixels.
      const local: i32 = this.pointer.x - (t.x[slot] + t.pad[slot]);
      t.caretAtX(slot, local);
    } else if (k == Kind.Slider) {
      this.sliderFromPointer(slot);
    } else if (k == Kind.Button) {
      this.setState(slot, State.Press, true);
    }

    this.bubbleClick(slot);
  }

  private release(): void {
    const t: WidgetTree = this.tree;
    if (this.pressedId >= 0 && this.pressedId < t.used) {
      this.setState(this.pressedId, State.Press, false);
    }
    this.pressedId = -1;
    this.captureId = -1;
  }

  /**
   * Walk up from `slot` calling `onClick` until a handler consumes it.
   *
   * The depth guard is the tree's own: `append` refuses a cycle, so the walk
   * terminates, and `MAX_DEPTH` bounds the pathological tree a caller built by
   * hand.
   */
  private bubbleClick(slot: i32): void {
    const t: WidgetTree = this.tree;
    let s: i32 = slot;
    let guard: i32 = 0;
    while (s >= 0 && s < t.used && guard < 64) {
      if (this.events.onClick(t.id[s])) return;
      s = t.parent[s];
      guard++;
    }
  }

  // ── dragging ────────────────────────────────────────────────────────────

  /**
   * Motion while captured.
   *
   * The two draggable kinds differ in what "moved" means and the difference is not
   * arbitrary: a **split** accumulates the delta (`splitPx += dx`), because its
   * divider has no absolute position to map to — it sits wherever it was left. A
   * **slider** maps the pointer absolutely, because a thumb that only moved by the
   * deltas would drift out of step with the track after one dropped frame.
   */
  private drag(): void {
    const t: WidgetTree = this.tree;
    const s: i32 = this.captureId;
    if (s < 0 || s >= t.used) return;
    const k: i32 = t.kind[s];

    if (k == Kind.Split) {
      const d: i32 = t.axis[s] == Axis.X ? this.pointer.dx : this.pointer.dy;
      if (d != 0) {
        // The `arrange` clamps it; this only has to keep the number in range of an
        // i32 across a long drag.
        t.splitPx[s] += d;
        t.reflowSubtree(s);
      }
    } else if (k == Kind.Slider) {
      this.sliderFromPointer(s);
    }

    // The handler hears about *motion*, not about held-ness: a drag callback that
    // fired on every frame with a zero delta would be a per-frame cost for an event
    // that did not happen.
    if (this.pointer.dx != 0 || this.pointer.dy != 0) {
      this.events.onDrag(t.id[s], this.pointer.dx, this.pointer.dy);
    }
  }

  /** Point the slider at the pointer, clamped to the track. */
  private sliderFromPointer(s: i32): void {
    const t: WidgetTree = this.tree;
    const tw: i32 = t.w[s] - 2 * t.pad[s];
    if (tw <= 0) return;
    let local: i32 = this.pointer.x - (t.x[s] + t.pad[s]);
    if (local < 0) local = 0;
    if (local > tw) local = tw;
    const v: i32 = local * SLIDER_MAX / tw;
    if (v == t.value[s]) return;
    t.value[s] = v;
    t.markPaint(s);
    this.events.onChange(t.id[s], v);
  }

  // ── the wheel ───────────────────────────────────────────────────────────

  /** Scroll the nearest list at or above the pointer. */
  private wheel(slot: i32): void {
    const t: WidgetTree = this.tree;
    let s: i32 = slot;
    let guard: i32 = 0;
    while (s >= 0 && s < t.used && guard < 64) {
      if (t.kind[s] == Kind.List) {
        const delta: i32 = -this.pointer.wheel * WHEEL_STEP;
        if (!this.events.onScroll(t.id[s], delta)) t.scrollBy(s, delta);
        return;
      }
      s = t.parent[s];
      guard++;
    }
  }

  // ── typing ──────────────────────────────────────────────────────────────

  /** The editing keys, applied to the focused field. */
  private editKeys(input: Snapshot | null): void {
    if (input == null) return;
    const f: i32 = this.focusId;
    if (f < 0 || this.tree.kind[f] != Kind.TextField) return;
    const t: WidgetTree = this.tree;

    let changed: bool = false;
    if (input.pressed(SCAN_BACKSPACE)) changed = t.backspace(f);
    if (input.pressed(SCAN_DELETE)) changed = t.deleteForward(f);
    if (input.pressed(SCAN_LEFT)) t.moveCaret(f, -1, this.pointer.shift);
    if (input.pressed(SCAN_RIGHT)) t.moveCaret(f, 1, this.pointer.shift);
    if (input.pressed(SCAN_HOME)) t.setCaret(f, 0);
    if (input.pressed(SCAN_END)) t.setCaret(f, t.textLength(f));
    if (changed) this.events.onChange(t.id[f], -1);

    if (input.pressed(SCAN_RETURN)) this.events.onSubmit(t.id[f]);
  }

  /** Put this frame's bytes into the focused field, or throw them away. */
  private insertTyped(): void {
    const f: i32 = this.focusId;
    if (f < 0 || this.tree.kind[f] != Kind.TextField) return;   // consumed, discarded
    this.tree.insertAtCaret(f, this.scratch, 0, this.typed);
    this.events.onChange(this.tree.id[f], -1);
  }

  // ── focus ───────────────────────────────────────────────────────────────

  /** Focus `slot`, or clear the focus with -1. Repaints both widgets. */
  setFocus(slot: i32): void {
    const t: WidgetTree = this.tree;
    const next: i32 = slot >= 0 && slot < t.used && t.focusable[slot] ? slot : -1;
    if (next == this.focusId) return;
    const prev: i32 = this.focusId;
    this.focusId = next;
    if (prev >= 0 && prev < t.used) this.setState(prev, State.Focus, false);
    if (next >= 0) this.setState(next, State.Focus, true);
  }

  /** Leave the focused widget. */
  blur(): void {
    this.setFocus(-1);
  }

  /**
   * Move focus to the next (or previous) focusable widget, in **pre-order**.
   *
   * Pre-order is the order a person reading the tree sees: a container, then its
   * first child, then that child's children. Two walks, because "the next one
   * after `focusId`" and "wrap to the first one" are different questions and
   * answering both in one pass needs a flag that then has to be un-set — the kind
   * of state that gets left behind. Neither walk allocates.
   */
  focusNext(back: bool): void {
    const t: WidgetTree = this.tree;
    if (t.root < 0) return;
    this.walkFound = -1;
    this.walkPassed = false;
    this.walkLast = -1;
    if (back) {
      this.walkBack(t.root, 0);
      // Nothing before the current focus: wrap to the last in the whole tree.
      if (this.walkFound < 0) {
        this.walkPassed = true;
        this.walkLast = -1;
        this.walkBack(t.root, 0);
        this.walkFound = this.walkLast;
      }
    } else {
      this.walkForward(t.root, 0);
      if (this.walkFound < 0) {
        this.walkPassed = true;
        this.walkForward(t.root, 0);
      }
    }
    if (this.walkFound >= 0) this.setFocus(this.walkFound);
  }

  // The walk's cursor. Fields rather than locals because the walk is recursive and
  // TensionScript has no closures — the same reason `Promote`-style helpers in this
  // tree carry their state.
  private walkFound: i32 = -1;
  private walkPassed: bool = false;
  private walkLast: i32 = -1;

  /** First focusable strictly after the current one, wrapping on a second pass. */
  private walkForward(i: i32, depth: i32): bool {
    if (depth > 64 || this.walkFound >= 0) return true;
    const t: WidgetTree = this.tree;
    if (t.kind[i] == KIND_NONE) return false;
    if (this.walkPassed && t.focusable[i]) {
      this.walkFound = i;
      return true;
    }
    if (i == this.focusId) this.walkPassed = true;
    let c: i32 = t.firstChild[i];
    while (c >= 0) {
      if (this.walkForward(c, depth + 1)) return true;
      c = t.nextSibling[c];
    }
    return false;
  }

  /** Last focusable strictly before the current one. */
  private walkBack(i: i32, depth: i32): void {
    if (depth > 64 || this.walkFound >= 0) return;
    const t: WidgetTree = this.tree;
    if (i == this.focusId) {
      this.walkFound = this.walkLast;
      return;
    }
    if (t.focusable[i]) this.walkLast = i;
    let c: i32 = t.firstChild[i];
    while (c >= 0) {
      this.walkBack(c, depth + 1);
      if (this.walkFound >= 0) return;
      c = t.nextSibling[c];
    }
  }

  // ── state bits ──────────────────────────────────────────────────────────

  /** Set or clear a `State` bit, repainting only when it actually changed. */
  setState(slot: i32, bit: i32, on: bool): void {
    const t: WidgetTree = this.tree;
    if (slot < 0 || slot >= t.used) return;
    const had: bool = (t.state[slot] & bit) != 0;
    if (had == on) return;
    t.state[slot] = on ? (t.state[slot] | bit) : (t.state[slot] & ~bit);
    t.markPaint(slot);
  }

  /** Track hover, and repaint the widget that gained or lost it. */
  private setHover(slot: i32): void {
    if (slot == this.hoverId) return;
    const prev: i32 = this.hoverId;
    this.hoverId = slot;
    if (prev >= 0) this.setState(prev, State.Hover, false);
    if (slot >= 0) this.setState(slot, State.Hover, true);
  }

  // ── reading back ────────────────────────────────────────────────────────

  /** The list item a row is showing, or -1. */
  itemOf(slot: i32): i32 {
    return slot >= 0 && slot < this.tree.used ? this.tree.itemIndex[slot] : -1;
  }

  /** The widget under the pointer. */
  get hovered(): i32 {
    return this.hoverId;
  }

  /** Whether a widget is focused. */
  isFocused(slot: i32): bool {
    return slot >= 0 && slot == this.focusId;
  }
}
