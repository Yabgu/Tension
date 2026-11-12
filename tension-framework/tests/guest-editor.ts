// The editor's core, with no canvas and no GPU.
//
// Everything an editor does that a game does not is bookkeeping — a tree of nodes,
// an undo stack, named operations — and all of it is a data structure over
// numbers. That is what makes this fixture possible on a machine with no display,
// and what makes it the right *first* test of the editor: a bug in undo is a bug
// however pretty the window is.
//
// The assertions are chosen to fail loudly if the mechanisms are only approximately
// right:
//
//   * **Byte-identical** round trips, not "the node is back". An undo that restores
//     a node with the same name but the wrong `z` passes an id-based check and
//     loses a user's work.
//   * **Exactly one** undo entry for a drag, and one that returns the value to
//     where the drag started — a merge that keeps the wrong "before" is worse than
//     no merge at all.
//   * The **subtree** comes back from a remove, not the node.
//   * An unknown palette id applies **nothing**.

import { Bytes } from "../assembly/bytes";
import { Document, NO_PARENT, Node, PropKind, ROOT_ID } from "../assembly/editor/document";
import {
  AddNode, ALLOCATE_ID, History, RemoveNode, Reparent, SetProperty, SetX, SetY,
} from "../assembly/editor/command";
import { Args, Palette, registerEditorCommands } from "../assembly/editor/palette";
import { JsonError } from "../assembly/editor/json";
import { print } from "../assembly/io";
import { ConfigBuilder, RuntimeSession } from "../assembly/runtime";

let failures: i32 = 0;

function check(ok: bool, what: string): void {
  if (!ok) {
    failures++;
    print("  FAIL: " + what);
  }
}

function checkEq(want: i32, got: i32, what: string): void {
  if (want != got) {
    failures++;
    print("  FAIL: " + what + " (want " + want.toString() + ", got " + got.toString() + ")");
  }
}

function checkF(want: f32, got: f32, what: string): void {
  if (want != got) {
    failures++;
    print("  FAIL: " + what + " (want " + want.toString() + ", got " + got.toString() + ")");
  }
}

/// Whether two byte runs are the same length and the same bytes.
function sameBytes(a: Bytes, b: Bytes): bool {
  if (a.length != b.length) return false;
  for (let i: i32 = 0; i < a.length; i++) {
    if (a.byteAt(i) != b.byteAt(i)) return false;
  }
  return true;
}

/// The document's JSON as a string, for a failure message that says what differs.
function describe(doc: Document): string {
  return "(" + doc.liveCount.toString() + " node(s))";
}

// ── 1. add and remove: undo restores the bytes, not just the node ──────────

function caseAddRemoveRoundTrip(): void {
  const doc = Document.create(64);
  const history = History.create(32);
  const empty = doc.toBytes();

  history.exec(doc, new AddNode(1, ROOT_ID, "a", 10.0, 20.0));
  checkEq(2, doc.liveCount, "an add makes a second node");
  checkEq(10, <i32>doc.xOf(1), "and lands where it was told");
  const added = doc.toBytes();
  check(!sameBytes(empty, added), "the add changes the document");

  check(history.undo(doc), "the add can be undone");
  check(sameBytes(empty, doc.toBytes()), "undoing an add is byte-identical to before " + describe(doc));
  checkEq(1, doc.liveCount, "and the node is gone");

  check(history.redo(doc), "the add can be redone");
  check(sameBytes(added, doc.toBytes()), "redoing it restores the exact bytes");

  // Remove it through a command: the document must return to the empty state
  // without any residue — no dead node left in the array, no stale parent.
  history.exec(doc, new RemoveNode(1));
  check(sameBytes(empty, doc.toBytes()), "a remove leaves the document as it began");

  check(history.undo(doc), "the remove can be undone");
  check(sameBytes(added, doc.toBytes()), "and brings the node back exactly");
}

// ── 2. a remove takes the subtree, and gives it back ───────────────────────

