// Text that a frame does not allocate: an owned buffer, an appender, and a pool.
//
// ## The allocation this file exists to remove
//
// `String.UTF8.encode(s)` answers a **fresh `ArrayBuffer`**. Every caller that
// wanted bytes therefore allocated once per string, and `widget.ts`'s `drawText`
// did it once per string per frame — which is exactly the cost the retained UI was
// supposed to have removed. The fix is not a cleverer encode; it is to stop asking
// for a new buffer and write into one that already exists:
//
//     const need: i32 = String.UTF8.byteLength(s);      // count, no allocate
//     buf.reserve(need);                                // grow only if it must
//     String.UTF8.encodeUnsafe(changetype<usize>(s), s.length, buf.dataStart);
//
// Measured on TensionScript 0.13.2: `"hello — ok"` is `byteLength` 12 (the em dash
// is three bytes), `encodeUnsafe` returns 12, and the round trip through
// `decodeUnsafe` reads back the original. `encodeUnsafe` needs no `--unsafe` build
// flag, which is why this is a library change and not a compiler one.
//
// ## Three kinds of string, three lifetimes
//
//   * **A widget's text** is owned by the widget and lives as long as it does.
//     `TextBuffer` grows by doubling and never shrinks; retyping into a field that
//     already has room touches no heap. This is what a `Label` holds.
//   * **A composed string** — `"node " + id + " " + name` — is built by
//     `TextBuilder`. A builder over an owned buffer allocates only when it grows;
//     a builder borrowed over a pool window never allocates at all.
//   * **A string that lives one frame** (a status line, a formatted count) goes in
//     the frame's `TextPool`, whose cursor `begin()` rewinds. `highWater` is how
//     many bytes the frame actually used, which is what makes "this frame
//     allocated no text" a number a test can assert rather than a claim.
//
// ## Why the pool is borrowed, not handed out
//
// A pool that answered `Uint8Array` would have to allocate one per string, which
// is the thing being removed. So a pool exposes `start`/`len` — a window into its
// own buffer — and the two readers that need the bytes (`Painter.textBytes` and
// `TextBuffer.setSpan`) take that window. `next()` moves the cursor past the
// string just written, so N ephemeral strings in a frame cost N additions.

/**
 * A widget's text, owned.
 *
 * Grows by doubling and never gives bytes back: a field being retyped rewrites in
 * place, and the occasional growth is amortised against the keystrokes that caused
 * it rather than paid per frame. `len` is a byte count, not a character count —
 * everything downstream (advances, the painter, the caret) indexes bytes.
 */
export class TextBuffer {
  /** The bytes. `len` of them are live; the rest is spare capacity. */
  bytes: Uint8Array;
  /** Live bytes. */
  len: i32 = 0;
  private cap: i32;

  constructor(initial: i32 = 32) {
    const cap: i32 = initial > 0 ? initial : 32;
    this.cap = cap;
    this.bytes = new Uint8Array(cap);
  }

  get capacity(): i32 {
    return this.cap;
  }

  /** Ensure that `need` bytes fit. The only method here that allocates. */
  reserve(need: i32): void {
    if (need <= this.cap) return;
    let cap: i32 = this.cap > 0 ? this.cap : 1;
    while (cap < need) cap = cap * 2 < cap ? need : cap * 2;   // no overflow loop
    const grown = new Uint8Array(cap);
    for (let i: i32 = 0; i < this.len; i++) grown[i] = this.bytes[i];
    this.bytes = grown;
    this.cap = cap;
  }

  /**
   * Replace the contents with a string.
   *
   * No intermediate `Uint8Array`: `byteLength` counts, `encodeUnsafe` writes. A
   * string that fits in the existing capacity allocates nothing at all.
   */
  set(value: string): void {
    const need: i32 = String.UTF8.byteLength(value);
    this.reserve(need);
    const wrote: usize = String.UTF8.encodeUnsafe(changetype<usize>(value), value.length,
                                                  this.bytes.dataStart);
    this.len = <i32>wrote;
  }

  /** Replace the contents with a span of bytes the caller already has. */
  setBytes(src: Uint8Array, start: i32, n: i32): void {
    const take: i32 = n > 0 ? n : 0;
    this.reserve(take);
    for (let i: i32 = 0; i < take; i++) this.bytes[i] = src[start + i];
    this.len = take;
  }

  /** Replace the contents with a window of the frame pool. */
  setSpan(pool: TextPool): void {
    this.setBytes(pool.buffer, pool.start, pool.len);
  }

