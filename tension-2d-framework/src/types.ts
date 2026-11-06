// tension-2d-framework/src/types.ts — the wire records, as records.
//
// The wire authority is `tension-2d/include/tension_2d.h`; this file is the
// guest-side mirror of its `sprite` record and submit header. It allocates
// nothing and knows nothing about a scene: it is the vocabulary the other three
// modules share.
//
// The framework writes records; it never reads them back and never sorts them.
// Sorting is the adapter's job — the graph's comparator runs on the CPU side
// before the draw — so a world that emitted sorted records would be doing the
// work twice and would disagree with the backend about tie-breaking.
//
// ## Why these are `struct` and not offsets
//
// The design's claim is "the guest's struct decides the layout at build time".
// A hand-rolled writer with `OFF_SORT_KEY = 20` and `store<u32>` states the same
// bytes, but it states them as *arithmetic*: the layout lives in a constant,
// checked by nothing, drifting silently the day a field is inserted. A struct
// states the layout as fields, and the compiler computes the offsets from the
// widths — the same way it computes them for the C header's twin.
//
// Since TensionScript 0.10 a bare `struct` is a **value**: no GC header, no
// reference identity, fields laid out inline with C alignment, and
// `sizeof<T>()` is the C `sizeof`. That is the shape a wire record wants, and it
// is what makes `sizeof<SpriteRecord>()` a meaningful stride.
//
// A value has no address, so the *byte view* is named where bytes are needed:
// `changetype<@unmanaged SpriteRecord>(ptr)`. That is the tree's existing idiom
// (`tension-framework/assembly/ogre/bones.ts`, `motion.ts`). `changetype` to the
// bare value form is refused by the compiler — correctly, since a value has no
// pointer to give.
//
// ## The layout is asserted at build time
//
// The `if (...) { ERROR(...) }` blocks below are compile-time assertions, not
// runtime ones: `ERROR()` emits a diagnostic while the module is compiled, and
// the compiler folds a constant `if`, so the body is compiled — and the error
// emitted — only when the condition holds. A wrong size or a moved field fails
// `tensionscript` with `AS102`, and the guest does not build.
//
// The `_pad` field is deliberate: it is the padding the C struct has, named so
// that a reader of the declaration counts 28 bytes instead of having to know the
// alignment rule. `writeRecord` clears it, so a record never carries a byte of
// whatever was in the buffer before.

/** The `sprite` record: 28 bytes, naturally aligned (DESIGN.md §5). */
export struct SpriteRecord {
  x: i32;        // 0
  y: i32;        // 4
  srcX: u16;     // 8
  srcY: u16;     // 10
  w: u16;        // 12
  h: u16;        // 14
  tex: u16;      // 16, the texture-array page
  _pad: u16;     // 18, natural alignment
  sortKey: u32;  // 20
  groupId: u16;  // 24
  z: u8;         // 26
  flags: u8;     // 27
}

/** The submit header: records pointer, count, stride, reserved. */
export struct SubmitHeader {
  records: u32;    // 0
  count: u32;      // 4
  stride: u16;     // 8
  _reserved: u16;  // 10
}

// ── compile-time layout assertions ──────────────────────────────────────────
//
// These are the guard the C header cannot give the guest: `TS_STATIC_ASSERT`
// checks `tension_2d.h` against itself, and these check the guest's declaration
// against the same numbers. If both are wrong in the same way the wire is
// broken, but one of them failing alone is a drift somebody can see.

