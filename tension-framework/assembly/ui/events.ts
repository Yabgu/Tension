// Events: what a pointer and a keyboard do to a retained tree.
//
// ## The order of a frame, and why it is that order
//
//     ui.frame(input);          // 1. dispatch, against LAST frame's targets
//     tree.layout();            // 2. measure/arrange whatever the event dirtied
//     tree.paint(p, ui.hits);   // 3. draw, recording THIS frame's targets
//
// Step 1 uses the hit list the *previous* paint produced, and that is deliberate
// rather than a wart. A hit list is a record of what was drawn, so it is always one
// frame old at the moment a click arrives; the alternative is to dispatch after
// painting, against rects that this frame has already moved. Given the choice
// between "the click is matched against where the widget was when you saw it" and
// "the click is matched against where it moved to while you clicked", the first is
// the one that activates what the user aimed at. The cost is that a focus ring
// appears one frame late, which nobody can see.
//
// ## Two ways to handle an event, and the order between them
//
// A widget's *behavior* (`WidgetBehavior.handle`) is for the widget's own logic: a
// divider consuming a drag, a field consuming a caret placement. An app's *closure*
// (`ui.onClick(id, cb)`) is for that widget's meaning in the app. At each widget on
// the way up:
//
//     1. a registered closure fires, and consumes the event;
//     2. otherwise the behavior's `handle` decides;
//     3. otherwise the event goes to the parent.
//
// Closures come first on purpose. `ButtonBehavior.handle` consumes a click (a button
// is a target — otherwise a button with nothing wired to it would click the panel
// behind it), so if the behavior ran first a `ui.onClick` closure would never fire.
// "The app decides, then the widget's default applies" is also the order a person
// expects: the handler runs, and the press is consumed either way.
//
// ## Capture
//
// A press on a widget whose behavior calls `ui.capture(id)` takes **capture**: every
// motion until the button comes up goes to that widget, wherever the pointer is.
// That is what lets a split's divider keep moving when the pointer leaves its 4-px
// band — the band decides *who grabbed it*, capture decides *who keeps it*. Capture
// is requested by the behavior, not by a `draggable` flag on the widget, because
// whether a gesture needs it is the widget's business.
//
// ## `readText` exactly once
//
// `Dispatcher.frame` calls `input.readText(scratch)` once, unconditionally, before
// anything else looks at it — and discards the bytes when nothing is focused. Both
// halves matter. Zero calls lets the host's mirror fill up and drop keystrokes; two
// calls (one here, one in an app's own handler) means two consumers draining one
// queue, so each sees half the typing.

import { Snapshot } from "../input";
import { Ui, WidgetBehavior } from "./builder";
import { UiEvent, UiEventKind } from "./event-def";
import { Hits } from "./hit";
import { KIND_NONE, State, WidgetTree } from "./layout";

// --- the handler targets ---------------------------------------------------
//
// ## Why a handler is an object with a method, and not a closure
//
// The API the brief asked for is `ui.onClick(id, () => { … })`, and that is what
// this file wanted to provide. It cannot work on the compiler this framework
// targets (TensionScript 0.13.2): a closure created in one module, stored in a
// framework object, and invoked from another **traps** — `wasm trap: uninitialized
// element`, an indirect call through a function-table entry that was never filled.
//
// Minimised, in this tree:
//
//     // works
//     const b = new Box((): void => { n++; });          b.run();
//     // traps at the call, with `this` captured as well
//     class Rec { calls: i32 = 0; watch(id: i32): void {
//       ui.onClick(id, (): void => { this.calls++; });
//     } }
//
// and capturing a **mutable local** is refused outright or aborts at the first
// call (`AS100: Not implemented: a captured local without a declared type`, then
// `E_INDEXOUTOFORDER` from `~lib/array.ts` when it is typed). Whatever the exact
// lowering defect, the consequence for an API is the same: a closure cannot be
// handed to the framework and called back later.
//
// So a handler is an **object with a method**, which this compiler dispatches
// correctly — it is the same mechanism `WidgetBehavior` uses to call a widget's
// own logic, and it is verified by every widget in the test suite. The shape an
// app writes is a one-line class:
//
//     class Save extends ClickTarget {
//       click(): void { this.doc.save(); }
//     }
//     ui.onClick(this.saveButton, new Save(this));
//
// ## What changes when the compiler is fixed
//
// Nothing above `Dispatcher`. `ClickTarget` is the extension point; a `ClickFn`
// overload of `ui.onClick` that wraps the closure in a target is additive, and the
// wrapper is the only thing that would need to disappear.

