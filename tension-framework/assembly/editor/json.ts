// A small JSON writer and reader, because there is no `JSON` in AssemblyScript.
//
// ## Why hand-rolled, and why this shape
//
// A `Document` has to survive a save and a reload, and a format a human can read
// and diff is worth more than one that is compact: an editor's document is
// something a person will look at in `git diff`. JSON is that format, and this
// runtime has no parser for it — `apps/docs/src/format.ts` has a number reader
// for a binary bundle, not a general JSON library.
//
// So: a writer that emits, and a reader that walks the same grammar with **no
// schema of its own**. The caller drives the reader — `enterObject`, then `key()`
// in a loop, dispatching on the name — which is what makes the format forgiving
// in the direction that matters: a document written by a newer build with an
// extra field still loads here, because an unknown key is *skipped* rather than
// misread as the next field.
//
// ## Why the caller drives rather than a callback
//
// A visitor callback would be a closure, and a closure over a local is the shape
// that traps on this toolchain (`scene.ts` records the four measurements). The
// reader therefore exposes `tryCloseObject`/`tryCloseArray`/`tryComma` and lets
// the caller write the loop. It is three lines per container and it cannot trap.
//
// ## What is deliberately not supported
//
// No `null` (a field is present or absent), no exponent notation (a document
// holds pixel positions, not measurements), and no `\u` escapes on **write** (they
// are read). Every refusal is reported on the `JsonError` the caller supplied,
// never thrown: `res.ts` states the no-throw rule for the whole SDK, and a
// document that failed to parse has to be shown to a person.

import { Bytes } from "../bytes";

/**
 * Builds JSON text into a growable byte array, then hands it out as `Bytes`.
 *
 * A byte array rather than a `String` builder because the output *is* bytes — the
 * caller writes them to a file — and escaping into a `String` would be a copy for
 * nothing.
 */
export class JsonOut {
  private out: u8[] = [];
  /** One entry per open container: how many elements it holds. */
  private counts: i32[] = [];
  /** A key has been written and its value is next; that value adds no comma. */
  private pendingKey: bool = false;

  private byte(value: i32): void {
    this.out.push(<u8>value);
  }

  /** Raw UTF-8 of `text`. */
  private raw(text: string): void {
    if (text.length == 0) return;
    const encoded = String.UTF8.encode(text, false);
    const view = Uint8Array.wrap(encoded);
    for (let i: i32 = 0; i < view.length; i++) this.out.push(view[i]);
  }

  /**
   * The separator rule, in one place.
   *
   * A value adds a `,` when it is not the first element of its container, and
   * never right after a key (the key already claimed that slot).
   */
  private beforeValue(): void {
    if (this.counts.length == 0) {
      this.pendingKey = false;
      return;
    }
    const at: i32 = this.counts.length - 1;
    if (this.pendingKey) {
      // The key already wrote this slot's separator; the value only counts.
      this.pendingKey = false;
      this.counts[at] = this.counts[at] + 1;
      return;
    }
    if (this.counts[at] > 0) this.byte(44); // ','
    this.counts[at] = this.counts[at] + 1;
  }

  beginObject(): JsonOut {
    this.beforeValue();
    this.byte(123); // '{'
    this.counts.push(0);
    return this;
  }

  endObject(): JsonOut {
    return this.close(125);
  }

  beginArray(): JsonOut {
    this.beforeValue();
    this.byte(91); // '['
    this.counts.push(0);
    return this;
  }

  endArray(): JsonOut {
    return this.close(93);
  }

  private close(ch: i32): JsonOut {
    if (this.counts.length == 0) return this;
    this.counts.pop();
    this.byte(ch);
    return this;
  }

  /** A key and the `:` after it. Its value must follow immediately. */
  key(name: string): JsonOut {
    if (this.counts.length > 0) {
      const at: i32 = this.counts.length - 1;
      if (this.counts[at] > 0) this.byte(44);
    }
    this.writeString(name);
    this.byte(58); // ':'
    this.pendingKey = true;
    return this;
  }

  number(v: f32): JsonOut {
    this.beforeValue();
    this.writeNumber(v);
    return this;
  }

  bool(v: bool): JsonOut {
    this.beforeValue();
    this.raw(v ? "true" : "false");
    return this;
  }

  string(v: string): JsonOut {
    this.beforeValue();
    this.writeString(v);
    return this;
  }

  private writeNumber(v: f32): void {
    // `NaN` and the infinities have no JSON spelling, so they are written as 0
    // rather than as something the reader would refuse.
    if (v != v || v > 3.0e38 || v < -3.0e38) {
      this.byte(48); // '0'
      return;
    }
    if (v == 0.0) {
      this.byte(48);
      return;
    }
    // An integer prints as one, which is what a document full of node ids and
    // pixel positions looks like in a diff.
    const whole: i64 = <i64>v;
    if (<f32>whole == v) {
      this.raw(whole.toString());
      return;
    }
    // Six decimals: more than a pixel position needs, and it trims the binary
    // noise an f32 carries (`1.2000000476837158` is not a useful diff line).
    const rounded: f64 = Math.round(<f64>v * 1.0e6) / 1.0e6;
    this.raw(rounded.toString());
  }

