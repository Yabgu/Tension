// The editor: a guest app that edits a document and draws a game under its own UI.
//
// ## The shape, in one paragraph
//
// `Document` holds the scene, `History` makes every edit reversible, `Palette`
// names the edits, and this file is the part that turns a mouse and a keyboard
// into dispatches. It draws with `tension-ui`'s `Painter` and hosts the app loop
// in `AppShell`. The one thing that is not ordinary: the **game viewport** is a
// second `Scene` with its own pipeline and its own texture, drawn into canvas
// bucket 0 while the UI goes to bucket 1 — so one `present` composites a world
// under a chrome, which is the architecture the editor exists to prove.
//
// ## The frame
//
//     0        32                                                         1920
//     +---------+---------------------------------------------------------+
//     | menu: File  Edit  View  Run                             (32 px)    |   0
//     +---------+--------------------------------+------------------------+
//     | scene   |  game viewport                 | inspector              |
//     | tree    |  (bucket 0, its own pipeline)  | (selected node)        |
//     | 320 px  |                                | 360 px                 |
//     +---------+--------------------------------+------------------------+
//     | console (240 px)                                                    |
//     +---------------------------------------------------------------------+
//     | status: undo label, node count, records, mode             (32 px)   |
//     +---------------------------------------------------------------------+
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
// Play mode (Pass 4), save and live reload (Pass 5). The document is edited in
// memory and the viewport draws procedurally generated boxes — no game asset is
// loaded yet, which is what keeps this pass about the composite rather than about
// an asset pipeline.

import {
  AppShell, Args, BOLD, Bytes, CELL_H, CELL_W, Canvas, CHROME_DIVIDER, CHROME_SELECTION,
  CHROME_WHITE, Document, drawText, Frame, HEADING, Hits, History, LINE_STEP, LINK, MUTED,
  NORMAL, Painter, Palette, print, px, REGULAR, registerEditorCommands, ROOT_ID, rule, Scene,
  SetX, Sprite, vrule, DEFAULT_THEME,
} from "tension-framework";
import { DEFAULT_2D_BLOB } from "./graph.generated";

// ── the layout ──────────────────────────────────────────────────────────────

/** Every panel's size, in pixels, at any window size. */
const MENU_H: i32 = CELL_H;          // 32 at the 2x cell: one line of text
const STATUS_H: i32 = CELL_H;
const SIDEBAR_W: i32 = 320;
const INSPECTOR_W: i32 = 360;
const CONSOLE_H: i32 = 240;
/** One pixel between panels; the divider is the only separation there is. */
const RULE_W: i32 = 1;

/**
 * The minimum canvas a layout is computed for.
 *
 * A window dragged small would otherwise give the viewport a negative width, and
 * every panel's arithmetic downstream would be arithmetic on nonsense. The
 * config also asks the window manager for this minimum; this is the backstop for a
 * compositor that ignores it.
 */
const MIN_W: i32 = 900;
const MIN_H: i32 = 600;

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

// ── the app ─────────────────────────────────────────────────────────────────

class Editor extends AppShell {
  // --- the document and its undo stack -----------------------------------
  doc: Document = Document.create(256);
  history: History = History.create(200);
  palette: Palette = Palette.create(this.history);

  // --- the game viewport --------------------------------------------------
  /**
   * A second scene and a second pipeline.
   *
   * `gameScene` is a `Scene`, so it keeps its records between frames and costs
   * only what moved. `gamePipe` comes from the emitted graph blob, which the
   * renderer mints as pipe 100 — distinct from preset 1, which the UI uses — so
   * bucket 0 and bucket 1 are genuinely two draw calls with two pipelines and two
   * atlases of different sizes.
   */
  gameScene: Scene = Scene.create(WORLD_W, WORLD_H, 64);
  gamePipe: i32 = -1;
  gameTexture: i32 = -1;
  private boxes: Sprite[] = [];
  private boxDx: f32[] = [];
  private boxDy: f32[] = [];
  private t: f32 = 0.0;

