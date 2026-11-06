// The tension-2d guest SDK: the ten verbs, the `sprite` record, and the
// submit header.
//
// The adapter is `libtension_2d.so` (tension-2d/), the design is
// tension-2d/DESIGN.md, and the wire is tension-2d/include/tension_2d.h. This
// module is the third reader of that header and invents no field the others do
// not have.
//
// **Hand-written, and it should not stay that way.** `tension-2d`'s header has
// no entry in `schema/`, so `tools/codegen/generate.mjs` cannot emit this —
// codegen covers `ogre` only today. When the schema tool grows a `2d` entry,
// this file should become generated output and the offsets below should
// disappear into it. Until then, every constant here is transcribed from
// tension_2d.h and must be checked against it by hand.
//
// **The canvas is the caller's choice.** `open(width, height, flags)` fixes the
// target's size for the handle's life; a resize is close + open, because v1 has
// no swapchain to renegotiate with. This example asks for 640x360 (main.ts),
// which is a choice the example makes, not a constant the adapter bakes.

// --- the imports (module "tension::2d") ------------------------------------

/** Open the capability's session at `width` x `height`: a handle (> 0), or an errno. */
@external("tension::2d", "open")
declare function openRaw(width: i32, height: i32, flags: i32): i32;
/** Release every texture, pipeline and buffer. */
@external("tension::2d", "close")
declare function closeRaw(handle: i32): i32;
/** Prepare a pipeline: `blob_ptr == 0` addresses built-in preset `blob_len`. */
@external("tension::2d", "set_pipeline")
declare function setPipelineRaw(handle: i32, blob_ptr: i32, blob_len: i32): i32;
/** Two shader sources in, a `pipe_id >= 1000` out. `-ENOSYS` at v1. */
@external("tension::2d", "shader_compile_raw")
declare function shaderCompileRawRaw(h: i32, vsP: i32, vsL: i32, fsP: i32, fsL: i32): i32;
/** Append records to a bucket for the next `present`; returns the count. */
@external("tension::2d", "submit")
declare function submitRaw(handle: i32, pipe_id: i32, hdr_ptr: i32, z_bucket: i32): i32;
/** Draw every bucket recorded since the last call. */
@external("tension::2d", "present")
declare function presentRaw(handle: i32): i32;
/** Decode and upload one texture; returns its id. */
@external("tension::2d", "texture_load")
declare function textureLoadRaw(handle: i32, src_ptr: i32, src_len: i32, fmt: i32): i32;
/** Bind a loaded texture to one page of a pipeline's texture array. */
@external("tension::2d", "set_texture")
declare function setTextureRaw(handle: i32, pipe_id: i32, slot: i32, texture_id: i32): i32;
/** Write the 24-byte info record. */
@external("tension::2d", "info")
declare function infoRaw(handle: i32, ptr: u32, cap: i32): i32;
/** Copy the last presented frame out as RGBA8. */
@external("tension::2d", "screenshot")
declare function screenshotRaw(handle: i32, ptr: u32, cap: i32): i32;

// --- thin wrappers, so call sites read like the header ----------------------
//
// Every verb takes and returns `i32` (rule 3: there is no `size_t` at this
// boundary). Pointers cross as `u32` guest addresses, which is what
// `usize` already is on wasm32 — the casts below are documentation, not
// conversion.

export function open(width: i32, height: i32, flags: i32 = 0): i32 {
  return openRaw(width, height, flags);
}
export function close(handle: i32): i32 { return closeRaw(handle); }

/** A built-in preset, addressed by id: `blob_ptr == 0`, `blob_len` = preset. */
export function setPipelinePreset(handle: i32, preset: i32): i32 {
  return setPipelineRaw(handle, 0, preset);
}

/** A graph blob already resident in guest memory. */
export function setPipeline(handle: i32, blobPtr: usize, blobLen: u32): i32 {
  return setPipelineRaw(handle, i32(blobPtr), i32(blobLen));
}

export function shaderCompileRaw(handle: i32, vsPtr: usize, vsLen: u32, fsPtr: usize, fsLen: u32): i32 {
  return shaderCompileRawRaw(handle, i32(vsPtr), i32(vsLen), i32(fsPtr), i32(fsLen));
}

export function submit(handle: i32, pipeId: i32, hdrPtr: usize, bucket: i32 = 0): i32 {
  return submitRaw(handle, pipeId, i32(hdrPtr), bucket);
}

export function present(handle: i32): i32 { return presentRaw(handle); }

export function textureLoad(handle: i32, srcPtr: usize, srcLen: u32, format: i32 = TEX_RGBA8): i32 {
  return textureLoadRaw(handle, i32(srcPtr), i32(srcLen), format);
}

/** Bind `textureId` to array page `slot` (0..15) for `pipeId`. A record's
 * `tex` is the page it samples. */
export function setTexture(handle: i32, pipeId: i32, slot: i32, textureId: i32): i32 {
  return setTextureRaw(handle, pipeId, slot, textureId);
}

export function info(handle: i32, ptr: usize, cap: i32): i32 {
  return infoRaw(handle, u32(ptr), cap);
}

