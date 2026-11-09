//! The IWI reader — one container, one layout family, `-ENOSYS` for the rest.
//!
//! A byte-for-byte port of `tension-2d/src/texture.cpp`, which parsed the format
//! `IWImageIO.ixx` (ImageViewer) writes rather than depending on it as a C++
//! module. The header is 74 bytes:
//!
//! ```text
//!   offset  size  field
//!        0     4  magic "IWI1"
//!        4     4  width           u32
//!        8     4  height          u32
//!       12     1  colorSpace      u8   (ImageColorSpace)
//!       13     2  componentCount  u16
//!       15     2  bitsPerPixel    u16
//!       17     1  storageLayout   u8   (0 interleaved, 1 planar)
//!       18    48  components[8]   6 bytes each:
//!                                    semantic       u8
//!                                    componentClass u8
//!                                    bitOffset      u16
//!                                    bitWidth       u16
//!       66     8  pixelDataSize   u64
//!       74     *  pixelData       u8[]
//! ```
//!
//! All little-endian.
//!
//! # What is refused, and why it is `-ENOSYS` rather than a bug
//!
//! Planar storage, fewer than three or more than four components, sub-8-bit
//! components, and a component sitting somewhere other than `i * 8` are all
//! *understood* layouts this build does not serve. They are `-ENOSYS` because
//! the honest answer is "not here", not "malformed" — and a guess would render
//! wrong colours, which is worse than a refusal.
//!
//! PNG and JPEG are the same answer for the same reason: the build pipeline
//! converts every shipped texture to IWI, so no runtime decoder is on the
//! critical path. Reaching one would take either an `iwconv` that covers more
//! formats at build time, or a capability DSO linking ImageViewer's plugin
//! decoders. Neither is built.
//!
//! SPDX-License-Identifier: MIT

use crate::render2d::error::Render2dError;

/// The fixed header, before any pixel data.
const HEADER_BYTES: usize = 74;

/// A decoded raster: always RGBA8, always tightly packed.
#[derive(Clone, Debug, PartialEq, Eq)]
pub struct DecodedImage {
    pub width: u32,
    pub height: u32,
    pub rgba: Vec<u8>,
}

fn rd16(p: &[u8], at: usize) -> u16 {
    u16::from_le_bytes([p[at], p[at + 1]])
}

fn rd32(p: &[u8], at: usize) -> u32 {
    u32::from_le_bytes([p[at], p[at + 1], p[at + 2], p[at + 3]])
}

fn rd64(p: &[u8], at: usize) -> u64 {
    u64::from_le_bytes([
        p[at],
        p[at + 1],
        p[at + 2],
        p[at + 3],
        p[at + 4],
        p[at + 5],
        p[at + 6],
        p[at + 7],
    ])
}

/// Decode an IWI container into tightly packed RGBA8.
///
/// The refusal order matters and is the C++ file's, because a caller that sees
/// `-EINVAL` versus `-ENOSYS` learns different things: `-EINVAL` means "this is
/// a broken IWI", `-ENOSYS` means "this is not something I decode".
pub fn decode_iwi(src: &[u8]) -> Result<DecodedImage, Render2dError> {
    if src.len() < HEADER_BYTES {
        return Err(Render2dError::Invalid(format!(
            "iwi: shorter than the {HEADER_BYTES}-byte header"
        )));
    }
    if &src[0..4] != b"IWI1" {
        // Not an IWI at all. Worth distinguishing from a corrupt one: a caller
        // that handed us a PNG is asking for a decoder this build lacks.
        return Err(Render2dError::Unsupported(
            "not an IWI container (magic mismatch)".to_string(),
        ));
    }

    let width = rd32(src, 4);
    let height = rd32(src, 8);
    let components = rd16(src, 13);
    let bits_per_pixel = rd16(src, 15);
    let storage = src[17];
    let pixel_bytes = rd64(src, 66);

    if width == 0 || height == 0 {
        return Err(Render2dError::Invalid(
            "iwi: zero width or height".to_string(),
        ));
    }
    if storage != 0 {
        return Err(Render2dError::Unsupported(
            "iwi: planar storage is not supported at v1".to_string(),
        ));
    }
    if !(3..=4).contains(&components) {
        return Err(Render2dError::Unsupported(
            "iwi: only 3- and 4-component colour is supported at v1".to_string(),
        ));
    }
    if bits_per_pixel != components * 8 {
        return Err(Render2dError::Unsupported(
            "iwi: only 8-bit components are supported at v1".to_string(),
        ));
    }
    // Every component must be an 8-bit sample sitting where the interleaved
    // layout says it is. A mismatch here is the difference between a correct
    // image and a misread red channel, so refuse rather than guess.
    for i in 0..components {
        let at = 18 + usize::from(i) * 6;
        let bit_width = rd16(src, at + 4);
        let bit_offset = rd16(src, at + 2);
        if bit_width != 8 || bit_offset != i * 8 {
            return Err(Render2dError::Unsupported(
                "iwi: unexpected component layout".to_string(),
            ));
        }
    }

    let expected = u64::from(width) * u64::from(height) * u64::from(components);
    if pixel_bytes < expected {
        return Err(Render2dError::Invalid(
            "iwi: pixel data truncated".to_string(),
        ));
    }
    if (src.len() as u64) < HEADER_BYTES as u64 + pixel_bytes {
        return Err(Render2dError::Invalid(
            "iwi: file shorter than its declared pixel data".to_string(),
        ));
    }

    let pixels = width as usize * height as usize;
    let px = &src[HEADER_BYTES..];
    let mut rgba = vec![0u8; pixels * 4];
    if components == 4 {
        rgba.copy_from_slice(&px[..pixels * 4]);
    } else {
        for i in 0..pixels {
            rgba[i * 4] = px[i * 3];
            rgba[i * 4 + 1] = px[i * 3 + 1];
            rgba[i * 4 + 2] = px[i * 3 + 2];
            rgba[i * 4 + 3] = 255;
        }
    }

    Ok(DecodedImage {
        width,
        height,
        rgba,
    })
}