  // --- interaction --------------------------------------------------------
  private hits: Hits = new Hits();
  /** The node the inspector is showing. */
  selected: i32 = ROOT_ID;
  /** The property the field edits; only X for now, which the brief asks for. */
  private fieldValue: string = "";
  private editing: bool = false;
  /** Frames drawn, for the status bar's record count and a sanity check. */
  private drawn: i32 = 0;
  private lastUndo: string = "";

  constructor() {
    super("tension-editor", DEFAULT_THEME, 240);
  }

  // ── the shell's hooks ───────────────────────────────────────────────────

  /**
   * Two textures, one pipeline each.
   *
   * The UI atlas comes out of the volume (`assets/ui.iwi`, baked by
   * `npm run assets`). The game's is **generated here** — four solid colour cells
   * — because this pass is about the composite, not an asset pipeline
   * (`Pass 4` loads a real one). It is still a real texture at a real, *different*
   * size, which is the harder case: the renderer rebinds `u_tex_size` per span, and
   * a game atlas the same size as the UI's would not prove that.
   */
  protected loadAssets(canvas: Canvas, pipe: i32): bool {
    const atlas = canvas.loadTextureFromRes("/ui.iwi");
    if (atlas <= 0) {
      print("tension-editor: /ui.iwi did not load: " + atlas.toString() +
        " (run `npm run assets`)");
      return false;
    }
    if (canvas.bindTexture(pipe, 0, atlas) != 0) {
      print("tension-editor: binding the UI atlas refused");
      return false;
    }

    // The game's pipeline: the same graph the host emitted, through a *second*
    // pipeline id. `tension dev` writes `src/graph.generated.ts` on build.
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

  protected onResize(width: i32, height: i32): void {
    // Nothing to recompute yet: every panel is a fixed size and the viewport is
    // whatever is left, computed at draw time from `this.width`/`this.height`.
  }

  // ── setup ───────────────────────────────────────────────────────────────

  /**
   * The document's opening scene, and the game's boxes — **once**.
   *
   * `loadAssets` runs at startup *and* after every canvas rebuild, because a
   * canvas is fixed for its lifetime and reopening one destroys its textures
   * (`app/shell.ts`). Rebuilding the scene with it is what a caller does by
   * accident: the first run of this file shipped nine nodes instead of five and
   * twelve boxes instead of six, because a window that the compositor had resized
   * to fit the screen triggered one rebuild. The flag is the fix, and the
   * duplication is the reason it is a flag rather than a comment.
   */
  private built: bool = false;

  /** The document's opening scene, and the game's boxes. */
  private buildScene(): void {
    if (this.built) return;
    this.built = true;
    this.palette = registerEditorCommands(Palette.create(this.history));

    // A document with something in it: an empty tree proves nothing about a tree.
    const world = this.doc.node(ROOT_ID);
    world.name = "World";
    this.spawn("room", ROOT_ID, 40.0, 60.0);
    this.spawn("hero", ROOT_ID, 300.0, 240.0);
    this.spawn("lantern", ROOT_ID, 620.0, 120.0);
    this.spawn("crate", ROOT_ID, 760.0, 420.0);
    // The history starts empty: the opening scene is the document's initial
    // state, not an edit a user has to undo past.
    this.history.clear();
    this.selected = ROOT_ID;
    // The inspector's subject and the document's selection are one thing at
    // startup; they diverge only when a node is deleted out from under them.
    this.doc.select(ROOT_ID, true);

    // The game's boxes: two frames (a cell each), scattered, drifting.
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
    args.id = 0;                       // ALLOCATE_ID: the document picks the id
    args.parent = parent;
    args.text = name;
    // Through the palette, not `doc.spawn`: the opening scene is built the way a
    // user's edit would be, so a bug in `AddNode` shows up here too.
    this.palette.run(this.doc, "node.add", args);
    const ids = this.doc.ids();
    const created = ids[ids.length - 1];
    this.doc.setX(created, x);
    this.doc.setY(created, y);
  }

  // ── the frame ───────────────────────────────────────────────────────────

  /** Animate the boxes and read input. */
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
    this.handleInput();
  }

