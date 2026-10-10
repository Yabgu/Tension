/*
 * The C half of the logging ABI's smoke test.
 *
 * This object is compiled by `tension-core/build.rs` and linked into the
 * `log_ffi` integration test. It calls the two `#[no_mangle]` symbols the host
 * exports — `tension_log` and `tension_log_structured` — the way a native
 * consumer that links libtension_core would. That the test binary links at all
 * is half the proof: the symbols are real and resolvable from C.
 *
 * SPDX-License-Identifier: MIT
 */
#include "tension_logger.h"

#include <string.h>

/* One record per level, plus a structured one, so the host's filter and layout
 * are exercised across the range. The return status lets a caller assert the
 * ABI was callable at all. */
int log_harness_emit(void) {
    const char *info = "hello from C";
    const char *debug = "a debug line";
    const char *error = "an error";
    const char *payload = "{\"payload\":true}";

    tension_log(TENSION_LOG_INFO, "harness", info, strlen(info));
    tension_log(TENSION_LOG_DEBUG, "harness", debug, strlen(debug));
    tension_log(TENSION_LOG_ERROR, "harness", error, strlen(error));
    tension_log_structured(TENSION_LOG_WARN, "harness", payload, strlen(payload));
    return 0;
}

/* Hostile input: null pointers and a level code outside the enum. Neither call
 * may crash, and neither may unwind. */
int log_harness_emit_null(void) {
    tension_log(TENSION_LOG_INFO, (const char *)0, (const char *)0, 0);
    tension_log_structured(TENSION_LOG_FATAL, (const char *)0, (const char *)0, 0);
    return 0;
}
