// The animation runtime archive parser, against the format's own archives.
//
// This fixture is the parser's proof, and it is deliberately a *pure function*
// test: no capability, no adapter, no host object beyond `print`. It parses four
// vendor-written archive pairs and asserts every value against expectations
// taken from the format's own runtime (see `anim-expectations.ts` for how
// those literals were produced), then checks the three format traps, then
// checks that two archives the format does not accept are refused.
//
// What each assertion buys:
//
//   1. **Values.** Joint count, parents, names, rest poses, clip name, duration,
//      track count, timepoint count, per-series key counts, and — for track 0 —
//      the first two keys' indices, raw `u16` triples, ratios, and decoded
//      values. Exact equality throughout: halves and quaternions are decoded by
//      arithmetic that has one right answer, so "close" would be a bug.
//   2. **The walk terminates and is stable.** Four fixtures, three series each,
//      built twice: the index must be in range, must be byte-identical on a
//      second run, and must satisfy every invariant `verifyTrackIndex` states.
//   3. **Trap T1 — padding.** For a rig whose joint count is not a multiple of
//      four, the key arrays cover `Align(trackCount, 4)` slots and the extra
//      slots hold the builder's identity keys. Asserted both ways: a padded rig
//      *must* carry padding keys (and they must decode to the identity
//      transform), and a rig that is already a multiple of four must carry none.
//   4. **Trap T2 — the sort order.** The v7 builder sorts by the *previous*
//      key's time, so `ratios` is not monotonic in the key index. What is
//      monotonic is the left key's ratio, and that is asserted at every key of
//      every series.
//   5. **Trap T3 — the iframe cache is skipped.** There is no GV4 decoder in the
//      parser and no code path that reads an iframe byte; the observable proof
//      is that a parse ends exactly at the archive's last byte, on every
//      fixture. It is the strict check: skip one byte too few and the decoded
//      values below come out wrong, too many and the offset overshoots.
//   6. **Refusals.** A skeleton v1 archive, a big-endian skeleton, and an
//      animation v6 archive must each be refused with a message that names the
//      problem — and must not be partially parsed first (`bytesConsumed == 0`).
//
// Deviations from the brief this round, both deliberate:
//
//   * the brief's assertion 2 says every `track[k]` is in `[0, num_tracks)`.
//     That is wrong for a padded rig — and T1 (in the same list) is the reason:
//     the padding slots are real keys with real track indices, `num_tracks <=
//     track < slots`. The range asserted here is `[0, slots)`, with the padding
//     split out and asserted separately as identity.
//   * the fixtures arrive as hex rather than as embedded bytes, because
//     AssemblyScript 0.28 has no `includeBytes`. See `anim-fixtures.ts`.

import { print } from "../assembly/io";
import {
  Animation,
  AnimationIndex,
  AnimationSeries,
  BoneTransform,
  Float3,
  Quat,
  Skeleton,
  TrackIndex,
  indexAnimation,
  verifyAnimationIndex,
} from "../assembly/anim";
import { fixtureBytes, fixtureFnv, fixtureLength, fnv1a } from "./anim-fixtures";
import {
  AnimationExpect,
  FixturePair,
  SeriesExpect,
  SkeletonExpect,
  fixturePairs,
} from "./anim-expectations";

/** Which series a helper is working on. */
const TRANSLATIONS: i32 = 0;
const ROTATIONS: i32 = 1;
const SCALES: i32 = 2;

/** One refusal fixture: what it is, and what its message must name. */
class Refusal {
  fixture: string;
  isSkeleton: bool;
  /** A substring the refusal must contain. */
  needle: string;
  bytes: i32;

  constructor(fixture: string, isSkeleton: bool, needle: string, bytes: i32) {
    this.fixture = fixture;
    this.isSkeleton = isSkeleton;
    this.needle = needle;
    this.bytes = bytes;
  }
}

export function _start_game(): void {
  const pairs = fixturePairs();
  assert(pairs.length == 4, "the expectations must describe four fixture pairs");
  for (let i = 0; i < pairs.length; i++) {
    checkPair(pairs[i]);
  }

  checkRefusals();

  print("OK");
}

