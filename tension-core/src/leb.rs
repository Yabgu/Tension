//! LEB128, shared by the wasm readers and the DWARF encoder.
//!
//! `read_uleb` is the byte-oriented reader the diagnostics and section walks
//! use (it advances an external cursor); the DWARF encoder writes through
//! `write_uleb` / `write_sleb`.

/// Decode an unsigned LEB128 from `bytes` at `*p`, advancing `*p` past it.
///
/// The shift is capped at `usize::BITS` *before* each shift, so an over-long
/// encoding is refused instead of silently wrapping (or panicking on a shift
/// amount >= the bit width). Values that do not fit a `usize` are refused by
/// the same cap.
pub fn read_uleb(bytes: &[u8], p: &mut usize) -> Option<usize> {
    let mut result = 0usize;
    let mut shift = 0u32;
    loop {
        let byte = *bytes.get(*p)?;
        *p += 1;
        if shift >= usize::BITS {
            return None;
        }
        result |= ((byte & 0x7f) as usize) << shift;
        if byte & 0x80 == 0 {
            return Some(result);
        }
        shift += 7;
    }
}

/// Encode `v` as unsigned LEB128.
pub fn write_uleb(out: &mut Vec<u8>, mut v: u64) {
    loop {
        let mut b = (v & 0x7f) as u8;
        v >>= 7;
        if v != 0 {
            b |= 0x80;
        }
        out.push(b);
        if v == 0 {
            break;
        }
    }
}

/// Encode `v` as signed LEB128.
pub fn write_sleb(out: &mut Vec<u8>, mut v: i64) {
    loop {
        let b = (v & 0x7f) as u8;
        v >>= 7;
        let done = (v == 0 && b & 0x40 == 0) || (v == -1 && b & 0x40 != 0);
        out.push(if done { b } else { b | 0x80 });
        if done {
            break;
        }
    }
}

#[cfg(test)]
mod tests {
    use super::*;

    fn read_all(bytes: &[u8]) -> Option<usize> {
        let mut p = 0;
        read_uleb(bytes, &mut p)
    }

    #[test]
    fn reads_valid_encodings_up_to_the_full_width() {
        assert_eq!(read_all(&[0x00]), Some(0));
        assert_eq!(read_all(&[0x7f]), Some(127));
        assert_eq!(read_all(&[0x80, 0x01]), Some(128));
        assert_eq!(read_all(&[0xe5, 0x8e, 0x26]), Some(624485));
        // Ten bytes: u64::MAX needs the full 64 bits and must not trip a
        // 32-bit-era cutoff.
        assert_eq!(
            read_all(&[0xff, 0xff, 0xff, 0xff, 0xff, 0xff, 0xff, 0xff, 0xff, 0x01]),
            Some(u64::MAX as usize)
        );
    }

    #[test]
    fn refuses_over_long_encodings() {
        // An 11th continuation byte would shift past the bit width.
        let bytes = [
            0x80, 0x80, 0x80, 0x80, 0x80, 0x80, 0x80, 0x80, 0x80, 0x80, 0x00,
        ];
        assert_eq!(read_all(&bytes), None);
    }

    #[test]
    fn write_read_round_trips() {
        for v in [0u64, 1, 127, 128, 624485, u32::MAX as u64, u64::MAX] {
            let mut out = Vec::new();
            write_uleb(&mut out, v);
            assert_eq!(read_all(&out), Some(v as usize), "round trip {v}");
        }
        for v in [0i64, 1, -1, 63, 64, -64, -65, i64::MIN, i64::MAX] {
            let mut out = Vec::new();
            write_sleb(&mut out, v);
            // Decode by hand: read_uleb cannot decode signed values.
            let mut p = 0;
            let mut result = 0i64;
            let mut shift = 0u32;
            loop {
                let byte = out[p];
                p += 1;
                result |= ((byte & 0x7f) as i64) << shift;
                shift += 7;
                if byte & 0x80 == 0 {
                    if shift < 64 && byte & 0x40 != 0 {
                        result |= !0i64 << shift;
                    }
                    break;
                }
            }
            assert_eq!(result, v, "round trip {v}");
        }
    }
}
