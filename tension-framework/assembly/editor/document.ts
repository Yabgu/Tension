// The editor's document: nodes in parallel arrays, and a save format.
//
// ## What a document is, and what it is not
//
// It is **data**: node ids, parents, transforms, names, selection. It is not a
// renderer, it has no canvas, and it does not know what a command is. Every
// mutation is a plain setter, and the undo stack lives beside it in `History` —
// which is the separation that makes an edit undoable *deliberately* rather than
// as a side effect of calling a setter. A setter that recorded itself would make
// `undo` mean "the last thing that happened", and the interesting commands —
// remove a subtree, reparent, paste — are not single setter calls.
//
// ## Why parallel arrays
//
// The same reason `Scene` and `physics.Body` use them: an id indexes a slot, a
// pass over one property is sequential, and there is no per-node object to allocate
// or collect. A `Node` is a **handle** — a document and an id, nothing else — so
// building one costs one small object and no state of its own.
//
// ## Why children are computed rather than stored
//
// A child list is a second copy of the `parent` array, and two copies of one fact
// drift. `children(id)` scans, which is O(capacity) — at editor sizes (hundreds of
// nodes, called from a draw or a click) that is free, and it means `reparent` and
// `remove` cannot leave a stale list behind. The one place a scan is too slow —
// serialization — already walks every node anyway.
//
// ## Identity
//
// An id is never reused. `RemoveNode` undoing a delete has to bring back the same
// ids so that any command still holding one refers to the same node, and a
// recycled id would make a stale reference silently point at a different node.

import { Bytes } from "../bytes";
import { JsonError, JsonIn, JsonOut } from "./json";

/** The root node's id. Always present, never removed, parent of the top level. */
export const ROOT_ID: i32 = 0;
/** What a top-level node's parent is. */
export const NO_PARENT: i32 = -1;

/** The scalar properties a `SetProperty` command can address. */
export enum PropKind {
  X = 0,
  Y = 1,
  Z = 2,
  Frame = 3,
}

/** The format version this build writes. A reader refuses anything higher. */
export const FORMAT_VERSION: i32 = 1;

/**
 * One node, as a handle.
 *
 * Every accessor reads and writes the document's arrays; the handle holds no
 * state. `isValid()` is false for an id that is not alive — including one that a
 * `RemoveNode` took away — so a caller that kept a handle across an undo of an add
 * has an answer instead of an out-of-range read.
 */
export class Node {
  doc: Document;
  id: i32;

  constructor(doc: Document, id: i32) {
    this.doc = doc;
    this.id = id;
  }

  isValid(): bool {
    return this.doc.alive(this.id);
  }

  get parent(): i32 { return this.doc.parentOf(this.id); }
  set parent(value: i32) { this.doc.setParentOf(this.id, value); }

  get x(): f32 { return this.doc.xOf(this.id); }
  set x(value: f32) { this.doc.setX(this.id, value); }

  get y(): f32 { return this.doc.yOf(this.id); }
  set y(value: f32) { this.doc.setY(this.id, value); }

  get z(): i32 { return this.doc.zOf(this.id); }
  set z(value: i32) { this.doc.setZ(this.id, value); }

  get frame(): i32 { return this.doc.frameOf(this.id); }
  set frame(value: i32) { this.doc.setFrame(this.id, value); }

  get visible(): bool { return this.doc.visibleOf(this.id); }
  set visible(value: bool) { this.doc.setVisibleOf(this.id, value); }

  get name(): string { return this.doc.nameOf(this.id); }
  set name(value: string) { this.doc.setNameOf(this.id, value); }

  get selected(): bool { return this.doc.isSelected(this.id); }
  set selected(value: bool) { this.doc.select(this.id, value); }

  /** `id:name` — what a tree row shows. */
  describe(): string {
    return this.id.toString() + ":" + this.doc.nameOf(this.id);
  }
}

/**
 * One document: `capacity` node slots, of which the alive ones are the scene.
 *
 * Created with `Document.create`, or loaded with `Document.fromBytes`. Both are
 * the only ways to get one, because a document with arrays of the wrong size is
 * not a state worth representing.
 */
