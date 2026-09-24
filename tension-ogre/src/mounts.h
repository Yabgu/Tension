// mounts.h — the Tension Volume mount table (chunk 11).
//
// The adapter's byte source. A mount is a volume's bytes, a borrowed
// `tension_res` handle over them, and the prefix a guest path is resolved
// against. There is no fallback to the disk: a path no mount matches is a
// refusal (-ENOENT), and a path that names a directory is -EINVAL — 11a's
// decision, taken so that "which bytes did the guest actually get" has exactly
// one answer.
//
// Ownership and lifetime:
//   * Mounts are heap-stable (`unique_ptr`) and append-only. A resolved
//     `const Mount *` therefore stays valid for the process, which is what
//     lets the loader's worker hold one across a read without holding the
//     table's lock (a plain vector of Mounts would move on reallocation).
//   * `bytes` owns the volume image and `res` borrows it
//     (`tension_res_load_borrowed`); they are fields of one struct so they
//     cannot be separated, and nothing ever removes a mount.
//
// Threading: this table has no lock of its own. It lives in the `Loader`,
// which guards it with the same mutex that guards the job table: the guest
// thread appends (`mount_tns`), the loader's worker reads. See loader.h.

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
    std::vector<uint8_t> bytes; ///< the volume image; owns the handle's lifetime
    tension_res *res = nullptr; ///< borrowed over `bytes`
};

using MountTable = std::vector<std::unique_ptr<Mount>>;

/// The verb-side validation, in one place so the shim and the tests agree.
/// Refusals: an empty prefix or path (-EINVAL), a prefix with a trailing '/'
/// (-EINVAL — the prefix is a name, not a path), a duplicate prefix (-EEXIST).
/// Returns 0 when the mount is acceptable.
int32_t mount_refusal(const MountTable &table, const std::string &prefix,
                      const std::string &tns_path);

/// Read a volume file into `bytes` and load it borrowed. 0, or the errno that
/// stopped it; `err` carries the library's own message when the parse refuses.
int32_t mount_open(const std::string &tns_path, std::vector<uint8_t> *bytes, tension_res **out,
                   std::string *err);

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