  /** A string with the escapes JSON requires; a control byte becomes `\uXXXX`. */
  private writeString(v: string): void {
    this.byte(34); // '"'
    for (let i: i32 = 0; i < v.length; i++) {
      const code: i32 = v.charCodeAt(i);
      if (code == 34) { this.byte(92); this.byte(34); continue; }   // \" 
      if (code == 92) { this.byte(92); this.byte(92); continue; }   // \\
      if (code == 10) { this.byte(92); this.byte(110); continue; }  // \n
      if (code == 13) { this.byte(92); this.byte(114); continue; }  // \r
      if (code == 9) { this.byte(92); this.byte(116); continue; }   // \t
      if (code < 32) {
        this.byte(92); this.byte(117); this.byte(48); this.byte(48);
        this.byte(hexDigit((code >> 4) & 0xF));
        this.byte(hexDigit(code & 0xF));
        continue;
      }
      this.raw(v.charAt(i));
    }
    this.byte(34);
  }

  /** The finished text. A trailing newline, because a document is a file. */
  finish(): Bytes {
    this.byte(10);
    return Bytes.ofArray(this.out);
  }
}

function hexDigit(nibble: i32): i32 {
  return nibble < 10 ? 48 + nibble : 87 + nibble; // '0'..'9', 'a'..'f'
}

/**
 * Why a document did not load. Empty `message` means it did.
 *
 * A value rather than a throw, for the reason in this file's header — and because
 * the caller has to *show* it: an editor that silently opened an empty document
 * instead of a corrupt one would eat the user's work.
 */
export class JsonError {
  message: string = "";
  /** The byte offset the reader stopped at, or -1. */
  at: i32 = -1;
  get ok(): bool { return this.message.length == 0; }
}

/**
 * Walks the text `JsonOut` writes — and, deliberately, a superset of it.
 *
 * Every `take` advances; the `try*` helpers peek and consume only on a match, so a
 * caller's loop is `while (!in.tryCloseObject()) { … in.tryComma(); }`.
 */
export class JsonIn {
  private bytes: Bytes;
  private at: i32 = 0;
  private error: JsonError;

  constructor(bytes: Bytes, error: JsonError) {
    this.bytes = bytes;
    this.error = error;
  }

  /** Where the reader is, for a diagnostic. */
  get offset(): i32 {
    return this.at;
  }

  /**
   * Whether the reader has given up.
   *
   * Every loop over this reader must test it. A failed read consumes nothing, so
   * `while (!tryCloseObject())` at end-of-input would otherwise spin forever —
   * measured, on the first run of this file's own fixture, where a deliberately
   * truncated document hung the process instead of being refused.
   */
  get failed(): bool {
    return !this.error.ok;
  }

  // --- lexing --------------------------------------------------------------

  private peek(): i32 {
    return this.at < this.bytes.length ? <i32>this.bytes.byteAt(this.at) : -1;
  }

  private take(): i32 {
    const c: i32 = this.peek();
    if (c >= 0) this.at++;
    return c;
  }

  private skipSpace(): void {
    while (this.at < this.bytes.length) {
      const c: i32 = <i32>this.bytes.byteAt(this.at);
      if (c == 32 || c == 9 || c == 10 || c == 13) {
        this.at++;
        continue;
      }
      break;
    }
  }

  private fail(message: string): void {
    if (this.error.ok) {
      this.error.message = message + " (at byte " + this.at.toString() + ")";
      this.error.at = this.at;
    }
  }

  /** Whether the next non-space byte is `ch`, without consuming it. */
  atChar(ch: i32): bool {
    this.skipSpace();
    return this.peek() == ch;
  }

  private expectByte(want: i32, what: string): bool {
    this.skipSpace();
    if (this.take() != want) {
      this.fail("expected " + what);
      return false;
    }
    return true;
  }

  // --- structure -----------------------------------------------------------

  /** Consume `{`. */
  enterObject(): bool {
    return this.expectByte(123, "'{'");
  }

  /** Consume `}` if it is next — the loop's exit test for an object. */
  tryCloseObject(): bool {
    this.skipSpace();
    if (this.peek() != 125) return false;
    this.at++;
    return true;
  }

  /** Consume `[`. */
  enterArray(): bool {
    return this.expectByte(91, "'['");
  }

  /** Consume `]` if it is next — the loop's exit test for an array. */
  tryCloseArray(): bool {
    this.skipSpace();
    if (this.peek() != 93) return false;
    this.at++;
    return true;
  }

