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
 * The ABI is alpha: it may break between releases. `TENSION_ADAPTER_ABI_VERSION`
 * states today's shape — a fact, not a promise. While alpha lasts, the shape
 * stays append-only: `tension_core_api` and `tension_adapter` grow at the end,
 * never reorder or remove a field, and changing an existing field's meaning
 * needs a new entry-point symbol. That discipline is what makes a version bump
 * catchable; it is not a compatibility promise during alpha, only a courtesy
 * that keeps the codebase coherent. Version 2 appended `guest_read_checked` and
 * `layout_hash`; version 3 `signal_frame`; version 4 `shader_generate`; version
 * 5 `compile_graph` (a graph blob, not a layout); version 6 `post_control`,
 * `host_surface` and `host_surface_extension`; version 7
 * `register_event_layer`, `unregister_event_layer`, `host_window_info` and
 * `pad_state` (the event dispatcher: a capability subscribes to the host's
 * input events instead of owning an SDL queue of its own).
 *
 * The window structs below (`tension_window_config`, `tension_window_info`)
 * arrived with the *guest* programmatic window API, which is what let
 * `--window` leave the command line. They add no slot to this table: the guest
 * reaches them through `tension::platform.create_window`, on the interpreter
 * thread, which is the only thread SDL will let create a window. An adapter
 * cannot create one — casting a slot for it would be a contract nothing could
 * honour. They live here because this header is where the wire's structs live.
 * A version-1 adapter is refused at load, so the host never reads past its end.
 *
 * Version 7 added the event wire (`tension_event`, `tension_event_layer`) and
 * moved `tension_pad_record` here from `tension_input.h`, so the record one
 * capability writes and the slot that serves it are declared in one place. No
 * existing slot changed and no struct changed layout; the four new slots are
 * appended, which is what rule 11 permits and what the version check enforces.
 *
 * Design note: `docs/abi/adapter.md`.
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
 *     version — the discipline in force while alpha lasts, not a promise.
 * 12. Deferred submissions are *copied* by the session before they are queued.
 *     An adapter's `apply` receives bytes; it never receives a guest address.
 * 13. A registered event layer's `dispatch` runs on the thread that owns the
 *     window — the same one that initialised SDL — synchronously after each
 *     pump, outside any adapter callback (a `publish` hook or a deferred
 *     `apply`), and never nested inside another dispatch. It may call
 *     `post_event` and `post_control` (both are any-thread safe and neither
 *     blocks). It must not touch guest memory, must not block, and must not
 *     register or unregister a layer — that is refused with -EBUSY rather than
 *     deadlocking the pump.
 *
 *     A pump happens (a) once per iteration of the host-owned loop, and (b) at
 *     the start of every blocking `session::wait` / `session::drain`, before
 *     that epoch runs. (b) is what serves a guest that drives its own loop:
 *     such a guest only yields to the host inside those two verbs, so a pump
 *     anywhere else would never run while it is alive.
 *
 *     **Overflow contract.** One pump translates at most
 *     `TENSION_EVENT_BATCH_CAPACITY` (256) events. A drain that produces more
 *     drops the excess, counts it, and logs one line; the 256 that fit are
 *     delivered normally and `dispatch` is called exactly once for them. A
 *     layer therefore cannot lose its place in a batch — there is no partial
 *     batch, no second call — but it *can* miss the newest events of a stall
 *     big enough to overflow. A layer whose correctness depends on every
 *     sample should coalesce what it needs from the state it keeps (the input
 *     capability accumulates motion rather than posting it per sample) rather
 *     than assume the batch is the whole drain.
 * ===================================================================== */

/* ── constants ───────────────────────────────────────────────────────── */

/** The ABI version this header describes. Checked in `init`; not advisory. */
#define TENSION_ADAPTER_ABI_VERSION 7u

/* ── window control: the host's write channel ────────────────────────── */
/*
 * A capability cannot call SDL. `tension-core` owns the window, and SDL's
 * window API is not thread-safe: every call must happen on the thread that
 * created the window. So a capability that wants the window changed says *what*
 * it wants and lets the host do it, on the host's thread, at a moment the host
 * chooses.
 *
 * One queue, three sources, one executor:
 *
 *   source 0 (LAYER)  an adapter calls `post_control`. Any thread.
 *   source 1 (CORE)   the host itself, for timers, DPI changes, focus.
 *   source 2 (GUEST)  the guest's `tension::platform.control` import.
 *
 * All three land in the same queue and the same executor. That is deliberate:
 * ordering between sources is then *arrival* order, one rule instead of three,
 * and no source can bypass another's backpressure.
 *
 * The executor drains once per frame on the window's own thread and is the
 * only code in the process that calls `SDL_SetWindow*`. Nothing else may.
 */

/*
 * What a control message asks for. Kinds are additive: an unknown kind is
 * refused with -EINVAL, never guessed at.
 *
 * Values are explicit and stable. `0` is not a kind, so a zeroed struct is
 * refused rather than silently meaning something.
 */
