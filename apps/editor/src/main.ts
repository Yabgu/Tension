// The editor: a guest app that edits a document and draws a game under its own UI.
//
// ## The shape, in one paragraph
//
// `Document` holds the scene, `History` makes every edit reversible, `Palette`
// names the edits, and this file is the part that turns a mouse and a keyboard
// into commands. It is drawn by the **retained widget tree** (`ui/layout.ts`),
// whose behaviors own every measure, arrange and paint, and it hosts the app loop
// in `AppShell`. The one thing that is not ordinary: the **game viewport** is a
// second `Scene` with its own pipeline and its own texture, drawn into canvas
// bucket 0 while the UI goes to bucket 1 — so one `present` composites a world
// under a chrome, which is the architecture the editor exists to prove.
//
// ## The frame, as a tree
//
//     root
//      └ column (flex 1)
//         ├ row   menu        File  Edit  View  Run  ……  last undo     32 px
//         ├ rule
//         ├ split (Axis.X)    ── the draggable divider ──
//         │  ├ column sidebar   (minW 320)   SCENE + a virtualised list
//         │  └ row    body      (flex 1)
//         │     ├ node   viewport  (flex 1)  bucket 0, its own pipeline
//         │     └ column inspector (minW 360)
//         ├ rule
//         ├ column console    (minH 240)
//         ├ rule
//         └ row   status      (minH 32)
//
// **There is no layout arithmetic left in this file.** Every `x`/`y`/`w`/`h` is
// decided by `WidgetBehavior.arrange`; every string is either a label's own buffer
// or the frame's `TextPool`; every click is a target the paint recorded. The three
// things the old version did by hand — `Rect`s, `px()` padding and a `Hits` array
// — are the framework's job now.
//
// ## Why no fills, still
//
// The renderer clears to opaque black and a full-window fill costs the whole
// 4,096-record budget (`ui/theme.ts`). So panels are **rules**, the viewport is a
// rectangle of rules, and the black is the background. The scene tree's selected
// row underlines; the inspector's labels are muted.
//
// ## What is not here
//
// Play mode, save and live reload. The document is edited in memory and the
// viewport draws procedurally generated boxes — no game asset is loaded, which is
// what keeps this about the composite rather than about an asset pipeline.

import {
  AppShell, Args, Axis, BOLD, Bytes, Canvas, ChangeTarget, Chrome, ClickTarget, Document,
  fontBook, FontBook, FONT_MONO, Frame, HEADING, History, LINK, ListBehavior, ListSource,
  loadFontBook, MUTED, NORMAL, Painter, Palette, print, REGULAR, registerEditorCommands,
  ROOT_ID, Scene, SetX, SIZE_14, Sprite, TextBuilder, TextPool, Ui, UiEvent, WidgetBehavior,
  WidgetTree,
} from "tension-framework";
import { DEFAULT_2D_BLOB } from "./graph.generated";

// ── the theme's numbers ─────────────────────────────────────────────────────
//
// Sizes that are *not* derived from type: a panel's width is a design decision, a
// bar's height is a line of type plus its air. Everything a line depends on — its
// pitch, its inset — comes from the page (`FontPage.lineStep`, `.pad`), because
// the point of the font pass is that one number cannot serve two sizes.

const SIDEBAR_W: i32 = 320;
const INSPECTOR_W: i32 = 360;
const CONSOLE_H: i32 = 240;
/** One panel's inset from its own edge. */
const PANEL_PAD: i32 = 10;
/** Air above and below a line of text in a bar. */
const BAR_PAD: i32 = 5;
/** A bar's height: one line of type plus its air. */
const BAR_H: i32 = 32;
/** The gap between two menu items. */
const ITEM_GAP: i32 = 14;
/** How many recycled row widgets the scene tree owns. */
const TREE_ROWS: i32 = 40;

/**
 * The game's world, and the field the boxes bounce in.
 *
 * **The world is deliberately larger than any panel**: a viewport that always
 * showed the whole world would never demonstrate a clip, and the camera would have
 * nothing to do. The boxes live in a smaller field inside it, so the camera can
 * frame them while boxes near the field's edge are cut by the viewport's edge —
 * which is the evidence that the clip is real.
 */
const WORLD_W: i32 = 1600;
const WORLD_H: i32 = 1200;
const FIELD_W: i32 = 900;
const FIELD_H: i32 = 560;

/** A box is one 32x32 cell of the procedural game atlas. */
const BOX: i32 = 32;
/** How many boxes the viewport animates. */
const BOXES: i32 = 6;

/** SDL scancodes, the same table the framework dispatches with. */
const SC_A: u32 = 4;
const SC_Y: u32 = 28;
const SC_Z: u32 = 29;
const SC_BACKSPACE: u32 = 42;
const SC_DELETE: u32 = 76;

// ── the viewport ────────────────────────────────────────────────────────────

/**
 * The game's rectangle, as a widget.
 *
 * This is the extension point the behavior architecture exists for, and it is the
 * smallest honest use of it: four methods, no engine knowledge. The widget **owns
 * its own rect** — `arrange` is handed the rectangle the row gave it and keeps it,
 * so the frame's camera and the scene's clip read the same numbers the UI drew at.
 * Before the tree, those numbers were recomputed by hand in two places from four
 * constants.
 *
 * The caption is built with a `TextBuilder` the behavior owns rather than with a
 * widget's text, because it is a *caption about this widget*, not content:
 * rebuilding it in `arrange` costs nothing and does not disturb the dirty flags of
 * a tree that has just finished laying out.
 */
