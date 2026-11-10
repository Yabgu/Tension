// `tension-docs`: the offline documentation viewer.
//
// A Tension guest that reads four files out of its packed volume and draws a
// reading UI with nothing but the 2D sprite API:
//
//     /docs.bin         the pages, blocks and runs (2.2a)
//     /search.bin       the inverted index (2.2a)
//     /transcripts.bin  recorded output for the runnable blocks (2.2a)
//     /ui.iwi           the font atlas: 5 colours x 2 weights x 95 glyphs
//
// ## The frame
//
//     0                                           1280
//     +----------------+-----------------------------+
//     |  sidebar       |  search bar                 |  0
//     |  (table of     +-----------------------------+
//     |   contents)    |                             |  40
//     |                |  content column (80 cols)   |
//     |                |                             |
//     |                |                             |  690
//     +----------------+-----------------------------+
//     |  status: page, position, hints              |  690..720
//     +---------------------------------------------+
//
// The sidebar is 260px, the divider one pixel, and the content column is 640px
// (80 characters) at x=301 — the measure, with room for a margin on both sides.
//
// ## What this file is not
//
// It is not a retained-mode UI. Every frame is built from scratch into one
// record buffer and submitted once, which is what makes scrolling exact: there is
// no scroll state to invalidate, only an offset that changes what the same loop
// decides to draw. `text.ts` and `layout.ts` carry the two expensive parts, and
// both are cached across frames.

import {
  Canvas,
  ConfigBuilder,
  print,
  resReadFile,
  RuntimeSession,
} from "tension-framework";
import {
  attach as inputAttach,
  close as inputClose,
  Kind as InputKind,
  InputState,
  open as inputOpen,
  state as inputState,
} from "tension-framework/assembly/input";
import { windowInfo, windowRequest } from "tension-framework/assembly/platform";

import {
  Docs, SearchIndex, Transcripts,
  B_LEVEL, F_RUNNABLE, K_CODE, K_HEADING, K_LIST_ITEM, K_QUOTE, K_RULE,
  S_CODE, S_LINK, compareTermToQuery, jsonNumber, termHasPrefix,
} from "./format";
import {
  advanceFor, CODE_INSET, colourFor, CONTENT_COLS, LINE_STEP, PageLayout, weightFor,
} from "./layout";
import {
  CELL_H, CELL_W, CHROME_CARET, CHROME_DIVIDER, CHROME_PANEL, CHROME_SELECTION,
  CHROME_WHITE,
  CODE, GLYPH_CELLS, HEADING, LINK, MUTED, NORMAL, Painter, REGULAR, BOLD,
} from "./text";

// ── the shell's geometry ────────────────────────────────────────────────────

const SIDEBAR_W: i32 = 260;
const DIVIDER_X: i32 = SIDEBAR_W;
const MAIN_X: i32 = SIDEBAR_W + 1;
const SEARCH_H: i32 = 40;
const STATUS_H: i32 = 30;
const CONTENT_X: i32 = MAIN_X + 40;
const CONTENT_TOP: i32 = SEARCH_H + 8;

/** Rows of the table of contents that fit the sidebar. */
const TOC_STEP: i32 = 22;

/** Scancodes (SDL numbering) — `input.state`'s key set is this numbering. */
const SC_UP: u32 = 82;
const SC_DOWN: u32 = 81;
const SC_PAGEUP: u32 = 75;
const SC_PAGEDOWN: u32 = 78;
const SC_HOME: u32 = 74;
const SC_END: u32 = 77;
const SC_SLASH: u32 = 56;
const SC_ESCAPE: u32 = 41;
const SC_BACKSPACE: u32 = 42;
const SC_RETURN: u32 = 40;
const SC_SPACE: u32 = 44;
const SC_MINUS: u32 = 45;
const SC_PERIOD: u32 = 55;
const SC_UNDERSCORE: u32 = 45; // shifted minus; shift is not tracked, so `-`
const SC_N: u32 = 17;          // 'n' — next page
const SC_P: u32 = 19;          // 'p' — previous page

/** Frames an offscreen run draws before it stops. */
const HEADLESS_FRAMES: i32 = 120;

/** The longest query the search field accepts. */
const MAX_QUERY: i32 = 48;

/**
 * The application.
 *
 * A class rather than a bag of module-level globals because there is exactly one
 * of it and its state is what the frame loop reads: page, scroll, query, focus.
 */
class App {
  /** Null until `start()` — the constructor is private and there is no
   *  invalid instance to hold a place with. */
  canvas: Canvas | null = null;
  pipe: i32 = -1;
  painter: Painter = new Painter();

  docs: Docs = Docs.open(new Uint8Array(0));
  search: SearchIndex = SearchIndex.open(new Uint8Array(0));
  transcripts: Transcripts = Transcripts.open(new Uint8Array(0));
  layout: PageLayout = new PageLayout();

  width: i32 = 1280;
  height: i32 = 720;
  /** True when the launcher asked for no window; the loop is then bounded. */
  headless: bool = false;

  /** The page being read, or -1 while search results are showing. */
  page: i32 = 0;
  scroll: i32 = 0;

  // --- search --------------------------------------------------------------
  /** The query, as bytes: the field is ASCII, so a byte per character. */
  query: Uint8Array = new Uint8Array(MAX_QUERY);
  queryLen: i32 = 0;
  /** Where the caret is; always `queryLen` in v1 (append-only editing). */
  searchFocused: bool = false;
  /** Section indices matching the query, best first. */
  results: i32[] = [];
  resultScores: i32[] = [];
  /**
   * Set whenever the query changes, cleared after `computeResults`.
   *
   * A flag rather than a comparison against the last query: the query is a byte
   * array, so "has it changed" would be a memcmp for a question the editing path
   * already knows the answer to. `computeResults` was declared and never called
   * in the first draft — the search pane showed "0 sections" for every query —
   * which is why this is now named after the thing that was missing.
   */
  private resultsDirty: bool = false;

  /** Per-section score for the current query; sized on first use. */
  private scores: i32[] = [];
  /** 0/1 per section: whether it is already in `touched`. */
  private marked: u8[] = [];
  /** Which sections the last query touched, so clearing is proportional. */
  private touched: i32[] = [];

  // --- the runnable panel --------------------------------------------------
  /** The block whose transcript is showing, or -1. */
  showingBlock: i32 = -1;
  showingEntry: i32 = -1;
  /**
   * How much page height the open transcript adds.
   *
   * The panel is drawn anchored under its code block, which does not move — so
   * without this the page has no room to scroll into and a Run button near the
   * bottom of a page answers by changing its own label and nothing else.
   */
  transcriptH: i32 = 0;

