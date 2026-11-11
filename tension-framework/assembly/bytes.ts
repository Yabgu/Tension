// tension-framework/assembly/bytes.ts — an owned run of bytes, with no address.
//
// ## Why this exists
//
// Every verb that takes a buffer used to take `(ptr: usize, len: i32)`, so a
// guest wrote `memory.data(size, 8)` and handed the number back. Three things
// follow from that, and all three were measured:
//
//   * **`memory.data` takes a compile-time size.** A buffer whose capacity comes
//     from a config file could not be allocated at all — the workaround was a
//     constant, so a guest's maximum scene was frozen at build time.
//   * **The pointer is unchecked.** `loadTexture(0, 584)` compiles, and the verb
//     answers `-EINVAL` at the boundary instead of the guest being told it has
//     no buffer.
//   * **`changetype<usize>(x)` is a trap, and it fired.** `x` is not always what
//     you think: for an `ArrayBuffer` the object pointer *is* the data, while for
//     a **TypedArray** it is the object — header, buffer field, length — and the
//     data is `32` bytes further on. A record buffer built with
//     `changetype<usize>(new Uint8Array(n))` therefore writes over the object
//     that owns it: first word the collector's link, and at `+16` the `buffer`
//     reference. It renders correctly, because the bytes it wrote happen to be
//     the shape the verb wants, and then the **next mark phase** follows the
//     corrupt link and traps at an address like `0xff212169`. That is the Gate
//     Zero fault, reproduced on this tree: `~lib/rt/itcms/Object#get:nextWithColor`
//     ← `__visit` ← `ArrayBufferView~visit` ← `Uint8Array~visit` ← `itcms/step`.
//
// `runtime/arena.ts` documents the third rule and it cost "an afternoon the
// first time"; the lesson here is that a rule written in a comment is not a
// guarantee. This class is the guarantee: **the framework holds the only
// address, and it is `dataStart`.**
//
// ## The one rule this file enforces
//
// A byte buffer is a `Uint8Array`, always, and its address is `view.dataStart` —
// never `changetype<usize>(view)`, and never `changetype<usize>(view.buffer)`
// either (that one is correct for the ArrayBuffer but only by the accident that
// an ArrayBuffer's payload starts at its object pointer). One spelling, and it
// is the field the runtime declares for exactly this purpose.
//
// `dataStart` is stable for the object's life: the collector is two-colour
// **mark & sweep** (`std/assembly/rt/tcms.ts`), so it never moves an object. What
// keeps the address valid is keeping the *reference* — which is why the view is a
// field and not a local, and why nothing here returns a `usize` to a caller that
// could outlive the `Bytes`.
//
// Verified: 200,000 allocations of churn (a collection forced between every
// batch) with the buffer live throughout, then read back correctly — three runs
// out of three. The same program with `changetype<usize>(view)` traps.
//
// ## Not a `memory.data` replacement
//
// `memory.data` returns a **static** block: never collected, and never resizable.
// `Bytes` is a heap object, so its size is a runtime value — which is what a
// scene with a capacity from a config file needs. A guest that genuinely wants a
// static block still has `memory.data`; nothing here takes that away.

/** An owned run of bytes. The address never leaves the framework's verbs. */
export class Bytes {
  /**
   * The owned view, and the only thing that keeps the data alive.
   *
   * A field rather than a local for the obvious reason: an address taken from a
   * local that has gone out of scope is an address into a collected object.
   */
  private view: Uint8Array;

  private constructor(view: Uint8Array) {
    this.view = view;
  }

  /** A zeroed buffer of `size` bytes. A negative size is a zero-length buffer. */
  static allocate(size: i32): Bytes {
    return new Bytes(new Uint8Array(size > 0 ? size : 0));
  }

  /**
   * A view over an `ArrayBuffer` the caller already owns — no copy.
   *
   * This is the path a file takes: `ResFile.readAll()` answers an `ArrayBuffer`,
   * and copying a 200 KB IWI to satisfy a type would be a copy nothing asked for.
   * `Uint8Array.wrap` keeps the buffer reachable through the view, so the
   * address stays valid exactly as long as the `Bytes` does.
   */
  static of(buffer: ArrayBuffer): Bytes {
    return new Bytes(Uint8Array.wrap(buffer, 0, buffer.byteLength));
  }

  /**
   * A copy of a plain `u8[]` literal — the generated graph blob's shape.
   *
   * A copy rather than a view of the array's own storage: `Array<u8>`'s
   * `dataStart` is inline and readable, but a `Bytes` that aliased a mutable
   * array would change under a caller that edited it, and 584 bytes once at
   * startup is not worth the aliasing rule.
   */
  static ofArray(values: u8[]): Bytes {
    const out = new Bytes(new Uint8Array(values.length));
    const at = out.view;
    for (let i: i32 = 0; i < values.length; i++) at[i] = values[i];
    return out;
  }

  /**
   * A view over a `Uint8Array` the caller already owns — no copy.
   *
   * The typed-array counterpart of {@link of}, and the one `resReadFile`
   * answers with. It does **not** keep the caller's variable alive — it keeps the
   * *buffer*, which is what the view points into, so a caller may drop its own
   * reference as soon as this returns.
   */
  static viewOf(bytes: Uint8Array): Bytes {
    return new Bytes(bytes);
  }

  /** UTF-8 bytes of `text` — for a verb that takes a byte string. */
  static ofString(text: string): Bytes {
    return Bytes.of(String.UTF8.encode(text));
  }

  /** How many bytes this holds. */
  get length(): i32 {
    return this.view.length;
  }

  /** Whether a length of zero is all it has. */
  get isEmpty(): bool {
    return this.view.length == 0;
  }

  // --- byte access ---------------------------------------------------------
  //
  // The writer half. A guest that builds a container — hello-sprites builds an
  // IWI file to upload — needs to place fields at offsets, and the alternative to
  // these is `store<u8>(address + n, v)` in the guest, which is the address leak
  // this class exists to remove. Little-endian, because wasm is and because every
  // container this tree reads (IWI, T2DG, the solver config) is.

  byteAt(index: i32): u8 {
    return index >= 0 && index < this.view.length ? this.view[index] : 0;
  }

  setByteAt(index: i32, value: u8): void {
    if (index < 0 || index >= this.view.length) return;
    this.view[index] = value;
  }

  setU16(index: i32, value: u16): void {
    this.setByteAt(index, <u8>(value & 0xFF));
    this.setByteAt(index + 1, <u8>(value >> 8));
  }

  setU32(index: i32, value: u32): void {
    this.setByteAt(index + 0, <u8>(value & 0xFF));
    this.setByteAt(index + 1, <u8>((value >> 8) & 0xFF));
    this.setByteAt(index + 2, <u8>((value >> 16) & 0xFF));
    this.setByteAt(index + 3, <u8>((value >> 24) & 0xFF));
  }

  setU64(index: i32, value: u64): void {
    this.setU32(index, <u32>(value & 0xFFFF_FFFF));
    this.setU32(index + 4, <u32>(value >> 32));
  }

  /** Fill every byte with `value`. */
  fill(value: u8): void {
    const at = this.view;
    for (let i: i32 = 0; i < at.length; i++) at[i] = value;
  }

  /**
   * The data address, for the framework's own verbs.
   *
   * **A guest should never call this.** It is here because AssemblyScript's
   * `private` is per-file and `canvas.ts` needs the number to reach
   * `loadTexture`/`set_pipeline`; every such use is inside this framework. A
   * guest that calls it is opting out of the guarantee this file makes, and the
   * next `changetype` it writes from that number is its own.
   */
  address(): usize {
    return this.view.dataStart;
  }
}
