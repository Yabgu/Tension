//! The IWI reader: ImageViewer's format authority, plus this build's policy.
//!
//! The container grammar is **not** implemented here. It lives once, in
//! `third_party/ImageViewer/src/format/IwiFile.{h,cpp}`, behind a C ABI that a
//! Rust host can call. That file's own header says why: the `.iwi` header had
//! been parsed independently by the viewer, its thumbnail provider, this Rust
//! reader and the Node writer, and the copies drifted. This module is now one
//! of the callers rather than one of the copies.
//!
//! # The header on disk (specified by `IwiFile.h`)
//!
//! ```text
//!   offset  size  field
//!        0     4  magic "IWI1"
//!        4     4  width           u32
//!        8     4  height          u32
//!       12     4  metaBytes       u32  (metadata blob size, 0 = none)
//!       16     8  storageLayout   u64  (flags u32, stride u32)
//!       24     8  payloadEncoding char[8] ("raw" or zero)
//!       32     1  colorSpace      u8   (ImageColorSpace)
//!       33     1  reserved        u8   (zeroed)
//!       34     2  componentCount  u16
//!       36   6*N  components[N]   N x IwiFileComponent, immediately after the
//!                                  base header
//!     36+6N   M  metadata        M = metaBytes, then:
//!   36+6N+M   *  pixelData       tightly packed, interleaved, 8 bits each
//! ```
//!
//! All little-endian. The component record is `{semantic u8, class u8,
//! bitOffset u16, bitWidth u16}`, six bytes.
//!
//! # Grammar and policy are separate on purpose
//!
//! `iwi_parse_structural` answers "is this a well-formed IWI whose payload is
//! present?" — it accepts planar, 16-bit and 700-component files because the
//! format does. Whether *this* build can display the pixels is a capability
//! question, and ImageViewer puts that answer in `IwiFormat.ixx`. This module
//! carries the same policy (3 or 4 components, 8-bit, integer, interleaved,
//! tightly packed, raw, RGBA semantics in order) so a valid-but-unserved file
//! is `-ENOSYS` and a broken one is `-EINVAL`, exactly as before the port.
//!
//! SPDX-License-Identifier: MIT

use std::ffi::CStr;
use std::os::raw::c_char;

use crate::render2d::error::Render2dError;

/// `IWI_FILE_BASE_HEADER_BYTES` in `IwiFile.h`: the fixed prefix, and the
/// offset of the component table. This is deliberately **not**
/// `sizeof(IwiFileHeader)` — the C struct is 40 bytes because a `u64` layout
/// descriptor gives it alignment 8, while the wire header is 36. Every
/// on-disk operation uses 36; the mirror below does the same.
const BASE_HEADER_BYTES: usize = 36;

/// `IWI_FILE_COMPONENT_BYTES`: the stride of one component record.
const COMPONENT_BYTES: usize = 6;

const STATUS_OK: i32 = 0;
/// `IWI_STATUS_BAD_MAGIC`. A non-IWI is "no decoder here", not "corrupt IWI":
/// the distinction the old reader made, and the one the guest sees.
const STATUS_BAD_MAGIC: i32 = 3;

/// Component semantics, from `ImagePluginDef.h`.
const SEMANTIC_R: u8 = 1;
const SEMANTIC_G: u8 = 2;
const SEMANTIC_B: u8 = 3;
const SEMANTIC_A: u8 = 4;
/// Component classes this build accepts: raw unsigned integer, or normalised.
const CLASS_UINT: u8 = 0;
const CLASS_UNORM: u8 = 2;

/// The 36-byte wire prefix of `IwiFileHeader`.
///
/// A mirror, not the C type: the C declaration is 40 bytes of naturally
/// aligned struct whose tail padding is not part of the file. The field order
/// and offsets are the format's.
///
/// Every field of the prefix is declared, including the ones this reader never
/// consults (`magic`, `metaBytes`, the encoding and colour-space bytes), so the
/// mirror stays a mirror: a field dropped here because nothing reads it would
/// shift every field after it, and the size assert below would then pass on a
/// struct that no longer describes the file.
#[repr(C)]
#[derive(Clone, Copy, Default)]
struct IwiFileHeader {
    magic: [u8; 4],
    width: u32,
    height: u32,
    meta_bytes: u32,
    storage_flags: u32,
    storage_stride: u32,
    payload_encoding: [u8; 8],
    color_space: u8,
    reserved: u8,
    component_count: u16,
}