typedef enum tension_ctrl_kind {
    /** a0 = width in pixels, a1 = height. Clamping is the executor's job: a
     *  layer sends what it wants, the host decides what the window system
     *  allows, and the guest learns the result by polling. */
    TENSION_CTRL_RESIZE = 1u,
    /** a0 = 0 disables, non-zero enables. Relative mouse mode: the pointer is
     *  grabbed and motion arrives as raw deltas rather than window
     *  coordinates. The input capability is the only caller, and it no longer
     *  holds a window to call `SDL_SetWindowRelativeMouseMode` on -- the
     *  executor is the one place that does.
     *
     *  Declared `CORE_ONLY` by its caller: the resulting state is reported by
     *  the capability's own `input_state` record, not by `host_surface`. */
    TENSION_CTRL_RELATIVE_MOUSE = 2u
} tension_ctrl_kind;

/*
 * What the caller can expect afterwards. This is the caller's declaration, not
 * a hint: it decides whether the next state is worth polling.
 */
typedef enum tension_ctrl_visibility {
    /** Handled, and deliberately leaves no readable state. A caller cannot
     *  observe whether it happened, which is why a host must never silently
     *  drop one of these — see the reserved-capacity rule below. */
    TENSION_CTRL_CORE_ONLY = 0u,
    /** Handled, and the resulting state is readable from `host_surface` on the
     *  next poll. This is the only confirmation the guest gets: there are no
     *  control callbacks. */
    TENSION_CTRL_OBSERVABLE = 1u
} tension_ctrl_visibility;

/*
 * One control message.
 *
 * **`source` is not the caller's to set.** Callers pass 0 and the receiving
 * entry point stamps the truth before the message is queued:
 *
 *   the guest import         stamps TENSION_CTRL_SRC_GUEST
 *   `post_control` (a layer) stamps TENSION_CTRL_SRC_LAYER
 *   the host's own push      stamps TENSION_CTRL_SRC_CORE
 *
 * A non-zero value supplied by a caller is overwritten and has no effect. This
 * matters because the source decides which queue region the message may occupy
 * (the core has reserved capacity a layer cannot consume), so a forgeable field
 * would let a layer take the host's slots. The field exists for the *executor*, 
 * which needs to know who is talking; it is an output of the enqueue, not an
 * input to it.
 *
 * Arguments are values, never guest pointers: `post_control` is callable from
 * the host and from other threads, where there is no guest memory to read. A
 * message needing bytes carries them inline or the verb does not exist yet.
 */
typedef struct tension_ctrl_msg {
    uint32_t kind;       /* tension_ctrl_kind */
    uint32_t visibility; /* tension_ctrl_visibility */
    int32_t  arg0;
    int32_t  arg1;
    int32_t  arg2;
    int32_t  arg3;
    uint32_t source;     /* stamped by the bus; see above */
    uint32_t reserved;   /* must be 0 */
} tension_ctrl_msg;

/*
 * The host's window surface (ABI v6). See the `host_surface` slot.
 *
 * `struct_size` is `sizeof(tension_host_surface)` and exists so a later ABI can
 * grow this without a new slot: an adapter passes the size it was compiled
 * against in, and the host writes no more than that.
 */
typedef struct tension_host_surface {
    uint32_t struct_size;
    uint32_t width;   /* current drawable size, pixels */
    uint32_t height;
    uint32_t reserved;
    uint64_t instance; /* VkInstance, 0 = none */
    uint64_t surface;  /* VkSurfaceKHR, 0 = none */
} tension_host_surface;

/*
 * A window the guest asks the host to create (ABI v7). See the `create_window`
 * slot.
 *
 * `struct_size` is `sizeof(tension_window_config)` at the caller's build, and
 * the host reads no field past it — the same additive-growth rule
 * `tension_host_surface` uses. A host that does not know a field the caller
 * sent cannot misread it.
 *
 * `title_ptr` / `title_len` are a guest address and a byte length: UTF-8, no
 * NUL terminator, read with `guest_read` inside the creating call. Zero length
 * means "no title", not "read address zero".
 *
 * `x` and `y` are `TENSION_WINDOW_POS_CENTERED` for "let the window system
 * place it", otherwise an absolute desktop position. A caller that means the
 * origin says 0, which is why "centered" needs a sentinel rather than being
 * spelled 0.
 *
 * `min_*` and `max_*` are 0 for "no bound". A maximum of 0 with a non-zero
 * minimum means "at least this"; both zero means the window system's own
 * limits.
 */
typedef struct tension_window_config {
    uint32_t struct_size;
    uint32_t target; /* TENSION_WINDOW_TARGET_* */
    uint32_t width;
    uint32_t height;
    uint32_t mode;  /* TENSION_WINDOW_MODE_* */
    uint32_t flags; /* TENSION_WINDOW_FLAG_* */
    int32_t x;
    int32_t y;
    uint32_t min_width;
    uint32_t min_height;
    uint32_t max_width;
    uint32_t max_height;
    uint32_t title_ptr;
    uint32_t title_len;
} tension_window_config;

