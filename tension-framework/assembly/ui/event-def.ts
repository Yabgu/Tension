// The event vocabulary, in a module that imports nothing.
//
// ## Why this is its own file
//
// `UiEvent` is the one type that has to be visible from **both** the dispatcher and
// the behavior interface, and those two live on opposite sides of an import cycle:
// `builder.ts` needs `Dispatcher` (to construct one), and `events.ts` needs `Ui` (to
// hand to behaviors). Keeping `UiEvent` in either would make the cycle a *runtime*
// one, and the measured symptom of that here was a hard `wasm trap: uninitialized
// element` — an indirect call through a function-table slot that had not been
// filled, because one module's initialisation ran before the other's.
//
// A leaf module has no such order. Both sides import it, neither can break it, and
// the cycle above is reduced to type-only edges (proven safe in this compiler:
// `Ui` in a signature erases, `Dispatcher` in a constructor call does not).

/** What kind of interaction a `UiEvent` describes. */
export const enum UiEventKind {
  /** The button went down on this widget. */
  Click = 0,
  /** The button came up. */
  Release = 1,
  /** The pointer moved while this widget holds capture. */
  Drag = 2,
  /** The wheel turned. */
  Wheel = 3,
  /** A key went down; `value` is the SDL scancode. */
  Key = 4,
  /** Typed text arrived for the focused widget; the bytes are in `ui.pendingText`. */
  Text = 5,
  /**
   * This widget just gained the focus. Delivered to its behavior only.
   *
   * A field needs it for one reason that is not cosmetic: the caret. A field that
   * has never been focused has a caret at 0, so Tab into it and the first character
   * lands *before* the existing text — a real bug, and one no amount of click
   * handling fixes, because a Tab is not a click. The event is not bubbled: focus
   * belongs to one widget, and a container hearing it would have to filter.
   */
  Focus = 6,
}

/**
 * One event, reused for every dispatch.
 *
 * A single instance (the dispatcher's) is refilled per event rather than allocated:
 * a drag delivers sixty `Drag` events a second and none of them should touch the
 * heap. A behavior that wants to keep an event must copy the fields it needs.
 */
export class UiEvent {
  kind: i32 = UiEventKind.Click;
  /** Pointer position, in tree coordinates. */
  x: i32 = 0;
  y: i32 = 0;
  /** Motion since the last frame, for `Drag`. */
  dx: i32 = 0;
  dy: i32 = 0;
  /** A scancode for `Key`, a slider value or byte count elsewhere. */
  value: i32 = 0;
  /** Modifier bits, SDL `KMOD_*`: bit 0 is shift. */
  mods: i32 = 0;
  /** Pointer position in the widget's own content box, for `Click` on a field. */
  localX: i32 = 0;

  /** Refill for a fresh dispatch. */
  set(kind: i32, x: i32, y: i32, dx: i32, dy: i32, value: i32, mods: i32): void {
    this.kind = kind;
    this.x = x;
    this.y = y;
    this.dx = dx;
    this.dy = dy;
    this.value = value;
    this.mods = mods;
    this.localX = 0;
  }

  /** Whether shift is held, for a caret-extending move. */
  get shift(): bool {
    return (this.mods & 0x3) != 0;
  }
}


/** How far one wheel notch scrolls a list, in pixels. */
export const WHEEL_STEP: i32 = 48;
