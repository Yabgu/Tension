/*
 * The reference capability adapter.
 *
 * It exists to prove the ABI in `tension-core/include/tension_adapter.h` end to
 * end, and to be the smallest honest example for the next capability author. It
 * needs nothing from the host executable: every service arrives through the
 * `tension_core_api` table, which is what makes `dlopen` safe with no
 * `-rdynamic`.
 *
 * Two imports, both under "echo":
 *
 *   echo::add(i32, i32) -> i32          arithmetic: argument passing and return
 *   echo::roundtrip(i32 ptr, i32 len)   guest memory: guest_write then
 *                                       guest_read, returning how many bytes
 *                                       survived
 *
 * `note_deferred` is the DEFERRABLE verb: called from a callback, the session
 * copies its arguments and calls `apply` in a later epoch instead — the
 * reference implementation of the deferred path, and what the epoch fixtures
 * read back. `publish` writes one sentinel byte into the guest's heap — the reference
 * implementation of the hook the epoch calls before it invokes anything, and
 * what the publish-before-invoke test reads back. `apply` stays NULL (the
 * deferrable-verb half is A2c's), which keeps the NULL-slot precedent visible:
 * NULL means "nothing to do".
 *
 * Built twice by `tension-core/build.rs` from this one file: once as the
 * reference adapter, once with `-DECHO_BAD_ABI_VERSION=1` so the loader's
 * version refusal is proven without a second source file.
 *
 * SPDX-License-Identifier: MIT
 */
#include <stdint.h>

#include "tension_adapter.h"

#if defined(ECHO_BAD_ABI_VERSION)
#define ECHO_ABI_VERSION 2u
#else
#define ECHO_ABI_VERSION TENSION_ADAPTER_ABI_VERSION
#endif

/*
 * The core API table, kept from init. The vtable has no context accessor — the
 * core calls every slot with ctx == NULL — so statics are where an adapter like
 * this one keeps the services it was handed. A larger adapter would hang its own
 * state off its import contexts instead, which is what `ctx` is for.
 */
static const tension_core_api *g_core;
static uint32_t g_source;

static const char MSG_INIT[] = "echo: init";
static const char MSG_LINKED[] = "echo: two imports registered";
static const char MSG_JOB_FOUND[] = "echo: the JOB region answered at link time";
static const char MSG_JOB_MISSING[] = "echo: the JOB region did not answer";
static const char MSG_PUBLISHED[] = "echo: publish wrote its sentinel";
static const char MSG_PUBLISH_SMALL[] = "echo: publish skipped (the guest has no heap)";
static const char MSG_APPLIED[] = "echo: applied a deferred note";
static const char MSG_APPLY_REFUSED[] = "echo: refused a deferred note (-EINVAL)";

/* Log through the core, without the NUL: `log` takes an explicit length. */
static void say(const char *text, uint32_t len)
{
    if (g_core != NULL && g_core->log != NULL) {
        g_core->log(g_core->user, 1, text, len);
    }
}

/* echo::add(a, b) -> a + b */
static int32_t echo_add(void *ctx, const tension_value *args, uint32_t nargs,
                        tension_value *ret)
{
    (void)ctx;
    if (nargs != 2 || args == NULL || ret == NULL) {
        return -22; /* EINVAL */
    }
    ret->i32 = args[0].i32 + args[1].i32;
    return 0;
}

/*
 * echo::roundtrip(ptr, len) -> bytes that survived
 *
 * Writes a deterministic pattern into the guest's buffer through `guest_write`,
 * reads it back through `guest_read`, and counts the bytes that match. Both
 * directions of the FFI's memory path are exercised, and the answer is checked
 * by the caller rather than trusted.
 */
static int32_t echo_roundtrip(void *ctx, const tension_value *args, uint32_t nargs,
                              tension_value *ret)
{
    uint8_t pattern[256];
    uint8_t back[256];
    uint32_t ptr;
    uint32_t len;
    uint32_t matching = 0;
    uint32_t i;
    int32_t status;

    (void)ctx;
    if (nargs != 2 || args == NULL || ret == NULL) {
        return -22; /* EINVAL */
    }
    ptr = (uint32_t)args[0].i32;
    len = (uint32_t)args[1].i32;
    if (len > sizeof(pattern)) {
        return -22;
    }
    if (g_core == NULL || g_core->guest_write == NULL || g_core->guest_read == NULL) {
        return -38; /* ENOSYS */
    }

    for (i = 0; i < len; i++) {
        pattern[i] = (uint8_t)(i * 7u + 3u);
    }
    status = g_core->guest_write(g_core->user, ptr, pattern, len);
    if (status != 0) {
        return status;
    }
    status = g_core->guest_read(g_core->user, ptr, back, len);
    if (status != 0) {
        return status;
    }
    for (i = 0; i < len; i++) {
        if (back[i] == pattern[i]) {
            matching++;
        }
    }
    ret->i32 = (int32_t)matching;
    return 0;
}

