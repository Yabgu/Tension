/*
 * tension_res — the ECMA-208 (SIDF) resource container, C ABI.
 *
 * The reader/writer/VFS live in Zig (tension-res/); this header is the only
 * surface Rust links against. It is deliberately small: one opaque handle,
 * one 12-byte record, and the POSIX-shaped calls a virtual filesystem needs.
 *
 * Memory model (DESIGN.md §9.2):
 *   tension_res_load(...)          copies the blob into the handle; the caller
 *                                  may free its buffer immediately.
 *   tension_res_load_borrowed(...) borrows the caller's bytes; they must stay
 *                                  alive and unchanged until tension_res_free.
 *   The Rust wrapper (tension-core/src/res/mod.rs) enforces the borrowed
 *   lifetime with a lifetime parameter and field drop order — not by
 *   convention.
 *
 * Conventions:
 *   - paths are UTF-8 (ptr, len); no NUL terminator is read, and path_len must
 *     be at most TENSION_RES_PATH_MAX (1 MiB) — longer input is -EINVAL.
 *   - every entry point is panic-free: any failure comes back as a negative
 *     errno value. 0 means success for the calls that report a status.
 *   - handles are 1-based; 0 is never a valid fd.
 *   - `const tension_res *` marks the caller's intent, not our state: the
 *     handle owns the fd table and the readdir cursor, which the fd calls
 *     mutate.
 *
 * Error codes (values are negated POSIX errno numbers):
 *   -2  ENOENT   missing path, no pak loaded, directory without a child index
 *   -5  EIO      input ends inside a structure, unsupported payload codec
 *   -9  EBADF    closed, out of range, or never-allocated fd
 *   -12 ENOMEM   allocation failure (load only)
 *   -20 ENOTDIR  file in a path position, readdir on a file
 *   -21 EISDIR   open on a directory
 *   -22 EINVAL   malformed path or structure, bad argument, bad whence
 *   -24 EMFILE   fd table full
 *   -38 ENOSYS   not implemented in this build (tension_res_pack, phase 7)
 *
 * SPDX-License-Identifier: MIT
 */
#ifndef TENSION_RES_H
#define TENSION_RES_H

#include <stddef.h>
#include <stdint.h>

#ifdef __cplusplus
extern "C" {
#endif

/** The largest path accepted at the boundary (see the header comment). */
#define TENSION_RES_PATH_MAX ((size_t)(1024 * 1024))

/** Opaque handle: one loaded pak plus its fd table and readdir cursor. */
typedef struct tension_res tension_res;

/** What `stat` reports (DESIGN.md §7.4): 12 bytes, little-endian. */
typedef struct tension_res_stat {
    uint32_t kind;  /* 0 = file, 1 = directory */
    uint32_t size;  /* payload bytes for a file, 0 for a directory */
    uint32_t flags; /* bit 0 = compressed payload; bits 1-31 reserved, zero */
} tension_res_stat;

/**
 * Load a pak by copying it into the handle. On success returns 0 and stores a
 * non-NULL handle in *out; on failure returns a negative errno, stores NULL in
 * *out, and (when `err` is non-NULL and `errcap > 0`) writes a NUL-terminated
 * reason truncated to `errcap` bytes.
 */
int32_t tension_res_load(const uint8_t *bytes, size_t len, tension_res **out,
                         char *err, size_t errcap);

/** As tension_res_load, but borrows `bytes` instead of copying (§9.2). */
int32_t tension_res_load_borrowed(const uint8_t *bytes, size_t len,
                                  tension_res **out, char *err, size_t errcap);

/** Release a handle (and, for an owned load, the copied blob). NULL is a no-op. */
void tension_res_free(tension_res *res);

/** Open a file: returns a handle >= 1, or a negative errno. */
int32_t tension_res_open(const tension_res *res, const char *path, size_t path_len);

/** Read up to `len` bytes: bytes read (0 at end of file), or negative errno. */
int32_t tension_res_read(const tension_res *res, int32_t fd, uint8_t *dst, size_t len);

/** Seek: whence is 0 = SET, 1 = CUR, 2 = END; returns the new position or errno. */
int64_t tension_res_seek(const tension_res *res, int32_t fd, int64_t off, int32_t whence);

/** Current position of an open handle, or a negative errno. */
int64_t tension_res_tell(const tension_res *res, int32_t fd);

/** Stat a path: 0 on success (fills *out), or a negative errno. */
int32_t tension_res_stat(const tension_res *res, const char *path, size_t path_len,
                         tension_res_stat *out);

/** Stat an open handle: 0 on success (fills *out), or a negative errno. */
int32_t tension_res_stat_fd(const tension_res *res, int32_t fd, tension_res_stat *out);

/**
 * Enumerate a directory. `index` is the 0-based ordinal in NS1 byte order.
 * Returns the child's raw name length (no '/' suffix — the framework formats
 * listings), 0 past the last child, or a negative errno. Writes
 * min(name_cap, len) bytes, so `name_cap == 0` is a size probe and a short
 * buffer is signalled by the returned length exceeding `name_cap`.
 */
int32_t tension_res_readdir(const tension_res *res, const char *path, size_t path_len,
                            uint32_t index, char *name, size_t name_cap,
                            tension_res_stat *out);

/** Close an fd (idempotent for in-range fds): 0 or a negative errno. */
int32_t tension_res_close(const tension_res *res, int32_t fd);

/**
 * Pack a directory into an ECMA-208 volume. STUB in phase 6: returns -ENOSYS.
 */
int32_t tension_res_pack(const char *dir, const char *out, char *err, size_t errcap);

#ifdef __cplusplus
} /* extern "C" */
#endif

#endif /* TENSION_RES_H */