/*
 * What the guest can learn about its window (ABI v7). See the `window_info`
 * slot.
 *
 * Two sizes, and they are different questions: `width`/`height` are logical
 * units (what a UI lays out in), `pixel_width`/`pixel_height` are what a render
 * target is allocated at. On a 1x display they are equal; on a high-DPI one
 * they are not, and a renderer that conflates them draws a blurry frame.
 *
 * **A run with no window answers 0, not an error.** `width == 0` is the whole
 * headless guard: a guest's update loop should not need per-frame error
 * handling for a window it never asked for.
 */
typedef struct tension_window_info {
    uint32_t struct_size;
    uint32_t width;  /* logical units */
    uint32_t height;
    uint32_t pixel_width; /* drawable pixels */
    uint32_t pixel_height;
    uint32_t dpi_scale_milli; /* display scale x 1000; 1000 = 1.0 */
    uint32_t mode;            /* TENSION_WINDOW_MODE_* */
    uint32_t focused;         /* 0/1 */
    uint32_t minimized;       /* 0/1 */
    uint32_t close_requested; /* 0/1: the user asked to close it */
} tension_window_info;

/*
 * Where a created window's pixels are meant to go. The value decides the flags
 * the window is created with, and the difference is load-bearing on Windows:
 *
 *   PLAIN   an ordinary window. No graphics API is promised anything.
 *   GPU     the window will be handed to `SDL_GPU`. On Linux that means SDL
 *           builds a Vulkan surface from an ordinary window, so no `VULKAN`
 *           flag is needed; on Windows and macOS it uses D3D12/Metal natively,
 *           and asking for a Vulkan window there would demand a Vulkan loader
 *           a D3D12-only machine need not have.
 *   VULKAN  the window will be handed to `SDL_Vulkan_CreateSurface`
 *           (`host_surface`), which *requires* that the window was created with
 *           `SDL_WINDOW_VULKAN`. A renderer that wants the host's
 *           `VkSurfaceKHR` — Ogre-Next's external-surface path — needs this.
 */
#define TENSION_WINDOW_TARGET_PLAIN 0u
#define TENSION_WINDOW_TARGET_GPU 1u
#define TENSION_WINDOW_TARGET_VULKAN 2u

#define TENSION_WINDOW_MODE_WINDOWED 0u
#define TENSION_WINDOW_MODE_FULLSCREEN 1u
#define TENSION_WINDOW_MODE_BORDERLESS_FULLSCREEN 2u

#define TENSION_WINDOW_FLAG_RESIZABLE (1u << 0)
#define TENSION_WINDOW_FLAG_DECORATED (1u << 1)
#define TENSION_WINDOW_FLAG_ALWAYS_ON_TOP (1u << 2)
#define TENSION_WINDOW_FLAG_HIDDEN (1u << 3)
#define TENSION_WINDOW_FLAG_HIGH_DPI (1u << 4)

/** `x`/`y`: let the window system place the window. */
#define TENSION_WINDOW_POS_CENTERED INT32_MIN

/* Every flag this build defines; anything outside is refused with -EINVAL. */
#define TENSION_WINDOW_FLAGS_KNOWN                                      \
    (TENSION_WINDOW_FLAG_RESIZABLE | TENSION_WINDOW_FLAG_DECORATED |    \
     TENSION_WINDOW_FLAG_ALWAYS_ON_TOP | TENSION_WINDOW_FLAG_HIDDEN |   \
     TENSION_WINDOW_FLAG_HIGH_DPI)

/** The source stamps. Not caller-supplied; see `tension_ctrl_msg`. */
#define TENSION_CTRL_SRC_LAYER 0u
#define TENSION_CTRL_SRC_CORE  1u
#define TENSION_CTRL_SRC_GUEST 2u

/* ── the event wire (ABI v7) ─────────────────────────────────────────── */
/*
 * A capability does not own SDL's event queue. `tension-core` initialises the
 * video subsystem, owns the window, and pumps the queue on the thread that did
 * so; a capability that wants events subscribes a *layer* and receives batches.
 *
 * Why this exists at all, in one paragraph. Before v7 the input capability ran
 * its own thread, called `SDL_Init` there, and polled the queue itself. Three
 * things were wrong with that: SDL requires the video subsystem to be used from
 * the thread that initialised it (illegal, and fatal on macOS); two pollers on
 * one queue split it nondeterministically — measured, 4000 pushed events came
 * out 2452/1548 on one run and 1796/2204 on the next, with none lost or
 * duplicated; and a second `SDL_Quit` on that thread tears the video subsystem
 * down under the host's own window (measured: the host's window then reports
 * 0x0 and every later call fails). One owner fixes all three, and the layer is
 * how a capability keeps seeing what it used to poll.
 *
 * Thread rule 13 governs `dispatch`. There is exactly one dispatcher, on one
 * thread, and the ordering is mechanical: the pump translates, then dispatches,
 * in the same call. A layer cannot miss a frame's events by being slow, because
 * it is called synchronously and the next pump cannot start until it returns.
 * The pump itself runs wherever the host has control — the host loop's own
 * iteration, or the start of a blocking `session::wait` — and a guest cannot
 * cause a dispatch from inside its own code.
 */

/* Event families. A layer's `event_mask` is a bitwise OR of these, and an
 * event carries exactly one in `family`. A layer that does not name a family
 * never sees its events — the filter is the host's, not the layer's, so a
 * layer cannot accidentally receive a family it did not ask for. */
