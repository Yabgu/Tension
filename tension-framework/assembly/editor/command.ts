// Commands and the undo stack.
//
// ## The rule this file exists for
//
// **A document setter does not record itself.** `Document.setX` moves a number;
// it does not push an undo entry. Every edit is made *through* a command, and the
// command is what the `History` sees — which is why `RemoveNode` can undo a whole
// subtree and `Reparent` can put a node back where it was, neither of which is a
// single setter call.
//
// ## Why commands are classes and not closures
//
// The obvious `History.exec(doc, () => { … }, () => { … })` shape does not work
// here: a closure over a *stack local* is the shape that traps on this toolchain
// (`scene.ts` records the four measurements, `FrameStep` is the interface it
// forced). It also cannot `merge`, which is what turns a drag into one undo entry.
// So a command is an object with `apply`/`undo`/`merge` and its state in fields.
//
// ## Undo is a stack of objects, not a stack of snapshots
//
// Snapshotting the document per edit is simpler and wrong: a document is hundreds
// of nodes, and a copy per keystroke is the kind of thing that works in a demo and
// stalls on a real scene. Each command captures **only what it changes**, at the
// moment it first applies — and a `RemoveNode` captures the subtree it deletes,
// which is the one case where "only what it changes" is a lot.

import { Document, NO_PARENT, PropKind, ROOT_ID } from "./document";

/**
 * One edit, undoable.
 *
 * `apply` is called for the first time by `History.exec` and again on every redo;
 * it must therefore be idempotent with respect to what it captures (a second
 * `apply` re-does the change without re-recording the old value — otherwise a
 * redo would learn the *new* state as the old one and the undo would do nothing).
 */
export interface Command {
  apply(doc: Document): void;
  undo(doc: Document): void;
  /**
   * Fold `next` into this command if they are the same edit continued.
   *
   * Called **after** `next` has been applied, so a `SetX` drag merges by taking
   * the newer value while keeping the older "before". True means "no new undo
   * entry" — the two edits are one.
   */
  merge(next: Command): bool;
  /** What a menu or a status line shows. */
  label(): string;
}

/** An id for a command created before the document is touched. */
export const ALLOCATE_ID: i32 = 0;

/**
 * Add one node.
 *
 * `id` may be `ALLOCATE_ID`, in which case the document's next id is used and
 * remembered — the shape a palette button needs, because it makes the command
 * before it can know what the document will hand out.
 */
export class AddNode implements Command {
  id: i32;
  parent: i32;
  name: string;
  x: f32;
  y: f32;
  private placed: bool = false;

  constructor(id: i32, parent: i32, name: string, x: f32 = 0.0, y: f32 = 0.0) {
    this.id = id;
    this.parent = parent;
    this.name = name;
    this.x = x;
    this.y = y;
  }

  apply(doc: Document): void {
    if (this.id == ALLOCATE_ID) {
      const created = doc.spawn(this.parent, this.name);
      this.id = created.id;
      if (this.id == NO_PARENT) return;          // the document is full
      doc.setX(this.id, this.x);
      doc.setY(this.id, this.y);
      this.placed = true;
      return;
    }
    if (doc.insertNode(this.id, this.parent, this.name, this.x, this.y, 0, 0, true)) {
      this.placed = true;
    }
  }

  undo(doc: Document): void {
    if (!this.placed) return;
    doc.removeSubtree(this.id);
    this.placed = false;
  }

  merge(next: Command): bool { return false; }

  label(): string { return "add " + this.name; }
}

/**
 * Remove a node and everything under it.
 *
 * **The subtree is captured, not recomputed.** Undoing a delete has to bring back
 * the same ids with the same transforms and the same names; a command that only
 * remembered the id would restore an empty node and call it undone. The capture
 * happens once, on the first `apply` — a redo re-removes what the undo restored,
 * and must not overwrite the snapshot with the empty state it is looking at.
 */