#[cfg(test)]
mod tests {
    use super::*;

    /// Build a minimal valid IWI: `components` interleaved 8-bit channels.
    fn iwi(width: u32, height: u32, components: u16, pixels: &[u8]) -> Vec<u8> {
        let mut bytes = vec![0u8; HEADER_BYTES];
        bytes[0..4].copy_from_slice(b"IWI1");
        bytes[4..8].copy_from_slice(&width.to_le_bytes());
        bytes[8..12].copy_from_slice(&height.to_le_bytes());
        bytes[12] = 0;
        bytes[13..15].copy_from_slice(&components.to_le_bytes());
        bytes[15..17].copy_from_slice(&(components * 8).to_le_bytes());
        bytes[17] = 0;
        for i in 0..components {
            let at = 18 + usize::from(i) * 6;
            bytes[at] = i as u8;
            bytes[at + 1] = 0;
            bytes[at + 2..at + 4].copy_from_slice(&(i * 8).to_le_bytes());
            bytes[at + 4..at + 6].copy_from_slice(&8u16.to_le_bytes());
        }
        bytes[66..74].copy_from_slice(&(pixels.len() as u64).to_le_bytes());
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
    fn a_png_is_unsupported_not_malformed() {
        // At least the 74-byte header, so the length check passes and the
        // magic is what decides. A shorter buffer is `-EINVAL` — the C++ read
        // length first too (`texture.cpp:71-74`).
        let mut bytes = vec![0u8; 80];
        bytes[0..8].copy_from_slice(b"\x89PNG\r\n\x1a\n");
        let error = decode_iwi(&bytes).expect_err("not an IWI");
        assert_eq!(error.errno(), crate::render2d::error::ENOSYS);
    }

    #[test]
    fn a_truncated_container_is_malformed() {
        let error = decode_iwi(&[0u8; 10]).expect_err("short");
        assert_eq!(error.errno(), crate::render2d::error::EINVAL);
    }

    #[test]
    fn planar_is_unsupported() {
        let mut bytes = iwi(1, 1, 3, &[1, 2, 3]);
        bytes[17] = 1;
        let error = decode_iwi(&bytes).expect_err("planar");
        assert_eq!(error.errno(), crate::render2d::error::ENOSYS);
    }

    #[test]
    fn a_shifted_component_is_refused() {
        let mut bytes = iwi(1, 1, 3, &[1, 2, 3]);
        // Move the second component off its slot.
        bytes[18 + 6 + 2..18 + 6 + 4].copy_from_slice(&16u16.to_le_bytes());
        let error = decode_iwi(&bytes).expect_err("shifted");
        assert_eq!(error.errno(), crate::render2d::error::ENOSYS);
    }

    #[test]
    fn declared_pixels_beyond_the_file_are_truncated() {
        let mut bytes = iwi(2, 2, 4, &[0u8; 16]);
        bytes.truncate(bytes.len() - 1);
        let error = decode_iwi(&bytes).expect_err("short file");
        assert_eq!(error.errno(), crate::render2d::error::EINVAL);
    }
}