export function screenshot(handle: i32, ptr: usize, cap: i32): i32 {
  return screenshotRaw(handle, u32(ptr), cap);
}

// --- the `sprite` record (tension_2d.h, DESIGN.md §5) -----------------------
//
// 28 bytes, naturally aligned, no packed fields. Offsets are byte offsets; the
// `sort_key` at 20 is why the record is 28 and not 26.

export const RECORD_SIZE: u32 = 28;

export const OFF_X: u32 = 0;
export const OFF_Y: u32 = 4;
export const OFF_SRC_X: u32 = 8;
export const OFF_SRC_Y: u32 = 10;
export const OFF_W: u32 = 12;
export const OFF_H: u32 = 14;
export const OFF_TEX: u32 = 16;
export const OFF_SORT_KEY: u32 = 20;
export const OFF_GROUP_ID: u32 = 24;
export const OFF_Z: u32 = 26;
export const OFF_FLAGS: u32 = 27;

/** Write one record into `base`, at `index`. The caller owns the memory. */
export function writeSprite(
  base: usize,
  index: i32,
  x: i32,
  y: i32,
  srcX: u16,
  srcY: u16,
  w: u16,
  h: u16,
  tex: u16,
  sortKey: u32,
  groupId: u16 = 0,
  z: u8 = 0,
  flags: u8 = 0,
): usize {
  const at = base + <usize>(index * <i32>RECORD_SIZE);
  // Zero first: the record has two padding bytes at 18-19 and a `flags` byte,
  // and a record that leaves them holding a previous frame's data is a record
  // whose shader reads garbage nothing else notices.
  memory.fill(at, 0, RECORD_SIZE);

  store<i32>(at + OFF_X, x);
  store<i32>(at + OFF_Y, y);
  store<u16>(at + OFF_SRC_X, srcX);
  store<u16>(at + OFF_SRC_Y, srcY);
  store<u16>(at + OFF_W, w);
  store<u16>(at + OFF_H, h);
  store<u16>(at + OFF_TEX, tex);
  store<u32>(at + OFF_SORT_KEY, sortKey);
  store<u16>(at + OFF_GROUP_ID, groupId);
  store<u8>(at + OFF_Z, z);
  store<u8>(at + OFF_FLAGS, flags);
  return at;
}

// --- the submit header (tension_2d.h) --------------------------------------
//
// 12 bytes: the record array's guest address, its count, its stride, and a
// flags word that must be zero. The records themselves follow in their own
// allocation, so a caller writes one header and one array.

export const HDR_SIZE: u32 = 12;
export const OFF_HDR_RECORDS: u32 = 0;
export const OFF_HDR_COUNT: u32 = 4;
export const OFF_HDR_STRIDE: u32 = 8;
export const OFF_HDR_FLAGS: u32 = 10;

export function writeSubmitHeader(base: usize, recordsPtr: usize, count: u32, stride: u16 = 28): void {
  memory.fill(base, 0, HDR_SIZE);
  store<u32>(base + OFF_HDR_RECORDS, u32(recordsPtr));
  store<u32>(base + OFF_HDR_COUNT, count);
  store<u16>(base + OFF_HDR_STRIDE, stride);
  store<u16>(base + OFF_HDR_FLAGS, 0);
}

// --- wire constants --------------------------------------------------------

/** `TENSION_2D_TEX_RGBA8`. The other three targets are `-ENOSYS` at v1. */
export const TEX_RGBA8: i32 = 1;
export const TEX_RGBA8_SRGB: i32 = 2;
export const TEX_R8: i32 = 3;
export const TEX_RGBA16F: i32 = 4;

/** `TENSION_2D_PIPE_PRESET_MIN`/`MAX`: built-in presets. */
export const PIPE_PRESET_MIN: i32 = 1;
export const PIPE_PRESET_MAX: i32 = 99;
/** `TENSION_2D_PIPE_RAW_MIN`: runtime-compiled and raw-shader pipelines. */
export const PIPE_RAW_MIN: i32 = 1000;

/** RGBA8 frame size for a canvas. The size is the caller's, so this is a
 * function of it rather than a constant. */
export function frameBytes(width: u32, height: u32): u32 { return width * height * 4; }

/** `TENSION_2D_MAX_ATLAS_PAGES`: the pages one pipeline can bind. */
export const MAX_ATLAS_PAGES: u32 = 16;

// --- the info record thin view ---------------------------------------------

export const INFO_SIZE: u32 = 24;

export function infoVersion(buf: usize): u16 { return load<u16>(buf); }
export function infoMaxRecords(buf: usize): u16 { return load<u16>(buf + 2); }
export function infoMaxTextures(buf: usize): u32 { return load<u32>(buf + 4); }
export function infoMaxPipelines(buf: usize): u32 { return load<u32>(buf + 8); }
export function infoMaxBuckets(buf: usize): u16 { return load<u16>(buf + 12); }
/** The canvas the handle was opened with, echoed back by the adapter. */
export function infoCanvasWidth(buf: usize): u32 { return load<u32>(buf + 16); }
export function infoCanvasHeight(buf: usize): u32 { return load<u32>(buf + 20); }