  /** Why the frame loop stopped, for the line `teardown` prints. */
  private exitReason: string = "the frame bound was reached";

  // --- input ---------------------------------------------------------------
  inputHandle: i32 = 0;
  inputReady: bool = false;
  stateBuffer: usize = 0;
  /** Previous frame's held keys, for edge detection. */
  prevKeys: Uint32Array = new Uint32Array(8);
  /** Accumulated wheel motion; the 2D adapter reports a float delta. */
  wheelCarry: f32 = 0.0;
  lastMouseX: i32 = -1;
  lastDx: i32 = 0;
  lastFlags: u32 = 0;
  lastMouseY: i32 = -1;
  lastButtons: u32 = 0;

  /** Where the last click landed, consumed by the hit tests in `draw`. */
  clickX: i32 = -1;
  clickY: i32 = -1;
  prevButtons: u32 = 0;

  /** Hit rectangles recorded during a draw, consumed by the next click. */
  tocHitY: i32[] = [];
  tocHitPage: i32[] = [];
  runHitX: i32[] = [];
  runHitY: i32[] = [];
  runHitBlock: i32[] = [];

  /** Frames drawn, and the last frame's record count, for the status bar. */
  frames: i32 = 0;
  lastRecords: i32 = 0;
  lastDropped: i32 = 0;

  // ── setup ───────────────────────────────────────────────────────────────

  /**
   * Open the session, the canvas, the volume and the atlas.
   *
   * Every failure here is fatal and says why: a viewer that opens a blank window
   * with no explanation is worse than one that refuses, because the user cannot
   * tell "the assets are missing" from "it crashed".
   */
  start(): bool {
    if (RuntimeSession.open(ConfigBuilder.forThisBuild()) != 0) {
      print("tension-docs: the session did not open");
      return false;
    }

    const request = windowRequest();
    this.width = request.width;
    this.height = request.height;
    this.headless = request.headless;

    // A local first, so the checks below read without an assertion on every
    // line; the field keeps it for the frame loop.
    const canvas: Canvas = request.headless
      ? Canvas.open(this.width, this.height)
      : Canvas.windowedOrOffscreen(this.width, this.height, request.title);
    this.canvas = canvas;
    if (!canvas.isValid()) {
      print("tension-docs: canvas refused: " + canvas.lastError().toString());
      return false;
    }

    // Preset 1 — the built-in `default_2d` pipeline, addressed by id with no
    // graph blob. The viewer needs nothing a custom graph would give it: one
    // texture, alpha blend, and the sprite record's own geometry.
    this.pipe = canvas.pipeline();
    if (this.pipe < 0) {
      print("tension-docs: set_pipeline refused: " + this.pipe.toString());
      return false;
    }

    const atlas = canvas.loadTextureFromRes("/ui.iwi");
    if (atlas <= 0) {
      print("tension-docs: /ui.iwi did not load: " + atlas.toString() +
        " (run `npm run assets` in apps/docs)");
      return false;
    }
    if (canvas.bindTexture(this.pipe, 0, atlas) != 0) {
      print("tension-docs: set_texture refused");
      return false;
    }

    // The three data files. Each is read whole into guest memory once; the
    // readers keep offsets into those buffers rather than copying.
    const docsBytes = resReadFile("/docs.bin");
    if (docsBytes == null) {
      print("tension-docs: /docs.bin is not in the volume (run `npm run assets`)");
      return false;
    }
    this.docs = Docs.open(docsBytes);
    if (!this.docs.ok) {
      print("tension-docs: docs.bin has no pages");
      return false;
    }

    const searchBytes = resReadFile("/search.bin");
    if (searchBytes != null) this.search = SearchIndex.open(searchBytes);
    const transcriptBytes = resReadFile("/transcripts.bin");
    if (transcriptBytes != null) this.transcripts = Transcripts.open(transcriptBytes);

    // Start on the first page — the book's opening chapter.
    this.page = 0;
    this.layout.build(this.docs, 0);

    this.setupInput();

    print("tension-docs: " + this.docs.pageCount.toString() + " pages, " +
      this.search.termCount.toString() + " search terms, " +
      this.transcripts.count.toString() + " recorded example(s)");
    return true;
  }

  /**
   * Open the input capability.
   *
   * `attach` may answer `-ENODEV` for a few frames while the host's window comes
   * up — the input layer joins the window rather than owning one — so a failure
   * here is not fatal: the viewer still draws, and the status bar says whether
   * the mouse and keyboard arrived.
   */
  setupInput(): void {
    this.stateBuffer = memory.data(96, 8); // input STATE_SIZE
    const handle = inputOpen(0);
    if (handle <= 0) return;
    this.inputHandle = handle;
    if (inputAttach(handle, InputKind.OwnSurface, 0, 0) == 0) {
      this.inputReady = true;
    }
  }

  /** Retry the attach; called once per frame until it succeeds. */
  pollAttach(): void {
    if (this.inputReady || this.inputHandle <= 0) return;
    if (inputAttach(this.inputHandle, InputKind.OwnSurface, 0, 0) == 0) {
      this.inputReady = true;
    }
  }

  // ── the loop ────────────────────────────────────────────────────────────

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
      // learns of the close from its *own* pump, and the host pumps too — in
      // `RuntimeSession.wait` and in the host loop. Whichever pump drains SDL's
      // quit event is the only one that sees it, and it is normally the host's,
      // which sets `window_closed` on a host that has nothing left to drive. So
      // a guest loop that owns its lifetime must stop on the request itself; the
      // host does not stop it for you in the 2D path, whatever `_game_running`
      // does in the Ogre one.
      if (windowInfo().closeRequested) {
        this.exitReason = "the window was closed";
        break;
      }

      this.pollAttach();
      this.handleInput();
      this.draw();

      const presented = this.canvas!.present();
      if (presented != 0) {
        // `-ECANCELED` once the window is closed: stop, do not retry.
        this.exitReason = "present answered " + presented.toString();
        break;
      }
      this.frames++;

      // One host-owned tick per frame. Without it a software driver spins as
      // fast as the CPU allows and the scroll runs away from the wheel.
      RuntimeSession.wait(16);