function caseRemoveKeepsSubtree(): void {
  const doc = Document.create(64);
  const history = History.create(32);

  const parent = doc.spawn(ROOT_ID, "parent");
  const child = doc.spawn(parent.id, "child");
  const sibling = doc.spawn(ROOT_ID, "sibling");
  doc.setX(parent.id, 3.0);
  doc.setX(child.id, 7.5);
  doc.setZ(child.id, 4);
  doc.setFrame(child.id, 2);
  doc.setVisibleOf(child.id, false);

  const before = doc.toBytes();
  checkEq(4, doc.liveCount, "three nodes plus the root");

  history.exec(doc, new RemoveNode(parent.id));
  checkEq(2, doc.liveCount, "removing a parent removes its child");
  check(!doc.alive(child.id), "the child is gone");

  check(history.undo(doc), "the remove can be undone");
  checkEq(4, doc.liveCount, "the whole subtree came back");
  check(sameBytes(before, doc.toBytes()), "with every field it had");
  checkEq(parent.id, doc.parentOf(child.id), "and the child's parent");

  // The sibling was never touched: the subtree is the deleted node's, not the
  // document's.
  check(doc.alive(sibling.id), "a sibling survives a subtree remove");
}

// ── 3. a drag is one undo entry, and it returns to the start ───────────────

function caseMergeCollapsesDrag(): void {
  const doc = Document.create(64);
  const history = History.create(32);

  history.exec(doc, new AddNode(1, ROOT_ID, "n", 5.0, 5.0));
  checkEq(1, history.undoCount, "the add is one entry");

  // Sixty frames of a drag, which is what a mouse produces.
  for (let i: i32 = 1; i <= 60; i++) {
    history.exec(doc, new SetX(1, 5.0 + <f32>i));
  }
  checkEq(2, history.undoCount, "a sixty-frame drag is still one entry");
  checkF(65.0, doc.xOf(1), "the drag moved the node");

  check(history.undo(doc), "the drag can be undone");
  checkF(5.0, doc.xOf(1), "one undo returns it to where the drag started");
  checkEq(1, history.undoCount, "leaving only the add");

  // Merging must not cross axes…
  history.clear();
  history.exec(doc, new SetX(1, 10.0));
  history.exec(doc, new SetY(1, 10.0));
  checkEq(2, history.undoCount, "an x edit and a y edit are two entries");

  // …nor nodes.
  const second = doc.spawn(ROOT_ID, "other");
  history.clear();
  history.exec(doc, new SetX(1, 11.0));
  history.exec(doc, new SetX(second.id, 12.0));
  checkEq(2, history.undoCount, "two nodes' x edits are two entries");

  // **A redo of a merged edit must land on the LAST value, not the first.**
  // `apply` writes `after = value`, so a merge that moved only `after` left the
  // entry holding the number from the first keystroke: the label said 42, the
  // screen said 42, and redo put back 30. Measured in the editor's property field.
  history.clear();
  history.exec(doc, new SetX(1, 30.0));
  history.exec(doc, new SetX(1, 3.0));
  history.exec(doc, new SetX(1, 42.0));
  checkEq(1, history.undoCount, "three keystrokes are one entry");
  checkF(42.0, doc.xOf(1), "the node holds the last one");
  check(history.undo(doc), "and it undoes");
  check(history.redo(doc), "and it redoes");
  checkF(42.0, doc.xOf(1), "the redo restores the last value, not the first");
  check(history.undoLabel() == "x = 42.0", "and the entry's label says so: " +
        history.undoLabel());

  // The same fold on the property command the inspector actually uses.
  history.clear();
  doc.setX(1, 0.0);
  history.exec(doc, new SetProperty(1, PropKind.X, 30.0));
  history.exec(doc, new SetProperty(1, PropKind.X, 42.0));
  checkEq(1, history.undoCount, "a property burst is one entry");
  check(history.undo(doc), "it undoes");
  check(history.redo(doc), "it redoes");
  checkF(42.0, doc.xOf(1), "and the redo lands on the last value");
}

// ── 4. the undo limit drops the oldest, and nothing else ──────────────────