class ViewportBehavior implements WidgetBehavior {
  x: i32 = 0;
  y: i32 = 0;
  w: i32 = 0;
  h: i32 = 0;
  private label: TextBuilder = new TextBuilder(64);

  measure(ui: Ui, id: i32): void {
    // Nothing intrinsic: the row's flex gives it the width that is left, and the
    // cross axis stretches. A self-measuring viewport would fight the split.
    ui.setSize(id, 0, 0);
    ui.applyFloors(id);
  }

  arrange(ui: Ui, id: i32, x: i32, y: i32, w: i32, h: i32): void {
    if (x == this.x && y == this.y && w == this.w && h == this.h) return;
    this.x = x;
    this.y = y;
    this.w = w;
    this.h = h;
    const b: TextBuilder = this.label;
    b.clear();
    b.str("viewport ");
    b.int(w);
    b.str("x");
    b.int(h);
    b.str("  world ");
    b.int(WORLD_W);
    b.str("x");
    b.int(WORLD_H);
  }

  paint(ui: Ui, id: i32, p: Painter): void {
    const page = ui.tree.page[id];
    const div: i32 = page.chromeCell(Chrome.Divider);
    // The frame — four rules, and the only place the viewport's edge is drawn.
    // The right-hand rule is also the line between the viewport and the inspector,
    // which is why the inspector draws none of its own.
    p.hline(this.x, this.y, this.w, div, page);
    p.hline(this.x, this.y + this.h - 1, this.w, div, page);
    p.vline(this.x, this.y, this.h, div, page);
    p.vline(this.x + this.w - 1, this.y, this.h, div, page);

    // **Clipped to the panel**: this text is longer than a narrow viewport, and
    // unclipped it drew straight over the inspector — the same bug the game
    // scene's own clip exists to prevent, in the UI layer. It is the framework's
    // clip now, not a hand-trimmed string.
    p.pushClip(this.x, this.y, this.w, this.h);
    p.textBytes(this.label.bytes, 0, this.label.len, this.x + PANEL_PAD, this.y + BAR_PAD,
                MUTED, REGULAR, 0, this.y, this.y + this.h, page);
    p.popClip();
  }

  handle(ui: Ui, id: i32, ev: UiEvent): bool {
    return false;
  }
}

// ── the scene tree ──────────────────────────────────────────────────────────

/**
 * The list's model: item `i` is the node at position `i` of the flattened tree.
 *
 * A `ListSource` writes into the frame's `TextPool` and never returns a `String`,
 * which is what makes filling forty rows during an arrange allocate nothing. The
 * indentation is *text*, not layout: the list has no opinion about hierarchy, and
 * a model that pushed rows around would be a second layout engine.
 */
class SceneModel extends ListSource {
  app: Editor;

  constructor(app: Editor) {
    super();
    this.app = app;
  }

  count(): i32 {
    return this.app.orderCount;
  }

  text(index: i32, out: TextPool): void {
    const depth: i32 = this.app.depthAt(index);
    // One space per level: the old tree spent 8 px per level, which at an 18 px
    // cell was under half a character. One mono space is the closest integer.
    for (let i: i32 = 0; i < depth; i++) out.str(" ");
    out.str(this.app.nameAt(index));
  }
}

/**
 * The list, plus a selection underline.
 *
 * `ListBehavior` already recycles rows, clips its own subtree and maps the wheel;
 * the only thing a scene tree adds is that the selected row is marked. Drawing it
 * from the *list's* own paint — rather than from the app, which no longer draws —
 * is what keeps the underline inside the list's clip and in step with the rows the
 * arrange just placed.
 */
class SceneTreeBehavior extends ListBehavior {
  /** The **item index** that is selected, or -1. */
  selected: i32 = -1;

  paint(ui: Ui, id: i32, p: Painter): void {
    if (this.selected < 0) return;
    const t: WidgetTree = ui.tree;
    let row: i32 = t.firstChild[id];
    while (row >= 0) {
      if (t.itemIndex[row] == this.selected) {
        const page = t.page[row];
        p.hline(t.x[row], t.y[row] + t.h[row] - 1, t.w[row],
                page.chromeCell(Chrome.White), page);
        return;
      }
      row = t.nextSibling[row];
    }
  }
}

// ── the handlers ────────────────────────────────────────────────────────────
//
// Handlers are objects with a method, not closures: a closure stored by the
// framework and called back from another module traps on this compiler
// (`docs/modules/ui.md` §14 has the measurement). A one-line class is the shape an
// app writes, and it is an ordinary object, so it may hold `this`.

/** A click on a row of the scene tree: `ui.lastItem` is the item that was hit. */
class SelectRow implements ClickTarget {
  app: Editor;

  constructor(app: Editor) {
    this.app = app;
  }

  click(): void {
    this.app.selectItem(this.app.ui.lastItem);
  }
}

/** The X field changed: apply what it holds, live, as one merged edit. */
class EditX implements ChangeTarget {
  app: Editor;

  constructor(app: Editor) {
    this.app = app;
  }

  change(value: i32): void {
    this.app.applyField();
  }
}

/** Return in the X field: apply, then normalise what the field shows. */
class SubmitX implements ClickTarget {
  app: Editor;

  constructor(app: Editor) {
    this.app = app;
  }

  click(): void {
    this.app.commitField();
  }
}

// ── the app ─────────────────────────────────────────────────────────────────