/** What a press on a widget does. Implement it and pass an instance. */
export interface ClickTarget {
  click(): void;
}

/** What a value change does. `value` is a slider's position, or -1 for text. */
export interface ChangeTarget {
  change(value: i32): void;
}

/** A target that does nothing, for a slot with no handler. */
class NoClick implements ClickTarget {
  click(): void {}
}

class NoChange implements ChangeTarget {
  change(value: i32): void {}
}

const NO_CLICK: ClickTarget = new NoClick();
const NO_CHANGE: ChangeTarget = new NoChange();

/**
 * The scratch `readText` writes into.
 *
 * 512 bytes is a paste, not a keypress. A frame that delivers more than this answers
 * `-ENOSPC` and **consumes nothing**; the dispatcher then grows the buffer to
 * `textPending()` so the *next* frame's single read succeeds. Growing on demand is
 * the one allocation this file can make, and it is bounded by what the user pasted
 * rather than by the frame rate.
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



/**
 * The keyboard and pointer state a frame is dispatched against.
 *
 * Kept separate from `Snapshot` because it is the *latched* view: `Snapshot` is what
 * the capability said this frame, and this is what changed since the last time the
 * UI looked. One `poll` per frame, then any number of reads.
 */
export class Pointer {
  x: i32 = 0;
  y: i32 = 0;
  dx: i32 = 0;
  dy: i32 = 0;
  /** The wheel delta for this frame, in notches (positive is away from the user). */
  wheel: i32 = 0;
  /** The modifier word, SDL `KMOD_*`. */
  mods: i32 = 0;
  /** Button 1, this frame and last. */
  down: bool = false;
  private wasDown: bool = false;

  /** Take this frame's state and compute the edges against the previous one. */
  poll(input: Snapshot): void {
    this.x = input.mouseX;
    this.y = input.mouseY;
    this.dx = input.mouseDx;
    this.dy = input.mouseDy;
    this.wheel = <i32>input.wheelY;
    this.mods = input.modifiers;
    this.wasDown = this.down;
    this.down = (input.mouseButtons & 1) != 0;
  }

  /** Button 1 went down since the last `poll`. */
  get pressed(): bool {
    return this.down && !this.wasDown;
  }

  /** Whether shift is held, SDL's `KMOD_LSHIFT | KMOD_RSHIFT`. */
  get shift(): bool {
    return (this.mods & 0x3) != 0;
  }

  /** Button 1 came up since the last `poll`. */
  get released(): bool {
    return !this.down && this.wasDown;
  }
}

/**
 * The dispatcher: focus, capture, hover, and the bubble.
 *
 * Owns the four slots the user's attention is on (`focusId`, `captureId`,
 * `hoverId`, `pressedId`) and turns a frame of input into calls on behaviors and
 * closures. It owns no widgets and draws nothing.
 */
export class Dispatcher {
  tree: WidgetTree;
  hits: Hits;
  /** The facade handed to behaviors. Set by `Ui`'s constructor. */
  owner: Ui | null = null;

  pointer: Pointer = new Pointer();

  /** The focused widget's **slot**, or -1. */
  focusId: i32 = -1;
  /** The widget holding mouse capture, or -1. */
  captureId: i32 = -1;
  /** The widget under the pointer, from the last dispatch. */
  hoverId: i32 = -1;
  /** The widget the button went down on, or -1. Cleared on release. */
  pressedId: i32 = -1;
  /** The list item the last press landed on, or -1. Read by a click handler. */
  lastItem: i32 = -1;

  /** Typed bytes delivered to the focused field this frame. */
  typed: i32 = 0;
  /** Typed bytes the scratch could not hold (`-ENOSPC`); nothing was consumed. */
  typedDropped: i32 = 0;

