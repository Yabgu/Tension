// tension-framework/assembly/2d/iwi.ts — the IWI container header, for guests.
//
// The format authority is ImageViewer's `src/format/IwiFile.h`; the host's
// reader (`tension-core/src/render2d/iwi.rs`) and the C++ reference adapter call
// that C API directly. A guest cannot call a C ABI, so this file mirrors the
// wire layout once for every guest that builds a texture at run time
// (`examples/2d/hello-sprites`, `examples/2d/box-physics`, `apps/editor`).
//
// The header on disk:
//
//    0  4  magic "IWI1"          16  4  storage flags (0 = interleaved)
//    4  4  width                20  4  row stride (0 = tightly packed)
//    8  4  height               24  8  payload encoding (zero = raw)
//   12  4  metaBytes            32  1  colorSpace (0 = sRGB)
//                                33  1  reserved
//                                34  2  componentCount
//                                36  *  componentCount x 6-byte records
//
// A component record is `{semantic u8, class u8, bitOffset u16, bitWidth u16}`.
// Pixels follow the table (and any metadata), tightly packed and interleaved.
//
// The header is naturally aligned in this format, but the component table is
// variable-length and the caller owns a byte buffer, so the fields are written
// by name through `Bytes` rather than cast from a record. `iwiHeaderBytes`
// returns the pixel offset once, and no caller repeats the arithmetic.

import { Bytes } from "../bytes";

/// `IWI_FILE_BASE_HEADER_BYTES`: the fixed prefix, and the component-table offset.
export const IWI_BASE_HEADER_BYTES: i32 = 36;
/// `IWI_FILE_COMPONENT_BYTES`: one component record's stride.
export const IWI_COMPONENT_BYTES: i32 = 6;

/// Component semantics, from `ImagePluginDef.h`: R=1, G=2, B=3, A=4.
const SEMANTIC_R: u8 = 1;
/// `IW_COMPONENT_CLASS_UNORM` — an unsigned normalized 8-bit sample.
const COMPONENT_CLASS_UNORM: u8 = 2;

/// Bytes a container header occupies for `components` channels.
export function iwiHeaderBytes(components: i32): i32 {
  return IWI_BASE_HEADER_BYTES + components * IWI_COMPONENT_BYTES;
}

/// Write the base header and component table into `image` (whose first bytes
/// must be the header's).
///
/// Returns the offset of the first pixel byte, or -1 when the request cannot
/// describe an RGBA raster: 3 or 4 components only, and the buffer must hold
/// the header. A caller that gets -1 has a bug in the atlas it built, not a
/// buffer the decoder can rescue.
export function writeIwiHeader(image: Bytes, width: u32, height: u32, components: i32): i32 {
  if (components != 3 && components != 4) return -1;
  const headerBytes = iwiHeaderBytes(components);
  if (image.length < headerBytes) return -1;

  image.setByteAt(0, 0x49); // I
  image.setByteAt(1, 0x57); // W
  image.setByteAt(2, 0x49); // I
  image.setByteAt(3, 0x31); // 1
  image.setU32(4, width);
  image.setU32(8, height);
  // metaBytes (12), storage flags (16), stride (20) and payloadEncoding
  // (24..31) stay zero: no metadata, interleaved, tightly packed, raw.
  image.setByteAt(32, 0); // colorSpace: sRGB
  image.setByteAt(33, 0); // reserved
  image.setU16(34, <u16>components);

  for (let i: i32 = 0; i < components; i++) {
    const at = IWI_BASE_HEADER_BYTES + i * IWI_COMPONENT_BYTES;
    image.setByteAt(at, <u8>(<i32>SEMANTIC_R + i)); // R, G, B[, A]
    image.setByteAt(at + 1, COMPONENT_CLASS_UNORM);
    image.setU16(at + 2, <u16>(i * 8)); // bitOffset
    image.setU16(at + 4, 8); // bitWidth
  }

  return headerBytes;
}
