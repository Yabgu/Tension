// Which slot a key belongs to, and the keys of a slot in order.
//
// This is the module that exists because of the format's third trap: an ozz
// archive does not store a track index per keyframe. It stores `previouses` —
// the distance, in keys, back to the same slot's previous key — and the whole
// track structure has to be recovered from that. The runtime recovers it with a
// compressed "iframe" cache (GV4-encoded checkpoints) plus an incremental walk;
// this does it in one forward pass and never touches a cache byte.
//
// The pass exists because of the second trap: the builder sorts keys by the
// *previous* key's time, and it forces every slot to carry a key at t=0 and one
// at t=duration before sorting. Those two facts put each slot's first key at
// index `slot` and its second at index `slot + slots`, in slot order — so the
// walk has somewhere to start:
//
//     slots = Align(trackCount, 4)
//     for k < slots:              slot[k] = k                 (the first keys)
//     for k < 2*slots:            slot[k] = k - slots         (the second keys)
//     for k from 2*slots:         slot[k] = slot[k - previouses[k]]
//
// After that every step is backwards (`previouses[k] > 0`), so one pass in
// index order classifies every key: no recursion, no cache, and a failure names
// the key index it failed on.
//
// **A slot is not a track.** The arrays cover `Align(trackCount, 4)` slots
// because the runtime's SoA layout wants groups of four; the slots at and above
// `trackCount` are padding the builder filled with identity keys. They are real
// keys in the file and they are parsed like any other — they are just not
// joints, and a parser that dropped them would lose its place in the array.
// That is also why the range check is `< slots`, not `< trackCount`.

import { Animation, AnimationSeries } from "./animation";
import { BoneTransform } from "./key";

export * from "./reader";
export * from "./key";
export * from "./skeleton";
export * from "./animation";

/** Keys per slot, and the keys themselves, grouped by slot. */
export class TrackIndex {
  /** Which slot each key belongs to, one entry per key, in key order. */
  readonly trackOf: Int32Array;
  /** The number of slots the key arrays cover: `Align(trackCount, 4)`. */
  readonly slots: i32;
  /** The number of real tracks, i.e. joints. Slots at and above it are padding. */
  readonly trackCount: i32;
  /** `""`, or why the walk could not be built. */
  error: string = "";

  /** `starts[track] .. starts[track + 1]` are `track`'s keys in `keysByTrack`. */
  private readonly starts: Int32Array;
  private readonly keysByTrack: Int32Array;

  constructor(
    trackOf: Int32Array,
    slots: i32,
    trackCount: i32,
    starts: Int32Array,
    keysByTrack: Int32Array,
  ) {
    this.trackOf = trackOf;
    this.slots = slots;
    this.trackCount = trackCount;
    this.starts = starts;
    this.keysByTrack = keysByTrack;
  }

  /** How many keys slot `track` has. */
  keyCount(track: i32): i32 {
    if (track < 0 || track >= this.slots) return 0;
    return this.starts[track + 1] - this.starts[track];
  }

  /** The `index`-th key of slot `track`, in ascending key order, or -1. */
  key(track: i32, index: i32): i32 {
    if (track < 0 || track >= this.slots) return -1;
    const count = this.keyCount(track);
    if (index < 0 || index >= count) return -1;
    return this.keysByTrack[this.starts[track] + index];
  }

  /** How many keys belong to padding slots, i.e. to no joint at all. Zero for a
   * rig whose joint count is a multiple of four. */
  paddingKeyCount(): i32 {
    let padding = 0;
    for (let track = this.trackCount; track < this.slots; track++) {
      padding += this.keyCount(track);
    }
    return padding;
  }
}

/** An index that failed to build: no keys grouped, the reason attached. */
function failedIndex(slots: i32, trackCount: i32, keys: i32, why: string): TrackIndex {
  const index = new TrackIndex(new Int32Array(keys), slots, trackCount, new Int32Array(slots + 1),
                               new Int32Array(0));
  index.error = why;
  return index;
}

/**
 * Classify every key of one series, then group the keys by slot.
 *
 * The grouping is a counting sort — two passes over the keys, no comparisons —
 * because the walk already produced the slot for each key and ascending key
 * index is the order a sampler wants inside a slot.
 */
export function buildTrackIndex(series: AnimationSeries, trackCount: i32): TrackIndex {
  const slots = ((trackCount + 3) / 4) * 4;
  const keys = series.keyCount;
  const trackOf = new Int32Array(keys);

  if (trackCount <= 0) {
    return failedIndex(slots, trackCount, keys, "an animation with no tracks has no keys to index");
  }
  if (keys < slots * 2) {
    return failedIndex(
      slots,
      trackCount,
      keys,
      "a series of " + keys.toString() + " keys cannot cover " + slots.toString() +
        " slots: the format guarantees at least two keys per slot",
    );
  }

  // The seed: the first keys, then the second keys, in slot order.
  for (let k = 0; k < slots; k++) trackOf[k] = k;
  for (let k = slots; k < slots * 2; k++) trackOf[k] = k - slots;

  // The walk. Every step reads a key that is already classified, because
  // `previouses[k]` is positive: the previous key of the same slot always sits
  // earlier in the array.
  for (let k = slots * 2; k < keys; k++) {
    const back: i32 = series.previouses[k];
    if (back <= 0 || back > k) {
      return failedIndex(
        slots,
        trackCount,
        keys,
        "key " + k.toString() + " names a previous key " + back.toString() +
          " keys back, which is not earlier in the array",
      );
    }
    const previous = trackOf[k - back];
    if (previous < 0 || previous >= slots) {
      return failedIndex(slots, trackCount, keys,
                         "key " + k.toString() + " walks back to slot " + previous.toString());
    }
    trackOf[k] = previous;
  }

  // Group: counting sort by slot, keeping key order inside a slot.
  const starts = new Int32Array(slots + 1);
  for (let k = 0; k < keys; k++) starts[trackOf[k] + 1] += 1;
  for (let track = 0; track < slots; track++) starts[track + 1] += starts[track];
  const cursor = starts.slice(0, slots);
  const keysByTrack = new Int32Array(keys);
  for (let k = 0; k < keys; k++) {
    const track = trackOf[k];
    keysByTrack[cursor[track]] = k;
    cursor[track] += 1;
  }

  return new TrackIndex(trackOf, slots, trackCount, starts, keysByTrack);
}

