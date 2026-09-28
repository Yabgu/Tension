#!/usr/bin/env python3
"""remap-ozz.py — reorder ozz runtime archives into OGRE bone order.

The asset pipeline (FBX -> Blender -> glTF -> gltf2ozz) produces ozz archives
whose joints are in the glTF node order: the two object nodes first, then the
bone hierarchy topologically (Hips chain, upper body, control chains). OGRE's
bones are in io_ogre's order (control chains first, `Hips` at 19,
`LeftForeArm` at 28). The rest transforms agree to 1e-6 — the difference is
order only — so this tool derives the permutation **by name** from the ozz
skeleton and the OGRE `.skeleton.xml`, drops the joints OGRE has no bone for
(`Root`, `characterMedium` — the Blender object nodes gltf2ozz turned into
joints), and rewrites the skeleton and every animation with the joints in OGRE
order. Parents come from the OGRE XML's `<bonehierarchy>` (cross-checked against
the ozz parents by name; a disagreement is fatal). If the pipeline shifts,
re-running the tool regenerates the mapping.

The byte layout written here is the one `tension-framework/assembly/anim/`
reads; that module is the spec, not a dependency — this tool is stdlib-only.

  skeleton v2:  u8 endianness(1), "ozz-skeleton\\0", u32 version(2), i32 joints,
                i32 nameBytes, names (NUL-terminated), parents (i16 x joints,
                -1 = root), rest poses (Align(joints,4) blocks of 40 f32,
                SoA: 4 lanes each of tx,ty,tz, rx,ry,rz,rw, sx,sy,sz).
  animation v7: u8 endianness(1), "ozz-animation\\0", u32 version(7), f32
                duration, u32 tracks, u32 nameBytes, u32 timepoints, u32 key
                counts (t, r, s), u32 iframe counts (6), name, timepoints
                (f32), then per series (t, r, s): ratios (u8, or u16 when
                timepoints > 255), previouses (u16 per key), iframe bytes
                (entries + desc*4 + one f32), values (3 x u16 per key).

The iframe cache (ozz's GV4 seek accelerators) is written as **zero counts**
plus the mandatory interval float: the reader skips it by count and the
framework's evaluator never touches an iframe byte, so an archive without a
cache is exactly as computable — it just lacks an optimization our path does
not use.

Runs standalone:

    python3 remap-ozz.py \
        --skeleton characterMedium_skeleton.ozz \
        --animation characterMedium_idle.ozz \
        --animation characterMedium_run.ozz \
        --animation characterMedium_jump.ozz \
        --ogre-xml characterMedium.skeleton.xml \
        --output-dir /tmp/kenney-remapped

Exits non-zero on any verification failure; the last block printed is the
per-file check table.
"""

import argparse
import heapq
import os
import struct
import sys
import xml.etree.ElementTree as ET

SOA_BLOCK = 40  # floats per Align(4) block of rest poses
MAT_SLOTS = ("translations", "rotations", "scales")
# Identity values for the padding slots (slots >= trackCount, which the format
# guarantees carry identity keys). Half-floats: 0 and 1.0; the rotation triple
# packs the identity quaternion (0,0,0,1) exactly as the format's encoder does
# (largest component 3, sign 0, three components at the midpoint 1/2 * 32767).
IDENTITY_TRANSLATION = (0x0000, 0x0000, 0x0000)
IDENTITY_SCALE = (0x3C00, 0x3C00, 0x3C00)


def _pack_identity_quat():
    kf_scale = 32767.0
    # the midpoint of the stored range, truncated — the convention the
    # reference encoder uses (checked against the fixture archives' padding
    # keys, which this reproduces byte for byte)
    c = int(kf_scale / 2.0)
    packed = c | (c << 15) | (c << 30)
    v0 = ((packed & 0x1FFF) << 3) | 0 | 3  # largest = 3 (w), sign = 0
    v1 = (packed >> 13) & 0xFFFF
    v2 = (packed >> 29) & 0xFFFF
    return (v0, v1, v2)


IDENTITY_ROTATION = _pack_identity_quat()


# ── reading (the reader's layout, mirrored) ─────────────────────────────────