export class Document {
  /** How many node slots exist. Ids run `0 .. capacity-1`. */
  capacity: i32;
  /** The next id `spawn` will hand out. Monotonic: ids are never reused. */
  nextId: i32 = 1;
  /** How many nodes are alive, the root included. */
  liveCount: i32 = 0;
  /** How many nodes are selected. */
  selectionCount: i32 = 0;

  // Declared with an empty initializer and sized in the constructor: the strict
  // property-initialization check reads an assignment that follows a `this` use as
  // uninitialized, and the sizing needs `this.capacity`.
  private alives: Uint8Array = new Uint8Array(0);
  private parents: Int32Array = new Int32Array(0);
  private xs: Float32Array = new Float32Array(0);
  private ys: Float32Array = new Float32Array(0);
  private zs: Int32Array = new Int32Array(0);
  private frames: Int32Array = new Int32Array(0);
  private visibles: Uint8Array = new Uint8Array(0);
  private names: Array<string> = new Array<string>();
  private selected: Uint8Array = new Uint8Array(0);
  /** Handles, so `node(id)` does not allocate one per call. */
  private handles: Array<Node | null> = new Array<Node | null>();

  private constructor(capacity: i32) {
    this.capacity = capacity > 1 ? capacity : 2;
    this.alives = new Uint8Array(this.capacity);
    this.parents = new Int32Array(this.capacity);
    this.xs = new Float32Array(this.capacity);
    this.ys = new Float32Array(this.capacity);
    this.zs = new Int32Array(this.capacity);
    this.frames = new Int32Array(this.capacity);
    this.visibles = new Uint8Array(this.capacity);
    this.selected = new Uint8Array(this.capacity);
    this.names = new Array<string>(this.capacity);
    this.handles = new Array<Node | null>(this.capacity);
    for (let i: i32 = 0; i < this.capacity; i++) {
      this.names[i] = "";
      this.handles[i] = null;
      this.parents[i] = NO_PARENT;
    }
  }

  /** An empty document whose only node is the root. */
  static create(capacity: i32 = 256): Document {
    const doc = new Document(capacity);
    doc.reset();
    return doc;
  }

  /** Empty every slot and lay down the root. */
  private reset(): void {
    for (let i: i32 = 0; i < this.capacity; i++) {
      this.alives[i] = 0;
      this.parents[i] = NO_PARENT;
      this.selected[i] = 0;
      this.names[i] = "";
    }
    this.alives[ROOT_ID] = 1;
    this.parents[ROOT_ID] = NO_PARENT;
    this.names[ROOT_ID] = "World";
    this.visibles[ROOT_ID] = 1;
    this.nextId = 1;
    this.liveCount = 1;
    this.selectionCount = 0;
  }

  // ── nodes ───────────────────────────────────────────────────────────────

  get root(): Node {
    return this.node(ROOT_ID);
  }

  alive(id: i32): bool {
    return id >= 0 && id < this.capacity && this.alives[id] != 0;
  }

  /** The handle for `id`. Inert when the id is not alive — see `Node`. */
  node(id: i32): Node {
    if (id < 0 || id >= this.capacity) return new Node(this, NO_PARENT);
    const cached = this.handles[id];
    if (cached != null) return cached!;
    const created = new Node(this, id);
    this.handles[id] = created;
    return created;
  }

  /** A new node under `parent`, named `name`. Inert when the document is full. */
  spawn(parent: i32, name: string = "node"): Node {
    if (!this.alive(parent)) return new Node(this, NO_PARENT);
    if (this.nextId >= this.capacity) return new Node(this, NO_PARENT);
    const id: i32 = this.nextId++;
    this.insertNode(id, parent, name, 0.0, 0.0, 0, 0, true);
    return this.node(id);
  }