class Editor extends AppShell {
  // --- the document and its undo stack -----------------------------------
  doc: Document = Document.create(256);
  history: History = History.create(200);
  palette: Palette = Palette.create(this.history);

  // --- the tree ----------------------------------------------------------
  //
  // Built in the constructor, resized on every `onResize`. One `Ui` holds the
  // tree, the font book and the frame's hit list; the shell's `Painter` is what
  // the tree paints into.
  book: FontBook = fontBook();
  ui: Ui = new Ui(new WidgetTree(fontBook()));

  private main: i32 = -1;
  private sceneList: i32 = -1;
  private sceneTree: SceneTreeBehavior = new SceneTreeBehavior();
  private sceneModel: SceneModel = new SceneModel(this);
  private viewport: ViewportBehavior = new ViewportBehavior();

  private undoLabel: i32 = -1;
  private field: i32 = -1;
  private inspName: i32 = -1;
  private inspY: i32 = -1;
  private inspZ: i32 = -1;
  private inspFrame: i32 = -1;
  private inspParent: i32 = -1;
  private inspVisible: i32 = -1;
  private inspHint: i32 = -1;
  private consoleUndo: i32 = -1;
  private consoleLast: i32 = -1;
  private consoleKeys: i32 = -1;
  private statusLeft: i32 = -1;
  private statusRight: i32 = -1;

  // --- the flattened tree, for the list ----------------------------------
  //
  // A list addresses its rows by index and the document addresses its nodes by
  // id; these arrays are the map. Rebuilt only when the document's *shape*
  // changes — never per frame, and never by a `Document.ids()` call in a paint.
  orderIds: i32[] = new Array<i32>(256);
  private orderDepths: i32[] = new Array<i32>(256);
  orderCount: i32 = 0;
  private orderDirty: bool = true;
  private selectedIndex: i32 = -1;

  // --- the game viewport --------------------------------------------------
  gameScene: Scene = Scene.create(WORLD_W, WORLD_H, 64);
  gamePipe: i32 = -1;
  gameTexture: i32 = -1;
  private boxes: Sprite[] = [];
  private boxDx: f32[] = [];
  private boxDy: f32[] = [];
  private t: f32 = 0.0;

  // --- interaction --------------------------------------------------------
  /** The node the inspector is showing, and the document selected. */
  selected: i32 = ROOT_ID;
  /** Whether the field held focus last frame, for the blur commit. */
  private fieldWasFocused: bool = false;
  /** Whether the console's history lines need rebuilding. */
  private consoleDirty: bool = true;
  /** Frames drawn, for the status bar and a sanity check. */
  private drawn: i32 = 0;
  private lastUndo: string = "";
  private built: bool = false;

  constructor() {
    super("tension-editor", fontBook().pages[0], 240);
    this.build(1280, 720);
  }

  // ── the shell's hooks ───────────────────────────────────────────────────

  /**
   * Three pages of type, and two textures on two pipelines.
   *
   * The pages come out of the volume (`assets/ui.N.iwi`, baked from real outlines
   * by `npm run assets`) and `loadFontBook` uploads them as the layers of one
   * texture array — which is what lets a single record name its page. The game's
   * atlas is **generated here**, four solid colour cells, because this pass is
   * about the composite and not an asset pipeline. It is still a real texture at a
   * real, *different* size, which is the harder case: the renderer rebinds
   * `u_tex_size` per span.
   */
  protected loadAssets(canvas: Canvas, pipe: i32): bool {
    const bound: i32 = loadFontBook(canvas, pipe);
    if (bound != 0) {
      print("tension-editor: the UI pages did not load: " + bound.toString() +
        " (run `npm run assets`)");
      return false;
    }

    this.gamePipe = canvas.pipelineGraph(Bytes.ofArray(DEFAULT_2D_BLOB));
    if (this.gamePipe < 0) {
      print("tension-editor: the game pipeline refused: " + this.gamePipe.toString());
      return false;
    }
    this.gameTexture = canvas.loadTexture(gameAtlas());
    if (this.gameTexture <= 0) {
      print("tension-editor: the game atlas refused: " + this.gameTexture.toString());
      return false;
    }
    if (canvas.bindTexture(this.gamePipe, 0, this.gameTexture) != 0) {
      print("tension-editor: binding the game atlas refused");
      return false;
    }

    this.buildScene();
    print("tension-editor: ui pipe " + pipe.toString() + " / game pipe " +
      this.gamePipe.toString() + ", " + this.boxes.length.toString() + " boxes");
    return true;
  }

  /** The UI goes on top: bucket 1, above the game's 0. */
  protected get uiBucket(): i32 {
    return 1;
  }

  /**
   * A new window size: the root's rectangle, and nothing else.
   *
   * `WidgetTree.resize` marks the root for an arrange and stops there. No widget
   * is re-measured by a resize — that is the property the two passes exist for —
   * and the split re-clamps its divider out of its own `arrange`, so a window
   * narrowed past a pane's floor cannot leave the divider outside the frame.
   */
  protected onResize(width: i32, height: i32): void {
    this.ui.tree.resize(width, height);
  }

  // ── the tree, once ──────────────────────────────────────────────────────

