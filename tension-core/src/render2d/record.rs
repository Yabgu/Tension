//! The 28-byte `sprite` record, and the graph's ordering of them.
//!
//! The layout is `tension_2d.h`'s (`TENSION_2D_OFF_*`), and it crosses the wire
//! as bytes from the guest. Nothing here trusts a field's meaning — the guest
//! hands over a `records_ptr` and a stride, and this is the struct both sides
//! agree the bytes are.
//!
//! # Why the comparator is data, not code
//!
//! `kSortKeys` in the C++ renderer is *emitted from the graph*: its
//! `make_tuple(sort_key, group_id, z)` says which fields order a frame, and
//! `tension-core graph emit-default` writes that list beside the SPIR-V. So the
//! ordering is a property of the graph, not of this file. [`SORT_KEYS`] is the
//! same list, transcribed, and `sort_keys_match_the_default_graph` in
//! `tests/render2d_parity.rs` holds it to the graph so it cannot drift.
//!
//! **The table is per-process, not per-pipeline**, and that is deliberate: the
//! C++ renderer applies `kSortKeys` (from `default_2d`) to *every* bucket,
//! including buckets drawn by a compiled graph. A port that derived the keys per
//! graph instead would sort differently the first time a guest shipped a graph
//! with its own tuple — a silent divergence in draw order, which is exactly the
//! kind of difference byte-identical parity exists to catch.
//!
//! SPDX-License-Identifier: MIT

/// Bytes per record (`TENSION_2D_RECORD_SIZE`).
pub const RECORD_SIZE: u32 = 28;

/// `TENSION_2D_OFF_SORT_KEY` — the low-level key, read without the table too.
pub const OFF_SORT_KEY: usize = 20;

/// The dtype codes `tension-core graph emit-default` writes in its key table.
///
/// The numbers are the wire's (`TENSION_DTYPE_*`), plus 6 for `u32`. Only the
/// three the default graph names are handled; anything else falls through to
/// `u32`, which is the C++ comparator's `default:` branch and therefore the
/// behaviour a frame was sorted with before this port existed.
#[derive(Clone, Copy, Debug, PartialEq, Eq)]
pub enum KeyKind {
    F32,
    U16,
    I16,
    U8,
    I32,
    U32,
}

/// One entry of the graph's ordering: where in the record, and how to read it.
#[derive(Clone, Copy, Debug)]
pub struct SortKey {
    pub offset: usize,
    pub kind: KeyKind,
    /// The `mul` factor a scaled `f32` key carries; `1.0` for a plain load.
    pub scale: f32,
}

/// `(sort_key, group_id, z)` — `default_2d.keys.txt`, in the graph's order.
///
/// Transcribed from `tension-2d/tests/default_2d.keys.txt`, which
/// `scripts/build-2d.mjs` regenerates from the graph on every build:
///
/// ```text
/// 20 6 1      sort_key   u32
/// 24 2 1      group_id   u16
/// 26 4 1      z          u8
/// ```
pub const SORT_KEYS: &[SortKey] = &[
    SortKey { offset: 20, kind: KeyKind::U32, scale: 1.0 },
    SortKey { offset: 24, kind: KeyKind::U16, scale: 1.0 },
    SortKey { offset: 26, kind: KeyKind::U8, scale: 1.0 },
];

/// The `sort_key` of one record, for callers that only need the first level.
pub fn record_sort_key(record: &[u8]) -> u32 {
    if record.len() < OFF_SORT_KEY + 4 {
        return 0;
    }
    u32::from_le_bytes([
        record[OFF_SORT_KEY],
        record[OFF_SORT_KEY + 1],
        record[OFF_SORT_KEY + 2],
        record[OFF_SORT_KEY + 3],
    ])
}

fn read_u16(record: &[u8], offset: usize) -> u16 {
    u16::from_le_bytes([record[offset], record[offset + 1]])
}

fn read_u32(record: &[u8], offset: usize) -> u32 {
    u32::from_le_bytes([
        record[offset],
        record[offset + 1],
        record[offset + 2],
        record[offset + 3],
    ])
}