  /**
   * Put node `id` back exactly as given.
   *
   * The path an undo takes: `AddNode.undo` and `RemoveNode.undo` both need to
   * restore a node at a *specific* id, which `spawn` cannot do because it hands
   * out the next one. Returns false for an id that is already alive.
   */
  insertNode(id: i32, parent: i32, name: string, x: f32, y: f32, z: i32, frame: i32,
             visible: bool): bool {
    if (id < 0 || id >= this.capacity) return false;
    if (this.alives[id] != 0) return false;
    this.alives[id] = 1;
    this.parents[id] = parent;
    this.xs[id] = x;
    this.ys[id] = y;
    this.zs[id] = z;
    this.frames[id] = frame;
    this.visibles[id] = visible ? 1 : 0;
    this.names[id] = name;
    this.selected[id] = 0;
    this.liveCount++;
    if (id >= this.nextId) this.nextId = id + 1;
    return true;
  }

  /** Mark `id` dead. The caller is responsible for its children (`removeSubtree`). */
  private kill(id: i32): void {
    if (!this.alive(id) || id == ROOT_ID) return;
    if (this.selected[id] != 0) {
      this.selected[id] = 0;
      this.selectionCount--;
    }
    this.alives[id] = 0;
    this.parents[id] = NO_PARENT;
    this.names[id] = "";
    this.liveCount--;
  }

  /** `id` and its descendants, **parents before children** — an insert order. */
  subtree(id: i32): Array<i32> {
    const out = new Array<i32>();
    if (!this.alive(id)) return out;
    // Depth-first, iteratively: a document can be deep enough that the recursive
    // form is a stack question, and this one is a worklist.
    const stack = new Array<i32>();
    stack.push(id);
    while (stack.length > 0) {
      const at: i32 = stack.pop()!;
      out.push(at);
      // Reverse so the first child is visited first, which keeps the order
      // readable in a test failure.
      const kids = this.children(at);
      for (let i: i32 = kids.length - 1; i >= 0; i--) stack.push(kids[i]);
    }
    return out;
  }

  /** Remove `id` and everything under it. */
  removeSubtree(id: i32): void {
    if (id == ROOT_ID) return;
    const ids = this.subtree(id);
    // Children before parents, so `kill` never leaves a live node whose parent
    // has gone.
    for (let i: i32 = ids.length - 1; i >= 0; i--) this.kill(ids[i]);
  }

  /** The live children of `parent`, in id order. */
  children(parent: i32): Array<i32> {
    const out = new Array<i32>();
    if (!this.alive(parent)) return out;
    for (let i: i32 = 0; i < this.capacity; i++) {
      if (this.alives[i] != 0 && this.parents[i] == parent) out.push(i);
    }
    return out;
  }

  /** Every live id, in ascending order — the root first. */
  ids(): Array<i32> {
    const out = new Array<i32>();
    for (let i: i32 = 0; i < this.capacity; i++) {
      if (this.alives[i] != 0) out.push(i);
    }
    return out;
  }

  /** Whether `ancestor` is `id`'s parent, grandparent, … The root is everyone's. */
  isAncestor(ancestor: i32, id: i32): bool {
    if (!this.alive(ancestor) || !this.alive(id)) return false;
    let walk: i32 = this.parents[id];
    let guard: i32 = 0;
    while (walk != NO_PARENT && guard < this.capacity) {
      if (walk == ancestor) return true;
      walk = this.parents[walk];
      guard++;
    }
    return false;
  }

  // ── properties ──────────────────────────────────────────────────────────

  parentOf(id: i32): i32 {
    return this.alive(id) ? this.parents[id] : NO_PARENT;
  }

  setParentOf(id: i32, parent: i32): void {
    if (!this.alive(id) || id == ROOT_ID) return;
    if (!this.alive(parent)) return;
    if (parent == id || this.isAncestor(id, parent)) return; // no cycles
    this.parents[id] = parent;
  }