  /**
   * Build the whole widget tree.
   *
   * Called once, from the constructor. Everything here is authoring: no measure,
   * no paint, no input. The sizes are the design's; the *type* is the page's, so a
   * bar's height is `BAR_H` (a line plus air) while a panel's inset is
   * `page.pad(...)`'s business.
   */
  private build(w: i32, h: i32): void {
    const ui: Ui = this.ui;
    const root: i32 = ui.root(w, h);
    const col: i32 = ui.column(root, { flex: 1 });

    // ── the menu bar ──────────────────────────────────────────────────────
    const menu: i32 = ui.row(col, { minH: BAR_H, pad: BAR_PAD, gap: ITEM_GAP });
    // Clipped to its own box: this is what replaces the old `fit()` helper. The
    // undo label can be longer than the window, and a clipped child is the same
    // answer as a truncated string with none of the arithmetic.
    ui.clips(menu);
    ui.label(menu, "File", { colour: MUTED });
    ui.label(menu, "Edit", { colour: MUTED });
    ui.label(menu, "View", { colour: MUTED });
    ui.label(menu, "Run", { colour: MUTED });
    ui.spacer(menu, 1);
    this.undoLabel = ui.label(menu, "", { colour: LINK });
    ui.rule(col);

    // ── the body: sidebar | viewport + inspector ─────────────────────────
    //
    // One split, because there is one divider the user drags. The inspector is a
    // *fixed* 360 inside the right-hand pane rather than a second pane, which is
    // the difference between "the split is the sidebar's edge" and "a resize
    // resets two dividers".
    const main: i32 = ui.split(col, Axis.X, { flex: 1 });
    this.main = main;
    ui.divider(main, SIDEBAR_W);

    const sidebar: i32 = ui.column(main, { minW: SIDEBAR_W, pad: PANEL_PAD, gap: 2 });
    ui.clips(sidebar);
    ui.label(sidebar, "SCENE", { colour: HEADING, weight: BOLD });
    this.sceneList = ui.list(sidebar, this.sceneModel, TREE_ROWS, { flex: 1 });
    // The list, drawn by a behavior that also marks the selection. `setBehavior`
    // is the extension point: everything `ui.list` set up (the recycled rows, the
    // clip, the scroll state) stays, and only the paint changes.
    ui.setBehavior(this.sceneList, this.sceneTree);
    // The tree's names are identifiers, so they are set in the mono face.
    this.setFont(this.sceneList, FONT_MONO, SIZE_14);

    const body: i32 = ui.row(main, { flex: 1 });
    const vp: i32 = ui.node(body, this.viewport, { flex: 1 });
    ui.flex(vp, 1);

    const inspector: i32 = ui.column(body, { minW: INSPECTOR_W, pad: PANEL_PAD, gap: 2 });
    ui.clips(inspector);
    ui.label(inspector, "INSPECTOR", { colour: HEADING, weight: BOLD });
    this.inspName = ui.label(inspector, "", { colour: HEADING, weight: BOLD });
    ui.rule(inspector);
    const fieldRow: i32 = ui.row(inspector, { gap: 12 });
    ui.label(fieldRow, "x", { colour: MUTED });
    this.field = ui.field(fieldRow, "", { minW: 140, pad: 2, flex: 1 });
    this.inspY = ui.label(inspector, "", { colour: MUTED });
    this.inspZ = ui.label(inspector, "", { colour: MUTED });
    this.inspFrame = ui.label(inspector, "", { colour: MUTED });
    this.inspParent = ui.label(inspector, "", { colour: MUTED });
    this.inspVisible = ui.label(inspector, "", { colour: MUTED });
    ui.rule(inspector);
    this.inspHint = ui.label(inspector, "", { colour: MUTED });
    ui.rule(col);

    // ── the console ───────────────────────────────────────────────────────
    const consoleCol: i32 = ui.column(col, { minH: CONSOLE_H, pad: PANEL_PAD, gap: 2 });
    ui.clips(consoleCol);
    ui.label(consoleCol, "CONSOLE", { colour: HEADING, weight: BOLD });
    this.consoleUndo = ui.label(consoleCol, "", { colour: MUTED });
    this.consoleLast = ui.label(consoleCol, "", { colour: MUTED });
    this.consoleKeys = ui.label(consoleCol, "", { colour: MUTED });
    // Code is monospaced: the console's columns were aligned in the old build and a
    // proportional face would undo that silently.
    ui.font(this.consoleUndo, FONT_MONO, SIZE_14);
    ui.font(this.consoleLast, FONT_MONO, SIZE_14);
    ui.font(this.consoleKeys, FONT_MONO, SIZE_14);
    ui.rule(col);

    // ── the status bar ────────────────────────────────────────────────────
    const status: i32 = ui.row(col, { minH: BAR_H, pad: BAR_PAD, gap: 12 });
    ui.clips(status);
    this.statusLeft = ui.label(status, "", { colour: MUTED });
    ui.spacer(status, 1);
    this.statusRight = ui.label(status, "", { colour: MUTED });

    // ── the bindings ──────────────────────────────────────────────────────
    //
    // A click on a *row* bubbles to the list, because a label consumes nothing and
    // a list is where its rows' clicks belong. `ui.onClick` on the list is
    // therefore "a row was clicked", and `ui.lastItem` says which one.
    ui.onClick(this.sceneList, new SelectRow(this));
    ui.onChange(this.field, new EditX(this));
    ui.onSubmit(this.field, new SubmitX(this));

    this.syncOrder();
    this.syncConsole();
  }

  /** Give a list (and the rows it will recycle) one page. */
  private setFont(list: i32, family: i32, size: i32): void {
    const t: WidgetTree = this.ui.tree;
    this.ui.font(list, family, size);
    let row: i32 = t.firstChild[list];
    while (row >= 0) {
      this.ui.font(row, family, size);
      row = t.nextSibling[row];
    }
  }