  /** One frame of records: the game into bucket 0, the UI into bucket 1. */
  protected draw(p: Painter): void {
    this.drawn++;
    this.hits.begin();

    // Frame the boxes: a camera at the origin shows the world's top-left corner,
    // and six boxes drifting across 1600x1200 spend most of their time outside a
    // 1238x655 window. Tracking the centroid is also what a real viewport does,
    // and it exercises `setCamera` on every frame rather than once.
    const vpPreview = this.viewport();
    this.cameraToBoxes(vpPreview);

    // **The composite.** The game scene is clipped to the viewport and submitted
    // first; the shell submits the painter into bucket 1 afterwards, and the
    // renderer draws the buckets in ascending order. The clip is what keeps a box
    // from painting over the inspector.
    const vp = this.viewport();
    this.gameScene.setViewport(vp.x, vp.y, vp.w, vp.h);
    const committed = this.gameScene.commit(this.canvas!, this.gamePipe, 0);
    if (committed < 0) {
      print("tension-editor: the game scene refused: " + committed.toString());
    }

    this.drawMenu(p);
    this.drawTree(p);
    this.drawViewportFrame(p, vp);
    this.drawInspector(p);
    this.drawConsole(p);
    this.drawStatus(p);
  }

  /**
   * Frame the first box, clamped to the world.
   *
   * **The first box, not the centroid.** The centroid was the first attempt and it
   * failed the thing it was for: six boxes spread over a 900x560 field have a
   * centroid in the middle of it, and a 238-px-wide viewport centred there
   * contained *nothing* — an editor that opens onto an empty panel. Tracking one
   * node keeps something on screen at every size, and boxes near the edge still
   * demonstrate the clip.
   *
   * A real editor tracks the selection; that is Pass 4's business.
   *
   * Clamped because a camera panned past the world's edge shows the void.
   */
  private cameraToBoxes(vp: Rect): void {
    if (this.boxes.length == 0) return;
    const lead = this.boxes[0];
    const cx: f32 = lead.x + <f32>BOX * 0.5 - <f32>vp.w * 0.5;
    const cy: f32 = lead.y + <f32>BOX * 0.5 - <f32>vp.h * 0.5;
    const maxX: f32 = <f32>(WORLD_W - vp.w);
    const maxY: f32 = <f32>(WORLD_H - vp.h);
    this.gameScene.setCamera(clamp(cx, 0.0, maxX > 0.0 ? maxX : 0.0),
                             clamp(cy, 0.0, maxY > 0.0 ? maxY : 0.0));
  }

  // ── layout, in one place ────────────────────────────────────────────────

  /** The rectangle the game draws in: what the panels leave. */
  private viewport(): Rect {
    const w: i32 = this.width < MIN_W ? MIN_W : this.width;
    return new Rect(SIDEBAR_W + RULE_W, MENU_H,
                    w - SIDEBAR_W - INSPECTOR_W - RULE_W * 2, this.mainH());
  }

  /** The height a main row has, after the menu, the console and the status bar. */
  private mainH(): i32 {
    const h: i32 = this.height < MIN_H ? MIN_H : this.height;
    return h - MENU_H - CONSOLE_H - STATUS_H;
  }

  // ── the panels ──────────────────────────────────────────────────────────

  private drawMenu(p: Painter): void {
    rule(p, 0, MENU_H, this.width, CHROME_DIVIDER);
    let x: i32 = px(8);
    const items: string[] = ["File", "Edit", "View", "Run"];
    for (let i: i32 = 0; i < items.length; i++) {
      x = drawText(p, items[i], x, (MENU_H - CELL_H) / 2, MUTED, REGULAR);
      x = drawText(p, "   ", x, 0, MUTED, REGULAR);
    }
    // The undo label doubles as the command palette's last action, which is the
    // cheapest honest way to show that an edit went through the history.
    const columns: i32 = this.width / CELL_W - 24;
    const label: string = fit(this.lastUndo, columns);
    if (label.length > 0) {
      const w: i32 = label.length * CELL_W;
      drawText(p, label, this.width - w - px(12), (MENU_H - CELL_H) / 2, LINK, REGULAR);
    }
  }