  /**
   * The separator check between elements — **strict**, because the format claims
   * to be JSON and a file no other parser can read is a file with a private
   * format.
   *
   * Call it after every element. A `,` is consumed (and a trailing one is refused);
   * the container's closer is left for `tryCloseObject`/`tryCloseArray`; anything
   * else — including end of input — is an error. The strictness is the reason this
   * exists at all: the first version accepted `{"a":1"b":2}`, which round-tripped
   * through this reader and through nothing else.
   */
  tryComma(): void {
    this.skipSpace();
    const c: i32 = this.peek();
    if (c == 44) {
      this.at++;
      this.skipSpace();
      if (this.peek() == 125 || this.peek() == 93) this.fail("trailing comma");
      return;
    }
    if (c == 125 || c == 93) return;             // the closer; the loop consumes it
    this.fail(c < 0 ? "unterminated container" : "expected ',' or the end of the container");
  }

  /** Read a key and the `:` after it. */
  key(): string {
    if (!this.expectByte(34, "a key")) return "";
    const name = this.readStringBody();
    this.expectByte(58, "':'");
    return name;
  }

  // --- values --------------------------------------------------------------

  number(): f32 {
    this.skipSpace();
    let sign: f64 = 1.0;
    if (this.peek() == 45) {          // '-'
      this.at++;
      sign = -1.0;
    }
    let whole: f64 = 0.0;
    let digits: i32 = 0;
    while (true) {
      const c: i32 = this.peek();
      if (c < 48 || c > 57) break;
      whole = whole * 10.0 + <f64>(c - 48);
      digits++;
      this.at++;
    }
    let frac: f64 = 0.0;
    let scale: f64 = 1.0;
    if (this.peek() == 46) {          // '.'
      this.at++;
      while (true) {
        const c: i32 = this.peek();
        if (c < 48 || c > 57) break;
        scale *= 10.0;
        frac += <f64>(c - 48) / scale;
        digits++;
        this.at++;
      }
    }
    if (digits == 0) {
      this.fail("expected a number");
      return 0.0;
    }
    return <f32>(sign * (whole + frac));
  }

  bool(): bool {
    this.skipSpace();
    if (this.peek() == 116) {         // 't'
      this.word("true");
      return true;
    }
    if (this.peek() == 102) {         // 'f'
      this.word("false");
      return false;
    }
    this.fail("expected true or false");
    return false;
  }

  private word(text: string): void {
    for (let i: i32 = 0; i < text.length; i++) {
      if (this.take() != text.charCodeAt(i)) {
        this.fail("expected '" + text + "'");
        return;
      }
    }
  }

  string(): string {
    this.skipSpace();
    if (!this.expectByte(34, "a string")) return "";
    return this.readStringBody();
  }

  private readStringBody(): string {
    // A byte array plus one decode at the end, rather than `out +=` per
    // character: string concatenation in a loop is a fresh allocation each time,
    // and a document's `nodes` array is thousands of characters.
    let raw: u8[] = [];
    while (true) {
      const c: i32 = this.take();
      if (c < 0) {
        this.fail("unterminated string");
        break;
      }
      if (c == 34) break;             // closing quote
      if (c == 92) {                  // backslash
        const esc: i32 = this.take();
        if (esc == 110) { raw.push(10); continue; }
        if (esc == 114) { raw.push(13); continue; }
        if (esc == 116) { raw.push(9); continue; }
        if (esc == 34) { raw.push(34); continue; }
        if (esc == 92) { raw.push(92); continue; }
        if (esc == 117) {             // \uXXXX — ASCII only, which is all we write
          let code: i32 = 0;
          for (let i: i32 = 0; i < 4; i++) code = code * 16 + hexValue(this.take());
          raw.push(<u8>(code & 0x7F));
          continue;
        }
        this.fail("unknown escape");
        break;
      }
      raw.push(<u8>(c & 0xFF));
    }
    if (raw.length == 0) return "";
    const bytes = Bytes.ofArray(raw);
    return String.UTF8.decodeUnsafe(bytes.address(), <usize>raw.length, false);
  }

  /**
   * Skip one value of any kind — how an unknown key is ignored.
   *
   * Recursive, and depth-limited: a document is a shallow structure, and an
   * unbounded recursion on attacker-supplied bytes is a stack overflow rather
   * than a refusal.
   */
  skipValue(): void {
    this.skipValueAt(0);
  }

  private skipValueAt(depth: i32): void {
    if (depth > 16) {
      this.fail("nested too deeply");
      return;
    }
    this.skipSpace();
    const c: i32 = this.peek();
    if (c == 123) {                              // '{'
      if (!this.enterObject()) return;
      while (!this.tryCloseObject() && !this.failed) {
        this.key();
        this.skipValueAt(depth + 1);
        this.tryComma();
      }
      return;
    }
    if (c == 91) {                               // '['
      if (!this.enterArray()) return;
      while (!this.tryCloseArray() && !this.failed) {
        this.skipValueAt(depth + 1);
        this.tryComma();
      }
      return;
    }
    if (c == 34) {
      this.string();
      return;
    }
    if (c == 116 || c == 102) {
      this.bool();
      return;
    }
    this.number();
  }
}

function hexValue(c: i32): i32 {
  if (c >= 48 && c <= 57) return c - 48;
  if (c >= 97 && c <= 102) return c - 87;
  if (c >= 65 && c <= 70) return c - 55;
  return 0;
}
