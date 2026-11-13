# Backlog: byte-offset decoders in guest code

**Status:** backlog, not a plan. Each row is a rewrite of one reader with its own
test surface, to be done as a separate pass after the nested-guest architecture
lands — not folded into it.

**What is wrong with them.** The doctrine is in
`tension-framework/assembly/2d/types.ts:22-84`: a struct declaration says *what
the bytes are*, and each use says *how they cross* (`by value`, or
`@unmanaged [T *]` for a run). A raw `usize` plus a hand-written offset says
neither. It has no struct identity, so nothing checks the layout, nothing bounds
the index, and two readers of one wire format drift apart without a compile
error. `assembly/2d/types.ts:76` states the target: *"Nothing here indexes
`addr + i * RECORD_SIZE`."*

The 2D record path is the part of the tree that already meets that bar
(`SpriteRecord`, `RecordBuffer`, `SubmitHeader`). These are the parts that do
not. **Nothing here is a defect that misbehaves today** — every row decodes a
layout its writer agrees on, and the suites pass. They are a readability and
drift hazard, not a bug list.

**How to fix one.** Define the wire record as a plain `struct` with the fields in
declared order, replace the scalar decode with `@unmanaged [T *]` indexing, and
keep the accessor names callers already use. A row that reads *text* rather than
a record takes a different shape: a span type, not a struct array.

| # | Where | Shape today | Safe wrapper already exists? |
| --- | --- | --- | --- |
| 1 | `tension-framework/assembly/input.ts:250-263` (`InputState.read`) | 14 × `load<T>(ptr + STATE_*_OFFSET)` over a caller's `usize` | **Partly, and duplicated.** `Snapshot` (`input.ts:339`) decodes the same layout a second time at `:541-554` over a block it owns. Two decoders, one wire format, no shared type — the exact drift the doctrine prevents. |
| 2 | `tension-framework/assembly/input.ts:283` (`keyHeld`), duplicated at `:677` (`keyWord`) | `load<u32>(keysAt + (scancode >> 5) * 4)` — a 256-bit set indexed by shift | Same duplication as #1; the bitmap width is a constant in both places. |
| 3 | `tension-framework/assembly/input.ts:293`, `:298` (`padAxis`, `padButton`) | `load<f32/i32>(padPtr + PAD_*_OFFSET …)` | **No.** The pad record has a C layout in `tension_input.h` and no type in the guest SDK. |
| 4 | `tension-framework/assembly/platform.ts:266-274` (`decodeWindowInfo`) | 9 × `load<u32>(staging + 4/8/12/…)` over `heap.alloc(40)` | **No.** `WindowInfo` (`:204`) is the decoded *copy*; the wire record (`tension_window_info`) has no type. Two readers share one decoder, which is the good half. |
| 5 | `tension-framework/assembly/res.ts:131-133` (stat record) | `load<u32>(statBuf + 0/4/8)` into a staging block | **No.** `ResStat` exists as a result type; the record has no type. |
| 6 | `apps/docs/src/format.ts:130-175` (`Docs.open` and ~40 accessors) | `base: usize` plus `load<u32>(this.pagesAt + i * PAGE_BYTES + 4)` per field | **No**, and it is the largest single body. `docs.bin` has a header, a page table, a block table and a run table, all addressed by hand. |
| 7 | `apps/docs/src/layout.ts:355`; `apps/docs/src/main.ts:555`, `:650`, `:1166` | `load<u8>(ptr + i)` walking a run's text for case folding, newline search and line counting | **No.** This is text, not a record: the fix is a span type (`TextBuffer`-like view over `[u8]` with a length), not a struct array. |
| 8 | `examples/2d/isometric/src/bindings.ts:110-138` (`writeRecord`, `writeSubmitHeader`) | 10 × `store<T>(at + OFF_*)` with hand-written offsets | **Yes, both.** `RecordBuffer.push`/`writeAt` (`2d/buffers.ts:102`, `:135`) and `SpriteRecord.setRect`. This example predates the wrappers and never migrated. |
| 9 | `examples/2d/isometric/src/main.ts:317-319` | three `memory.data(n * RECORD_SIZE)` blocks sized by hand | Partly: `RecordBuffer` is the replacement for the records block; `Pixels` for the frame block. `memory.data` takes a compile-time size, which is why they are static. |
| 10 | `examples/2d/box-physics/src/atlas.ts:95` | `changetype<@unmanaged [Rgba *]>(image.address() + 74)` — the IWI header length written as `74` | **No**, but the pointer is typed. `Rgba` is the right element; the magic number and the unchecked cast are the issue. |
| 11 | `examples/2d/stiff-boxes/src/main.ts:38-39`, `:238` | `memory.data(65536)` handed to the solver as `[f64 *]` | **No.** Typed array view, fixed 64 KiB, no length in the type. |

## Related, and deliberately not on this list

- `Bytes.viewOf(bytes: Uint8Array)` (`bytes.ts:111`) is a **reference-keeping**
  wrapper over a typed array — no address, no offset, no layout claim. It is not
  an instance of this pattern. Its three call sites (`2d/canvas.ts:363`,
  `apps/editor/src/main.ts:1162`, the definition) are fine.
- `RecordBuffer.view()` (`2d/buffers.ts:153`) and `Canvas.submit`
  (`2d/canvas.ts:414-422`) are `changetype<@unmanaged …>` over an address, but
  the address belongs to a wrapper the guest never touches and the type is the
  record. That is the shape the rest of this list should move to.
- `ogre/*` view types (`bones.ts:149`, `motion.ts:99`, `index.ts:378-390`) are
  typed views into adapter-owned regions. They lack a length in the type, which
  is a smaller version of the same issue; they belong with the OGRE surface, not
  here.

## Why not now

Each row is a reader with its own writer, its own tests, and its own drift risk
if converted halfway. Converting `input.ts` means changing the wire type shared
by `Snapshot` and `InputState` at once; converting `format.ts` means touching the
docs bundle format's reader and the build that writes it. Doing them inside the
nested-guest pass would put an unrelated rewrite between the spike and the
sandbox, where a regression would be ambiguous. They land after.