  /** The scene tree: one row per node, indented by depth, selected underlined. */
  private drawTree(p: Painter): void {
    const top: i32 = MENU_H + px(8);
    vrule(p, SIDEBAR_W, MENU_H, this.mainH(), CHROME_DIVIDER);
    drawText(p, "SCENE", px(10), top, HEADING, BOLD);

    const rowsTop: i32 = top + LINE_STEP;
    const rows: i32 = (this.mainH() - (rowsTop - MENU_H) - px(4)) / LINE_STEP;
    const ids = this.doc.ids();

    // Keep the selection on screen: the tree is longer than the panel as soon as
    // a user adds a handful of nodes.
    let first: i32 = 0;
    let selectedRow: i32 = 0;
    for (let i: i32 = 0; i < ids.length; i++) {
      if (ids[i] == this.selected) selectedRow = i;
    }
    if (selectedRow >= rows) first = selectedRow - rows + 1;

    for (let r: i32 = 0; r < rows; r++) {
      const i: i32 = first + r;
      if (i >= ids.length) break;
      const id: i32 = ids[i];
      const depth: i32 = this.depthOf(id);
      const y: i32 = rowsTop + r * LINE_STEP;
      const selected: bool = id == this.selected;
      const indent: i32 = px(10) + depth * px(8);

      // A row is the whole panel width, so clicking anywhere on the line selects.
      this.hits.add(0, y, SIDEBAR_W, LINE_STEP, id);

      const columns: i32 = (SIDEBAR_W - indent - px(10)) / CELL_W;
      const name: string = fit(this.doc.nameOf(id), columns);
      drawText(p, name, indent, y, selected ? HEADING : NORMAL, selected ? BOLD : REGULAR);
      if (selected) p.hline(indent, y + CELL_H, SIDEBAR_W - indent - px(10), CHROME_WHITE);
    }
  }

  /** The viewport's frame — four rules, and where the scene is clipped. */
  private drawViewportFrame(p: Painter, vp: Rect): void {
    rule(p, vp.x, vp.y, vp.w, CHROME_DIVIDER);
    rule(p, vp.x, vp.y + vp.h - 1, vp.w, CHROME_DIVIDER);
    vrule(p, vp.x, vp.y, vp.h, CHROME_DIVIDER);
    vrule(p, vp.x + vp.w - 1, vp.y, vp.h, CHROME_DIVIDER);
    // The world's extent, so the clip is visible as a *clip* rather than as a
    // scene that happens to end. **Clipped to the panel**: this text is longer
    // than a narrow viewport, and unclipped it drew straight over the inspector —
    // the same bug the game scene's own clip exists to prevent, in the UI layer.
    const label: string = "viewport " + vp.w.toString() + "x" + vp.h.toString() +
      "  world " + WORLD_W.toString() + "x" + WORLD_H.toString();
    p.setClip(vp.x, vp.y, vp.w, vp.h);
    drawText(p, label, vp.x + px(6), vp.y + px(4), MUTED, REGULAR);
    p.clearClip();
  }

