// tension-framework/assembly/2d/constants.ts — the `tension::2d` wire numbers.
//
// These lived in three example `bindings.ts` files, copied by hand, and the
// copies had already drifted: two of them did not declare
// `TEX_RGBA8_SRGB`/`TEX_R8`/`TEX_RGBA16F` at all, and only one had the pipe
// ranges. A constant transcribed three times is three chances to be wrong, so
// they live here once and every one of them cites the line of
// `tension-2d/include/tension_2d.h` it mirrors.
//
// The header is the source of truth. A number here that the header does not
// carry is marked `header gap` — that is a defect in the header, not a
// licence to invent a value, and it is reported as such in the pass that
// introduced it.

import { Info } from "./types";

// --- `open`'s flags bit set (tension_2d.h:85) ------------------------------

/** `TENSION_2D_OPEN_WINDOWED` (tension_2d.h:85): `open`'s flags bit 0. */
export const OPEN_WINDOWED: i32 = 1;

/**
 * Flags `0`: offscreen. No window, `present` draws to the target and waits for
 * the GPU, `screenshot` reads the frame back — the mode every test uses,
 * because its pixels do not depend on a compositor (tension_2d.h:66-70).
 *
 * There is no macro for zero in the header; it is the documented absence of
 * any bit. Named anyway so a call site says which mode it means.
 */
export const OPEN_OFFSCREEN: i32 = 0;

// --- texture target formats (tension_2d.h:358-361) -------------------------

/** `TENSION_2D_TEX_RGBA8` (tension_2d.h:358) — `R8G8B8A8_UNORM`. */
export const TEX_RGBA8: i32 = 1;
/** `TENSION_2D_TEX_RGBA8_SRGB` (tension_2d.h:359). */
export const TEX_RGBA8_SRGB: i32 = 2;
/** `TENSION_2D_TEX_R8` (tension_2d.h:360). */
export const TEX_R8: i32 = 3;
/** `TENSION_2D_TEX_RGBA16F` (tension_2d.h:361). */
export const TEX_RGBA16F: i32 = 4;

// --- pipe_id ranges (tension_2d.h:350-354) --------------------------------

/**
 * `TENSION_2D_PIPE_PRESET_MIN` / `_MAX` (tension_2d.h:350-351): the built-in
 * preset band. Preset 1 (`default_2d`) is the only one this build compiles; a
 * higher id in the band is `-ENOSYS`, one outside it `-ENOENT`
 * (`tension_2d.h:110-116`).
 */
export const PIPE_PRESET_MIN: i32 = 1;
export const PIPE_PRESET_MAX: i32 = 99;

/** `TENSION_2D_PIPE_RAW_MIN` (tension_2d.h:354): graphs compiled at run time. */
export const PIPE_RAW_MIN: i32 = 1000;

// --- the pipeline's texture array (tension_2d.h:299) ----------------------

/**
 * `TENSION_2D_MAX_ATLAS_PAGES` (tension_2d.h:299): the pages one pipeline can
 * bind, and therefore the largest record `tex` with defined contents.
 *
 * A wire constant rather than an `info` field, because a guest sizes a page
 * table from it and a page table sized at runtime is one that can be wrong.
 */
export const MAX_ATLAS_PAGES: u32 = 16;

// --- limits (tension_2d.h:50, :61-66) -------------------------------------

/**
 * The largest canvas edge `open` accepts — 16384, the Vulkan guaranteed
 * minimum `maxImageDimension2D`, so a size the verb accepts is one every
 * conformant device can allocate.
 *
 * **Header gap.** `tension_2d.h:50` states it in prose ("`width`/`height`
 * outside 1..16384") and `:61-66` explains the choice, but no macro carries
 * the number. A guest cannot read a comment, so this file names it; the fix is
 * a `#define TENSION_2D_MAX_CANVAS_DIMENSION 16384u` in the header, which is
 * not this pass's to make.
 */
export const MAX_CANVAS_DIMENSION: i32 = 16384;

// --- errno values (tension_2d.h:363-390) ----------------------------------

/**
 * The refusals the 2D boundary speaks, as numbers. `tension_2d.h:363-390` gives
 * them by name only — the C side gets the values from `<errno.h>` — so these
 * are the POSIX Linux/Windows-agreed values the adapter actually returns.
 *
 * The framework never translates one: `Canvas` returns the errno the verb
 * returned, unmodified, and records it for `lastError()`.
 */
export const ERR_NOENT: i32 = -2;   // ENOENT: unknown pipe/texture, preset out of range
export const ERR_BUSY: i32 = -16;   // EBUSY:  a handle is already open
export const ERR_NODEV: i32 = -19;  // ENODEV: no device, nothing presented yet
export const ERR_INVAL: i32 = -22;  // EINVAL: bad handle, bad header, bad stride
export const ERR_NOSPC: i32 = -28;  // ENOSPC: short buffer, full bucket, full table
export const ERR_IO: i32 = -5;      // EIO:    SDL, decode or download failed
export const ERR_NOMEM: i32 = -12;  // ENOMEM: allocation failure
export const ERR_NOSYS: i32 = -38;  // ENOSYS: preset not compiled, container not served

// --- derived sizes ---------------------------------------------------------

/**
 * `sizeof(tension_2d_info_record)` (tension_2d.h:328-337) — 24, the header's
 * own figure at `:242`.
 *
 * Derived from the guest-side declaration instead of typed as `24`, so the
 * two cannot disagree: `Info` in `types.ts` mirrors the C struct field for
 * field, and this follows it.
 */
export const INFO_SIZE: u32 = sizeof<Info>();

/**
 * RGBA8 bytes for a `width` x `height` frame — what `screenshot` writes.
 *
 * Overflow-safe by refusing rather than wrapping: a dimension outside
 * `1..MAX_CANVAS_DIMENSION` returns 0, and inside that range the product is at
 * most 2^30, which fits a `u32` with room. A caller that gets 0 has passed a
 * size `open` would have refused anyway.
 *
 * `i32` in, `u32` out: the dimensions a guest holds are the `i32`s it passed to
 * `open`, and an unsigned parameter would turn a negative into a huge positive
 * before this check could see it. (`hello-sprites`' copy took `u32`.) The
 * multiply happens after the check, so no wrap is possible.
 */
export function frameBytes(width: i32, height: i32): u32 {
  if (width < 1 || height < 1) return 0;
  if (width > MAX_CANVAS_DIMENSION || height > MAX_CANVAS_DIMENSION) return 0;
  return <u32>width * <u32>height * 4;
}
