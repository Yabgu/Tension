// The `STRING` region's guest half: where a guest puts UTF-8 for an adapter to
// read by `(offset, len)`.
//
// The region is `1 MiB + 32 B`: two 16-byte `StringHalf` descriptors at its
// start, then the buffer the two halves share (`DESIGN.md` §5.2 — the descriptors
// are why the size has a `+ 32`). Half 0 is the guest's and half 1 is the
// session's; the descriptors say where each half starts inside the region and
// how much it holds, and nothing else in chunk 1 writes them.
//
// The management here is deliberately small — an append cursor and a reset —
// because a guest that wants to keep every string it ever wrote wants its *own*
// memory, not the arena's. What the arena is for is handing a path to a
// capability: write it, get the two numbers, pass them in, and let the next
// write overwrite it once the call that needed it has returned.
//
// This lives in the runtime rather than in a capability module on purpose: the
// region belongs to the session, and two capabilities writing it with their own
// rules is how a shared buffer becomes two buffers.

import { STRING_HALF_SIZE, StringHalf, REGION_STRING } from "./wire";
import { regionDesc, regionOffset, regionSize } from "./arena";

/** Which half the guest writes: 0. The session's is 1. */
export const GUEST_HALF: u32 = 0;

/** The descriptor of one half, at the region's start. */
function half(half_: u32): StringHalf {
  return changetype<StringHalf>(regionOffset(REGION_STRING) + half_ * STRING_HALF_SIZE);
}

/**
 * The guest half's descriptor, initialized on first use.
 *
 * A fresh arena has the descriptors zeroed — the session writes the region
 * table but not these, because the halves are the guest's own bookkeeping. So
 * the first call lays them out: half 0 at `2 * STRING_HALF_SIZE` with half the
 * remaining bytes, half 1 after it with the other half. A descriptor that is
 * already initialized is left alone, so a guest that wants to carve the region
 * differently can, before its first `writeString`.
 */
function guestHalf(): StringHalf {
  const descriptor = half(GUEST_HALF);
  if (descriptor.capacity == 0) {
    const regionBytes = regionSize(REGION_STRING) - 2 * STRING_HALF_SIZE;
    const perHalf = regionBytes / 2;
    descriptor.offset = 2 * STRING_HALF_SIZE;
    descriptor.length = 0;
    descriptor.capacity = perHalf;
    descriptor.flags = 0;
    const other = half(1);
    other.offset = 2 * STRING_HALF_SIZE + perHalf;
    other.length = 0;
    other.capacity = perHalf;
    other.flags = 0;
  }
  return descriptor;
}

/**
 * Write `text` into the guest half and return where it landed.
 *
 * The half is a bump buffer: each call appends while it fits. Returns
 * `(offset, 0)` for an empty string, `(0, 0)` when the text does not fit the
 * half that is left — the caller's signal to call `resetStrings` (or to keep
 * fewer strings alive at once), because writing a partial path would hand a
 * capability a name that is not the one it asked for.
 */
export function writeString(text: string): u32 {
  return writeBytes(String.UTF8.encode(text));
}

/** `writeString` for bytes a caller already encoded. Returns the offset in the
 * high half of a u64? No: use `writeBytesAt` for the pair. */
export function writeBytes(bytes: ArrayBuffer): u32 {
  return writeBytesAt(bytes, 0);
}

/** The `(offset, length)` pair of the last successful write, as two numbers. */
export let lastWriteOffset: u32 = 0;
export let lastWriteLength: u32 = 0;

/** Write `bytes` and record the pair; returns the offset, or 0 on overflow. */
export function writeBytesAt(bytes: ArrayBuffer, offsetInHalf: u32 = 0): u32 {
  const descriptor = guestHalf();
  const length = <u32>bytes.byteLength;
  const at = descriptor.offset + offsetInHalf;
  if (offsetInHalf + length > descriptor.capacity) {
    lastWriteOffset = 0;
    lastWriteLength = 0;
    return 0;
  }
  const base = regionOffset(REGION_STRING);
  memory.copy(base + at, changetype<usize>(bytes), length);
  descriptor.length = offsetInHalf + length;
  lastWriteOffset = base + at;
  lastWriteLength = length;
  return lastWriteOffset;
}

/** Rewind the half: the next write starts at its beginning. */
export function resetStrings(): void {
  const descriptor = guestHalf();
  descriptor.length = 0;
  lastWriteOffset = 0;
  lastWriteLength = 0;
}