/** Everything asserted about one skeleton + animation pair. */
function checkPair(pair: FixturePair): void {
  const label = pair.label;

  // ── the fixture itself, before the parser is trusted with it ────────────
  const skeletonBytes = fixtureBytes(pair.skeleton);
  assert(
    skeletonBytes.length == fixtureLength(pair.skeleton),
    label + ": the skeleton fixture decoded to " + skeletonBytes.length.toString() +
      " bytes, not " + fixtureLength(pair.skeleton).toString(),
  );
  assert(
    fnv1a(skeletonBytes) == fixtureFnv(pair.skeleton),
    label + ": the skeleton fixture's hash does not match the generator's",
  );

  const animationBytes = fixtureBytes(pair.animation);
  assert(
    animationBytes.length == fixtureLength(pair.animation),
    label + ": the animation fixture decoded to " + animationBytes.length.toString() +
      " bytes, not " + fixtureLength(pair.animation).toString(),
  );
  assert(
    fnv1a(animationBytes) == fixtureFnv(pair.animation),
    label + ": the animation fixture's hash does not match the generator's",
  );

  checkSkeleton(label, skeletonBytes, pair.skeletonExpect);
  checkAnimation(label, animationBytes, skeletonBytes.length, pair.skeletonExpect.bytes,
                 pair.animationExpect);
}

// ── the skeleton ────────────────────────────────────────────────────────────

function checkSkeleton(label: string, bytes: StaticArray<u8>, expect: SkeletonExpect): void {
  const skeleton = Skeleton.parse(bytes);
  assert(skeleton.error == "", label + ": skeleton refused: " + skeleton.error);

  assert(
    skeleton.bytesConsumed == expect.bytes,
    label + ": the skeleton parse consumed " + skeleton.bytesConsumed.toString() + " of " +
      expect.bytes.toString() + " bytes",
  );
  assert(
    skeleton.jointCount == expect.jointCount,
    label + ": joint count " + skeleton.jointCount.toString() + ", expected " +
      expect.jointCount.toString(),
  );
  assert(
    skeleton.soaBlockCount() == (expect.jointCount + 3) / 4,
    label + ": the rest poses occupy " + skeleton.soaBlockCount().toString() +
      " SoA block(s), expected " + ((expect.jointCount + 3) / 4).toString(),
  );

  for (let i = 0; i < expect.parents.length; i++) {
    assert(
      skeleton.parent(i) == expect.parents[i],
      label + ": parent[" + i.toString() + "] is " + skeleton.parent(i).toString() + ", expected " +
        expect.parents[i].toString(),
    );
  }
  for (let i = 0; i < expect.names.length; i++) {
    assert(
      skeleton.name(i) == expect.names[i],
      label + ": name[" + i.toString() + "] is \"" + skeleton.name(i) + "\", expected \"" +
        expect.names[i] + "\"",
    );
  }

  // The rest poses are the SoA trap: gathered per joint they must equal what
  // the format's own accessor reports for that joint.
  const transform = new BoneTransform();
  for (let joint = 0; joint < expect.rest.length; joint++) {
    skeleton.restTransformInto(joint, transform);
    const values: f32[] = [
      transform.tx, transform.ty, transform.tz, //
      transform.rx, transform.ry, transform.rz, transform.rw, //
      transform.sx, transform.sy, transform.sz,
    ];
    const expected = expect.rest[joint];
    assert(
      values.length == expected.length,
      label + ": rest[" + joint.toString() + "] has " + values.length.toString() + " values",
    );
    for (let i = 0; i < values.length; i++) {
      assert(
        values[i] == expected[i],
        label + ": rest[" + joint.toString() + "][" + i.toString() + "] is " + values[i].toString() +
          ", expected " + expected[i].toString(),
      );
    }
  }
}

// ── the animation ───────────────────────────────────────────────────────────

