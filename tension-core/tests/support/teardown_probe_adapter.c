/*
 * The teardown probe: a capability that records its own disposal.
 *
 * C3's fault-injection fixture. `shutdown` and `destroy` each append one line
 * — "shutdown" / "destroy" — to the file named by `$TENSION_TEARDOWN_LOG`, so a
 * test can prove the host called the vtable's teardown slots, in order, exactly
 * once, even when the guest trapped (`tension-core/tests/adapter_teardown.rs`).
 *
 * It registers no imports and borrowed no service, so the only thing it does
 * that is observable is being torn down. It is a separate DSO from
 * `echo_adapter.c` on purpose: the echo adapter is the ABI's reference and
 * other tests read its behaviour; this one exists only to be disposed of.
 *
 * SPDX-License-Identifier: MIT
 */
#include <stdint.h>
#include <stdio.h>
#include <stdlib.h>

#include "tension_adapter.h"

/* Append one word to the log named by the environment. Nothing else: a failure
 * to write is swallowed, because a probe that crashed the host while measuring
 * the host's teardown would be measuring itself. */
static void record(const char *what)
{
    const char *path = getenv("TENSION_TEARDOWN_LOG");
    FILE *f;
    if (path == NULL) {
        return;
    }
    f = fopen(path, "a");
    if (f == NULL) {
        return;
    }
    fputs(what, f);
    fputc('\n', f);
    fclose(f);
}

static int32_t probe_init(void *ctx, const tension_core_api *core)
{
    (void)ctx;
    (void)core;
    return 0;
}

static int32_t probe_link(void *ctx, const tension_core_api *core)
{
    (void)ctx;
    (void)core;
    return 0;
}

static int32_t probe_shutdown(void *ctx)
{
    (void)ctx;
    record("shutdown");
    return 0;
}

static void probe_destroy(void *ctx)
{
    (void)ctx;
    record("destroy");
}

static const tension_adapter PROBE_ADAPTER = {
    .abi_version = TENSION_ADAPTER_ABI_VERSION,
    .name = "teardown_probe",
    .flags = 0,
    .init = probe_init,
    .link = probe_link,
    .publish = NULL,
    .apply = NULL,
    .shutdown = probe_shutdown,
    .destroy = probe_destroy,
    .layout_hash = TENSION_ADAPTER_LAYOUT_HASH,
};

const tension_adapter *tension_adapter_v1(void)
{
    return &PROBE_ADAPTER;
}