  // ── setup ───────────────────────────────────────────────────────────────

  /**
   * The document's opening scene, and the game's boxes — **once**.
   *
   * `loadAssets` runs at startup *and* after every canvas rebuild, because a canvas
   * is fixed for its lifetime and reopening one destroys its textures. The flag is
   * the fix, and the duplication is the reason it is a flag.
   */
  private buildScene(): void {
    if (this.built) return;
    this.built = true;
    this.palette = registerEditorCommands(Palette.create(this.history));

    const world = this.doc.node(ROOT_ID);
    world.name = "World";
    this.spawn("room", ROOT_ID, 40.0, 60.0);
    this.spawn("hero", ROOT_ID, 300.0, 240.0);
    this.spawn("lantern", ROOT_ID, 620.0, 120.0);
    this.spawn("crate", ROOT_ID, 760.0, 420.0);
    this.history.clear();
    this.selected = ROOT_ID;
    this.doc.select(ROOT_ID, true);
    this.orderDirty = true;

    const cells: Frame[] = [
      new Frame(0, <u16>0, <u16>0, <u16>BOX, <u16>BOX),
      new Frame(0, <u16>BOX, <u16>0, <u16>BOX, <u16>BOX),
      new Frame(0, <u16>(BOX * 2), <u16>0, <u16>BOX, <u16>BOX),
      new Frame(0, <u16>(BOX * 3), <u16>0, <u16>BOX, <u16>BOX),
    ];
    const startX: i32[] = [80, 300, 520, 700, 180, 620];
    const startY: i32[] = [120, 380, 200, 480, 460, 60];
    for (let i: i32 = 0; i < BOXES; i++) {
      const sprite = this.gameScene.spawn(cells[i % 4]);
      sprite.moveTo(<f32>startX[i], <f32>startY[i]);
      this.boxes.push(sprite);
      this.boxDx.push(i % 2 == 0 ? 1.5 : -1.5);
      this.boxDy.push(i % 3 == 0 ? 1.0 : -1.0);
    }
  }

  private spawn(name: string, parent: i32, x: f32, y: f32): void {
    const args = new Args();
    args.id = 0;
    args.parent = parent;
    args.text = name;
    this.palette.run(this.doc, "node.add", args);
    const ids = this.doc.ids();
    const created = ids[ids.length - 1];
    this.doc.setX(created, x);
    this.doc.setY(created, y);
  }

  // ── the frame ───────────────────────────────────────────────────────────

  /** Animate the boxes, dispatch input, then run the shortcuts. */
  protected update(): void {
    this.t += 1.0;
    for (let i: i32 = 0; i < this.boxes.length; i++) {
      const b = this.boxes[i];
      let x: f32 = b.x + this.boxDx[i];
      let y: f32 = b.y + this.boxDy[i];
      if (x < 0.0) { x = 0.0; this.boxDx[i] = -this.boxDx[i]; }
      if (x > <f32>(FIELD_W - BOX)) { x = <f32>(FIELD_W - BOX); this.boxDx[i] = -this.boxDx[i]; }
      if (y < 0.0) { y = 0.0; this.boxDy[i] = -this.boxDy[i]; }
      if (y > <f32>(FIELD_H - BOX)) { y = <f32>(FIELD_H - BOX); this.boxDy[i] = -this.boxDy[i]; }
      b.moveTo(x, y);
    }

    // **One dispatch per frame**, and `readText` inside it is the frame's only read
    // of the typed stream — the queue has one consumer or it has two.
    if (this.inputReady && this.input.read()) {
      this.ui.frame(this.input);
    } else {
      this.ui.frame(null);
    }

    this.commitOnBlur();
    // A focused field owns the keyboard, so the commands stand down: a Backspace
    // meant for a number is not a request to delete a node.
    if (this.ui.focusId < 0) this.shortcuts();
  }

  /** One frame: layout, the game into bucket 0, the tree into bucket 1. */
  protected draw(p: Painter): void {
    this.drawn++;
    this.syncOrder();
    this.syncConsole();
    this.updateStatus();
    this.ui.tree.layout();
    this.styleRows();

    // Frame the boxes and clip the scene to the viewport the *arrange* just gave
    // it. The tree is laid out first because the rect is its answer, not ours.
    const vp = this.viewport;
    if (vp.w > 0 && vp.h > 0) {
      this.cameraToBoxes(vp);
      this.gameScene.setViewport(vp.x, vp.y, vp.w, vp.h);
      const committed = this.gameScene.commit(this.canvas!, this.gamePipe, 0);
      if (committed < 0) {
        print("tension-editor: the game scene refused: " + committed.toString());
      }
    }

    this.ui.tree.paint(p, this.ui.hits);
  }

  /**
   * Frame the first box, clamped to the world.
   *
   * A real editor tracks the selection; pointing the camera at the scene tree's
   * selection is the obvious next step and not this pass's.
   */
  private cameraToBoxes(vp: ViewportBehavior): void {
    if (this.boxes.length == 0) return;
    const lead = this.boxes[0];
    const cx: f32 = lead.x + <f32>BOX * 0.5 - <f32>vp.w * 0.5;
    const cy: f32 = lead.y + <f32>BOX * 0.5 - <f32>vp.h * 0.5;
    const maxX: f32 = <f32>(WORLD_W - vp.w);
    const maxY: f32 = <f32>(WORLD_H - vp.h);
    this.gameScene.setCamera(clamp(cx, 0.0, maxX > 0.0 ? maxX : 0.0),
                             clamp(cy, 0.0, maxY > 0.0 ? maxY : 0.0));
  }

