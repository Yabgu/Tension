// `tension-docs`: the offline documentation viewer.
//
// A Tension guest that reads four files out of its packed volume and draws a
// reading UI:
//
//     /docs.bin         the pages, blocks and runs (2.2a)
//     /search.bin       the inverted index (2.2a)
//     /transcripts.bin  recorded output for the runnable blocks (2.2a)
//     /ui.0.iwi …       the three baked faces: Inter 14, Inter 18, Mono 14
//
// ## The frame, as a tree
//
//     root
//      └ row (flex 1)
//         ├ column sidebar (minW 320)          the table of contents
//         │   ├ label "Tension"                (Inter 18, bold)
//         │   └ list (flex 1)                  48 recycled rows over the whole TOC
//         └ column main (flex 1)
//             ├ row   search                    the query field + the hit count
//             ├ rule
//             ├ node  content (flex 1)          the page flow, or the results
//             └ row   status                    hints and counters
//
// **There is no layout arithmetic left in this file.** Every `x`/`y`/`w`/`h` is
// decided by `WidgetBehavior.arrange`; every click is a target the paint recorded;
// the scroll offset is the only number the app keeps, and it moves the *text*
// inside a pane whose rectangle the tree owns.
//
// ## What the retained tree actually bought here
//
// The viewer used to keep parallel hit arrays (`tocHitY`, `runHitX`, `runHitY`, …)
// filled during the draw and scanned by `doClick`, with a comment beside the result
// rows because that scan had drifted one row from the draw. The rows are widgets
// now: a list row records its own target where it draws itself, and a click
// bubbles from the row to the list that owns it. The run buttons and the result
// rows are recorded by the one widget that paints them and read back by its own
// `handle` — the shape a page of prose needs, because its targets live at absolute
// positions inside a scrolling region.
//
// ## The text
//
// Proportional, from the baked pages. A heading is Inter 18, the body is Inter 14,
// an inline code span is JetBrains Mono 14 — measured and drawn from the same
// advance table (`layout.ts` explains why that is what makes wrapping correct). One
// consequence is deliberate: the atlas bakes bold **only in the heading stripe**, so
// a `strong` span is drawn as white bold rather than as a second weight of the body
// colour (`colourFor`).

import {
  AppShell, Axis, BOLD, Canvas, ChangeTarget, Chrome, ClickTarget, CODE, FontBook,
  FontPage, fontBook, FONT_INTER, FONT_MONO, HEADING, LINK, ListBehavior, ListSource,
  loadFontBook, MUTED, NORMAL, Painter, print, REGULAR, resReadFile, SIZE_14, TextBuffer,
  TextBuilder, TextPool, Ui, UiEvent, UiEventKind, WidgetBehavior, WidgetTree,
} from "tension-framework";

import {
  Docs, SearchIndex, Transcripts,
  F_RUNNABLE, K_CODE, K_HEADING, K_LIST_ITEM, K_QUOTE, K_RULE,
  compareTermToQuery, termHasPrefix, TOC_NO_PAGE,
} from "./format";
import {
  CODE_INSET, colourFor, MAX_MEASURE_PX, PageLayout, pageFor, weightFor,
} from "./layout";

// ── the shell's geometry ────────────────────────────────────────────────────
//
// Only the things that are *design decisions*: a pane's width, an inset, the
// number of rows a list recycles. Everything derived from type — a line's pitch, a
// button's height, the air inside a bar — comes from the page (`FontPage`), so one
// constant cannot serve two sizes.

const SIDEBAR_W: i32 = 320;
/** The narrowest the sidebar may be dragged, and the widest the divider may go. */
const SIDEBAR_MIN: i32 = 180;
/**
 * The narrowest the content column may be dragged.
 *
 * Not `MAX_MEASURE_PX`: the measure is a cap the wrap respects, and a reader who
 * wants a narrow window beside the sidebar should get a narrower column, not a
 * refusal to drag. 420 px holds a short paragraph without breaking every word.
 */
const MAIN_MIN: i32 = 420;
/** One panel's inset from its own edge. */
const PANEL_PAD: i32 = 10;
/** The gap between two sidebar rows. */
const PANEL_GAP: i32 = 2;
/** The horizontal inset of the text column inside the content pane. */
const CONTENT_PAD: i32 = 24;
/** Air around the search field. */
const FIELD_PAD: i32 = 5;
/** Air above and below a bar's line. */
const BAR_PAD: i32 = 5;
/** How many rows the table of contents recycles. */
const TOC_ROWS: i32 = 48;
/**
 * Spaces per TOC nesting level.
 *
 * Indentation is *text*, not layout: the list has no opinion about hierarchy, and a
 * model that pushed rows around would be a second layout engine. Six spaces of
 * Inter 14 is ~21 px, which is one level's worth at this size.
 */
const TOC_INDENT: i32 = 6;
/** The gap between the hint and the counters in the status bar. */
const STATUS_GAP: i32 = 16;
/** Frames an offscreen run draws before it stops. */
const HEADLESS_FRAMES: i32 = 120;

/**
 * The hit ids the content pane uses for things that are not widgets.
 *
 * Negative, because a widget slot is never negative and the pane's own target is
 * `HIT_NONE`: a run button's id is the **block index** (non-negative), and a search
 * result's is `RESULT_HIT_BASE - i`. `PageBehavior.handle` reads them back with
 * `hits.at`, so the draw and the click share one arithmetic.
 */
const HIT_NONE: i32 = -1;
const RESULT_HIT_BASE: i32 = -2000;

/** Scancodes (SDL numbering) — `input.pressed` reads this numbering. */
const SC_UP: u32 = 82;
const SC_DOWN: u32 = 81;
const SC_PAGEUP: u32 = 75;
const SC_PAGEDOWN: u32 = 78;
const SC_HOME: u32 = 74;
const SC_END: u32 = 77;
const SC_SLASH: u32 = 56;
const SC_ESCAPE: u32 = 41;
const SC_RETURN: u32 = 40;
const SC_N: u32 = 17;
const SC_P: u32 = 19;

// ── the sidebar ─────────────────────────────────────────────────────────────

/**
 * The table of contents, as a list model.
 *
 * Item `i` is TOC entry `i`, so the list's `lastItem` *is* the entry — no second
 * index, and no way for the two to drift. The indentation is written into the row's
 * text (one run of spaces per nesting level), which is what keeps the list free of
 * any opinion about hierarchy.
 */