fn read_f32(record: &[u8], offset: usize) -> f32 {
    f32::from_le_bytes([
        record[offset],
        record[offset + 1],
        record[offset + 2],
        record[offset + 3],
    ])
}

/// Order two records by the graph's key list.
///
/// A field-by-field transcription of the C++ `compare_by_keys`
/// (`tension-2d/src/render.cpp:104-159`), comparison by comparison, because the
/// two must agree exactly: a difference here reorders a frame, and a reordered
/// frame is not byte-identical.
///
/// `f32` uses `partial_cmp`'s ordering with `None` (a NaN) treated as "equal",
/// which is what the C++ `if (x < y) … if (x > y) …` pair does — both false for
/// a NaN, so the loop falls through to the next key.
pub fn compare(a: &[u8], b: &[u8]) -> std::cmp::Ordering {
    use std::cmp::Ordering;

    for key in SORT_KEYS {
        // A record shorter than the key's *field* cannot be ordered by it. The
        // width is the key's own, not a fixed four: `z` is a `u8` at offset 26
        // of a 28-byte record, and a `+ 4` guard here silently skipped it —
        // which reordered every frame whose records differed only in `z`.
        //
        // The adapter refuses a stride that disagrees with the layout, so this
        // is unreachable through the ABI; it is here so a malformed slice is a
        // defined "equal" rather than a panic.
        let width = match key.kind {
            KeyKind::U8 => 1,
            KeyKind::U16 | KeyKind::I16 => 2,
            KeyKind::F32 | KeyKind::I32 | KeyKind::U32 => 4,
        };
        if a.len() < key.offset + width || b.len() < key.offset + width {
            continue;
        }
        let order = match key.kind {
            KeyKind::F32 => {
                let x = read_f32(a, key.offset) * key.scale;
                let y = read_f32(b, key.offset) * key.scale;
                x.partial_cmp(&y).unwrap_or(Ordering::Equal)
            }
            KeyKind::U16 => read_u16(a, key.offset).cmp(&read_u16(b, key.offset)),
            KeyKind::I16 => {
                let x = read_u16(a, key.offset) as i16;
                let y = read_u16(b, key.offset) as i16;
                x.cmp(&y)
            }
            KeyKind::U8 => a[key.offset].cmp(&b[key.offset]),
            KeyKind::I32 => (read_u32(a, key.offset) as i32).cmp(&(read_u32(b, key.offset) as i32)),
            KeyKind::U32 => read_u32(a, key.offset).cmp(&read_u32(b, key.offset)),
        };
        if order != Ordering::Equal {
            return order;
        }
    }
    Ordering::Equal
}

/// The 12-byte submit header (`tension_2d_submit_hdr`).
#[derive(Clone, Copy, Debug, PartialEq, Eq)]
pub struct SubmitHeader {
    pub records_ptr: u32,
    pub records_count: u32,
    pub record_stride: u16,
    pub flags: u16,
}

impl SubmitHeader {
    /// Decode the header at the start of `bytes`, or `None` if it is short.
    pub fn parse(bytes: &[u8]) -> Option<Self> {
        if bytes.len() < 12 {
            return None;
        }
        Some(SubmitHeader {
            records_ptr: read_u32(bytes, 0),
            records_count: read_u32(bytes, 4),
            record_stride: read_u16(bytes, 8),
            flags: read_u16(bytes, 10),
        })
    }
}

/// The 24-byte info record (`tension_2d_info_record`), version 2.
#[derive(Clone, Copy, Debug, PartialEq, Eq)]
pub struct InfoRecord {
    pub version: u16,
    pub max_records: u16,
    pub max_textures: u32,
    pub max_pipelines: u32,
    pub max_buckets: u16,
    pub flags: u16,
    pub canvas_width: u32,
    pub canvas_height: u32,
}

impl InfoRecord {
    /// Bytes on the wire. The adapter answers `-ENOSPC` for a shorter buffer.
    pub const SIZE: usize = 24;