export class RemoveNode implements Command {
  id: i32;
  private captured: bool = false;
  private ids: Array<i32> = new Array<i32>();
  private parents: Array<i32> = new Array<i32>();
  private names: Array<string> = new Array<string>();
  private xs: Array<f32> = new Array<f32>();
  private ys: Array<f32> = new Array<f32>();
  private zs: Array<i32> = new Array<i32>();
  private frames: Array<i32> = new Array<i32>();
  private visibles: Array<bool> = new Array<bool>();

  constructor(id: i32) {
    this.id = id;
  }

  apply(doc: Document): void {
    if (!doc.alive(this.id)) return;
    if (!this.captured) this.capture(doc);
    doc.removeSubtree(this.id);
  }

  private capture(doc: Document): void {
    this.ids = [];
    this.parents = [];
    this.names = [];
    this.xs = [];
    this.ys = [];
    this.zs = [];
    this.frames = [];
    this.visibles = [];
    // `subtree` answers parents before children, which is the order that can be
    // re-inserted: a child whose parent is not there yet would be orphaned.
    const ids = doc.subtree(this.id);
    for (let i: i32 = 0; i < ids.length; i++) {
      const id: i32 = ids[i];
      this.ids.push(id);
      this.parents.push(doc.parentOf(id));
      this.names.push(doc.nameOf(id));
      this.xs.push(doc.xOf(id));
      this.ys.push(doc.yOf(id));
      this.zs.push(doc.zOf(id));
      this.frames.push(doc.frameOf(id));
      this.visibles.push(doc.visibleOf(id));
    }
    this.captured = true;
  }

  undo(doc: Document): void {
    if (!this.captured) return;
    for (let i: i32 = 0; i < this.ids.length; i++) {
      doc.insertNode(this.ids[i], this.parents[i], this.names[i], this.xs[i], this.ys[i],
                     this.zs[i], this.frames[i], this.visibles[i]);
    }
  }

  merge(next: Command): bool { return false; }

  label(): string { return "remove " + this.id.toString(); }

  /** How many nodes the delete took — what a status line can report. */
  get capturedCount(): i32 { return this.ids.length; }
}

/**
 * Set one node's `x`.
 *
 * The drag case, and the reason `merge` exists: a mouse drag emits one of these
 * per frame, and 60 undo entries for one gesture is not an undo stack a person can
 * use. Merging keeps the *first* "before" and the *last* "after", so one undo
 * returns the node to where the drag started.
 */
export class SetX implements Command {
  id: i32;
  value: f32;
  private before: f32 = 0.0;
  private after: f32 = 0.0;
  private haveBefore: bool = false;

  constructor(id: i32, value: f32) {
    this.id = id;
    this.value = value;
  }

  apply(doc: Document): void {
    if (!this.haveBefore) {
      this.before = doc.xOf(this.id);
      this.haveBefore = true;
    }
    this.after = this.value;
    doc.setX(this.id, this.after);
  }

  undo(doc: Document): void {
    doc.setX(this.id, this.before);
  }

  merge(next: Command): bool {
    if (!(next instanceof SetX)) return false;
    const other = <SetX>next;
    if (other.id != this.id) return false;
    this.after = other.after;
    return true;
  }

  label(): string { return "x = " + this.after.toString(); }
}

/** `SetX` for `y`. Separate class so a drag on one axis cannot merge into the other. */
export class SetY implements Command {
  id: i32;
  value: f32;
  private before: f32 = 0.0;
  private after: f32 = 0.0;
  private haveBefore: bool = false;

  constructor(id: i32, value: f32) {
    this.id = id;
    this.value = value;
  }

  apply(doc: Document): void {
    if (!this.haveBefore) {
      this.before = doc.yOf(this.id);
      this.haveBefore = true;
    }
    this.after = this.value;
    doc.setY(this.id, this.after);
  }

  undo(doc: Document): void {
    doc.setY(this.id, this.before);
  }

  merge(next: Command): bool {
    if (!(next instanceof SetY)) return false;
    const other = <SetY>next;
    if (other.id != this.id) return false;
    this.after = other.after;
    return true;
  }

  label(): string { return "y = " + this.after.toString(); }
}

/**
 * Set any scalar property, by kind.
 *
 * The one command an inspector needs: a property row is `(node, kind, value)`, and
 * a numeric field that emits one of these per keystroke merges the same way a drag
 * does.
 */