  /** The one reusable event object; see `UiEvent`. */
  private ev: UiEvent = new UiEvent();
  /** The buffer `readText` writes into. Sized for a paste, not for a keypress. */
  private scratch: Uint8Array = new Uint8Array(TEXT_SCRATCH);

  // --- the handler targets ----------------------------------------------------
  //
  // One array per event kind, keyed by slot, pre-filled with a shared no-op so no
  // slot is ever a hole (the collector visits every element of a reference array).
  // The `has*` flags say which slots hold a real target.
  private clicks: ClickTarget[];
  private changes: ChangeTarget[];
  private scrolls: ChangeTarget[];
  private submits: ClickTarget[];
  // The arrays are created holey (every slot null), and reading a null slot of a
  // non-nullable element type throws `E_HOLEYARRAY` — so a slot is only indexed once
  // its flag says a handler was registered. That also states the intent at the call
  // site, which a null-check on the value cannot.
  private hasClick: bool[];
  private hasChange: bool[];
  private hasScroll: bool[];
  private hasSubmit: bool[];

  constructor(tree: WidgetTree, hits: Hits) {
    this.tree = tree;
    this.hits = hits;
    const cap: i32 = tree.capacity;
    // Pre-filled, not holey: an array of a non-nullable reference type created with
    // a length holds nulls, and every slot the collector visits must be a real
    // object. A shared no-op target in each slot keeps the array fully populated;
    // the `has*` flags decide what actually fires.
    this.clicks = filledClicks(cap);
    this.changes = filledChanges(cap);
    this.scrolls = filledChanges(cap);
    this.submits = filledClicks(cap);
    this.hasClick = new Array<bool>(cap);
    this.hasChange = new Array<bool>(cap);
    this.hasScroll = new Array<bool>(cap);
    this.hasSubmit = new Array<bool>(cap);
  }

  // ── registration ─────────────────────────────────────────────────────────

  setClick(slot: i32, target: ClickTarget): void {
    if (slot < 0 || slot >= this.tree.capacity) return;
    this.clicks[slot] = target;
    this.hasClick[slot] = true;
  }

  setChange(slot: i32, target: ChangeTarget): void {
    if (slot < 0 || slot >= this.tree.capacity) return;
    this.changes[slot] = target;
    this.hasChange[slot] = true;
  }

  setScroll(slot: i32, target: ChangeTarget): void {
    if (slot < 0 || slot >= this.tree.capacity) return;
    this.scrolls[slot] = target;
    this.hasScroll[slot] = true;
  }

  setSubmit(slot: i32, target: ClickTarget): void {
    if (slot < 0 || slot >= this.tree.capacity) return;
    this.submits[slot] = target;
    this.hasSubmit[slot] = true;
  }

  /** Forget every handler on a slot. Called when the slot is freed. */
  clearHandlers(slot: i32): void {
    if (slot < 0 || slot >= this.tree.capacity) return;
    this.hasClick[slot] = false;
    this.hasChange[slot] = false;
    this.hasScroll[slot] = false;
    this.hasSubmit[slot] = false;
  }

  /** Fire a change handler, if one is registered. Called by a behavior. */
  fireChange(slot: i32, value: i32): void {
    if (slot < 0 || slot >= this.tree.capacity) return;
    if (!this.hasChange[slot]) return;
    this.changes[slot].change(value);
  }

  /** Fire a submit handler, if one is registered. Called by a behavior. */
  fireSubmit(slot: i32): void {
    if (slot < 0 || slot >= this.tree.capacity) return;
    if (!this.hasSubmit[slot]) return;
    this.submits[slot].click();
  }

  // ── the frame ────────────────────────────────────────────────────────────

