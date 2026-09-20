/*
 * tension_ogre — the OGRE capability's boundary header.
 *
 * The counterpart of tension_adapter.h for one capability: it fixes the wasm
 * import surface (`ogre::*`) that the adapter implements, the config TLV the
 * guest builds for `ogre::init`, the payload convention of the events the
 * adapter posts, and the errno mapping of its refusals. The guest SDK
 * (tension-framework/assembly/ogre/index.ts) and the adapter's C++ sources both
 * answer to it, and neither invents a key the other does not know.
 *
 * This header includes no OGRE header, on purpose. Everything a guest can see
 * is the boundary, and the adapter's OGRE-facing includes live in src/ where
 * they cannot leak into the wire contract — DESIGN.md §0: the version pin is a
 * build-time concern that the wire format does not depend on.
 *
 * Sub-chunk 1 registers three imports: init, shutdown and last_error. The
 * submission verbs (queue_mesh_load, queue_texture_load, job_state,
 * job_release) belong to the sub-chunk that has submissions to queue.
 *
 * SPDX-License-Identifier: MIT
 */
#ifndef TENSION_OGRE_H
#define TENSION_OGRE_H

#include <stdint.h>

#ifdef __cplusplus
extern "C" {
#endif

/* ── the imports this adapter registers ──────────────────────────────── */

/*
 * The wasm-facing surface, module name "ogre". The guest declares these with
 * `@external("ogre", ...)`; the adapter registers them through
 * `tension_core_api.register_import`, in `link` (registration is refused
 * outside it), handing over one `tension_import_fn` shim per verb. The shims
 * unpack the `tension_value` arguments and match these prototypes after the
 * boundary erases the C naming — the declarations below are the wasm-level
 * signature, which is what the guest compiles against.
 *
 * Everything here is `i32` at the wasm boundary. Guest pointers are `u32`
 * offsets into the guest's own memory — the adapter reaches that memory only
 * through `guest_read` / `guest_write`, inside a guest-initiated call.
 */

/*
 * `ogre::init(i32 cfg_ptr, i32 cfg_len) -> i32`  — verb_id 1, flags 0.
 *
 * Decodes the config TLV at `[cfg_ptr, cfg_ptr + cfg_len)` and starts the
 * render thread. Returns 0 when the config was accepted: the window is *not*
 * up yet, and the adapter reports readiness with a RESOURCE_READY event, so a
 * guest whose platform is slow to open a window never blocks inside this call.
 * A malformed or unsupported config is refused here, synchronously, with
 * -EINVAL; a second init while one is live is -EBUSY.
 *
 * Carries no import flags: calling it from inside a callback is refused by the
 * session with -EBUSY, like every other non-exempt verb.
 */
int32_t ogre_init(uint32_t cfg_ptr, uint32_t cfg_len);

/*
 * `ogre::shutdown() -> i32`  — verb_id 2, flags 0.
 *
 * Requests the render thread to stop and waits, bounded, for it to join: the
 * thread tears down its own OGRE objects before exiting, which is what joining
 * buys (tension_adapter.h, `shutdown`). Idempotent, and 0 when nothing was ever
 * initialised. Called while init is still starting, it returns once the thread
 * reaches its next startup checkpoint rather than waiting for the whole
 * startup.
 */
int32_t ogre_shutdown(void);

/*
 * `ogre::last_error(i32 ptr, i32 cap) -> i32`  — verb_id 3,
 * flags TENSION_IMPORT_REENTRANT_READONLY.
 *
 * The adapter's last diagnostic, as UTF-8, probe/consume the way
 * `tension::io read_line` is: `cap <= 0` asks for the length without consuming,
 * `cap > 0` consumes the message, writes `min(cap, len)` bytes and returns the
 * full length. `-1` means there is nothing to report — the normal case, not an
 * error.
 *
 * Reentrant because reading a message is exactly the exempt-accessor case: it
 * takes a lock, copies a string, never pumps and never blocks.
 */
int32_t ogre_last_error(uint32_t ptr, int32_t cap);

/* ── the config TLV ──────────────────────────────────────────────────── */

/*
 * The same wire shape as the session config (DESIGN.md §6.1): a `u32` entry
 * count in little-endian, then per entry a `u32` key, a `u8` tag and an `i64`
 * little-endian value. Every value here is carried by tag 2 and its upper four
 * bytes must be zero. `KEY_ABI_VERSION` must be the first entry in the byte
 * stream — the AS builder cannot emit a config without it, and the decoder
 * refuses a stream that does not start with it.
 *
 * These numbers mirror tension-framework/assembly/ogre/index.ts exactly; that
 * file is the guest half of the same contract.
 */
#define TENSION_OGRE_KEY_ABI_VERSION 1u /* u32, required, must come first */
#define TENSION_OGRE_KEY_RENDERER 2u    /* u32, a TENSION_OGRE_RENDERER_* */
#define TENSION_OGRE_KEY_HEADLESS 3u    /* u32, 0/1: do not open a window */
#define TENSION_OGRE_KEY_VSYNC 4u       /* u32, 0/1 */
#define TENSION_OGRE_KEY_FRAME_HZ 5u    /* u32, frames per second to pace to */
#define TENSION_OGRE_KEY_WINDOW_WIDTH 6u  /* u32, pixels */
#define TENSION_OGRE_KEY_WINDOW_HEIGHT 7u /* u32, pixels */

/** The ABI version this capability's config carries. */
#define TENSION_OGRE_ABI_VERSION 1u

/*
 * The renderer to bring up. All four are named so the guest SDK and the adapter
 * agree on the numbering; the adapter refuses one it cannot provide with a
 * DEVICE_LOST event rather than an -EINVAL, because "not available here" is an
 * environment fact, not a malformed request.
 */
#define TENSION_OGRE_RENDERER_NULL 0u    /* RenderSystem_NULL: no window, no GPU */
#define TENSION_OGRE_RENDERER_GL3PLUS 1u /* RenderSystem_GL3Plus */
#define TENSION_OGRE_RENDERER_METAL 2u   /* not in this chunk */
#define TENSION_OGRE_RENDERER_VULKAN 3u  /* not in this chunk */

/* ── what the adapter tells the guest ────────────────────────────────── */

/*
 * Two event classes, delivered through the session like any other event: the
 * guest subscribes, and the session decides when it runs (DESIGN.md §3.2).
 *
 *   RESOURCE_READY (5)  a = resource_id, b = 0
 *       The renderer is up. Resource id 1 is the renderer itself, so
 *       `a == TENSION_OGRE_RESOURCE_RENDERER`; later sub-chunks give real
 *       resources their own ids.
 *
 *   DEVICE_LOST (0)     a = stage, b = errno as u32 (two's complement)
 *       Startup or a frame failed at `a`'s stage with `b`'s errno. The same
 *       errno also names the reason in `last_error`, and the renderer's record
 *       in the RESOURCE region carries it as a status, because events are
 *       advisory and the status table is the truth (DESIGN.md §0).
 *
 * The stage codes, in the order startup performs them:
 */
#define TENSION_OGRE_STAGE_PLUGIN 0u        /* load the render system plugin */
#define TENSION_OGRE_STAGE_RENDER_SYSTEM 1u /* create/select the render system */
#define TENSION_OGRE_STAGE_WINDOW 2u        /* create the window */
#define TENSION_OGRE_STAGE_INITIALISE 3u    /* render system initialisation */
#define TENSION_OGRE_STAGE_FRAME 4u         /* rendering a frame */
#define TENSION_OGRE_STAGE_COMPLETE 5u      /* startup finished; frames are running */

/** The session's class ids this adapter posts to. */
#define TENSION_OGRE_CLASS_DEVICE_LOST 0u
#define TENSION_OGRE_CLASS_RESOURCE_READY 5u

/** The renderer's own resource id; the RESOURCE region's first slot. */
#define TENSION_OGRE_RESOURCE_RENDERER 1u

/**
 * The renderer's `kind` in its RESOURCE record. The catalogue's own kinds
 * (mesh, texture, shader, font) keep their numbering; the renderer is not a
 * loadable resource, so its slot carries this sentinel — named here rather
 * than borrowing a catalogue kind it does not mean.
 */
#define TENSION_OGRE_RES_KIND_RENDERER 0xFFFFFFFFu

/* ── the job lifecycle, as the catalogue declares it ─────────────────── */

/*
 * States of the 64-byte `Job` record (`assembly/ogre/wire.ts`): jobId@0,
 * state@4, kind@8, flags@12, priority@16, resourceId@20, progress@24 (f32),
 * error@28, nameOffset@32, nameLength@36, seq@40, reserved@48, reserved2@56.
 */
#define TENSION_OGRE_JOB_PENDING 0u
#define TENSION_OGRE_JOB_LOADING 1u
#define TENSION_OGRE_JOB_DONE 2u
#define TENSION_OGRE_JOB_FAILED 3u
#define TENSION_OGRE_JOB_CANCELLED 4u
/** Not one of the five states: the marker `job_release` leaves behind. */
#define TENSION_OGRE_JOB_RELEASED 5u

#define TENSION_OGRE_JOB_RECORD_BYTES 64u

/* Light kinds, as the catalogue declares them. */
#define TENSION_OGRE_LIGHT_DIRECTIONAL 0u
#define TENSION_OGRE_LIGHT_POINT 1u
#define TENSION_OGRE_LIGHT_SPOT 2u

/* Material shader models, as the catalogue declares them. */
#define TENSION_OGRE_MAT_HLMS_PBS 0u
#define TENSION_OGRE_MAT_HLMS_UNLIT 1u
#define TENSION_OGRE_MAT_HLMS_CUSTOM 2u

/** The two resource kinds this sub-chunk loads. */
#define TENSION_OGRE_RES_KIND_MESH 0u
#define TENSION_OGRE_RES_KIND_TEXTURE 1u

/** The two classes a finished job is announced with. */
#define TENSION_OGRE_CLASS_JOB_FAILED 1u
#define TENSION_OGRE_CLASS_JOB_DONE 4u

/**
 * One `Resource` record, as the catalogue lays it out
 * (`assembly/ogre/wire.ts`): id@0, kind@4, state@8, flags@12, size@16,
 * nameOffset@20, nameLength@24, error@28, refs@32, pad0@36, seq@64-bit@40.
 * The frame counter lands in `seq` so a guest can see the loop is alive.
 */
#define TENSION_OGRE_RESOURCE_RECORD_BYTES 48u

/*
 * The renderer's record in the RESOURCE region carries these states, matching
 * the capability catalogue the guest SDK declares (assembly/ogre/wire.ts). The
 * adapter writes it during `publish`, from its host-side mirror.
 */
#define TENSION_OGRE_RES_STATE_REQUESTED 0u
#define TENSION_OGRE_RES_STATE_LOADING 1u
#define TENSION_OGRE_RES_STATE_READY 2u
#define TENSION_OGRE_RES_STATE_FAILED 3u
#define TENSION_OGRE_RES_STATE_UNLOADED 4u

/* ── refusals ────────────────────────────────────────────────────────── */

/*
 * The adapter's errno vocabulary is tension_adapter.h's — the boundary's list
 * is closed, and there is no -ENODEV in it, so "no display" is -EIO here:
 *
 *   -EINVAL  the config TLV is malformed, unknown-keyed, trailing, or not
 *            version 1. Returned by `init`, synchronously, before any thread
 *            exists.
 *   -EBUSY   `init` while one is live, or (from the session, not the adapter)
 *            any of these three verbs called from inside a callback.
 *   -EIO     the window could not be created, the plugin is missing, the
 *            render system refused to initialise, or a frame failed. These
 *            arrive as a DEVICE_LOST event, not as `init`'s return, because
 *            they happen on the render thread after `init` already returned;
 *            `shutdown` also returns it when the thread does not stop within
 *            the bounded wait.
 *    0      `shutdown` before `init` — nothing to stop is not a failure.
 *
 * Diagnostics go to the session's log with the `[tension:ogre]` prefix, which
 * names the module, not the capability (DESIGN.md §6.1).
 */

#ifdef __cplusplus
} /* extern "C" */
#endif

#endif /* TENSION_OGRE_H */