class TocModel extends ListSource {
  app: App | null = null;

  count(): i32 {
    const app: App | null = this.app;
    return app == null ? 0 : <i32>app.docs.tocCount;
  }

  text(index: i32, out: TextPool): void {
    const app: App | null = this.app;
    if (app == null) return;
    const depth: i32 = <i32>app.docs.tocDepth(<u32>index);
    for (let i: i32 = 0; i < depth * TOC_INDENT; i++) out.ch(32);
    out.raw(app.docs.tocTitlePtr(<u32>index), <i32>app.docs.tocTitleLen(<u32>index));
  }
}

/**
 * The list, plus the current page's marker and the per-row colours.
 *
 * `ListBehavior` already recycles rows, clips its own subtree and maps the wheel.
 * What a table of contents adds is that one row is *current* — a selection
 * background and a bright right edge — and that a group heading (an entry with no
 * page) is dimmer than a link. The colours are decided in `arrange`, where the rows
 * have just been placed; the marker is drawn in `paint`, which the engine calls
 * **before** the rows draw themselves, so it is behind the text rather than over it.
 */
class TocBehavior extends ListBehavior {
  app: App | null = null;

  arrange(ui: Ui, id: i32, x: i32, y: i32, w: i32, h: i32): void {
    super.arrange(ui, id, x, y, w, h);
    const app: App | null = this.app;
    if (app == null) return;
    const t: WidgetTree = ui.tree;
    let row: i32 = t.firstChild[id];
    while (row >= 0) {
      const item: i32 = t.itemIndex[row];
      if (item >= 0) {
        const pg: u32 = app.docs.tocPage(<u32>item);
        const current: bool = pg != TOC_NO_PAGE && <i32>pg == app.page;
        // A group heading is a label, not a link: muted and regular. The current
        // page is white and bold — the atlas bakes bold for the heading stripe,
        // which is exactly this pair.
        t.colour[row] = pg == TOC_NO_PAGE ? MUTED : (current ? HEADING : NORMAL);
        t.weight[row] = current ? BOLD : REGULAR;
      }
      row = t.nextSibling[row];
    }
  }

  paint(ui: Ui, id: i32, p: Painter): void {
    const app: App | null = this.app;
    if (app == null) return;
    const t: WidgetTree = ui.tree;
    const page: FontPage = t.page[id];
    const pad: i32 = t.pad[id];
    p.pushClip(t.x[id] + pad, t.y[id] + pad, t.w[id] - 2 * pad, t.h[id] - 2 * pad);
    let row: i32 = t.firstChild[id];
    while (row >= 0) {
      const item: i32 = t.itemIndex[row];
      if (item >= 0 && <i32>app.docs.tocPage(<u32>item) == app.page) {
        p.fill(t.x[row], t.y[row], t.w[row], t.h[row],
               page.chromeCell(Chrome.Selection), page);
        p.fill(t.x[row] + t.w[row] - 2, t.y[row], 2, t.h[row],
               page.chromeCell(Chrome.White), page);
        break;
      }
      row = t.nextSibling[row];
    }
    p.popClip();
  }
}

/** A click on a TOC row: `ui.lastItem` is the entry, and its page is the target. */
class TocClick implements ClickTarget {
  app: App;

  constructor(app: App) {
    this.app = app;
  }

  click(): void {
    const item: i32 = this.app.ui.lastItem;
    if (item < 0) return;
    const pg: u32 = this.app.docs.tocPage(<u32>item);
    if (pg == TOC_NO_PAGE) return;
    this.app.openPage(<i32>pg);
  }
}

/** The search field changed: rank the query before anything reads it. */
class QueryChanged implements ChangeTarget {
  app: App;

  constructor(app: App) {
    this.app = app;
  }

  change(value: i32): void {
    this.app.queryChanged();
  }
}

// ── the content pane ────────────────────────────────────────────────────────

/**
 * The page flow, or the search results, inside one scrolling rectangle.
 *
 * This is the largest custom behavior in the repository and it is deliberately one
 * widget: a page is a *flow* of lines whose vertical positions a `PageLayout`
 * computes once, and turning a thousand lines into a thousand widgets to hand that
 * arithmetic back to a column would spend the pool's whole budget on one document.
 * What the tree still owns is everything around it — the pane's rectangle, its clip,
 * culling and the dispatch — and what stays here is a walk over
 * `lineStart`/`lineLen`/`lineY`.
 *
 * **Nothing is measured per frame.** The wrap is cached in `PageLayout`; `paint`
 * skips the lines above the pane with a scan and stops at the first line below it,
 * so a 2,000-line page costs its visible lines and no more.
 *
 * **The hits are the draw's.** A run button records `(rect, blockIndex)` through
 * `p.addHit` as it is painted; `handle` reads the topmost id back at the press
 * position. One arithmetic, one owner — which is what the parallel hit arrays in
 * this file's previous life were trying to be.
 */
class PageBehavior implements WidgetBehavior {
  app: App | null = null;
  /** The pane's rectangle, from the last arrange: the geometry this widget paints. */
  x: i32 = 0;
  y: i32 = 0;
  w: i32 = 0;
  h: i32 = 0;
  /** The transcript header, which carries a number and so cannot be a literal. */
  private head: TextBuilder = new TextBuilder(64);
  /** The button labels, encoded once: literals, but not free to encode per frame. */
  private runLabel: Uint8Array = new Uint8Array(32);
  private runLen: i32 = 0;
  private hideLabel: Uint8Array = new Uint8Array(32);
  private hideLen: i32 = 0;

  constructor() {
    const run: string = "Run (recorded)";
    this.runLen = <i32>String.UTF8.encodeUnsafe(changetype<usize>(run), run.length,
                                               this.runLabel.dataStart);
    const hide: string = "Hide output";
    this.hideLen = <i32>String.UTF8.encodeUnsafe(changetype<usize>(hide), hide.length,
                                                 this.hideLabel.dataStart);
  }

  measure(ui: Ui, id: i32): void {
    // Nothing intrinsic: the column gives the pane what is left, and a page that
    // measured itself from its content would be as tall as the document.
    ui.setSize(id, 0, 0);
    ui.applyFloors(id);
  }

  arrange(ui: Ui, id: i32, x: i32, y: i32, w: i32, h: i32): void {
    if (x == this.x && y == this.y && w == this.w && h == this.h) return;
    this.x = x;
    this.y = y;
    this.w = w;
    this.h = h;
  }