  /** The inspector: the selected node's properties, with X editable. */
  private drawInspector(p: Painter): void {
    const x0: i32 = this.width - INSPECTOR_W;
    vrule(p, x0, MENU_H, this.mainH(), CHROME_DIVIDER);
    const top: i32 = MENU_H + px(8);
    drawText(p, "INSPECTOR", x0 + px(10), top, HEADING, BOLD);

    let y: i32 = top + LINE_STEP;
    const id: i32 = this.selected;
    if (!this.doc.alive(id)) {
      drawText(p, "nothing selected", x0 + px(10), y, MUTED, REGULAR);
      return;
    }
    const node = this.doc.node(id);
    drawText(p, "node " + id.toString() + "  " + node.name, x0 + px(10), y, NORMAL, BOLD);
    y += LINE_STEP;
    rule(p, x0 + px(10), y - px(4), INSPECTOR_W - px(20), CHROME_DIVIDER);

    // The editable field. Its row is a hit target, and while it is focused the
    // row shows the value being typed rather than the document's.
    const fieldY: i32 = y + LINE_STEP;
    drawText(p, "x", x0 + px(10), y, MUTED, REGULAR);
    const shown: string = this.editing ? this.fieldValue + "_" : node.x.toString();
    const fieldX: i32 = x0 + px(10) + CELL_W * 3;
    if (this.editing) {
      // A caret cell behind the text: the atlas has one precisely for this.
      p.fill(fieldX - px(2), y - px(2), (shown.length + 1) * CELL_W, CELL_H + px(4),
             CHROME_SELECTION);
      drawText(p, shown, fieldX, y, HEADING, BOLD);
    } else {
      drawText(p, shown, fieldX, y, LINK, REGULAR);
    }
    this.hits.add(x0 + px(10), y, INSPECTOR_W - px(20), LINE_STEP, HIT_FIELD);

    y = fieldY;
    drawText(p, "y " + node.y.toString(), x0 + px(10), y, MUTED, REGULAR);
    y += LINE_STEP;
    drawText(p, "z " + node.z.toString(), x0 + px(10), y, MUTED, REGULAR);
    y += LINE_STEP;
    drawText(p, "frame " + node.frame.toString(), x0 + px(10), y, MUTED, REGULAR);
    y += LINE_STEP;
    drawText(p, "parent " + node.parent.toString(), x0 + px(10), y, MUTED, REGULAR);
    y += LINE_STEP;
    drawText(p, "visible " + (node.visible ? "yes" : "no"), x0 + px(10), y, MUTED, REGULAR);

    y += LINE_STEP * 2;
    rule(p, x0 + px(10), y - px(6), INSPECTOR_W - px(20), CHROME_DIVIDER);
    drawText(p, this.editing ? "type a number, Enter applies" : "click x to edit",
             x0 + px(10), y, MUTED, REGULAR);
  }

  /** The console: the command log, newest last. */
  private drawConsole(p: Painter): void {
    const y0: i32 = this.height - STATUS_H - CONSOLE_H;
    rule(p, 0, y0, this.width, CHROME_DIVIDER);
    drawText(p, "CONSOLE", px(10), y0 + px(6), HEADING, BOLD);

    let y: i32 = y0 + px(6) + LINE_STEP;
    const lines: string[] = [];
    lines.push("undo: " + this.history.undoCount.toString() +
      "   redo: " + this.history.redoCount.toString());
    // What the user can reach: the undo they would run next, else the redo.
    const reachable: string = this.history.canUndo ? this.history.undoLabel()
      : (this.history.canRedo ? "redo " + this.history.redoLabel() : "(nothing)");
    lines.push("last: " + reachable);
    lines.push("keys: ctrl+z undo   ctrl+y redo   ctrl+a add   del remove");
    const columns: i32 = (this.width - px(20)) / CELL_W;
    for (let i: i32 = 0; i < lines.length; i++) {
      drawText(p, fit(lines[i], columns), px(10), y, MUTED, REGULAR);
      y += LINE_STEP;
    }
  }

