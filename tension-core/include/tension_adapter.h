/*
 * tension_adapter — the C ABI between tension-core and a capability adapter.
 *
 * A capability adapter is a shared object that `tension-core` loads at run time
 * (`dlopen` + one well-known symbol) and through which a wasm import namespace
 * — `ogre` today, others later — is implemented. This header is that boundary's
 * contract and nothing else: it defines no capability's wasm surface, names no
 * OGRE type, and grants no capability any knowledge of another.
 *
 * The counterpart on the guest side is the *session*: a core-owned coprocessor
 * that owns the memory the guest imports, the arena the guest reads and writes,
 * the per-class event queues, and delivery. An adapter posts events to the
 * session and writes its own regions during `publish`; the session decides when
 * anything reaches the guest. That split is why this header has no `pump` and
 * no scheduler: the adapter never decides when the guest runs.
 *
 * Frozen at ABI version 2 (TENSION_ADAPTER_ABI_VERSION). The `tension_core_api`
 * struct and the `tension_adapter` vtable are append-only within a version;
 * changing the meaning of an existing field requires a new entry-point symbol.
 * Version 2 appended `guest_read_checked` to the core API and `layout_hash` to
 * the vtable; a version-1 adapter is refused at load by the version check, so
 * the host never reads the vtable past where a version-1 struct ends.
 *
 * Design note: tension-ogre/DESIGN.md, Appendix A.
 *
 * SPDX-License-Identifier: MIT
 */
#ifndef TENSION_ADAPTER_H
#define TENSION_ADAPTER_H

#include <stddef.h>
#include <stdint.h>