      // An offscreen run has no window to close and would loop until something
      // kills it. A bound makes `--headless` a job that finishes, which is what
      // a CI check and a screenshot harness both need.
      if (this.headless && this.frames >= HEADLESS_FRAMES) break;
    }

    this.teardown();
  }

  teardown(): void {
    if (this.inputHandle > 0) inputClose(this.inputHandle);
    if (this.canvas!.isValid()) this.canvas!.close();
    RuntimeSession.close();
    // Said out loud, because "the window closed" and "the process died" look
    // identical from the launcher otherwise, and the difference is the whole
    // point of exiting through this path.
    print("tension-docs: closed after " + this.frames.toString() + " frame(s) (" +
      this.exitReason + ")");
  }

  // ── input ───────────────────────────────────────────────────────────────

  /** Read the input record, if the capability is up, into `stateBuffer`. */
  private readState(): bool {
    if (!this.inputReady) return false;
    return inputState(this.inputHandle, this.stateBuffer) > 0;
  }

  /** Whether a scancode is held right now (reads `stateBuffer` in place). */
  private held(scancode: u32): bool {
    if (scancode >= 256) return false;
    // `STATE_KEYS_OFFSET` is 16 and the set is 8 words.
    const at: usize = this.stateBuffer + 16 + <usize>((scancode >> 5) * 4);
    return (load<u32>(at) & (1 << (scancode & 31))) != 0;
  }

  /** A key that went down since the last frame. */
  private pressed(scancode: u32): bool {
    if (scancode >= 256) return false;
    const word: i32 = <i32>(scancode >> 5);
    const bit: u32 = 1 << (scancode & 31);
    return (this.prevKeys[word] & bit) == 0 && this.held(scancode);
  }

  /** Snapshot the key set for the next frame's edge detection. */
  private latchKeys(): void {
    if (!this.inputReady) return;
    for (let i: i32 = 0; i < 8; i++) {
      this.prevKeys[i] = load<u32>(this.stateBuffer + 16 + <usize>(i * 4));
    }
  }

  handleInput(): void {
    if (!this.readState()) {
      // No input: the page still draws. Do not advance the guards, so the first
      // frame with input does not see a spurious press.
      return;
    }

    const state = InputState.read(this.stateBuffer);

    // Resolve a changed query before anything reads `results` — the search bar's
    // count and the results pane both come from it.
    if (this.resultsDirty) {
      this.computeResults();
      this.resultsDirty = false;
    }

    // ── the wheel ─────────────────────────────────────────────────────────
    this.wheelCarry += state.wheelY;
    if (this.wheelCarry >= 1.0 || this.wheelCarry <= -1.0) {
      const steps: i32 = <i32>this.wheelCarry;
      this.scrollBy(-steps * LINE_STEP * 2);
      this.wheelCarry -= <f32>steps;
    }

    // ── clicking ──────────────────────────────────────────────────────────
    this.lastMouseX = state.mouseX;
    this.lastDx = state.mouseDx;
    this.lastFlags = state.flags;
    this.lastMouseY = state.mouseY;
    const buttons = state.mouseButtons;
    this.lastButtons = buttons;
    const justPressed: bool = (buttons & 1) != 0 && (this.prevButtons & 1) == 0;
    if (justPressed) {
      this.clickX = state.mouseX;
      this.clickY = state.mouseY;
    }

    // ── the keyboard ──────────────────────────────────────────────────────
    if (this.pressed(SC_SLASH) && !this.searchFocused) {
      this.searchFocused = true;
    } else if (this.pressed(SC_ESCAPE)) {
      if (this.searchFocused && this.queryLen > 0) {
        this.queryLen = 0;
        this.resultsDirty = true;
      } else if (this.searchFocused) {
        this.searchFocused = false;
      } else {
        this.showingBlock = -1;
      }
    } else if (this.pressed(SC_BACKSPACE) && this.searchFocused && this.queryLen > 0) {
      this.queryLen--;
      this.resultsDirty = true;
    } else if (this.searchFocused) {
      // Typing: a-z, 0-9, space, and the two punctuation marks a search query
      // actually uses. Scancodes, because there is no text event on this path.
      const code: i32 = scancodeToChar(this);
      if (code > 0 && this.queryLen < MAX_QUERY) {
        this.query[this.queryLen++] = <u8>code;
        this.resultsDirty = true;
      }
    }

    // Scrolling keys work whether or not the field has focus, except that a
    // focused field owns Home/End for the caret (not implemented: append-only).
    if (this.pressed(SC_DOWN)) this.scrollBy(LINE_STEP * 2);
    if (this.pressed(SC_UP)) this.scrollBy(-LINE_STEP * 2);
    if (this.pressed(SC_PAGEDOWN)) this.scrollBy(this.pageHeight() - LINE_STEP);
    if (this.pressed(SC_PAGEUP)) this.scrollBy(-(this.pageHeight() - LINE_STEP));
    if (this.pressed(SC_HOME)) this.scroll = 0;
    if (this.pressed(SC_END)) this.scroll = this.maxScroll();

    // Page navigation and the transcript, by keyboard. `n`/`p` rather than the
    // arrows, which already scroll — and rather than Tab, which a window
    // manager may claim.
    if (!this.searchFocused) {
      if (this.pressed(SC_N)) this.stepPage(1);
      if (this.pressed(SC_P)) this.stepPage(-1);
      if (this.pressed(SC_RETURN)) {
        const block: i32 = this.firstRunnableBlock();
        if (block >= 0) this.toggleTranscript(block);
      }
    }

    if (justPressed) this.doClick(state.mouseX, state.mouseY);

    this.prevButtons = buttons;
    this.latchKeys();
  }

  /** The visible height of the content pane. */
  private pageHeight(): i32 {
    return this.height - STATUS_H - CONTENT_TOP;
  }

  private maxScroll(): i32 {
    const total: i32 = this.searchFocused || this.queryLen > 0
      ? this.results.length * (LINE_STEP + 12) + 40
      : this.layout.height + this.transcriptH;
    const max: i32 = total - this.pageHeight();
    return max > 0 ? max : 0;
  }

  private scrollBy(delta: i32): void {
    this.scroll += delta;
    if (this.scroll < 0) this.scroll = 0;
    const max: i32 = this.maxScroll();
    if (this.scroll > max) this.scroll = max;
  }

  /**
   * Resolve a click against the rectangles the last draw recorded.
   *
   * Hit testing against recorded rectangles rather than recomputing positions is
   * what keeps the click and the pixels from disagreeing: there is one layout,
   * and the draw writes down what it drew.
   */
  doClick(x: i32, y: i32): void {
    // The run buttons first: they sit inside the content pane.
    for (let i: i32 = 0; i < this.runHitBlock.length; i++) {
      const bx: i32 = this.runHitX[i];
      const by: i32 = this.runHitY[i];
      if (x >= bx && x < bx + RUN_BTN_W && y >= by && y < by + RUN_BTN_H) {
        this.toggleTranscript(this.runHitBlock[i]);
        return;
      }
    }

    // The sidebar.
    if (x < SIDEBAR_W) {
      for (let i: i32 = 0; i < this.tocHitPage.length; i++) {
        const ty: i32 = this.tocHitY[i];
        if (y >= ty && y < ty + TOC_STEP) {
          const target: i32 = this.tocHitPage[i];
          if (target >= 0) this.openPage(target);
          return;
        }
      }
      return;
    }

    // The search bar: a click focuses it.
    if (y < SEARCH_H) {
      this.searchFocused = true;
      return;
    }

    // A search result.
    if (this.queryLen > 0) {
      for (let i: i32 = 0; i < this.results.length; i++) {
        const ry: i32 = CONTENT_TOP + 8 + i * (LINE_STEP + 12);
        if (y >= ry && y < ry + LINE_STEP + 12) {
          const section: i32 = this.results[i];
          const page: i32 = <i32>this.docs.sectionPage(section);
          const block: i32 = <i32>this.docs.sectionBlockFirst(section);
          this.openPage(page);
          this.scroll = this.layout.scrollForBlock(block);
          this.clampScroll();
          this.searchFocused = false;
          this.queryLen = 0;
          this.resultsDirty = true;
          return;
        }
      }
    }
  }

  /**
   * Show or hide the recorded output for one block.
   *
   * Shared by the Run button and the Enter key, so "the button works" and "Enter
   * works" cannot become two different behaviours that only one path tests.
   */
  toggleTranscript(block: i32): void {
    if (this.showingBlock == block) {
      this.showingBlock = -1;
      this.showingEntry = -1;
      this.transcriptH = 0;
      this.clampScroll();
      return;
    }
    this.showingBlock = block;
    this.showingEntry = this.transcripts.ok ? this.transcripts.find(block) : -1;

    // The panel becomes part of the page's height, and opening it scrolls to it
    // when it would not otherwise be visible. A code block near the bottom of a
    // page is the common case, and "the button answered but nothing appeared"
    // is indistinguishable from a dead button.
    this.transcriptH = this.showingEntry >= 0
      ? this.transcriptLines(this.showingEntry) * LINE_STEP + 26 + 12
      : LINE_STEP + 18;
    const anchor: i32 = this.layout.anchorForBlock(block);
    if (anchor >= 0) {
      const want: i32 = anchor + this.transcriptH - this.pageHeight();
      if (want > this.scroll) this.scroll = want;
    }
    this.clampScroll();
  }

  /** How many lines a recorded transcript has, header excluded. */
  private transcriptLines(entry: i32): i32 {
    const ptr: usize = this.transcripts.textPtr(<u32>entry);
    const len: i32 = <i32>this.transcripts.textLen(<u32>entry);
    let lines: i32 = 1;
    for (let i: i32 = 0; i < len; i++) {
      if (load<u8>(ptr + <usize>i) == 10) lines++;
    }
    return lines;
  }

  /** The page's first runnable code block, or -1. */
  private firstRunnableBlock(): i32 {
    const layout = this.layout;
    for (let i: i32 = 0; i < layout.blockIndex.length; i++) {
      if (layout.blockKind[i] == K_CODE && (layout.blockFlags[i] & F_RUNNABLE) != 0) {
        return layout.blockIndex[i];
      }
    }
    return -1;
  }

  /**
   * Move to the adjacent page in the table of contents.
   *
   * The keyboard equivalent of clicking the sidebar, and it exists because the
   * pointer is not always available: `input.state` reports `mouse_x`/`mouse_y`
   * only for motion the capability attributes to a device, and on a display
   * where injected (or a compositor-remapped) pointer motion carries device id 0
   * the capability drops it — measured on this rig: `b=1` while a button is
   * held, `m=0 dx=0` throughout. A viewer that could only be navigated by a mouse
   * would be unusable there, so both paths exist and share `openPage`.
   */
  private stepPage(delta: i32): void {
    // Walk the table of contents, not the page array: a group entry is not a
    // destination, and the TOC is the order the reader sees.
    const total: i32 = <i32>this.docs.tocCount;
    let here: i32 = -1;
    for (let i: i32 = 0; i < total; i++) {
      const pg: u32 = this.docs.tocPage(<u32>i);
      if (pg != 0xffffffff && <i32>pg == this.page) { here = i; break; }
    }
    if (here < 0) return;
    let next: i32 = here + delta;
    while (next >= 0 && next < total) {
      const pg: u32 = this.docs.tocPage(<u32>next);
      if (pg != 0xffffffff) {
        this.openPage(<i32>pg);
        this.searchFocused = false;
        return;
      }
      next += delta;
    }
  }

  private clampScroll(): void {
    const max: i32 = this.maxScroll();
    if (this.scroll > max) this.scroll = max;
    if (this.scroll < 0) this.scroll = 0;
  }

  private openPage(page: i32): void {
    if (page < 0 || page >= <i32>this.docs.pageCount) return;
    this.page = page;
    this.layout.build(this.docs, <u32>page);
    this.scroll = 0;
    this.showingBlock = -1;
    this.showingEntry = -1;
    this.transcriptH = 0;
  }

  // ── search ──────────────────────────────────────────────────────────────

  /**
   * Resolve the query into ranked sections.
   *
   * Prefix-first, and that is the whole as-you-type story: a reader typing
   * `rend` gets every term beginning with it, which is a dictionary scan over
   * 5,744 sorted terms affords in microseconds. Scored by occurrence count,
   * weighted up for a term in a section's heading and for an exact term match.
   *
   * **No `Map`.** AssemblyScript's `Map#get` is the `[]` operator, which throws
   * on a missing key rather than returning null (`std/assembly/map.ts`), so the
   * obvious `map.get(k)` accumulator killed the guest with "Key does not
   * exist". Sections are dense integers, so the accumulator is a flat score
   * array instead: one indexed add per posting, and no hashing at all.
   */
  private computeResults(): void {
    this.results = [];
    this.resultScores = [];

    const sections: i32 = <i32>this.docs.sectionCount;
    if (this.scores.length != sections + 1) {
      this.scores = new Array<i32>(sections + 1);
      this.marked = new Array<u8>(sections + 1);
    }
    // Clear only what the last query touched — a memset of 628 entries per
    // keystroke would be the largest thing this function does.
    for (let i: i32 = 0; i < this.touched.length; i++) {
      const at: i32 = this.touched[i];
      this.scores[at] = 0;
      this.marked[at] = 0;
    }
    this.touched = [];

    if (this.queryLen < 2 || !this.search.ok) return;

    // The dictionary index at or after the query prefix.
    let lo: i32 = 0;
    let hi: i32 = <i32>this.search.termCount - 1;
    while (lo <= hi) {
      const mid: i32 = (lo + hi) >> 1;
      const cmp: i32 = compareTermToQuery(
        this.search.termPtr(<u32>mid), this.search.termLen(<u32>mid),
        this.query.dataStart, <u32>this.queryLen);
      if (cmp < 0) lo = mid + 1;
      else hi = mid - 1;
    }

    let considered: i32 = 0;
    for (let t: i32 = lo; t < <i32>this.search.termCount && considered < 40; t++) {
      const termLen: u32 = this.search.termLen(<u32>t);
      if (!termHasPrefix(this.search.termPtr(<u32>t), termLen,
                          this.query.dataStart, <u32>this.queryLen)) break;
      considered++;

      // A term that *is* the query is worth more than one that merely shares
      // its prefix: "load" should outrank "loader" for the query "load".
      const exactWeight: i32 = termLen == <u32>this.queryLen ? 2 : 1;

      const first: u32 = this.search.termPostFirst(<u32>t);
      const count: u32 = this.search.termPostCount(<u32>t);
      for (let p: u32 = 0; p < count; p++) {
        const posting: u32 = first + p;
        const word: u16 = this.search.postingWord(posting);
        const inHeading: bool = (word & 0x8000) != 0;
        const occurrences: i32 = <i32>(word & 0x7fff);
        const score: i32 = occurrences * (inHeading ? 3 : 1) * exactWeight;

        const section: i32 = <i32>this.search.postingSection(posting);
        if (section < 0 || section >= sections) continue;
        if (this.marked[section] == 0) {
          this.marked[section] = 1;
          this.touched.push(section);
        }
        this.scores[section] += score;
      }
    }

    // Rank the touched sections. Tens of them, so a selection sort is both the
    // simplest thing and faster than the bookkeeping a better one would need.
    const ranked: i32[] = this.touched;
    const scores: i32[] = this.scores;
    for (let i: i32 = 0; i < ranked.length; i++) {
      let best: i32 = i;
      for (let j: i32 = i + 1; j < ranked.length; j++) {
        if (scores[ranked[j]] > scores[ranked[best]]) best = j;
      }
      if (best != i) {
        const t: i32 = ranked[i]; ranked[i] = ranked[best]; ranked[best] = t;
      }
    }

    const limit: i32 = ranked.length < 30 ? ranked.length : 30;
    for (let i: i32 = 0; i < limit; i++) {
      this.results.push(ranked[i]);
      this.resultScores.push(scores[ranked[i]]);
    }
  }

  // ── drawing ─────────────────────────────────────────────────────────────

  draw(): void {
    const p = this.painter;
    p.reset();
    this.tocHitY = [];
    this.tocHitPage = [];
    this.runHitX = [];
    this.runHitY = [];
    this.runHitBlock = [];

    const clipTop: i32 = CONTENT_TOP;
    const clipBottom: i32 = this.height - STATUS_H;

    // **No background fill.** The 2D renderer clears to opaque black, and a
    // sprite cannot be stretched, so painting 1280x720 would cost 7,200 of the
    // 4,096 records the frame may stage — more than the text it exists to
    // surround. The clear *is* the background, and the divider below is what
    // separates the two regions.
    p.vline(DIVIDER_X, 0, this.height, CHROME_DIVIDER);

    this.drawSidebar();
    this.drawSearchBar();

    if (this.queryLen > 0) {
      this.drawResults(clipTop, clipBottom);
    } else {
      this.drawContent(clipTop, clipBottom);
    }

    this.drawStatusBar();

    const accepted = p.submit(this.canvas!, this.pipe);
    this.lastRecords = p.count;
    this.lastDropped = p.dropped;
    if (accepted < p.count) {
      // The renderer staged fewer than we emitted; say so once rather than
      // silently losing the tail of the frame.
      print("tension-docs: the renderer accepted " + accepted.toString() +
        " of " + p.count.toString() + " records");
    }
  }

  /** The table of contents, scrolled so the current page stays visible. */
  private drawSidebar(): void {
    const p = this.painter;
    const top: i32 = 16;

    // The book's title, in the heading colour.
    this.drawBytesAt("Tension", 7, 16, top, HEADING, BOLD, CELL_W);

    const rowsTop: i32 = top + 36;
    const rows: i32 = (this.height - rowsTop - 8) / TOC_STEP;
    const total: i32 = <i32>this.docs.tocCount;

    // Keep the current page's entry on screen: find it, then centre the window
    // on it when it would otherwise fall outside.
    let first: i32 = 0;
    if (total > rows) {
      let currentRow: i32 = 0;
      for (let i: i32 = 0; i < total; i++) {
        const pg: u32 = this.docs.tocPage(<u32>i);
        if (pg != 0xffffffff && <i32>pg == this.page) currentRow = i;
      }
      first = currentRow - rows / 2;
      if (first < 0) first = 0;
      if (first > total - rows) first = total - rows;
    }

    for (let r: i32 = 0; r < rows && first + r < total; r++) {
      const i: i32 = first + r;
      const y: i32 = rowsTop + r * TOC_STEP;
      const page: u32 = this.docs.tocPage(<u32>i);
      const depth: u32 = this.docs.tocDepth(<u32>i);
      const indent: i32 = 12 + <i32>depth * 12;
      const active: bool = page != 0xffffffff && <i32>page == this.page;

      // 260x22 is 33x2 = 66 records, affordable once for the current row.
      if (active) {
        p.fill(0, y - 2, SIDEBAR_W, TOC_STEP, CHROME_SELECTION);
        p.fill(SIDEBAR_W - 3, y - 2, 3, TOC_STEP, CHROME_WHITE);
      }

      const colour: i32 = page == 0xffffffff ? MUTED : (active ? HEADING : NORMAL);
      const weight: i32 = page == 0xffffffff ? BOLD : REGULAR;
      const maxChars: i32 = (SIDEBAR_W - indent - 8) / CELL_W;
      this.drawTruncated(this.docs.tocTitlePtr(<u32>i), <i32>this.docs.tocTitleLen(<u32>i),
        indent, y, colour, weight, maxChars);

      this.tocHitY.push(y - 2);
      this.tocHitPage.push(page == 0xffffffff ? -1 : <i32>page);
    }
  }

  /** The search field, and its placeholder when empty. */
  private drawSearchBar(): void {
    const p = this.painter;
    p.hline(MAIN_X, SEARCH_H - 1, this.width - MAIN_X, CHROME_DIVIDER);

    // A magnifier stand-in: the font has no icon, so the prompt is text.
    const promptX: i32 = MAIN_X + 16;
    const promptY: i32 = 12;

    if (this.queryLen == 0 && !this.searchFocused) {
      this.drawBytesAt("Press / to search", 17, promptX, promptY, MUTED, REGULAR, CELL_W);
      return;
    }

    const startX: i32 = promptX;
    const cursorX: i32 = p.text(
      this.query.dataStart, this.queryLen, startX, promptY,
      NORMAL, REGULAR, CELL_W, 0, this.height);

    // The caret blinks on a two-second cycle: `frames` is the only clock the
    // guest has, and a caret that never blinks reads as a rendering artefact.
    if (this.searchFocused && (this.frames / 30) % 2 == 0) {
      p.sprite(cursorX, promptY, CELL_W - 4, CELL_H, CHROME_CARET);
    }

    // The result count, right-aligned in the bar.
    if (this.queryLen >= 2) {
      const label: string = this.results.length.toString() + " sections";
      const w: i32 = label.length * CELL_W;
      this.drawString(label, this.width - 24 - w, promptY, MUTED, REGULAR, CELL_W);
    }
  }

  /** Search results: a section title, its page, and the score. */
  private drawResults(clipTop: i32, clipBottom: i32): void {
    const p = this.painter;
    const x: i32 = CONTENT_X;
    const top: i32 = CONTENT_TOP + 8;

    this.drawBytesAt("Results for", 11, x, top, MUTED, REGULAR, CELL_W);
    p.text(this.query.dataStart, this.queryLen,
      x + 12 * CELL_W, top, LINK, BOLD, CELL_W, 0, this.height);

    if (this.results.length == 0) {
      this.drawBytesAt("no section matches that prefix", 31, x, top + LINE_STEP,
        MUTED, REGULAR, CELL_W);
      return;
    }

    const rowStep: i32 = LINE_STEP + 12;
    for (let i: i32 = 0; i < this.results.length; i++) {
      const y: i32 = top + 36 + i * rowStep;
      if (y > clipBottom) break;
      if (y + rowStep < clipTop) continue;

      const section: i32 = this.results[i];

      // The section title, with the matched prefix picked out in the link
      // colour — the highlight is what tells the reader *why* the row matched.
      this.drawHighlighted(this.docs.sectionTitlePtr(<u32>section),
        <i32>this.docs.sectionTitleLen(<u32>section), x, y, 64);

      // The page it belongs to, indented and muted.
      const page: i32 = <i32>this.docs.sectionPage(<u32>section);
      const titlePtr: usize = this.docs.pageTitlePtr(<u32>page);
      const titleLen: i32 = <i32>this.docs.pageTitleLen(<u32>page);
      this.drawTruncated(titlePtr, titleLen, x + 16, y + 16, MUTED, REGULAR, 60);
    }
  }

  /** The document page. */
  private drawContent(clipTop: i32, clipBottom: i32): void {
    const p = this.painter;
    const layout = this.layout;

    // The page title, above the flow and not part of it — a reader scrolling
    // should lose the title first, which is why it scrolls with the text.
    const scroll: i32 = this.scroll;

    // Only the visible lines are walked. `firstLineAt` is a scan over ~40
    // entries, and everything before it is skipped without touching a glyph —
    // this is what keeps a 2,000-line page inside the record budget.
    // The transcript is drawn **after** every line, not where its block ends:
    // it is an overlay, and drawing it inside the line loop let the paragraphs
    // below paint straight over it. Deferring it is what makes it occlude.
    let transcriptY: i32 = -1;

    let startLine: i32 = 0;
    while (startLine < layout.lineCount &&
           layout.lineY[startLine] + LINE_STEP < scroll) {
      startLine++;
    }

    for (let li: i32 = startLine; li < layout.lineCount; li++) {
      const lineY: i32 = layout.lineY[li] - scroll + CONTENT_TOP;
      if (lineY > clipBottom) break;

      const blockSlot: i32 = layout.lineBlock[li];
      const kind: u8 = layout.blockKind[blockSlot];
      const level: u8 = layout.blockLevel[blockSlot];
      const indent: i32 = kind == K_CODE ? CODE_INSET : (kind == K_LIST_ITEM ? 16 : 0);
      const x: i32 = CONTENT_X + indent;
      const start: i32 = layout.lineStart[li];
      const len: i32 = layout.lineLen[li];

      // A rule is a bar where a line of text would be.
      if (kind == K_RULE) {
        p.fill(CONTENT_X, lineY + 8, CONTENT_COLS * CELL_W, 1, CHROME_DIVIDER);
        continue;
      }

      // A code block's background: drawn per line so a scrolled block is
      // inset at both ends rather than hanging out of its box.
      // A code block's marker: a two-pixel accent on the left. A full
      // background would be 82x2 = 164 records *per line*, which ten visible
      // code lines would spend a third of the frame on.
      if (kind == K_CODE) {
        p.fill(CONTENT_X, lineY - 2, 2, LINE_STEP, CHROME_SELECTION);
      }

      // A heading's rule, sized to its text, is what gives the hierarchy its
      // weight without a second pipeline.
      if (kind == K_HEADING && level <= 2) {
        const width: i32 = len * advanceFor(kind, level);
        p.fill(x, lineY + CELL_H, width, level == 1 ? 2 : 1, CHROME_DIVIDER);
      }

      // A bullet for a list item: the font has `-`, which is what the Markdown
      // source uses too.
      if (kind == K_LIST_ITEM && len > 0) {
        p.char(45, x - 12, lineY, NORMAL, REGULAR, clipTop, clipBottom);
      }

      // Emit the line: group consecutive characters by style so the colour and
      // weight are computed per run rather than per glyph.
      let i: i32 = 0;
      while (i < len) {
        const style: u8 = layout.styles[start + i];
        let j: i32 = i + 1;
        while (j < len && layout.styles[start + j] == style) j++;

        const colour: i32 = colourFor(kind, level, style);
        const weight: i32 = weightFor(kind, style);
        const advance: i32 = advanceFor(kind, level);
        p.text(layout.chars.dataStart + <usize>(start + i), j - i,
          x + i * advance, lineY, colour, weight, advance, clipTop, clipBottom);
        i = j;
      }

      // The Run button, on the first line of a runnable code block.
      if (kind == K_CODE && blockSlot >= 0 &&
          (layout.blockFlags[blockSlot] & F_RUNNABLE) != 0 &&
          li == layout.blockFirstLine[blockSlot]) {
        this.drawRunButton(layout.blockIndex[blockSlot], lineY + CELL_H + 6);
      }

      // The transcript, anchored under its block. Only the anchor is decided
      // here; the panel is drawn once the flow is complete.
      if (this.showingBlock >= 0 && blockSlot >= 0 &&
          layout.blockIndex[blockSlot] == this.showingBlock &&
          li == layout.blockFirstLine[blockSlot] + layout.blockLineCount[blockSlot] - 1) {
        transcriptY = lineY + LINE_STEP + 10;
      }
    }

    if (transcriptY >= 0) this.drawTranscript(transcriptY);
  }

  /**
   * The "Run (recorded)" button.
   *
   * A filled box of the link colour with the label over it. The label is drawn
   * in the panel colour, which is the only way to get dark text on a light box
   * when the atlas carries the colour rather than the shader.
   */
  private drawRunButton(block: i32, y: i32): void {
    const p = this.painter;
    const x: i32 = CONTENT_X + CONTENT_COLS * CELL_W + 24;
    if (y > this.height - STATUS_H) return;

    const label: string = this.showingBlock == block ? "Hide output" : "Run (recorded)";
    const w: i32 = label.length * CELL_W + 20;

    p.fill(x, y, w, RUN_BTN_H, CHROME_SELECTION);
    p.fill(x, y, w, 1, CHROME_WHITE);
    this.drawString(label, x + 10, y + 3, HEADING, REGULAR, CELL_W);

    this.runHitX.push(x);
    this.runHitY.push(y);
    this.runHitBlock.push(block);
  }

  /**
   * The recorded transcript, below its code block.
   *
   * Anchored under the block's last line and **never moved up over it**: an
   * earlier version slid the panel upward when it did not fit, which drew it on
   * top of the code it was explaining. Shrinking the number of visible lines is
   * the honest answer — the reader can scroll to see the rest, and the code stays
   * where it was.
   */
  private drawTranscript(y: i32): void {
    const p = this.painter;
    const bottom: i32 = this.height - STATUS_H - 8;

    if (this.showingEntry < 0) {
      if (y + LINE_STEP <= bottom) {
        p.fill(CONTENT_X, y, CONTENT_COLS * CELL_W, LINE_STEP + 6, CHROME_PANEL);
        p.hline(CONTENT_X, y, CONTENT_COLS * CELL_W, CHROME_SELECTION);
        this.drawString("no transcript recorded for this block",
          CONTENT_X + 8, y + 6, MUTED, REGULAR, CELL_W);
      }
      return;
    }

    const ptr: usize = this.transcripts.textPtr(<u32>this.showingEntry);
    const len: i32 = <i32>this.transcripts.textLen(<u32>this.showingEntry);
    const lines: i32 = this.transcriptLines(this.showingEntry);

    const avail: i32 = bottom - y;
    // 26px for the header line; whatever is left is body lines.
    const fit: i32 = (avail - 26) / LINE_STEP;
    if (fit < 1) {
      if (y + LINE_STEP <= bottom) {
        this.drawString("scroll down to see the output",
          CONTENT_X + 8, y + 6, MUTED, REGULAR, CELL_W);
      }
      return;
    }
    const shown: i32 = lines < fit ? lines : fit;
    const panelH: i32 = shown * LINE_STEP + 26;

    // **Opaque**, because this is an overlay: without the backing the paragraph
    // below shows through the transcript and neither is readable. 640x98 is
    // 80x7 = 560 records, which the frame affords — the status bar reports the
    // running total.
    p.fill(CONTENT_X, y, CONTENT_COLS * CELL_W, panelH, CHROME_PANEL);
    p.hline(CONTENT_X, y, CONTENT_COLS * CELL_W, CHROME_SELECTION);
    p.fill(CONTENT_X, y, 2, panelH, CHROME_SELECTION);

    const ms: string = this.transcripts.durationMs(<u32>this.showingEntry).toString();
    this.drawString("output - recorded at build time, " + ms + " ms",
      CONTENT_X + 8, y + 6, MUTED, REGULAR, CELL_W);

    let lineY: i32 = y + 26;
    let s: i32 = 0;
    for (let n: i32 = 0; n < shown; n++) {
      let e: i32 = s;
      while (e < len && load<u8>(ptr + <usize>e) != 10) e++;
      const lineLen: i32 = e - s < CONTENT_COLS - 2 ? e - s : CONTENT_COLS - 2;
      if (lineLen > 0) {
        p.text(ptr + <usize>s, lineLen, CONTENT_X + 8, lineY, CODE, REGULAR,
          CELL_W, 0, this.height);
      }
      lineY += LINE_STEP;
      s = e + 1;
      if (s >= len) break;
    }

    if (shown < lines) {
      this.drawString("... " + (lines - shown).toString() + " more line(s)",
        CONTENT_X + 8, lineY, MUTED, REGULAR, CELL_W);
    }
  }

  /** Page title, position, record count, and the key hints. */
  private drawStatusBar(): void {
    const p = this.painter;
    const y: i32 = this.height - STATUS_H;
    p.hline(MAIN_X, y, this.width - MAIN_X, CHROME_DIVIDER);

    const titlePtr: usize = this.docs.pageTitlePtr(<u32>this.page);
    const titleLen: i32 = <i32>this.docs.pageTitleLen(<u32>this.page);
    const pageNo: string = (this.page + 1).toString() + "/" + this.docs.pageCount.toString();

    this.drawTruncated(titlePtr, titleLen, MAIN_X + 16, y + 7, MUTED, REGULAR, 40);

    const right: string = pageNo + "   " + this.lastRecords.toString() + " sprites" +
      (this.lastDropped > 0 ? "  (" + this.lastDropped.toString() + " dropped)" : "");
    const w: i32 = right.length * CELL_W;
    this.drawString(right, this.width - 24 - w, y + 7,
      this.lastDropped > 0 ? HEADING : MUTED, REGULAR, CELL_W);

    if (!this.inputReady) {
      this.drawString("input unavailable", MAIN_X + 16 + 44 * CELL_W, y + 7, HEADING, REGULAR, CELL_W);
    } else {
      this.drawString(this.searchFocused
        ? "type to search   Esc to clear"
        : "/ search   n/p page   Enter output   wheel/PgUp scroll",
        MAIN_X + 16 + 44 * CELL_W, y + 7, MUTED, REGULAR, CELL_W);
    }
  }

  // ── text helpers ────────────────────────────────────────────────────────

  private drawBytesAt(text: string, len: i32, x: i32, y: i32,
                      colour: i32, weight: i32, advance: i32): void {
    const bytes = String.UTF8.encode(text, false);
    this.painter.text(changetype<usize>(bytes), len, x, y, colour, weight, advance, 0, this.height);
  }

  private drawString(text: string, x: i32, y: i32,
                     colour: i32, weight: i32, advance: i32): void {
    const bytes = String.UTF8.encode(text, false);
    this.painter.text(changetype<usize>(bytes), bytes.byteLength, x, y, colour, weight, advance, 0, this.height);
  }

  /** Draw a byte span, truncating to `maxChars` with no ellipsis glyph. */
  private drawTruncated(ptr: usize, len: i32, x: i32, y: i32,
                        colour: i32, weight: i32, maxChars: i32): void {
    const n: i32 = len < maxChars ? len : maxChars;
    this.painter.text(ptr, n, x, y, colour, weight, CELL_W, 0, this.height);
  }

  /**
   * A title with the query's occurrences in the link colour.
   *
   * Case-insensitive over ASCII: the engine folds `A-Z` to `a-z` by ORing 32,
   * which is exact for the characters the font carries.
   */
  private drawHighlighted(ptr: usize, len: i32, x: i32, y: i32, maxChars: i32): void {
    const n: i32 = len < maxChars ? len : maxChars;
    const p = this.painter;
    let i: i32 = 0;
    while (i < n) {
      // Is there a match starting here?
      let match: bool = false;
      if (this.queryLen > 0 && i + this.queryLen <= n) {
        match = true;
        for (let k: i32 = 0; k < this.queryLen; k++) {
          const a: i32 = lowerAscii(load<u8>(ptr + <usize>(i + k)));
          const b: i32 = lowerAscii(this.query[k]);
          if (a != b) { match = false; break; }
        }
      }
      if (match) {
        p.text(ptr + <usize>i, this.queryLen, x + i * CELL_W, y, LINK, BOLD, CELL_W, 0, this.height);
        i += this.queryLen;
        continue;
      }
      const colour: i32 = NORMAL;
      p.text(ptr + <usize>i, 1, x + i * CELL_W, y, colour, REGULAR, CELL_W, 0, this.height);
      i++;
    }
  }
}

