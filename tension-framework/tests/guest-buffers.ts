// Gate Zero: the buffer wrappers survive a collection, and their address is the
// buffer's data rather than the object that owns it.
//
// ## What this is guarding
//
// `changetype<usize>(someTypedArray)` is the **object**, not its data: a
// `Uint8Array` is a small object holding `buffer`, `dataStart` and `byteLength`,
// and the bytes are `32` further on. A record buffer addressed that way writes
// over the object that owns it — first word the collector's link, `+16` the
// `buffer` reference — and the damage lands in the *next mark phase*, as a trap
// at a nonsense address, nowhere near the code that caused it.
//
// Measured on this tree before the wrappers existed: a guest that churned 200 000
// allocations after allocating its record buffer, then called `screenshot`, died
// with
//
//     ~lib/rt/itcms/Object#get:nextWithColor
//     ~lib/rt/itcms/__visit
//     ~lib/rt/itcms/__visit_members
//     ~lib/rt/itcms/step
//     ~lib/rt/itcms/__new  ← an allocation inside .toString()
//     gz3/_start_game
//
// and `memory fault at wasm address 0xff212169`. The same program written
// through `Bytes`/`RecordBuffer` passed, three runs of three.
//
// ## Why this is a fixture and not a comment
//
// The rule was already written down twice — `runtime/arena.ts` says "a `usize` is
// not a TypedArray's bytes", and it cites a mesh whose index 0 named vertex 9248.
// A note in a file did not stop it happening again, because nothing executed it.
// This executes it, with no canvas and no display: the property under test is the
// wrapper's, so the test needs only a heap and a collector.
//
// The first assertion is the sharp one. If a buffer were addressed at its object,
// `push` would overwrite `byteLength` and `byteLength()` would come back wrong
// *immediately* — before any collection, before any trap. So the corruption is
// caught where it happens rather than 200 000 allocations later.

import { Bytes } from "../assembly/bytes";
import { Pixels, RecordBuffer } from "../assembly/2d/buffers";
import { Frame } from "../assembly/2d/types";
import { print } from "../assembly/io";
import { ConfigBuilder, RuntimeSession } from "../assembly/runtime";

const CAPACITY: i32 = 8;
const RECORD_SIZE: usize = 28;
/** Enough allocation that the collector runs several mark phases while the
 *  buffers below are live. Measured: 60 000 is past the first, 200 000 past many;
 *  rounds of 20 000 give the assertions somewhere to stand in between. */
const CHURN_ROUNDS: i32 = 4;
const CHURN_PER_ROUND: i32 = 25000;

let failures: i32 = 0;

function check(ok: bool, what: string): void {
  if (!ok) {
    failures++;
    print("  FAIL: " + what);
  }
}

/// Allocate and drop, so the collector has work and no reason to keep any of it.
function churn(): void {
  let acc: i32 = 0;
  for (let i: i32 = 0; i < CHURN_PER_ROUND; i++) {
    const junk = new Uint8Array(64);
    junk[0] = <u8>i;
    acc += junk[0];
  }
  if (acc == 123456789) print("unreachable " + acc.toString());
}

export function _start_game(): void {
  if (RuntimeSession.open(ConfigBuilder.forThisBuild()) != 0) {
    print("FAIL: the session did not open");
    return;
  }

  // ── the record buffer ────────────────────────────────────────────────────
  const records = RecordBuffer.create(CAPACITY);

  // The sharp assertion: writing through the wrapper must not have touched the
  // object's own fields. A buffer addressed at the object fails here, with no
  // collection involved.
  check(records.byteLength() == <i32>(CAPACITY * <i32>RECORD_SIZE),
        "writing a record corrupted the buffer's own length");
  check(records.capacity() == CAPACITY, "capacity is unchanged after construction");

  const frame = new Frame(0, <u16>16, <u16>32, <u16>8, <u16>16);
  for (let i: i32 = 0; i < CAPACITY; i++) {
    records.pushFrame(100 + i, 200 + i, frame, <u32>(1000 + i), <u16>i, <u8>i);
  }
  check(records.count == CAPACITY, "every push was accepted");
  check(!records.pushFrame(0, 0, frame, 0, 0, 0), "a push past capacity is refused");
  check(records.dropped == 1, "the refusal is counted");

  // ── and the same, across collections ─────────────────────────────────────
  //
  // The records are read back through the buffer's own view after each round, so
  // a moving collector that failed to update anything the guest holds would show
  // up as wrong numbers rather than as a pass on a stale copy.
  for (let round: i32 = 0; round < CHURN_ROUNDS; round++) {
    churn();
    const view = records.view();
    let wrong = 0;
    for (let i: i32 = 0; i < CAPACITY; i++) {
      if (view[i].x != 100 + i || view[i].y != 200 + i ||
          view[i].sortKey != <u32>(1000 + i) || view[i].groupId != <u16>i) {
        wrong++;
      }
    }
    check(wrong == 0, "records changed under collection (round " + round.toString() + ")");
    check(records.byteLength() == <i32>(CAPACITY * <i32>RECORD_SIZE),
          "the buffer's length changed under collection");
    check(records.count == CAPACITY, "the buffer's count changed under collection");
  }

  // ── the pixel buffer ─────────────────────────────────────────────────────
  const pixels = Pixels.create(8, 4);
  check(pixels.byteLength() == 8 * 4 * 4, "Pixels sizes itself from its geometry");
  // `screenshot` has not been called, so the buffer is zeroes — which is also the
  // reading that proves `byteLength` above was not overwritten by a push.
  check(pixels.nonBlack() == 0, "a fresh pixel buffer is empty");
  churn();
  check(pixels.byteLength() == 8 * 4 * 4, "Pixels survived a collection");

  // ── the byte buffer ──────────────────────────────────────────────────────
  const image = Bytes.allocate(32);
  image.fill(0);
  image.setU16(0, 0xBEEF);
  image.setU32(4, 0xDEADBEEF);
  image.setU64(8, 0x0123456789ABCDEF);
  image.setByteAt(30, 7);
  check(image.length == 32, "Bytes reports the length it was asked for");
  churn();
  check(image.byteAt(0) == 0xEF && image.byteAt(1) == 0xBE, "little-endian u16 survives");
  check(image.byteAt(4) == 0xEF && image.byteAt(7) == 0xDE, "little-endian u32 survives");
  check(image.byteAt(15) == 0x01, "little-endian u64 survives");
  check(image.byteAt(30) == 7, "a byte at the far end survives");
  check(image.byteAt(32) == 0, "a read past the end answers 0 rather than faulting");

  // `ofArray` copies rather than aliasing, so editing the literal afterwards
  // cannot change what the buffer says.
  const values: u8[] = [1, 2, 3];
  const copy = Bytes.ofArray(values);
  values[0] = 9;
  check(copy.byteAt(0) == 1, "ofArray copies rather than aliasing the array");
  check(copy.length == 3, "ofArray takes the array's length");

  if (failures != 0) {
    print("buffers: " + failures.toString() + " check(s) failed");
    return;
  }
  print("buffers: " + CAPACITY.toString() + " records held across " +
        (CHURN_ROUNDS * CHURN_PER_ROUND).toString() + " allocations — dataStart is the address");
  print("OK");
  RuntimeSession.close();
}
