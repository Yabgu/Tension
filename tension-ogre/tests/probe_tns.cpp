// probe_tns.cpp — the adapter side drives tension-res (chunk 11, round
// 11a-probe: Q1 and Q3; header defect fixed in 11b).
//
// Q0 (found by 11a, fixed in 11b): tension-res/include/tension_res.h used to
//     declare a typedef `tension_res_stat` and a function `tension_res_stat` —
//     fine in C, a name collision in C++, where types and functions share the
//     ordinary identifier namespace. The function is now
//     `tension_res_stat_path` and this file includes the real header, which is
//     exactly the claim the fix has to survive: a C++ translation unit.
//
// Q1. The C ABI had only ever been called from Rust (tension-core) and the Zig
//     tests. Chunk 11's design has the OGRE adapter DSO — C++ — calling
//     `tension_res_load_borrowed / open / stat_fd / read / close` directly,
//     linked against the same static archive `tension-core/build.rs` links.
//     This probe proves that link and that call sequence, against the archive
//     that actually ships: examples/res/game.tns.
//
// Q3. Is the volume read path cheap enough to be the only one for mesh bytes?
//     Ten iterations of `std::ifstream` over Stickman.mesh, against ten of
//     `tension_res_open/read/close` on the same bytes inside a scratch volume.
//     The volume arm includes Deflate decompression when the packer compressed
//     the File — `stat_fd`'s flags bit 0 says which, and the report says so
//     rather than letting the numbers imply a raw copy.
//
// Build:
//   g++ -std=c++17 -O2 -I tension-res/include \
//       tests/probe_tns.cpp -o build/probe-tns/probe_tns \
//       tension-res/zig-out/lib/libtension_res.a -lpthread
//
// Run:
//   ./probe_tns <volume.tns> [path-in-volume]                    # Q1
//   ./probe_tns --time <disk-file> <volume.tns> <in-volume-path> # Q3

#include "tension_res.h"

#include <chrono>
#include <cstddef>
#include <cstdint>
#include <cstdio>
#include <cstring>
#include <fstream>
#include <iterator>
#include <string>
#include <vector>