  paint(ui: Ui, id: i32, p: Painter): void {
    const app: App | null = this.app;
    if (app == null) return;
    const t: WidgetTree = ui.tree;
    const x: i32 = t.x[id];
    const y: i32 = t.y[id];
    const w: i32 = t.w[id];
    const h: i32 = t.h[id];
    if (w <= 0 || h <= 0) return;

    p.pushClip(x, y, w, h);
    // The pane's own target, which is also the one the wheel needs: a click on the
    // blank part of a page lands here (`HIT_NONE`) and a wheel over the text
    // scrolls it.
    p.addHit(x, y, w, h, HIT_NONE, id);
    if (app.queryLen() > 0) {
      this.paintResults(ui, id, p, app);
    } else {
      this.paintPage(ui, id, p, app);
    }
    p.popClip();
  }

  handle(ui: Ui, id: i32, ev: UiEvent): bool {
    const app: App | null = this.app;
    if (app == null) return false;
    if (ev.kind == UiEventKind.Wheel) {
      app.scrollBy(-ev.value * app.step() * 3);
      return true;
    }
    if (ev.kind == UiEventKind.Click) {
      const hit: i32 = ui.hits.at(ev.x, ev.y);
      if (hit >= 0) {
        // A run button: its id is the block the page flow gave it.
        app.toggleTranscript(hit);
        return true;
      }
      if (hit <= RESULT_HIT_BASE) {
        app.openResult(RESULT_HIT_BASE - hit);
        return true;
      }
      // The pane's own background: nothing to do, but the click is ours.
      return hit == HIT_NONE;
    }
    return false;
  }

  // --- the page ------------------------------------------------------------

  private paintPage(ui: Ui, id: i32, p: Painter, app: App): void {
    const t: WidgetTree = ui.tree;
    const layout: PageLayout = app.layout;
    const chars: Uint8Array = layout.chars;
    const styles: Uint8Array = layout.styles;
    const y: i32 = t.y[id];
    const h: i32 = t.h[id];
    const bottom: i32 = y + h;
    const scroll: i32 = app.scroll;
    const left: i32 = this.textLeft(app);
    const body: FontPage = app.book.page(FONT_INTER, SIZE_14);
    const bodyBase: i32 = body.baseline;

    // Where the transcript panel hangs, decided while walking the flow and drawn
    // after it: the panel is an overlay, and drawing it inside the loop let the
    // paragraphs below paint straight over it.
    let transcriptY: i32 = -1;

    // Only the visible lines are walked. The scan is over the cached `lineY`, and
    // everything before it is skipped without touching a glyph.
    let li: i32 = 0;
    while (li < layout.lineCount &&
           layout.lineY[li] + layout.blockStep[layout.lineBlock[li]] < scroll) {
      li++;
    }

    for (; li < layout.lineCount; li++) {
      const block: i32 = layout.lineBlock[li];
      const kind: u8 = layout.blockKind[block];
      const level: u8 = layout.blockLevel[block];
      const step: i32 = layout.blockStep[block];
      const lineY: i32 = layout.lineY[li] - scroll + y;
      if (lineY > bottom) break;

      const indent: i32 = kind == K_CODE ? CODE_INSET
        : (kind == K_LIST_ITEM || kind == K_QUOTE ? CODE_INSET : 0);
      const lx: i32 = left + indent;
      const start: i32 = layout.lineStart[li];
      const len: i32 = layout.lineLen[li];

      // A rule is a bar where a line of text would be.
      if (kind == K_RULE) {
        p.fill(left, lineY + step / 2, layout.wrapPx, 1,
               body.chromeCell(Chrome.Divider), body);
        continue;
      }

      // A code block's marker: a one-pixel accent on the left, drawn per line so a
      // scrolled block has a continuous rule. A full background behind the block
      // would be the other option and is unaffordable: tiled at the cell size that
      // is ~100 records *per line*.
      if (kind == K_CODE) {
        p.fill(left, lineY, 1, step, body.chromeCell(Chrome.Selection), body);
      }

      // A heading's rule, sized to its own measured text, is what gives the
      // hierarchy its weight without a second pipeline. `lineW` is the wrap's own
      // measurement, so the rule ends exactly where the text does.
      if (kind == K_HEADING && level <= 2) {
        p.fill(lx, lineY + step - 3, layout.lineW[li], level == 1 ? 2 : 1,
               body.chromeCell(Chrome.Divider), body);
      }

      // A bullet for a list item — only on the block's **first** line. A wrapped
      // continuation that got its own dash read as a second item.
      if (kind == K_LIST_ITEM && len > 0 && li == layout.blockFirstLine[block]) {
        const dash: i32 = body.advancePx(REGULAR, 45);
        p.char(45, lx - dash - 6, lineY, MUTED, REGULAR, y, bottom, body);
      }

      // Emit the line: consecutive characters in one style become one call, and
      // the cursor is the *painter's* answer — the same advance table the wrap used.
      let i: i32 = 0;
      let cx: i32 = lx;
      while (i < len) {
        const style: u8 = styles[start + i];
        let j: i32 = i + 1;
        while (j < len && styles[start + j] == style) j++;
        const runPage: FontPage = pageFor(kind, style);
        const ty: i32 = lineY + (bodyBase - runPage.baseline);
        cx = p.textBytes(chars, start + i, j - i, cx, ty,
                         colourFor(kind, level, style), weightFor(kind, style), 0, y, bottom,
                         runPage);
        i = j;
      }

      // The Run button, on the row the layout reserved for it — the block's last
      // line, which carries no text.
      if (kind == K_CODE && (layout.blockFlags[block] & F_RUNNABLE) != 0 &&
          li == layout.blockFirstLine[block] + layout.blockLineCount[block] - 1) {
        this.paintRunButton(p, app, layout.blockIndex[block], lineY);
      }

      // The transcript, anchored under its block. Only the anchor is decided here.
      if (app.showingBlock >= 0 && layout.blockIndex[block] == app.showingBlock &&
          li == layout.blockFirstLine[block] + layout.blockLineCount[block] - 1) {
        transcriptY = lineY + step + 4;
      }
    }

    if (transcriptY >= 0) this.paintTranscript(p, app, transcriptY);
  }