  /** Insert `n` bytes at byte offset `at`. `at` is clamped into `[0, len]`. */
  insert(at: i32, src: Uint8Array, start: i32, n: i32): void {
    if (n <= 0) return;
    let at2: i32 = at;
    if (at2 < 0) at2 = 0;
    if (at2 > this.len) at2 = this.len;
    this.reserve(this.len + n);
    // Backwards, because the two ranges overlap: a forward copy would smear the
    // tail over the bytes it is about to move.
    for (let i: i32 = this.len - 1; i >= at2; i--) this.bytes[i + n] = this.bytes[i];
    for (let i: i32 = 0; i < n; i++) this.bytes[at2 + i] = src[start + i];
    this.len += n;
  }

  /** Insert `n` bytes of the frame pool at `at`. */
  insertSpan(at: i32, pool: TextPool, n: i32): void {
    this.insert(at, pool.buffer, pool.start, n);
  }

  /** Remove `n` bytes at `at`. Out-of-range asks are clamped, not trapped. */
  remove(at: i32, n: i32): void {
    if (n <= 0 || this.len <= 0) return;
    let at2: i32 = at;
    if (at2 < 0) at2 = 0;
    if (at2 >= this.len) return;
    let take: i32 = n;
    if (at2 + take > this.len) take = this.len - at2;
    for (let i: i32 = at2 + take; i < this.len; i++) this.bytes[i - take] = this.bytes[i];
    this.len -= take;
  }

  clear(): void {
    this.len = 0;
  }

  /** One byte, or 0 outside the live range. */
  at(i: i32): u8 {
    return i >= 0 && i < this.len ? this.bytes[i] : 0;
  }
}

/**
 * A byte appender: `"node " + id + " " + name` without a `String` in sight.
 *
 * `str` appends a string's UTF-8, `int` appends a decimal integer, `ch` appends
 * one byte. Concatenation with `+` on a `String` allocates a new `String` per `+`
 * and then an `ArrayBuffer` to encode it; this allocates nothing once the buffer
 * has room, which is why every composed line in the toolkit goes through it.
 */
export class TextBuilder {
  bytes: Uint8Array;
  /** Bytes live in `[at, at + len)`. */
  len: i32 = 0;
  /** Where this builder's window starts inside `bytes`. */
  at: i32 = 0;
  private cap: i32;
  private owns: bool;
  /** Set when an append did not fit; the text is then a prefix, not a lie. */
  overflowed: bool = false;
  /** Bytes an append could not fit, summed. Read by `TextPool`. */
  droppedBytes: i32 = 0;

  constructor(cap: i32 = 64) {
    const c: i32 = cap > 0 ? cap : 64;
    this.bytes = new Uint8Array(c);
    this.cap = c;
    this.owns = true;
  }

  /**
   * A builder over a window of a buffer somebody else owns.
   *
   * It cannot grow, because growing would mean copying a pool's tail on top of
   * the next string's start. An append that does not fit sets `overflowed` and
   * keeps the prefix.
   */
  static into(buf: Uint8Array, offset: i32, cap: i32): TextBuilder {
    const b = new TextBuilder(1);
    b.bytes = buf;
    b.at = offset > 0 ? offset : 0;
    b.cap = cap > 0 ? cap : 0;
    b.owns = false;
    return b;
  }

  /** Room left in the window. */
  get spare(): i32 {
    return this.cap - this.len;
  }

  /** Move the window to `offset` and empty it. Keeps the capacity. */
  rebase(offset: i32): void {
    this.at = offset > 0 ? offset : 0;
    this.len = 0;
    this.overflowed = false;
  }

  /** Empty the window in place. */
  clear(): void {
    this.len = 0;
    this.overflowed = false;
  }

  /** Make room for `need` more bytes. An owned builder grows; a borrowed one cannot. */
  private reserve(need: i32): bool {
    if (this.len + need <= this.cap) return true;
    if (!this.owns) {
      this.overflowed = true;
      this.droppedBytes += this.len + need - this.cap;
      return false;
    }
    let cap: i32 = this.cap > 0 ? this.cap : 1;
    while (cap < this.len + need) cap = cap * 2 < cap ? this.len + need : cap * 2;
    const grown = new Uint8Array(cap);
    for (let i: i32 = 0; i < this.len; i++) grown[i] = this.bytes[i];
    this.bytes = grown;
    this.cap = cap;
    return true;
  }