/// One component record, exactly as stored.
///
/// The field names carry the C ones (`semantic`, `component_class`, …) rather
/// than Rust spellings, because this is a mirror of the wire record and a
/// renamed field would make the mapping something a reader has to work out.
#[repr(C)]
#[derive(Clone, Copy, Default)]
struct IwiFileComponent {
    semantic: u8,
    component_class: u8,
    bit_offset: u16,
    bit_width: u16,
}

// The mirrors must be the wire sizes. This is a compile error, not a test:
// a field added here that moves the component table is caught by the build.
const _: [(); BASE_HEADER_BYTES] = [(); std::mem::size_of::<IwiFileHeader>()];
const _: [(); COMPONENT_BYTES] = [(); std::mem::size_of::<IwiFileComponent>()];

extern "C" {
    fn iwi_file_required_size(bytes: *const u8, size: usize) -> usize;
    fn iwi_parse_structural(
        out: *mut IwiFileHeader,
        out_size: usize,
        bytes: *const u8,
        size: usize,
    ) -> i32;
    fn iwi_decode(
        f: *const IwiFileHeader,
        bytes: *const u8,
        size: usize,
        out_rgba: *mut u8,
        out_cap: usize,
    ) -> i32;
    fn iwi_payload_encoding_is_raw(f: *const IwiFileHeader) -> i32;
    fn iwi_status_is_unsupported(status: i32) -> i32;
    fn iwi_status_message(status: i32) -> *const c_char;
}

/// A decoded raster: always RGBA8, always tightly packed.
#[derive(Clone, Debug, PartialEq, Eq)]
pub struct DecodedImage {
    pub width: u32,
    pub height: u32,
    pub rgba: Vec<u8>,
}

fn component_at(blob: &[u8], index: usize) -> IwiFileComponent {
    let at = BASE_HEADER_BYTES + index * COMPONENT_BYTES;
    // `blob` is a `Vec<u8>`; its data is not guaranteed to be 2-aligned by the
    // type, so read the record the way C writes it rather than casting.
    unsafe { std::ptr::read_unaligned(blob.as_ptr().add(at) as *const IwiFileComponent) }
}

/// The C status's sentence, with the `iwi:` prefix the rest of this module's
/// refusals use. `iwi_status_message` never returns null for a status this
/// code can produce; an unknown code still gets its generic sentence.
fn status_message(status: i32) -> String {
    let text = unsafe { CStr::from_ptr(iwi_status_message(status)) }
        .to_string_lossy()
        .into_owned();
    format!("iwi: {text}")
}

/// Map a C status onto this crate's error vocabulary.
///
/// `-ENOSYS` means "a valid IWI this build cannot serve" (or "not an IWI at
/// all", for the magic mismatch the old reader also classified that way);
/// `-EINVAL` means "this is a broken IWI".
fn status_error(status: i32) -> Render2dError {
    let unsupported =
        status == STATUS_BAD_MAGIC || unsafe { iwi_status_is_unsupported(status) } != 0;
    if unsupported {
        Render2dError::Unsupported(status_message(status))
    } else {
        Render2dError::Invalid(status_message(status))
    }
}