  /**
   * The "Run (recorded)" button.
   *
   * A filled box of the selection colour with a bright top edge, right-aligned to
   * the text column on its own row. The label is drawn in the heading colour, which
   * is the only way to get light text on a lighter box when the atlas carries the
   * colour rather than the shader.
   */
  private paintRunButton(p: Painter, app: App, block: i32, lineY: i32): void {
    const body: FontPage = app.book.page(FONT_INTER, SIZE_14);
    const showing: bool = app.showingBlock == block;
    const n: i32 = showing ? this.hideLen : this.runLen;
    const bytes: Uint8Array = showing ? this.hideLabel : this.runLabel;
    const w: i32 = app.book.measure(body, REGULAR, bytes, 0, n) + 16;
    // The button owns the row the layout reserved for it: one line step less two
    // pixels of air, so the transcript panel anchored below the row cannot be
    // overlapped by the box.
    const h: i32 = body.lineStep - 2;
    const left: i32 = this.textLeft(app);
    const bx: i32 = left + app.layout.wrapPx - w;
    if (bx < left) return;

    p.fill(bx, lineY, w, h, body.chromeCell(Chrome.Selection), body);
    p.fill(bx, lineY, w, 1, body.chromeCell(Chrome.White), body);
    p.textBytes(bytes, 0, n, bx + 8, lineY + 3, HEADING, REGULAR, 0, lineY, lineY + h, body);
    p.addHit(bx, lineY, w, h, block, app.contentId());
  }

  /** Where the text column starts, in tree space: the measure, centred. */
  private textLeft(app: App): i32 {
    const inset: i32 = this.w - app.layout.wrapPx;
    return this.x + (inset > 0 ? inset / 2 : 0);
  }

  // --- the search results --------------------------------------------------

  private paintResults(ui: Ui, id: i32, p: Painter, app: App): void {
    const t: WidgetTree = ui.tree;
    const body: FontPage = app.book.page(FONT_INTER, SIZE_14);
    const step: i32 = body.lineStep;
    const left: i32 = this.textLeft(app);
    const top: i32 = t.y[id] + 4;
    const bottom: i32 = t.y[id] + t.h[id];
    const q: TextBuffer = t.bufferOf(app.searchField);

    const prompt: string = "Results for";
    this.paintText(p, app, prompt, left, top, MUTED, top, bottom);
    const promptW: i32 = app.book.measureText(body, REGULAR, prompt);
    p.textBytes(q.bytes, 0, q.len, left + promptW + 8, top, LINK, REGULAR, 0,
                top, bottom, body);

    const rowsTop: i32 = top + step + 8;
    if (app.results.length == 0) {
      this.paintText(p, app, "no section matches that prefix", left, rowsTop, MUTED,
                     top, bottom);
      return;
    }

    const rowH: i32 = step * 2 + 4;
    const rowStep: i32 = rowH + 6;
    for (let i: i32 = 0; i < app.results.length; i++) {
      const ry: i32 = rowsTop + i * rowStep - app.scroll;
      if (ry > bottom) break;
      if (ry + rowH < top) continue;

      const section: i32 = app.results[i];
      // The title, with the matched prefix picked out in the link colour — the
      // highlight is what tells the reader *why* the row matched.
      this.paintHighlighted(p, app, app.docs.sectionTitlePtr(<u32>section),
                            <i32>app.docs.sectionTitleLen(<u32>section), left, ry, bottom);

      // The page it belongs to, indented and muted.
      const page: i32 = <i32>app.docs.sectionPage(<u32>section);
      if (page >= 0 && page < <i32>app.docs.pageCount) {
        const subY: i32 = ry + step + 2;
        if (subY + step <= bottom) {
          p.text(app.docs.pageTitlePtr(<u32>page), <i32>app.docs.pageTitleLen(<u32>page),
                 left + 8, subY, MUTED, REGULAR, 0, subY, bottom, body);
        }
      }
      p.addHit(left, ry, app.layout.wrapPx, rowH, RESULT_HIT_BASE - i, id);
    }
  }

  /** A title with the query's occurrences in the link colour, over a byte span. */
  private paintHighlighted(p: Painter, app: App, ptr: usize, len: i32, x: i32, y: i32,
                           bottom: i32): void {
    const q: TextBuffer = app.ui.tree.bufferOf(app.searchField);
    const body: FontPage = app.book.page(FONT_INTER, SIZE_14);
    let i: i32 = 0;
    let cx: i32 = x;
    while (i < len) {
      let match: bool = false;
      if (q.len > 0 && i + q.len <= len) {
        match = true;
        for (let k: i32 = 0; k < q.len; k++) {
          if (lowerAscii(load<u8>(ptr + <usize>(i + k))) != lowerAscii(q.bytes[k])) {
            match = false;
            break;
          }
        }
      }
      if (match) {
        cx = p.text(ptr + <usize>i, q.len, cx, y, LINK, REGULAR, 0, y, bottom, body);
        i += q.len;
        continue;
      }
      cx = p.text(ptr + <usize>i, 1, cx, y, NORMAL, REGULAR, 0, y, bottom, body);
      i++;
    }
  }

  // --- small text ----------------------------------------------------------

  /**
   * A literal string, drawn in the body page.
   *
   * The encode goes into a [`TextBuilder`] the behavior owns rather than into a
   * fresh `Uint8Array`: a literal is a static `String`, but encoding one still
   * needs a destination, and a destination per call is the allocation the retained
   * UI exists to remove.
   */
  private paintText(p: Painter, app: App, text: string, x: i32, y: i32, colour: i32,
                    clipTop: i32, clipBottom: i32): void {
    const body: FontPage = app.book.page(FONT_INTER, SIZE_14);
    this.head.clear();
    this.head.str(text);
    p.textBytes(this.head.bytes, this.head.at, this.head.len, x, y, colour, REGULAR, 0,
                clipTop, clipBottom, body);
  }

  // --- the transcript ------------------------------------------------------