function checkAnimation(
  label: string,
  bytes: StaticArray<u8>,
  skeletonBytes: i32,
  skeletonExpectBytes: i32,
  expect: AnimationExpect,
): void {
  const animation = Animation.parse(bytes);
  assert(animation.error == "", label + ": animation refused: " + animation.error);

  // Trap T3's observable form: the whole archive, to the byte, with the iframe
  // bytes skipped rather than read.
  assert(
    animation.bytesConsumed == expect.bytes,
    label + ": the animation parse consumed " + animation.bytesConsumed.toString() + " of " +
      expect.bytes.toString() + " bytes",
  );
  assert(animation.name == expect.name, label + ": clip name \"" + animation.name + "\"");
  assert(
    animation.duration == expect.duration,
    label + ": duration " + animation.duration.toString() + ", expected " +
      expect.duration.toString(),
  );
  assert(
    animation.trackCount == expect.trackCount,
    label + ": track count " + animation.trackCount.toString() + ", expected " +
      expect.trackCount.toString(),
  );
  assert(
    animation.slots == expect.slots,
    label + ": slots " + animation.slots.toString() + ", expected " + expect.slots.toString(),
  );
  // Trap T1's arithmetic, stated where it can be false: slots is Align(tracks, 4).
  assert(
    animation.slots == ((animation.trackCount + 3) / 4) * 4,
    label + ": slots is not Align(trackCount, 4)",
  );
  assert(
    animation.timepoints.length == expect.timepoints,
    label + ": timepoints " + animation.timepoints.length.toString() + ", expected " +
      expect.timepoints.toString(),
  );
  assert(
    animation.ratioWidth() == expect.ratioWidth,
    label + ": ratio width " + animation.ratioWidth().toString() + ", expected " +
      expect.ratioWidth.toString(),
  );

  assert(
    animation.translations.keyCount == expect.translations.keyCount,
    label + ": translation keys " + animation.translations.keyCount.toString() + ", expected " +
      expect.translations.keyCount.toString(),
  );
  assert(
    animation.rotations.keyCount == expect.rotations.keyCount,
    label + ": rotation keys " + animation.rotations.keyCount.toString() + ", expected " +
      expect.rotations.keyCount.toString(),
  );
  assert(
    animation.scales.keyCount == expect.scales.keyCount,
    label + ": scale keys " + animation.scales.keyCount.toString() + ", expected " +
      expect.scales.keyCount.toString(),
  );

  // The walk: built twice, verified against every invariant.
  const index = indexAnimation(animation);
  const problem = verifyAnimationIndex(animation, index);
  assert(problem == "", label + ": the track index is not sound: " + problem);
  checkStable(label, animation);
  checkPaddingIdentity(label, animation, index);
  checkSortOrder(label, animation, index);

  checkSeries(label, animation, TRANSLATIONS, animation.translations, index.translations,
              expect.translations);
  checkSeries(label, animation, ROTATIONS, animation.rotations, index.rotations,
              expect.rotations);
  checkSeries(label, animation, SCALES, animation.scales, index.scales, expect.scales);

  // One line per pair, so the run's output carries the byte-consumption checks
  // and the padding counts itself rather than only a summary "OK".
  print(
    "anim: " + label + " skeleton=" + skeletonBytes.toString() + "/" +
      skeletonExpectBytes.toString() + " animation=" + animation.bytesConsumed.toString() +
      "/" + expect.bytes.toString() + " tracks=" + animation.trackCount.toString() +
      " slots=" + animation.slots.toString() + " paddingKeys=" +
      index.translations.paddingKeyCount().toString() + "/" +
      index.rotations.paddingKeyCount().toString() + "/" +
      index.scales.paddingKeyCount().toString() + " ratioWidth=" +
      animation.ratioWidth().toString(),
  );
}

// ── trap T1: the padding slots ──────────────────────────────────────────────

/**
 * A padded rig's extra slots hold the identity keys the builder wrote, and a rig
 * whose joint count is already a multiple of four has no extra slots at all.
 *
 * "Identity" is the *quantized* identity: a rotation of (0, 0, 0, 1) does not
 * round-trip exactly through 45 bits, so a padding key's quaternion lands within
 * ~3e-5 of it. Translation and scale are exact, because zero and one are exact
 * in half precision.
 */
function checkPaddingIdentity(label: string, animation: Animation, index: AnimationIndex): void {
  checkSeriesPaddingIdentity(label, "translations", animation, index.translations);
  checkSeriesPaddingIdentity(label, "rotations", animation, index.rotations);
  checkSeriesPaddingIdentity(label, "scales", animation, index.scales);
}

/** One series' padding slots: T1, stated per series because each has its own
 * key array and its own padding. */
