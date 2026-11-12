# tension-editor — the document, the commands, the palette

The editor's *core* is a document, a set of undoable edits, and a registry that
names them. It draws nothing. That split is the design, not an early stage: an
editor's hard part is not the window, it is that every change has to be reversible
and every change has to be expressible as one thing a user can name ("undo *move
node*"). Both of those are properties of data, and data is testable on a machine
with no display.

Module: `assembly/editor/`, re-exported from `tension-framework`.

## 1. The rule the three files exist to keep

**A document setter does not record itself.**

`Document.setX` moves a number. It does not push an undo entry, and it has never
heard of a command. Every edit a user can make goes through a `Command`, and the
`History` is the only thing that sees it.

The alternative — setters that record themselves — looks simpler and breaks on the
first interesting case. `RemoveNode` has to delete a subtree and put every node back;
`Reparent` has to remember a parent and refuse to create a cycle; an inspector's
numeric field has to collapse sixty keystrokes into one entry. None of those is a
single setter call, so a setter that logged its own undo would have to be bypassed
for all three.

The consequence for callers is a rule: **the shell never writes the document, it
dispatches.** A code path that assigns `node.x` directly is an edit with no undo,
and no test can see it.

## 2. The document

Parallel arrays, one slot per node id, and a handle class:

```ts
const doc = Document.create(256);          // the root exists from the start
const hero = doc.spawn(ROOT_ID, "hero");   // a Node handle: doc + id
hero.x = 12.5;                             // a setter, not a command
hero.frame = 3;
doc.children(ROOT_ID);                     // computed, never stored
```

- **Ids are never reused.** An undo of a remove has to restore the *same* ids so a
  command still holding one means the same node. `nextId` is monotonic.
- **Children are computed.** A child list is a second copy of the `parent` array,
  and two copies of one fact drift; `children()` scans, which is free at editor
  sizes and cannot go stale after a `reparent`.
- **The root is `0` and cannot be removed.** It is the parent of the top level, so
  the tree has one root rather than a forest.
- **`insertNode` exists for undo.** `spawn` hands out the next id; an undo needs to
  put a node back at a *specific* one.
- **`setParentOf` refuses a cycle.** Moving a node under its own descendant is a
  no-op, so the command that asked is a no-op and its undo lands where it started.

### The save format

JSON, in `Bytes`, one object per live node:

```json
{"version":1,"capacity":256,"nodes":[
  {"id":0,"parent":-1,"x":0,"y":0,"z":0,"frame":0,"visible":true,"name":"World"},
  {"id":1,"parent":0,"x":12.5,"y":-3.25,"z":0,"frame":0,"visible":true,"name":"hero"}
]}
```

A format a person can read in `git diff` is worth more to an editor than a compact
one, and this runtime has no JSON library — `json.ts` is a writer and a reader, about
250 lines, with the rules stated where they are enforced.

**`nextId` is deliberately not in the file.** It is session state: it exists so an id
is never reused *within* a run, and serializing it would make an undo of an add leave
a different file than the one before it, for a reason with nothing to do with the
scene. A load derives it as one past the highest id it read.

**The reader is strict about the things that make a file valid JSON** — separators,
trailing commas, unterminated containers — and lenient about everything else: an
unknown key is skipped rather than misread as the next field, so a document from a
newer build still opens. Strictness on the read side is what makes the
round-trip assertion mean *"valid JSON"* rather than "the two halves of this file
agree"; the first version of the writer omitted separators and passed every
round-trip, because the reader it was tested against was as lenient as the writer
was wrong.

## 3. The commands

```ts
interface Command {
  apply(doc: Document): void;   // first time, and on every redo
  undo(doc: Document): void;
  merge(next: Command): bool;   // true = "same edit continued, no new entry"
  label(): string;
}
```

Classes, not closures: a closure over a stack local is the shape that traps on this
toolchain (`docs/modules/2d.md` §3 records the measurements), and a closure cannot
`merge`.

| command | captures | merges |
|---|---|---|
| `AddNode` | the id it was given, or the one the document hands out | no |
| `RemoveNode` | **the whole subtree** — ids, parents, names, transforms, visibility | no |
| `SetX` / `SetY` | the value before the first apply, and after the last | with the same node and axis |
| `SetProperty` | as above, per `PropKind` | with the same node *and* kind |
| `Reparent` | the parent it came from | no |

Two details that are easy to get wrong, both pinned by tests:

- **`RemoveNode` snapshots on the first `apply` only.** A redo re-removes what the
  undo restored; a snapshot taken then would capture the empty state and the next
  undo would restore nothing.
- **`SetX.merge` keeps the *first* before and the *last* after.** Sixty frames of a
  drag is one entry, and one undo returns the node to where the drag started — not
  to the previous frame.

`History` is two stacks and a limit:

```ts
const history = History.create(200);
history.exec(doc, new SetX(id, 40));   // applies, offers the top a merge
history.undo(doc);                      // true when something was undone
history.redo(doc);
```

An edit after an undo clears the redo stack — the branch it would replay is gone.
Past the limit the oldest entry is dropped, and `undo` then answers `false` rather
than reaching for an entry that no longer exists.

## 4. The palette

```ts
const palette = registerEditorCommands(Palette.create(history));
palette.run(doc, "node.add", args);     // true; false for an unknown id
palette.list();                         // [{id, title}] for a menu
```

A `CommandFactory` is `id()`, `title()` and `make(args)`. An object rather than a
handler, for the closure reason above and because it carries the title a palette row
draws.

`run` holds the `History`, so there is no way to run a command outside the undo
stack — an edit a user cannot take back is not a command. An **unknown id applies
nothing** and answers `false`, which is what makes a typo in a keybinding table
harmless.

`args.id == NO_PARENT` means "act on the selection", so a button or a key handler
does not have to repeat the lookup. `AddNode` allocates its id on the first `apply`
when it is given `ALLOCATE_ID`, because a factory cannot know what the document will
hand out before it runs.

## 5. Tests

`guest-editor.ts` in `tension-framework/tests`, wired into the `framework` suite.
No canvas, no GPU:

```
editor: undo is exact, a drag merges, saves round-trip, the palette dispatches
```

Eight cases, chosen to fail loudly if the mechanisms are only approximately right:

1. **Add/remove round trips are byte-identical** to the document before them — not
   "the node is back". An undo that restores a node with the right name and the
   wrong `z` passes an id check and loses work.
2. **A remove takes the subtree** and gives all of it back, every field, with the
   child's parent intact — and a sibling is untouched.
3. **A sixty-frame drag is one entry**, and one undo returns it to the drag's start.
   Merging must not cross axes or nodes.
4. **The undo limit** drops the oldest and nothing else: ten adds with a limit of
   three leaves three undos and seven nodes.
5. **Serialization** round-trips through escapes, negatives, `z`, frames and
   visibility; a save-load-save is byte-identical; malformed documents (truncated,
   missing separator, trailing comma, a newer version) are refused with a message.
6. **Reparent**, and the cycle it must refuse.
7. **The palette** dispatches by id, refuses an unknown one without touching the
   document, acts on the selection, merges through `run`, and removes.
8. **Handles**: a setter writes the document without consulting the history, a
   handle to a removed node reports itself invalid, and the root survives.

Two mutation checks were run against this fixture while it was written, and both were
caught: dropping `z` from `RemoveNode`'s snapshot fails "with every field it had",
and making `SetX.merge` return false fails four assertions (the drag becomes 32
entries and one undo lands on the last frame instead of the start).

## 6. The shell — `apps/editor`

Pass 3 puts the core on screen. The app is `apps/editor`: an `AppShell` subclass,
the `tension-ui` painter, and no loop of its own.

```
 0        32                                                         1920
 +---------+---------------------------------------------------------+
 | menu: File  Edit  View  Run                             (32 px)    |   0
 +---------+--------------------------------+------------------------+
 | scene   |  game viewport                 | inspector              |
 | tree    |  (bucket 0, its own pipeline)  | (selected node)        |
 | 320 px  |                                | 360 px                 |
 +---------+--------------------------------+------------------------+
 | console (240 px)                                                    |
 +---------------------------------------------------------------------+
 | status: nodes, selection, records, frame              (32 px)       |
 +---------------------------------------------------------------------+
```

**The composite is the point.** The game is a second `Scene` with its own pipeline
(pipe 100, from the emitted graph blob) and its own texture (a generated 128x32
atlas); the UI is the painter on preset 1 with the 576x1024 font atlas. The game
commits into canvas **bucket 0**, the painter into **bucket 1**, and one `present`
draws them in order. Buckets are the mechanism: each is one draw call and one
pipeline, which is why submitting both into 0 is refused rather than merged.

The scene is clipped to the viewport with `Scene.setViewport`, so a box near the
panel's edge is trimmed at it instead of painting over the inspector — and the
*atlas sizes differ*, which is the harder half of the proof: the renderer rebinds
`u_tex_size` per span.

Three things the shell taught, each of which was a bug first:

- **`loadAssets` runs again on every canvas rebuild.** Building the scene there
  gave nine nodes instead of five and twelve boxes instead of six, because a
  compositor that resized the window at startup triggered one rebuild. The scene
  is built once, behind a flag.
- **`SDL3` does not enable text input by itself.** `SDL_StartTextInput` is what
  makes the pump produce `SDL_EVENT_TEXT_INPUT`; without it the TEXT family
  translates nothing and the inspector's field received every key *down* and no
  text. The host now starts it at window creation — and that is a correction to an
  earlier pass, whose text-input verb had only ever been verified against "nothing
  was typed", a claim that is trivially true when nothing *can* be.
- **`node.add` must ignore `Args.id`.** `Args.id` is "the node this command acts
  on", and `Palette.run` resolves it from the selection — so a create command that
  read it inserted at the *selected node's* id, found it alive, refused, and left
  an undo entry that undid nothing. A user does not choose ids.

Interaction: a click in the tree selects; a click on the inspector's `x` row
focuses it; typing goes through `Snapshot.textInput()` (UTF-8, so a minus and a
decimal point are the keyboard's); `Enter` dispatches `SetX` through the history;
`Ctrl+Z`/`Ctrl+Y` undo and redo; `Ctrl+A` adds under the selection; `Delete`
removes.

**A rig note for anyone scripting it:** `xdotool key` presses and releases inside
one frame, and the key set is a *level* sampled once per frame — so a scripted key
must be held (`keydown`, ~150 ms, `keyup`), exactly as a scripted click must use
`mousedown`/`mouseup`. A human keypress is 50-150 ms and is always seen.

## 7. What is not here

Play mode (Pass 4), save and live reload (Pass 5). The **core** — `document.ts`,
`command.ts`, `palette.ts`, `json.ts` — still imports no `Canvas`, no `Scene` and
nothing from the session; the shell is the only file that does, which is what keeps
the whole of the logic testable with no display.
