// The tension-2d guest SDK, second reader: the ten verbs, the `sprite` record,
// the submit header.
//
// Identical in shape to `examples/2d/hello-sprites/src/bindings.ts` — one
// module per example rather than a shared package, because the shared package
// would have to be published and the header it maps is still moving. The
// authority is `tension-2d/include/tension_2d.h`.
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

// --- the `sprite` record (tension_2d.h, `docs/modules/2d.md` §8) ------------
//
// 28 bytes, naturally aligned. `tex` is the texture-array page.

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

/** Write one record into `base`, at `index`. */
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
): void {
  const at = base + <usize>(index * <i32>RECORD_SIZE);
  // Zero first: a stale padding byte at 18-19 or a `flags` byte from a previous
  // frame is a record whose meaning depends on history.
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
}

// --- the submit header -----------------------------------------------------

export const HDR_SIZE: u32 = 12;

export function writeSubmitHeader(base: usize, recordsPtr: usize, count: u32): void {
  memory.fill(base, 0, HDR_SIZE);
  store<u32>(base + 0, u32(recordsPtr));
  store<u32>(base + 4, count);
  store<u16>(base + 8, <u16>RECORD_SIZE);
  store<u16>(base + 10, 0);
}

// --- wire constants --------------------------------------------------------

/// `TENSION_2D_OPEN_WINDOWED`: `open`'s flags bit 0. Without it the capability
/// renders offscreen and `screenshot` is the only way to see the frame; with it
/// a window appears and every `present` blits the same frame to a swapchain.
/// Tests pass 0 so their pixels do not depend on a compositor.
export const OPEN_WINDOWED: i32 = 1;

export const TEX_RGBA8: i32 = 1;
export const INFO_SIZE: u32 = 24;
