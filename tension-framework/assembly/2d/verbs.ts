// tension-framework/assembly/2d/verbs.ts — the nine `tension::2d` imports.
//
// This module is internal to the SDK, the way `ogre/wire.ts` is internal to
// `ogre/`: `2d/index.ts` does not re-export it, and a guest calls `Canvas`
// rather than a verb. The declarations live in one file so the wire is stated
// once — a second `@external("tension::2d", …)` anywhere else is a second
// declaration of a signature the header already owns.
//
// The authority is `tension-2d/include/tension_2d.h`. Every parameter and
// return is `i32` (tension_adapter.h rule 3: there is no `size_t` at this
// boundary); guest pointers cross as `u32` where the header says `u32` and as
// `i32` where it says `int32_t`.
//
// ## Nine, not ten
//
// `tension_2d.h` declares ten verbs. `shader_compile_raw` (verb_id 4) is not
// declared here, on purpose:
//
//   * it answers `-ENOSYS` in every build — the DSO carries no GLSL → SPIR-V
//     translator (`tension_2d.h:143-151`, `adapter.cpp:248-254`);
//   * none of the three 2D examples calls it, though all three declare it,
//     which is the strongest evidence available that the declaration is dead
//     weight;
//   * a wrapper in the SDK is an invitation. A stub that always refuses, but
//     that a caller can reach without seeing a comment, is one more way for a
//     game to ship a code path that cannot work.
//
// The door still exists in the wire, and the adapter still registers verb 4 —
// see `tension-core/tests/2d_surface.rs`, which pins all ten registrations.
// Re-opening it in the SDK is a design decision, not a wrapper decision: it
// needs the translator first.
//
// ## Why the `*Raw` suffix
//
// AssemblyScript requires the local name to differ from the import name when a
// wrapper shares it, and `Raw` is the house convention — 32 of the framework's
// 66 declarations use it. `Canvas` calls these; nothing else should.

// --- the imports (module "tension::2d") ------------------------------------

/** `tension_2d_open` — verb_id 1. A handle (> 0), or an errno. */
@external("tension::2d", "open")
export declare function openRaw(width: i32, height: i32, flags: i32): i32;

/** `tension_2d_close` — verb_id 2. */
@external("tension::2d", "close")
export declare function closeRaw(handle: i32): i32;

/** `tension_2d_set_pipeline` — verb_id 3. `blob_ptr == 0` addresses preset `blob_len`. */
@external("tension::2d", "set_pipeline")
export declare function setPipelineRaw(handle: i32, blobPtr: i32, blobLen: i32): i32;

/** `tension_2d_submit` — verb_id 5. Returns the count accepted. */
@external("tension::2d", "submit")
export declare function submitRaw(handle: i32, pipeId: i32, hdrPtr: i32, zBucket: i32): i32;

/** `tension_2d_present` — verb_id 6. */
@external("tension::2d", "present")
export declare function presentRaw(handle: i32): i32;

/** `tension_2d_texture_load` — verb_id 7. Returns a 1-based texture id. */
@external("tension::2d", "texture_load")
export declare function textureLoadRaw(handle: i32, srcPtr: i32, srcLen: i32, targetFormat: i32): i32;

/** `tension_2d_set_texture` — verb_id 10. Binds a texture to one array page. */
@external("tension::2d", "set_texture")
export declare function setTextureRaw(handle: i32, pipeId: i32, slot: i32, textureId: i32): i32;

/** `tension_2d_info` — verb_id 8, `TENSION_IMPORT_REENTRANT_READONLY`. */
@external("tension::2d", "info")
export declare function infoRaw(handle: i32, ptr: u32, cap: i32): i32;

/** `tension_2d_screenshot` — verb_id 9. Returns the bytes written. */
@external("tension::2d", "screenshot")
export declare function screenshotRaw(handle: i32, ptr: u32, cap: i32): i32;