  /** The status bar: what the frame cost, and what is selected. */
  private drawStatus(p: Painter): void {
    const y: i32 = this.height - STATUS_H;
    rule(p, 0, y, this.width, CHROME_DIVIDER);
    const textY: i32 = y + (STATUS_H - CELL_H) / 2;
    const state: string = this.doc.liveCount.toString() + " nodes   " +
      this.doc.selectionCount.toString() + " selected   " +
      this.lastRecords.toString() + " ui rec" +
      (this.lastDropped > 0 ? "  " + this.lastDropped.toString() + " dropped" : "");
    drawText(p, state, px(10), textY, MUTED, REGULAR);

    const right: string = "frame " + this.drawn.toString() +
      "   game " + this.gameScene.aliveCount().toString() + " boxes";
    const w: i32 = right.length * CELL_W;
    const leftW: i32 = state.length * CELL_W;
    // Only when both halves fit: a status bar that overprints itself is worse
    // than one showing less.
    if (leftW + w + px(30) <= this.width) {
      drawText(p, right, this.width - w - px(10), textY, MUTED, REGULAR);
    }
  }

  // ── input ───────────────────────────────────────────────────────────────

  /** Clicks, keys, and the one editable field. */
  private handleInput(): void {
    if (!this.inputReady || !this.input.read()) return;
    const state = this.input;

    // ── a click ───────────────────────────────────────────────────────────
    if (state.buttonPressed(1)) {
      const hit: i32 = this.hits.at(state.mouseX, state.mouseY);
      if (hit == HIT_FIELD) {
        this.editing = true;
        this.fieldValue = "";
      } else if (hit >= 0) {
        this.editing = false;
        this.selected = hit;
        this.doc.clearSelection();
        this.doc.select(hit, true);
      } else {
        // A click on a panel that is not a target drops the field's focus, which
        // is what every form does and what stops a stray keystroke editing.
        this.editing = false;
      }
    }

    // ── the typed field ───────────────────────────────────────────────────
    //
    // `textInput()` is the UTF-8 stream the input capability gained for exactly
    // this: a scancode table can spell `[a-z0-9]` and cannot spell a minus sign
    // or a decimal point the way a keyboard's own layout does.
    if (this.editing) {
      const typed: string = state.textInput();
      for (let i: i32 = 0; i < typed.length; i++) {
        const c: i32 = typed.charCodeAt(i);
        if ((c >= 48 && c <= 57) || c == 45 || c == 46) {
          this.fieldValue += typed.charAt(i);
        }
      }
      if (state.pressed(SC_BACKSPACE) && this.fieldValue.length > 0) {
        this.fieldValue = this.fieldValue.slice(0, this.fieldValue.length - 1);
      }
      if (state.pressed(SC_RETURN) || state.pressed(SC_KP_ENTER)) {
        this.commitField();
      }
      if (state.pressed(SC_ESCAPE)) {
        this.editing = false;
        this.fieldValue = "";
      }
      return;                            // a focused field owns the keyboard
    }

    // ── the shortcuts ─────────────────────────────────────────────────────
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
        this.afterEdit("add");
      }
      return;
    }
    if (state.pressed(SC_DELETE) || state.pressed(SC_BACKSPACE)) {
      if (this.selected != ROOT_ID) {
        const args = Args.forNode(this.selected);
        if (this.palette.run(this.doc, "node.remove", args)) {
          this.selected = ROOT_ID;
          this.afterEdit("remove");
        }
      }
    }
  }

  /** Apply the typed value through the history — the pass's one editable field. */
  private commitField(): void {
    if (this.fieldValue.length == 0) {
      this.editing = false;
      return;
    }
    const parsed: f64 = parseDecimal(this.fieldValue);
    this.editing = false;
    this.fieldValue = "";
    // `SetX` through the history, not `doc.setX`: the setter would move the number
    // and leave nothing to undo, which is the rule the editor core is built on.
    this.history.exec(this.doc, new SetX(this.selected, <f32>parsed));
    this.afterEdit("set x");
  }

  /** What the menu and the console report after an edit. */
  private afterEdit(what: string): void {
    this.lastUndo = what + ": " + (this.history.canUndo ? this.history.undoLabel() : "");
  }

  /** After an undo, the selected id may be gone; fall back to the root. */
  private syncSelection(): void {
    if (!this.doc.alive(this.selected)) this.selected = ROOT_ID;
    if (this.selected != ROOT_ID) {
      this.doc.clearSelection();
      this.doc.select(this.selected, true);
    }
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

// ── small types ─────────────────────────────────────────────────────────────

/** A rectangle, because the layout returns one twice and four ints is a bug. */
class Rect {
  x: i32;
  y: i32;
  w: i32;
  h: i32;
  constructor(x: i32, y: i32, w: i32, h: i32) {
    this.x = x;
    this.y = y;
    this.w = w;
    this.h = h;
  }
}

/** The `Hits` id for the inspector's field: node ids are 0.. so this is free. */
const HIT_FIELD: i32 = -2;

/**
 * Scancodes (SDL numbering), the same table `apps/docs` uses.
 *
 * The record carries a held-key bitmap for physical keys and a separate UTF-8
 * stream for *typed* text (`input.ts`, `Snapshot.textInput`). The stream is what
 * the field below reads; these are the keys that are commands rather than text.
 */
const SC_A: u32 = 4;
const SC_Y: u32 = 28;
const SC_Z: u32 = 29;
const SC_RETURN: u32 = 40;
const SC_ESCAPE: u32 = 41;
const SC_BACKSPACE: u32 = 42;
const SC_DELETE: u32 = 76;
const SC_KP_ENTER: u32 = 88;

/**
 * A decimal from the field's text — `-12`, `3.5`, `.5`.
 *
 * Hand-rolled because `parseFloat` is not in this runtime's standard library
 * surface, and a value the user typed must not quietly become `NaN`: an
 * unparseable string answers 0, which the caller can see rather than discovering
 * a node at `NaN` two undos later.
 */
/**
 * `text` cut to `columns` characters, or the whole of it.
 *
 * Every panel here is a fixed width while the text is not — a `--tns` path in the
 * console, a node name a user typed. Unclipped, the status bar's two halves drew
 * through each other at 920 px (`58frame 6` was `586 ui rec` and `frame 6…`), so
 * the panels measure before they draw, the way `apps/docs`' status bar does.
 */
function fit(text: string, columns: i32): string {
  return text.length <= columns ? text : text.slice(0, columns);
}

function clamp(v: f32, lo: f32, hi: f32): f32 {
  if (v < lo) return lo;
  if (v > hi) return hi;
  return v;
}

function parseDecimal(text: string): f64 {
  let sign: f64 = 1.0;
  let i: i32 = 0;
  if (text.length > 0 && text.charCodeAt(0) == 45) {   // '-'
    sign = -1.0;
    i = 1;
  }
  let whole: f64 = 0.0;
  let frac: f64 = 0.0;
  let scale: f64 = 1.0;
  let seen: bool = false;
  while (i < text.length) {
    const c: i32 = text.charCodeAt(i);
    if (c == 46) {                                     // '.'
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
 * arbitrary — 128x32 against the UI atlas's 576x1024 means the renderer has to
 * rebind `u_tex_size` between the two spans, which is the part of the bucket
 * mechanism that two same-sized atlases would not test.
 *
 * The header is the one `examples/2d/box-physics/src/atlas.ts` documents and
 * `apps/docs/tools/make-font.mjs` writes: 74 bytes, `IWI1`, RGBA8 interleaved.
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

  // Four cells, one colour each, opaque. A view over the buffer's `dataStart`,
  // which is the rule `bytes.ts` sets: never `changetype` of a typed array.
  // **Little-endian, so the word is `A<<24 | B<<16 | G<<8 | R`.** Writing the
  // RGB triple as if it were a big-endian word is the mistake that shipped first:
  // the boxes came out purple, olive and magenta, which looks like a pipeline bug
  // and is an endianness one.
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
      const row: i32 = (y * W + base) ;
      for (let x: i32 = 0; x < 32; x++) {
        // Little-endian RGBA in memory, so the word is A<<24 | B<<16 | G<<8 | R.
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
