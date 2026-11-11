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
//   function emit(out: @unmanaged [SpriteRecord *])             a run of them, by pointer
//   const frame = changetype<@unmanaged [Rgba *]>(addr)         a run of pixels, by pointer
//   frame[i].r                                                  a field of one of them
//
// A use is never left implicit "because it compiles". Omitting `@unmanaged` at
// a use is a claim that the thing is a value, and a record in a caller's buffer
// is not one.
//
// **Why array views rather than a scalar pointer.** The natural spelling,
// `f(rec: @unmanaged SpriteRecord, …)`, over a plain declaration is refused —
// as is every route around it:
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
// indexes, and `[0]` is a record. So a buffer crosses as an array view: honest
// for a frame (a run of records), and for the header, which is one of them.
//
// **The record fills itself, and the method takes an address.** `out[i]` is an
// address — the same `this` a setter takes — so `out[i].set(…)` writes through
// it with the compiler's stride and offsets. A value local is not: a method
// called on one is refused (AS100, "a value has no address"), and no caller here
// has one, because a record is only filled where it will be submitted from.
// Keeping the writes inside the type is what stops a `writeRecord(records, i, …)`
// free function from reappearing: there is one layout, so there is one writer, and
// it belongs to the layout.
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
//   out[i].set(…)               ->  field stores at index × sizeof
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

/** The `sprite` record: 28 bytes, naturally aligned (`docs/modules/2d.md` §8). */
export struct SpriteRecord {
  x: i32;        // 0
  y: i32;        // 4
  srcX: u16;     // 8
  srcY: u16;     // 10
  w: u16;        // 12
  h: u16;        // 14
  tex: u16;      // 16, the texture-array page
  sortKey: u32;  // 20. Bytes 18–19 are C's implicit padding, not a field.
  groupId: u16;  // 24
  z: u8;         // 26
  flags: u8;     // 27

  /**
   * Fill this record. The receiver is the record already in the buffer:
   *
   *   out[i].set(x, y, frame, sortKey, groupId, z)
   *
   * The compiler supplies the stride and every field offset, so no caller does
   * that arithmetic. Every field of the type is written — a record that
   * inherits a field from the previous frame is a record whose meaning depends
   * on history.
   *
   * The two bytes between `tex` and `sortKey` are not among them. They are
   * padding the C layout inserts to align a `u32` after a `u16`, `tension_2d.h`
   * marks them `—` rather than naming them, and nothing reads them: a `u16`
   * field is masked out of its 32-bit word (`(r_words[base + n] >> shift) &
   * 0xFFFF`). Declaring `_pad: u16` to shadow them was a field the wire does not
   * have, which is the same mistake as an `OFF_*` constant in a smaller size —
   * a second statement of the layout that can disagree with it. Natural
   * alignment puts `sortKey` at 20 and `sizeof` at 28 on its own; no `@abi.align`
   * is needed, because nothing here asks the layout to differ from C's.
   *
   * **A method, not a free function taking `(records, i, …)`.** A writer
   * function makes the record a parameter of somebody else's procedure; the
   * method makes it a receiver, and the call site says *which record* is being
   * filled rather than *which buffer*. There is exactly one record layout, so
   * there is no second implementation to keep in step.
   *
   * **The receiver must have an address.** `records[i]` is one (the element of
   * a `[T *]` view is an address, the same `this` a setter takes). A value local
   * is not: `let r = new SpriteRecord(); r.set(…)` is refused with AS100
   * ("reading an @inline struct value as a whole"), because a value has no
   * address to write through. Nothing here needs to; a record is only ever
   * filled where it will be submitted from.
   */
  set(x: i32, y: i32, frame: Frame, sortKey: u32, groupId: u16, z: u8): void {
    this.setRect(x, y, frame.srcX, frame.srcY, frame.w, frame.h, frame.tex,
                 sortKey, groupId, z);
  }

  /**
   * `set`, from the source rect directly rather than from a `Frame`.
   *
   * **The primitive of the two**, and the only method that writes a field. A
   * caller that has a `Frame` uses `set`; a caller that has the five numbers — a
   * UI painter drawing an atlas cell it computed inline, which is exactly what
   * `apps/docs` does — uses this. Keeping `set` a delegation rather than a second
   * set of ten assignments is what preserves "one layout, one writer": two
   * bodies that each write every field are two places for a field to be forgotten
   * the day one is added.
   */
  setRect(x: i32, y: i32, srcX: u16, srcY: u16, w: u16, h: u16, tex: u16,
          sortKey: u32, groupId: u16, z: u8): void {
    this.x = x;
    this.y = y;
    this.srcX = srcX;
    this.srcY = srcY;
    this.w = w;
    this.h = h;
    this.tex = tex;
    this.sortKey = sortKey;
    this.groupId = groupId;
    this.z = z;
    this.flags = 0;
  }
}

/**
 * The submit header: records pointer, count, stride, reserved.
 *
 * Also a method, for the same reason as `SpriteRecord.set` — the header is one
 * value with one wire layout, and `header[0].set(records, count)` reads as the
 * statement it is. `stride` and `flags` are not parameters: a caller that could
 * pass a different stride could submit records the adapter cannot decode.
 */
export struct SubmitHeader {
  records: u32;  // 0
  count: u32;    // 4
  stride: u16;   // 8
  flags: u16;    // 10, `tension_2d_submit_hdr.flags` — must be 0

  set(records: @unmanaged [SpriteRecord *], count: u32): void {
    // `<usize>` rather than `changetype<usize>`: a view is already a pointer,
    // and `changetype` between the two is refused (AS202).
    this.records = u32(<usize>records);
    this.count = count;
    this.stride = <u16>sizeof<SpriteRecord>();
    this.flags = 0;
  }
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