if (sizeof<SpriteRecord>() != 28) {
  ERROR("SpriteRecord must be 28 bytes — tension_2d.h's `sprite` record");
}
if (offsetof<SpriteRecord>("x") != 0) {
  ERROR("SpriteRecord.x must be at offset 0");
}
if (offsetof<SpriteRecord>("y") != 4) {
  ERROR("SpriteRecord.y must be at offset 4");
}
if (offsetof<SpriteRecord>("srcX") != 8) {
  ERROR("SpriteRecord.srcX must be at offset 8");
}
if (offsetof<SpriteRecord>("srcY") != 10) {
  ERROR("SpriteRecord.srcY must be at offset 10");
}
if (offsetof<SpriteRecord>("w") != 12) {
  ERROR("SpriteRecord.w must be at offset 12");
}
if (offsetof<SpriteRecord>("h") != 14) {
  ERROR("SpriteRecord.h must be at offset 14");
}
if (offsetof<SpriteRecord>("tex") != 16) {
  ERROR("SpriteRecord.tex must be at offset 16");
}
if (offsetof<SpriteRecord>("sortKey") != 20) {
  ERROR("SpriteRecord.sortKey must be at offset 20");
}
if (offsetof<SpriteRecord>("groupId") != 24) {
  ERROR("SpriteRecord.groupId must be at offset 24");
}
if (offsetof<SpriteRecord>("z") != 26) {
  ERROR("SpriteRecord.z must be at offset 26");
}
if (offsetof<SpriteRecord>("flags") != 27) {
  ERROR("SpriteRecord.flags must be at offset 27");
}
if (sizeof<SubmitHeader>() != 12) {
  ERROR("SubmitHeader must be 12 bytes");
}
if (offsetof<SubmitHeader>("stride") != 8) {
  ERROR("SubmitHeader.stride must be at offset 8");
}

/**
 * 28, derived from the declaration rather than typed twice.
 *
 * Exported because a caller sizing a buffer wants a number it can multiply;
 * `sizeof<T>()` works in an expression but reads badly in the middle of a
 * guest's own arithmetic.
 */
export const RECORD_SIZE: u32 = sizeof<SpriteRecord>();
export const HEADER_SIZE: u32 = sizeof<SubmitHeader>();

/** Facings a composite's z table is indexed by. */
export const FACINGS: i32 = 8;
/** Facing 0 is the back view: the sibling layers draw over the body. */
export const FACING_BACK: u8 = 0;
/** Facing 1 is the front view: the body draws over the pack. */
export const FACING_FRONT: u8 = 1;

/**
 * One source rectangle on one page: what a record needs to sample.
 *
 * `srcX`/`srcY` are in *page* pixels, not sheet pixels — the page a record
 * samples is already fixed by `tex`, and the shader has no idea the sheet was
 * ever larger than one page.
 *
 * **Still a managed class, and that is a compiler constraint rather than a
 * preference.** The value form — `struct Frame` — is refused in all three places
 * this type has to live (TensionScript 0.13.2; still true on 0.14.1, where the
 * deletions are listed as deferred):
 *
 * ```
 * AS100: an @inline struct as a class field (a class field is a pointer slot;
 *        inline-in-heap is a separate, deferred case)
 * AS100: an @inline struct value in a type argument (Array<T>) (value types are
 *        not implemented here yet; a pointer would alias)
 * AS100: passing this expression as an @inline struct argument (only a local
 *        value can be passed: a value has no address)
 * ```
 *
 * `Composite.Layer.frame` is a class field, `Tileset.named` is a
 * `Map<string, Frame>`, and callers pass `frameForPixel(...)` results to
 * functions. A value struct can do none of the three, so this type stays a
 * reference and carries `ok` as a bool. The wire records above — the ones whose
 * layout the design actually claims — are structs.
 *
 * `ok` is false for a frame a lookup could not produce: a coordinate outside the
 * sheet, a name that was never defined, a degenerate tileset. A flag rather than
 * a nullable return because every consumer is AssemblyScript, where `Frame |
 * null` forces a null check at each use and one missed check is a null
 * dereference inside a frame loop. An invalid frame is inert:
 * `IsometricWorld.addStatic` writes no record for it, and `Composite.addLayer`
 * refuses it.
 */
export class Frame {
  /** Texture-array slot, 0..15. */
  tex: u16;
  srcX: u16;
  srcY: u16;
  w: u16;
  h: u16;
  ok: bool;

  constructor(tex: u16, srcX: u16, srcY: u16, w: u16, h: u16) {
    this.tex = tex;
    this.srcX = srcX;
    this.srcY = srcY;
    this.w = w;
    this.h = h;
    this.ok = true;
  }