  /**
   * Dispatch one frame.
   *
   * `input` may be null — an app that drives the dispatcher itself, or a headless
   * frame with no capability — in which case nothing is read and nothing moves, but
   * the method is still the frame boundary.
   */
  frame(input: Snapshot | null): void {
    this.typed = 0;
    this.typedDropped = 0;

    // ── 1. the keystrokes, exactly once, whatever happens next ─────────────
    if (input != null) {
      const got: i32 = input.readText(this.scratch);
      if (got > 0) {
        this.typed = got;
      } else if (got < 0) {
        // `-ENOSPC`: bigger than the scratch, and **nothing was consumed**. Grow to
        // what is waiting so the next frame's single read succeeds — retrying with
        // the same buffer would fail identically for ever, which is a stall.
        this.typedDropped = -got;
        const need: i32 = input.textPending();
        if (need > 0) this.scratch = new Uint8Array(need + 64);
      }
    }

    // ── 2. the pointer, latched ────────────────────────────────────────────
    if (input != null) this.pointer.poll(input);
    this.tree.shiftHeld = this.pointer.shift;

    // ── 3. focus keys, before the pointer ──────────────────────────────────
    if (input != null) {
      if (input.pressed(SCAN_TAB)) this.focusNext(this.pointer.shift);
      if (input.pressed(SCAN_ESCAPE)) this.blur();
    }

    // ── 4. hover ───────────────────────────────────────────────────────────
    const slot: i32 = input != null ? this.hits.tagAt(this.pointer.x, this.pointer.y) : -1;
    this.setHover(slot);

    // ── 5. the press edge ──────────────────────────────────────────────────
    if (this.pointer.pressed) this.press(slot);

    // ── 6. keys and typed text, to the focused widget ──────────────────────
    if (input != null) this.keys(input);
    if (this.typed > 0) this.typedText();

    // ── 7. motion while captured ───────────────────────────────────────────
    //
    // Every frame the button is down, not only the frames the pointer moved. A split
    // only cares about the delta, but a slider maps the pointer's *position* onto its
    // range, and skipping a frame with no recorded delta is how a thumb stops one
    // pixel short of the click.
    if (this.captureId >= 0 && this.pointer.down) this.drag();

    // ── 8. the wheel ───────────────────────────────────────────────────────
    if (this.pointer.wheel != 0 && slot >= 0) this.wheel(slot);

    // ── 9. the release edge, last so it sees this frame's drag ─────────────
    if (this.pointer.released) this.releaseEdge();
  }

  // ── the edges ────────────────────────────────────────────────────────────

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

    this.setState(slot, State.Press, true);