/// Decode an IWI container into tightly packed RGBA8.
///
/// The order is the format authority's: parse the grammar, apply this build's
/// capability policy, then convert. A caller that sees `-EINVAL` learns "this
/// is a broken IWI"; `-ENOSYS` means "this is not something I decode".
pub fn decode_iwi(src: &[u8]) -> Result<DecodedImage, Render2dError> {
    // Size the blob the C API fills: 36 + 6N. `required == 0` means the base
    // header is not readable (or declares no components); give the parser a
    // base-sized buffer anyway so it returns the precise status rather than
    // this side guessing.
    let required = unsafe { iwi_file_required_size(src.as_ptr(), src.len()) };
    let mut blob = vec![0u8; required.max(BASE_HEADER_BYTES)];

    let parsed = blob.as_mut_ptr() as *mut IwiFileHeader;
    let rc = unsafe { iwi_parse_structural(parsed, blob.len(), src.as_ptr(), src.len()) };
    if rc != STATUS_OK {
        return Err(status_error(rc));
    }
    let header: IwiFileHeader = unsafe { std::ptr::read_unaligned(parsed) };

    // ── this build's capability policy ───────────────────────────────────
    //
    // The grammar accepted the file; these are statements about what the 2D
    // renderer can upload, not about what an IWI may contain. The policy is
    // ImageViewer's (`IwiFormat.ixx`), and the order is chosen for the
    // message: depth before count, so a 16-bit grayscale file says "not 8-bit"
    // rather than "unsupported component count".
    if header.storage_flags != 0 || header.storage_stride != 0 {
        return Err(Render2dError::Unsupported(
            "iwi: storage layout is planar, columnar, mirrored or stride-aligned; \
             this build reads only interleaved, tightly packed rows"
                .to_string(),
        ));
    }
    if unsafe { iwi_payload_encoding_is_raw(parsed) } == 0 {
        return Err(Render2dError::Unsupported(
            "iwi: payload encoding is not one this build decodes; only \"raw\" is supported"
                .to_string(),
        ));
    }

    let count = header.component_count as usize;
    let components: Vec<IwiFileComponent> = (0..count).map(|i| component_at(&blob, i)).collect();

    if components.iter().any(|c| c.bit_width != 8) {
        return Err(Render2dError::Unsupported(
            "iwi: only 8-bit components are supported; 16-bit and wider samples are not \
             displayed"
                .to_string(),
        ));
    }
    if components
        .iter()
        .any(|c| c.component_class != CLASS_UINT && c.component_class != CLASS_UNORM)
    {
        return Err(Render2dError::Unsupported(
            "iwi: component class is not integer or unsigned-normalised data".to_string(),
        ));
    }
    if !(3..=4).contains(&count) {
        return Err(Render2dError::Unsupported(
            "iwi: only 3- and 4-component colour is supported at v1".to_string(),
        ));
    }

    // The renderer copies the payload as RGBA8 in channel order, so the
    // semantics and offsets must be exactly R, G, B[, A] at i * 8. A mismatch
    // is the difference between a correct image and a misread red channel, so
    // refuse rather than guess.
    const REQUIRED_SEMANTICS: [u8; 4] = [SEMANTIC_R, SEMANTIC_G, SEMANTIC_B, SEMANTIC_A];
    for (i, component) in components.iter().enumerate() {
        if component.semantic != REQUIRED_SEMANTICS[i] {
            return Err(Render2dError::Unsupported(
                "iwi: component semantics are not an RGB(A) raster".to_string(),
            ));
        }
        if component.bit_offset != (i * 8) as u16 {
            return Err(Render2dError::Unsupported(
                "iwi: unexpected component layout".to_string(),
            ));
        }
    }

    // ── the presentation step ────────────────────────────────────────────
    let out_bytes = (u64::from(header.width) * u64::from(header.height))
        .checked_mul(4)
        .and_then(|n| usize::try_from(n).ok())
        .ok_or_else(|| {
            Render2dError::Invalid("iwi: geometry overflows the addressable range".to_string())
        })?;

    let mut rgba = vec![0u8; out_bytes];
    let rc = unsafe {
        iwi_decode(
            parsed,
            src.as_ptr(),
            src.len(),
            rgba.as_mut_ptr(),
            rgba.len(),
        )
    };
    if rc != STATUS_OK {
        return Err(status_error(rc));
    }

    Ok(DecodedImage {
        width: header.width,
        height: header.height,
        rgba,
    })
}

#[cfg(test)]
mod tests {
    use super::*;
    use crate::render2d::error::{EINVAL, ENOSYS};

    /// Build a minimal valid IWI: `components` interleaved 8-bit channels.
    fn iwi(width: u32, height: u32, components: u16, pixels: &[u8]) -> Vec<u8> {
        let table = BASE_HEADER_BYTES + usize::from(components) * COMPONENT_BYTES;
        let mut bytes = vec![0u8; table];
        bytes[0..4].copy_from_slice(b"IWI1");
        bytes[4..8].copy_from_slice(&width.to_le_bytes());
        bytes[8..12].copy_from_slice(&height.to_le_bytes());
        // 12..16 metaBytes = 0
        // 16..24 storageLayout = interleaved, tightly packed
        // 24..32 payloadEncoding = zero (raw)
        // 32 colorSpace = sRGB, 33 reserved = 0
        bytes[34..36].copy_from_slice(&components.to_le_bytes());
        for i in 0..components {
            let at = BASE_HEADER_BYTES + usize::from(i) * COMPONENT_BYTES;
            bytes[at] = i as u8 + 1; // R, G, B, A
            bytes[at + 1] = CLASS_UNORM;
            bytes[at + 2..at + 4].copy_from_slice(&(i * 8).to_le_bytes());
            bytes[at + 4..at + 6].copy_from_slice(&8u16.to_le_bytes());
        }
        bytes.extend_from_slice(pixels);
        bytes
    }