  static invalid(): Frame {
    const f = new Frame(0, 0, 0, 0, 0);
    f.ok = false;
    return f;
  }
}

/**
 * Write one record into `out` at `index`, through the struct.
 *
 * The view is `@unmanaged` — a pointer over bytes with no header — so the field
 * writes below land at exactly the offsets the compile-time assertions pin.
 * Every field is written, including the pad and the flags: a record that
 * inherits a byte from the previous frame is a record whose meaning depends on
 * history.
 */
export function writeRecord(
  out: usize,
  index: i32,
  x: i32,
  y: i32,
  frame: Frame,
  sortKey: u32,
  groupId: u16,
  z: u8,
): void {
  const rec = changetype<@unmanaged SpriteRecord>(out + <usize>(index * <i32>sizeof<SpriteRecord>()));
  rec.x = x;
  rec.y = y;
  rec.srcX = frame.srcX;
  rec.srcY = frame.srcY;
  rec.w = frame.w;
  rec.h = frame.h;
  rec.tex = frame.tex;
  rec._pad = 0;
  rec.sortKey = sortKey;
  rec.groupId = groupId;
  rec.z = z;
  rec.flags = 0;
}

/**
 * Write the submit header for `count` records starting at `records`.
 *
 * The guest builds this immediately before `submit`; it is here so every caller
 * writes the same 12 bytes and nobody has to remember that the stride is a
 * `u16` at offset 8.
 */
export function writeSubmitHeader(header: usize, records: usize, count: u32): void {
  const hdr = changetype<@unmanaged SubmitHeader>(header);
  hdr.records = u32(records);
  hdr.count = count;
  hdr.stride = <u16>RECORD_SIZE;
  hdr._reserved = 0;
}

// ── the guest-side offset test ──────────────────────────────────────────────

/**
 * Write a record and a header through the structs, then read the bytes back at
 * the *literal* offsets the wire specifies. Returns 0, or a code naming the
 * first disagreement.
 *
 * The compile-time assertions above prove the declaration's layout. This proves
 * the writes reach it: `writeRecord` could store through the wrong view and the
 * offsets would still be right. The loads here are deliberately plain
 * `load<T>` at hand-written constants — if this used `offsetof`, it would agree
 * with itself and test nothing.
 *
 * `scratch` must be at least 40 bytes, 8-aligned (28 + 12). The caller supplies
 * it because a static block's size must be a compile-time constant, and a shared
 * allocator would make this test depend on allocation order.
 */
export function layoutSelfTest(scratch: usize): i32 {
  const frame = new Frame(3, 0x1234, 0x5678, 32, 64);
  writeRecord(scratch, 0, -7, 0x00ABCDEF, frame, 0x11223344, 0x5566, 7);
  writeSubmitHeader(scratch + 28, scratch, 1);

  if (load<i32>(scratch + 0) != -7) return 1;
  if (load<i32>(scratch + 4) != 0x00ABCDEF) return 2;
  if (load<u16>(scratch + 8) != 0x1234) return 3;      // srcX
  if (load<u16>(scratch + 10) != 0x5678) return 4;     // srcY
  if (load<u16>(scratch + 12) != 32) return 5;         // w
  if (load<u16>(scratch + 14) != 64) return 6;         // h
  if (load<u16>(scratch + 16) != 3) return 7;          // tex
  if (load<u16>(scratch + 18) != 0) return 8;          // pad, cleared
  if (load<u32>(scratch + 20) != 0x11223344) return 9; // sortKey
  if (load<u16>(scratch + 24) != 0x5566) return 10;    // groupId
  if (load<u8>(scratch + 26) != 7) return 11;          // z
  if (load<u8>(scratch + 27) != 0) return 12;          // flags, cleared

  const hdr = scratch + 28;
  if (load<u32>(hdr + 0) != <u32>scratch) return 13;
  if (load<u32>(hdr + 4) != 1) return 14;
  if (load<u16>(hdr + 8) != 28) return 15;
  if (load<u16>(hdr + 10) != 0) return 16;
  return 0;
}