  // ── the status bar ──────────────────────────────────────────────────────

  /**
   * The status bar, from the frame's text pool.
   *
   * Composed with `TextPool` because it changes every frame: the record count and
   * the frame number are the two numbers a UI must not turn into a `String` sixty
   * times a second. `ui.textPool` copies the window into the label's own buffer, so
   * the pool can be rewound immediately afterwards.
   */
  private updateStatus(): void {
    const pool: TextPool = this.ui.pool;
    pool.begin();
    pool.int(this.doc.liveCount);
    pool.str(" nodes   ");
    pool.int(this.doc.selectionCount);
    pool.str(" selected   ");
    pool.int(this.lastRecords);
    pool.str(" ui rec");
    if (this.lastDropped > 0) {
      pool.str("  ");
      pool.int(this.lastDropped);
      pool.str(" dropped");
    }
    this.ui.textPool(this.statusLeft);

    pool.begin();
    pool.str("frame ");
    pool.int(this.drawn);
    pool.str("   game ");
    pool.int(this.gameScene.aliveCount());
    pool.str(" boxes");
    this.ui.textPool(this.statusRight);
  }

  /** The console's three history lines, rebuilt only when the history moved. */
  private syncConsole(): void {
    if (!this.consoleDirty) return;
    this.consoleDirty = false;
    this.ui.text(this.consoleUndo, "undo: " + this.history.undoCount.toString() +
      "   redo: " + this.history.redoCount.toString());
    const reachable: string = this.history.canUndo ? this.history.undoLabel()
      : (this.history.canRedo ? "redo " + this.history.redoLabel() : "(nothing)");
    this.ui.text(this.consoleLast, "last: " + reachable);
    this.ui.text(this.consoleKeys,
      "keys: ctrl+z undo   ctrl+y redo   ctrl+a add   del remove");
  }

  // ── the scene tree's model ──────────────────────────────────────────────

  /**
   * Flatten the document, rebuild the list, and re-point the selection.
   *
   * `orderDirty` is set by every edit that changes the tree's *shape* — add,
   * remove, undo, redo — and never by a frame. `Document.ids()` allocates, and a
   * paint is not where that belongs.
   */
  private syncOrder(): void {
    if (!this.orderDirty) return;
    this.orderDirty = false;
    const ids = this.doc.ids();
    this.orderCount = ids.length;
    for (let i: i32 = 0; i < ids.length; i++) {
      this.orderIds[i] = ids[i];
      this.orderDepths[i] = this.depthOf(ids[i]);
    }
    this.selectedIndex = -1;
    for (let i: i32 = 0; i < this.orderCount; i++) {
      if (this.orderIds[i] == this.selected) this.selectedIndex = i;
    }
    this.sceneTree.selected = this.selectedIndex;
    this.ui.items(this.sceneList, this.orderCount);
    this.ui.refresh(this.sceneList);
    this.syncInspector();
  }

  depthAt(index: i32): i32 {
    return index >= 0 && index < this.orderCount ? this.orderDepths[index] : 0;
  }

  nameAt(index: i32): string {
    return index >= 0 && index < this.orderCount
      ? this.doc.nameOf(this.orderIds[index]) : "";
  }

  /**
   * Colour the rows: the selected one is white and bold, the rest body text.
   *
   * Done after the arrange, because a row's *item* is what the arrange decides — a
   * recycled row was showing some other node a frame ago. A row whose item did not
   * change is not touched, so this walks forty widgets and writes nothing on a
   * frame where the selection held still.
   */
  private styleRows(): void {
    const t: WidgetTree = this.ui.tree;
    let row: i32 = t.firstChild[this.sceneList];
    while (row >= 0) {
      const selected: bool = t.itemIndex[row] >= 0 && t.itemIndex[row] == this.selectedIndex;
      // White for the selected row because `(NORMAL, BOLD)` is not a baked pair —
      // an unbaked pair is a missing stripe, and its glyphs are skipped outright.
      const colour: i32 = selected ? HEADING : NORMAL;
      const weight: i32 = selected ? BOLD : REGULAR;
      if (t.colour[row] != colour || t.weight[row] != weight) {
        t.colour[row] = colour;
        t.weight[row] = weight;
        t.markPaint(row);
      }
      row = t.nextSibling[row];
    }
  }

  /** Select the row a click landed on, commit what the field held, and tell the doc. */
  selectItem(index: i32): void {
    if (index < 0 || index >= this.orderCount) return;
    const id: i32 = this.orderIds[index];
    if (id == this.selected) return;
    // The field belonged to the *old* node, so it commits before the selection
    // moves — otherwise leaving the field by clicking a row would write the old
    // text onto the new node's X.
    if (this.fieldWasFocused) this.commitField();
    this.selected = id;
    this.selectedIndex = index;
    this.sceneTree.selected = index;
    this.doc.clearSelection();
    this.doc.select(id, true);
    this.syncInspector();
  }

  // ── the inspector ───────────────────────────────────────────────────────