/* The addresses the deferred verbs agree with their fixtures about. Both are in
 * the guest's own heap (above `max_arena_size`), which is where an adapter's
 * writes belong; a guest with no heap gets a skip rather than a fault. */
#define ECHO_DIRECT_ADDR 8389600u /* direct note_deferred: the args' low bytes */
#define ECHO_NOTE_ADDR 8389632u   /* applied submissions: 1 byte at + slot */

/* The verb id `note_deferred` registers with, which is what its `apply` switches
 * on. Ids are the adapter's own (`tension_adapter.h` A.5). */
#define ECHO_VERB_NOTE_DEFERRED 3u

/* echo::note_deferred(slot, value) -> i32 — the DEFERRABLE import.
 *
 * Called directly (at depth 0) it writes the two arguments' low bytes to
 * ECHO_DIRECT_ADDR. Called from a callback it is *not* called at all: the
 * session copies the arguments and calls `echo_apply` in a later epoch, which
 * writes one byte per applied submission at ECHO_NOTE_ADDR + slot. A fixture can
 * therefore tell the two paths apart by looking at the two addresses.
 */
static int32_t echo_note_deferred(void *ctx, const tension_value *args, uint32_t nargs,
                                  tension_value *ret)
{
    uint8_t lows[2];

    (void)ctx;
    if (nargs != 2 || args == NULL || ret == NULL) {
        return -22; /* EINVAL */
    }
    if (g_core == NULL || g_core->guest_write == NULL || g_core->guest_size == NULL) {
        return -38; /* ENOSYS */
    }
    if (g_core->guest_size(g_core->user) <= ECHO_DIRECT_ADDR + 2u) {
        return 0; /* the guest has no heap: there is nowhere to write */
    }
    lows[0] = (uint8_t)(args[0].i32 & 0xFF);
    lows[1] = (uint8_t)(args[1].i32 & 0xFF);
    if (g_core->guest_write(g_core->user, ECHO_DIRECT_ADDR, lows, (uint32_t)sizeof lows) != 0) {
        return -5; /* EIO */
    }
    ret->i32 = 0;
    return 0;
}

/*
 * echo's `apply` hook: the deferred half of `note_deferred`.
 *
 * The session calls this once per queued submission, with the arguments it
 * copied — the same `tension_value` array the import was handed, so this reads
 * them with the same code. A negative slot asks for a refusal (-EINVAL), which
 * is how the rejection fixture makes an apply fail on purpose; everything else
 * writes one byte at ECHO_NOTE_ADDR + slot and reports success.
 */
static int32_t echo_apply(void *ctx, uint32_t verb_id, const void *bytes, uint32_t len)
{
    const tension_value *args = (const tension_value *)bytes;
    uint8_t one = 1;
    uint32_t at;
    int32_t slot;

    (void)ctx;
    if (verb_id != ECHO_VERB_NOTE_DEFERRED) {
        return -38; /* ENOSYS: not a verb this adapter defers */
    }
    if (args == NULL || len < 2u * 8u) {
        return -22; /* EINVAL: not the two slots the verb declares */
    }
    slot = args[0].i32;
    if (slot < 0) {
        say(MSG_APPLY_REFUSED, (uint32_t)(sizeof(MSG_APPLY_REFUSED) - 1));
        return -22;
    }
    if (g_core == NULL || g_core->guest_write == NULL || g_core->guest_size == NULL) {
        return -38;
    }
    at = ECHO_NOTE_ADDR + (uint32_t)slot;
    if (g_core->guest_size(g_core->user) <= at) {
        return 0;
    }
    if (g_core->guest_write(g_core->user, at, &one, 1) != 0) {
        return -5;
    }
    say(MSG_APPLIED, (uint32_t)(sizeof(MSG_APPLIED) - 1));
    return 0;
}

static int32_t echo_init(void *ctx, const tension_core_api *core)
{
    (void)ctx;
    if (core == NULL || core->abi_version != TENSION_ADAPTER_ABI_VERSION) {
        return -22;
    }
    g_core = core;
    say(MSG_INIT, (uint32_t)(sizeof(MSG_INIT) - 1));
    return 0;
}