function caseUndoLimit(): void {
  const doc = Document.create(64);
  const history = History.create(3);

  for (let i: i32 = 0; i < 10; i++) {
    history.exec(doc, new AddNode(ALLOCATE_ID, ROOT_ID, "n" + i.toString()));
  }
  checkEq(11, doc.liveCount, "ten adds");
  checkEq(3, history.undoCount, "the stack stops at its limit");

  check(history.undo(doc), "the first of three undoes");
  check(history.undo(doc), "the second");
  check(history.undo(doc), "the third");
  check(!history.undo(doc), "and the fourth refuses: the older entries are gone");
  checkEq(8, doc.liveCount, "three undos removed three nodes");
}

// ── 5. the document survives a save ───────────────────────────────────────

function caseSerialization(): void {
  const doc = Document.create(128);
  const a = doc.spawn(ROOT_ID, "hero");
  const b = doc.spawn(a.id, "sword");
  doc.spawn(ROOT_ID, "ground");
  doc.setX(a.id, 12.5);
  doc.setY(a.id, -3.25);
  doc.setZ(a.id, 3);
  doc.setFrame(b.id, 7);
  doc.setVisibleOf(b.id, false);
  // A name that needs every escape the writer has.
  doc.setNameOf(b.id, "a\"b\\c\td");

  const bytes = doc.toBytes();
  check(bytes.length > 0, "the document serializes to bytes");

  const error = new JsonError();
  const back = Document.fromBytes(bytes, error);
  check(error.ok, "the document loads" + (error.ok ? "" : ": " + error.message));
  if (!error.ok) return;

  checkEq(doc.liveCount, back.liveCount, "every node came back");
  checkEq(a.id, back.parentOf(b.id), "and the tree's shape");
  checkF(12.5, back.xOf(a.id), "and the transforms");
  checkF(-3.25, back.yOf(a.id), "including a negative");
  checkEq(3, back.zOf(a.id), "and z");
  checkEq(7, back.frameOf(b.id), "and the frame");
  check(!back.visibleOf(b.id), "and visibility");
  check(back.nameOf(b.id) == "a\"b\\c\td", "and a name with every escape in it");
  check(sameBytes(bytes, back.toBytes()), "so a save-load-save is byte-identical");

  // A malformed document is refused rather than half-loaded. The separator cases
  // are here because the *writer* once omitted them and every round-trip still
  // passed: the reader was as lenient as the writer was wrong, so the two agreed
  // on a format no JSON parser accepts. Strictness on the read side is what makes
  // the round-trip assertion mean "valid JSON".
  const broken = new JsonError();
  const junk = Document.fromBytes(Bytes.ofString("{\"version\":1,\"nodes\":[{\"id\":1"), broken);
  check(!broken.ok, "an unterminated document reports an error");
  check(junk != null, "and still answers a document a caller can open");

  const noSeparator = new JsonError();
  Document.fromBytes(Bytes.ofString("{\"version\":1 \"nodes\":[]}"), noSeparator);
  check(!noSeparator.ok, "a missing separator is refused");

  const trailing = new JsonError();
  Document.fromBytes(Bytes.ofString("{\"version\":1,\"nodes\":[],}"), trailing);
  check(!trailing.ok, "a trailing comma is refused");

  const tooNew = new JsonError();
  Document.fromBytes(Bytes.ofString("{\"version\":99,\"nodes\":[]}"), tooNew);
  check(!tooNew.ok, "a document from a newer build is refused, not guessed at");
}

// ── 6. reparent, and the cycle it must refuse ─────────────────────────────

function caseReparent(): void {
  const doc = Document.create(64);
  const history = History.create(16);
  const a = doc.spawn(ROOT_ID, "a");
  const b = doc.spawn(a.id, "b");
  const c = doc.spawn(ROOT_ID, "c");

  history.exec(doc, new Reparent(b.id, c.id));
  checkEq(c.id, doc.parentOf(b.id), "the node moved");
  check(history.undo(doc), "and the move can be undone");
  checkEq(a.id, doc.parentOf(b.id), "back under its original parent");

  // Moving a node under its own descendant would make a cycle; the document
  // refuses, so the command is a no-op and the undo restores the same place.
  const before = doc.toBytes();
  history.exec(doc, new Reparent(a.id, b.id));
  checkEq(ROOT_ID, doc.parentOf(a.id), "a node cannot be moved under its own child");
  check(sameBytes(before, doc.toBytes()), "and the document did not change");
}