function checkSeriesPaddingIdentity(
  label: string,
  name: string,
  animation: Animation,
  index: TrackIndex,
): void {
  const where = label + " " + name;
  const padding = index.paddingKeyCount();
  if (index.slots == index.trackCount) {
    assert(
      padding == 0,
      where + ": this rig needs no padding, but the key arrays carry " + padding.toString() +
        " padding key(s)",
    );
    return;
  }
  assert(
    index.trackCount < index.slots,
    where + ": a padded rig must have fewer tracks than slots",
  );
  assert(
    padding > 0,
    where + ": tracks " + index.trackCount.toString() + " < slots " + index.slots.toString() +
      ", so the builder's identity keys must be in the arrays",
  );

  const translation = new Float3();
  const rotation = new Quat();
  const scale = new Float3();
  for (let track = index.trackCount; track < index.slots; track++) {
    const count = index.keyCount(track);
    assert(
      count >= 2,
      where + ": padding slot " + track.toString() + " has " + count.toString() + " key(s)",
    );
    for (let i = 0; i < count; i++) {
      const key = index.key(track, i);
      animation.translationAt(key, translation);
      animation.rotationAt(key, rotation);
      animation.scaleAt(key, scale);
      assert(
        translation.x == 0 && translation.y == 0 && translation.z == 0,
        where + ": padding key " + key.toString() + " translates (" + translation.x.toString() +
          ", " + translation.y.toString() + ", " + translation.z.toString() + ")",
      );
      assert(
        scale.x == 1 && scale.y == 1 && scale.z == 1,
        where + ": padding key " + key.toString() + " scales (" + scale.x.toString() + ", " +
          scale.y.toString() + ", " + scale.z.toString() + ")",
      );
      assert(
        Mathf.abs(rotation.rx) < 1e-4 && Mathf.abs(rotation.ry) < 1e-4 &&
          Mathf.abs(rotation.rz) < 1e-4 && Mathf.abs(rotation.rw) > 0.9999,
        where + ": padding key " + key.toString() + " is not the identity rotation: (" +
          rotation.rx.toString() + ", " + rotation.ry.toString() + ", " + rotation.rz.toString() +
          ", " + rotation.rw.toString() + ")",
      );
    }
  }
}

// ── trap T2: the sort order ────────────────────────────────────────────────

/**
 * The v7 sort invariant: at every key past the seed, the *left* key's ratio is
 * at or after the previous key's left ratio. A parser that assumed the keys were
 * sorted by their own time would see this break in the first few keys of a real
 * clip — which is exactly how the probe found it.
 */
function checkSortOrder(label: string, animation: Animation, index: AnimationIndex): void {
  checkSeriesSortOrder(label, "translations", animation, animation.translations,
                       index.translations);
  checkSeriesSortOrder(label, "rotations", animation, animation.rotations, index.rotations);
  checkSeriesSortOrder(label, "scales", animation, animation.scales, index.scales);
}

function checkSeriesSortOrder(
  label: string,
  name: string,
  animation: Animation,
  series: AnimationSeries,
  index: TrackIndex,
): void {
  let previousLeft: f32 = -1;
  for (let k = index.slots; k < series.keyCount; k++) {
    const left = k - series.previousOffset(k);
    const leftRatio = series.ratio(animation.timepoints, left);
    assert(
      leftRatio >= previousLeft,
      label + " " + name + ": key " + k.toString() + " breaks the v7 sort order (" +
        leftRatio.toString() + " after " + previousLeft.toString() + ")",
    );
    previousLeft = leftRatio;
  }
}

// ── the walk, built twice ───────────────────────────────────────────────────

/** Assertion 2's "stable": the same archive indexes identically twice. */
function checkStable(label: string, animation: Animation): void {
  const first = indexAnimation(animation);
  const second = indexAnimation(animation);
  checkSameIndex(label, "translations", first.translations, second.translations);
  checkSameIndex(label, "rotations", first.rotations, second.rotations);
  checkSameIndex(label, "scales", first.scales, second.scales);
}

function checkSameIndex(label: string, name: string, a: TrackIndex, b: TrackIndex): void {
  assert(a.trackOf.length == b.trackOf.length, label + " " + name + ": the walk is not stable");
  for (let k = 0; k < a.trackOf.length; k++) {
    assert(
      a.trackOf[k] == b.trackOf[k],
      label + " " + name + ": key " + k.toString() + " indexed as " + a.trackOf[k].toString() +
        " then " + b.trackOf[k].toString(),
    );
  }
}

// ── one series' first two keys of track 0 ──────────────────────────────────