static int32_t echo_link(void *ctx, const tension_core_api *core)
{
    static const uint32_t add_params[2] = { TENSION_VT_I32, TENSION_VT_I32 };
    static const uint32_t roundtrip_params[2] = { TENSION_VT_I32, TENSION_VT_I32 };
    static const uint32_t note_params[2] = { TENSION_VT_I32, TENSION_VT_I32 };
    uint32_t offset = 0;
    uint32_t size = 0;

    if (core == NULL) {
        return -22;
    }
    g_core = core;
    if (core->register_source == NULL || core->register_import == NULL) {
        return -38;
    }
    if (core->register_source(core->user, "echo", 0, &g_source) != 0) {
        return -1;
    }
    if (core->register_import(core->user, "echo", "add", TENSION_VT_I32, add_params, 2,
                              echo_add, ctx, 1, 0) != 0) {
        return -1;
    }
    if (core->register_import(core->user, "echo", "roundtrip", TENSION_VT_I32,
                              roundtrip_params, 2, echo_roundtrip, ctx, 2, 0) != 0) {
        return -1;
    }
    /*
     * The deferred verb: TENSION_IMPORT_DEFERRABLE says a callback may call it,
     * and that the session copies the arguments instead of calling it there.
     * `add` above keeps flags 0 — neither deferrable nor re-entrant — which is
     * what makes it the verb a callback must not call.
     */
    if (core->register_import(core->user, "echo", "note_deferred", TENSION_VT_I32,
                              note_params, 2, echo_note_deferred, ctx,
                              ECHO_VERB_NOTE_DEFERRED, TENSION_IMPORT_DEFERRABLE) != 0) {
        return -1;
    }

    /*
     * The pre-open region query. The layout is a compile-time constant, so this
     * answers before any session exists — which is the whole reason
     * `region_lookup` is allowed at link time. The answer is logged, not used,
     * and the act of asking is what declares the region as required.
     */
    if (core->region_lookup != NULL &&
        core->region_lookup(core->user, TENSION_REGION_JOB, &offset, &size) == 0) {
        say(MSG_JOB_FOUND, (uint32_t)(sizeof(MSG_JOB_FOUND) - 1));
    } else {
        say(MSG_JOB_MISSING, (uint32_t)(sizeof(MSG_JOB_MISSING) - 1));
    }
    say(MSG_LINKED, (uint32_t)(sizeof(MSG_LINKED) - 1));
    return 0;
}

/*
 * Where the publish hook's sentinel goes. A fixed address the test that proves
 * publish-before-invoke agrees on; it is in the guest's own heap (above
 * `max_arena_size`), and the hook skips the write when the guest's memory is too
 * small — a guest that declares exactly `memoryBase` has no heap, and a publish
 * hook must not fault because of it.
 */
#define ECHO_SENTINEL_ADDR 8389888u
#define ECHO_SENTINEL_BYTE 0x5Au

/* echo::publish — the hook the epoch calls before it invokes anything. */
static int32_t echo_publish(void *ctx, const tension_core_api *core)
{
    uint8_t sentinel = ECHO_SENTINEL_BYTE;

    (void)ctx;
    if (core == NULL || core->guest_write == NULL || core->guest_size == NULL) {
        return -38; /* ENOSYS */
    }
    if (core->guest_size(core->user) <= ECHO_SENTINEL_ADDR) {
        say(MSG_PUBLISH_SMALL, (uint32_t)(sizeof(MSG_PUBLISH_SMALL) - 1));
        return 0;
    }
    if (core->guest_write(core->user, ECHO_SENTINEL_ADDR, &sentinel, 1) != 0) {
        return -5; /* EIO: the write was refused mid-publish */
    }
    say(MSG_PUBLISHED, (uint32_t)(sizeof(MSG_PUBLISHED) - 1));
    return 0;
}

static int32_t echo_shutdown(void *ctx)
{
    (void)ctx;
    g_core = NULL;
    return 0;
}

static void echo_destroy(void *ctx)
{
    (void)ctx;
}

static const tension_adapter ECHO_ADAPTER = {
    .abi_version = ECHO_ABI_VERSION,
    .name = "echo",
    .flags = 0,
    .init = echo_init,
    .link = echo_link,
    .publish = echo_publish,
    .apply = echo_apply,
    .shutdown = echo_shutdown,
    .destroy = echo_destroy,
};

const tension_adapter *tension_adapter_v1(void)
{
    return &ECHO_ADAPTER;
}
