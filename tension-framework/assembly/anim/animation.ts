// The animation archive: one clip, stored as three keyframe series over a shared
// time axis.
//
// Layout, in the order `Animation::Save` writes it (animation version 7 — the
// only version the reference loader accepts, and it says so in the source:
// "No retro-compatibility with anterior versions"):
//
//     endianness byte, tag "ozz-animation\0", u32 version = 7
//     f32 duration
//     u32 num_tracks
//     u32 name_len, u32 timepoints_count
//     u32 translations_count, u32 rotations_count, u32 scales_count
//     u32 t_iframe_entries, u32 t_iframe_desc     (and the r_ and s_ pairs)
//     char[name_len] name
//     f32[timepoints_count] ratios
//     per series (translations, rotations, scales):
//         ratios        count x (u8 if timepoints_count <= 255, else u16)
//         previouses    count x u16
//         iframe_entries  n bytes      <- skipped
//         iframe_desc     n x u32      <- skipped
//         iframe_interval f32          <- read and ignored
//         values        count x 6 bytes
//
// Three things about this layout are traps, and each is checked by a test:
//
//   1. **The key arrays cover `Align(num_tracks, 4)` slots, not `num_tracks`**
//      (`animation_builder.cc` pads with identity keys). Every rig whose joint
//      count is not a multiple of four has padding keys — all of ours do — so a
//      parser that trusts `num_tracks` mis-reads the tail of every array.
//   2. **Keys are not sorted by their own time.** The builder sorts by the
//      *previous* key's time (`SortingKeyLess`), which is exactly what makes the
//      first two keys of every slot land at indices `slot` and `slot + slots`.
//      A parser that assumes time order sees `ratios` run backwards.
//   3. **The iframe cache is skippable.** `iframe_entries`/`iframe_desc`/
//      `iframe_interval` are a seek accelerator built from a compressed (GV4)
//      copy of the same key indices; nothing else in the archive depends on
//      them, and `index.ts` rebuilds the same information with one forward pass
//      over `previouses`. This module therefore *skips* those bytes, and the
//      tests assert the parse still ends exactly at the file's last byte —
//      which is the proof it skipped the right number of them.
//
// What is *not* here: sampling. No bracket search, no interpolation, no
// time -> pose. This module hands out keys and their decoded values; the
// evaluator is the next round.

import { BoneTransform, Float3, Quat, halfToFloat, unpackQuatInto } from "./key";
import { Reader } from "./reader";

/** The runtime's per-joint keyframe capacity, as a guard against a corrupt header. */
export const MAX_TRACKS: i32 = 4096;

/**
 * One series' keys: the three arrays the archive stores, in the archive's own
 * form, plus the width of the ratio column.
 *
 * `values` packs the three `u16` of one key consecutively (6 bytes), so key `k`
 * occupies `3k .. 3k + 2`. Ratios are *not* times: they are indices into the
 * animation's shared `timepoints` array, which is why a series cannot resolve a
 * key's time by itself.
 */
export class AnimationSeries {
  /** How many keys this series holds. */
  keyCount: i32 = 0;
  /** Whether ratios are `u16`. The archive chooses by `timepoints_count > 255`. */
  wide: bool = false;
  ratios8: Uint8Array = new Uint8Array(0);
  ratios16: Uint16Array = new Uint16Array(0);
  /** Offset, in keys, back to the same slot's previous key. 0 for the first key. */
  previouses: Uint16Array = new Uint16Array(0);
  /** Three `u16` per key. */
  values: Uint16Array = new Uint16Array(0);

  /** The `timepoints` index this key's ratio points at. */
  ratioIndex(key: i32): i32 {
    if (key < 0 || key >= this.keyCount) return 0;
    return this.wide ? <i32>this.ratios16[key] : <i32>this.ratios8[key];
  }

  /** This key's ratio, i.e. its time divided by the clip's duration. */
  ratio(timepoints: Float32Array, key: i32): f32 {
    const at = this.ratioIndex(key);
    if (at < 0 || at >= timepoints.length) return 0;
    return timepoints[at];
  }