namespace {

std::vector<uint8_t> read_file(const std::string &path) {
    std::ifstream file(path, std::ios::binary);
    return std::vector<uint8_t>(std::istreambuf_iterator<char>(file),
                                std::istreambuf_iterator<char>());
}

double now_us() {
    using clock = std::chrono::steady_clock;
    return std::chrono::duration<double, std::micro>(clock::now().time_since_epoch()).count();
}

uint64_t fnv1a64(const uint8_t *data, size_t len) {
    uint64_t h = 14695981039346656037ull;
    for (size_t i = 0; i < len; ++i) {
        h ^= data[i];
        h *= 1099511628211ull;
    }
    return h;
}

void print_first_16(const uint8_t *p, size_t len) {
    const size_t n = len < 16 ? len : 16;
    std::printf("               first %zu bytes:", n);
    for (size_t i = 0; i < n; ++i) std::printf(" %02x", static_cast<unsigned>(p[i]));
    std::printf("  |");
    for (size_t i = 0; i < n; ++i) {
        const uint8_t c = p[i];
        std::putchar(c >= 32 && c < 127 ? static_cast<int>(c) : '.');
    }
    std::printf("|\n");
}

/// Open, stat, read the whole file, close — the exact sequence the loader will
/// run per mesh. Returns the byte count (negative errno on failure).
int32_t read_through(const tension_res *res, const char *path, std::vector<uint8_t> *out,
                     bool announce) {
    const int32_t fd = tension_res_open(res, path, std::strlen(path));
    if (fd < 0) {
        if (announce) std::printf("  open(\"%s\"): %d\n", path, fd);
        return fd;
    }
    tension_res_stat st{};
    const int32_t st_rc = tension_res_stat_fd(res, fd, &st);
    if (announce) {
        std::printf("  open(\"%s\"): fd=%d stat=%d kind=%u size=%u flags=0x%x%s\n", path, fd, st_rc,
                    st.kind, st.size, st.flags,
                    (st.flags & 1u) != 0 ? " (compressed payload)" : " (stored)");
    }
    out->assign(st.size, 0);
    const int32_t got = tension_res_read(res, fd, out->data(), out->size());
    if (announce) std::printf("  read: got=%d of size=%u\n", got, st.size);
    const int32_t closed = tension_res_close(res, fd);
    if (announce) std::printf("  close: %d\n", closed);
    if (got != static_cast<int32_t>(st.size)) return got < 0 ? got : -5;
    return got;
}

int q1(const std::string &volume_path, const char *path_in_volume) {
    const std::vector<uint8_t> bytes = read_file(volume_path);
    if (bytes.empty()) {
        std::printf("Q1: %s could not be read\n", volume_path.c_str());
        return 2;
    }
    tension_res *res = nullptr;
    char err[512] = {0};
    const int32_t rc = tension_res_load_borrowed(bytes.data(), bytes.size(), &res, err, sizeof err);
    std::printf("Q1 load_borrowed: rc=%d err=\"%s\" handle=%s (%zu bytes borrowed)\n", rc, err,
                res != nullptr ? "non-null" : "null", bytes.size());
    if (rc != 0 || res == nullptr) return 3;

    std::vector<uint8_t> intro;
    const int32_t intro_got = read_through(res, path_in_volume, &intro, true);
    if (intro_got >= 0) print_first_16(intro.data(), intro.size());

    std::vector<uint8_t> level1;
    const int32_t level1_got = read_through(res, "data/level1.bin", &level1, true);
    if (level1_got >= 0 && level1.size() >= 16) print_first_16(level1.data(), level1.size());

    const int32_t missing = tension_res_open(res, "no/such/file", 12);
    std::printf("Q1 open(\"no/such/file\"): %d (expect -2 ENOENT)\n", missing);

    tension_res_free(res);
    std::printf("Q1 free: done (handle released)\n");
    return 0;
}

int q3(const std::string &disk_path, const std::string &volume_path,
       const std::string &inner_path) {
    const std::vector<uint8_t> reference = read_file(disk_path);
    if (reference.empty()) {
        std::printf("Q3: %s could not be read\n", disk_path.c_str());
        return 2;
    }
    std::printf("Q3 disk file: %s (%zu bytes, fnv1a %016llx)\n", disk_path.c_str(),
                reference.size(),
                static_cast<unsigned long long>(fnv1a64(reference.data(), reference.size())));

    double ifstream_total = 0.0, res_total = 0.0;
    std::printf("Q3 arm ifstream: 10 iterations\n");
    for (int i = 0; i < 10; ++i) {
        const double t0 = now_us();
        const std::vector<uint8_t> bytes = read_file(disk_path);
        const double t1 = now_us();
        ifstream_total += t1 - t0;
        std::printf("  iter %2d: %8.1f us (%zu bytes)\n", i + 1, t1 - t0, bytes.size());
    }

    const std::vector<uint8_t> volume = read_file(volume_path);
    if (volume.empty()) {
        std::printf("Q3: %s could not be read\n", volume_path.c_str());
        return 2;
    }
    tension_res *res = nullptr;
    char err[512] = {0};
    const double load_t0 = now_us();
    const int32_t rc = tension_res_load_borrowed(volume.data(), volume.size(), &res, err, sizeof err);
    const double load_t1 = now_us();
    std::printf("Q3 arm tension-res: volume %s (%zu bytes), load_borrowed rc=%d in %.1f us "
                "(once, outside the loop)\n",
                volume_path.c_str(), volume.size(), rc, load_t1 - load_t0);
    if (rc != 0 || res == nullptr) return 3;

    uint64_t res_fnv = 0;
    size_t res_bytes = 0;
    std::printf("Q3 arm tension-res: 10 iterations of open/stat_fd/read/close\n");
    for (int i = 0; i < 10; ++i) {
        std::vector<uint8_t> bytes;
        const double t0 = now_us();
        const int32_t got = read_through(res, inner_path.c_str(), &bytes, i == 0);
        const double t1 = now_us();
        if (got < 0) {
            std::printf("Q3: the volume read failed: %d\n", got);
            tension_res_free(res);
            return 3;
        }
        res_total += t1 - t0;
        res_bytes = bytes.size();
        res_fnv = fnv1a64(bytes.data(), bytes.size());
        std::printf("  iter %2d: %8.1f us (%zu bytes)\n", i + 1, t1 - t0, bytes.size());
    }
    tension_res_free(res);

    std::printf("Q3 means: ifstream %.1f us, tension-res %.1f us, ratio %.2fx\n",
                ifstream_total / 10.0, res_total / 10.0, res_total / ifstream_total);
    std::printf("Q3 bytes: disk %zu, volume %zu, fnv1a %s\n", reference.size(), res_bytes,
                res_fnv == fnv1a64(reference.data(), reference.size()) ? "identical" : "DIFFERENT");
    return 0;
}

} // namespace

int main(int argc, char **argv) {
    std::setvbuf(stdout, nullptr, _IONBF, 0);
    if (argc >= 2 && std::strcmp(argv[1], "--time") == 0) {
        if (argc != 5) {
            std::fprintf(stderr,
                         "usage: probe_tns --time <disk-file> <volume.tns> <in-volume-path>\n");
            return 2;
        }
        return q3(argv[2], argv[3], argv[4]);
    }
    if (argc < 2) {
        std::fprintf(stderr, "usage: probe_tns <volume.tns> [path-in-volume]\n");
        return 2;
    }
    std::printf("Q0 note: this file includes tension_res.h directly — the C++ header fix "
                "(tension_res_stat_path) is what makes that possible\n");
    return q1(argv[1], argc >= 3 ? argv[2] : "text/intro.txt");
}
