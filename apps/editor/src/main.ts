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
//         ├ row   menu        File Edit View Run … Play Stop Restart … undo   34 px
//         ├ rule
//         ├ split (Axis.X)    ── the draggable divider ──
//         │  ├ column sidebar   (minW 320)   SCENE + a virtualised list
//         │  └ row    body      (flex 1)
//         │     ├ node   viewport  (flex 1)  bucket 0, its own pipeline
//         │     └ column inspector (minW 360)   x / y / z + read-only rows
//         ├ rule
//         ├ column console    (minH 240)
//         ├ rule
//         └ row   status      (minH 34)
//
// A **dropdown** is the one thing outside the tree: `drawMenu` paints it after
// `tree.paint`, into the same hit list, so it is above every panel and its rows
// win the hit test. The tree has no absolute positioning or z-order yet, and a
// popup is exactly the widget that needs both — see `drawMenu` for why an overlay
// is the honest way to do this today.
//
// **There is no layout arithmetic left in this file.** Every `x`/`y`/`w`/`h` is
// decided by `WidgetBehavior.arrange`; every string is either a label's own buffer
// or the frame's `TextPool`; every click is a target the paint recorded.
//
// ## Why no fills, still
//
// The renderer clears to opaque black and a full-window fill costs the whole
// 4,096-record budget (`ui/theme.ts`). So panels are **rules**, the viewport is a
// rectangle of rules, and the black is the background. Play mode therefore *hides*
// chrome rather than dimming it: a scrim would be ~5,000 records.
//
// ## What is not here
//
// A true Play mode (a second guest process; the buttons toggle this one's chrome
// and the scene keeps running), live reload, and asset loading. The viewport draws
// procedurally generated boxes.