  /** Append a string's UTF-8. */
  str(value: string): TextBuilder {
    const need: i32 = String.UTF8.byteLength(value);
    if (!this.reserve(need)) return this;
    const wrote: usize = String.UTF8.encodeUnsafe(changetype<usize>(value), value.length,
                                                  this.bytes.dataStart + <usize>(this.at + this.len));
    this.len += <i32>wrote;
    return this;
  }

  /** Append one byte, for a separator or a quote. */
  ch(value: i32): TextBuilder {
    if (!this.reserve(1)) return this;
    this.bytes[this.at + this.len] = <u8>value;
    this.len++;
    return this;
  }

  /**
   * Append a decimal integer.
   *
   * Hand-rolled because `i32.toString()` allocates a `String`. The magnitude is
   * computed as `0 - u`, which is exact for `INT_MIN` under two's complement — the
   * case a `-v` would trap on.
   */
  int(value: i32): TextBuilder {
    const negative: bool = value < 0;
    let u: u32 = negative ? <u32>(0) - <u32>value : <u32>value;
    let digits: i32 = 1;
    let t: u32 = u;
    while (t >= 10) {
      t /= 10;
      digits++;
    }
    if (!this.reserve(digits + (negative ? 1 : 0))) return this;
    let at: i32 = this.at + this.len;
    let end: i32 = at + digits + (negative ? 1 : 0) - 1;
    this.len += digits + (negative ? 1 : 0);
    while (end >= at) {
      if (negative && end == at) {
        this.bytes[end] = 45;   // '-'
        break;
      }
      this.bytes[end] = <u8>(48 + <i32>(u % 10));
      u /= 10;
      end--;
    }
    return this;
  }
}

/**
 * The frame's scratch text: a bump allocation that `begin()` rewinds.
 *
 * Every ephemeral string in a frame comes out of here, so a frame that draws
 * seventy status words allocates zero buffers. `highWater` is the arithmetic
 * claim: bytes written this frame, so "a label whose text did not change wrote
 * nothing" is `highWater == 0`.
 */
export class TextPool {
  /** The bytes. A window is `[start, start + len)`. */
  buffer: Uint8Array;
  /** Where the current string begins. */
  start: i32 = 0;
  /** Bytes in the current string. */
  len: i32 = 0;
  /** The furthest the cursor reached this frame. */
  highWater: i32 = 0;
  /** Bytes an append could not fit. Non-zero means a string was truncated. */
  dropped: i32 = 0;

  private cap: i32;
  private b: TextBuilder;
  /** The builder's lifetime drop count when this frame began. */
  private droppedBase: i32 = 0;

  constructor(bytes: i32 = 4096) {
    // Locals first: the compiler refuses to read `this` before every field is
    // assigned, and the builder is constructed *over* the buffer.
    const cap: i32 = bytes > 0 ? bytes : 4096;
    const buf = new Uint8Array(cap);
    const b = TextBuilder.into(buf, 0, cap);
    this.cap = cap;
    this.buffer = buf;
    this.b = b;
  }

  get capacity(): i32 {
    return this.cap;
  }

  /** Rewind for a new frame. The allocation survives; only the cursor moves. */
  begin(): void {
    this.b.rebase(0);
    this.start = 0;
    this.len = 0;
    this.highWater = 0;
    this.dropped = 0;
    this.droppedBase = this.b.droppedBytes;
  }

  /** Start a fresh string without discarding the previous one. */
  next(): void {
    this.b.rebase(this.b.at + this.b.len);
    this.start = this.b.at;
    this.len = 0;
  }

  /** Append to the current string. */
  str(value: string): void {
    this.b.str(value);
    this.settle();
  }

  /** Append a decimal integer to the current string. */
  int(value: i32): void {
    this.b.int(value);
    this.settle();
  }

  /** Append one byte to the current string. */
  ch(value: i32): void {
    this.b.ch(value);
    this.settle();
  }

  /** Adopt the builder's window as the current string and track the watermark. */
  private settle(): void {
    this.start = this.b.at;
    this.len = this.b.len;
    if (this.b.at + this.b.len > this.highWater) this.highWater = this.b.at + this.b.len;
    // The builder counts the bytes it could not fit over its whole life; the pool
    // reports this frame's share, which is what `highWater`/`dropped` mean together.
    // Nothing else increments it: a shortfall is a byte count, not an event count.
    this.dropped = this.b.droppedBytes - this.droppedBase;
  }

  /** One byte of the current string, or 0 outside it. */
  at(i: i32): u8 {
    return i >= 0 && i < this.len ? this.buffer[this.start + i] : 0;
  }
}
