// tension-2d-framework/src/types.ts — the record, the frame, the facing.
//
// The wire authority is `tension-2d/include/tension_2d.h`; this file is the
// guest-side mirror of its `sprite` record. Nothing here allocates, talks to the
// host, or knows what a scene is: it is the vocabulary the other three modules
// share.
//
// The framework writes records; it never reads them back and never sorts them.
// Sorting is the adapter's job — the graph's comparator runs on the CPU side
// before the draw — so a world that emitted sorted records would be doing work
// twice and would disagree with the backend about tie-breaking.

/** The `sprite` record: 28 bytes, naturally aligned (DESIGN.md §5). */
export const RECORD_SIZE: u32 = 28;

export const OFF_X: u32 = 0;        // i32
export const OFF_Y: u32 = 4;        // i32
export const OFF_SRC_X: u32 = 8;    // u16
export const OFF_SRC_Y: u32 = 10;   // u16
export const OFF_W: u32 = 12;       // u16
export const OFF_H: u32 = 14;       // u16
export const OFF_TEX: u32 = 16;     // u16, the texture-array page
export const OFF_SORT_KEY: u32 = 20; // u32
export const OFF_GROUP_ID: u32 = 24; // u16
export const OFF_Z: u32 = 26;       // u8
export const OFF_FLAGS: u32 = 27;   // u8

/** The submit header: records pointer, count, stride, reserved. */
export const HEADER_SIZE: u32 = 12;

/** Facings the composite's z table is indexed by. */
export const FACINGS: i32 = 8;
/** Facing 0 is the back view: the sibling layers draw over the body. */
export const FACING_BACK: u8 = 0;
/** Facing 1 is the front view: the body draws over the pack. */
export const FACING_FRONT: u8 = 1;

/**
 * One source rectangle on one page: what a record needs to sample.
 *
 * `srcX`/`srcY` are in *page* pixels, not tileset pixels — the page a record
 * samples is already fixed by `tex`, and the shader has no idea the sheet was
 * ever larger than one page.
 */
export class Frame {
  /** Texture-array slot, 0..15. */
  tex: u16;
  srcX: u16;
  srcY: u16;
  w: u16;
  h: u16;
  /**
   * False for a frame a lookup could not produce: a coordinate outside the
   * sheet, a name that was never defined, or a degenerate tileset.
   *
   * A flag rather than a nullable return because every consumer here is
   * AssemblyScript, where a `Frame | null` return forces a null check at each
   * use and one missed check becomes a null dereference in a frame loop. An
   * invalid frame is inert: `IsometricWorld.addStatic` writes no record for it
   * and `Composite.addLayer` refuses it, both of which are the right answer.
   */
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
 * Write one record into `out` at `index`.
 *
 * Zeroed first: a stale padding byte at 18-19 or a `flags` byte from an earlier
 * frame is a record whose meaning depends on history, which is the kind of bug
 * that only reproduces after the third frame.
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
  const at = out + <usize>(index * <i32>RECORD_SIZE);
  memory.fill(at, 0, RECORD_SIZE);
  store<i32>(at + OFF_X, x);
  store<i32>(at + OFF_Y, y);
  store<u16>(at + OFF_SRC_X, frame.srcX);
  store<u16>(at + OFF_SRC_Y, frame.srcY);
  store<u16>(at + OFF_W, frame.w);
  store<u16>(at + OFF_H, frame.h);
  store<u16>(at + OFF_TEX, frame.tex);
  store<u32>(at + OFF_SORT_KEY, sortKey);
  store<u16>(at + OFF_GROUP_ID, groupId);
  store<u8>(at + OFF_Z, z);
}

/**
 * Write the submit header for `count` records starting at `records`.
 *
 * The guest builds this immediately before `submit`; it is here so every caller
 * writes the same 12 bytes and nobody has to remember that the stride is a
 * `u16` at offset 8.
 */
export function writeSubmitHeader(header: usize, records: usize, count: u32): void {
  memory.fill(header, 0, HEADER_SIZE);
  store<u32>(header + 0, u32(records));
  store<u32>(header + 4, count);
  store<u16>(header + 8, <u16>RECORD_SIZE);
  store<u16>(header + 10, 0);
}