  /**
   * The recorded transcript, below its code block.
   *
   * **Opaque**, because it is an overlay: without the backing the paragraph below
   * shows through and neither is readable. Anchored under the block's last line and
   * never moved up over it — shrinking the number of visible lines is the honest
   * answer, and the reader can scroll to see the rest.
   */
  private paintTranscript(p: Painter, app: App, y: i32): void {
    const body: FontPage = app.book.page(FONT_INTER, SIZE_14);
    const step: i32 = body.lineStep;
    const left: i32 = this.textLeft(app);
    const bottom: i32 = this.y + this.h;
    const headH: i32 = step + 6;
    const width: i32 = app.layout.wrapPx;

    if (app.showingEntry < 0) {
      if (y + headH <= bottom) {
        p.fill(left, y, width, headH, body.chromeCell(Chrome.Surface), body);
        p.hline(left, y, width, body.chromeCell(Chrome.Selection), body);
        this.paintText(p, app, "no transcript recorded for this block", left + 8, y + 4,
                       MUTED, y, bottom);
      }
      return;
    }

    const ptr: usize = app.transcripts.textPtr(<u32>app.showingEntry);
    const len: i32 = <i32>app.transcripts.textLen(<u32>app.showingEntry);
    const lines: i32 = app.transcriptLines(app.showingEntry);

    const avail: i32 = bottom - y;
    const fit: i32 = (avail - headH) / step;
    if (fit < 1) {
      if (y + headH <= bottom) {
        this.paintText(p, app, "scroll down to see the output", left + 8, y + 4,
                       MUTED, y, bottom);
      }
      return;
    }
    const shown: i32 = lines < fit ? lines : fit;
    const panelH: i32 = shown * step + headH;

    p.fill(left, y, width, panelH, body.chromeCell(Chrome.Panel), body);
    p.hline(left, y, width, body.chromeCell(Chrome.Selection), body);
    p.fill(left, y, 1, panelH, body.chromeCell(Chrome.Selection), body);

    this.head.clear();
    this.head.str("output - recorded at build time, ");
    this.head.int(<i32>app.transcripts.durationMs(<u32>app.showingEntry));
    this.head.str(" ms");
    p.textBytes(this.head.bytes, this.head.at, this.head.len, left + 8, y + 4, MUTED,
                REGULAR, 0, y, bottom, body);

    const code: FontPage = app.book.page(FONT_MONO, SIZE_14);
    let lineY: i32 = y + headH;
    let s: i32 = 0;
    for (let n: i32 = 0; n < shown; n++) {
      let e: i32 = s;
      while (e < len && load<u8>(ptr + <usize>e) != 10) e++;
      const lineLen: i32 = e - s;
      if (lineLen > 0) {
        p.text(ptr + <usize>s, lineLen, left + 8, lineY, CODE, REGULAR, 0, y, bottom, code);
      }
      lineY += step;
      s = e + 1;
      if (s >= len) break;
    }

    if (shown < lines) {
      this.paintText(p, app, "... more line(s) below", left + 8, lineY, MUTED, y, bottom);
    }
  }
}

// ── the app ─────────────────────────────────────────────────────────────────

class App extends AppShell {
  // --- the document and its three asset files -----------------------------
  docs: Docs = Docs.open(new Uint8Array(0));
  search: SearchIndex = SearchIndex.open(new Uint8Array(0));
  transcripts: Transcripts = Transcripts.open(new Uint8Array(0));
  layout: PageLayout = new PageLayout();

  // --- the tree ------------------------------------------------------------
  book: FontBook = fontBook();
  ui: Ui = new Ui(new WidgetTree(fontBook()));

  searchField: i32 = -1;
  private toc: i32 = -1;
  private hitCount: i32 = -1;
  private content: i32 = -1;
  private hint: i32 = -1;
  private counters: i32 = -1;

  private tocBehavior: TocBehavior = new TocBehavior();
  private pageBehavior: PageBehavior = new PageBehavior();
  private tocModel: TocModel = new TocModel();

  // --- what the reader is looking at ---------------------------------------
  /** The page being read, or -1 while search results are showing. */
  page: i32 = 0;
  scroll: i32 = 0;
  /** The block whose transcript is showing, or -1. */
  showingBlock: i32 = -1;
  showingEntry: i32 = -1;
  /** How much page height the open transcript adds. */
  transcriptH: i32 = 0;

  // --- search --------------------------------------------------------------
  /** Section indices matching the query, best first. */
  results: i32[] = [];
  resultScores: i32[] = [];
  /** Set whenever the query changes, cleared after `computeResults`. */
  private resultsDirty: bool = false;
  private scores: i32[] = [];
  private marked: u8[] = [];
  private touched: i32[] = [];

  // --- status --------------------------------------------------------------
  /**
   * What the status bar said last, so a frame that changes nothing writes nothing.
   *
   * `lastRecordsSeen` is *this* app's latch on the shell's own counter
   * (`AppShell.lastRecords`, written after the frame is submitted); the two names
   * differ because shadowing the shell's field is a compile error, and rightly so.
   */
  private lastRecordsSeen: i32 = -1;
  private lastDroppedSeen: i32 = -1;
  private lastPage: i32 = -2;
  private lastHits: i32 = -2;
  private lastHint: string = "";
  private builder: TextBuilder = new TextBuilder(64);
  private builder2: TextBuilder = new TextBuilder(32);

  /** Set when the TOC's scroll should be re-centred on the current page. */
  private tocSync: bool = false;
  /** A block to scroll to once the next layout is built, or -1. */
  private pendingBlock: i32 = -1;

  constructor() {
    // The name the shell's own lines carry: a launcher's log should say which app
    // is talking, and this is the string the teardown line has always used.
    super("tension-docs", fontBook().pages[0], HEADLESS_FRAMES);
    // The behaviors need the app, and the app needs its fields assigned before it
    // can be handed out; the constructor is the first place both are true.
    this.tocBehavior.app = this;
    this.pageBehavior.app = this;
    this.tocModel.app = this;
    this.build(1280, 720);
  }

  // ── the shell's hooks ───────────────────────────────────────────────────

  /**
   * The three pages of type.
   *
   * `loadFontBook` uploads every page and binds each to its slot — one call,
   * because the file the bake wrote, the slot a record names and the page the book
   * hands out must agree, and a caller that bound two of three gets a frame with
   * one face missing.
   */
  protected loadAssets(canvas: Canvas, pipe: i32): bool {
    const bound: i32 = loadFontBook(canvas, pipe);
    if (bound != 0) {
      print("tension-docs: the UI pages did not load: " + bound.toString() +
        " (run `npm run assets` in apps/docs)");
      return false;
    }
    return true;
  }

  /**
   * The volume and the opening page, after the shell's startup.
   *
   * The three data files are read once, whole: the readers keep offsets into those
   * buffers rather than copying them.
   */
  start(): bool {
    if (!super.start()) return false;

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

    this.ui.items(this.toc, <i32>this.docs.tocCount);
    this.openPage(0);

    print("tension-docs: " + this.docs.pageCount.toString() + " pages, " +
      this.search.termCount.toString() + " search terms, " +
      this.transcripts.count.toString() + " recorded example(s)");
    return true;
  }

