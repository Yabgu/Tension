//! LEB128, for the wasm section walks.
//!
//! `read_uleb` is the byte-oriented reader the guest diagnostics and the DWARF
//! section check use (it advances an external cursor). The encode halves went
//! with the DWARF encoder that was their only caller.

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
///
/// Test-only: the one caller left builds wasm modules out of `(id, payload)`
/// pairs so a section walk has something real to walk. The encoder that used
/// this in production went with the DWARF synthesiser.
#[cfg(test)]
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
    fn write_uleb_round_trips() {
        for v in [0u64, 1, 127, 128, 624485, u32::MAX as u64, u64::MAX] {
            let mut out = Vec::new();
            write_uleb(&mut out, v);
            assert_eq!(read_all(&out), Some(v as usize), "round trip {v}");
        }
    }
}
