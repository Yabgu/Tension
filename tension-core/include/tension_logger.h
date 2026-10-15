/*
 * tension_logger — the host logging ABI.
 *
 * The Rust host owns one logger: its level, filter, layout, sink, and
 * configuration. These two functions are how native code that links the host
 * directly hands it a record. The layout is applied in the host, so a line
 * written from C, from Rust, or from the wasm guest is byte-identical for the
 * same (level, logger name, message).
 *
 * Who calls these:
 *   - a tool or test harness linked against libtension_core (the C harness in
 *     tension-core/tests/support/log_harness.c is the reference caller);
 *   - the statically linked Zig resource core, if it ever needs to log.
 *
 * A capability adapter does NOT call these. `tension_adapter.h` rule 8 forbids
 * an adapter from requiring a symbol in the host executable (that is what makes
 * dlopen safe with no -rdynamic), so an adapter logs through
 * `tension_core_api.log_named` / `.log_structured` instead. Those slots forward
 * to the same logger these functions do.
 *
 * Rules:
 *   1. Panic-free. A failure is a dropped line, never a crash and never an
 *      unwinding panic across this boundary.
 *   2. Callable from any thread. The host serialises the write.
 *   3. `logger_name` is NUL-terminated and has no length; `message` and
 *      `json_payload` are byte slices of the given length and need not be
 *      NUL-terminated. Invalid UTF-8 is replaced, not refused — a log call
 *      never fails.
 *   4. The logger is configured at startup from the command line. If the host
 *      did not install one, a line at INFO or above still reaches stderr
 *      through a fallback, so these symbols are useful to a caller with no
 *      interpreter around it.
 *
 * SPDX-License-Identifier: MIT
 */
#ifndef TENSION_LOGGER_H
#define TENSION_LOGGER_H

#include <stddef.h>
#include <stdint.h>

#ifdef __cplusplus
extern "C" {
#endif

/*
 * Severity, least severe first. The discriminants are frozen: a seventh level is
 * they are the level the host's `Level` enum uses and the level the guest's
 * AssemblyScript `Level` uses.
 */
typedef enum tension_log_level {
    TENSION_LOG_TRACE = 0,
    TENSION_LOG_DEBUG = 1,
    TENSION_LOG_INFO  = 2,
    TENSION_LOG_WARN  = 3,
    TENSION_LOG_ERROR = 4,
    TENSION_LOG_FATAL = 5
} tension_log_level_t;

/*
 * Emit one record. `message` carries `message_len` bytes.
 *
 * The host timestamps it, applies its configured layout (text or JSON), and
 * writes it to its configured sink (stderr by default).
 */
void tension_log(tension_log_level_t level, const char *logger_name,
                 const char *message, size_t message_len);

/*
 * Emit one record with a structured payload. `json_payload` carries
 * `payload_len` bytes and is expected to be a JSON object or array; the JSON
 * layout splices a payload that names such a container and quotes any other
 * text as a string, so the line stays parseable.
 *
 * There is no message: a structured record is its payload.
 */
void tension_log_structured(tension_log_level_t level, const char *logger_name,
                            const char *json_payload, size_t payload_len);

#ifdef __cplusplus
} /* extern "C" */
#endif

#endif /* TENSION_LOGGER_H */