import {
  ALIGN_CENTER, AppShell, Args, Axis, BOLD, Bytes, Canvas, ChangeTarget, Chrome, ClickTarget,
  Document, fontBook, FontBook, FONT_MONO, Frame, HEADING, History, JsonError, LINK,
  ListBehavior, ListSource, loadFontBook, MUTED, NORMAL, Painter, Palette, print, PropKind,
  REGULAR, registerEditorCommands, resWriteFile, ROOT_ID, Scene, SetProperty,
  SIZE_14, Sprite, State, TextBuffer, TextBuilder, TextPool, Ui, UiEvent, UiEventKind,
  WidgetBehavior, WidgetTree,
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
const BAR_PAD: i32 = 4;
/**
 * A bar's height.
 *
 * `lineStep` (21) plus two of air would be 29; the bars hold buttons, and a button
 * is `lineStep + 2*3` = 27 tall. 34 leaves a button three pixels of room to sit in.
 */
const BAR_H: i32 = 34;
/** The gap between two menu-bar items. */
const ITEM_GAP: i32 = 10;
/** How many recycled row widgets the scene tree owns. */
const TREE_ROWS: i32 = 40;

/** A dropdown's metrics, in pixels. */
const MENU_ITEM_H: i32 = 31;
const MENU_PAD: i32 = 3;
const MENU_PAD_X: i32 = 12;
/** The gap between a label and its shortcut column. */
const MENU_GAP: i32 = 28;

/**
 * The hit-id space a dropdown item occupies.
 *
 * **Negative, and that is load-bearing.** A hit id is handed to the dispatcher as
 * a slot, and `Dispatcher.press` reads `itemIndex[slot]` for a non-negative slot —
 * so a large positive sentinel would index past the pool and trap. A negative one
 * is what the dispatcher already treats as "no widget": it blurs the focus and
 * leaves the event alone, which is exactly what an overlay wants.
 */
const MENU_HIT_BASE: i32 = -1000;

/** The scene's modes. `Edit` is the editor; `Play` is the same frame without chrome. */
const enum Mode {
  Edit = 0,
  Play = 1,
}

/**
 * What a menu row (or a toolbar button) does.
 *
 * An enum and a `switch`, not a closure: the compiler this targets cannot call a
 * stored closure back across a module boundary (`docs/modules/ui.md` §14). A
 * handler target object is the other spelling, and it is what the *widgets* use —
 * the menu rows live in an overlay, which has no slots to bind targets to.
 */
const enum Act {
  None = 0,
  Save = 1,
  Revert = 2,
  Exit = 3,
  Undo = 4,
  Redo = 5,
  AddNode = 6,
  DeleteNode = 7,
  ToggleConsole = 8,
  ToggleInspector = 9,
  Play = 10,
  Stop = 11,
  Restart = 12,
}

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
const SC_S: u32 = 22;
const SC_Y: u32 = 28;
const SC_Z: u32 = 29;
const SC_ESCAPE: u32 = 41;
const SC_DELETE: u32 = 76;

// ── the menus ───────────────────────────────────────────────────────────────

/**
 * One dropdown row.
 *
 * The label and the shortcut are `TextBuffer`s, not strings: the menu is painted
 * every frame it is open, and `String.UTF8.encode` allocates. They are written
 * once, when the menu is built.
 */
class MenuItem {
  label: string;
  shortcut: string;
  act: i32;
  text: TextBuffer;
  short: TextBuffer;
  labelW: i32 = 0;
  shortW: i32 = 0;
  /** The id this row records, and the id `Hits.at` answers for it. */
  hitId: i32 = 0;

  constructor(label: string, shortcut: string, act: i32) {
    this.label = label;
    this.shortcut = shortcut;
    this.act = act;
    const t = new TextBuffer(32);
    t.set(label);
    const s = new TextBuffer(16);
    s.set(shortcut);
    this.text = t;
    this.short = s;
  }
}

/** One menu: a title in the bar and the rows under it. */
class MenuDef {
  title: string;
  /** The title's UTF-8, written once: the bar is painted every frame. */
  titleBytes: TextBuffer;
  items: MenuItem[] = new Array<MenuItem>();
  /** The menu-bar button's slot, filled once the tree is built. */
  button: i32 = -1;
  titleW: i32 = 0;

  constructor(title: string) {
    this.title = title;
    const t = new TextBuffer(16);
    t.set(title);
    this.titleBytes = t;
  }

  add(label: string, shortcut: string, act: i32): MenuItem {
    const item = new MenuItem(label, shortcut, act);
    this.items.push(item);
    return item;
  }
}

// ── the viewport ────────────────────────────────────────────────────────────

/**
 * The game's rectangle, as a widget.
 *
 * This is the extension point the behavior architecture exists for, and it is the
 * smallest honest use of it: four methods, no engine knowledge. The widget **owns
 * its own rect** — `arrange` is handed the rectangle the row gave it and keeps it,
 * so the frame's camera and the scene's clip read the same numbers the UI drew at.
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
  /** `Mode.Play` draws the banner; `Mode.Edit` draws the caption alone. */
  mode: i32 = Mode.Edit;
  private label: TextBuilder = new TextBuilder(64);
  /** "PLAYING …" as UTF-8, encoded once. A banner per frame would allocate. */
  private banner: Uint8Array = new Uint8Array(64);
  private bannerLen: i32 = 0;

  constructor() {
    const text: string = "PLAYING - Stop returns to the editor";
    this.bannerLen = <i32>String.UTF8.encodeUnsafe(changetype<usize>(text), text.length,
                                                  this.banner.dataStart);
  }

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

    if (this.mode == Mode.Play) {
      // The banner is a band of `Surface` plus one bright line. Not a scrim: a
      // full-panel fill is ~1,500 records and the frame's budget is 4,096 for
      // everything (`ui/theme.ts`), so the honest way to say "playing" is to say
      // it, not to darken the world behind it.
      const bandH: i32 = page.lineStep + 2 * 6;
      p.fill(this.x + 1, this.y + 1, this.w - 2, bandH, page.chromeCell(Chrome.Surface), page);
      p.textBytes(this.banner, 0, this.bannerLen, this.x + PANEL_PAD, this.y + 7,
                  HEADING, BOLD, 0, this.y + 1, this.y + 1 + bandH, page);
    }

    // **Clipped to the panel**: this text is longer than a narrow viewport, and
    // unclipped it drew straight over the inspector — the same bug the game
    // scene's own clip exists to prevent, in the UI layer. It is the framework's
    // clip now, not a hand-trimmed string.
    p.pushClip(this.x, this.y, this.w, this.h);
    p.textBytes(this.label.bytes, 0, this.label.len, this.x + PANEL_PAD,
                this.y + this.h - page.lineStep - 4, MUTED, REGULAR, 0,
                this.y, this.y + this.h, page);
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
 * from the *list's* own paint — rather than from the app, which does not draw —
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

// ── the menu-bar button ─────────────────────────────────────────────────────

/**
 * A menu's title in the bar: text that behaves like a button.
 *
 * A `Button` was the other option and it is the wrong shape here — a filled box per
 * menu reads as a toolbar of four buttons, not as a menu bar. So this is a custom
 * behavior: it measures like a label, paints a `Surface` behind itself while it is
 * open or hovered, and opens its menu on a press. That is the whole of what the
 * open extension point is for, and it is nine lines of drawing.
 */
class MenuButtonBehavior implements WidgetBehavior {
  app: Editor;
  menu: i32 = 0;

  constructor(app: Editor, menu: i32) {
    this.app = app;
    this.menu = menu;
  }

  measure(ui: Ui, id: i32): void {
    const t: WidgetTree = ui.tree;
    const page = t.page[id];
    const w: i32 = ui.book.measureText(page, REGULAR, this.app.menus[this.menu].title) +
      2 * t.pad[id];
    ui.setSize(id, w, page.lineStep + 2 * t.pad[id]);
    ui.applyFloors(id);
  }

  arrange(ui: Ui, id: i32, x: i32, y: i32, w: i32, h: i32): void {}

  paint(ui: Ui, id: i32, p: Painter): void {
    const t: WidgetTree = ui.tree;
    const page = t.page[id];
    const x: i32 = t.x[id];
    const y: i32 = t.y[id];
    const w: i32 = t.w[id];
    const h: i32 = t.h[id];
    const open: bool = this.app.openMenu == this.menu;
    const hovered: bool = (t.state[id] & State.Hover) != 0;
    if (open || hovered) p.fill(x, y, w, h, page.chromeCell(Chrome.Surface), page);
    if (open) p.hline(x, y + h - 1, w, page.chromeCell(Chrome.White), page);
    const tw: i32 = ui.book.measureText(page, REGULAR, this.app.menus[this.menu].title);
    p.textBytes(this.app.menus[this.menu].titleBytes.bytes, 0,
                this.app.menus[this.menu].titleBytes.len,
                x + (w - tw) / 2, y + (h - page.lineStep) / 2,
                open ? HEADING : NORMAL, REGULAR, 0, y, y + h, page);
    p.addHit(x, y, w, h, t.id[id], id);
  }

  handle(ui: Ui, id: i32, ev: UiEvent): bool {
    if (ev.kind == UiEventKind.Click) {
      this.app.toggleMenu(this.menu);
      return true;
    }
    return false;
  }
}

// ── the handlers ────────────────────────────────────────────────────────────
//
// Handlers are objects with a method, not closures: a closure stored by the
// framework and called back from another module traps on this compiler
// (`docs/modules/ui.md` §14). A one-line class is the shape an app writes.

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

/** A property field changed: apply it, live, as one merged edit. */
class PropertyEdit implements ChangeTarget {
  app: Editor;
  kind: i32;

  constructor(app: Editor, kind: i32) {
    this.app = app;
    this.kind = kind;
  }

  change(value: i32): void {
    this.app.applyField(this.kind);
  }
}

/** Return in a property field: apply, then show the canonical value. */
class PropertySubmit implements ClickTarget {
  app: Editor;
  kind: i32;

  constructor(app: Editor, kind: i32) {
    this.app = app;
    this.kind = kind;
  }

  click(): void {
    this.app.commitField(this.kind);
  }
}

/** A click on the caption beside a field: focus that field. */
class FocusField implements ClickTarget {
  app: Editor;
  field: i32;

  constructor(app: Editor, field: i32) {
    this.app = app;
    this.field = field;
  }

  click(): void {
    this.app.ui.setFocus(this.field);
  }
}

/** A toolbar button: run one `Act`. */
class RunAct implements ClickTarget {
  app: Editor;
  act: i32;

  constructor(app: Editor, act: i32) {
    this.app = app;
    this.act = act;
  }

  click(): void {
    this.app.runAct(this.act);
  }
}

// ── the app ─────────────────────────────────────────────────────────────────

class Editor extends AppShell {
  // --- the document and its undo stack -----------------------------------
  doc: Document = Document.create(256);
  history: History = History.create(200);
  palette: Palette = Palette.create(this.history);

  // --- the tree ----------------------------------------------------------
  book: FontBook = fontBook();
  ui: Ui = new Ui(new WidgetTree(fontBook()));

  private sidebar: i32 = -1;
  private inspector: i32 = -1;
  private consoleCol: i32 = -1;
  private sceneList: i32 = -1;
  private sceneTree: SceneTreeBehavior = new SceneTreeBehavior();
  private sceneModel: SceneModel = new SceneModel(this);
  private viewport: ViewportBehavior = new ViewportBehavior();

  private undoLabel: i32 = -1;
  private inspName: i32 = -1;
  private inspFrame: i32 = -1;
  private inspParent: i32 = -1;
  private inspVisible: i32 = -1;
  private inspHint: i32 = -1;
  private consoleUndo: i32 = -1;
  private consoleLast: i32 = -1;
  private consoleLog: i32 = -1;
  private consoleKeys: i32 = -1;
  private statusLeft: i32 = -1;
  private statusRight: i32 = -1;

  /** The three editable properties, in inspector order, and their `PropKind`s. */
  private fields: i32[] = new Array<i32>(3);
  private fieldKinds: i32[] = new Array<i32>(3);

  // --- the menus ---------------------------------------------------------
  menus: MenuDef[] = new Array<MenuDef>();
  /** Which menu is open, or -1. */
  openMenu: i32 = -1;
  /** The overlay's rectangle, recomputed when a menu opens. */
  private menuX: i32 = 0;
  private menuY: i32 = 0;
  private menuW: i32 = 0;
  private menuH: i32 = 0;
  /** The menu row under the pointer, from the last paint's hit list. */
  private menuHover: i32 = -1;
  /** Set by `toggleMenu`, so the press that opened a menu does not close it. */
  private menuToggled: bool = false;

  // --- the flattened tree, for the list ----------------------------------
  //
  // A list addresses its rows by index and the document addresses its nodes by
  // id; these arrays are the map. Rebuilt only when the document's *shape*
  // changes — never per frame.
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
  private startX: i32[] = [80, 300, 520, 700, 180, 620];
  private startY: i32[] = [120, 380, 200, 480, 460, 60];
  private t: f32 = 0.0;

  // --- interaction --------------------------------------------------------
  /** The node the inspector is showing, and the document selected. */
  selected: i32 = ROOT_ID;
  /** The widget that held the focus last frame, for the commit-on-blur edge. */
  private lastFocus: i32 = -1;
  /** Whether the console's history lines need rebuilding. */
  private consoleDirty: bool = true;
  /** Frames drawn, for the status bar and a sanity check. */
  private drawn: i32 = 0;
  private lastUndo: string = "";
  private built: bool = false;
  /** `Mode.Edit` or `Mode.Play`. */
  private mode: i32 = Mode.Edit;
  /** The console's last log line. */
  private logLine: string = "(ready)";
  /** The bytes the last save wrote, so `Revert` has something to go back to. */
  private snapshot: Bytes | null = null;

  constructor() {
    super("tension-editor", fontBook().pages[0], 240);
    this.buildMenus();
    this.build(1280, 720);
  }

  // ── the shell's hooks ───────────────────────────────────────────────────

  /**
   * Three pages of type, and two textures on two pipelines.
   *
   * The pages come out of the volume (`assets/ui.N.iwi`, baked from real outlines
   * by `npm run assets`) and `loadFontBook` uploads them as the layers of one
   * texture array — which is what lets a single record name its page. The game's
   * atlas is **generated here**, because this pass is about the composite and not
   * an asset pipeline.
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
    this.log("ready: " + this.doc.liveCount.toString() + " nodes");
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
   * and the split re-clamps its divider out of its own `arrange`.
   */
  protected onResize(width: i32, height: i32): void {
    this.ui.tree.resize(width, height);
    // A menu anchored to a button that has moved is drawn at the old place, so it
    // closes: a popup at the wrong coordinates is worse than a popup that shut.
    this.openMenu = -1;
  }

  // ── the menus, once ─────────────────────────────────────────────────────

  /** The four menus, their rows, and the ids their rows record. */
  private buildMenus(): void {
    const file = new MenuDef("File");
    file.add("Save scene", "Ctrl+S", Act.Save);
    // **Revert, not Load**, and the difference is the host's, not the app's: a
    // guest cannot read back what it wrote. `tension::res` is a read-only VFS over
    // the packed volumes and `res_write` is the one verb that lands on the
    // filesystem, so the bytes go out and cannot come in. Until the host lets
    // `res_open` fall back to the write root, this item restores the snapshot the
    // last save took — which is the half of "load" that is honest to offer.
    file.add("Revert to saved", "", Act.Revert);
    file.add("Exit", "", Act.Exit);

    const edit = new MenuDef("Edit");
    edit.add("Undo", "Ctrl+Z", Act.Undo);
    edit.add("Redo", "Ctrl+Y", Act.Redo);
    edit.add("Add node", "Ctrl+A", Act.AddNode);
    edit.add("Delete node", "Del", Act.DeleteNode);

    const view = new MenuDef("View");
    view.add("Console", "", Act.ToggleConsole);
    view.add("Inspector", "", Act.ToggleInspector);

    const run = new MenuDef("Run");
    run.add("Play", "", Act.Play);
    run.add("Stop", "", Act.Stop);
    run.add("Restart", "", Act.Restart);

    this.menus.push(file);
    this.menus.push(edit);
    this.menus.push(view);
    this.menus.push(run);

    // Ids and widths are assigned once, here: the popup paints every frame it is
    // open and none of this may be recomputed there.
    const page = this.book.pages[0];
    let next: i32 = 0;
    for (let m: i32 = 0; m < this.menus.length; m++) {
      const def = this.menus[m];
      for (let i: i32 = 0; i < def.items.length; i++) {
        const item = def.items[i];
        item.hitId = MENU_HIT_BASE - next;
        next++;
        item.labelW = this.book.measureText(page, REGULAR, item.label);
        item.shortW = item.shortcut.length > 0
          ? this.book.measureText(page, REGULAR, item.shortcut) : 0;
      }
    }
  }

  // ── the tree, once ──────────────────────────────────────────────────────

  private build(w: i32, h: i32): void {
    const ui: Ui = this.ui;
    const root: i32 = ui.root(w, h);
    const col: i32 = ui.column(root, { flex: 1 });

    // ── the menu bar ──────────────────────────────────────────────────────
    const menu: i32 = ui.row(col, { minH: BAR_H, pad: BAR_PAD, gap: ITEM_GAP });
    ui.clips(menu);
    // Clipped to its own box: the undo label is the last child and a long one would
    // otherwise draw past the window edge. Nothing that needs to be *reachable*
    // depends on overrunning — the toolbar buttons come before the label.
    for (let m: i32 = 0; m < this.menus.length; m++) {
      const btn: i32 = ui.node(menu, new MenuButtonBehavior(this, m), { pad: 6 });
      this.menus[m].button = btn;
    }
    ui.spacer(menu, 1);
    const tools: i32 = ui.row(menu, { gap: 6, align: ALIGN_CENTER });
    ui.button(tools, "Play", { pad: 3 });
    ui.button(tools, "Stop", { pad: 3 });
    ui.button(tools, "Restart", { pad: 3 });
    // The three buttons are bound by index, in build order, so the target and the
    // widget cannot drift: `runAct` is what both a button and a menu row call.
    let b: i32 = ui.tree.firstChild[tools];
    if (b >= 0) { ui.onClick(b, new RunAct(this, Act.Play)); b = ui.tree.nextSibling[b]; }
    if (b >= 0) { ui.onClick(b, new RunAct(this, Act.Stop)); b = ui.tree.nextSibling[b]; }
    if (b >= 0) { ui.onClick(b, new RunAct(this, Act.Restart)); }
    this.undoLabel = ui.label(menu, "", { colour: LINK });
    ui.rule(col);

    // ── the body: sidebar | viewport + inspector ─────────────────────────
    const main: i32 = ui.split(col, Axis.X, { flex: 1 });
    ui.divider(main, SIDEBAR_W);

    const sidebar: i32 = ui.column(main, { minW: SIDEBAR_W, pad: PANEL_PAD, gap: 2 });
    this.sidebar = sidebar;
    ui.clips(sidebar);
    ui.label(sidebar, "SCENE", { colour: HEADING, weight: BOLD });
    this.sceneList = ui.list(sidebar, this.sceneModel, TREE_ROWS, { flex: 1 });
    // The list, drawn by a behavior that also marks the selection. `setBehavior`
    // is the extension point: everything `ui.list` set up stays, and only the
    // paint changes.
    ui.setBehavior(this.sceneList, this.sceneTree);
    // The tree's names are identifiers, so they are set in the mono face.
    this.setFont(this.sceneList, FONT_MONO, SIZE_14);

    const body: i32 = ui.row(main, { flex: 1 });
    const vp: i32 = ui.node(body, this.viewport, { flex: 1 });
    ui.flex(vp, 1);

    const inspector: i32 = ui.column(body, { minW: INSPECTOR_W, pad: PANEL_PAD, gap: 6 });
    this.inspector = inspector;
    ui.clips(inspector);
    ui.label(inspector, "INSPECTOR", { colour: HEADING, weight: BOLD });
    this.inspName = ui.label(inspector, "", { colour: HEADING, weight: BOLD });
    ui.rule(inspector);
    this.buildField(inspector, "x", PropKind.X, 0);
    this.buildField(inspector, "y", PropKind.Y, 1);
    this.buildField(inspector, "z", PropKind.Z, 2);
    this.inspFrame = ui.label(inspector, "", { colour: MUTED });
    this.inspParent = ui.label(inspector, "", { colour: MUTED });
    this.inspVisible = ui.label(inspector, "", { colour: MUTED });
    ui.rule(inspector);
    this.inspHint = ui.label(inspector, "", { colour: MUTED });
    ui.rule(col);

    // ── the console ───────────────────────────────────────────────────────
    const consoleCol: i32 = ui.column(col, { minH: CONSOLE_H, pad: PANEL_PAD, gap: 2 });
    this.consoleCol = consoleCol;
    ui.clips(consoleCol);
    ui.label(consoleCol, "CONSOLE", { colour: HEADING, weight: BOLD });
    this.consoleUndo = ui.label(consoleCol, "", { colour: MUTED });
    this.consoleLast = ui.label(consoleCol, "", { colour: MUTED });
    this.consoleLog = ui.label(consoleCol, "", { colour: LINK });
    this.consoleKeys = ui.label(consoleCol, "", { colour: MUTED });
    // Code is monospaced: the console's columns were aligned in the old build and a
    // proportional face would undo that silently.
    ui.font(this.consoleUndo, FONT_MONO, SIZE_14);
    ui.font(this.consoleLast, FONT_MONO, SIZE_14);
    ui.font(this.consoleLog, FONT_MONO, SIZE_14);
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

    this.syncOrder();
    this.syncConsole();
  }

  /**
   * One property row: a caption that focuses the field, and the field.
   *
   * The caption is `ui.clickable` because a `Label` records no hit by default — a
   * caption is for reading. Making it a target is what lets a click anywhere on the
   * row's left half put the caret in the field, which is where a user aiming at
   * "x" expects to end up.
   */
  private buildField(parent: i32, caption: string, kind: i32, index: i32): void {
    const ui: Ui = this.ui;
    // **The row stretches; the caption is what is centred.** Putting `align` on
    // the row instead centres the *row* inside the column, which measured it from
    // its content — a 164-px row floating in a 340-px panel, with the field squeezed
    // to its floor. Measured, and the reason the caption carries the alignment.
    const row: i32 = ui.row(parent, { gap: 12 });
    const lab: i32 = ui.label(row, caption, { colour: MUTED, align: ALIGN_CENTER });
    const field: i32 = ui.field(row, "", { minW: 140, pad: 3, flex: 1 });
    this.fields[index] = field;
    this.fieldKinds[index] = kind;
    ui.onChange(field, new PropertyEdit(this, kind));
    ui.onSubmit(field, new PropertySubmit(this, kind));
    // **The whole row focuses the field**, not only the caption. A click four pixels
    // above a field used to land on nothing, blur the field, and leave the next
    // Backspace to delete a node — measured. The row's own hit is recorded before
    // its children, so the field still wins a click that lands on the field.
    ui.clickable(row);
    ui.onClick(row, new FocusField(this, field));
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
    for (let i: i32 = 0; i < BOXES; i++) {
      const sprite = this.gameScene.spawn(cells[i % 4]);
      sprite.moveTo(<f32>this.startX[i], <f32>this.startY[i]);
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

    // **One dispatch per frame**, against the *previous* frame's hit list, and
    // `readText` inside it is the frame's only read of the typed stream — the queue
    // has one consumer or it has two.
    this.menuToggled = false;
    if (this.inputReady && this.input.read()) {
      this.ui.frame(this.input);
    } else {
      this.ui.frame(null);
    }

    this.trackMenu();
    this.commitOnBlur();
    // The commands run whatever holds the focus — except the ones that a *typing*
    // key would shadow. See `shortcuts` for which and why.
    this.shortcuts();
  }

  /** One frame: layout, the game into bucket 0, the tree and the popup into bucket 1. */
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
    // The dropdown goes into the same hit list, after the tree, so it is on top of
    // every panel and its rows win the hit test.
    this.drawMenu(p);
  }

  // ── the popup ───────────────────────────────────────────────────────────

  /** Open `which`, or close it if it is already open. */
  toggleMenu(which: i32): void {
    if (this.openMenu == which) {
      this.openMenu = -1;
      return;
    }
    this.showMenu(which);
  }

  private showMenu(which: i32): void {
    const m = this.menus[which];
    let w: i32 = 0;
    let h: i32 = 2 * MENU_PAD;
    for (let i: i32 = 0; i < m.items.length; i++) {
      const it = m.items[i];
      const rowW: i32 = it.labelW + (it.shortW > 0 ? MENU_GAP + it.shortW : 0);
      if (rowW > w) w = rowW;
      h += MENU_ITEM_H;
    }
    w += 2 * MENU_PAD_X;

    let x: i32 = this.ui.xOf(m.button);
    const maxX: i32 = this.width - w - 2;
    if (x > maxX) x = maxX > 0 ? maxX : 0;
    this.menuX = x;
    this.menuY = this.ui.yOf(m.button) + this.ui.hOf(m.button);
    this.menuW = w;
    this.menuH = h;
    this.openMenu = which;
    this.menuToggled = true;
  }

  /** Paint the open menu, into the frame's hit list. */
  private drawMenu(p: Painter): void {
    if (this.openMenu < 0) return;
    const m = this.menus[this.openMenu];
    const page = this.book.pages[0];
    const x: i32 = this.menuX;
    const y: i32 = this.menuY;
    const w: i32 = this.menuW;
    const h: i32 = this.menuH;

    // Re-arm the hit list: `tree.paint` disarms it when it returns, because a
    // caller that draws after the tree should not be able to record targets
    // silently. This one is deliberate.
    p.useHits(this.ui.hits);
    p.fill(x, y, w, h, page.chromeCell(Chrome.Surface), page);
    p.hline(x, y, w, page.chromeCell(Chrome.White), page);
    p.hline(x, y + h - 1, w, page.chromeCell(Chrome.Divider), page);
    p.vline(x, y, h, page.chromeCell(Chrome.Divider), page);
    p.vline(x + w - 1, y, h, page.chromeCell(Chrome.Divider), page);

    for (let i: i32 = 0; i < m.items.length; i++) {
      const it = m.items[i];
      const ry: i32 = y + MENU_PAD + i * MENU_ITEM_H;
      if (it.hitId == this.menuHover) {
        p.fill(x + 1, ry, w - 2, MENU_ITEM_H, page.chromeCell(Chrome.Selection), page);
      }
      const ty: i32 = ry + (MENU_ITEM_H - page.lineStep) / 2;
      p.textBytes(it.text.bytes, 0, it.text.len, x + MENU_PAD_X, ty,
                  NORMAL, REGULAR, 0, ry, ry + MENU_ITEM_H, page);
      if (it.short.len > 0) {
        p.textBytes(it.short.bytes, 0, it.short.len, x + w - MENU_PAD_X - it.shortW, ty,
                    MUTED, REGULAR, 0, ry, ry + MENU_ITEM_H, page);
      }
      p.addHit(x + 1, ry, w - 2, MENU_ITEM_H, it.hitId, it.hitId);
    }
    p.useHits(null);
  }

  /** Hover, click and dismiss for the popup. Runs after the dispatch. */
  private trackMenu(): void {
    const mx: i32 = this.input.mouseX;
    const my: i32 = this.input.mouseY;
    const over: i32 = this.ui.hits.at(mx, my);
    this.menuHover = this.itemByHit(over) != null ? over : -1;

    if (!this.input.buttonPressed(1)) return;
    const item = this.itemByHit(over);
    if (item != null) {
      this.openMenu = -1;
      this.runAct(item!.act);
      return;
    }
    // A press anywhere else dismisses — except the press that opened a menu, which
    // the button's own behavior already handled this frame.
    if (this.openMenu >= 0 && !this.menuToggled) this.openMenu = -1;
  }

  /** The row a hit id belongs to, or null. */
  private itemByHit(hitId: i32): MenuItem | null {
    if (hitId > MENU_HIT_BASE) return null;
    for (let m: i32 = 0; m < this.menus.length; m++) {
      const def = this.menus[m];
      for (let i: i32 = 0; i < def.items.length; i++) {
        if (def.items[i].hitId == hitId) return def.items[i];
      }
    }
    return null;
  }

  // ── the actions ─────────────────────────────────────────────────────────

  /** The one dispatcher for everything a menu row or a toolbar button means. */
  runAct(act: i32): void {
    if (act == Act.Save) { this.saveScene(); return; }
    if (act == Act.Revert) { this.revertScene(); return; }
    if (act == Act.Exit) {
      this.log("exit");
      print("tension-editor: exit requested from the File menu");
      this.stopLoop("the File menu asked to exit");
      return;
    }
    if (act == Act.Undo) {
      if (this.history.undo(this.doc)) this.afterEdit("undo");
      this.syncSelection();
      return;
    }
    if (act == Act.Redo) {
      if (this.history.redo(this.doc)) this.afterEdit("redo");
      this.syncSelection();
      return;
    }
    if (act == Act.AddNode) { this.addNode(); return; }
    if (act == Act.DeleteNode) { this.deleteNode(); return; }
    if (act == Act.ToggleConsole) {
      this.ui.hidden(this.consoleCol, !this.ui.isHidden(this.consoleCol));
      this.log(this.ui.isHidden(this.consoleCol) ? "console: hidden" : "console: shown");
      return;
    }
    if (act == Act.ToggleInspector) {
      this.ui.hidden(this.inspector, !this.ui.isHidden(this.inspector));
      this.log(this.ui.isHidden(this.inspector) ? "inspector: hidden" : "inspector: shown");
      return;
    }
    if (act == Act.Play) { this.setMode(Mode.Play); return; }
    if (act == Act.Stop) { this.setMode(Mode.Edit); return; }
    if (act == Act.Restart) { this.restartScene(); return; }
  }

  /** Save the document where the host's write root puts it, and keep a copy. */
  private saveScene(): void {
    const bytes: Bytes = this.doc.toBytes();
    const wrote: i32 = resWriteFile("saves/scene.json", bytes);
    if (wrote < 0) {
      this.log("save failed: " + wrote.toString());
      print("tension-editor: save failed: " + wrote.toString());
      return;
    }
    this.snapshot = bytes;
    this.log("saved " + this.doc.liveCount.toString() + " nodes (" +
             wrote.toString() + " bytes) to saves/scene.json");
    print("tension-editor: saved saves/scene.json (" + wrote.toString() + " bytes)");
  }

  /**
   * Put the document back to what the last save wrote.
   *
   * A **new** document rather than a command: undoing *into* a document that is no
   * longer open is a different feature, and the history holds commands that name
   * ids from the old one. So the history is dropped, which is also what a load
   * does in every editor that has one.
   */
  private revertScene(): void {
    if (this.snapshot == null) {
      this.log("revert: nothing saved yet");
      return;
    }
    const err = new JsonError();
    const loaded = Document.fromBytes(this.snapshot!, err);
    if (!err.ok) {
      this.log("revert failed: " + err.message);
      return;
    }
    this.doc = loaded;
    this.history.clear();
    this.selected = ROOT_ID;
    this.doc.select(ROOT_ID, true);
    this.orderDirty = true;
    this.consoleDirty = true;
    this.syncOrder();
    this.log("reverted to the saved snapshot (" + this.doc.liveCount.toString() + " nodes)");
    print("tension-editor: reverted to the saved snapshot");
  }

  private addNode(): void {
    const args = new Args();
    args.parent = this.selected >= 0 ? this.selected : ROOT_ID;
    args.text = "node";
    if (this.palette.run(this.doc, "node.add", args)) {
      this.selected = this.lastId();
      this.orderDirty = true;
      this.afterEdit("add");
    }
  }

  private deleteNode(): void {
    if (this.selected == ROOT_ID) return;
    const args = Args.forNode(this.selected);
    if (this.palette.run(this.doc, "node.remove", args)) {
      this.selected = ROOT_ID;
      this.orderDirty = true;
      this.afterEdit("remove");
    }
  }

  /** Enter or leave play mode: hide the chrome, and say so in three places. */
  private setMode(m: i32): void {
    if (this.mode == m) {
      this.log(m == Mode.Play ? "run: already playing" : "run: already in the editor");
      return;
    }
    this.mode = m;
    const playing: bool = m == Mode.Play;
    // **Hiding, not dimming.** A scrim over the chrome is ~5,000 records against a
    // 4,096 budget, so the honest "the editor steps aside" is to collapse the three
    // panels a player does not need. The bar stays — Stop has to be reachable.
    this.ui.hidden(this.sidebar, playing);
    this.ui.hidden(this.inspector, playing);
    this.ui.hidden(this.consoleCol, playing);
    this.viewport.mode = m;
    const what: string = playing ? "play" : "stop";
    this.log("run: " + what + " (mode " + m.toString() + ")");
    print("tension-editor: run: " + what);
  }

  /** Put the boxes back where they started, and play. */
  private restartScene(): void {
    for (let i: i32 = 0; i < this.boxes.length; i++) {
      this.boxes[i].moveTo(<f32>this.startX[i], <f32>this.startY[i]);
    }
    this.t = 0.0;
    this.log("run: restart");
    print("tension-editor: run: restart");
    this.setMode(Mode.Play);
  }

  // ── the panels ──────────────────────────────────────────────────────────

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
    pool.str(this.mode == Mode.Play ? "PLAYING   " : "edit   ");
    pool.str("frame ");
    pool.int(this.drawn);
    pool.str("   game ");
    pool.int(this.gameScene.aliveCount());
    pool.str(" boxes");
    this.ui.textPool(this.statusRight);
  }

  /** The console's lines, rebuilt only when something in them moved. */
  private syncConsole(): void {
    if (!this.consoleDirty) return;
    this.consoleDirty = false;
    this.ui.text(this.consoleUndo, "undo: " + this.history.undoCount.toString() +
      "   redo: " + this.history.redoCount.toString());
    const reachable: string = this.history.canUndo ? this.history.undoLabel()
      : (this.history.canRedo ? "redo " + this.history.redoLabel() : "(nothing)");
    this.ui.text(this.consoleLast, "last: " + reachable);
    this.ui.text(this.consoleKeys,
      "keys: ctrl+z undo  ctrl+y redo  ctrl+a add  ctrl+s save  del remove");
  }

  /** Write one line to the console panel and to stdout. The panel shows the last. */
  log(message: string): void {
    this.logLine = message;
    this.ui.text(this.consoleLog, "log: " + message);
  }

  // ── the scene tree's model ──────────────────────────────────────────────

  /**
   * Flatten the document, rebuild the list, and re-point the selection.
   *
   * `orderDirty` is set by every edit that changes the tree's *shape* — add,
   * remove, undo, redo, load — and never by a frame. `Document.ids()` allocates,
   * and a paint is not where that belongs.
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
   * recycled row was showing some other node a frame ago.
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

  /** Select the row a click landed on, commit what a field held, and tell the doc. */
  selectItem(index: i32): void {
    if (index < 0 || index >= this.orderCount) return;
    const id: i32 = this.orderIds[index];
    if (id == this.selected) return;
    // The field belonged to the *old* node, so it commits before the selection
    // moves — otherwise leaving a field by clicking a row would write the old text
    // onto the new node.
    this.commitFocused();
    this.selected = id;
    this.selectedIndex = index;
    this.sceneTree.selected = index;
    this.doc.clearSelection();
    this.doc.select(id, true);
    this.syncInspector();
  }

  // ── the inspector ───────────────────────────────────────────────────────

  /** Re-read the selected node into the inspector's fields and labels. */
  private syncInspector(): void {
    const id: i32 = this.selected;
    if (!this.doc.alive(id)) {
      for (let i: i32 = 0; i < this.fields.length; i++) this.ui.text(this.fields[i], "");
      this.ui.text(this.inspName, "");
      this.ui.text(this.inspFrame, "");
      this.ui.text(this.inspParent, "");
      this.ui.text(this.inspVisible, "");
      this.ui.text(this.inspHint, "nothing selected");
      return;
    }
    const node = this.doc.node(id);
    this.ui.text(this.inspName, "node " + id.toString() + "  " + node.name);
    // The fields show the *document's* values. While a user types, the edit applies
    // live and nothing writes back — a field that rewrites itself under the caret
    // is a field that moves the caret.
    this.ui.text(this.fields[0], node.x.toString());
    this.ui.text(this.fields[1], node.y.toString());
    this.ui.text(this.fields[2], node.z.toString());
    this.ui.text(this.inspFrame, "frame " + node.frame.toString());
    this.ui.text(this.inspParent, "parent " + node.parent.toString());
    this.ui.text(this.inspVisible, "visible " + (node.visible ? "yes" : "no"));
    this.ui.text(this.inspHint, "click a value to edit it; Enter or leaving applies");
  }

  // ── editing ─────────────────────────────────────────────────────────────

  /** The field slot for a `PropKind`, or -1 when it is not one of the three. */
  private slotOf(kind: i32): i32 {
    for (let i: i32 = 0; i < this.fieldKinds.length; i++) {
      if (this.fieldKinds[i] == kind) return this.fields[i];
    }
    return -1;
  }

  /** The `PropKind` a field slot edits, or -1. */
  private kindOfField(slot: i32): i32 {
    for (let i: i32 = 0; i < this.fields.length; i++) {
      if (this.fields[i] == slot) return this.fieldKinds[i];
    }
    return -1;
  }

  /**
   * Apply what a field holds, live, as one undoable edit.
   *
   * `SetProperty.merge` collapses a burst of same-node, same-property edits, so a
   * typed `12.5` is one history entry whose `before` is the value from before the
   * first keystroke — which is what a drag does, and why `merge` exists.
   */
  applyField(kind: i32): void {
    const id: i32 = this.selected;
    if (!this.doc.alive(id)) return;
    const slot: i32 = this.slotOf(kind);
    if (slot < 0) return;
    const text: string = this.ui.textOf(slot);
    if (!looksNumeric(text)) return;
    const value: f32 = <f32>parseDecimal(text);
    if (value == this.doc.number(id, <PropKind>kind)) return;
    this.history.exec(this.doc, new SetProperty(id, <PropKind>kind, value));
    this.afterEdit("set " + propertyName(kind));
  }

  /** Return, or leaving a field: apply, then show the document's value. */
  commitField(kind: i32): void {
    this.applyField(kind);
    if (!this.doc.alive(this.selected)) return;
    this.ui.text(this.slotOf(kind), this.doc.number(this.selected, <PropKind>kind).toString());
  }

  /** Commit whichever field currently holds the focus, if any. */
  private commitFocused(): void {
    const kind: i32 = this.kindOfField(this.ui.focusId);
    if (kind >= 0) this.commitField(kind);
  }

  /**
   * A focus loss commits; **Escape cancels**.
   *
   * The edge is tracked here rather than in a handler because focus lives in the
   * dispatcher: there is no "blur" event to bind, and inventing one for this app
   * would be a second source of truth about who holds the keyboard. Escape is the
   * one exception a user expects — it is "never mind", so the fields are re-read
   * from the document instead of applied.
   */
  private commitOnBlur(): void {
    const now: i32 = this.ui.focusId;
    const cancelled: bool = this.input.pressed(SC_ESCAPE);
    if (this.lastFocus >= 0 && now != this.lastFocus) {
      const kind: i32 = this.kindOfField(this.lastFocus);
      if (cancelled || kind < 0) {
        // Cancelled: the document never changed, so re-reading it *is* the revert.
        this.syncInspector();
      } else {
        this.commitField(kind);
      }
    }
    this.lastFocus = now;
  }

  /** What the menu and the console report after an edit. */
  private afterEdit(what: string): void {
    const label: string = this.history.canUndo ? this.history.undoLabel() : "";
    // The menu bar says what happened ("set x"); the console says what the command
    // was ("x = 42.0"). A bar that tried to say both ran off the end of a 1280-px
    // window the moment a node name got long, and a bar is not a log.
    this.lastUndo = what;
    this.ui.text(this.undoLabel, this.lastUndo);
    this.log(what + " -> " + label);
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
    if (state.pressed(SC_ESCAPE) && this.openMenu >= 0) {
      this.openMenu = -1;
      return;
    }
    // Undo, redo, save and load run **even while a field has the focus**. They are
    // commands about the document, and a user who just typed a number reaches for
    // Ctrl+Z without leaving the field — measured: with the old rule the keystroke
    // did nothing at all, because the field consumes what it does not know.
    if (state.ctrl && state.pressed(SC_Z)) { this.runAct(Act.Undo); return; }
    if (state.ctrl && state.pressed(SC_Y)) { this.runAct(Act.Redo); return; }
    if (state.ctrl && state.pressed(SC_S)) { this.runAct(Act.Save); return; }
    // These two *do* collide with typing, so a focused field owns them: Ctrl+A in a
    // field is "select all" in every editor that has one, and Delete in a field is
    // a forward delete. Neither is a document command while the caret is in text.
    if (this.ui.focusId >= 0) return;
    if (state.ctrl && state.pressed(SC_A)) { this.runAct(Act.AddNode); return; }
    // **Delete, not Backspace.** Backspace is a typing key: when the focus is lost
    // — a click a few pixels off a field — its first press deleted the selected
    // node, which is how a user loses work without touching the menu. `Del` is
    // deliberate, and it is what the legend says.
    if (state.pressed(SC_DELETE)) { this.runAct(Act.DeleteNode); }
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

  // ── the camera ──────────────────────────────────────────────────────────

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
}

// ── small functions ─────────────────────────────────────────────────────────

/** The menu label for a `PropKind`. */
function propertyName(kind: i32): string {
  if (kind == PropKind.X) return "x";
  if (kind == PropKind.Y) return "y";
  if (kind == PropKind.Z) return "z";
  return "property";
}

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
