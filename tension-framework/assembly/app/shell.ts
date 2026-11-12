// The frame loop and the window lifecycle, for a guest app that wants neither.
//
// ## What this is for
//
// Every 2D *application* in this tree — the documentation viewer, and now the
// editor — has the same non-drawing code, and all of it is hard-won:
//
//   * a canvas is **fixed for its lifetime**, so a window resize is `close()` and
//     a new `open()`, and the textures have to come back with it;
//   * on that reopen the canvas must be claimed with `OPEN_WINDOWED`, because
//     `windowedOrOffscreen` tests `platform.hasSurface()` — false for a window an
//     SDL_GPU device owns — and would quietly open *offscreen*, a resize that
//     stops presenting (`openCanvas` records the measurement);
//   * a refused close abandons the resize rather than opening anyway, because
//     `open` would then answer `-EBUSY` and leave no drawable canvas at all;
//   * the close button must be *asked* for (`windowInfo().closeRequested`), since
//     the host's own pump is the one that drains SDL's quit event;
//   * `input.attach` answers `-ENODEV` for the first frames while the window comes
//     up, so a failure is a retry rather than a crash.
//
// Each of those is a bug that was found by running the thing. A second app that
// copies them is a second app that will find them again, which is why they live
// here instead.
//
// ## What an app implements
//
//     class MyApp extends AppShell {
//       loadAssets(canvas: Canvas, pipe: i32): bool { … }   // textures, once and per resize
//       draw(p: Painter): void { … }                        // one frame, records only
//     }
//
// `draw` is inside a frame the shell owns: it resets the painter before the call
// and submits it after, so a frame cannot be built and never sent.
//
// ## What it does not do
//
// It has no scene, no entities, no widgets and no input policy — `draw` gets a
// `Painter` and `update` gets nothing, and both read the app's own state. A
// game that wants a declarative scene uses `Scene.run` instead; this is for the
// apps that draw a UI.

import { Canvas } from "../2d/canvas";
import { OPEN_WINDOWED } from "../2d/constants";
import { ConfigBuilder, RuntimeSession } from "../runtime";
import { close as inputClose, Snapshot } from "../input";
import { print } from "../io";
import { Theme } from "../ui/theme";
import { fontBook } from "../ui/fonts";
import { Painter } from "../ui/painter";
import { windowInfo, windowRequest, WindowInfo } from "../platform";

/**
 * How long one frame waits for the host before drawing the next.
 *
 * Without it a software driver spins as fast as the CPU allows and a scroll runs
 * away from the wheel. 16 ms is a 60 Hz frame; the host owns the pacing
 * (`RuntimeSession.wait`), so this is a request rather than a clock.
 */
export const FRAME_WAIT_MS: i32 = 16;

export abstract class AppShell {
  canvas: Canvas | null = null;
  pipe: i32 = -1;
  painter: Painter;

  /** The input record, its buffer and its edge latch, in one object. */
  input: Snapshot = new Snapshot(0);
  inputReady: bool = false;

  width: i32 = 1280;
  height: i32 = 720;
  /** True when the launcher asked for no window; the loop is then bounded. */
  headless: bool = false;
  /** Frames drawn; the teardown line and any status bar read it. */
  frames: i32 = 0;
  /** Records the last frame submitted, and how many the budget refused. */
  lastRecords: i32 = 0;
  lastDropped: i32 = 0;

  /** The size the current canvas was opened at, so a resize is one comparison. */
  private canvasW: i32 = 0;
  private canvasH: i32 = 0;
  private title: string = "";
  /** Frames an offscreen run draws before stopping; 0 means "no bound". */
  private headlessBudget: i32;
  private exitReason: string = "the frame bound was reached";
  /** Set by `stopLoop`; the loop reads it once per frame. */
  private stopping: bool = false;
  /** The name this app's lines carry. A build's logs should say which app. */
  private name: string;

  constructor(name: string = "app", theme: Theme = fontBook().pages[0], headlessBudget: i32 = 120) {
    this.name = name;
    this.painter = new Painter(theme);
    this.headlessBudget = headlessBudget;
  }

  // ── what an app supplies ────────────────────────────────────────────────

  /**
   * Load the app's textures and bind them. Called once at startup and again
   * after every canvas rebuild — a canvas is fixed for its lifetime, so
   * reopening one destroys its textures with it.
   *
   * Returns `false` to abort startup; `start` reports what failed and returns, so
   * the shell never draws against a half-open canvas.
   */
  protected abstract loadAssets(canvas: Canvas, pipe: i32): bool;

  /** Draw one frame. The shell has reset the painter; anything emitted is sent. */
  protected abstract draw(p: Painter): void;

  /**
   * End the loop from inside the app, after this frame.
   *
   * The guest cannot close the host's window (that is the window manager's, and
   * `closeRequested` reports it rather than causing it), so an app whose menu says
   * **Exit** needs a way to stop that is its own. The frame in flight still draws
   * and presents — an exit that skipped the draw would leave the last visible frame
   * half a frame old — and the ordinary `teardown` path runs, so textures, the input
   * handle and the session are still released in the one place they always were.
   */
  protected stopLoop(reason: string = "the app asked to exit"): void {
    this.stopping = true;
    this.exitReason = reason;
  }