#define TENSION_EVENT_QUIT 1u
#define TENSION_EVENT_WINDOW 2u
#define TENSION_EVENT_KEY 4u
#define TENSION_EVENT_TEXT 8u
#define TENSION_EVENT_MOUSE_MOTION 16u
#define TENSION_EVENT_MOUSE_BUTTON 32u
#define TENSION_EVENT_MOUSE_WHEEL 64u
#define TENSION_EVENT_PAD 128u

/* Every family this build defines; a mask outside this is -EINVAL. */
#define TENSION_EVENT_FAMILIES_KNOWN                                           \
    (TENSION_EVENT_QUIT | TENSION_EVENT_WINDOW | TENSION_EVENT_KEY |           \
     TENSION_EVENT_TEXT | TENSION_EVENT_MOUSE_MOTION |                         \
     TENSION_EVENT_MOUSE_BUTTON | TENSION_EVENT_MOUSE_WHEEL | TENSION_EVENT_PAD)

/*
 * `TENSION_EVENT_WINDOW`'s subtype, in `a0`. The payload follows the subtype:
 *
 *   RESIZED, PIXEL_SIZE_CHANGED   a1 = width, a2 = height (PIXEL_SIZE is
 *                                 drawable pixels; RESIZED is logical units)
 *   FOCUS_GAINED, FOCUS_LOST, MINIMIZED, RESTORED, ENTER_FULLSCREEN,
 *   LEAVE_FULLSCREEN, CLOSE_REQUESTED   no payload
 *
 * These are subtypes rather than families because they share one meaning for a
 * consumer — "something about the window changed" — and eight more mask bits
 * would push the mask past a byte for no gain.
 */
#define TENSION_WINDOW_EVENT_RESIZED 1u
#define TENSION_WINDOW_EVENT_PIXEL_SIZE_CHANGED 2u
#define TENSION_WINDOW_EVENT_FOCUS_GAINED 3u
#define TENSION_WINDOW_EVENT_FOCUS_LOST 4u
#define TENSION_WINDOW_EVENT_MINIMIZED 5u
#define TENSION_WINDOW_EVENT_RESTORED 6u
#define TENSION_WINDOW_EVENT_ENTER_FULLSCREEN 7u
#define TENSION_WINDOW_EVENT_LEAVE_FULLSCREEN 8u
#define TENSION_WINDOW_EVENT_CLOSE_REQUESTED 9u
/* Added in v7b, when the input capability stopped polling SDL for itself. Its
 * state record carries POINTER_OVER, and the nine subtypes above cannot say
 * it. Additive: no struct changed, nothing was renumbered. */
#define TENSION_WINDOW_EVENT_MOUSE_ENTER 10u
#define TENSION_WINDOW_EVENT_MOUSE_LEAVE 11u

/* `TENSION_EVENT_KEY`'s `flags` bits. `a0` = scancode, `a1` = keycode,
 * `a2` = the modifier state, `a3` = 1 when this is an auto-repeat. */
#define TENSION_KEY_FLAG_DOWN 1u
#define TENSION_KEY_FLAG_REPEAT 2u

/* `TENSION_EVENT_PAD`'s subtype, in `a0`. `a1` = the device's joystick instance
 * id, `a2` = button or axis index, `a3` = value (a button's 0/1, or an axis's
 * raw -32768..32767). Slots are the host's to assign, not the wire's: an
 * adapter that needs a stable slot number asks `pad_state`, and this event is
 * how it learns a pad appeared. */
#define TENSION_PAD_EVENT_ADDED 1u
#define TENSION_PAD_EVENT_REMOVED 2u
#define TENSION_PAD_EVENT_BUTTON_DOWN 3u
#define TENSION_PAD_EVENT_BUTTON_UP 4u
#define TENSION_PAD_EVENT_AXIS 5u

/*
 * One event (ABI v7). 40 bytes, 8-byte alignment.
 *
 * `family` is one `TENSION_EVENT_*` value and decides what the four payload
 * words mean — see the table above and the comment at each family's translation
 * site in `platform.rs`. `flags` is family-specific and is *not* a second
 * payload word: it holds the bits a consumer tests before decoding anything,
 * and it is where a family with no flags of its own puts its device id (the
 * mouse families: `which`, so a consumer can still tell a synthetic
 * position-derived motion from a real one — the rule the input capability
 * measured and depends on).
 *
 * Signed payloads are `int64_t` rather than a union so this stays one POD type
 * the host fills and the adapter reads, with no tag handling beyond `family`.
 */
typedef struct tension_event {
    uint32_t family;
    uint32_t flags;
    int64_t a0;
    int64_t a1;
    int64_t a2;
    int64_t a3;
} tension_event;

/**
 * One event subscription (ABI v7). See `register_event_layer`.
 *
 * `layer_user` — the argument both callbacks receive — is **the host's token
 * for this layer**, written to `out_layer_user` by `register_event_layer`. It is
 * how a layer names itself when it unregisters, and a layer that needs its own
 * per-instance state keeps it in its own module: this struct has no field for
 * it, and the two reserved words are what a future version would spend on one.
 *
 * `shutdown`, when present, is called **once**, when the host tears the
 * dispatcher down — not on `unregister_event_layer`, which is a layer leaving of
 * its own accord and therefore already past the point of needing a call.
 *
 * `dispatch` is required; `shutdown` may be NULL. A zeroed struct is refused
 * rather than read as "no mask, no callbacks".
 */