  /**
   * A new window size: the root's rectangle, and nothing else.
   *
   * No widget is re-measured by a resize — that is the property the two passes
   * exist for. The text column follows in `draw`, where the content pane's new
   * width is known (it is an arrange's answer, not a window size).
   */
  protected onResize(width: i32, height: i32): void {
    this.ui.tree.resize(width, height);
  }

  // ── the tree, once ──────────────────────────────────────────────────────

  private build(w: i32, h: i32): void {
    const ui: Ui = this.ui;
    const root: i32 = ui.root(w, h);
    // **A split, not a row.** The sidebar's width is the reader's to set: a
    // 320-pixel table of contents is right for a chapter list and wasteful for a
    // deep module tree. `ui.split` draws the divider and owns the drag (capture,
    // clamp, hover feedback), so this file keeps no width state at all — the
    // arrange clamps `splitPx` into `[minA, total - divider - minB]` on every pass,
    // which is also what makes the pane survive a window narrower than both floors.
    const split: i32 = ui.split(root, Axis.X, { flex: 1 });
    ui.divider(split, SIDEBAR_W);

    // ── the sidebar ───────────────────────────────────────────────────────
    const sidebar: i32 = ui.column(split, { minW: SIDEBAR_MIN, pad: PANEL_PAD, gap: PANEL_GAP });
    ui.clips(sidebar);

    ui.label(sidebar, "Tension", { colour: HEADING, weight: BOLD });

    // Four pixels of pad puts the row clip *inside* the pane's own content box, so
    // a title too long for the sidebar stops short of the rule instead of having a
    // glyph trimmed in half at it.
    this.toc = ui.list(sidebar, this.tocModel, TOC_ROWS, { flex: 1, pad: 4 });
    ui.setBehavior(this.toc, this.tocBehavior);
    ui.onClick(this.toc, new TocClick(this));

    // ── the main column ───────────────────────────────────────────────────
    // `minW` is the split's clamp for the second pane, not a layout hint: it is
    // what stops a drag from squeezing the text column to a word a line.
    const main: i32 = ui.column(split, { minW: MAIN_MIN, flex: 1 });

    const bar: i32 = ui.row(main, { pad: BAR_PAD, gap: 8 });
    this.searchField = ui.field(bar, "", { pad: FIELD_PAD, flex: 1 });
    ui.onChange(this.searchField, new QueryChanged(this));
    this.hitCount = ui.label(bar, "", { colour: MUTED });

    ui.rule(main);

    this.content = ui.node(main, this.pageBehavior, { flex: 1 });
    // The one container that clips its children: the page flow is positioned in
    // scrolled coordinates, so what is above the pane must be *culled*, not drawn
    // and then trimmed.
    ui.clips(this.content);

    const status: i32 = ui.row(main, { pad: BAR_PAD, gap: STATUS_GAP });
    ui.clips(status);
    this.hint = ui.label(status, "", { colour: MUTED });
    ui.spacer(status, 1);
    this.counters = ui.label(status, "", { colour: MUTED });
  }

  /** The content widget's slot, for the behavior that paints the run buttons. */
  contentId(): i32 {
    return this.content;
  }

  // ── the frame ───────────────────────────────────────────────────────────

  /**
   * Read this frame's input and hand it to the tree.
   *
   * The dispatcher's `frame` is the frame's **only** read of the typed stream: it
   * calls `readText` once, stores the bytes, and dispatches them to the focused
   * field. A second reader would be a second consumer of one queue.
   */
  protected update(): void {
    let live: bool = false;
    if (this.inputReady && this.input.read()) {
      this.ui.frame(this.input);
      live = true;
    } else {
      this.ui.frame(null);
    }

    if (live) this.shortcuts();

    // A query that changed during the dispatch is ranked before anything reads
    // `results` — the counter and the results pane both come from it.
    if (this.resultsDirty) {
      this.computeResults();
      this.resultsDirty = false;
      this.ui.repaint(this.content);
    }
  }

  /**
   * The keys the field does not own.
   *
   * `/` focuses the search field, Escape clears the query (or closes the
   * transcript), and the page keys scroll. The dispatcher delivers Tab and Escape's
   * *blur* itself; what is left here is what a *page* means, which no widget can
   * know.
   */
  private shortcuts(): void {
    const input = this.input;

    if (input.pressed(SC_SLASH) && this.ui.focusId != this.searchField) {
      this.ui.setFocus(this.searchField);
    }

    if (input.pressed(SC_ESCAPE)) {
      if (this.queryLen() > 0) {
        this.clearQuery();
        this.scroll = 0;
        this.ui.repaint(this.content);
      } else if (this.showingBlock >= 0) {
        this.toggleTranscript(this.showingBlock);
      }
    }

    const step: i32 = this.step();
    if (input.pressed(SC_DOWN)) this.scrollBy(step * 2);
    if (input.pressed(SC_UP)) this.scrollBy(-step * 2);
    if (input.pressed(SC_PAGEDOWN)) this.scrollBy(this.paneH() - step);
    if (input.pressed(SC_PAGEUP)) this.scrollBy(-(this.paneH() - step));
    if (input.pressed(SC_HOME)) this.scrollBy(-this.maxScroll());
    if (input.pressed(SC_END)) this.scrollBy(this.maxScroll());

    // Page navigation by keyboard, for the display where the pointer is not
    // available: `n`/`p` rather than the arrows, which already scroll.
    if (this.ui.focusId != this.searchField) {
      if (input.pressed(SC_N)) this.stepPage(1);
      if (input.pressed(SC_P)) this.stepPage(-1);
      if (input.pressed(SC_RETURN)) {
        const block: i32 = this.firstRunnableBlock();
        if (block >= 0) this.toggleTranscript(block);
      }
    }
  }

  /** One frame: layout, the column's width, then the records. */
  protected draw(p: Painter): void {
    this.syncStatus();
    this.ui.tree.layout();
    this.syncLayout();
    if (this.tocSync) this.syncTocScroll();
    this.ui.tree.paint(p, this.ui.hits);
  }

