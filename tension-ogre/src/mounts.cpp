// mounts.cpp — see mounts.h for the ownership and threading rules.

#include "mounts.h"

#include <cerrno>
#include <fstream>
#include <iterator>

namespace tension_ogre {

int32_t mount_refusal(const MountTable &table, const std::string &prefix,
                      const std::string &tns_path) {
    if (prefix.empty() || tns_path.empty()) return -EINVAL;
    if (prefix.back() == '/') return -EINVAL;
    for (const std::unique_ptr<Mount> &mount : table) {
        if (mount->prefix == prefix) return -EEXIST;
    }
    return 0;
}

int32_t mount_open(const std::string &tns_path, std::vector<uint8_t> *bytes, tension_res **out,
                   std::string *err) {
    std::ifstream file(tns_path, std::ios::binary);
    if (!file) return -ENOENT;
    bytes->assign(std::istreambuf_iterator<char>(file), std::istreambuf_iterator<char>());
    if (file.bad() || bytes->empty()) return -EIO;

    char message[512] = {0};
    const int32_t loaded =
        tension_res_load_borrowed(bytes->data(), bytes->size(), out, message, sizeof message);
    if (loaded != 0) {
        if (err != nullptr) *err = message;
        return -EIO;
    }
    return 0;
}

const Mount *mount_resolve(const std::vector<const Mount *> &table, const std::string &path,
                           std::string *relative) {
    const Mount *best = nullptr;
    size_t best_length = 0;
    for (const Mount *mount : table) {
        const std::string &prefix = mount->prefix;
        // "prefix/x" needs at least two more bytes than the prefix itself; a
        // path equal to the bare prefix is not a File in the volume.
        if (path.size() < prefix.size() + 2) continue;
        if (path.compare(0, prefix.size(), prefix) != 0) continue;
        if (path[prefix.size()] != '/') continue;
        if (prefix.size() + 1 <= best_length) continue; // not longer than the best
        best = mount;
        best_length = prefix.size() + 1;
    }
    if (best == nullptr) return nullptr;
    if (relative != nullptr) *relative = path.substr(best->prefix.size() + 1);
    return best;
}

std::vector<const Mount *> mount_pointers(const MountTable &table) {
    std::vector<const Mount *> pointers;
    pointers.reserve(table.size());
    for (const std::unique_ptr<Mount> &mount : table) pointers.push_back(mount.get());
    return pointers;
}

bool mount_path_is_directory(const std::string &path) {
    return !path.empty() && path.back() == '/';
}

std::vector<uint8_t> mount_read(const Mount &mount, const std::string &relative, int32_t *error) {
    const int32_t fd = tension_res_open(mount.res, relative.data(), relative.size());
    if (fd < 0) {
        *error = fd;
        return {};
    }
    tension_res_stat record{};
    const int32_t stat_rc = tension_res_stat_fd(mount.res, fd, &record);
    if (stat_rc != 0 || record.kind != 0) {
        tension_res_close(mount.res, fd);
        *error = stat_rc != 0 ? stat_rc : -EINVAL;
        return {};
    }
    std::vector<uint8_t> bytes(record.size);
    const int32_t got = tension_res_read(mount.res, fd, bytes.data(), bytes.size());
    tension_res_close(mount.res, fd);
    if (got != static_cast<int32_t>(record.size)) {
        *error = got < 0 ? got : -EIO;
        return {};
    }
    *error = 0;
    return bytes;
}

} // namespace tension_ogre