typedef struct tension_event_layer {
    uint32_t struct_size; /* sizeof(tension_event_layer) */
    uint32_t reserved;    /* 0 */
    uint32_t event_mask;  /* TENSION_EVENT_* bitmask */
    uint32_t reserved2;   /* 0 */
    /* Called on the main thread, once per pump, with a batch of the events
     * whose families this layer named. Return 0 to mark the batch consumed
     * (counted); anything else is logged once for this layer and never fails
     * the frame — a layer that misreports its own health must not stop the
     * window from pumping. */
    int32_t (*dispatch)(void *layer_user, const tension_event *events,
                        uint32_t count);
    /* Called once at teardown, on the main thread. May be NULL. */
    void (*shutdown)(void *layer_user);
} tension_event_layer;

/*
 * One gamepad slot (ABI v7). 48 bytes, 4-byte alignment.
 *
 * Moved here from `tension_input.h` when `pad_state` was appended: the record
 * used to be the input capability's private wire, which was right while input
 * owned SDL. Now the host owns the devices, so the record is the boundary's and
 * `tension_input.h` includes this header rather than restating the layout (its
 * `TENSION_INPUT_PAD_*` names stay as aliases its adapter already uses).
 *
 *   off  size  field
 *   ---  ----  ----------------------------------------------------------
 *    0     4   version (TENSION_PAD_RECORD_VERSION)
 *    4     4   flags — TENSION_PAD_RECORD_ATTACHED while a pad is there
 *    8     4   buttons (the gamepad button mask, bit n = button n)
 *   12     4   reserved
 *   16    24   axes[6] f32: left x/y, right x/y in [-1, 1]; triggers [0, 1]
 *   40     8   reserved (zero)
 */
typedef struct tension_pad_record {
    uint32_t version;
    uint32_t flags;
    uint32_t buttons;
    uint32_t reserved0;
    float axes[6];
    uint64_t reserved1;
} tension_pad_record;

#define TENSION_PAD_RECORD_SIZE 48u
#define TENSION_PAD_RECORD_VERSION 1u
#define TENSION_PAD_RECORD_ATTACHED 1u

/** How many gamepad slots the host serves. */
#define TENSION_PAD_SLOTS 8u


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

/*
 * The shader descriptor's codes (`shader_generate`, ABI version 4). Fixed
 * numbers, appended to only: they cross the boundary packed, so a renumbering
 * would silently reinterpret an old caller's layout. `PAD` exists so a
 * struct's tail padding can be named rather than guessed at.
 */
#define TENSION_SEM_POS_X    1u
#define TENSION_SEM_POS_Y    2u
#define TENSION_SEM_POS_Z    3u
#define TENSION_SEM_SRC_X    4u
#define TENSION_SEM_SRC_Y    5u
#define TENSION_SEM_SRC_W    6u
#define TENSION_SEM_SRC_H    7u
#define TENSION_SEM_UV_X     8u
#define TENSION_SEM_UV_Y     9u
#define TENSION_SEM_W       10u
#define TENSION_SEM_H       11u
#define TENSION_SEM_TINT    12u
#define TENSION_SEM_SORT_KEY 13u
#define TENSION_SEM_PAD     14u

#define TENSION_DTYPE_F32 1u
#define TENSION_DTYPE_U16 2u
#define TENSION_DTYPE_I16 3u
#define TENSION_DTYPE_U8  4u
/* Appended at 5 under the same append-only rule as the semantics above. The
 * sprite record carries signed pixel positions (`docs/modules/2d.md` §8), and none of 1..4
 * can express one: F32 would reinterpret the bits, and I16 caps a position at
 * 32767 px with a 1 px quantum. */
#define TENSION_DTYPE_I32 5u

/* The low byte of a field's `slot`; the high byte is the set index, which only
 * TexCoord uses today. */
