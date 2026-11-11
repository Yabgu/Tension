// mounts.h — the adapter's view of the session's mounts.
//
// **This is a borrowed index, not a mount table of its own.** The session owns
// mounting: `tension::res.mount` (the guest verb) and `res_volume_bytes` (the
// core slot, for this adapter's worker thread) both append to the host's one
// table, and the host reads the file once. What lives here is the pair the
// loader's worker needs to resolve a guest path — a prefix and a parsed view —
// over bytes it does not own and must not free.
//
// There is no fallback to the disk: a path no mount matches is -ENOENT, and a
// path that names a directory is -EINVAL — 11a's decision, kept so that "which
// bytes did the guest actually get" has exactly one answer.
//
// Ownership and lifetime:
//   * Mounts are heap-stable (`unique_ptr`) and append-only, so a resolved
//     `const Mount *` stays valid for the process and the worker can hold one
//     across a read without the table's lock (a plain vector would move on
//     reallocation).
//   * `res` is a `tension_res` over the **host's** image
//     (`res_volume_bytes`), so this adapter frees the handle and never the
//     bytes. The host never unmounts, which is what makes the borrow valid for
//     the session.
//
// Threading: this table has no lock of its own. It lives in the `Loader`, which
// guards it with the same mutex that guards the job table: the guest thread
// appends (`mount_tns`), the loader's worker reads. See loader.h.

#ifndef TENSION_OGRE_MOUNTS_H
#define TENSION_OGRE_MOUNTS_H

#include <cstddef>
#include <cstdint>
#include <memory>
#include <string>
#include <vector>

#include "tension_res.h"

namespace tension_ogre {

struct Mount {
    std::string prefix;         ///< "resources" — no trailing slash
    std::string tns_path;       ///< absolute, named in diagnostics
    /// The volume image. **Not owned here**: it is the host mount table's
    /// buffer, reached through `res_volume_bytes`, and freed when the session
    /// ends. Kept for diagnostics and so a test can see what was borrowed.
    const uint8_t *image = nullptr;
    size_t image_len = 0;
    tension_res *res = nullptr; ///< borrowed over `image`; this side frees it
};

using MountTable = std::vector<std::unique_ptr<Mount>>;

/// The verb-side validation, in one place so the shim and the tests agree.
/// Refusals: an empty prefix or path (-EINVAL), a prefix with a trailing '/'
/// (-EINVAL — the prefix is a name, not a path), a duplicate prefix (-EEXIST).
/// Returns 0 when the mount is acceptable.
int32_t mount_refusal(const MountTable &table, const std::string &prefix,
                      const std::string &tns_path);

/// Parse a volume image **the host already read**, borrowing it.
///
/// The image belongs to the host's mount table (`res_volume_bytes`): one read of
/// the file, one copy in the process, and this adapter's parser sees the same
/// bytes the guest's `tension::res` verbs do. Before the host owned mounting,
/// this function opened the file itself — which is why one volume had to be
/// passed to the host as well as to the adapter.
///
/// 0, or the errno that stopped it; `err` carries the library's own message when
/// the parse refuses.
int32_t mount_borrow(const uint8_t *image, size_t len, tension_res **out, std::string *err);

/// Longest prefix wins, and a match must land on a '/' boundary — the mount
/// "res" does not answer for "resources/x.mesh". `relative` is the path after
/// `prefix + "/"`. Returns nullptr when no mount matches. Takes the table as
/// stable pointers (`mount_pointers`), which is what the worker holds across a
/// read.
const Mount *mount_resolve(const std::vector<const Mount *> &table, const std::string &path,
                           std::string *relative);

/// The same table, as stable pointers: the worker's snapshot, taken under the
/// loader's lock and used outside it (mounts are never removed, so the
/// pointers stay valid).
std::vector<const Mount *> mount_pointers(const MountTable &table);

/// True when the path spells a directory rather than a file — it ends in '/'.
bool mount_path_is_directory(const std::string &path);

/// Open, stat, read and close one File in a mounted volume: the worker's whole
/// byte source. 0 in `*error` and the bytes, or an errno and an empty vector.
std::vector<uint8_t> mount_read(const Mount &mount, const std::string &relative, int32_t *error);

} // namespace tension_ogre

#endif // TENSION_OGRE_MOUNTS_H