  /** The `component`-th stored `u16` of key `key` (0..2). */
  raw(key: i32, component: i32): u16 {
    if (key < 0 || key >= this.keyCount || component < 0 || component > 2) return 0;
    return this.values[key * 3 + component];
  }

  /** Offset, in keys, from `key` back to its slot's previous key. */
  previousOffset(key: i32): i32 {
    if (key < 0 || key >= this.keyCount) return 0;
    return this.previouses[key];
  }
}

/** A parsed animation archive. `error` is `""` when the parse succeeded. */
export class Animation {
  /** The clip's name, as the exporter wrote it ("run", "idle", …). */
  name: string = "";
  /** The clip's length in seconds. */
  duration: f32 = 0;
  /** The number of joint tracks. Padding slots are *not* counted here. */
  trackCount: i32 = 0;
  /** `Align(trackCount, 4)`: how many slots the key arrays actually cover. */
  slots: i32 = 0;
  /** The shared time axis, as ratios in [0, 1]. */
  timepoints: Float32Array = new Float32Array(0);
  translations: AnimationSeries = new AnimationSeries();
  rotations: AnimationSeries = new AnimationSeries();
  scales: AnimationSeries = new AnimationSeries();
  /** Where the parse stopped: the archive's length when it consumed all of it. */
  bytesConsumed: i32 = 0;
  /** `""`, or why the archive was refused. */
  error: string = "";

  /**
   * Parse an animation archive. Returns an `Animation` either way: check
   * `error`. Every count is bounded by the bytes that are actually left, so a
   * corrupt header is refused instead of asking for an allocation the archive
   * cannot fill.
   */
  static parse(bytes: StaticArray<u8>): Animation {
    const animation = new Animation();
    const reader = new Reader(bytes);

    if (!reader.readEndianness() || !reader.readTag("ozz-animation") || !reader.readVersion(7)) {
      animation.error = reader.error;
      return animation;
    }

    animation.duration = reader.f32();
    const tracks = reader.u32();
    const nameLength = reader.u32();
    const timepointCount = reader.u32();
    const translationCount = reader.u32();
    const rotationCount = reader.u32();
    const scaleCount = reader.u32();
    // The six iframe counts, in header order: t entries, t desc, r entries,
    // r desc, s entries, s desc. Only their *sizes* are used.
    const iframeCounts = new Uint32Array(6);
    for (let i = 0; i < 6; i++) iframeCounts[i] = reader.u32();
    if (!reader.ok) {
      animation.error = reader.error;
      return animation;
    }

    if (tracks == 0 || tracks > <u32>MAX_TRACKS) {
      animation.error =
        "the archive declares " + tracks.toString() + " tracks, which is not in 1.." +
        MAX_TRACKS.toString();
      return animation;
    }
    // A bounded header: every count is a subset of the bytes that follow, and
    // the cheapest thing a count can describe is one byte. `remaining` is the
    // whole archive after the header, so this never rejects a real file and
    // always rejects a nonsense one.
    const budget = <u32>reader.remaining;
    if (nameLength > budget || timepointCount > budget || translationCount > budget ||
        rotationCount > budget || scaleCount > budget) {
      animation.error = "an animation count exceeds the " + budget.toString() + " bytes left in the archive";
      return animation;
    }

    animation.trackCount = tracks;
    animation.slots = ((tracks + 3) / 4) * 4;

    // ── the name ───────────────────────────────────────────────────────────
    if (nameLength > 0) {
      if (!reader.need(<i32>nameLength)) {
        animation.error = reader.error;
        return animation;
      }
      animation.name = String.UTF8.decodeUnsafe(
        changetype<usize>(bytes) + reader.offset,
        <usize>nameLength,
        false,
      );
      reader.offset += <i32>nameLength;
    }

    // ── the shared time axis ───────────────────────────────────────────────
    const timepoints = new Float32Array(timepointCount);
    for (let i = 0; i < timepoints.length; i++) timepoints[i] = reader.f32();
    if (!reader.ok) {
      animation.error = reader.error;
      return animation;
    }
    animation.timepoints = timepoints;

    // ── the three series, in the order the file stores them ────────────────
    const wide = timepointCount > 255;
    animation.translations = readSeries(reader, translationCount, wide, iframeCounts[0], iframeCounts[1]);
    if (!reader.ok) {
      animation.error = reader.error;
      return animation;
    }
    animation.rotations = readSeries(reader, rotationCount, wide, iframeCounts[2], iframeCounts[3]);
    if (!reader.ok) {
      animation.error = reader.error;
      return animation;
    }
    animation.scales = readSeries(reader, scaleCount, wide, iframeCounts[4], iframeCounts[5]);
    if (!reader.ok) {
      animation.error = reader.error;
      return animation;
    }

    animation.bytesConsumed = reader.offset;
    return animation;
  }