#define TENSION_SLOT_POSITION 1u
#define TENSION_SLOT_TEXCOORD 2u
#define TENSION_SLOT_COLOR    3u
#define TENSION_SLOT_NORMAL   4u
#define TENSION_SLOT_TANGENT  5u
#define TENSION_SLOT_BINORMAL 6u

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
     * Look up a region's offset and size in the session's arena layout. A
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
     *
     * No longer the last slot: `shader_generate` was appended after it at ABI
     * version 4, and `compile_graph` after that at version 5, under the same
     * rule.
     */
    void (*signal_frame)(void *user);

    /*
     * Generate shader source for one vertex/instance layout, appended under
     * rule 11 at ABI version 4.
     *
     * The division of labour is the DWARF arc's, applied to shader text: the
     * language emits the description, the engine transports the request and
     * returns a string, and the engine never invents a layout it was not
     * given.
     *
     * `layout_ptr` points at the packed descriptor below naming the vertex
     * stream. `out` is the caller's buffer and `cap` its capacity in
     * bytes; the result is one NUL-terminated UTF-8 string. Returns that
     * string's length excluding the NUL on success, `-ENOSPC` when `cap` is
     * too small (nothing is written), `-ENOSYS` when the host has no
     * generator for that layout, and `-EINVAL` on a bad argument.
     *
     * A host may answer `-ENOSYS` for any layout it does not recognise: at
     * v1 the registered generator serves the nine built-in presets only, so a
     * guest-defined layout arrives here as `-ENOSYS` rather than as a guess.
     * Callers must treat that as "no shader from the host" and fall back,
     * not as a fatal error.
     *
     * Any-thread slot (rule 7): it reads the descriptor, writes the caller's
     * buffer, and never touches guest memory.
     *
     * The descriptor is packed, little-endian, and fixed-width — no C struct
     * and no pointers inside it, so it crosses the boundary the same way on
     * every ABI this project builds for:
     *
     *   u16 preset_id      one of the nine built-in presets; 0 = none
     *   u16 record_size    bytes per vertex/instance record
     *   u16 alignment      the record's alignment
     *   u16 field_count    entries in the array that follows
     *   u16 reserved[2]    must be 0
     *   field[field_count], 8 bytes each:
     *     u16 semantic     TENSION_SEM_* below
     *     u16 dtype        TENSION_DTYPE_*
     *     u16 offset       bytes from the record start
     *     u16 slot         low byte TENSION_SLOT_*, high byte the set index
     *     u16 step_rate    0 = per-vertex, n = per-instance every n steps
     *     u16 reserved     must be 0
     */
    int32_t (*shader_generate)(const void *layout_ptr, char *out, uint32_t cap);

    /*
     * Compile a pipeline graph to SPIR-V, appended under rule 11 at ABI
     * version 5.
     *
     * `blob` is a T2DG graph. The host parses it, validates it, lowers it to
     * GLSL through its shader generator, and compiles both stages to SPIR-V.
     * The result lands in the caller's two buffers.
     *
     * This is how a capability draws a pipeline its build never saw: the
     * capability owns the device, the host owns the compiler, and neither
     * carries a copy of the other's dependency. It is the same division as
     * `shader_generate` — the engine transports and returns, the language
     * decides — one step further along.
     *
     * Returns 0 on success with `*out_vs_len`/`*out_fs_len` set to the byte
     * counts written, or:
     *   -EINVAL   a malformed blob, or a graph that fails validation
     *   -ENOSYS   a well-formed graph this build cannot lower (unknown
     *             primitive, unsupported stage shape)
     *   -ENOSPC   either buffer is too small; nothing is written, and the
     *             required sizes are still reported in `*out_vs_len` and
     *             `*out_fs_len` so the caller can retry
     *
     * Any-thread slot (rule 7): it reads the blob, writes the caller's buffers,
     * and never touches guest memory.
     */
    int32_t (*compile_graph)(void *user, const uint8_t *blob, uint32_t blob_len,
                             uint8_t *vs_out, uint32_t vs_cap, uint8_t *fs_out,
                             uint32_t fs_cap, uint32_t *out_vs_len,
                             uint32_t *out_fs_len);

    /*
     * Ask the host to change the window, appended under rule 11 at ABI
     * version 6.
     *
     * This is the only write channel a capability has for window state. It
     * copies the message and returns; the change happens later, on the
     * window's own thread, when the host drains its queue. So the answer is
     * "queued", never "applied" — a caller that needs to know the result
     * polls `host_surface`, and a caller that needs to know it *now* has the
     * wrong model.
     *
     * Any thread (rule 7): it reads a caller-supplied struct, copies it, and
     * never touches guest memory.
     *
     * Returns 0 when queued, or:
     *   -EINVAL  `msg` is null, `kind` is not a value this build knows, or
     *            `reserved` is non-zero
     *   -ENOSPC  the queue region for this source is full. Synchronous, and
     *            the same contract as a full pending queue: the caller learns
     *            immediately that its message did not land. Nothing is
     *            silently dropped or coalesced.
     *   -ENOSYS  this build has no executor (a control channel that would
     *            discard the message answers "not available", never 0)
     *
     * `msg->source` is ignored on input and stamped before the message is
     * queued. See `tension_ctrl_msg`.
     */
    int32_t (*post_control)(void *user, const tension_ctrl_msg *msg);

    /*
     * The host's window surface, appended under rule 11 at ABI version 6.
     *
     * A renderer cannot create its own window in this architecture, so the
     * handles it needs to render into the host's are handed over here. Both are
     * **borrowed**: the host created them and the host destroys them. An
     * adapter builds a swapchain on `surface` and must never call
     * `vkDestroySurfaceKHR` on it, nor `vkDestroyInstance` on `instance`.
     *
     * The handles are plain `uint64_t` rather than Vulkan types so that this
     * header still knows nothing about Vulkan: an adapter that does not use it
     * need not include a Vulkan header at all.
     *
     * Returns 0 and fills `out`, or -ENOSYS when the host owns no surface —
     * no `--window`, or a window without a Vulkan one. -ENOSYS is the expected
     * answer on a headless run, not a failure.
     *
     * Any thread (rule 7): it reads the host's own state, never guest memory.
     * A render thread may call it once per frame to learn the current size.
     */
    int32_t (*host_surface)(void *user, tension_host_surface *out);

    /*
     * One of the Vulkan instance extensions the host enabled, appended under
     * rule 11 at ABI version 6 (slot 22).
     *
     * `host_surface` gives a renderer the host's `VkInstance`; it cannot give
     * the extensions that instance was created with, because that list is not
     * recoverable from the handle. Ogre-Next needs it: its external-instance
     * path filters the caller's claims against what the loader reports as
     * *available* and then uses the caller's list as the truth about what is
     * enabled (`OgreVulkanDevice.cpp`, the `else  // externalInstance` branch).
     * Enumerating from here would answer the wrong question — available is not
     * enabled — so the host, which created the instance, reports its own
     * record.
     *
     * `index` counts from 0. Returns
     *   0        `out_name` holds the name, NUL-terminated, and `*out_len` its
     *            length excluding the NUL
     *   -ENOENT  `index` is past the last extension; this is how a caller
     *            enumerates, and it is not an error
     *   -EINVAL  a null argument, or `capacity` below
     *            TENSION_EXTENSION_NAME_CAPACITY (the ABI's floor, 256 — every
     *            Vulkan extension name fits, and a smaller buffer would
     *            truncate a name that is then silently wrong)
     *   -ENOSYS  the host owns no surface, so it has no instance to describe
     *
     * The list is fixed for the life of the instance: it is what was passed to
     * `vkCreateInstance` before any adapter loaded.
     *
     * Any thread (rule 7): it reads the host's own state, never guest memory.
     */
    int32_t (*host_surface_extension)(void *user, uint32_t index, char *out_name,
                                      uint32_t capacity, uint32_t *out_len);

    /*
     * Subscribe a layer to the host's input events (ABI v7, slot 23).
     *
     * The host owns the video subsystem and the window, and pumps their queue
     * on the thread that initialised them. A capability that wants to see what
     * happens there registers a layer instead of initialising SDL itself. What
     * changed and why is in the header's event-wire block above; the contract
     * here is the shape.
     *
     * `layer->dispatch` is called on the main thread, synchronously, once per
     * pump, with the contiguous batch of events whose families the layer's
     * `event_mask` names (thread rule 13). Registration may happen from any
     * thread that is not inside a dispatch — in practice `link`, which runs on
     * the interpreter thread before any event exists.
     *
     * `*out_layer_user` receives the host's token for this layer: non-NULL,
     * stable until it is unregistered, and the value both callbacks and
     * `unregister_event_layer` use. Rule 2 applies — 0 is never a valid token.
     *
     * Returns
     *   0        registered, `*out_layer_user` written
     *   -EINVAL  a null argument, a `struct_size` below
     *            `sizeof(tension_event_layer)`, a non-zero reserved word, a NULL
     *            `dispatch`, or a mask with a family this build does not define
     *   -ENOSPC  no free layer slot (TENSION_MAX_EVENT_LAYERS are served)
     *   -EBUSY   called from inside a `dispatch`
     *
     * The layer is *not* called before this returns 0, and a host that has no
     * window simply never pumps: registering costs nothing and a layer that
     * wants to know whether a window exists asks `host_window_info`.
     */
    int32_t (*register_event_layer)(void *user,
                                    const tension_event_layer *layer,
                                    void **out_layer_user);

    /*
     * Remove a layer (ABI v7, slot 24).
     *
     * `layer_user` is the token `register_event_layer` wrote. The layer's
     * `shutdown` is **not** called: unregistering is a capability leaving of
     * its own accord, and it knows it did. `shutdown` exists for the case the
     * capability cannot know — the host tearing the dispatcher down — and it is
     * called exactly once, for every layer still registered at that moment.
     *
     * Any thread that is not inside a dispatch: in practice `init`'s failure
     * path or `shutdown`, which is where a capability tears its own layer down
     * before it stops existing.
     *
     * Returns 0, or -EINVAL for an unknown token, or -EBUSY from inside a
     * dispatch. Registration may follow a removal: the slot a removed layer
     * held is reusable, and the freed token is never handed out again.
     */
    int32_t (*unregister_event_layer)(void *user, void *layer_user);

    /*
     * The host's window state (ABI v7, slot 25).
     *
     * `tension_window_info`, the same record the guest reads through
     * `tension::platform.window_info`, written into the caller's buffer as far
     * as `out->struct_size` allows. This is how a capability that used to own a
     * window learns whether the host has one and how big it is, without a
     * handle to it: the input capability needs exactly this to answer a
     * `state` record's ATTACHED and FOCUSED bits honestly.
     *
     * The values are the pump's snapshot, i.e. as of the last frame the host
     * pumped. A layer reading this from inside its own `dispatch` therefore sees
     * the state the batch it is holding belongs to.
     *
     * Any thread (rule 7): it reads the host's published record, never guest
     * memory, and it never calls SDL.
     *
     * Returns
     *   0        written; a run with no window writes a zeroed record (the
     *            guest-side convention — `width == 0` is "no window")
     *   -EINVAL  a null `out`, or a `struct_size` below the record's
     *   -ENOSYS  this build has no window plumbing at all (a host built without
     *            the platform module)
     */
    int32_t (*host_window_info)(void *user, tension_window_info *out);

    /*
     * One gamepad slot's state (ABI v7, slot 26).
     *
     * Records the host's mirror as of the last pump. `-ENODEV` when the slot has
     * no pad — which is the answer for every slot on a machine with none, and a
     * state rather than an error, exactly as `input_pad` documents it. `slot`
     * counts from 0 to TENSION_PAD_SLOTS-1; anything else is -EINVAL.
     *
     * **A mirror, not a live read.** The host opens each pad once, on the
     * thread that initialised SDL, and samples every live slot at the end of
     * each pump; this slot copies the sample out. That is what makes it
     * honestly any-thread: SDL's gamepad getters are not thread-safe, and a
     * direct read from an arbitrary thread would be the same class of mistake
     * that two event pollers were. A caller that wants every sample rather than
     * the state subscribes to `TENSION_EVENT_PAD`.
     *
     * Any thread (rule 7): it reads the host's own mirror.
     */
    int32_t (*pad_state)(void *user, uint32_t slot, tension_pad_record *out);

} tension_core_api;