  /** Read input, once per frame, before the draw. The default reads nothing. */
  protected update(): void {}

  /**
   * The window size changed: recompute the layout here.
   *
   * Called after `width`/`height` are updated and **before** the canvas is
   * replaced, so it must be arithmetic on the size and the app's own data — no
   * canvas, no textures, nothing that the reopen is about to destroy.
   */
  protected onResize(width: i32, height: i32): void {}

  /** After a frame is presented. The default does nothing. */
  protected afterFrame(): void {}

  /**
   * The bucket this shell submits its painter into. **0 unless an app composites.**
   *
   * Buckets are draw order, ascending, and each is one draw call and one pipeline
   * — so an app that draws a scene *under* its own UI here needs two: the scene
   * into a lower bucket with its pipeline, the UI into a higher one. Submitting
   * both into 0 is refused by the renderer rather than silently merged ("a bucket
   * that already belongs to another pipe"), which is how this was found.
   */
  protected get uiBucket(): i32 {
    return 0;
  }

  // ── lifecycle ───────────────────────────────────────────────────────────

  /**
   * Open the session, take the window request, open the canvas, load assets and
   * attach input.
   *
   * Every failure is fatal and says why: an app that opens a blank window with no
   * explanation is worse than one that refuses, because the user cannot tell "the
   * assets are missing" from "it crashed".
   */
  start(): bool {
    if (RuntimeSession.open(ConfigBuilder.forThisBuild()) != 0) {
      print(this.name + ": the session did not open");
      return false;
    }

    const request = windowRequest();
    this.headless = request.headless;
    this.title = request.title;
    this.width = request.width > 0 ? request.width : 1;
    this.height = request.height > 0 ? request.height : 1;

    // Create the window first, then take the size from the **window**: the host
    // fits a request that cannot fit the display (a client area the size of the
    // work area leaves no room for its own title bar), and a layout built on the
    // request would be a layout for a window that does not exist. Opening the
    // canvas before this read is what made a fitted window draw at the requested
    // size and rebuild on the next frame, paying for two GPU devices to arrive
    // at the size the window had all along.
    if (!this.headless) {
      Canvas.openWindow(this.width, this.height, this.title);
      const actual: WindowInfo = windowInfo();
      if (actual.width > 0 && actual.height > 0) {
        this.width = <i32>actual.width;
        this.height = <i32>actual.height;
      }
    }

    // Before the canvas: a layout is arithmetic on the window size, so computing
    // it first means `loadAssets` can already read a column count.
    this.onResize(this.width, this.height);

    if (!this.openCanvas(this.width, this.height, this.title, false)) return false;

    this.setupInput();
    return true;
  }

  /**
   * Create the canvas and hand it to `loadAssets`.
   *
   * Extracted because it happens **twice** in a normal session: once at startup
   * and once per resize. A canvas is fixed for its lifetime, so a resize is a
   * `close()` and a new `open()` — which also destroys every texture and the
   * pipeline cache with it. Doing that in one place is what keeps the two paths
   * from disagreeing.
   *
   * The **host window is not recreated**: `2d:close` releases the swapchain and
   * the GPU device and deliberately leaves the window up, so reopening claims the
   * same window at its new size. That is what makes a resize invisible to the
   * user's drag — a window torn down and remade would snap back.
   */
  protected openCanvas(width: i32, height: i32, title: string, reopen: bool): bool {
    // On a **reopen** the window already exists, so the canvas claims it with
    // `OPEN_WINDOWED` and nothing creates a second one. `windowedOrOffscreen`
    // would be wrong here: its fallback tests `platform.hasSurface()`, which is
    // false for a window SDL_GPU owns (there is no Vulkan surface), so it would
    // try to create a window that already exists and then quietly open
    // *offscreen* — a resize that stops presenting. Measured, not assumed.
    const canvas: Canvas = this.headless
      ? Canvas.open(width, height)
      : (reopen ? Canvas.open(width, height, OPEN_WINDOWED)
                : Canvas.windowedOrOffscreen(width, height, title));
    this.canvas = canvas;
    if (!canvas.isValid()) {
      print(this.name + ": canvas refused at " + width.toString() + "x" + height.toString() +
        ": " + canvas.lastError().toString());
      return false;
    }
    this.canvasW = width;
    this.canvasH = height;

    // Preset 1 — the built-in `default_2d` pipeline, addressed by id with no graph
    // blob. A UI needs nothing a custom graph would give it: one texture, alpha
    // blend, and the record's own geometry.
    this.pipe = canvas.pipeline();
    if (this.pipe < 0) {
      print(this.name + ": set_pipeline refused: " + this.pipe.toString());
      return false;
    }

    if (!this.loadAssets(canvas, this.pipe)) return false;
    return true;
  }

