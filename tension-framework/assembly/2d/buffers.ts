// tension-framework/assembly/2d/buffers.ts — the two buffers a 2D guest owns.
//
// `RecordBuffer` is a frame's worth of `SpriteRecord`s and the submit header's
// count; `Pixels` is a `screenshot` destination and the questions a test asks of
// one. Both own a `Uint8Array` and neither hands out an address, which is the
// whole point: `submit` and `screenshot` used to take `(ptr, count)` and every
// guest in this tree allocated those buffers itself.
//
// ## Why the buffer is a class and not a `memory.data` block
//
// `memory.data` takes a **compile-time** size. `MAX_RECORDS` is a constant in
// `apps/docs` because of it, and a scene whose capacity came from a config file
// could not be built at all. A `Uint8Array` is a heap object, so `capacity` is a
// runtime value — and its address is `dataStart`, stable for its life, because
// the collector is mark & sweep and never moves an object.
//
// What keeps the address valid is the *reference*, and that is why the buffer is
// a field. The measured failure this prevents (`bytes.ts` has the backtrace) is
// a record buffer addressed with `changetype<usize>(view)`: that is the
// `Uint8Array` **object**, 32 bytes before its data, so the records overwrite the
// collector's link word and the object's own `buffer` reference — and the trap
// lands in the next mark phase, nowhere near the code that caused it.
//
// ## The record count belongs to the buffer
//
// `count` used to be the caller's, tracked beside the pointer it described, and
// the two could disagree: `submit(pipe, records, 4, 0)` on a buffer holding ten
// records is a legal call that draws four. Here the count moves with `push`, so
// the only way to submit n records is to have pushed n.
//
// `dropped` is the other half: the record budget (4096, **summed across all
// buckets**) is a host refusal, and a painter that draws past it must still draw
// the frame. A `push` at capacity increments `dropped` and writes nothing, which
// is what `apps/docs`' status bar reports.

import { Bytes } from "../bytes";
import { Frame, RECORD_SIZE, Rgba, SpriteRecord } from "./types";

/**
 * A frame's worth of sprite records.
 *
 * `capacity` is what the caller will ever push in one frame, not how many exist:
 * `reset()` between frames keeps the allocation, so a steady-state frame
 * allocates nothing.
 */
export class RecordBuffer {
  /** The records' bytes. `dataStart` is the address; nothing else is. */
  private bytes: Bytes;
  private cap: i32;
  /** Records pushed since `reset`. */
  count: i32 = 0;
  /** Pushes refused because the buffer was full. */
  dropped: i32 = 0;

  constructor(capacity: i32) {
    // Locals first: the compiler refuses to read `this` before every field is
    // assigned, and sizing the buffer from `this.cap` is exactly that read.
    const cap = capacity > 0 ? capacity : 0;
    this.bytes = Bytes.allocate(cap * <i32>RECORD_SIZE);
    this.cap = cap;
  }

  /** For symmetry with the rest of the SDK, which spells construction `create`. */
  static create(capacity: i32): RecordBuffer {
    return new RecordBuffer(capacity);
  }

  /** How many records fit in one frame. */
  capacity(): i32 {
    return this.cap;
  }

  /** How many bytes the records occupy, for a caller budgeting memory. */
  byteLength(): i32 {
    return this.cap * <i32>RECORD_SIZE;
  }

  /** Empty it for the next frame. Keeps the allocation, clears the counters. */
  reset(): void {
    this.count = 0;
    this.dropped = 0;
  }

  /** Whether the next `push` would be refused. */
  full(): bool {
    return this.count >= this.cap;
  }

  /**
   * Append one record, from the five source-rect numbers.
   *
   * Returns false when the buffer is full — and counts it in `dropped`, because
   * a silently short frame is the failure mode this reports rather than causes.
   */
  push(x: i32, y: i32, srcX: u16, srcY: u16, w: u16, h: u16, tex: u16,
       sortKey: u32, groupId: u16, z: u8): bool {
    if (this.count >= this.cap) {
      this.dropped++;
      return false;
    }
    const at = this.view();
    const i = this.count++;
    at[i].setRect(x, y, srcX, srcY, w, h, tex, sortKey, groupId, z);
    return true;
  }

  /** `push`, for a caller that already has a `Frame` (a tileset lookup). */
  pushFrame(x: i32, y: i32, frame: Frame, sortKey: u32, groupId: u16, z: u8): bool {
    return this.push(x, y, frame.srcX, frame.srcY, frame.w, frame.h, frame.tex,
                     sortKey, groupId, z);
  }

  // --- the retaining path --------------------------------------------------
  //
  // `push` is for a caller that rebuilds its record set every frame: it appends
  // and counts. A *scene* does not rebuild — it keeps the bytes from the last
  // frame and overwrites only the slots whose node changed — so it needs to write
  // at an index it chose and to say how many records the buffer now describes.
  //
  // These two are what make a retained packer possible without a second buffer:
  // the out buffer *is* the cache, so a frame where nothing moved writes nothing
  // and still submits a complete record set (`pack()` in `scene.ts`).

  /** How many records the buffer describes. The packer's `count` write. */
  setCount(count: i32): void {
    this.count = count < 0 ? 0 : (count > this.cap ? this.cap : count);
  }