/* The most event layers one host serves; `register_event_layer`'s -ENOSPC. */
#define TENSION_MAX_EVENT_LAYERS 8u

/* The most events one pump translates into a dispatch batch. A drain that
 * produces more drops the excess and counts it (rule 13, overflow contract). */
#define TENSION_EVENT_BATCH_CAPACITY 256u

/* The smallest `capacity` `host_surface_extension` accepts; see that slot. */
#define TENSION_EXTENSION_NAME_CAPACITY 256u

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
 * On the import-type refusals behind C3 (see `docs/modules/ogre.md` §4): all
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
 * Twelve kinds, `kind == index`: the session writes the
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
static_assert(offsetof(tension_core_api, pad_state)
                      + sizeof(((tension_core_api *)0)->pad_state)
                  == sizeof(tension_core_api),
              "tension_core_api: pad_state must stay the last "
              "slot; an append updates this assertion and the Rust table "
              "together");
static_assert(sizeof(tension_core_api)
                  == offsetof(tension_core_api, user) + 26 * sizeof(void *),
              "tension_core_api: expected 26 pointer-sized slots after "
              "abi_version; update this count, the Rust TensionCoreApi, and its "
              "size assertion together");
#elif defined(__STDC_VERSION__) && (__STDC_VERSION__ >= 201112L)
_Static_assert(offsetof(tension_core_api, pad_state)
                       + sizeof(((tension_core_api *)0)->pad_state)
                   == sizeof(tension_core_api),
               "tension_core_api: pad_state must stay the last "
               "slot; an append updates this assertion and the Rust table "
               "together");