  /**
   * Re-wrap the page if the content pane's width (or the page) changed.
   *
   * The wrap is a function of a rectangle that only an **arrange** knows, so it
   * cannot be done in `onResize`: the sidebar's width, the padding and the measure
   * cap all take part. Doing it here also means a window dragged wider re-wraps on
   * the frame it got wider.
   */
  private syncLayout(): void {
    if (!this.docs.ok) return;
    const w: i32 = this.ui.wOf(this.content) - 2 * CONTENT_PAD;
    const wrap: i32 = w > MAX_MEASURE_PX ? MAX_MEASURE_PX : w;
    if (this.layout.page != this.page || this.layout.wrapPx != wrap) {
      this.layout.build(this.docs, <u32>this.page, wrap);
      this.clampScroll();
      this.ui.repaint(this.content);
    }
    // A search result's first block, once the page it names has a layout.
    if (this.pendingBlock >= 0) {
      this.scroll = this.layout.scrollForBlock(this.pendingBlock);
      this.pendingBlock = -1;
      this.clampScroll();
    }
  }

  /** Keep the current page's TOC entry on screen, centred where it can be. */
  private syncTocScroll(): void {
    this.tocSync = false;
    if (!this.docs.ok) return;
    const total: i32 = <i32>this.docs.tocCount;
    let at: i32 = -1;
    for (let i: i32 = 0; i < total; i++) {
      const pg: u32 = this.docs.tocPage(<u32>i);
      if (pg != TOC_NO_PAGE && <i32>pg == this.page) { at = i; break; }
    }
    if (at < 0) return;
    const rowH: i32 = this.ui.tree.itemH[this.toc] > 0
      ? this.ui.tree.itemH[this.toc] : this.step();
    this.ui.scrollTo(this.toc, at * rowH - this.ui.hOf(this.toc) / 2 + rowH);
  }

  // ── the status bar ──────────────────────────────────────────────────────

  /**
   * The two counters and the hint.
   *
   * Composed with a `TextBuilder` and written into the labels' own buffers: no
   * `String` is built, so a frame that changes nothing allocates nothing. The hint
   * degrades to a short form when the window cannot carry it *and* the counters — a
   * reader who cannot see `/ search` has no way to discover search at all, so it
   * shortens rather than vanishing.
   */
  private syncStatus(): void {
    const records: i32 = this.lastRecords;
    const dropped: i32 = this.lastDropped;
    const pageNo: i32 = this.page + 1;
    if (records != this.lastRecordsSeen || dropped != this.lastDroppedSeen ||
        pageNo != this.lastPage) {
      this.lastRecordsSeen = records;
      this.lastDroppedSeen = dropped;
      this.lastPage = pageNo;
      const b: TextBuilder = this.builder;
      b.clear();
      b.int(pageNo);
      b.ch(47);                       // '/'
      b.int(<i32>this.docs.pageCount);
      b.str("   ");
      b.int(records);
      b.str(" sp");
      if (dropped > 0) {
        b.str("   ");
        b.int(dropped);
        b.str(" dropped");
      }
      this.ui.textBuilder(this.counters, b);
      this.ui.colour(this.counters, dropped > 0 ? HEADING : MUTED);
    }

    const focused: bool = this.ui.focusId == this.searchField;
    const full: string = !this.inputReady
      ? "input unavailable"
      : (focused ? "type to search   Esc to clear" : "/ search   n/p keys   Enter output");
    const brief: string = focused ? "Esc to clear" : "/ search   n/p";
    const body: FontPage = this.book.page(FONT_INTER, SIZE_14);
    const statusW: i32 = this.ui.wOf(this.ui.tree.parent[this.hint]);
    const space: i32 = statusW - this.ui.wOf(this.counters) - STATUS_GAP - 4 * BAR_PAD;
    const want: string = this.book.measureText(body, REGULAR, full) <= space
      ? full
      : (this.book.measureText(body, REGULAR, brief) <= space ? brief : "");
    if (want != this.lastHint) {
      this.lastHint = want;
      this.ui.text(this.hint, want);
      this.ui.colour(this.hint, this.inputReady ? MUTED : HEADING);
    }

    // The hit count, beside the field.
    const n: i32 = this.queryLen() >= 2 ? this.results.length : -1;
    if (n != this.lastHits) {
      this.lastHits = n;
      const b2: TextBuilder = this.builder2;
      b2.clear();
      if (n >= 0) {
        b2.int(n);
        b2.str(n == 1 ? " section" : " sections");
      }
      this.ui.textBuilder(this.hitCount, b2);
    }
  }

  // ── the page ────────────────────────────────────────────────────────────

  /** The body line step — the unit every scroll distance is expressed in. */
  step(): i32 {
    return this.book.page(FONT_INTER, SIZE_14).lineStep;
  }

  /** The visible height of the content pane, from its arranged rectangle. */
  private paneH(): i32 {
    const h: i32 = this.ui.hOf(this.content);
    return h > 0 ? h : 1;
  }

  private maxScroll(): i32 {
    // **The pane shows the results only when there is a query**, so that is also
    // the only case where the scroll range is the results list.
    const step: i32 = this.step();
    let total: i32 = this.layout.height + this.transcriptH;
    if (this.queryLen() > 0) {
      total = step * 2 + 16 + this.results.length * (step * 2 + 10);
    }
    const max: i32 = total - this.paneH();
    return max > 0 ? max : 0;
  }

  scrollBy(delta: i32): void {
    const before: i32 = this.scroll;
    this.scroll += delta;
    this.clampScroll();
    if (this.scroll != before) this.ui.repaint(this.content);
  }

  private clampScroll(): void {
    if (this.scroll < 0) this.scroll = 0;
    const max: i32 = this.maxScroll();
    if (this.scroll > max) this.scroll = max;
  }

  /**
   * Show `page`, from the top.
   *
   * The wrap follows in `syncLayout`, where the pane's width is known: a page change
   * does not know how wide the window is, and building the layout twice per click
   * would be the cost of pretending it does.
   */
  openPage(page: i32): void {
    if (!this.docs.ok) return;
    if (page < 0 || page >= <i32>this.docs.pageCount) return;
    this.page = page;
    this.scroll = 0;
    this.showingBlock = -1;
    this.showingEntry = -1;
    this.transcriptH = 0;
    this.clearQuery();
    this.tocSync = true;
    this.ui.repaint(this.content);
    this.ui.repaint(this.toc);
  }

