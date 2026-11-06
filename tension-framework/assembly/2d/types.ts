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
// ## Declared plain, storage named at every use
//
// A struct declaration here carries no `@managed`, `@unmanaged` or `@inline`.
// The declaration says *what the bytes are* — a record with these fields, C
// layout, `sizeof` including trailing padding — and each use says *how they
// cross*: by value, or through a pointer.
//
//   export struct SpriteRecord { … }                            declaration
//   function writeRecord(records: @unmanaged [SpriteRecord *])  a run of them, by pointer
//   const px = changetype<@unmanaged Rgba>(addr)                one of them, by pointer
//   function readRgba(px: @unmanaged [Rgba *]): Rgba            pointer in, value out
//
// A use is never left implicit "because it compiles". Omitting `@unmanaged` at
// a use is a claim that the thing is a value, and a record in a caller's buffer
// is not one.
//
// **Why array views rather than a scalar pointer.** The natural spelling,
// `writeRec(rec: @unmanaged SpriteRecord, …)`, over a plain declaration is
// refused — as is every route around it:
//
//   field write through `@unmanaged` scalar param   AS100 "reading an @inline
//                                                  struct value as a whole"
//   the same parameter on an exported function      TS6411 "a view parameter …
//                                                  cannot appear in a
//                                                  host-visible signature"
//   changetype<usize>(param) + store<…>             AS100
//   copyInto(changetype<usize>(param), v)           AS100
//
// `@unmanaged [T *]` has none of those restrictions — it is host-visible, it
// indexes, and `[0]` is a record. So the parameters are array views: honest for
// a frame (a run of records), and for the header, which is one of them.
//
// **`Frame` is a class.** It is a lookup result, never bytes in a buffer, so
// the value model has nothing to offer — and a plain struct cannot be a class
// field, a `Map` value, or a non-local argument, which are the three places it
// lives. A class is already explicitly a GC reference; no annotation needed.
//
// ## Records are an array, not an address
//
// A frame is `[SpriteRecord *]` all the way down — a pointer to a run of
// records, which is a type the language has and a stride the compiler computes:
//
//   writeRecord(out, i, …)      ->  out[i].x = …      (index × sizeof)
//   world.emit(out)             ->  one view, no arithmetic at the call site
//
// Nothing here indexes `addr + i * RECORD_SIZE`. The one place a stride is
// written by hand is `RECORD_SIZE` itself, and only so a caller can size a
// buffer.
//
// **A view local must be a `let`, not a `const`.** A `const` whose type is a
// pointer view, in a scope that also declares an integer `const`, crashes
// `tensionscript` — 0.13.2 and 0.14.1 both, `AssertionError` in
// `setConstantIntegerValue`. It is a compiler bug, not a rule; `let` compiles to
// the same code and nothing reassigns a view.
//
// ## Where the layout is checked
//
// Nowhere. The declaration *is* the layout: `srcX: u16` is at 8 because `x: i32`
// and `y: i32` precede it, and the compiler derives every offset from the field
// widths the way a C compiler would. A struct that has a field has the field,
// and a second table restating it would be the drift it was meant to catch.
//
// What can actually break the wire is a wrong value in a field, or a record the
// adapter cannot decode — and both show up as pixels, in the examples'
// assertions. That is where a wire defect belongs.

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

/**
 * One pixel of a `screenshot` readback: RGBA8, four bytes, `width * height` of
 * them in a row.
 *
 * A struct rather than four `load<u8>(ptr + n)` calls, for the obvious reason:
 * the four channels are a record with names, and a caller that gets `r` and `b`
 * the wrong way round has no way to notice from a hex address.
 */
export struct Rgba {
  r: u8;
  g: u8;
  b: u8;
  a: u8;
}