function checkSeries(
  label: string,
  animation: Animation,
  kind: i32,
  series: AnimationSeries,
  index: TrackIndex,
  expect: SeriesExpect,
): void {
  const name = kind == TRANSLATIONS ? "translations" : (kind == ROTATIONS ? "rotations" : "scales");
  assert(
    index.keyCount(0) == expect.track0KeyCount,
    label + " " + name + ": track 0 has " + index.keyCount(0).toString() + " key(s), expected " +
      expect.track0KeyCount.toString(),
  );
  assert(
    index.keyCount(0) >= expect.keys.length,
    label + " " + name + ": track 0 has " + index.keyCount(0).toString() + " key(s)",
  );

  for (let i = 0; i < expect.keys.length; i++) {
    const want = expect.keys[i];
    const key = index.key(0, i);
    assert(
      key == want.index,
      label + " " + name + ": track 0 key " + i.toString() + " is at index " + key.toString() +
        ", expected " + want.index.toString(),
    );

    const raw0 = series.raw(key, 0);
    const raw1 = series.raw(key, 1);
    const raw2 = series.raw(key, 2);
    assert(
      raw0 == want.raw0 && raw1 == want.raw1 && raw2 == want.raw2,
      label + " " + name + ": key " + key.toString() + " reads (" + raw0.toString() + ", " +
        raw1.toString() + ", " + raw2.toString() + "), expected (" + want.raw0.toString() + ", " +
        want.raw1.toString() + ", " + want.raw2.toString() + ")",
    );

    const ratio = series.ratio(animation.timepoints, key);
    assert(
      ratio == want.ratio,
      label + " " + name + ": key " + key.toString() + " is at ratio " + ratio.toString() +
        ", expected " + want.ratio.toString(),
    );

    const decoded = new StaticArray<f32>(4);
    const count = decodeInto(kind, animation, key, decoded);
    assert(
      count == want.value.length,
      label + " " + name + ": key " + key.toString() + " decoded to " + count.toString() +
        " value(s)",
    );
    for (let c = 0; c < count; c++) {
      assert(
        decoded[c] == want.value[c],
        label + " " + name + ": key " + key.toString() + " value " + c.toString() + " is " +
          decoded[c].toString() + ", expected " + want.value[c].toString(),
      );
    }
  }
}

/** Decode key `key` of `kind` into `out`; returns 3 for TRS, 4 for a rotation. */
function decodeInto(kind: i32, animation: Animation, key: i32, out: StaticArray<f32>): i32 {
  if (kind == TRANSLATIONS) {
    const value = new Float3();
    animation.translationAt(key, value);
    out[0] = value.x;
    out[1] = value.y;
    out[2] = value.z;
    return 3;
  }
  if (kind == ROTATIONS) {
    const value = new Quat();
    animation.rotationAt(key, value);
    out[0] = value.rx;
    out[1] = value.ry;
    out[2] = value.rz;
    out[3] = value.rw;
    return 4;
  }
  const value = new Float3();
  animation.scaleAt(key, value);
  out[0] = value.x;
  out[1] = value.y;
  out[2] = value.z;
  return 3;
}

// ── refusals ───────────────────────────────────────────────────────────────

/**
 * Archives the format does not accept must be refused, and refused *before*
 * anything is parsed: a version is a different byte layout, and a big-endian
 * archive read as little-endian gives a joint count in the hundreds of millions.
 * Neither may be half-parsed.
 */
function checkRefusals(): void {
  const refusals = new Array<Refusal>(3);
  refusals[0] = new Refusal("skeleton_v1_le", true, "version 1", 3889);
  refusals[1] = new Refusal("skeleton_v2_be", true, "endianness byte is 0", 3818);
  refusals[2] = new Refusal("animation_v6_le", false, "version 6", 9962);

  for (let i = 0; i < refusals.length; i++) {
    const refusal = refusals[i];
    const bytes = fixtureBytes(refusal.fixture);
    assert(
      bytes.length == refusal.bytes,
      refusal.fixture + ": the fixture decoded to " + bytes.length.toString() + " bytes, not " +
        refusal.bytes.toString(),
    );
    assert(
      fnv1a(bytes) == fixtureFnv(refusal.fixture),
      refusal.fixture + ": the fixture's hash does not match the generator's",
    );

    if (refusal.isSkeleton) {
      const skeleton = Skeleton.parse(bytes);
      assert(skeleton.error.length > 0, refusal.fixture + ": a refused archive was accepted");
      assert(
        skeleton.error.indexOf(refusal.needle) >= 0,
        refusal.fixture + ": the refusal does not name the problem: \"" + skeleton.error + "\"",
      );
      assert(
        skeleton.bytesConsumed == 0 && skeleton.jointCount == 0,
        refusal.fixture + ": the refusal came after a partial parse (" +
          skeleton.bytesConsumed.toString() + " bytes, " + skeleton.jointCount.toString() +
          " joints)",
      );
    } else {
      const animation = Animation.parse(bytes);
      assert(animation.error.length > 0, refusal.fixture + ": a refused archive was accepted");
      assert(
        animation.error.indexOf(refusal.needle) >= 0,
        refusal.fixture + ": the refusal does not name the problem: \"" + animation.error + "\"",
      );
      assert(
        animation.bytesConsumed == 0 && animation.trackCount == 0,
        refusal.fixture + ": the refusal came after a partial parse",
      );
    }
    print("anim: " + refusal.fixture + " refused: " + refusal.needle);
  }
}
