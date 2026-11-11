// The editor's pure core: a document, the commands that change it, and the
// registry a UI invokes them through.
//
// ## No canvas, no window, no frame
//
// Nothing in this directory touches a `Canvas`, a `Scene`, or the runtime's
// session. That is not a limitation, it is the design: everything an editor does
// that a *game* does not is bookkeeping — a tree of nodes, an undo stack, a set of
// named operations — and bookkeeping is testable on a machine with no display.
// `guest-editor.ts` proves it, and Pass 3's shell is then only drawing.
//
// ## The three pieces, and the rule between them
//
//   * `document.ts` — the data. Plain setters; no command is implied by one.
//   * `command.ts`  — the edits. Each captures what it changes, so undo is exact.
//   * `palette.ts`  — the names. A factory per command, dispatchable by id.
//
// The rule: **an edit a user can make is a command**, and a setter is only ever
// called by a command (or by a load). A code path that writes the document
// directly is a path with no undo, and the tests cannot see it — so the shell's
// rule is that it never writes, it dispatches.
//
// ## What this is not
//
// Not the editor's UI (Pass 3), not a viewport (Pass 4), and not a file format for
// a *project* — a document is one scene graph, saved as JSON through
// `Document.toBytes`. Reloading a changed script is Pass 5's problem, and it works
// because a document survives a process: that is what the save format is for.

export * from "./document";
export * from "./command";
export * from "./palette";
export * from "./json";
