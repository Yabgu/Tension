// The TLV argmap encoder, shared by every capability's config builder.
//
// The wire is `tension-core`'s (`session/config.rs` for `session_open`, and the
// same shape for `ogre_init`), and the decoder is authoritative:
//
//   u32 entry_count, then per entry
//     u32 key, u8 tag (2 = i64), i64 value (little-endian, upper four bytes zero)
//
// Two rules this encoder enforces by construction, because both decoders do:
// `abi_version` is the first entry in the byte stream, and a value fits a u32
// (the setters take `u32`, so the i64's upper half is zero by typing). Neither
// capability re-implements this: a second encoder would be a second chance for
// the guest and the host to disagree about a byte.

/** The only value tag this build writes (`config.rs`'s `TAG_I64`). */
const TAG_I64: u8 = 2;

/**
 * One argmap under construction.
 *
 * The constructor takes the ABI key and value rather than a setter, so "the
 * first entry is `abi_version`" is not a rule a caller can forget: there is no
 * way to build an argmap without it.
 */
export class TlvArgmap {
  private keys: Array<u32> = [];
  private values: Array<u32> = [];

  constructor(abiKey: u32, abiVersion: u32) {
    this.keys.push(abiKey);
    this.values.push(abiVersion);
  }

  /** Add one entry. A repeated key takes its last value, as the decoders do. */
  put(key: u32, value: u32): TlvArgmap {
    this.keys.push(key);
    this.values.push(value);
    return this;
  }

  /** How many entries have been written. */
  get count(): u32 {
    return <u32>this.keys.length;
  }

  /** Encode the stream. */
  toBytes(): ArrayBuffer {
    const size = 4 + this.keys.length * (4 + 1 + 8);
    const buf = new ArrayBuffer(size);
    const view = new DataView(buf);
    view.setUint32(0, this.keys.length, true);
    let off = 4;
    for (let i = 0; i < this.keys.length; i++) {
      view.setUint32(off, this.keys[i], true);
      view.setUint8(off + 4, TAG_I64);
      view.setInt64(off + 5, <i64>this.values[i], true);
      off += 13;
    }
    return buf;
  }
}