  /** Re-read the selected node into the inspector's labels and its field. */
  private syncInspector(): void {
    const id: i32 = this.selected;
    if (!this.doc.alive(id)) {
      this.ui.text(this.inspName, "");
      this.ui.text(this.inspY, "");
      this.ui.text(this.inspZ, "");
      this.ui.text(this.inspFrame, "");
      this.ui.text(this.inspParent, "");
      this.ui.text(this.inspVisible, "");
      this.ui.text(this.field, "");
      this.ui.text(this.inspHint, "nothing selected");
      return;
    }
    const node = this.doc.node(id);
    this.ui.text(this.inspName, "node " + id.toString() + "  " + node.name);
    this.ui.text(this.inspY, "y " + node.y.toString());
    this.ui.text(this.inspZ, "z " + node.z.toString());
    this.ui.text(this.inspFrame, "frame " + node.frame.toString());
    this.ui.text(this.inspParent, "parent " + node.parent.toString());
    this.ui.text(this.inspVisible, "visible " + (node.visible ? "yes" : "no"));
    // The field shows the canonical value whenever the selection moves. While a
    // user types, `applyField` keeps the document in step and nothing re-reads the
    // value back into the field — a field that rewrites itself under the caret is a
    // field that moves the caret.
    this.ui.text(this.field, node.x.toString());
    this.ui.text(this.inspHint, "click x to edit");
  }

  // ── editing ─────────────────────────────────────────────────────────────

  /**
   * Apply what the field holds, live, as one undoable edit.
   *
   * `SetX.merge` collapses a burst of same-node edits, so a typed `12.5` is one
   * history entry whose `before` is the value from before the first keystroke —
   * which is what a drag does, and why `merge` exists at all.
   */
  applyField(): void {
    const id: i32 = this.selected;
    if (!this.doc.alive(id)) return;
    const text: string = this.ui.textOf(this.field);
    if (!looksNumeric(text)) return;
    const value: f32 = <f32>parseDecimal(text);
    if (value == this.doc.xOf(id)) return;
    this.history.exec(this.doc, new SetX(id, value));
    this.afterEdit("set x");
  }

  /** Return, or leaving the field: apply, then show what the document holds. */
  commitField(): void {
    this.applyField();
    const id: i32 = this.selected;
    if (this.doc.alive(id)) this.ui.text(this.field, this.doc.node(id).x.toString());
  }

  /**
   * A focus loss commits.
   *
   * The edge is tracked here rather than in a handler because focus lives in the
   * dispatcher: there is no "blur" event to bind, and inventing one for this app
   * would be a second source of truth about who holds the keyboard.
   */
  private commitOnBlur(): void {
    const now: bool = this.ui.isFocused(this.field);
    if (this.fieldWasFocused && !now) this.commitField();
    this.fieldWasFocused = now;
  }

  /** What the menu and the console report after an edit. */
  private afterEdit(what: string): void {
    this.lastUndo = what + ": " + (this.history.canUndo ? this.history.undoLabel() : "");
    this.ui.text(this.undoLabel, this.lastUndo);
    this.consoleDirty = true;
  }

  // ── the keyboard ────────────────────────────────────────────────────────

  /**
   * The shortcuts, from the raw snapshot.
   *
   * They are deliberately not widget events: `ctrl+z` is not addressed to the scene
   * tree or to the inspector, it is addressed to the *application*. The framework
   * dispatches keys to the focused widget, which is the right rule for a field and
   * the wrong one for a command, so the commands read the snapshot here.
   */
  private shortcuts(): void {
    const state = this.input;
    if (state.ctrl && state.pressed(SC_Z)) {
      if (this.history.undo(this.doc)) this.afterEdit("undo");
      this.syncSelection();
      return;
    }
    if (state.ctrl && state.pressed(SC_Y)) {
      if (this.history.redo(this.doc)) this.afterEdit("redo");
      this.syncSelection();
      return;
    }
    if (state.ctrl && state.pressed(SC_A)) {
      const args = new Args();
      args.parent = this.selected >= 0 ? this.selected : ROOT_ID;
      args.text = "node";
      if (this.palette.run(this.doc, "node.add", args)) {
        this.selected = this.lastId();
        this.orderDirty = true;
        this.afterEdit("add");
      }
      return;
    }
    if (state.pressed(SC_DELETE) || state.pressed(SC_BACKSPACE)) {
      if (this.selected != ROOT_ID) {
        const args = Args.forNode(this.selected);
        if (this.palette.run(this.doc, "node.remove", args)) {
          this.selected = ROOT_ID;
          this.orderDirty = true;
          this.afterEdit("remove");
        }
      }
    }
  }

  /** After an undo, the selected id may be gone; fall back to the root. */
  private syncSelection(): void {
    if (!this.doc.alive(this.selected)) this.selected = ROOT_ID;
    if (this.selected != ROOT_ID) {
      this.doc.clearSelection();
      this.doc.select(this.selected, true);
    }
    this.orderDirty = true;
    this.syncOrder();
  }

  private lastId(): i32 {
    const ids = this.doc.ids();
    return ids.length > 0 ? ids[ids.length - 1] : ROOT_ID;
  }

  /** How deep `id` sits: the root is 0, its children 1. */
  private depthOf(id: i32): i32 {
    let depth: i32 = 0;
    let walk: i32 = this.doc.parentOf(id);
    let guard: i32 = 0;
    while (walk != -1 && guard < 64) {
      depth++;
      walk = this.doc.parentOf(walk);
      guard++;
    }
    return depth;
  }
}

// ── small functions ─────────────────────────────────────────────────────────