  xOf(id: i32): f32 { return this.alive(id) ? this.xs[id] : 0.0; }
  yOf(id: i32): f32 { return this.alive(id) ? this.ys[id] : 0.0; }
  zOf(id: i32): i32 { return this.alive(id) ? this.zs[id] : 0; }
  frameOf(id: i32): i32 { return this.alive(id) ? this.frames[id] : 0; }
  visibleOf(id: i32): bool { return this.alive(id) && this.visibles[id] != 0; }
  nameOf(id: i32): string { return this.alive(id) ? this.names[id] : ""; }
  isSelected(id: i32): bool { return this.alive(id) && this.selected[id] != 0; }

  setX(id: i32, value: f32): void { if (this.alive(id)) this.xs[id] = value; }
  setY(id: i32, value: f32): void { if (this.alive(id)) this.ys[id] = value; }
  setZ(id: i32, value: i32): void { if (this.alive(id)) this.zs[id] = value; }
  setFrame(id: i32, value: i32): void { if (this.alive(id)) this.frames[id] = value; }
  setVisibleOf(id: i32, value: bool): void { if (this.alive(id)) this.visibles[id] = value ? 1 : 0; }
  setNameOf(id: i32, value: string): void { if (this.alive(id)) this.names[id] = value; }

  /** A property by kind, so `SetProperty` is one command rather than four. */
  number(id: i32, kind: PropKind): f32 {
    if (kind == PropKind.X) return this.xOf(id);
    if (kind == PropKind.Y) return this.yOf(id);
    if (kind == PropKind.Z) return <f32>this.zOf(id);
    if (kind == PropKind.Frame) return <f32>this.frameOf(id);
    return 0.0;
  }

  setNumber(id: i32, kind: PropKind, value: f32): void {
    if (kind == PropKind.X) { this.setX(id, value); return; }
    if (kind == PropKind.Y) { this.setY(id, value); return; }
    if (kind == PropKind.Z) { this.setZ(id, <i32>value); return; }
    if (kind == PropKind.Frame) this.setFrame(id, <i32>value);
  }

  select(id: i32, on: bool): void {
    if (!this.alive(id)) return;
    const want: u8 = on ? 1 : 0;
    if (this.selected[id] == want) return;
    this.selected[id] = want;
    this.selectionCount += on ? 1 : -1;
  }

  clearSelection(): void {
    for (let i: i32 = 0; i < this.capacity; i++) this.selected[i] = 0;
    this.selectionCount = 0;
  }

  /** The first selected id, or `NO_PARENT` — what a panel shows by default. */
  firstSelected(): i32 {
    for (let i: i32 = 0; i < this.capacity; i++) {
      if (this.alives[i] != 0 && this.selected[i] != 0) return i;
    }
    return NO_PARENT;
  }

  // ── serialization ───────────────────────────────────────────────────────

  /**
   * The document as JSON, in `Bytes`.
   *
   * Only the **live** nodes are written, in id order, and the ids are theirs —
   * so a reload re-creates the same nodes and a command holding an id still means
   * the same thing. A dead node leaves no trace, which is what makes this a
   * snapshot of the *scene* rather than a journal of the session.
   *
   * **The id counter is not in the file.** `nextId` is session state — it exists so
   * an id is never reused *within* a run, and serializing it would make an undo of
   * an add leave a different file behind than the one before it, for a reason that
   * has nothing to do with the scene. A load derives it as one past the highest id
   * it read, which is monotonic from that point on; the only thing the file cannot
   * carry is the memory of a deleted node's id, and a command that remembered one
   * does not survive the save either.
   *
   *     {"version":1,"capacity":256,"nodes":[
   *       {"id":0,"parent":-1,"x":0,"y":0,"z":0,"frame":0,"visible":true,"name":"World"},
   *       …
   *     ]}
   */
  toBytes(): Bytes {
    const out = new JsonOut();
    out.beginObject();
    out.key("version").number(<f32>FORMAT_VERSION);
    out.key("capacity").number(<f32>this.capacity);
    out.key("nodes").beginArray();
    const ids = this.ids();
    for (let i: i32 = 0; i < ids.length; i++) {
      const id: i32 = ids[i];
      out.beginObject();
      out.key("id").number(<f32>id);
      out.key("parent").number(<f32>this.parents[id]);
      out.key("x").number(this.xs[id]);
      out.key("y").number(this.ys[id]);
      out.key("z").number(<f32>this.zs[id]);
      out.key("frame").number(<f32>this.frames[id]);
      out.key("visible").bool(this.visibles[id] != 0);
      out.key("name").string(this.names[id]);
      out.endObject();
    }
    out.endArray();
    out.endObject();
    return out.finish();
  }