  /**
   * Write record `index` in full, without touching `count` or `dropped`.
   *
   * Out-of-range writes are ignored rather than refused: a packer that computed
   * a slot past the capacity is a bug in the packer, and it already counts the
   * drop — the buffer refusing again would count it twice.
   */
  writeAt(index: i32, x: i32, y: i32, srcX: u16, srcY: u16, w: u16, h: u16, tex: u16,
          sortKey: u32, groupId: u16, z: u8): void {
    if (index < 0 || index >= this.cap) return;
    const at = this.view();
    at[index].setRect(x, y, srcX, srcY, w, h, tex, sortKey, groupId, z);
  }

  /**
   * The records as a view, for `Canvas.submit` and for the scene layer's own
   * emitter.
   *
   * A `let`, not a `const`: a `const` view local in a scope that also declares an
   * integer `const` crashes the compiler (`types.ts` records the repro). No
   * caller needs `const` — nothing reassigns a view.
   */
  view(): @unmanaged [SpriteRecord *] {
    let at = changetype<@unmanaged [SpriteRecord *]>(this.bytes.address());
    return at;
  }

  /** The data address, for `Canvas.submit`. Framework use; see `Bytes.address`. */
  address(): usize {
    return this.bytes.address();
  }
}

/**
 * A `screenshot` destination, and what a test asks of the frame it holds.
 *
 * The buffer is `width * height * 4` bytes of RGBA8, which is the only layout
 * `screenshot` writes. A pixel is read as a packed `u32` rather than as an
 * `Rgba` value: `Rgba` is a plain struct, and returning one by value is refused
 * ("reading an @inline struct value as a whole"), so the channels are read out of
 * the word instead. That is also what makes `nonBlack` one comparison per pixel
 * instead of four field reads.
 */
export class Pixels {
  private bytes: Bytes;
  /** The frame's size, in pixels. `screenshot` fills exactly this. */
  width: i32;
  height: i32;

  constructor(width: i32, height: i32) {
    const w = width > 0 ? width : 0;
    const h = height > 0 ? height : 0;
    this.bytes = Bytes.allocate(w * h * 4);
    this.width = w;
    this.height = h;
  }

  static create(width: i32, height: i32): Pixels {
    return new Pixels(width, height);
  }

  /** The bytes `screenshot` must write: `width * height * 4`. */
  byteLength(): i32 {
    return this.width * this.height * 4;
  }

  /** Whether `x`/`y` is inside the frame. Out-of-range reads answer 0. */
  contains(x: i32, y: i32): bool {
    return x >= 0 && y >= 0 && x < this.width && y < this.height;
  }

  /**
   * One pixel as `0xAABBGGRR` — the byte order in memory, so a little-endian
   * 32-bit load is the pixel and no channel has to be reassembled.
   */
  rgbAt(x: i32, y: i32): u32 {
    if (!this.contains(x, y)) return 0;
    let at = changetype<@unmanaged [Rgba *]>(this.bytes.address());
    const i = y * this.width + x;
    return <u32>at[i].r | (<u32>at[i].g << 8) | (<u32>at[i].b << 16) | (<u32>at[i].a << 24);
  }

  /** One byte of the frame, for a caller that treats it as a blob (a hex dump). */
  byteAt(index: i32): u8 {
    return this.bytes.byteAt(index);
  }

  /** One channel, `0` = red, `1` = green, `2` = blue, `3` = alpha. */
  channelAt(x: i32, y: i32, channel: i32): u8 {
    if (!this.contains(x, y)) return 0;
    let at = changetype<@unmanaged [Rgba *]>(this.bytes.address());
    const i = y * this.width + x;
    if (channel == 0) return at[i].r;
    if (channel == 1) return at[i].g;
    if (channel == 2) return at[i].b;
    if (channel == 3) return at[i].a;
    return 0;
  }

  /** Every pixel whose RGB is not `0,0,0`. Alpha is ignored, as the suites do. */
  nonBlack(): i32 {
    let at = changetype<@unmanaged [Rgba *]>(this.bytes.address());
    let n: i32 = 0;
    const total = this.width * this.height;
    for (let i: i32 = 0; i < total; i++) {
      if (at[i].r != 0 || at[i].g != 0 || at[i].b != 0) n++;
    }
    return n;
  }

  /** The same count over a rectangle, clipped to the frame. */
  nonBlackIn(x: i32, y: i32, w: i32, h: i32): i32 {
    let at = changetype<@unmanaged [Rgba *]>(this.bytes.address());
    let n: i32 = 0;
    const x0 = max<i32>(0, x), y0 = max<i32>(0, y);
    const x1 = min<i32>(this.width, x + w), y1 = min<i32>(this.height, y + h);
    for (let py: i32 = y0; py < y1; py++) {
      for (let px: i32 = x0; px < x1; px++) {
        const i = py * this.width + px;
        if (at[i].r != 0 || at[i].g != 0 || at[i].b != 0) n++;
      }
    }
    return n;
  }

  /** The data address, for `Canvas.screenshot`. Framework use; see `Bytes.address`. */
  address(): usize {
    return this.bytes.address();
  }

  /** The pixels as a view, for a loop that reads channels directly. */
  view(): @unmanaged [Rgba *] {
    let at = changetype<@unmanaged [Rgba *]>(this.bytes.address());
    return at;
  }
}