  /**
   * Rebuild the canvas and the layout when the user resizes the window.
   *
   * Polled once per frame rather than driven by an event: the guest has no event
   * queue of its own, and `windowInfo()` is one call that answers the question
   * outright. The cost of polling is a compare against two ints.
   */
  syncWindowSize(): bool {
    if (this.headless) return false;
    const info: WindowInfo = windowInfo();
    // A closing window reports zero, and "0x0" is not a size to lay out for.
    if (info.width <= 0 || info.height <= 0) return false;
    if (<i32>info.width == this.canvasW && <i32>info.height == this.canvasH) return false;

    // A refused close is **not** recovered from by opening anyway: `open` would
    // answer `-EBUSY` ("a canvas is already open"), leaving the app with no
    // drawable canvas at all and a loop that exits on the next `present`. So a
    // refusal abandons this resize and lets the next frame try again, with the
    // old canvas still valid and still presenting.
    if (this.canvas != null && this.canvas!.isValid()) {
      const closed: i32 = this.canvas!.close();
      if (closed != 0) {
        print(this.name + ": canvas would not close for a resize (" + closed.toString() +
          "); keeping the old size");
        return false;
      }
    }

    this.width = <i32>info.width;
    this.height = <i32>info.height;
    // The app re-lays out and clamps its scroll *before* the canvas comes back: a
    // window dragged wider would otherwise leave the user past the end of content
    // that just got shorter, and the clamp has to happen before the frame that
    // draws against the new size.
    this.onResize(this.width, this.height);
    if (!this.openCanvas(this.width, this.height, this.title, true)) return false;
    return true;
  }

  /**
   * Open the input capability.
   *
   * `attach` may answer `-ENODEV` for a few frames while the host's window comes
   * up — the input layer joins the window rather than owning one — so a failure
   * here is not fatal: the app still draws, and a status line can say whether the
   * mouse and keyboard arrived.
   */
  protected setupInput(): void {
    this.input = Snapshot.open();
    if (this.input.handle > 0 && this.input.attach()) this.inputReady = true;
  }

  /** Retry the attach; called once per frame until it succeeds. */
  protected pollAttach(): void {
    if (this.inputReady) return;
    if (this.input.attach()) this.inputReady = true;
  }

  /** The frame loop. Returns when the window closes, the budget ends, or a verb refuses. */
  run(): void {
    if (!this.start()) {
      this.teardown();
      return;
    }

    while (true) {
      // The close button, asked directly — and it has to be asked here.
      //
      // Measured, by removing this check and clicking the X: the process never
      // exits. `present`'s `-ECANCELED` is not a fallback, because the renderer
      // learns of the close from its *own* pump, and the host pumps too. Whichever
      // pump drains SDL's quit event is the only one that sees it, and it is
      // normally the host's — so an app that owns its lifetime must stop on the
      // request itself.
      if (windowInfo().closeRequested) {
        this.exitReason = "the window was closed";
        break;
      }

      // A resize rebuilds the canvas and re-lays out, so it runs before anything
      // reads the geometry — and before `present`, because the canvas that would
      // present is the one being replaced.
      this.syncWindowSize();

      this.pollAttach();
      this.update();

      const p = this.painter;
      p.reset();
      this.draw(p);
      const accepted = p.submit(this.canvas!, this.pipe, this.uiBucket);
      this.lastRecords = p.count;
      this.lastDropped = p.dropped;
      if (accepted < p.count) {
        // The renderer staged fewer than we emitted; say so rather than silently
        // losing the tail of the frame.
        print(this.name + ": the renderer accepted " + accepted.toString() + " of " +
          p.count.toString() + " records");
      }

      const presented = this.canvas!.present();
      if (presented != 0) {
        // `-ECANCELED` once the window is closed: stop, do not retry.
        this.exitReason = "present answered " + presented.toString();
        break;
      }
      this.frames++;
      this.afterFrame();
      // `stopLoop` asked for this: the frame it was asked in has been drawn and
      // presented, which is the difference between an exit and a freeze.
      if (this.stopping) break;

      RuntimeSession.wait(FRAME_WAIT_MS);

      // An offscreen run has no window to close and would loop until something
      // kills it. A bound makes `--headless` a job that finishes, which is what a
      // CI check and a screenshot harness both need.
      if (this.headless && this.headlessBudget > 0 && this.frames >= this.headlessBudget) break;
    }

    this.teardown();
  }

  teardown(): void {
    if (this.input.handle > 0) inputClose(this.input.handle);
    if (this.canvas != null && this.canvas!.isValid()) this.canvas!.close();
    RuntimeSession.close();
    // Said out loud, because "the window closed" and "the process died" look
    // identical from the launcher otherwise, and the difference is the whole point
    // of exiting through this path.
    print(this.name + ": closed after " + this.frames.toString() + " frame(s) (" + this.exitReason + ")");
  }

  /** Where the text column starts for a pane, given the theme's cell. */
  get cellW(): i32 {
    return this.painter.theme.cellW;
  }

  /** The cell's height, for a caller laying out rows. */
  get cellH(): i32 {
    return this.painter.theme.cellH;
  }
}