/**
 * Whether a field's text is a number this app will apply.
 *
 * A field whose text is `-` or `.` is *mid-typing*, not a value: applying it as 0
 * would jump the node to the origin between two keystrokes. `parseDecimal` answers
 * 0 for anything it cannot read, so the caller must be able to tell "zero" from
 * "not a number" — which is this.
 */
function looksNumeric(text: string): bool {
  let i: i32 = 0;
  if (text.length > 0 && text.charCodeAt(0) == 45) i = 1;   // '-'
  if (i >= text.length) return false;
  let digits: i32 = 0;
  let points: i32 = 0;
  while (i < text.length) {
    const c: i32 = text.charCodeAt(i);
    if (c == 46) {                                          // '.'
      points++;
      if (points > 1) return false;
    } else if (c >= 48 && c <= 57) {
      digits++;
    } else {
      return false;
    }
    i++;
  }
  return digits > 0;
}

function clamp(v: f32, lo: f32, hi: f32): f32 {
  if (v < lo) return lo;
  if (v > hi) return hi;
  return v;
}

/**
 * A decimal from the field's text — `-12`, `3.5`, `.5`.
 *
 * Hand-rolled because `parseFloat` is not in this runtime's standard library
 * surface; `looksNumeric` is what decides whether the answer may be applied.
 */
function parseDecimal(text: string): f64 {
  let sign: f64 = 1.0;
  let i: i32 = 0;
  if (text.length > 0 && text.charCodeAt(0) == 45) {
    sign = -1.0;
    i = 1;
  }
  let whole: f64 = 0.0;
  let frac: f64 = 0.0;
  let scale: f64 = 1.0;
  let seen: bool = false;
  while (i < text.length) {
    const c: i32 = text.charCodeAt(i);
    if (c == 46) {
      i++;
      break;
    }
    if (c < 48 || c > 57) return 0.0;
    whole = whole * 10.0 + <f64>(c - 48);
    seen = true;
    i++;
  }
  while (i < text.length) {
    const c: i32 = text.charCodeAt(i);
    if (c < 48 || c > 57) return 0.0;
    scale *= 10.0;
    frac += <f64>(c - 48) / scale;
    seen = true;
    i++;
  }
  return seen ? sign * (whole + frac) : 0.0;
}

// ── the game atlas ──────────────────────────────────────────────────────────

/**
 * Four solid cells, 128x32, as an IWI1 container.
 *
 * Deliberately *generated*: this pass proves a composite, and adding an asset
 * pipeline to it would make a failure ambiguous between the two. The size is not
 * arbitrary — 128x32 against the UI pages means the renderer has to rebind
 * `u_tex_size` between spans, which two same-sized atlases would not test.
 */
function gameAtlas(): Bytes {
  const W: i32 = 128;
  const H: i32 = 32;
  const pixels: i32 = W * H * 4;
  const image = Bytes.allocate(74 + pixels);
  image.fill(0);

  image.setByteAt(0, 0x49); // I
  image.setByteAt(1, 0x57); // W
  image.setByteAt(2, 0x49); // I
  image.setByteAt(3, 0x31); // 1
  image.setU32(4, <u32>W);
  image.setU32(8, <u32>H);
  image.setByteAt(12, 0);              // sRGB
  image.setU16(13, 4);                 // RGBA
  image.setU16(15, 32);                // 32 bpp
  image.setByteAt(17, 0);              // interleaved
  for (let i: i32 = 0; i < 4; i++) {
    const at = 18 + i * 6;
    image.setByteAt(at + 0, <u8>(i + 1)); // semantic: R, G, B, A
    image.setByteAt(at + 1, 2);           // UNORM
    image.setU16(at + 2, <u16>(i * 8));
    image.setU16(at + 4, 8);
  }
  image.setU64(66, <u64>pixels);

  // Four cells, one colour each, opaque. **Little-endian, so the word is
  // `A<<24 | B<<16 | G<<8 | R`.** Writing the RGB triple as if it were a
  // big-endian word is the mistake that shipped first: the boxes came out
  // purple, olive and magenta, which looks like a pipeline bug and is an
  // endianness one.
  const colors: i32[] = [0xE6, 0x2D, 0x37, 0x28, 0x73, 0xEB, 0x23, 0xBE, 0x55, 0xE0, 0xA0, 0x20];
  const words: u32[] = new Array<u32>(4);
  for (let c: i32 = 0; c < 4; c++) {
    const r: u32 = <u32>colors[c * 3 + 0];
    const g: u32 = <u32>colors[c * 3 + 1];
    const b: u32 = <u32>colors[c * 3 + 2];
    words[c] = (<u32>0xFF << 24) | (b << 16) | (g << 8) | r;
  }
  let px32 = changetype<@unmanaged [u32 *]>(image.address() + 74);
  for (let cell: i32 = 0; cell < 4; cell++) {
    const base: i32 = cell * 32;
    for (let y: i32 = 0; y < 32; y++) {
      const row: i32 = (y * W + base);
      for (let x: i32 = 0; x < 32; x++) {
        px32[row + x] = words[cell];
      }
    }
  }
  return image;
}

// ── entry point ─────────────────────────────────────────────────────────────

const app = new Editor();

export function _start_game(): void {
  app.run();
}

// No `_game_running` and no `__taskWake`: this guest owns its loop through
// `AppShell`, the way `apps/docs` does. The shell asks
// `platform.windowInfo().closeRequested` every frame, which is the check the
// `window-close` suite looks for in the source that presents.
