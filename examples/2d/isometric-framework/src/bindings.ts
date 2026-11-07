// The tension-2d guest SDK: the verbs, and nothing about records.
//
// The record layout lives in the SDK's `assembly/2d/types.ts`, where it is a
// `struct` the compiler lays out from the field list. This module carries the
// imports only — a second copy of the offsets here would be a second declaration
// of the wire, and the first time the two disagreed the pixels would be the only
// evidence.
//
// The verbs are the same set as `examples/2d/hello-sprites/src/bindings.ts`, one
// module per example rather than a shared package, because the shared package
// would have to be published and the header it maps is still moving. The
// authority is `tension-2d/include/tension_2d.h`. Unlike that file this one has
// no `writeSprite`: records come from the framework.
//
// **Hand-written.** `tension-2d/include/tension_2d.h` has no entry in
// `schema/`, so `tools/codegen/generate.mjs` cannot emit this; codegen covers
// `ogre` only. Every offset below is transcribed from the header by hand.

// --- the imports (module "tension::2d") ------------------------------------

/** Open at `width` x `height`: a handle (> 0), or an errno. */
@external("tension::2d", "open")
declare function openRaw(width: i32, height: i32, flags: i32): i32;
@external("tension::2d", "close")
declare function closeRaw(handle: i32): i32;
/** `blob_ptr == 0` addresses built-in preset `blob_len`. */
@external("tension::2d", "set_pipeline")
declare function setPipelineRaw(handle: i32, blob_ptr: i32, blob_len: i32): i32;
@external("tension::2d", "shader_compile_raw")
declare function shaderCompileRawRaw(h: i32, vsP: i32, vsL: i32, fsP: i32, fsL: i32): i32;
@external("tension::2d", "submit")
declare function submitRaw(handle: i32, pipe_id: i32, hdr_ptr: i32, z_bucket: i32): i32;
@external("tension::2d", "present")
declare function presentRaw(handle: i32): i32;
@external("tension::2d", "texture_load")
declare function textureLoadRaw(handle: i32, src_ptr: i32, src_len: i32, fmt: i32): i32;
/** Bind a loaded texture to one page of a pipeline's texture array. */
@external("tension::2d", "set_texture")
declare function setTextureRaw(handle: i32, pipe_id: i32, slot: i32, texture_id: i32): i32;
@external("tension::2d", "info")
declare function infoRaw(handle: i32, ptr: u32, cap: i32): i32;
@external("tension::2d", "screenshot")
declare function screenshotRaw(handle: i32, ptr: u32, cap: i32): i32;

// --- thin wrappers ---------------------------------------------------------

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

export function submit(handle: i32, pipeId: i32, hdrPtr: usize, bucket: i32 = 0): i32 {
  return submitRaw(handle, pipeId, i32(hdrPtr), bucket);
}

export function present(handle: i32): i32 { return presentRaw(handle); }

export function textureLoad(handle: i32, srcPtr: usize, srcLen: u32, format: i32 = TEX_RGBA8): i32 {
  return textureLoadRaw(handle, i32(srcPtr), i32(srcLen), format);
}

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

/// `TENSION_2D_OPEN_WINDOWED`: `open`'s flags bit 0. Without it the capability
/// renders offscreen and `screenshot` is the only way to see the frame; with it
/// a window appears and every `present` blits the same frame to a swapchain.
/// Tests pass 0 so their pixels do not depend on a compositor.
export const OPEN_WINDOWED: i32 = 1;

export const TEX_RGBA8: i32 = 1;
export const INFO_SIZE: u32 = 24;