_Static_assert(sizeof(tension_core_api)
                   == offsetof(tension_core_api, user) + 26 * sizeof(void *),
               "tension_core_api: expected 26 pointer-sized slots after "
               "abi_version; update this count, the Rust TensionCoreApi, and its "
               "size assertion together");
#endif

/*
 * The v7 event wire's shape. Asserted from both languages because the two
 * sides decode the same bytes: a field reordered on one side is a silently
 * misinterpreted payload on the other, and these are cheap.
 *
 * `tension_event` is 40 bytes because four `int64_t` payload words follow two
 * `uint32_t`s; `a0` therefore starts at 8, which is also the struct's alignment.
 */
#if defined(__cplusplus)
static_assert(sizeof(tension_event) == 40, "tension_event is 40 bytes");
static_assert(offsetof(tension_event, a0) == 8, "tension_event: a0 at 8");
static_assert(sizeof(tension_event_layer) == 32,
              "tension_event_layer: four u32 then two pointers");
static_assert(offsetof(tension_event_layer, dispatch) == 16,
              "tension_event_layer: dispatch after the four u32");
static_assert(sizeof(tension_pad_record) == TENSION_PAD_RECORD_SIZE,
              "tension_pad_record must be the size the wire declares");
#elif defined(__STDC_VERSION__) && (__STDC_VERSION__ >= 201112L)
_Static_assert(sizeof(tension_event) == 40, "tension_event is 40 bytes");
_Static_assert(offsetof(tension_event, a0) == 8, "tension_event: a0 at 8");
_Static_assert(sizeof(tension_event_layer) == 32,
               "tension_event_layer: four u32 then two pointers");
_Static_assert(offsetof(tension_event_layer, dispatch) == 16,
               "tension_event_layer: dispatch after the four u32");
_Static_assert(sizeof(tension_pad_record) == TENSION_PAD_RECORD_SIZE,
               "tension_pad_record must be the size the wire declares");
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
 * The ABI is alpha; `TENSION_ADAPTER_ABI_VERSION` is the shape it carries
 * today. Additive fields are appended; the version check in `init` is mandatory
 * rather than advisory, and it is what refuses a version-1 adapter before its
 * shorter vtable is read as if it were longer.
 */

#ifdef __cplusplus
} /* extern "C" */
#endif

#endif /* TENSION_ADAPTER_H */