    #[test]
    fn decodes_rgba_passthrough() {
        let pixels = [1u8, 2, 3, 4, 5, 6, 7, 8];
        let image = decode_iwi(&iwi(2, 1, 4, &pixels)).expect("valid");
        assert_eq!((image.width, image.height), (2, 1));
        assert_eq!(image.rgba, pixels);
    }

    #[test]
    fn expands_rgb_to_opaque_rgba() {
        let pixels = [10u8, 20, 30];
        let image = decode_iwi(&iwi(1, 1, 3, &pixels)).expect("valid");
        assert_eq!(image.rgba, vec![10, 20, 30, 255]);
    }

    #[test]
    fn metadata_between_the_table_and_the_pixels_is_skipped() {
        let mut bytes = iwi(1, 1, 4, &[9, 8, 7, 6]);
        // metaBytes lives at 12; the metadata blob follows the component table,
        // so inserting it means shifting the payload rather than appending.
        let payload_at = bytes.len() - 4;
        bytes[12..16].copy_from_slice(&3u32.to_le_bytes());
        bytes.splice(payload_at..payload_at, [0xAA, 0xBB, 0xCC]);
        let image = decode_iwi(&bytes).expect("valid");
        assert_eq!(image.rgba, vec![9, 8, 7, 6]);
    }

    #[test]
    fn a_png_is_unsupported_not_malformed() {
        // At least the 36-byte base header, so the length check passes and the
        // magic is what decides.
        let mut bytes = vec![0u8; 80];
        bytes[0..8].copy_from_slice(b"\x89PNG\r\n\x1a\n");
        let error = decode_iwi(&bytes).expect_err("not an IWI");
        assert_eq!(error.errno(), ENOSYS);
    }

    #[test]
    fn a_truncated_container_is_malformed() {
        let error = decode_iwi(&[0u8; 10]).expect_err("short");
        assert_eq!(error.errno(), EINVAL);
    }

    #[test]
    fn no_components_is_malformed() {
        let mut bytes = iwi(1, 1, 3, &[1, 2, 3]);
        bytes[34..36].copy_from_slice(&0u16.to_le_bytes());
        let error = decode_iwi(&bytes).expect_err("no components");
        assert_eq!(error.errno(), EINVAL);
    }

    #[test]
    fn planar_is_unsupported() {
        let mut bytes = iwi(1, 1, 3, &[1, 2, 3]);
        // storageLayout.flags is the little-endian u32 at 16; bit 0 is PLANAR.
        bytes[16] = 1;
        let error = decode_iwi(&bytes).expect_err("planar");
        assert_eq!(error.errno(), ENOSYS);
    }

    #[test]
    fn a_non_raw_payload_encoding_is_unsupported() {
        let mut bytes = iwi(1, 1, 3, &[1, 2, 3]);
        bytes[24..27].copy_from_slice(b"lz4");
        let error = decode_iwi(&bytes).expect_err("compressed");
        assert_eq!(error.errno(), ENOSYS);
    }

    #[test]
    fn a_shifted_component_is_refused() {
        let mut bytes = iwi(1, 1, 3, &[1, 2, 3]);
        // Move the second component off its slot.
        let at = BASE_HEADER_BYTES + COMPONENT_BYTES + 2;
        bytes[at..at + 2].copy_from_slice(&16u16.to_le_bytes());
        let error = decode_iwi(&bytes).expect_err("shifted");
        assert_eq!(error.errno(), ENOSYS);
    }

    #[test]
    fn a_sixteen_bit_component_is_unsupported() {
        let mut bytes = iwi(1, 1, 3, &[1, 2, 3, 4, 5, 6]);
        let at = BASE_HEADER_BYTES + 4;
        bytes[at..at + 2].copy_from_slice(&16u16.to_le_bytes());
        let error = decode_iwi(&bytes).expect_err("16-bit");
        assert_eq!(error.errno(), ENOSYS);
    }

    #[test]
    fn declared_pixels_beyond_the_file_are_truncated() {
        let mut bytes = iwi(2, 2, 4, &[0u8; 16]);
        bytes.truncate(bytes.len() - 1);
        let error = decode_iwi(&bytes).expect_err("short file");
        assert_eq!(error.errno(), EINVAL);
    }
}