  /** Open a search result: its page, scrolled to its first block. */
  openResult(index: i32): void {
    if (index < 0 || index >= this.results.length) return;
    const section: i32 = this.results[index];
    const page: i32 = <i32>this.docs.sectionPage(<u32>section);
    const block: i32 = <i32>this.docs.sectionBlockFirst(<u32>section);
    this.openPage(page);
    this.pendingBlock = block;
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
      this.ui.repaint(this.content);
      return;
    }
    this.showingBlock = block;
    this.showingEntry = this.transcripts.ok ? this.transcripts.find(block) : -1;

    // The panel becomes part of the page's height, and opening it scrolls to it when
    // it would not otherwise be visible. A code block near the bottom of a page is
    // the common case, and "the button answered but nothing appeared" is
    // indistinguishable from a dead button.
    this.transcriptH = this.showingEntry >= 0
      ? this.transcriptLines(this.showingEntry) * this.step() + this.step() + 6
      : this.step() + 12;
    const anchor: i32 = this.layout.anchorForBlock(block);
    if (anchor >= 0) {
      const want: i32 = anchor + this.transcriptH - this.paneH();
      if (want > this.scroll) this.scroll = want;
    }
    this.clampScroll();
    this.ui.repaint(this.content);
  }

  /** How many lines a recorded transcript has, header excluded. */
  transcriptLines(entry: i32): i32 {
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

  /** Move to the adjacent page in the table of contents. */
  private stepPage(delta: i32): void {
    const total: i32 = <i32>this.docs.tocCount;
    let here: i32 = -1;
    for (let i: i32 = 0; i < total; i++) {
      const pg: u32 = this.docs.tocPage(<u32>i);
      if (pg != TOC_NO_PAGE && <i32>pg == this.page) { here = i; break; }
    }
    if (here < 0) return;
    let next: i32 = here + delta;
    while (next >= 0 && next < total) {
      const pg: u32 = this.docs.tocPage(<u32>next);
      if (pg != TOC_NO_PAGE) {
        this.openPage(<i32>pg);
        return;
      }
      next += delta;
    }
  }

  // ── search ──────────────────────────────────────────────────────────────

  /** The query, as bytes: it is the search field's own buffer. */
  queryLen(): i32 {
    return this.searchField >= 0 ? this.ui.tree.textLength(this.searchField) : 0;
  }

  private clearQuery(): void {
    if (this.searchField < 0) return;
    if (this.ui.tree.textLength(this.searchField) > 0) this.ui.text(this.searchField, "");
    this.resultsDirty = true;
  }

  /**
   * The field changed: rank the query, and show the results.
   *
   * Called by the closure the field's `onChange` registered, and *also* the point
   * where the pane switches from the document to the results: a query that is typed
   * but not yet ranked would draw the previous page under a new prompt.
   */
  queryChanged(): void {
    this.resultsDirty = true;
    this.scroll = 0;
  }

  /**
   * Resolve the query into ranked sections.
   *
   * Prefix-first, and that is the whole as-you-type story: a reader typing `rend`
   * gets every term beginning with it, which is a dictionary scan over 5,744 sorted
   * terms affords in microseconds. Scored by occurrence count, weighted up for a term
   * in a section's heading and for an exact term match.
   *
   * **No `Map`.** AssemblyScript's `Map#get` is the `[]` operator, which throws on a
   * missing key rather than returning null, so the obvious accumulator kills the
   * guest. Sections are dense integers, so the accumulator is a flat score array
   * instead: one indexed add per posting, and no hashing at all.
   */
  private computeResults(): void {
    this.results = [];
    this.resultScores = [];

    const sections: i32 = <i32>this.docs.sectionCount;
    if (sections <= 0) return;
    if (this.scores.length != sections + 1) {
      this.scores = new Array<i32>(sections + 1);
      this.marked = new Array<u8>(sections + 1);
    }
    // Clear only what the last query touched — a memset of 628 entries per keystroke
    // would be the largest thing this function does.
    for (let i: i32 = 0; i < this.touched.length; i++) {
      const at: i32 = this.touched[i];
      this.scores[at] = 0;
      this.marked[at] = 0;
    }
    this.touched = [];

    const q: TextBuffer = this.ui.tree.bufferOf(this.searchField);
    const qlen: i32 = q.len;
    if (qlen < 2 || !this.search.ok) return;

    // The dictionary index at or after the query prefix.
    let lo: i32 = 0;
    let hi: i32 = <i32>this.search.termCount - 1;
    while (lo <= hi) {
      const mid: i32 = (lo + hi) >> 1;
      const cmp: i32 = compareTermToQuery(
        this.search.termPtr(<u32>mid), this.search.termLen(<u32>mid),
        q.bytes.dataStart, <u32>qlen);
      if (cmp < 0) lo = mid + 1;
      else hi = mid - 1;
    }

    let considered: i32 = 0;
    for (let t: i32 = lo; t < <i32>this.search.termCount && considered < 40; t++) {
      const termLen: u32 = this.search.termLen(<u32>t);
      if (!termHasPrefix(this.search.termPtr(<u32>t), termLen,
                          q.bytes.dataStart, <u32>qlen)) break;
      considered++;

      // A term that *is* the query is worth more than one that merely shares its
      // prefix: "load" should outrank "loader" for the query "load".
      const exactWeight: i32 = termLen == <u32>qlen ? 2 : 1;

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
        const tmp: i32 = ranked[i]; ranked[i] = ranked[best]; ranked[best] = tmp;
      }
    }

    const limit: i32 = ranked.length < 30 ? ranked.length : 30;
    for (let i: i32 = 0; i < limit; i++) {
      this.results.push(ranked[i]);
      this.resultScores.push(scores[ranked[i]]);
    }
  }
}

// ── entry point ─────────────────────────────────────────────────────────────

/** Fold an ASCII letter to lower case; every other byte is unchanged. */
function lowerAscii(c: u8): i32 {
  if (c >= 65 && c <= 90) return <i32>c + 32;
  return <i32>c;
}

const app = new App();

export function _start_game(): void {
  app.run();
}

// **No `_game_running` export, and no `__taskWake`.**
//
// The host refuses half an adoption: a guest with `_game_running` and no
// `__taskWake` asks the host to drive a loop the host then cannot resume a task in,
// and `main.rs` refuses that pairing before the first guest instruction rather than
// running a loop that silently does nothing.
//
// This viewer owns its loop the way `examples/2d/hello-sprites` does: `present`
// pumps the window's events, a closed window answers `-ECANCELED`, and the loop
// ends.