  /**
   * Load a document. Never throws: a malformed one answers an empty document and
   * fills `error`, so a caller can say *why* rather than showing an empty scene.
   */
  static fromBytes(bytes: Bytes, error: JsonError | null = null): Document {
    const sink: JsonError = error != null ? error! : new JsonError();
    const doc = Document.create(256);
    if (bytes.isEmpty) {
      sink.message = "the document is empty";
      return doc;
    }
    const input = new JsonIn(bytes, sink);

    // Capacity first, so the arrays are sized before any node lands. A second
    // pass would be the alternative; the format writes it first for this reason.
    let capacity: i32 = 0;
    let version: i32 = 0;

    // A scan for `version`, `capacity` and `nextId` before the nodes array: the
    // reader has no rewind, and the node pass needs the capacity. Two passes over
    // one file is cheaper than a growable document.
    if (!input.enterObject()) return doc;
    while (!input.tryCloseObject() && !input.failed) {
      const name = input.key();
      if (name == "version") version = <i32>input.number();
      else if (name == "capacity") capacity = <i32>input.number();
      else input.skipValue();
      input.tryComma();
    }
    if (!sink.ok) return doc;
    if (version > FORMAT_VERSION) {
      sink.message = "the document is version " + version.toString() +
        ", and this build reads up to " + FORMAT_VERSION.toString();
      return doc;
    }

    const loaded = new Document(capacity > 1 ? capacity : 256);
    loaded.reset();

    const second = new JsonIn(bytes, sink);
    if (!second.enterObject()) return loaded;
    while (!second.tryCloseObject() && !second.failed) {
      const name = second.key();
      if (name != "nodes") {
        second.skipValue();
        second.tryComma();
        continue;
      }
      if (!second.enterArray()) return loaded;
      while (!second.tryCloseArray() && !second.failed) {
        readNode(loaded, second);
        second.tryComma();
      }
      second.tryComma();
    }
    // `insertNode` keeps `nextId` one past the highest id it has seen, which is
    // the only counter a loaded document needs.
    if (!sink.ok) return Document.create(capacity);
    return loaded;
  }
}

/**
 * Read one `{…}` into `doc`.
 *
 * Field order is the writer's, but nothing here depends on it: every field is
 * applied when it is seen, and a node is inserted at the end with whatever it
 * collected. That is what lets a document from a newer build — with an extra
 * field — load, and lets a hand-edited file put `name` before `id`.
 */
function readNode(doc: Document, input: JsonIn): void {
  if (!input.enterObject()) return;
  let id: i32 = -1;
  let parent: i32 = NO_PARENT;
  let x: f32 = 0.0;
  let y: f32 = 0.0;
  let z: i32 = 0;
  let frame: i32 = 0;
  let visible: bool = true;
  let name: string = "node";
  while (!input.tryCloseObject() && !input.failed) {
    const key = input.key();
    if (key == "id") id = <i32>input.number();
    else if (key == "parent") parent = <i32>input.number();
    else if (key == "x") x = input.number();
    else if (key == "y") y = input.number();
    else if (key == "z") z = <i32>input.number();
    else if (key == "frame") frame = <i32>input.number();
    else if (key == "visible") visible = input.bool();
    else if (key == "name") name = input.string();
    else input.skipValue();
    input.tryComma();
  }
  if (id < 0) return;
  if (id == ROOT_ID) {
    // The root already exists from `reset`; a file's copy fills in its fields.
    doc.setNameOf(ROOT_ID, name);
    doc.setX(ROOT_ID, x);
    doc.setY(ROOT_ID, y);
    return;
  }
  doc.insertNode(id, parent, name, x, y, z, frame, visible);
}
