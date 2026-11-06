// tension-framework/assembly/2d/types.ts — the 2D wire records, as records.
//
// The wire authority is `tension-2d/include/tension_2d.h`; this file is the
// guest-side mirror of its `sprite` record and submit header. It allocates
// nothing on the hot path and knows nothing about a scene: it is the vocabulary
// the other three modules share.
//
// The framework writes records; it never reads them back and never sorts them.
// Sorting is the adapter's job — the graph's comparator runs on the CPU side
// before the draw — so a world that emitted sorted records would be doing the
// work twice and would disagree with the backend about tie-breaking.
//
// ## Why these are structs and not offsets
//
// The design's claim is "the guest's struct decides the layout at build time".
// A hand-rolled writer with `OFF_SORT_KEY = 20` and `store<u32>` states the same
// bytes, but it states them as *arithmetic*: the layout lives in a constant,
// checked by nothing, drifting silently the day a field is inserted. A struct
// states the layout as fields, and the compiler computes the offsets from the
// widths — the same way it computes them for the C header's twin.
//
// ## Declared plain, viewed where it is used
//
// A bare `struct` is a **value**: the bytes live in the variable, assigned by
// copy, with no address (TensionScript's 0.10 default flip). The declarations
// below are exactly that, and they carry no storage decorator — same as
// `assembly/ogre/generated`'s records, which are also plain.
//
// Storage is chosen at the *use*, because a use is where it is known. A record
// in a caller's buffer is written through a pointer, so that one call site says
// `changetype<@unmanaged SpriteRecord>(ptr)`: an `@unmanaged` view is a pointer
// over bytes with no header, and the operand supplies the address. The modifier
// has been a use-site one since 0.11.1, which is why the declaration needs no
// twin.
//
// The value form is what the field list describes — C layout, fields at their
// natural alignment, `sizeof` including trailing padding, `offsetof` the field's
// byte offset — and it does not change with the view. That is what makes
// `sizeof<SpriteRecord>()` a meaningful stride.
//
// ## Where the layout is checked
//
// The declaration *is* the layout: `x: i32` is at 0 and `sortKey: u32` follows
// `tex`/`_pad` because that is what the field list says, and the compiler
// derives every offset from the field widths the way a C compiler would. There
// is no separate table to keep in step, and nothing above needs a guard.
//
// The one place a check belongs is where bytes are actually written:
// `layoutSelfTest` below writes a real record and reads it back at the offsets
// `tension_2d.h` publishes. One test of behaviour beats a ledge of assertions
// about arithmetic, and it catches something they never could — a declaration
// that is right while the write goes somewhere else.

/** The `sprite` record: 28 bytes, naturally aligned (DESIGN.md §5). */
export struct SpriteRecord {
  x: i32;        // 0
  y: i32;        // 4
  srcX: u16;     // 8
  srcY: u16;     // 10
  w: u16;        // 12
  h: u16;        // 14
  tex: u16;      // 16, the texture-array page
  _pad: u16;     // 18, the C struct's padding, named
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
 * **A class, not a struct.** This type is never on the wire and never viewed
 * through a pointer, so the value model buys nothing here — and it cannot be
 * used in the three places the type has to live:
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
 * `Map<string, Frame>`, and callers pass `frameForPixel(...)` results straight
 * into functions. A value can do none of the three, and `@managed` at a use
 * cannot rescue it — `TS6395: Type 'Frame' is a value with no address, so a use
 * cannot view it as '@managed'`. So it is an ordinary reference with ordinary
 * reference behaviour, which is what a lookup result wants anyway.
 *
 * `ok` is 1 for a usable frame and 0 for an inert one: a coordinate outside the
 * sheet, a name that was never defined, a degenerate tileset. A flag rather than
 * a nullable return because `Frame | null` forces a null check at every use, and
 * one missed check is a null dereference inside a frame loop. An invalid frame
 * writes no record: `IsometricWorld.addStatic` skips it and `Composite.addLayer`
 * refuses it.
 */
export class Frame {
  /** Texture-array slot, 0..15. */
  tex: u16;
  srcX: u16;
  srcY: u16;
  w: u16;
  h: u16;
  /** 1 usable, 0 inert. */
  ok: u8;

  constructor(tex: u16, srcX: u16, srcY: u16, w: u16, h: u16) {
    this.tex = tex;
    this.srcX = srcX;
    this.srcY = srcY;
    this.w = w;
    this.h = h;
    this.ok = 1;
  }

  isValid(): bool {
    return this.ok != 0;
  }

  static invalid(): Frame {
    const f = new Frame(0, 0, 0, 0, 0);
    f.ok = 0;
    return f;
  }
}

/**
 * Write one record into `out` at `index`, through the struct.
 *
 * `changetype<@unmanaged SpriteRecord>` is the pointer view: no header is read or
 * written, because an `@unmanaged` view has none. The field writes below are the
 * wire's bytes in the wire's order, and every field is written — including the
 * pad and the flags — because a record that inherits a byte from the previous
 * frame is a record whose meaning depends on history.
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
 * The declaration fixes the layout; this fixes the *writes*. `writeRecord` could
 * store through the wrong view with the declaration unchanged, and only real
 * bytes catch that. The loads here are deliberately plain `load<T>` at
 * hand-written constants — written with `offsetof` they would agree with
 * themselves and test nothing.
 *
 * The offsets are repeated here on purpose, once, in the one place that reads
 * raw bytes. Everywhere else the field names do the work.
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