def parse_skeleton(path):
    b = open(path, "rb").read()
    if not b or b[0] != 1:
        raise SystemExit("%s: not a little-endian ozz archive" % path)
    p = 1
    end = b.index(b"\x00", p)
    tag = b[p:end].decode()
    if tag != "ozz-skeleton":
        raise SystemExit("%s: tag is %r, not ozz-skeleton" % (path, tag))
    p = end + 1
    (version,) = struct.unpack_from("<I", b, p)
    p += 4
    if version != 2:
        raise SystemExit("%s: skeleton version %d, not 2" % (path, version))
    joints, name_bytes = struct.unpack_from("<ii", b, p)
    p += 8
    names = []
    for _ in range(joints):
        end = b.index(b"\x00", p)
        names.append(b[p:end].decode())
        p = end + 1
    parents = struct.unpack_from("<%dh" % joints, b, p)
    p += joints * 2
    blocks = (joints + 3) // 4
    rest = struct.unpack_from("<%df" % (blocks * SOA_BLOCK), b, p)
    p += blocks * SOA_BLOCK * 4
    if p != len(b):
        raise SystemExit("%s: parsed %d of %d bytes" % (path, p, len(b)))
    return {"joints": joints, "names": names, "parents": parents, "rest": rest}


def rest_trs(skeleton, joint):
    """Joint `joint`'s rest TRS, gathered out of its SoA block."""
    base = (joint // 4) * SOA_BLOCK + (joint % 4)
    r = skeleton["rest"]
    return (
        (r[base + 0], r[base + 4], r[base + 8]),
        (r[base + 12], r[base + 16], r[base + 20], r[base + 24]),
        (r[base + 28], r[base + 32], r[base + 36]),
    )


def assemble_rest(trs_list):
    """`rest_trs` in reverse: a joint list's TRS into one SoA rest block array."""
    joints = len(trs_list)
    blocks = (joints + 3) // 4
    out = [0.0] * (blocks * SOA_BLOCK)
    for j in range(blocks * 4):
        t, r, s = trs_list[j] if j < joints else (
            (0.0, 0.0, 0.0),
            (0.0, 0.0, 0.0, 1.0),
            (1.0, 1.0, 1.0),
        )
        base = (j // 4) * SOA_BLOCK + (j % 4)
        out[base + 0], out[base + 4], out[base + 8] = t
        out[base + 12], out[base + 16], out[base + 20], out[base + 24] = r
        out[base + 28], out[base + 32], out[base + 36] = s
    return out


def parse_animation(path):
    b = open(path, "rb").read()
    if not b or b[0] != 1:
        raise SystemExit("%s: not a little-endian ozz archive" % path)
    p = 1
    end = b.index(b"\x00", p)
    tag = b[p:end].decode()
    if tag != "ozz-animation":
        raise SystemExit("%s: tag is %r, not ozz-animation" % (path, tag))
    p = end + 1
    (version,) = struct.unpack_from("<I", b, p)
    p += 4
    if version != 7:
        raise SystemExit("%s: animation version %d, not 7" % (path, version))
    (duration,) = struct.unpack_from("<f", b, p)
    p += 4
    tracks, name_len, tpc = struct.unpack_from("<III", b, p)
    p += 12
    counts = struct.unpack_from("<III", b, p)
    p += 12
    iframes = struct.unpack_from("<IIIIII", b, p)
    p += 24
    name = b[p:p + name_len].decode()
    p += name_len
    timepoints = struct.unpack_from("<%df" % tpc, b, p)
    p += tpc * 4
    wide = tpc > 255
    series = []
    for si, count in enumerate(counts):
        if wide:
            ratios = struct.unpack_from("<%dH" % count, b, p)
            p += count * 2
        else:
            ratios = struct.unpack_from("<%dB" % count, b, p)
            p += count
        previouses = struct.unpack_from("<%dH" % count, b, p)
        p += count * 2
        p += iframes[si * 2] + iframes[si * 2 + 1] * 4 + 4
        values = struct.unpack_from("<%dH" % (count * 3), b, p)
        p += count * 6
        series.append({"ratios": ratios, "previouses": previouses, "values": values})
    if p != len(b):
        raise SystemExit("%s: parsed %d of %d bytes" % (path, p, len(b)))
    return {
        "duration": duration,
        "tracks": tracks,
        "name": name,
        "timepoints": timepoints,
        "wide": wide,
        "counts": counts,
        "iframes": iframes,
        "series": series,
    }


def build_track_index(count, previouses, slots):
    """The parser's one-pass walk (anim/index.ts): every key's slot."""
    track_of = [0] * count
    for k in range(slots):
        track_of[k] = k
    for k in range(slots, slots * 2):
        track_of[k] = k - slots
    for k in range(slots * 2, count):
        back = previouses[k]
        track_of[k] = track_of[k - back]
    return track_of


def keys_by_slot(series, slots):
    out = [[] for _ in range(slots)]
    track_of = build_track_index(len(series["ratios"]), series["previouses"], slots)
    for k, track in enumerate(track_of):
        out[track].append(k)
    return out


# ── writing ─────────────────────────────────────────────────────────────────


def write_skeleton(path, names, parents, rest):
    joints = len(names)
    blob = bytearray()
    blob += b"\x01ozz-skeleton\x00"
    blob += struct.pack("<I", 2)
    name_bytes = b"".join(n.encode() + b"\x00" for n in names)
    blob += struct.pack("<ii", joints, len(name_bytes))
    blob += name_bytes
    blob += struct.pack("<%dh" % joints, *parents)
    blob += struct.pack("<%df" % len(rest), *rest)
    with open(path, "wb") as f:
        f.write(bytes(blob))
    return len(blob)


def write_animation(path, duration, tracks, name, timepoints, series, wide):
    slots = ((tracks + 3) // 4) * 4
    blob = bytearray()
    blob += b"\x01ozz-animation\x00"
    blob += struct.pack("<I", 7)
    blob += struct.pack("<f", duration)
    name_bytes = name.encode()
    blob += struct.pack("<III", tracks, len(name_bytes), len(timepoints))
    blob += struct.pack("<III", *(len(s["ratios"]) for s in series))
    blob += struct.pack("<IIIIII", 0, 0, 0, 0, 0, 0)  # no iframe cache; see docstring
    blob += name_bytes
    blob += struct.pack("<%df" % len(timepoints), *timepoints)
    for s in series:
        if wide:
            blob += struct.pack("<%dH" % len(s["ratios"]), *s["ratios"])
        else:
            blob += struct.pack("<%dB" % len(s["ratios"]), *s["ratios"])
        blob += struct.pack("<%dH" % len(s["previouses"]), *s["previouses"])
        blob += struct.pack("<f", 0.0)  # the iframe interval the format keeps
        blob += struct.pack("<%dH" % len(s["values"]), *s["values"])
    with open(path, "wb") as f:
        f.write(bytes(blob))
    return len(blob), slots


def emit_series(series, src_slots, slot_of_new, new_slots, timepoints, what):
    """One series with the slots permuted: seeds, then a merge by predecessor
    ratio, so the written stream satisfies the reader's v7 sort invariant
    (predecessor ratios non-decreasing in key order)."""
    src_keys = keys_by_slot(series, src_slots)
    ratios, previouses, values = [], [], []
    last_at = {}

    def emit(slot, ratio_index, triple):
        index = len(ratios)
        ratios.append(ratio_index)
        values.extend(triple)
        previouses.append(index - last_at[slot] if slot in last_at else 0)
        last_at[slot] = index

    def key_triple(k):
        return tuple(series["values"][k * 3:k * 3 + 3])

    # the seeds: every slot's first key (index k < slots is slot k), then every
    # slot's second key (index slots + k is slot k) — the format's fixed shape.
    pending = {}
    for t in range(new_slots):
        src = slot_of_new[t] if t < len(slot_of_new) else None
        if src is None:
            pending[t] = None
            emit(t, 0, IDENTITY_TRANSLATION if what == "t" else
                 IDENTITY_ROTATION if what == "r" else IDENTITY_SCALE)
        else:
            keys = src_keys[src]
            if len(keys) < 2:
                raise SystemExit("slot %d has %d key(s), not at least 2" % (src, len(keys)))
            pending[t] = keys
            emit(t, series["ratios"][keys[0]], key_triple(keys[0]))
    for t in range(new_slots):
        keys = pending[t]
        if keys is None:
            emit(t, len(timepoints) - 1, IDENTITY_TRANSLATION if what == "t" else
                 IDENTITY_ROTATION if what == "r" else IDENTITY_SCALE)
        else:
            emit(t, series["ratios"][keys[1]], key_triple(keys[1]))

    # everything else, merged by the ratio of the key it follows. The check in
    # anim/index.ts is on the *left* key's ratio, so that is the heap key.
    heap = []
    for t in range(new_slots):
        keys = pending[t]
        if keys is None or len(keys) <= 2:
            continue
        left_ratio = series["ratios"][keys[1]]
        heapq.heappush(heap, (left_ratio, t, 2))
    while heap:
        left_ratio, t, j = heapq.heappop(heap)
        keys = pending[t]
        emit(t, series["ratios"][keys[j]], key_triple(keys[j]))
        if j + 1 < len(keys):
            heapq.heappush(heap, (series["ratios"][keys[j]], t, j + 1))
    return {"ratios": ratios, "previouses": previouses, "values": values}


# ── verification ────────────────────────────────────────────────────────────


def verify_series_structure(series, track_count, timepoints, what):
    """The reader's own invariants (anim/index.ts verifyTrackIndex), in full."""
    count = len(series["ratios"])
    slots = ((track_count + 3) // 4) * 4
    if count < slots * 2:
        return "%s: %d keys cannot cover %d slots" % (what, count, slots)
    track_of = build_track_index(count, series["previouses"], slots)
    previous_left = -1.0
    for k in range(count):
        track = track_of[k]
        if k < slots:
            if track != k:
                return "%s: key %d is in slot %d, not itself" % (what, k, track)
            continue
        if k < slots * 2 and track != k - slots:
            return "%s: key %d is in slot %d, not %d" % (what, k, track, k - slots)
        left = k - series["previouses"][k]
        if left >= k:
            return "%s: key %d does not point backwards" % (what, k)
        if track_of[left] != track:
            return "%s: key %d and its predecessor are in different slots" % (what, k)
        left_ratio = timepoints[series["ratios"][left]]
        if timepoints[series["ratios"][k]] < left_ratio:
            return "%s: key %d precedes its predecessor" % (what, k)
        if left_ratio < previous_left:
            return "%s: key %d breaks the v7 sort order" % (what, k)
        previous_left = left_ratio
    for slot in range(slots):
        n = sum(1 for t in track_of if t == slot)
        if n < 2:
            return "%s: slot %d has %d key(s)" % (what, slot, n)
    return ""


def remap(args):
    skeleton = parse_skeleton(args.skeleton)
    tree = ET.parse(args.ogre_xml)
    ogre = []
    for bone in tree.getroot().iter("bone"):
        ogre.append(bone.get("name"))
        if int(bone.get("id")) != len(ogre) - 1:
            raise SystemExit("%s: bone ids are not 0..n-1 in document order" % args.ogre_xml)
    # OGRE's own hierarchy, from the XML's <bonehierarchy> section. It is the
    # authority the written parents come from; the ozz side only cross-checks
    # it (the two exporters describe the same armature, and if they ever stop
    # agreeing the mapping is wrong and a human should look).
    ogre_parent = {}
    for link in tree.getroot().iter("boneparent"):
        ogre_parent[link.get("bone")] = link.get("parent")

    by_name = {}
    for j, name in enumerate(skeleton["names"]):
        by_name.setdefault(name, []).append(j)
    dupes = {n: v for n, v in by_name.items() if len(v) > 1}
    if dupes:
        raise SystemExit("duplicate joint names in the ozz skeleton: %s" % dupes)

    missing = [n for n in ogre if n not in by_name]
    if missing:
        raise SystemExit("OGRE bones with no ozz joint: %s" % ", ".join(missing))
    extras = [n for n in skeleton["names"] if n not in set(ogre)]
    unexpected = [n for n in extras if n not in ("Root", "characterMedium")]
    if unexpected:
        raise SystemExit("unmatched ozz joints beyond the known extras: %s"
                         % ", ".join(unexpected))

    # ogre bone o <- ozz joint by_name[ogre[o]]
    src_of_new = [by_name[n][0] if n in by_name else None for n in ogre]
    missing_check = [o for o, s in enumerate(src_of_new) if s is None]
    if missing_check:
        raise SystemExit("internal: OGRE bones not resolved: %s" % missing_check)

    print("remap-ozz.py: %d ozz joints, %d OGRE bones, dropping %d extra joint(s): %s"
          % (skeleton["joints"], len(ogre), len(extras), ", ".join(extras) or "none"))
    for o, name in enumerate(ogre):
        s = src_of_new[o]
        if o < 10 or o >= len(ogre) - 5:
            print("  ogre %2d <- ozz %2d  %s" % (o, s, name))

    os.makedirs(args.output_dir, exist_ok=True)

    # ── the skeleton ───────────────────────────────────────────────────────
    out_names = list(ogre)
    ogre_at = {name: o for o, name in enumerate(ogre)}
    out_parents = []
    for o, s in enumerate(src_of_new):
        p = skeleton["parents"][s]
        ozz_parent = skeleton["names"][p] if p >= 0 else None
        expected = ozz_parent if ozz_parent in ogre_at else None
        xml_parent = ogre_parent.get(out_names[o])
        if xml_parent != expected:
            raise SystemExit(
                "hierarchy disagreement for %s: the ozz skeleton says %r, the OGRE "
                "XML says %r" % (out_names[o], expected, xml_parent))
        out_parents.append(ogre_at[xml_parent] if xml_parent is not None else -1)
    out_rest = assemble_rest([rest_trs(skeleton, s) for s in src_of_new])
    skel_out = os.path.join(args.output_dir, os.path.basename(args.skeleton))
    size = write_skeleton(skel_out, out_names, out_parents, out_rest)
    print("remap-ozz.py: wrote %s (%d bytes, %d joints)" % (skel_out, size, len(out_names)))

    # ── the animations ─────────────────────────────────────────────────────
    failures = 0
    for path in args.animation:
        anim = parse_animation(path)
        src_slots = ((anim["tracks"] + 3) // 4) * 4
        out = [emit_series(anim["series"][si], src_slots, src_of_new,
                           ((len(ogre) + 3) // 4) * 4, anim["timepoints"], what)
               for si, what in enumerate("trs")]
        out_path = os.path.join(args.output_dir, os.path.basename(path))
        size, slots = write_animation(out_path, anim["duration"], len(ogre), anim["name"],
                                      anim["timepoints"], out, anim["wide"])
        print("remap-ozz.py: wrote %s (%d bytes, %d tracks, %d slots)"
              % (out_path, size, len(ogre), slots))

        # ── verify by reading back with the same code path ────────────────
        back = parse_skeleton(skel_out)
        if back["joints"] != len(ogre):
            print("  FAIL: joint count %d" % back["joints"])
            failures += 1
            continue
        if back["names"] != out_names:
            print("  FAIL: names are not in OGRE order")
            failures += 1
            continue
        if list(back["parents"]) != out_parents:
            print("  FAIL: parents differ")
            failures += 1
            continue
        rest_ok = all(
            rest_trs(back, o) == rest_trs(skeleton, src_of_new[o])
            for o in range(len(ogre)))
        if not rest_ok:
            print("  FAIL: rest poses differ by name")
            failures += 1
            continue
        anim_back = parse_animation(out_path)
        if (anim_back["duration"] != anim["duration"]
                or anim_back["name"] != anim["name"]
                or anim_back["tracks"] != len(ogre)
                or list(anim_back["timepoints"]) != list(anim["timepoints"])):
            print("  FAIL: animation header differs")
            failures += 1
            continue
        back_keys = [keys_by_slot(anim_back["series"][si], slots) for si in range(3)]
        ok = True
        for o in range(len(ogre)):
            s = src_of_new[o]
            for si in range(3):
                src_keys = keys_by_slot(anim["series"][si], src_slots)[s]
                dst_keys = back_keys[si][o]
                if len(src_keys) != len(dst_keys):
                    print("  FAIL: %s track %d (%s): %d keys, source had %d"
                          % (MAT_SLOTS[si], o, ogre[o], len(dst_keys), len(src_keys)))
                    ok = False
                    continue
                for a, b in zip(src_keys, dst_keys):
                    sa = anim["series"][si]
                    sb = anim_back["series"][si]
                    if (anim["timepoints"][sa["ratios"][a]]
                            != anim_back["timepoints"][sb["ratios"][b]]
                            or tuple(sa["values"][a * 3:a * 3 + 3])
                            != tuple(sb["values"][b * 3:b * 3 + 3])):
                        print("  FAIL: %s track %d (%s): key differs"
                              % (MAT_SLOTS[si], o, ogre[o]))
                        ok = False
                        break
                if not ok:
                    break
            if not ok:
                break
        for si in range(3):
            err = verify_series_structure(anim_back["series"][si], len(ogre),
                                          anim_back["timepoints"], MAT_SLOTS[si])
            if err:
                print("  FAIL: %s" % err)
                ok = False
        if ok:
            print("  verified: names in OGRE order, parents and rests by name, "
                  "all three series' tracks match, reader invariants hold")
        else:
            failures += 1
    return failures


def main():
    parser = argparse.ArgumentParser(description=__doc__.splitlines()[0])
    parser.add_argument("--skeleton", required=True)
    parser.add_argument("--animation", action="append", default=[])
    parser.add_argument("--ogre-xml", required=True)
    parser.add_argument("--output-dir", required=True)
    args = parser.parse_args()
    if not args.animation:
        raise SystemExit("--animation is required at least once")
    failures = remap(args)
    if failures:
        raise SystemExit("%d file(s) failed verification" % failures)
    print("remap-ozz.py: all files verified")
    return 0


if __name__ == "__main__":
    sys.exit(main())