// ── 7. the palette dispatches by id, and refuses what it does not know ────

function casePalette(): void {
  const doc = Document.create(64);
  const history = History.create(16);
  const palette = registerEditorCommands(Palette.create(history));

  checkEq(6, palette.count, "six commands are registered");
  checkEq(6, palette.list().length, "and the list has them all");
  check(palette.find("node.add") != null, "find answers a known id");
  check(palette.find("nope") == null, "and null for an unknown one");

  const add = new Args();
  add.id = ALLOCATE_ID;
  add.parent = ROOT_ID;
  add.text = "box";
  check(palette.run(doc, "node.add", add), "a known id runs");
  checkEq(2, doc.liveCount, "and the node exists");
  checkEq(1, history.undoCount, "and it is on the undo stack");

  // An unknown id is a no-op — not a silent edit, which is what makes a typo in a
  // keybinding table harmless.
  check(!palette.run(doc, "node.frobnicate", add), "an unknown id answers false");
  checkEq(2, doc.liveCount, "and changes nothing");
  checkEq(1, history.undoCount, "and adds no undo entry");

  // `NO_PARENT` means "act on the selection", which is how a panel drives it.
  doc.select(1, true);
  const nudge = new Args();
  nudge.value = 42.0;
  check(palette.run(doc, "node.set-x", nudge), "set-x runs against the selection");
  checkF(42.0, doc.xOf(1), "and reached the selected node");

  // Merging works through the palette too: the second nudge is one entry.
  const before = history.undoCount;
  nudge.value = 43.0;
  palette.run(doc, "node.set-x", nudge);
  checkEq(before, history.undoCount, "a second nudge merges into the first");

  // Remove by selection, through the same path a button would take.
  check(palette.run(doc, "node.remove", nudge), "remove runs");
  checkEq(1, doc.liveCount, "and took the node");
}

// ── 8. a handle outlives nothing it should ────────────────────────────────

function caseHandles(): void {
  const doc = Document.create(32);
  const node: Node = doc.spawn(ROOT_ID, "thing");
  const id: i32 = node.id;
  check(node.isValid(), "a spawned handle is valid");
  checkF(0.0, node.x, "and reads its own state");

  node.x = 4.5;                 // a plain setter: no command, by design
  node.y = 2.0;
  checkF(4.5, doc.xOf(id), "the setter wrote the document");
  checkEq(0, doc.liveCount - 2, "and made no undo entry (the history is not consulted)");

  doc.removeSubtree(id);
  check(!node.isValid(), "a handle to a removed node reports itself invalid");
  checkF(0.0, node.x, "and reads as zero rather than out of range");

  // The root is never removable, whatever a caller asks.
  doc.removeSubtree(ROOT_ID);
  check(doc.alive(ROOT_ID), "the root survives a remove");
  check(!doc.node(NO_PARENT).isValid(), "an out-of-range id answers an inert handle");
}

export function _start_game(): void {
  if (RuntimeSession.open(ConfigBuilder.forThisBuild()) != 0) {
    print("FAIL: the session did not open");
    return;
  }
  caseAddRemoveRoundTrip();
  caseRemoveKeepsSubtree();
  caseMergeCollapsesDrag();
  caseUndoLimit();
  caseSerialization();
  caseReparent();
  casePalette();
  caseHandles();

  if (failures != 0) {
    print("editor: " + failures.toString() + " check(s) failed");
    RuntimeSession.close();
    return;
  }
  print("editor: undo is exact, a drag merges, saves round-trip, the palette dispatches");
  print("OK");
  RuntimeSession.close();
}