    /// Encode in the header's field order, little-endian.
    pub fn to_bytes(self) -> [u8; Self::SIZE] {
        let mut out = [0u8; Self::SIZE];
        out[0..2].copy_from_slice(&self.version.to_le_bytes());
        out[2..4].copy_from_slice(&self.max_records.to_le_bytes());
        out[4..8].copy_from_slice(&self.max_textures.to_le_bytes());
        out[8..12].copy_from_slice(&self.max_pipelines.to_le_bytes());
        out[12..14].copy_from_slice(&self.max_buckets.to_le_bytes());
        out[14..16].copy_from_slice(&self.flags.to_le_bytes());
        out[16..20].copy_from_slice(&self.canvas_width.to_le_bytes());
        out[20..24].copy_from_slice(&self.canvas_height.to_le_bytes());
        out
    }
}

#[cfg(test)]
mod tests {
    use super::*;

    /// A record with only the three key fields set, everything else zero.
    fn record(sort_key: u32, group: u16, z: u8) -> [u8; 28] {
        let mut r = [0u8; 28];
        r[20..24].copy_from_slice(&sort_key.to_le_bytes());
        r[24..26].copy_from_slice(&group.to_le_bytes());
        r[26] = z;
        r
    }

    #[test]
    fn orders_by_sort_key_then_group_then_z() {
        assert_eq!(compare(&record(1, 0, 0), &record(2, 0, 0)), std::cmp::Ordering::Less);
        assert_eq!(
            compare(&record(1, 5, 0), &record(1, 6, 0)),
            std::cmp::Ordering::Less
        );
        assert_eq!(
            compare(&record(1, 5, 7), &record(1, 5, 9)),
            std::cmp::Ordering::Less
        );
        assert_eq!(
            compare(&record(1, 5, 7), &record(1, 5, 7)),
            std::cmp::Ordering::Equal
        );
    }

    /// The key fields are unsigned: a `u8` z of 200 is above 100, where a
    /// signed read would put it below.
    #[test]
    fn key_fields_are_unsigned() {
        assert_eq!(
            compare(&record(0, 0, 100), &record(0, 0, 200)),
            std::cmp::Ordering::Less
        );
        assert_eq!(
            compare(&record(0, 40000, 0), &record(0, 50000, 0)),
            std::cmp::Ordering::Less
        );
    }

    #[test]
    fn sort_is_stable_for_equal_keys() {
        // Two records with equal keys but different payloads: stable sort must
        // keep submission order, which is what makes a frame reproducible.
        let mut a = record(7, 1, 2);
        a[0] = 1;
        let mut b = record(7, 1, 2);
        b[0] = 2;
        let mut frame = vec![a, b];
        frame.sort_by(|x, y| compare(x, y));
        assert_eq!(frame[0][0], 1);
        assert_eq!(frame[1][0], 2);
    }

    #[test]
    fn header_decodes_le() {
        let mut bytes = [0u8; 12];
        bytes[0..4].copy_from_slice(&64u32.to_le_bytes());
        bytes[4..8].copy_from_slice(&3u32.to_le_bytes());
        bytes[8..10].copy_from_slice(&28u16.to_le_bytes());
        let header = SubmitHeader::parse(&bytes).expect("12 bytes");
        assert_eq!(
            header,
            SubmitHeader { records_ptr: 64, records_count: 3, record_stride: 28, flags: 0 }
        );
        assert!(SubmitHeader::parse(&bytes[..11]).is_none());
    }

    #[test]
    fn info_record_is_24_bytes_in_header_order() {
        let info = InfoRecord {
            version: 2,
            max_records: 4096,
            max_textures: 64,
            max_pipelines: 16,
            max_buckets: 8,
            flags: 0,
            canvas_width: 640,
            canvas_height: 360,
        };
        let bytes = info.to_bytes();
        assert_eq!(bytes.len(), 24);
        assert_eq!(u16::from_le_bytes([bytes[0], bytes[1]]), 2);
        assert_eq!(u32::from_le_bytes([bytes[4], bytes[5], bytes[6], bytes[7]]), 64);
        assert_eq!(
            u32::from_le_bytes([bytes[16], bytes[17], bytes[18], bytes[19]]),
            640
        );
    }
}