export class SetProperty implements Command {
  id: i32;
  kind: PropKind;
  value: f32;
  private before: f32 = 0.0;
  private after: f32 = 0.0;
  private haveBefore: bool = false;

  constructor(id: i32, kind: PropKind, value: f32) {
    this.id = id;
    this.kind = kind;
    this.value = value;
  }

  apply(doc: Document): void {
    if (!this.haveBefore) {
      this.before = doc.number(this.id, this.kind);
      this.haveBefore = true;
    }
    this.after = this.value;
    doc.setNumber(this.id, this.kind, this.after);
  }

  undo(doc: Document): void {
    doc.setNumber(this.id, this.kind, this.before);
  }

  merge(next: Command): bool {
    if (!(next instanceof SetProperty)) return false;
    const other = <SetProperty>next;
    if (other.id != this.id || other.kind != this.kind) return false;
    this.after = other.after;
    return true;
  }

  label(): string { return "set " + this.kind.toString(); }
}

/**
 * Move a node under a different parent.
 *
 * Refused by the document when the new parent is inside the moving subtree — a
 * node cannot be its own ancestor — so `apply` on such a pair is a no-op, and the
 * history entry it leaves undoes to the same place it started.
 */
export class Reparent implements Command {
  id: i32;
  parent: i32;
  private before: i32 = NO_PARENT;
  private haveBefore: bool = false;

  constructor(id: i32, parent: i32) {
    this.id = id;
    this.parent = parent;
  }

  apply(doc: Document): void {
    if (!this.haveBefore) {
      this.before = doc.parentOf(this.id);
      this.haveBefore = true;
    }
    doc.setParentOf(this.id, this.parent);
  }

  undo(doc: Document): void {
    doc.setParentOf(this.id, this.before);
  }

  merge(next: Command): bool { return false; }

  label(): string { return "reparent " + this.id.toString(); }
}

/**
 * The undo stack.
 *
 * Two stacks and a limit. `exec` is the only entry point for a new edit — it
 * applies, offers the top of the undo stack a chance to merge, and clears redo
 * (because an edit after an undo is a new branch, and a redo stack from the old
 * one would apply a command whose "before" no longer holds).
 */
export class History {
  /** How many undo entries are kept. The oldest is dropped past this. */
  limit: i32 = 200;
  private undos: Array<Command> = new Array<Command>();
  private redos: Array<Command> = new Array<Command>();

  static create(limit: i32 = 200): History {
    const history = new History();
    history.limit = limit > 0 ? limit : 1;
    return history;
  }

  /** Apply `cmd`, merging it into the previous edit when that edit says so. */
  exec(doc: Document, cmd: Command): bool {
    cmd.apply(doc);
    // A new edit invalidates the redo branch before anything else looks at it.
    this.redos = new Array<Command>();
    if (this.undos.length > 0) {
      const top = this.undos[this.undos.length - 1];
      if (top.merge(cmd)) return true;
    }
    this.undos.push(cmd);
    while (this.undos.length > this.limit) this.undos.shift();
    return true;
  }

  undo(doc: Document): bool {
    if (this.undos.length == 0) return false;
    const cmd = this.undos.pop()!;
    cmd.undo(doc);
    this.redos.push(cmd);
    return true;
  }

  redo(doc: Document): bool {
    if (this.redos.length == 0) return false;
    const cmd = this.redos.pop()!;
    cmd.apply(doc);
    this.undos.push(cmd);
    return true;
  }

  get canUndo(): bool { return this.undos.length > 0; }
  get canRedo(): bool { return this.redos.length > 0; }
  get undoCount(): i32 { return this.undos.length; }
  get redoCount(): i32 { return this.redos.length; }

  /** What a menu would offer to undo, or "" when there is nothing. */
  undoLabel(): string {
    return this.undos.length == 0 ? "" : this.undos[this.undos.length - 1].label();
  }

  redoLabel(): string {
    return this.redos.length == 0 ? "" : this.redos[this.redos.length - 1].label();
  }

  clear(): void {
    this.undos = new Array<Command>();
    this.redos = new Array<Command>();
  }
}