/**
 * The pixel at `ptr`, as a value.
 *
 * The view is `@unmanaged` — a pointer over four bytes — and it is read into a
 * local before returning, because a value has no address: `return
 * changetype<@unmanaged Rgba>(ptr)` is refused (`AS100: only a local value can
 * be returned`), while building the local and returning *that* is the ordinary
 * sret path the language documents. Four field reads, and the caller gets
 * `px.r` instead of `load<u8>(at)`.
 *
 * **Not from inside two loops.** The returned local is an SROA value, and two
 * SROA locals of one struct type in two loops of the same function crash the
 * compiler — 0.13.2 and 0.14.1 both, `duplicate local name` out of
 * `fillSroaFieldLocals`. One loop is fine, and so are two outside loops. Where a
 * function has two pixel loops, take the `@unmanaged` view instead: it is a
 * pointer local and the fields are named the same way.
 */
/**
 * The pixel at (`x`,`y`) in an RGBA8 screenshot buffer `width` pixels wide.
 *
 * `frame` is the buffer's first pixel, not an address: a `screenshot` fills
 * `width * height` of these and there is nothing else in the block, so the
 * pointer arithmetic belongs here once rather than in every guest's probe.
 */
export function pixelAt(frame: @unmanaged [Rgba *], x: i32, y: i32, width: i32): Rgba {
  // A value has no address, so a returned value has to be a local: `return
  // readRgba(…)` is refused, `const px = readRgba(…); return px;` is the sret
  // path. Same rule as the showcase's `add()`.
  const px = readRgba(changetype<@unmanaged [Rgba *]>(<usize>frame + <usize>((y * width + x) * 4)));
  return px;
}

export function readRgba(px: @unmanaged [Rgba *]): Rgba {
  const out = new Rgba();
  out.r = px[0].r;
  out.g = px[0].g;
  out.b = px[0].b;
  out.a = px[0].a;
  return out;
}

/**
 * The `info` verb's record: 24 bytes, `tension_2d_info_record`.
 *
 * Read as a struct rather than through seven accessors doing
 * `load<u16>(buf + 2)`. The layout is the C declaration's; a guest that reads
 * `info.canvasWidth` cannot visit the wrong offset.
 */
export struct Info {
  version: u16;       // 0
  maxRecords: u16;    // 2
  maxTextures: u32;   // 4
  maxPipelines: u32;  // 8
  maxBuckets: u16;    // 12
  flags: u16;         // 14
  canvasWidth: u32;   // 16
  canvasHeight: u32;  // 20
}

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
 * `records[index]` is the record — the compiler supplies the stride from
 * `sizeof<SpriteRecord>()`, so no caller does that arithmetic. The field writes
 * below are the wire's bytes in the wire's order, and every field is written,
 * including the pad and the flags: a record that inherits a byte from the
 * previous frame is a record whose meaning depends on history.
 */
export function writeRecord(
  records: @unmanaged [SpriteRecord *],
  index: i32,
  x: i32,
  y: i32,
  frame: Frame,
  sortKey: u32,
  groupId: u16,
  z: u8,
): void {
  records[index].x = x;
  records[index].y = y;
  records[index].srcX = frame.srcX;
  records[index].srcY = frame.srcY;
  records[index].w = frame.w;
  records[index].h = frame.h;
  records[index].tex = frame.tex;
  records[index]._pad = 0;
  records[index].sortKey = sortKey;
  records[index].groupId = groupId;
  records[index].z = z;
  records[index].flags = 0;
}

/**
 * Write the submit header for `count` records starting at `records`.
 *
 * The guest builds this immediately before `submit`; it is here so every caller
 * writes the same 12 bytes and nobody has to remember that the stride is a
 * `u16` at offset 8.
 */
export function writeSubmitHeader(
  hdr: @unmanaged [SubmitHeader *],
  records: @unmanaged [SpriteRecord *],
  count: u32,
): void {
  // `<usize>` rather than `changetype<usize>`: a view is already a pointer,
  // and `changetype` between the two is refused (AS202).
  hdr[0].records = u32(<usize>records);
  hdr[0].count = count;
  hdr[0].stride = <u16>RECORD_SIZE;
  hdr[0]._reserved = 0;
}