    // The pointer's position in the widget's own content box, so a field can place
    // its caret without knowing where it is.
    this.ev.set(UiEventKind.Click, this.pointer.x, this.pointer.y, 0, 0, 0,
                this.pointer.mods);
    this.ev.localX = this.pointer.x - (t.x[slot] + t.pad[slot]);
    this.bubble(slot, this.ev);
  }

  private releaseEdge(): void {
    const slot: i32 = this.captureId >= 0 ? this.captureId : this.pressedId;
    if (slot >= 0 && slot < this.tree.used) {
      this.ev.set(UiEventKind.Release, this.pointer.x, this.pointer.y, 0, 0, 0,
                  this.pointer.mods);
      this.bubble(slot, this.ev);
      this.setState(slot, State.Press, false);
    }
    if (this.pressedId >= 0 && this.pressedId != slot) {
      this.setState(this.pressedId, State.Press, false);
    }
    this.pressedId = -1;
    this.captureId = -1;
  }

  private drag(): void {
    this.ev.set(UiEventKind.Drag, this.pointer.x, this.pointer.y,
                this.pointer.dx, this.pointer.dy, 0, this.pointer.mods);
    this.bubble(this.captureId, this.ev);
  }

  private wheel(slot: i32): void {
    this.ev.set(UiEventKind.Wheel, this.pointer.x, this.pointer.y, 0, 0,
                this.pointer.wheel, this.pointer.mods);
    this.bubble(slot, this.ev);
  }

  /** Key presses, to the focused widget and up from there. */
  private keys(input: Snapshot): void {
    const f: i32 = this.focusId;
    if (f < 0) return;
    for (let code: i32 = 0; code < 90; code++) {
      if (!input.pressed(<u32>code)) continue;
      this.ev.set(UiEventKind.Key, this.pointer.x, this.pointer.y, 0, 0, code,
                  this.pointer.mods);
      this.bubble(f, this.ev);
    }
  }

  /** Typed bytes, to the focused widget or thrown away. */
  private typedText(): void {
    const f: i32 = this.focusId;
    if (f < 0) return;   // consumed and discarded: see the header
    this.ev.set(UiEventKind.Text, this.pointer.x, this.pointer.y, 0, 0, this.typed,
                this.pointer.mods);
    this.bubble(f, this.ev);
  }

  /**
   * Up the parent chain: closure first, then the behavior.
   *
   * The depth guard is the tree's own — `append` refuses a cycle — plus a bound for
   * the tree a caller built by hand.
   */
  private bubble(slot: i32, ev: UiEvent): bool {
    const t: WidgetTree = this.tree;
    const owner: Ui = <Ui>this.owner;
    let s: i32 = slot;
    let guard: i32 = 0;
    while (s >= 0 && s < t.used && guard < 64) {
      if (this.fire(s, ev)) return true;
      if (t.behavior[s].handle(owner, s, ev)) return true;
      s = t.parent[s];
      guard++;
    }
    return false;
  }

  /** The closure for this event kind on this slot, if one is registered. */
  private fire(slot: i32, ev: UiEvent): bool {
    if (ev.kind == UiEventKind.Click) {
      if (!this.hasClick[slot]) return false;
      this.clicks[slot].click();
      return true;
    }
    if (ev.kind == UiEventKind.Wheel) {
      if (!this.hasScroll[slot]) return false;
      this.scrolls[slot].change(ev.value);
      return true;
    }
    // Drag, Release, Key and Text have no app-facing closure: a drag is the widget's
    // own gesture, and a key or a keystroke is the focused field's. Both are
    // behaviors, and a change of *value* reaches the app through `fireChange`.
    return false;
  }

  // ── typed bytes ──────────────────────────────────────────────────────────

  /** Insert this frame's typed bytes at the focused widget's caret. */
  insertTyped(slot: i32): void {
    if (this.typed <= 0) return;
    this.tree.insertAtCaret(slot, this.scratch, 0, this.typed);
  }

  /**
   * Put this frame's bytes into a widget's text.
   *
   * The same window `insertTyped` writes, from a caller that is not the dispatch
   * path — which is what a custom behavior reading `UiEventKind.Text` needs.
   */
  typedInto(slot: i32): void {
    this.insertTyped(slot);
  }

  // ── capture ──────────────────────────────────────────────────────────────

  /** Give `slot` every motion until the button comes up. */
  capture(slot: i32): void {
    if (slot < 0 || slot >= this.tree.used) return;
    this.captureId = slot;
  }

  /** Drop capture: the gesture is over. */
  release(): void {
    this.captureId = -1;
  }

  // ── focus ────────────────────────────────────────────────────────────────

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
   * first child, then that child's children. Two walks, because "the next one after
   * `focusId`" and "wrap to the first" are different questions and answering both in
   * one pass needs a flag that then has to be un-set.
   */
  focusNext(back: bool): void {
    const t: WidgetTree = this.tree;
    if (t.root < 0) return;
    this.walkFound = -1;
    this.walkPassed = false;
    this.walkLast = -1;
    if (back) {
      this.walkBack(t.root, 0);
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

  private walkFound: i32 = -1;
  private walkPassed: bool = false;
  private walkLast: i32 = -1;

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

  // ── state bits ───────────────────────────────────────────────────────────

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

  // ── reading back ─────────────────────────────────────────────────────────

  /** The list item a row is showing, or -1. */
  itemOf(slot: i32): i32 {
    return slot >= 0 && slot < this.tree.used ? this.tree.itemIndex[slot] : -1;
  }

  /** Whether a widget is focused. */
  isFocused(slot: i32): bool {
    return slot >= 0 && slot == this.focusId;
  }
}


// --- the pre-filled arrays -------------------------------------------------
//
// A slot the app never wired holds a shared no-op target rather than a hole. An
// array of a non-nullable reference type created with a length is *holey* (every
// element null), and the collector visits every element — the measured symptom of
// leaving the holes in was `wasm trap: uninitialized element` inside a GC visit,
// which reads as a closure bug and is not one.

function filledClicks(n: i32): ClickTarget[] {
  const out = new Array<ClickTarget>(n);
  for (let i: i32 = 0; i < n; i++) out[i] = NO_CLICK;
  return out;
}

function filledChanges(n: i32): ChangeTarget[] {
  const out = new Array<ChangeTarget>(n);
  for (let i: i32 = 0; i < n; i++) out[i] = NO_CHANGE;
  return out;
}