  /** The width of one ratio field, in bytes: 1, or 2 when a wide archive. */
  ratioWidth(): i32 {
    return this.timepoints.length > 255 ? 2 : 1;
  }

  /** Key `key` of the translations, decoded. */
  translationAt(key: i32, out: Float3): void {
    out.x = halfToFloat(this.translations.raw(key, 0));
    out.y = halfToFloat(this.translations.raw(key, 1));
    out.z = halfToFloat(this.translations.raw(key, 2));
  }

  /** Key `key` of the rotations, decoded. */
  rotationAt(key: i32, out: Quat): void {
    unpackQuatInto(
      this.rotations.raw(key, 0),
      this.rotations.raw(key, 1),
      this.rotations.raw(key, 2),
      out,
    );
  }

  /** Key `key` of the scales, decoded. */
  scaleAt(key: i32, out: Float3): void {
    out.x = halfToFloat(this.scales.raw(key, 0));
    out.y = halfToFloat(this.scales.raw(key, 1));
    out.z = halfToFloat(this.scales.raw(key, 2));
  }

  /** Key `key` of all three series, decoded into one transform. */
  keyAt(key: i32, out: BoneTransform): void {
    const translation = new Float3();
    const rotation = new Quat();
    const scale = new Float3();
    this.translationAt(key, translation);
    this.rotationAt(key, rotation);
    this.scaleAt(key, scale);
    out.tx = translation.x;
    out.ty = translation.y;
    out.tz = translation.z;
    out.rx = rotation.rx;
    out.ry = rotation.ry;
    out.rz = rotation.rz;
    out.rw = rotation.rw;
    out.sx = scale.x;
    out.sy = scale.y;
    out.sz = scale.z;
  }
}

/**
 * One series, in the file's order, with its own iframe sizes passed in. The
 * count pair comes from the header block `Animation.parse` read before any
 * payload.
 *
 * The iframe bytes are stepped over rather than read. That is deliberate and
 * total: this parser has no GV4 decoder and no path that touches an iframe
 * byte, and the tests prove it by checking the parse still ends exactly at the
 * file's last byte.
 */
function readSeries(
  reader: Reader,
  count: u32,
  wide: bool,
  iframeEntries: u32,
  iframeDesc: u32,
): AnimationSeries {
  const series = new AnimationSeries();
  series.keyCount = <i32>count;
  series.wide = wide;

  if (wide) {
    const ratios = new Uint16Array(<i32>count);
    for (let i = 0; i < ratios.length; i++) ratios[i] = reader.u16();
    series.ratios16 = ratios;
  } else {
    const ratios = new Uint8Array(<i32>count);
    for (let i = 0; i < ratios.length; i++) ratios[i] = reader.u8();
    series.ratios8 = ratios;
  }

  const previouses = new Uint16Array(<i32>count);
  for (let i = 0; i < previouses.length; i++) previouses[i] = reader.u16();
  series.previouses = previouses;

  // The iframe cache: entries (bytes), desc (u32 each), interval (one f32).
  reader.skip(<i32>iframeEntries);
  reader.skip(<i32>iframeDesc * 4);
  reader.skip(4);

  const values = new Uint16Array(<i32>count * 3);
  for (let i = 0; i < values.length; i++) values[i] = reader.u16();
  series.values = values;
  return series;
}