#ifdef __cplusplus
extern "C" {
#endif

/* =====================================================================
 * Rules
 *
 *  1. Every entry point is panic-free: any failure comes back as a negative
 *     POSIX errno value. 0 means success for the calls that report a status.
 *  2. Ids and handles are 1-based; 0 is never valid.
 *  3. All integers are fixed-width and all lengths are bytes. There is no
 *     `size_t` at this boundary: guest pointers and lengths are `uint32_t`
 *     (the guest is wasm32; a `size_t` would be 4 bytes here and 8 in the
 *     adapter's own code, which is how sign-extension bugs are born).
 *  4. The session calls `init`, `link`, `publish`, `apply`, `shutdown` and
 *     `destroy` on the interpreter thread. `publish` and `apply` run only
 *     while the guest is inside a `session::*` call.
 *  5. Adapters never call the guest — from any thread, ever. Callback
 *     invocation belongs to the session and is reached only through
 *     `call_callback`, which is guest-thread-only.
 *  6. Guest memory is reached only through `guest_read`, `guest_write` and
 *     `guest_size`, and only from the guest thread inside a guest-initiated
 *     call. Called outside that window they return -EBUSY; they never fault
 *     and never block. An adapter never caches a pointer into guest memory and
 *     never holds a slice across a call.
 *  7. `post_event` is the only function in this header that may be called from
 *     a non-guest thread. It never touches guest memory and never blocks.
 *  8. An adapter must not require any symbol from the host executable: every
 *     service arrives through `tension_core_api`. This is what makes loading
 *     with `dlopen` safe with no `-rdynamic` and no export-dynamic table.
 *  9. The wasm module name "session" is reserved to tension-core. An adapter
 *     that registers an import there is refused when it links.
 * 10. An adapter must not assume another adapter is loaded, must not read or
 *     interpret another capability's records or ids, and must not assume it is
 *     the only event source.
 * 11. `tension_core_api` and `tension_adapter` are append-only within an ABI
 *     version.
 * 12. Deferred submissions are *copied* by the session before they are queued.
 *     An adapter's `apply` receives bytes; it never receives a guest address.
 * ===================================================================== */

/* ── constants ───────────────────────────────────────────────────────── */

/** The ABI version this header describes. Checked in `init`; not advisory. */
#define TENSION_ADAPTER_ABI_VERSION 3u

/*
 * The arena layout this build's `tension_core_api` is shaped against, as a
 * hash. It is the same value `tension-core layout-hash` prints and the guest
 * SDK is generated from (`arena::layout_hash()`).
 *
 * **It hashes arena geometry only** — the region table, the type catalogue,
 * the field offsets a guest reads, and the scalar constants that decide how a
 * word is interpreted. It does **not** cover this vtable: a field appended to
 * `tension_core_api` or `tension_adapter` leaves the hash unchanged, because the
 * hash is computed by `arena::layout_hash()` from constants an adapter cannot
 * see. The vtable's shape is enforced by **`abi_version` alone** — which is why
 * bumping it is load-bearing for any vtable change, and why the version check
 * runs before this one.
 *
 * An adapter sets `.layout_hash = TENSION_ADAPTER_LAYOUT_HASH` in its vtable.
 * If the host's value disagrees, the load is refused by name rather than the
 * process corrupting later.
 */
#define TENSION_ADAPTER_LAYOUT_HASH 786288195u

/** The most scalar parameters a registered import may take. */
#define TENSION_ADAPTER_MAX_PARAMS 8u

/** The most imports one adapter may register. */
#define TENSION_ADAPTER_MAX_IMPORTS 64u

/** The most event sources one adapter may register. */
#define TENSION_ADAPTER_MAX_SOURCES 8u

/* ── values ──────────────────────────────────────────────────────────── */

/*
 * The closed set of value types that cross this boundary. There is no v128 and
 * no funcref: an import signature is scalars only, so the session can build the
 * wasm-facing wrapper without knowing what the import means.
 */
typedef enum tension_value_type {
    TENSION_VT_VOID = 0,
    TENSION_VT_I32  = 1,
    TENSION_VT_I64  = 2,
    TENSION_VT_F32  = 3,
    TENSION_VT_F64  = 4
} tension_value_type;

/*
 * One argument or return slot. A union rather than a tagged struct because the
 * session has already validated the signature when it builds the call frame:
 * the adapter knows what it registered, so the tag would be dead weight on
 * every call.
 */
typedef union tension_value {
    int32_t i32;
    int64_t i64;
    float   f32;
    double  f64;
} tension_value;

/*
 * A registered import. `ctx` is the adapter's own per-import context, passed
 * back unchanged; `args` holds `nargs` values whose types are the ones declared
 * at registration, in order; `ret` is written only when the declared return
 * type is not TENSION_VT_VOID. Return 0 or a negative errno.
 */
typedef int32_t (*tension_import_fn)(void *ctx, const tension_value *args,
                                     uint32_t nargs, tension_value *ret);

/* Import flags (the `flags` argument of register_import). */

/** Callable from inside a callback: the session copies the record and applies
 * it after the batch. The `queue_*` verbs set this. */
#define TENSION_IMPORT_DEFERRABLE (1u << 0)

/** Exempt from the re-entrancy refusal: safe inside a callback, never pumps,
 * never blocks. Read-only state accessors set this. */
#define TENSION_IMPORT_REENTRANT_READONLY (1u << 1)

/* ── the core API: what the session provides to an adapter ───────────── */

/*
 * `user` is an opaque session context, stable for the adapter's lifetime and
 * passed back to every function here. It is *not* a per-call pointer: whether
 * memory access is legal is a function of thread and phase, not of this handle.
 */
typedef struct tension_core_api {
    /** Filled by the session. The adapter checks it in `init`. */
    uint32_t abi_version;

    /** Opaque session context. */
    void *user;

    /*
     * Copy out of the session's memory. Guest thread, inside a guest-initiated
     * call: -EBUSY outside that window, -EINVAL on a null destination or an
     * out-of-range span. Never partially copies without reporting.
     *
     * This path exists because the session sizes the memory from the module's
     * *declared* import type and validates it before instantiation. The
     * session's own pre-check is load-bearing for diagnostics, not a
     * duplication of the runtime's: wasmtime refuses every mismatched provider
     * with one generic message — measured, not assumed — so a provided memory
     * whose minimum is too small, whose maximum is too large, or which has no
     * maximum at all is refused identically, naming no page count. Only the
     * session's check can say which number was wrong.
     */
    int32_t (*guest_read)(void *user, uint32_t ptr, void *dst, uint32_t len);

    /* Write into the session's memory; the mirror of guest_read, with the same
     * thread and phase rules. The only write path an adapter has. One error code
     * is its own: -ENOSPC while a `publish` hook is running means the epoch's
     * byte budget is exhausted (see the vtable's `publish`), not that the range
     * was wrong. */
    int32_t (*guest_write)(void *user, uint32_t ptr, const void *src,
                           uint32_t len);

    /* The memory's current size in bytes, for bounds checking. Safe outside a
     * guest call: it reads a stored length, not the memory. */
    uint32_t (*guest_size)(void *user);

    /*
     * Resolve one guest function-table index against the guest's exported
     * table and pin its signature. Called once, typically in `link`.
     * -EINVAL for a missing table export, an out-of-range index, a null entry,
     * or a mis-shaped function; -ENOSPC when the adapter's callback budget is
     * exhausted. `param_types` points at `nparams` values of tension_value_type.
     */
    int32_t (*resolve_callback)(void *user, uint32_t table_index,
                                uint32_t ret_type, const uint32_t *param_types,
                                uint32_t nparams, void **out_fn);

    /*
     * Invoke a resolved callback. Guest thread only, inside `publish` or
     * `apply`; -EBUSY elsewhere. A guest trap comes back as -EIO, with the
     * slot already disabled and the fault already published by the session.
     */
    int32_t (*call_callback)(void *user, void *fn, const tension_value *args,
                             uint32_t nargs, tension_value *ret);

    /* Release a resolved callback. Idempotent; the session owns the storage. */
    int32_t (*release_callback)(void *user, void *fn);

    /*
     * One line to stderr, prefixed `[tension:session]`. Never blocks, never
     * fails, callable from any thread. Levels: 0 debug, 1 info, 2 warning,
     * 3 error.
     *
     * The host now routes this through its one logger under the name
     * "session", so the line carries the configured layout (text or JSON) and
     * the configured filter rather than a fixed prefix — see `log_named`
     * below. The vocabulary is unchanged: the four legacy levels map onto
     * DEBUG/INFO/WARN/ERROR. Kept populated for adapters built before the
     * `log_named` append (rule 11).
     */
    void (*log)(void *user, int32_t level, const char *msg, uint32_t len);

    /*
     * Register one import of the adapter's wasm namespace. Valid only while
     * `link` runs. Refused (-EINVAL) for an unknown value type, more than
     * TENSION_ADAPTER_MAX_PARAMS parameters, a duplicate (module, name), a name
     * in the reserved "session" module, a duplicate `verb_id` within the
     * adapter, or any registration after `link` returned.
     */
    int32_t (*register_import)(void *user, const char *module, const char *name,
                               uint32_t ret_type, const uint32_t *param_types,
                               uint32_t nparams, tension_import_fn fn, void *ctx,
                               uint32_t verb_id, uint32_t flags);

    /*
     * Register this adapter's event source. Valid only while `link` runs. The
     * source id tags every event the adapter posts, so two sources of the same
     * class are distinguishable. `hint` is advisory.
     */
    int32_t (*register_source)(void *user, const char *name, uint32_t hint,
                               uint32_t *out_source_id);

    /*
     * Post an event, tagged by class, to the session. Callable from any thread;
     * never touches guest memory; never blocks. The session builds the record;
     * the adapter posts fields. `out_seq` may be NULL. Returns -ENOSPC when the
     * class's queue is full (the adapter may throttle its producer), -EINVAL
     * for an unknown class or source. Posting is a hint about what happened,
     * not a status update: the authoritative state is what the adapter writes
     * into its own regions during `publish`.
     */
    int32_t (*post_event)(void *user, uint32_t source_id, uint32_t class_id,
                          uint32_t flags, uint32_t a, uint32_t b, float f0,
                          float f1, uint64_t *out_seq);

    /*
     * Report one class's delivery mode, ring capacity and flags, so a producer
     * can skip generating events nobody subscribed to. -ENOENT for an unknown
     * class. Callable from any thread.
     */
    int32_t (*class_info)(void *user, uint32_t class_id, uint32_t *out_mode,
                          uint32_t *out_capacity, uint32_t *out_flags);

    /*
     * Look up a region's offset and size in the frozen arena layout. A
     * host-side lookup in the session's own table: it does not read guest
     * memory, so it is valid at `link` time, before `session_open` has run and
     * before the arena has any content. -ENOENT for a kind not in this chunk's
     * twelve.
     *
     * Offsets are compile-time constants: cache them during `link`, use them in
     * `publish`, and treat them as stable for the session's lifetime. Region
     * sizes are not configurable in this chunk, which is what makes the
     * link-time query meaningful at all.
     */
    int32_t (*region_lookup)(void *user, uint32_t kind, uint32_t *out_offset,
                             uint32_t *out_size);

    /*
     * The logging slots appended under rule 11 (they landed at ABI version 1,
     * 2026-10).
     *
     * Optional at the adapter: an adapter built before these fields existed
     * cannot call them and calls `log` instead, so the host keeps that slot
     * populated. An adapter built after should prefer these — they carry a
     * logger name, so the host's per-logger filtering (`--log-level=ogre:debug`)
     * applies to its lines.
     *
     * `level` is a `tension_log_level_t` (0 trace .. 5 fatal) — the *new*
     * vocabulary, not the legacy 0..3 `log` uses. `name` is NUL-terminated and
     * names the logger (e.g. "ogre"); a NULL name means the "session" channel,
     * matching `log`. `msg` / `json` carry `len` bytes. Both are panic-free,
     * never block, never fail, and are callable from any thread; the layout is
     * applied once, in the host.
     */
    void (*log_named)(void *user, int32_t level, const char *name,
                      const char *msg, uint32_t len);
    void (*log_structured)(void *user, int32_t level, const char *name,
                           const char *json, uint32_t len);

    /*
     * The bounds-checked `guest_read`, appended under rule 11 at ABI version 2
     * (C4.1a).
     *
     * Identical to `guest_read` except that the adapter also states the capacity
     * of its own `dst` buffer. The host refuses `-EINVAL` when `len > dst_capacity`
     * instead of copying — the guarantee `guest_read` cannot give, because it
     * only knows `len`, which the adapter also supplied. An adapter that
     * overstates its buffer is the "not careful" case rule 11's neighbours keep
     * naming; this slot is where that becomes a refusal rather than a write past
     * the destination.
     *
     * `guest_read` stays populated and unchanged for adapters built before this
     * slot: they cannot call it and keep calling `guest_read`, which is still a
     * correct enough check against the *source* span (`ptr + len <= memory`).
     * A new adapter should prefer this slot. Same thread and phase rules as
     * `guest_read`.
     */
    int32_t (*guest_read_checked)(void *user, uint32_t ptr, void *dst,
                                  uint32_t len, uint32_t dst_capacity);

    /*
     * One render frame has been presented, appended under rule 11 at ABI
     * version 3 (0.7.0a).
     *
     * Called by the adapter's render thread once per frame, from the thread
     * that owns the renderer, **after** the frame is presented — a signal before
     * presentation would wake a loop for a frame nobody can see. The session
     * forwards it to whichever loop is driving the guest; a guest with no
     * renderer never sends one, and a host with no loop ignores it.
     *
     * It carries no frame number and no timing: the loop needs "a frame
     * happened", and a number would invite it to infer a rate the adapter never
     * promised. It never blocks and never touches guest memory, so it belongs to
     * the any-thread slots (rule 7).
     *
     * An adapter that presents no frames simply never calls it.
     */
    void (*signal_frame)(void *user);
} tension_core_api;

/* ── the adapter: what it provides to the session ────────────────────── */

/*
 * NULL slots mean "nothing to do", except that `shutdown` and `destroy` must be
 * present. `publish` and `apply` are optional; an adapter with deferrable
 * imports must supply `apply`.
 */
typedef struct tension_adapter {
    uint32_t abi_version; /* TENSION_ADAPTER_ABI_VERSION */
    const char *name;     /* the capability's wasm module name, e.g. "ogre" */
    uint32_t flags;       /* reserved; 0 */

    /* Construct the adapter. Check `abi_version` here and refuse on mismatch.
     * May block bounded (device or window creation); must not enter a loop and
     * must not touch guest memory. */
    int32_t (*init)(void *ctx, const tension_core_api *core);

    /* Register imports and event sources; declare the region kinds this
     * adapter requires. Pure registration: no I/O, no blocking, no guest
     * memory. */
    int32_t (*link)(void *ctx, const tension_core_api *core);

    /* Called once per delivery epoch, on the guest thread, inside the session's
     * publish phase, with guest memory available through `guest_write`. Write
     * this adapter's host -> guest regions from its own mirror. Bounded work
     * only: no blocking, no callback invocation, no guest reads of state the
     * guest may be mutating.
     *
     * The session gives each publish call a byte budget for the epoch (1 MiB in
     * chunk 1). `guest_write` returns -ENOSPC once it is spent, and that means
     * "this epoch is over budget": stop and let the next epoch's publish finish
     * the write rather than retrying in a loop. A hook that runs out leaves
     * partly written regions, which is the signal that it is doing more per
     * epoch than the session will pay for.
     *
     * NULL means the adapter owns no regions. */
    int32_t (*publish)(void *ctx, const tension_core_api *core);

    /* Apply one deferred submission, on the guest thread, from the record bytes
     * the session copied when the guest called the verb. `verb_id` is the one
     * declared at registration; the call depth is reset to 0, so the verb's
     * normal implementation may be reused. A non-zero return becomes a
     * SUBMISSION_REJECTED delivery for the guest. NULL means the adapter has no
     * deferrable verbs. */
    int32_t (*apply)(void *ctx, uint32_t verb_id, const void *record,
                     uint32_t len);

    /* Stop background threads and release their resources; idempotent; must not
     * touch guest memory. A render thread tears down its own engine objects
     * before exiting, on its own thread: that is what joining buys. */
    int32_t (*shutdown)(void *ctx);

    /* Free the adapter's own storage. Called once, after `shutdown`. */
    void (*destroy)(void *ctx);

    /*
     * The arena layout this adapter was built against, appended under rule 11.
     * Set it to `TENSION_ADAPTER_LAYOUT_HASH`.
     *
     * The host checks it at **load time**, before `init`/`link` and before any
     * vtable slot is called: a mismatch is refused with a message naming both
     * hashes. Where `abi_version` answers "is this the right *shape of
     * contract*", `layout_hash` answers "is this the right *build of the
     * arena*".
     *
     * **What it does not do.** It does not cover the vtable's own layout — see
     * the note on `TENSION_ADAPTER_LAYOUT_HASH` above. A vtable field appended
     * without a version bump is caught by `abi_version`, not by this field.
     *
     * This field is reached only by a **version-2 or later** adapter. A
     * version-1 adapter has a 72-byte `tension_adapter` with no `layout_hash`;
     * reading offset 72 here would be an out-of-bounds read of the shorter
     * object, so it is the **version check** — run first, in `load_adapter` —
     * that refuses a v1 adapter (`-EINVAL`, "built against adapter ABI 1"), not
     * this field. The two checks are ordered for exactly that reason: version
     * first, then layout.
     *
     * Growth: 72 bytes at v1, 80 at v2 (this field), unchanged at v3 — v3
     * grows `tension_core_api` instead (`signal_frame`), because the render
     * thread signals the *host*, and the adapter holds the host's table.
     */
    uint32_t layout_hash;
} tension_adapter;

/*
 * The one symbol the session looks up with dlsym. The version lives in the
 * symbol name so a future tension_adapter_v2 can coexist in one object, and so
 * a missing symbol is a named load failure rather than a crash.
 */
const tension_adapter *tension_adapter_v1(void);

/* ── error codes at this boundary ────────────────────────────────────── */

/*
 *   0       success (for calls that report a status)
 *  -EINVAL  malformed argument, unsupported shape, or a refused registration
 *  -ENOENT  unknown region kind or unknown event class
 *  -EBUSY   wrong thread or phase, or a re-entrant call refused
 *  -EIO     a guest callback trapped, or a fatal adapter fault
 *  -ENOSPC  a class queue is full, or a callback budget is exhausted
 *  -EBADF   the session is not READY
 *  -ENOMEM  allocation failure
 *  -ENOSYS  a required slot was left NULL
 *
 * On the import-type refusals behind C3 (see tension-ogre/DESIGN.md §4.1): all
 * three directions — a provided minimum below the declared minimum, a provided
 * maximum above the declared maximum, and an unbounded provider — produce the
 * *same* wasmtime error string, with no page counts in it. The session's
 * pre-check is therefore not belt-and-braces; it is the only place the failing
 * number can be named, and adapters can rely on it having run before they see
 * anything.
 */

/* ── what an adapter must not do ─────────────────────────────────────── */

/*
 *  1. Never call the guest — not from the render thread, not from any thread.
 *  2. Never touch guest memory outside `publish`, `apply`, or an import call;
 *     never from a background thread; never hold a memory view across anything.
 *  3. Never write a guest -> host region, or a region it did not declare.
 *  4. Never block inside `publish`.
 *  5. Never interpret another capability's records.
 *  6. Never register an import in the reserved "session" module.
 *  7. Never require a symbol from the host executable.
 *  8. Never assume it is the only event source.
 *  9. Never call any `session::*` verb.
 */

/* ── the arena's region kinds ────────────────────────────────────────── */

/*
 * Twelve kinds, frozen for this chunk. `kind == index`: the session writes the
 * region table in ascending kind order, so a guest finds a region by arithmetic
 * and no lookup verb exists. Direction bits live in the region descriptor; the
 * sizes below are the defaults, and they are compile-time constants — an
 * adapter's `region_lookup` at link time is meaningful precisely because
 * nothing at `session_open` can move an offset.
 *
 *  kind  region          default size  written by
 *  ----  --------------  ------------  --------------------------------
 *   0    CONTROL         256 B         session, once (fixed offset 0x000)
 *   1    SESSION_INFO    128 B         session, once (fixed offset 0x100)
 *   2    FRAME_STATE     4 KiB         session
 *   3    JOB             48 KiB        session
 *   4    RESOURCE        48 KiB        session
 *   5    EVENT_TABLE     384 KiB       session (one sub-ring per class)
 *   6    STRING          1 MiB + 32 B  both (two disjoint halves)
 *   7    RESOURCE_REQ    48 KiB        guest
 *   8    SCENE           256 KiB       guest
 *   9    MATERIAL        64 KiB        guest
 *  10    RENDERABLE      128 KiB       guest
 *  11    BUFFER_POOL     4 MiB         guest (bytes)
 *
 * Adding a region requires either a schema bump (a shape change: the layout
 * hash and the schema version both move, and every capability recompiles) or a
 * dynamic allocation mechanism this chunk does not have. A capability adapter
 * cannot add, move or resize one.
 */

/** Region descriptor `flags` bits (direction and shape). */
#define TENSION_RD_GUEST_WRITES (1u << 0)
#define TENSION_RD_SESSION_WRITES (1u << 1)
#define TENSION_RD_WRITES_ONCE (1u << 2)
#define TENSION_RD_BYTES (1u << 3)

#define TENSION_REGION_CONTROL 0u
#define TENSION_REGION_SESSION_INFO 1u
#define TENSION_REGION_FRAME_STATE 2u
#define TENSION_REGION_JOB 3u
#define TENSION_REGION_RESOURCE 4u
#define TENSION_REGION_EVENT_TABLE 5u
#define TENSION_REGION_STRING 6u
#define TENSION_REGION_RESOURCE_REQ 7u
#define TENSION_REGION_SCENE 8u
#define TENSION_REGION_MATERIAL 9u
#define TENSION_REGION_RENDERABLE 10u
#define TENSION_REGION_BUFFER_POOL 11u

/** One past the last region kind this chunk defines. */
#define TENSION_REGION_KIND_MAX 12u

/* ── shape checks ────────────────────────────────────────────────────── */

/*
 * tension_value must be exactly one 8-byte slot: it is the unit the session
 * packs into a call frame, and a wider union would silently change every
 * registered signature's frame layout.
 */
#if defined(__cplusplus)
static_assert(sizeof(tension_value) == 8,
              "tension_value must be one 8-byte slot");
#elif defined(__STDC_VERSION__) && (__STDC_VERSION__ >= 201112L)
_Static_assert(sizeof(tension_value) == 8,
               "tension_value must be one 8-byte slot");
#endif

/*
 * tension_core_api's shape, made mechanical on both sides of the boundary.
 *
 * Rule 11 lets fields be appended, never removed, reordered, or retyped; these
 * assertions are what make an append *deliberate*. The first fails if a slot is
 * inserted or removed before the last one; the second fails if the trailing
 * count changes. Either way the fix is the same and names both halves: update
 * this assertion together with the Rust `TensionCoreApi` and the matching
 * `const _` block in `tension-core/src/adapter/ffi.rs`.
 *
 * (The count is expressed against `offsetof(user)` and `sizeof(void *)` so it
 * holds on 32- and 64-bit alike; every slot after `abi_version` is
 * pointer-sized.)
 */
#if defined(__cplusplus)
static_assert(offsetof(tension_core_api, signal_frame)
                      + sizeof(((tension_core_api *)0)->signal_frame)
                  == sizeof(tension_core_api),
              "tension_core_api: signal_frame must stay the last slot; an "
              "append updates this assertion and the Rust table together");
static_assert(sizeof(tension_core_api)
                  == offsetof(tension_core_api, user) + 17 * sizeof(void *),
              "tension_core_api: expected 17 pointer-sized slots after "
              "abi_version; update this count, the Rust TensionCoreApi, and its "
              "size assertion together");
#elif defined(__STDC_VERSION__) && (__STDC_VERSION__ >= 201112L)
_Static_assert(offsetof(tension_core_api, signal_frame)
                       + sizeof(((tension_core_api *)0)->signal_frame)
                   == sizeof(tension_core_api),
               "tension_core_api: signal_frame must stay the last slot; an "
               "append updates this assertion and the Rust table together");
_Static_assert(sizeof(tension_core_api)
                   == offsetof(tension_core_api, user) + 17 * sizeof(void *),
               "tension_core_api: expected 17 pointer-sized slots after "
               "abi_version; update this count, the Rust TensionCoreApi, and its "
               "size assertion together");
#endif

/*
 * tension_adapter's shape, likewise mechanical. `layout_hash` is a u32 appended
 * after nine pointer-sized slots, so its offset is what the assertion pins (a
 * trailing u32 is followed by tail padding, so `offset + sizeof == sizeof`
 * would not hold). The Rust `const _` block asserts the same offset and the
 * 80-byte size from its side.
 */
#if defined(__cplusplus)
static_assert(offsetof(tension_adapter, layout_hash) == 9 * sizeof(void *),
              "tension_adapter: layout_hash must sit after the nine leading "
              "fields; an append or reorder updates this assertion and the Rust "
              "TensionAdapter offset asserts together");
static_assert(sizeof(tension_adapter) == 10 * sizeof(void *),
              "tension_adapter: expected ten pointer-sized slots (the nine "
              "leading fields plus layout_hash); update this count, the Rust "
              "TensionAdapter, and its size assertion together");
#elif defined(__STDC_VERSION__) && (__STDC_VERSION__ >= 201112L)
_Static_assert(offsetof(tension_adapter, layout_hash) == 9 * sizeof(void *),
               "tension_adapter: layout_hash must sit after the nine leading "
               "fields; an append or reorder updates this assertion and the Rust "
               "TensionAdapter offset asserts together");
_Static_assert(sizeof(tension_adapter) == 10 * sizeof(void *),
               "tension_adapter: expected ten pointer-sized slots (the nine "
               "leading fields plus layout_hash); update this count, the Rust "
               "TensionAdapter, and its size assertion together");
#endif

/*
 * Frozen at ABI version 2. Additive fields are appended; the version check in
 * `init` is mandatory rather than advisory, and it is what refuses a
 * version-1 adapter before its shorter vtable is read as if it were longer.
 */

#ifdef __cplusplus
} /* extern "C" */
#endif

#endif /* TENSION_ADAPTER_H */
