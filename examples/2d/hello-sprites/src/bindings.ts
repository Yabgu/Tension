// The tension-2d guest SDK: the ten verbs, and nothing about records.
//
// The record layout lives in the SDK's `assembly/2d/types.ts` — a `struct` the
// compiler lays out from the field list. A second copy of the offsets here would
// be a second declaration of the wire.
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