/** One track index per series: the three are independent (different key counts,
 * different `previouses`), and a sampler needs all three. */
export class AnimationIndex {
  translations: TrackIndex;
  rotations: TrackIndex;
  scales: TrackIndex;

  constructor(translations: TrackIndex, rotations: TrackIndex, scales: TrackIndex) {
    this.translations = translations;
    this.rotations = rotations;
    this.scales = scales;
  }
}

/** Build all three indices for a parsed animation. */
export function indexAnimation(animation: Animation): AnimationIndex {
  return new AnimationIndex(
    buildTrackIndex(animation.translations, animation.trackCount),
    buildTrackIndex(animation.rotations, animation.trackCount),
    buildTrackIndex(animation.scales, animation.trackCount),
  );
}

/**
 * Check a built index against every invariant the format guarantees, and return
 * `""` when they all hold.
 *
 * These are the assertions the tests run, in one place, so a caller can verify a
 * real archive rather than trusting the parser:
 *
 *   * every key's slot is in `[0, slots)`;
 *   * the seed rule holds (first keys at `slot`, second keys at `slot + slots`);
 *   * every later key's `previouses` points backwards, to the same slot;
 *   * a key's time is at or after its predecessor's;
 *   * **the v7 sort order**: the *left* key's ratio is non-decreasing in `k`
 *     (this is the real sort invariant, and the one a parser that assumes
 *     time-sorted keys gets wrong);
 *   * every slot carries at least two keys — the format's own guarantee, since
 *     the builder writes a key at t=0 and one at t=duration for every slot.
 */
export function verifyTrackIndex(
  series: AnimationSeries,
  timepoints: Float32Array,
  index: TrackIndex,
): string {
  if (index.error.length > 0) return index.error;
  const keys = series.keyCount;
  if (index.trackOf.length != keys) {
    return "the index covers " + index.trackOf.length.toString() + " keys, not " + keys.toString();
  }
  const slots = index.slots;

  let previousLeftRatio: f32 = -1;
  for (let k = 0; k < keys; k++) {
    const track = index.trackOf[k];
    if (track < 0 || track >= slots) {
      return "key " + k.toString() + " is in slot " + track.toString() + ", outside 0.." +
        slots.toString();
    }
    if (k < slots) {
      if (track != k) {
        return "key " + k.toString() + " is in slot " + track.toString() + ", not itself";
      }
      continue;
    }
    if (k < slots * 2 && track != k - slots) {
      return "key " + k.toString() + " is in slot " + track.toString() + ", not " +
        (k - slots).toString();
    }
    const back: i32 = series.previouses[k];
    const left = k - back;
    if (back <= 0 || left >= k) {
      return "key " + k.toString() + " does not point backwards";
    }
    if (index.trackOf[left] != track) {
      return "key " + k.toString() + " and its predecessor " + left.toString() + " are in slots " +
        track.toString() + " and " + index.trackOf[left].toString();
    }
    const leftRatio = timepoints[series.ratioIndex(left)];
    const ratio = timepoints[series.ratioIndex(k)];
    if (ratio < leftRatio) {
      return "key " + k.toString() + " is at ratio " + ratio.toString() +
        ", before its predecessor's " + leftRatio.toString();
    }
    if (leftRatio < previousLeftRatio) {
      return "key " + k.toString() + " breaks the v7 sort order: its predecessor is at " +
        leftRatio.toString() + ", after the previous key's " + previousLeftRatio.toString();
    }
    previousLeftRatio = leftRatio;
  }

  for (let track = 0; track < slots; track++) {
    const count = index.keyCount(track);
    if (count < 2) {
      return "slot " + track.toString() + " has " + count.toString() + " key(s), not at least 2";
    }
  }
  return "";
}

/** `verifyTrackIndex` for all three series. */
export function verifyAnimationIndex(animation: Animation, index: AnimationIndex): string {
  const t = verifyTrackIndex(animation.translations, animation.timepoints, index.translations);
  if (t.length > 0) return "translations: " + t;
  const r = verifyTrackIndex(animation.rotations, animation.timepoints, index.rotations);
  if (r.length > 0) return "rotations: " + r;
  const s = verifyTrackIndex(animation.scales, animation.timepoints, index.scales);
  if (s.length > 0) return "scales: " + s;
  return "";
}