/** Fold an ASCII letter to lower case; every other byte is unchanged. */
function lowerAscii(c: u8): i32 {
  if (c >= 65 && c <= 90) return <i32>c + 32;
  return <i32>c;
}

const RUN_BTN_W: i32 = 15 * CELL_W + 20;
const RUN_BTN_H: i32 = CELL_H + 6;

/**
 * The character a pressed alphanumeric scancode stands for, or 0.
 *
 * Scancodes rather than a text event: `input.state` reports a held-key bitmap
 * and nothing else, so a typed character is derived from the physical key. That
 * is exactly right for a search query of `[a-z0-9 -_.]` and exactly wrong for
 * anything else — a limitation stated in the report, not worked around.
 */
function scancodeToChar(app: App): i32 {
  // a-z
  if (app.pressed(4)) return 65 + 32; // a
  if (app.pressed(5)) return 66 + 32;
  if (app.pressed(6)) return 67 + 32;
  if (app.pressed(7)) return 68 + 32;
  if (app.pressed(8)) return 69 + 32;
  if (app.pressed(9)) return 70 + 32;
  if (app.pressed(10)) return 71 + 32;
  if (app.pressed(11)) return 72 + 32;
  if (app.pressed(12)) return 73 + 32;
  if (app.pressed(13)) return 74 + 32;
  if (app.pressed(14)) return 75 + 32;
  if (app.pressed(15)) return 76 + 32;
  if (app.pressed(16)) return 77 + 32;
  if (app.pressed(17)) return 78 + 32;
  if (app.pressed(18)) return 79 + 32;
  if (app.pressed(19)) return 80 + 32;
  if (app.pressed(20)) return 81 + 32;
  if (app.pressed(21)) return 82 + 32;
  if (app.pressed(22)) return 83 + 32;
  if (app.pressed(23)) return 84 + 32;
  if (app.pressed(24)) return 85 + 32;
  if (app.pressed(25)) return 86 + 32;
  if (app.pressed(26)) return 87 + 32;
  if (app.pressed(27)) return 88 + 32;
  if (app.pressed(28)) return 89 + 32;
  if (app.pressed(29)) return 90 + 32;

  // 1-9, 0
  if (app.pressed(30)) return 49;
  if (app.pressed(31)) return 50;
  if (app.pressed(32)) return 51;
  if (app.pressed(33)) return 52;
  if (app.pressed(34)) return 53;
  if (app.pressed(35)) return 54;
  if (app.pressed(36)) return 55;
  if (app.pressed(37)) return 56;
  if (app.pressed(38)) return 57;
  if (app.pressed(39)) return 48;

  if (app.pressed(SC_SPACE)) return 32;
  if (app.pressed(SC_MINUS)) return 45;
  if (app.pressed(SC_PERIOD)) return 46;
  if (app.pressed(SC_UNDERSCORE)) return 95;
  return 0;
}

// ── entry point ─────────────────────────────────────────────────────────────

const app = new App();

export function _start_game(): void {
  app.run();
}

// **No `_game_running` export, and no `__taskWake`.**
//
// The host refuses half an adoption: a guest with `_game_running` and no
// `__taskWake` asks the host to drive a loop the host then cannot resume a task
// in, and `main.rs` refuses that pairing before the first guest instruction
// rather than running a loop that silently does nothing.
//
// This viewer owns its loop the way `examples/2d/hello-sprites` does: `present`
// pumps the window's events, a closed window answers `-ECANCELED`, and the loop
// ends. Adopting the host-driven loop would mean parking on `rt.frame()` every
// frame for no benefit — there is no async work here to interleave.
